import fs from 'node:fs/promises';

import { redactForLog } from '../utils/redactForLog';
import { imageMimeTypeFromPath } from '../utils/curlUtils';
import { MetricsStore } from './MetricsStore';
import { MeetingCopilotReviewLogEntry } from './ReviewLogStore';
import { classifyFreshnessNeed, FRESHNESS_UNVERIFIED_CAVEAT } from './FreshnessPolicy';

import {
    BuildMeetingCopilotContextInput,
    BuiltMeetingCopilotContext,
    ActionRunToolLoop,
    ActionPane,
    ContextMode,
    LlmCallMetrics,
    MeetingCopilotActionConfig,
    MeetingCopilotConfig,
    MeetingCopilotEvent,
    OpenRouterChatCompletionRequest,
    OpenRouterContentBlock,
    OpenRouterImageContentBlock,
    OpenRouterMessage,
    OpenRouterStreamEvent,
    ReasoningConfig,
    ProjectContextBundle,
    ProjectContextMetrics,
    FreshnessDecision,
    FreshnessEvidence,
    FreshnessMetrics,
    ModelInfo,
    TranscriptSnapshot,
} from './types';

type ActionResolver = {
    getAction?: (actionId: string) => MeetingCopilotActionConfig | undefined;
    actions?: Record<string, MeetingCopilotActionConfig>;
};

type ActionRunManagerConfig = MeetingCopilotConfig | ActionResolver;

type SessionIdInput = {
    runId: string;
    actionId: string;
    snapshot: TranscriptSnapshot;
    branch?: ActionPane;
};

type ReviewLogStoreLike = {
    record: (entry: Omit<MeetingCopilotReviewLogEntry, 'logged_at'>) => void | Promise<void>;
};

export interface ActionRunManagerOptions {
    config: ActionRunManagerConfig;
    transcriptSnapshotProvider: () => TranscriptSnapshot | Promise<TranscriptSnapshot>;
    buildContext: (input: BuildMeetingCopilotContextInput) => BuiltMeetingCopilotContext;
    buildMessages: (input: {
        context: BuiltMeetingCopilotContext;
        cachePolicy: OpenRouterChatCompletionRequest['cache_policy'];
    }) => {
        messages: OpenRouterMessage[];
    };
    openRouterClient: {
        streamChatCompletion: (
            request: OpenRouterChatCompletionRequest
        ) => AsyncGenerator<OpenRouterStreamEvent, unknown, void>;
    };
    emitEvent: (event: MeetingCopilotEvent) => void;
    toolLoop?: ActionRunToolLoop;
    metricsStore?: MetricsStore;
    reviewLogStore?: ReviewLogStoreLike;
    createRunId?: () => string;
    now?: () => number;
    sessionId?: string | ((input: SessionIdInput) => string);
    getStableInstructions?: () => string;
    getCustomContext?: () => string;
    getPinnedContext?: () => string | Promise<string>;
    getProjectContext?: () => ProjectContextBundle | Promise<ProjectContextBundle>;
    getCodeContext?: () => string;
    hasFreshnessTools?: () => boolean;
    freshnessTools?: {
        getOpenRouterModel: (modelId: string, signal?: AbortSignal) => Promise<ModelInfo>;
    };
}

export interface StartActionInput {
    actionId: string;
    imagePaths?: string[];
}

export interface CancelActionInput {
    runId: string;
    branch?: 'fast' | 'deep' | 'all';
}

type ActiveRun = {
    branches: Partial<Record<ActionPane, ActiveBranch>>;
    cancelled: boolean;
};

type ActiveBranch = {
    abortController: AbortController;
    cancelled: boolean;
    finished: boolean;
};

type BranchOutcome =
    | {
          status: 'success';
          metrics: LlmCallMetrics;
          warnings?: string[];
          finalText: string;
      }
    | {
          status: 'error';
          error: string;
      }
    | {
          status: 'cancelled';
      };

type RunnerBranchConfig = {
    model: string;
    context_mode: ContextMode;
    cache_policy: OpenRouterChatCompletionRequest['cache_policy'];
    context_minutes?: number;
    max_tokens?: number;
    temperature: number;
    reasoning?: ReasoningConfig;
    tools_enabled?: boolean;
    max_tool_rounds?: number;
    max_tool_calls_per_round?: number;
    web_search_enabled?: boolean;
    project_docs_enabled?: boolean;
    prompt: string;
};

// OpenRouter's built-in web plugin — injects live web search results (via Exa
// by default) into the model's context before it answers, and returns
// citations as `annotations` on the response. ~$0.005/call. No model-specific
// wiring needed; works the same way regardless of which model runs the branch.
const WEB_SEARCH_PLUGIN = [{ id: 'web' }];

function sanitizeText(value: string): string {
    return redactForLog([value])
        .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED]')
        .replace(/[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s]+/g, '[REDACTED]')
        .trim();
}

function toBoundedString(value: unknown, maxChars = 16_000): string {
    return String(value ?? '').slice(0, maxChars);
}

function createDefaultRunId(): string {
    return `meeting-copilot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveAction(
    config: ActionRunManagerConfig,
    actionId: string
): MeetingCopilotActionConfig | undefined {
    if ('actions' in config && config.actions) {
        return config.actions[actionId];
    }

    if ('getAction' in config && typeof config.getAction === 'function') {
        return config.getAction(actionId);
    }

    return undefined;
}

function resolveCodeContextMaxChars(config: ActionRunManagerConfig): number {
    if (
        'code_context' in config &&
        config.code_context &&
        Number.isFinite(config.code_context.max_total_chars) &&
        config.code_context.max_total_chars > 0
    ) {
        return Math.trunc(config.code_context.max_total_chars);
    }

    return 12_000;
}

function isParallelAction(
    action: MeetingCopilotActionConfig
): action is Extract<MeetingCopilotActionConfig, { parallel: unknown }> {
    return 'parallel' in action;
}

function actionNeedsProjectContext(action: MeetingCopilotActionConfig): boolean {
    if (isParallelAction(action)) {
        return (
            action.parallel.fast.context_mode === 'full_cached' ||
            action.parallel.deep.context_mode === 'full_cached' ||
            Boolean(action.parallel.fast.project_docs_enabled) ||
            Boolean(action.parallel.deep.project_docs_enabled)
        );
    }

    return action.context_mode === 'full_cached' || Boolean(action.project_docs_enabled);
}

function normalizeImagePaths(imagePaths: string[] | undefined): string[] {
    if (!Array.isArray(imagePaths)) return [];

    return imagePaths
        .filter((imagePath): imagePath is string => typeof imagePath === 'string' && imagePath.trim().length > 0)
        .slice(0, 5);
}

async function buildImageContentBlocks(imagePaths: string[] | undefined): Promise<OpenRouterImageContentBlock[]> {
    const normalizedPaths = normalizeImagePaths(imagePaths);
    const blocks: OpenRouterImageContentBlock[] = [];

    for (const imagePath of normalizedPaths) {
        const data = await fs.readFile(imagePath);
        blocks.push({
            type: 'image_url',
            image_url: {
                url: `data:${imageMimeTypeFromPath(imagePath)};base64,${data.toString('base64')}`,
            },
        });
    }

    return blocks;
}

function appendImageBlocksToMessages(
    messages: OpenRouterMessage[],
    imageBlocks: OpenRouterImageContentBlock[]
): OpenRouterMessage[] {
    if (imageBlocks.length === 0) return messages;

    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') {
            lastUserIndex = index;
            break;
        }
    }

    const nextMessages = messages.map((message) => ({ ...message }));

    if (lastUserIndex === -1) {
        nextMessages.push({ role: 'user', content: imageBlocks });
        return nextMessages;
    }

    const userMessage = nextMessages[lastUserIndex];
    const existingContent = userMessage.content;
    let content: OpenRouterContentBlock[];

    if (Array.isArray(existingContent)) {
        content = [...existingContent, ...imageBlocks];
    } else if (typeof existingContent === 'string' && existingContent.trim().length > 0) {
        content = [{ type: 'text', text: existingContent }, ...imageBlocks];
    } else {
        content = [...imageBlocks];
    }

    nextMessages[lastUserIndex] = {
        ...userMessage,
        content,
    };

    return nextMessages;
}

function isAbortError(error: unknown): boolean {
    return (
        (error instanceof Error && error.name === 'AbortError') ||
        (typeof error === 'object' &&
            error !== null &&
            'name' in error &&
            (error as { name?: unknown }).name === 'AbortError')
    );
}

function isProviderContextLimitError(error: unknown): boolean {
    const message = sanitizeText(error instanceof Error ? error.message : String(error));
    return /(\bcontext\s*(length|window)\b|\bmaximum context\b|\bmax(?:imum)? tokens?\b|\btoken limit\b|\bprompt too long\b|\btoo many tokens\b|\bexceed(?:s|ed)?\b.*\bcontext\b|\binput too long\b|\binput is too large\b)/i.test(
        message
    );
}

function isAuthError(error: unknown): boolean {
    const message = sanitizeText(error instanceof Error ? error.message : String(error));
    return /(\b401\b|\b403\b|unauthorized|forbidden|invalid api key|api key not found|bad api key|auth(?:entication)?\s*(?:failed|error|invalid)|no credentials|missing api key|key\s*(?:not|is invalid|is revoked|expired))/i.test(
        message
    );
}

function buildAuthErrorMessage(): string {
    return [
        'The provider rejected this request because the API key is missing or invalid.',
        'Set a valid OpenRouter API key in the Natively settings panel.',
    ].join(' ');
}

function isRateLimitError(error: unknown): boolean {
    const message = sanitizeText(error instanceof Error ? error.message : String(error));
    return /(\b429\b|rate.?limit|too many requests|quota exceeded|billing|insufficient.?quota|insufficient.?credits|usage limit)/i.test(message);
}

function buildRateLimitMessage(): string {
    return [
        'The provider is rate-limiting or billing-quota-limited your requests.',
        'Consider a lower-cost model, upgrading your OpenRouter plan, or waiting before retrying.',
    ].join(' ');
}

function buildProviderContextLimitMessage(): string {
    return [
        'The provider rejected this run because the context is too large.',
        'Reduce code context, clear pinned context, or start a new meeting/session.',
        'M8 does not use transcript summarization or token fallback.',
    ].join(' ');
}

function emptyProjectContextBundle(): ProjectContextBundle {
    return {
        included: false,
        packNames: [],
        files: [],
        text: '',
        chars: 0,
        fileCount: 0,
        warnings: [],
        truncated: false,
    };
}

function projectContextMetricsFromBundle(bundle: ProjectContextBundle): ProjectContextMetrics {
    return {
        project_context_included: bundle.included,
        ...(bundle.packNames.length > 0 ? { project_context_pack_names: bundle.packNames } : {}),
        project_context_chars: bundle.chars,
        project_context_file_count: bundle.fileCount,
    };
}

function mergeProjectContextMetrics(
    metricsList: Array<ProjectContextMetrics | undefined>
): ProjectContextMetrics | undefined {
    const included = metricsList.some((metrics) => metrics?.project_context_included === true);
    const explicitFalse = metricsList.some((metrics) => metrics?.project_context_included === false);
    const packNames = [
        ...new Set(
            metricsList.flatMap((metrics) => metrics?.project_context_pack_names ?? [])
        ),
    ];
    const chars = metricsList.find((metrics) => typeof metrics?.project_context_chars === 'number')?.project_context_chars;
    const fileCount = metricsList.find(
        (metrics) => typeof metrics?.project_context_file_count === 'number'
    )?.project_context_file_count;

    if (!included && !explicitFalse && packNames.length === 0 && chars === undefined && fileCount === undefined) {
        return undefined;
    }

    return {
        project_context_included: included ? true : explicitFalse ? false : undefined,
        project_context_pack_names: packNames.length > 0 ? packNames : undefined,
        project_context_chars: chars,
        project_context_file_count: fileCount,
    };
}

function recentTranscriptText(snapshot: TranscriptSnapshot, maxChars = 4_000): string {
    return snapshot.chunks.map((chunk) => chunk.text).join('\n').slice(-maxChars);
}

const PUBLIC_MODEL_PROVIDERS = new Set([
    'anthropic',
    'cohere',
    'deepseek',
    'google',
    'meta-llama',
    'mistralai',
    'openai',
    'perplexity',
    'qwen',
    'x-ai',
]);

function extractSafeOpenRouterModelIds(...values: string[]): string[] {
    const text = values.join('\n').slice(0, 8_000);
    const matches = text.matchAll(
        /\b([a-z][a-z0-9-]{1,31}\/[a-z0-9][a-z0-9._-]{1,95})\b/gi
    );
    const ids: string[] = [];

    for (const match of matches) {
        const id = match[1].toLowerCase();
        const provider = id.split('/')[0];
        if (!PUBLIC_MODEL_PROVIDERS.has(provider)) {
            continue;
        }
        if (!ids.includes(id)) {
            ids.push(id);
        }
        if (ids.length >= 3) {
            break;
        }
    }

    return ids;
}

function formatModelEvidence(model: ModelInfo): string {
    const lines = [
        `- id: ${model.id}`,
        model.name ? `  name: ${model.name}` : undefined,
        typeof model.context_length === 'number'
            ? `  context_length: ${model.context_length}`
            : undefined,
        model.supported_parameters?.length
            ? `  supported_parameters: ${model.supported_parameters.join(', ')}`
            : undefined,
        model.pricing ? `  pricing_keys: ${Object.keys(model.pricing).slice(0, 16).join(', ')}` : undefined,
        `  checked_at: ${model.checked_at}`,
    ];

    return lines.filter((line): line is string => typeof line === 'string').join('\n');
}

function freshnessMetricsFromEvidence(evidence: FreshnessEvidence): FreshnessMetrics {
    return {
        freshness_check_used: evidence.used ? true : undefined,
        freshness_sources: evidence.sources.length > 0 ? evidence.sources : undefined,
        freshness_query_count: evidence.queries.length,
        freshness_result_count: evidence.resultCount,
        freshness_verified_at: evidence.verifiedAt,
        freshness_error: evidence.warnings[0],
    };
}

function freshnessMetricsFromDecision(decision: FreshnessDecision): FreshnessMetrics | undefined {
    if (decision.sensitivity === 'none') {
        return undefined;
    }

    if (decision.shouldCaveat) {
        return {
            freshness_query_count: 0,
            freshness_result_count: 0,
            freshness_error: 'verification_unavailable',
        };
    }

    if (decision.shouldVerify) {
        return {
            freshness_query_count: 0,
            freshness_result_count: 0,
        };
    }

    return undefined;
}

function mergeFreshnessMetrics(
    metricsList: Array<FreshnessMetrics | undefined>
): FreshnessMetrics | undefined {
    const filtered = metricsList.filter(Boolean) as FreshnessMetrics[];
    if (filtered.length === 0) {
        return undefined;
    }

    const freshnessSources = [
        ...new Set(filtered.flatMap((metrics) => metrics.freshness_sources ?? [])),
    ];
    const freshnessQueryCount = filtered.reduce(
        (sum, metrics) => sum + (metrics.freshness_query_count ?? 0),
        0
    );
    const freshnessResultCount = filtered.reduce(
        (sum, metrics) => sum + (metrics.freshness_result_count ?? 0),
        0
    );
    const freshnessError = filtered.find((metrics) => metrics.freshness_error)?.freshness_error;
    const freshnessVerifiedAt = filtered.find(
        (metrics) => typeof metrics.freshness_verified_at === 'string'
    )?.freshness_verified_at;
    const freshnessCheckUsed = filtered.some(
        (metrics) => metrics.freshness_check_used === true
    )
        ? true
        : undefined;

    return {
        freshness_check_used: freshnessCheckUsed,
        freshness_sources: freshnessSources.length > 0 ? freshnessSources : undefined,
        freshness_query_count: freshnessQueryCount,
        freshness_result_count: freshnessResultCount,
        freshness_verified_at: freshnessVerifiedAt,
        freshness_error: freshnessError,
    };
}

export class ActionRunManager {
    private readonly config: ActionRunManagerConfig;
    private readonly transcriptSnapshotProvider: ActionRunManagerOptions['transcriptSnapshotProvider'];
    private readonly buildContext: ActionRunManagerOptions['buildContext'];
    private readonly buildMessages: ActionRunManagerOptions['buildMessages'];
    private readonly openRouterClient: ActionRunManagerOptions['openRouterClient'];
    private readonly emitEvent: ActionRunManagerOptions['emitEvent'];
    private readonly toolLoop?: ActionRunToolLoop;
    private readonly metricsStore?: MetricsStore;
    private readonly reviewLogStore?: ReviewLogStoreLike;
    private readonly createRunId: () => string;
    private readonly now: () => number;
    private readonly sessionId: ActionRunManagerOptions['sessionId'];
    private readonly getStableInstructions: () => string;
    private readonly getCustomContext: () => string;
    private readonly getPinnedContext: () => string | Promise<string>;
    private readonly getProjectContext?: () => ProjectContextBundle | Promise<ProjectContextBundle>;
    private readonly getCodeContext: () => string;
    private readonly hasFreshnessTools: () => boolean;
    private readonly freshnessTools?: NonNullable<ActionRunManagerOptions['freshnessTools']>;
    private readonly activeRuns = new Map<string, ActiveRun>();
    private readonly sharedActionHistoryByMeeting = new Map<string, string[]>();

    constructor(options: ActionRunManagerOptions) {
        this.config = options.config;
        this.transcriptSnapshotProvider = options.transcriptSnapshotProvider;
        this.buildContext = options.buildContext;
        this.buildMessages = options.buildMessages;
        this.openRouterClient = options.openRouterClient;
        this.emitEvent = options.emitEvent;
        this.toolLoop = options.toolLoop;
        this.metricsStore = options.metricsStore;
        this.reviewLogStore = options.reviewLogStore;
        this.createRunId = options.createRunId ?? createDefaultRunId;
        this.now = options.now ?? (() => Date.now());
        this.sessionId = options.sessionId;
        this.getStableInstructions = options.getStableInstructions ?? (() => '');
        this.getCustomContext = options.getCustomContext ?? (() => '');
        this.getPinnedContext = options.getPinnedContext ?? (() => '');
        this.getProjectContext = options.getProjectContext;
        this.getCodeContext = options.getCodeContext ?? (() => '');
        this.freshnessTools = options.freshnessTools;
        this.hasFreshnessTools = () =>
            this.freshnessTools !== undefined && (options.hasFreshnessTools?.() ?? true);
    }

    async start(input: StartActionInput): Promise<{ runId: string }> {
        const runId = this.createRunId();
        const actionId = input.actionId;
        let failureMessage: string | undefined;
        let result: { runId: string } | undefined;

        try {
            if (this.activeRuns.size > 0) {
                throw new Error('Another Meeting Copilot action is already running in this slice');
            }

            const action = resolveAction(this.config, actionId);
            if (!action) {
                throw new Error(`Meeting Copilot action "${sanitizeText(actionId)}" is not configured`);
            }

            const snapshot = await this.transcriptSnapshotProvider();
            const pinnedContext = await this.getPinnedContext();
            const projectContextBundle = actionNeedsProjectContext(action)
                ? await this.loadProjectContextBundle()
                : emptyProjectContextBundle();
            const startedAt = this.now();

            if (isParallelAction(action)) {
                const activeRun: ActiveRun = {
                    branches: {
                        fast: {
                            abortController: new AbortController(),
                            cancelled: false,
                            finished: false,
                        },
                        deep: {
                            abortController: new AbortController(),
                            cancelled: false,
                            finished: false,
                        },
                    },
                    cancelled: false,
                };
                this.activeRuns.set(runId, activeRun);
                this.emitEvent({
                    type: 'action:started',
                    runId,
                    actionId,
                    label: action.label,
                });

                const [fastOutcome, deepOutcome] = await Promise.all([
                    this.executeBranch({
                        runId,
                        actionId,
                        snapshot,
                        startedAt,
                        branch: 'fast',
                        pane: 'fast',
                        branchConfig: action.parallel.fast,
                        sessionBranch: 'fast',
                        pinnedContext,
                        projectContextBundle,
                        imagePaths: input.imagePaths,
                    }),
                    this.executeBranch({
                        runId,
                        actionId,
                        snapshot,
                        startedAt,
                        branch: 'deep',
                        pane: 'deep',
                        branchConfig: action.parallel.deep,
                        sessionBranch: 'deep',
                        pinnedContext,
                        projectContextBundle,
                        imagePaths: input.imagePaths,
                    }),
                ]);

                if (activeRun.cancelled) {
                    result = { runId };
                } else {
                    const successes = [fastOutcome, deepOutcome].filter(
                        (outcome): outcome is Extract<BranchOutcome, { status: 'success' }> =>
                            outcome.status === 'success'
                    );
                    const failures = [fastOutcome, deepOutcome].filter(
                        (outcome): outcome is Extract<BranchOutcome, { status: 'error' }> =>
                            outcome.status === 'error'
                    );

                    if (successes.length > 0) {
                        this.appendSharedActionHistory(
                            snapshot.meeting_id,
                            this.formatParallelActionHistory(action.label, successes)
                        );
                        const aggregateMetrics = this.buildAggregateMetrics({
                            meetingId: snapshot.meeting_id,
                            actionId,
                            startedAt,
                            outcomes: successes,
                        });
                        this.emitEvent({
                            type: 'action:completed',
                            runId,
                            metrics: aggregateMetrics,
                            warnings: this.collectWarnings(successes),
                        });
                    } else if (failures.length > 0) {
                        failureMessage = failures[0].error;
                    }
                }

                result = { runId };
            } else {
                const activeRun: ActiveRun = {
                    branches: {
                        main: {
                            abortController: new AbortController(),
                            cancelled: false,
                            finished: false,
                        },
                    },
                    cancelled: false,
                };
                this.activeRuns.set(runId, activeRun);

                this.emitEvent({
                    type: 'action:started',
                    runId,
                    actionId,
                    label: action.label,
                });

                const outcome = await this.executeBranch({
                    runId,
                    actionId,
                    snapshot,
                    startedAt,
                    branch: 'main',
                    pane: 'main',
                    branchConfig: action,
                    sessionBranch: undefined,
                    pinnedContext,
                    projectContextBundle,
                    imagePaths: input.imagePaths,
                });

                if (outcome.status === 'success') {
                    this.appendSharedActionHistory(
                        snapshot.meeting_id,
                        this.formatSingleActionHistory(action.label, outcome.finalText)
                    );
                    this.emitEvent({
                        type: 'action:completed',
                        runId,
                        metrics: {
                            ...outcome.metrics,
                            meeting_id: snapshot.meeting_id,
                            action_id: actionId,
                            branch: 'single',
                            success: true,
                        },
                        warnings: outcome.warnings,
                    });
                } else if (outcome.status === 'error') {
                    failureMessage = outcome.error;
                }

                result = { runId };
            }
        } catch (error: unknown) {
            const activeRun = this.activeRuns.get(runId);
            if (activeRun?.cancelled || isAbortError(error)) {
                result = { runId };
            } else {
                failureMessage = isProviderContextLimitError(error)
                    ? buildProviderContextLimitMessage()
                    : toBoundedString(sanitizeText(error instanceof Error ? error.message : String(error)));
                this.emitEvent({
                    type: 'action:error',
                    runId,
                    error: failureMessage,
                });
            }
        } finally {
            this.activeRuns.delete(runId);
        }

        if (failureMessage) {
            throw new Error(failureMessage);
        }

        return result ?? { runId };
    }

    async cancel(input: CancelActionInput): Promise<{ cancelled: boolean }> {
        const activeRun = this.activeRuns.get(input.runId);
        if (!activeRun) {
            return { cancelled: false };
        }

        const branch = input.branch ?? 'all';
        if (branch === 'all') {
            const activeBranches = Object.values(activeRun.branches).filter(Boolean);
            if (activeBranches.length === 0) {
                return { cancelled: false };
            }

            activeRun.cancelled = true;
            for (const branchState of activeBranches) {
                branchState.cancelled = true;
                branchState.abortController.abort();
            }
            this.emitEvent({
                type: 'action:cancelled',
                runId: input.runId,
                branch: 'all',
            });
            return { cancelled: true };
        }

        const activeBranch = activeRun.branches[branch];
        if (!activeBranch || activeBranch.finished) {
            return { cancelled: false };
        }

        activeBranch.cancelled = true;
        activeBranch.abortController.abort();
        this.emitEvent({
            type: 'action:cancelled',
            runId: input.runId,
            branch,
        });
        return { cancelled: true };
    }

    private resolveSessionId(input: SessionIdInput): string {
        if (typeof this.sessionId === 'function') {
            return this.sessionId(input);
        }
        if (typeof this.sessionId === 'string' && this.sessionId.trim() !== '') {
            return input.branch ? `${this.sessionId}:${input.branch}` : this.sessionId;
        }
        return input.branch
            ? `${input.snapshot.meeting_id}:${input.actionId}:${input.branch}`
            : `${input.snapshot.meeting_id}:${input.actionId}`;
    }

    private async loadProjectContextBundle(): Promise<ProjectContextBundle> {
        if (!this.getProjectContext) {
            return emptyProjectContextBundle();
        }

        try {
            const bundle = await this.getProjectContext();
            return bundle;
        } catch (error: unknown) {
            const warning = `Project context could not be loaded: ${
                error instanceof Error ? error.message : String(error ?? 'unknown error')
            }`;
            return {
                ...emptyProjectContextBundle(),
                warnings: [warning],
            };
        }
    }

    private appendSharedActionHistory(meetingId: string, entry: string): void {
        const trimmed = entry.trim();
        if (!trimmed) {
            return;
        }
        const existing = this.sharedActionHistoryByMeeting.get(meetingId) ?? [];
        const next = [...existing, trimmed].slice(-8);
        this.sharedActionHistoryByMeeting.set(meetingId, next);
    }

    private getSharedActionHistory(meetingId: string): string {
        return (this.sharedActionHistoryByMeeting.get(meetingId) ?? []).join('\n\n');
    }

    private formatSingleActionHistory(label: string, finalText: string): string {
        return `${label}\n${finalText.trim()}`.trim();
    }

    private formatParallelActionHistory(
        label: string,
        outcomes: Array<Extract<BranchOutcome, { status: 'success' }>>
    ): string {
        const parts = outcomes
            .map((outcome) => {
                const branch = outcome.metrics.branch === 'fast' || outcome.metrics.branch === 'deep'
                    ? outcome.metrics.branch
                    : 'single';
                return `[${branch}] ${outcome.finalText.trim()}`.trim();
            })
            .filter((value) => value.length > 0);
        return [label, ...parts].join('\n');
    }

    private async buildFreshnessEvidence(input: {
        decision: FreshnessDecision;
        prompt: string;
        recentTranscriptText: string;
        signal?: AbortSignal;
    }): Promise<FreshnessEvidence> {
        if (!input.decision.shouldVerify || !this.freshnessTools) {
            return {
                used: false,
                sources: [],
                queries: [],
                resultCount: 0,
                dynamicContextText: '',
                warnings: [],
            };
        }

        const modelIds = extractSafeOpenRouterModelIds(
            input.prompt,
            input.recentTranscriptText
        );
        if (modelIds.length === 0) {
            return {
                used: false,
                sources: [],
                queries: [],
                resultCount: 0,
                dynamicContextText: [
                    '<dynamic_evidence_context>',
                    'No safe public OpenRouter model ID was recognized for catalog lookup.',
                    FRESHNESS_UNVERIFIED_CAVEAT,
                    '</dynamic_evidence_context>',
                ].join('\n'),
                warnings: ['no_safe_model_id'],
            };
        }

        const queries = modelIds.slice(0, 3);
        const models: ModelInfo[] = [];
        const warnings: string[] = [];

        for (const modelId of queries) {
            try {
                models.push(await this.freshnessTools.getOpenRouterModel(modelId, input.signal));
            } catch (error: unknown) {
                warnings.push(
                    toBoundedString(
                        sanitizeText(error instanceof Error ? error.message : String(error)),
                        256
                    )
                );
            }
        }

        if (models.length === 0) {
            return {
                used: true,
                sources: ['OpenRouter model catalog'],
                queries,
                resultCount: 0,
                dynamicContextText: [
                    '<dynamic_evidence_context>',
                    'OpenRouter model catalog lookup was attempted, but no current model metadata was returned.',
                    FRESHNESS_UNVERIFIED_CAVEAT,
                    '</dynamic_evidence_context>',
                ].join('\n'),
                warnings: warnings.length > 0 ? warnings : ['verification_unavailable'],
            };
        }

        const verifiedAt = models[0].checked_at;
        return {
            used: true,
            sources: ['OpenRouter model catalog'],
            queries,
            resultCount: models.length,
            verifiedAt,
            dynamicContextText: [
                '<dynamic_evidence_context>',
                `Source: OpenRouter model catalog`,
                `Verified at: ${verifiedAt}`,
                'Model metadata:',
                ...models.map(formatModelEvidence),
                '</dynamic_evidence_context>',
            ].join('\n'),
            warnings,
        };
    }

    private async executeBranch(input: {
        runId: string;
        actionId: string;
        snapshot: TranscriptSnapshot;
        startedAt: number;
        branch: ActionPane;
        pane: ActionPane;
        branchConfig: RunnerBranchConfig;
        sessionBranch?: ActionPane;
        pinnedContext: string;
        projectContextBundle: ProjectContextBundle;
        imagePaths?: string[];
    }): Promise<BranchOutcome> {
        const activeRun = this.activeRuns.get(input.runId);
        const activeBranch = activeRun?.branches[input.branch];
        if (!activeRun || !activeBranch) {
            return { status: 'cancelled' };
        }

        const baseCodeContext = this.getCodeContext();
        // full_cached branches always get the docs; recent-mode branches only opt in
        // explicitly via project_docs_enabled (e.g. quick-answer) — a sibling branch in a
        // parallel action (like tech-solver-parallel.fast) that didn't opt in stays lean.
        const branchWantsProjectDocs =
            input.branchConfig.context_mode === 'full_cached' || Boolean(input.branchConfig.project_docs_enabled);
        const projectDocsContext = branchWantsProjectDocs ? input.projectContextBundle.text : '';
        const projectContextWarnings = input.projectContextBundle.warnings ?? [];
        const freshnessDecision = classifyFreshnessNeed({
            actionId: input.actionId,
            branch: input.branch === 'main' ? 'single' : input.branch,
            prompt: input.branchConfig.prompt,
            recentTranscriptText: recentTranscriptText(input.snapshot),
            toolsAvailable: this.hasFreshnessTools(),
        });
        const freshnessEvidence = await this.buildFreshnessEvidence({
            decision: freshnessDecision,
            prompt: input.branchConfig.prompt,
            recentTranscriptText: recentTranscriptText(input.snapshot),
            signal: activeBranch.abortController.signal,
        });
        const freshnessMetrics =
            freshnessEvidence.dynamicContextText || freshnessEvidence.queries.length > 0
                ? freshnessMetricsFromEvidence(freshnessEvidence)
                : freshnessMetricsFromDecision(freshnessDecision);
        const freshnessGuidance =
            freshnessDecision.shouldCaveat ||
            (freshnessDecision.shouldVerify && freshnessEvidence.resultCount === 0)
                ? FRESHNESS_UNVERIFIED_CAVEAT
                : undefined;
        const actionHistoryBefore = this.getSharedActionHistory(input.snapshot.meeting_id);
        const context = this.buildContext({
            mode: input.branchConfig.context_mode,
            snapshot: input.snapshot,
            stableInstructions: this.getStableInstructions(),
            customContext: this.getCustomContext(),
            projectDocsContext,
            pinnedContext: input.pinnedContext,
            actionHistory: actionHistoryBefore,
            currentAction: input.branchConfig.prompt,
            dynamicEvidenceContext: freshnessEvidence.dynamicContextText,
            freshnessGuidance,
            contextMinutes: input.branchConfig.context_minutes,
            codeContext: baseCodeContext,
            now:
                input.snapshot.chunks[input.snapshot.chunks.length - 1]?.end_ts ??
                new Date().toISOString(),
        });
        let serialized = this.buildMessages({
            context,
            cachePolicy: input.branchConfig.cache_policy,
        });
        let toolLoopMetrics: Pick<
            LlmCallMetrics,
            'tool_rounds' | 'tool_calls' | 'code_context_included'
        > | undefined;
        let toolLoopWarnings: string[] = [...projectContextWarnings];

        if (input.branchConfig.tools_enabled) {
            if (!this.toolLoop) {
                throw new Error('Meeting Copilot tool loop is not configured for tool-enabled actions');
            }

            const toolLoopResult = await this.toolLoop.run({
                runId: input.runId,
                pane: input.pane,
                messages: serialized.messages,
                branchConfig: input.branchConfig,
                session_id: this.resolveSessionId({
                    runId: input.runId,
                    actionId: input.actionId,
                    snapshot: input.snapshot,
                    branch: input.sessionBranch,
                }),
                signal: activeBranch.abortController.signal,
                emitStatus: (message) => {
                    this.emitEvent({
                        type: 'action:tool_status',
                        runId: input.runId,
                        pane: input.pane,
                        message,
                    });
                },
                codeContextMaxChars: resolveCodeContextMaxChars(this.config),
            });

            if (
                activeRun.cancelled ||
                activeBranch.cancelled ||
                activeBranch.abortController.signal.aborted
            ) {
                activeBranch.finished = true;
                return { status: 'cancelled' };
            }

            toolLoopMetrics = toolLoopResult.metrics;
            toolLoopWarnings = this.mergeWarnings(toolLoopWarnings, toolLoopResult.warnings) ?? [];
            const refreshedContext = this.buildContext({
                mode: input.branchConfig.context_mode,
                snapshot: input.snapshot,
                stableInstructions: this.getStableInstructions(),
                customContext: this.getCustomContext(),
                projectDocsContext,
                pinnedContext: input.pinnedContext,
                actionHistory: actionHistoryBefore,
                currentAction: input.branchConfig.prompt,
                dynamicEvidenceContext: freshnessEvidence.dynamicContextText,
                freshnessGuidance,
                contextMinutes: input.branchConfig.context_minutes,
                codeContext: toolLoopResult.evidenceText,
                now:
                    input.snapshot.chunks[input.snapshot.chunks.length - 1]?.end_ts ??
                    new Date().toISOString(),
            });
            serialized = this.buildMessages({
                context: refreshedContext,
                cachePolicy: input.branchConfig.cache_policy,
            });
        }

        const startedAt = input.startedAt;
        let firstTokenAt: number | undefined;
        let finalText = '';
        const imageBlocks = input.imagePaths?.length ? await buildImageContentBlocks(input.imagePaths) : [];
        const messages = appendImageBlocksToMessages(serialized.messages, imageBlocks);

        try {
            const stream = this.openRouterClient.streamChatCompletion({
                model: input.branchConfig.model,
                messages,
                max_tokens: input.branchConfig.max_tokens,
                temperature: input.branchConfig.temperature,
                stream: true,
                plugins: input.branchConfig.web_search_enabled ? WEB_SEARCH_PLUGIN : undefined,
                reasoning: input.branchConfig.reasoning,
                session_id: this.resolveSessionId({
                    runId: input.runId,
                    actionId: input.actionId,
                    snapshot: input.snapshot,
                    branch: input.sessionBranch,
                }),
                cache_policy: input.branchConfig.cache_policy,
                signal: activeBranch.abortController.signal,
            });

            for await (const event of stream) {
                const currentRun = this.activeRuns.get(input.runId);
                const currentBranch = currentRun?.branches[input.branch];
                if (!currentRun || !currentBranch) {
                    return { status: 'cancelled' };
                }

                if (event.type === 'token') {
                    if (firstTokenAt === undefined) {
                        firstTokenAt = this.now();
                    }
                    finalText += toBoundedString(event.token);
                    this.emitEvent({
                        type: 'action:token',
                        runId: input.runId,
                        pane: input.pane,
                        token: toBoundedString(event.token),
                    });
                    continue;
                }

                if (currentRun.cancelled || currentBranch.cancelled || activeBranch.abortController.signal.aborted) {
                    currentBranch.finished = true;
                    return { status: 'cancelled' };
                }

                const completedAt = this.now();
                const metrics: LlmCallMetrics = {
                    ...event.result.metrics,
                    meeting_id: input.snapshot.meeting_id,
                    action_id: input.actionId,
                    branch: input.branch === 'main' ? 'single' : input.branch,
                    model: input.branchConfig.model,
                    context_mode: input.branchConfig.context_mode,
                    cache_policy: input.branchConfig.cache_policy,
                    tool_rounds: toolLoopMetrics?.tool_rounds,
                    tool_calls: toolLoopMetrics?.tool_calls,
                    code_context_included: toolLoopMetrics?.code_context_included,
                    time_to_first_token_ms:
                        firstTokenAt === undefined
                            ? event.result.metrics.time_to_first_token_ms
                            : firstTokenAt - startedAt,
                    total_latency_ms: completedAt - startedAt,
                    ...projectContextMetricsFromBundle(input.projectContextBundle),
                    ...freshnessMetrics,
                    success: true,
                };

                this.metricsStore?.record(metrics);

                this.emitEvent({
                    type: 'metrics:update',
                    metrics,
                });

                const completedText = finalText.trim() || toBoundedString(event.result.content);
                await this.recordReviewLog({
                    runId: input.runId,
                    actionId: input.actionId,
                    snapshot: input.snapshot,
                    branch: input.branch === 'main' ? 'single' : input.branch,
                    finalText: completedText,
                    actionHistoryBefore,
                    imagePaths: input.imagePaths ?? [],
                    metrics,
                });

                currentBranch.finished = true;
                return {
                    status: 'success',
                    metrics,
                    warnings: this.mergeWarnings(toolLoopWarnings, event.result.warnings),
                    finalText: completedText,
                };
            }

            activeBranch.finished = true;
            return { status: 'cancelled' };
        } catch (error: unknown) {
            const currentRun = this.activeRuns.get(input.runId);
            const currentBranch = currentRun?.branches[input.branch];
            if (currentRun?.cancelled || currentBranch?.cancelled || isAbortError(error)) {
                if (currentBranch) {
                    currentBranch.finished = true;
                }
                return { status: 'cancelled' };
            }

            let errorType: string | undefined;
            let message: string;
            if (isAuthError(error)) {
                errorType = 'auth';
                message = buildAuthErrorMessage();
            } else if (isRateLimitError(error)) {
                errorType = 'rate_limit';
                message = buildRateLimitMessage();
            } else if (isProviderContextLimitError(error)) {
                errorType = 'context_limit';
                message = buildProviderContextLimitMessage();
            } else {
                message = toBoundedString(sanitizeText(error instanceof Error ? error.message : String(error)));
            }

            this.metricsStore?.record({
                error: message,
                error_type: errorType,
                success: false,
                action_id: input.actionId,
                branch: input.branch === 'main' ? 'single' : input.branch,
                model: input.branchConfig.model,
                context_mode: input.branchConfig.context_mode,
                cache_policy: input.branchConfig.cache_policy,
                ...projectContextMetricsFromBundle(input.projectContextBundle),
                ...freshnessMetrics,
            });

            this.emitEvent({
                type: 'action:error',
                runId: input.runId,
                error: message,
                error_type: errorType,
                pane: input.pane,
            });
            if (currentBranch) {
                currentBranch.finished = true;
            }
            return { status: 'error', error: message };
        } finally {
            const currentRun = this.activeRuns.get(input.runId);
            const currentBranch = currentRun?.branches[input.branch];
            if (currentBranch) {
                currentBranch.finished = true;
            }
        }
    }

    private buildAggregateMetrics(input: {
        meetingId: string;
        actionId: string;
        startedAt: number;
        outcomes: Array<Extract<BranchOutcome, { status: 'success' }>>;
    }): LlmCallMetrics {
        const earliestFirstToken = input.outcomes
            .map((outcome) => outcome.metrics.time_to_first_token_ms)
            .filter((value): value is number => typeof value === 'number')
            .sort((a, b) => a - b)[0];
        const latestLatency = input.outcomes
            .map((outcome) => outcome.metrics.total_latency_ms)
            .filter((value): value is number => typeof value === 'number')
            .sort((a, b) => b - a)[0];
        const projectContextMetrics = mergeProjectContextMetrics(
            input.outcomes.map((outcome) => ({
                project_context_included: outcome.metrics.project_context_included,
                project_context_pack_names: outcome.metrics.project_context_pack_names,
                project_context_chars: outcome.metrics.project_context_chars,
                project_context_file_count: outcome.metrics.project_context_file_count,
            }))
        );
        const freshnessMetrics = mergeFreshnessMetrics(
            input.outcomes.map((outcome) => ({
                freshness_check_used: outcome.metrics.freshness_check_used,
                freshness_sources: outcome.metrics.freshness_sources,
                freshness_query_count: outcome.metrics.freshness_query_count,
                freshness_result_count: outcome.metrics.freshness_result_count,
                freshness_verified_at: outcome.metrics.freshness_verified_at,
                freshness_error: outcome.metrics.freshness_error,
            }))
        );

        return {
            meeting_id: input.meetingId,
            action_id: input.actionId,
            branch: 'single',
            success: true,
            prompt_tokens: input.outcomes.reduce(
                (sum, outcome) => sum + (outcome.metrics.prompt_tokens ?? 0),
                0
            ),
            completion_tokens: input.outcomes.reduce(
                (sum, outcome) => sum + (outcome.metrics.completion_tokens ?? 0),
                0
            ),
            total_tokens: input.outcomes.reduce(
                (sum, outcome) => sum + (outcome.metrics.total_tokens ?? 0),
                0
            ),
            cached_tokens: input.outcomes.reduce(
                (sum, outcome) => sum + (outcome.metrics.cached_tokens ?? 0),
                0
            ),
            cache_write_tokens: input.outcomes.reduce(
                (sum, outcome) => sum + (outcome.metrics.cache_write_tokens ?? 0),
                0
            ),
            tool_rounds: input.outcomes.reduce(
                (sum, outcome) => sum + (outcome.metrics.tool_rounds ?? 0),
                0
            ),
            tool_calls: input.outcomes.reduce(
                (sum, outcome) => sum + (outcome.metrics.tool_calls ?? 0),
                0
            ),
            code_context_included: input.outcomes.some(
                (outcome) => outcome.metrics.code_context_included === true
            ),
            time_to_first_token_ms: earliestFirstToken,
            total_latency_ms: latestLatency ?? this.now() - input.startedAt,
            ...projectContextMetrics,
            ...freshnessMetrics,
        };
    }

    private collectWarnings(
        outcomes: Array<Extract<BranchOutcome, { status: 'success' }>>
    ): string[] | undefined {
        const warnings = outcomes.flatMap((outcome) => outcome.warnings ?? []);
        const deduped = [...new Set(warnings)].filter((warning) => warning.length > 0);
        return deduped.length > 0 ? deduped : undefined;
    }

    private mergeWarnings(...warningLists: Array<string[] | undefined>): string[] | undefined {
        const warnings = warningLists.flatMap((list) => list ?? []);
        const deduped = [...new Set(warnings)].filter((warning) => warning.length > 0);
        return deduped.length > 0 ? deduped : undefined;
    }

    private async recordReviewLog(input: {
        runId: string;
        actionId: string;
        snapshot: TranscriptSnapshot;
        branch: string;
        finalText: string;
        actionHistoryBefore: string;
        imagePaths: string[];
        metrics: LlmCallMetrics;
    }): Promise<void> {
        if (!this.reviewLogStore) {
            return;
        }
        try {
            await this.reviewLogStore.record({
                type: 'action_completed',
                meeting_id: input.snapshot.meeting_id,
                run_id: input.runId,
                action_id: input.actionId,
                branch: input.branch,
                final_text: input.finalText,
                transcript_snapshot: trimTranscriptSnapshot(
                    input.snapshot,
                    reviewLogMaxTranscriptChars(this.config)
                ),
                action_history_before: input.actionHistoryBefore,
                image_paths: input.imagePaths,
                metrics: input.metrics,
            });
        } catch (error: unknown) {
            console.warn(
                'Meeting Copilot review log write failed:',
                error instanceof Error ? error.message : String(error)
            );
        }
    }
}

function reviewLogMaxTranscriptChars(config: ActionRunManagerConfig): number {
    if ('review_log' in config && typeof config.review_log?.max_transcript_chars === 'number') {
        return config.review_log.max_transcript_chars;
    }
    return 80_000;
}

function trimTranscriptSnapshot(snapshot: TranscriptSnapshot, maxChars: number): TranscriptSnapshot {
    let remaining = Math.max(0, maxChars);
    const chunks: TranscriptSnapshot['chunks'] = [];

    for (let index = snapshot.chunks.length - 1; index >= 0; index -= 1) {
        const chunk = snapshot.chunks[index];
        if (remaining <= 0) {
            break;
        }
        const text = chunk.text.length <= remaining
            ? chunk.text
            : chunk.text.slice(chunk.text.length - remaining);
        remaining -= text.length;
        chunks.unshift({ ...chunk, text });
    }

    return {
        meeting_id: snapshot.meeting_id,
        chunks,
    };
}
