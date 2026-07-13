import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_MEETING_COPILOT_CONFIG, getDefaultMeetingCopilotConfig } from './defaultActionConfig';
import {
    ActionBranchConfig,
    MeetingCopilotActionConfig,
    MeetingCopilotConfig,
    MeetingCopilotConfigFile,
    MeetingCopilotPreset,
    ReasoningEffort,
    ProjectContextConfig,
    ProjectContextPack,
    OverlayConfig,
} from './types';

export interface ActionConfigStoreOptions {
    configDir: string;
    fileName?: string;
}

type JsonObject = Record<string, unknown>;

const CONTEXT_MODES = ['recent', 'full_cached'] as const;
const CACHE_POLICIES = ['none', 'anthropic_explicit_5m', 'anthropic_explicit_1h'] as const;
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export class ActionConfigStore {
    private readonly configDir: string;
    private readonly fileName: string;
    private config: MeetingCopilotConfig;

    constructor(options: ActionConfigStoreOptions) {
        this.configDir = options.configDir;
        this.fileName = options.fileName ?? 'meeting-copilot.config.json';
        this.config = validateMeetingCopilotConfig(cloneDefaultConfig());
    }

    async load(): Promise<MeetingCopilotConfig> {
        const overridePath = path.join(this.configDir, this.fileName);
        let resolvedConfig: unknown = cloneDefaultConfig();

        try {
            const file = await fs.readFile(overridePath, 'utf8');
            const parsed = JSON.parse(file) as unknown;
            const defaultConfig = cloneDefaultConfig(resolvePreset(parsed));
            resolvedConfig = deepMerge(defaultConfig as unknown as JsonObject, parsed);
        } catch (error: unknown) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError?.code !== 'ENOENT') {
                throw new Error(`Failed to load meeting copilot config from ${overridePath}: ${nodeError.message}`);
            }
        }

        this.config = validateMeetingCopilotConfig(resolvedConfig);
        return this.config;
    }

    loadSync(): MeetingCopilotConfig {
        const overridePath = path.join(this.configDir, this.fileName);
        let resolvedConfig: unknown = cloneDefaultConfig();

        try {
            const file = readFileSync(overridePath, 'utf8');
            const parsed = JSON.parse(file) as unknown;
            const defaultConfig = cloneDefaultConfig(resolvePreset(parsed));
            resolvedConfig = deepMerge(defaultConfig as unknown as JsonObject, parsed);
        } catch (error: unknown) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError?.code !== 'ENOENT') {
                throw new Error(`Failed to load meeting copilot config from ${overridePath}: ${nodeError.message}`);
            }
        }

        this.config = validateMeetingCopilotConfig(resolvedConfig);
        return this.config;
    }

    getAction(actionId: string): MeetingCopilotActionConfig | undefined {
        return this.config.actions[actionId];
    }

    listActions(): Array<{ id: string; action: MeetingCopilotActionConfig }> {
        return Object.entries(this.config.actions).map(([id, action]) => ({ id, action }));
    }
}

export function validateMeetingCopilotConfig(value: unknown): MeetingCopilotConfig {
    assertObject(value, 'config');

    const config = value as JsonObject;
    const openrouter = validateOpenRouterConfig(config.openrouter, 'openrouter');
    const actions = validateActions(config.actions, 'actions');
    const overlay = validateOverlay(config.overlay, 'overlay');
    const workspaces = validateWorkspaces(config.workspaces, 'workspaces');
    const codeContext = validateCodeContext(config.code_context, 'code_context');
    const transcriptContext = validateTranscriptContext(config.transcript_context, 'transcript_context');
    const reviewLog = validateReviewLog(config.review_log, 'review_log');
    const projectContext = validateProjectContext(config.project_context, 'project_context');

    return {
        openrouter,
        actions,
        overlay,
        workspaces,
        code_context: codeContext,
        transcript_context: transcriptContext,
        review_log: reviewLog,
        project_context: projectContext,
    };
}

function validateOverlay(value: unknown, pathName: string): OverlayConfig {
    assertObject(value, pathName);

    return {
        move_step_px: requirePositiveInteger(value.move_step_px, `${pathName}.move_step_px`),
    };
}

function validateOpenRouterConfig(value: unknown, pathName: string) {
    assertObject(value, pathName);

    const baseUrl = requireNonEmptyString(value.base_url, `${pathName}.base_url`);
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(baseUrl);
    } catch {
        throw new Error(`${pathName}.base_url must be a non-empty HTTP(S) URL`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`${pathName}.base_url must be a non-empty HTTP(S) URL`);
    }

    const apiKeyEnv = requireNonEmptyString(value.api_key_env, `${pathName}.api_key_env`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        throw new Error(`${pathName}.api_key_env must be a non-empty environment variable name`);
    }

    let defaultHeaders: Record<string, string> | undefined;
    if (value.default_headers !== undefined) {
        assertObject(value.default_headers, `${pathName}.default_headers`);
        defaultHeaders = {};
        for (const [key, headerValue] of Object.entries(value.default_headers)) {
            if (typeof headerValue !== 'string' || headerValue.trim() === '') {
                throw new Error(`${pathName}.default_headers.${key} must be a non-empty string`);
            }
            defaultHeaders[key] = headerValue;
        }
    }

    return {
        base_url: baseUrl,
        api_key_env: apiKeyEnv,
        default_headers: defaultHeaders,
    };
}

function validateActions(value: unknown, pathName: string): Record<string, MeetingCopilotActionConfig> {
    assertObject(value, pathName);

    const entries = Object.entries(value);
    if (entries.length === 0) {
        throw new Error(`${pathName} must be a non-empty object`);
    }

    const hotkeys = new Map<string, string>();
    const actions: Record<string, MeetingCopilotActionConfig> = {};

    for (const [actionId, actionValue] of entries) {
        const actionPath = `${pathName}.${actionId}`;
        assertObject(actionValue, actionPath);

        const label = requireNonEmptyString(actionValue.label, `${actionPath}.label`);
        const trigger = validateTrigger(actionValue.trigger, `${actionPath}.trigger`);
        const normalizedHotkey = normalizeAccelerator(trigger.hotkey);
        const duplicateOwner = hotkeys.get(normalizedHotkey);
        if (duplicateOwner) {
            throw new Error(`${actionPath}.trigger.hotkey must be unique; duplicate ${trigger.hotkey}`);
        }
        hotkeys.set(normalizedHotkey, actionId);

        if ('parallel' in actionValue && actionValue.parallel !== undefined) {
            assertObject(actionValue.parallel, `${actionPath}.parallel`);
            const fast = validateBranch(actionValue.parallel.fast, `${actionPath}.parallel.fast`);
            const deep = validateBranch(actionValue.parallel.deep, `${actionPath}.parallel.deep`);
            actions[actionId] = {
                label,
                trigger,
                parallel: {
                    fast,
                    deep,
                },
            };
            continue;
        }

        if ('parallel' in actionValue) {
            throw new Error(`${actionPath}.parallel must not be present on single actions`);
        }

        actions[actionId] = {
            label,
            trigger,
            ...validateBranch(actionValue, actionPath),
        };
    }

    return actions;
}

function normalizeAccelerator(accelerator: string): string {
    return accelerator
        .split('+')
        .map((part) => part.trim().toLowerCase())
        .sort()
        .join('+');
}

function validateTrigger(value: unknown, pathName: string) {
    assertObject(value, pathName);

    const hotkey = requireNonEmptyString(value.hotkey, `${pathName}.hotkey`);
    let slash: string | undefined;
    if (value.slash !== undefined) {
        slash = requireNonEmptyString(value.slash, `${pathName}.slash`);
    }
    let button: boolean | undefined;
    if (value.button !== undefined) {
        if (typeof value.button !== 'boolean') {
            throw new Error(`${pathName}.button must be a boolean`);
        }
        button = value.button;
    }

    return {
        hotkey,
        slash,
        button,
    };
}

function validateBranch(value: unknown, pathName: string): ActionBranchConfig {
    assertObject(value, pathName);

    const model = requireNonEmptyString(value.model, `${pathName}.model`);
    const contextMode = requireEnum(value.context_mode, `${pathName}.context_mode`, CONTEXT_MODES);
    const cachePolicy = requireEnum(value.cache_policy, `${pathName}.cache_policy`, CACHE_POLICIES);
    let maxTokens: number | undefined;
    if (value.max_tokens !== undefined) {
        maxTokens = requirePositiveInteger(value.max_tokens, `${pathName}.max_tokens`);
    }
    const temperature = requireFiniteNumber(value.temperature, `${pathName}.temperature`);
    const prompt = requireNonEmptyString(value.prompt, `${pathName}.prompt`);

    let contextMinutes: number | undefined;
    if (value.context_minutes !== undefined) {
        contextMinutes = requirePositiveNumber(value.context_minutes, `${pathName}.context_minutes`);
    }

    let reasoning: { effort?: ReasoningEffort } | undefined;
    if (value.reasoning !== undefined) {
        assertObject(value.reasoning, `${pathName}.reasoning`);
        if (value.reasoning.effort !== undefined) {
            reasoning = {
                effort: requireEnum(
                    value.reasoning.effort,
                    `${pathName}.reasoning.effort`,
                    REASONING_EFFORTS
                ),
            };
        } else {
            reasoning = {};
        }
    }

    let toolsEnabled: boolean | undefined;
    if (value.tools_enabled !== undefined) {
        if (typeof value.tools_enabled !== 'boolean') {
            throw new Error(`${pathName}.tools_enabled must be a boolean`);
        }
        toolsEnabled = value.tools_enabled;
    }

    let maxToolRounds: number | undefined;
    if (value.max_tool_rounds !== undefined) {
        maxToolRounds = requireNonNegativeInteger(value.max_tool_rounds, `${pathName}.max_tool_rounds`);
    }

    let maxToolCallsPerRound: number | undefined;
    if (value.max_tool_calls_per_round !== undefined) {
        maxToolCallsPerRound = requireNonNegativeInteger(
            value.max_tool_calls_per_round,
            `${pathName}.max_tool_calls_per_round`
        );
    }

    let webSearchEnabled: boolean | undefined;
    if (value.web_search_enabled !== undefined) {
        if (typeof value.web_search_enabled !== 'boolean') {
            throw new Error(`${pathName}.web_search_enabled must be a boolean`);
        }
        webSearchEnabled = value.web_search_enabled;
    }

    let projectDocsEnabled: boolean | undefined;
    if (value.project_docs_enabled !== undefined) {
        if (typeof value.project_docs_enabled !== 'boolean') {
            throw new Error(`${pathName}.project_docs_enabled must be a boolean`);
        }
        projectDocsEnabled = value.project_docs_enabled;
    }

    return {
        model,
        context_mode: contextMode,
        cache_policy: cachePolicy,
        context_minutes: contextMinutes,
        max_tokens: maxTokens,
        temperature,
        reasoning,
        tools_enabled: toolsEnabled,
        max_tool_rounds: maxToolRounds,
        max_tool_calls_per_round: maxToolCallsPerRound,
        web_search_enabled: webSearchEnabled,
        project_docs_enabled: projectDocsEnabled,
        prompt,
    };
}

function validateWorkspaces(value: unknown, pathName: string) {
    if (!Array.isArray(value)) {
        throw new Error(`${pathName} must be an array`);
    }

    return value.map((workspace, index) => {
        const workspacePath = `${pathName}.${index}`;
        assertObject(workspace, workspacePath);

        const name = requireNonEmptyString(workspace.name, `${workspacePath}.name`);
        const resolvedPath = requireNonEmptyString(workspace.path, `${workspacePath}.path`);
        if (typeof workspace.enabled !== 'boolean') {
            throw new Error(`${workspacePath}.enabled must be a boolean`);
        }

        return {
            name,
            path: resolvedPath,
            enabled: workspace.enabled,
            max_snippets: requirePositiveInteger(workspace.max_snippets, `${workspacePath}.max_snippets`),
            max_snippet_chars: requirePositiveInteger(
                workspace.max_snippet_chars,
                `${workspacePath}.max_snippet_chars`
            ),
        };
    });
}

function validateCodeContext(value: unknown, pathName: string) {
    assertObject(value, pathName);

    if (typeof value.enabled !== 'boolean') {
        throw new Error(`${pathName}.enabled must be a boolean`);
    }
    if (value.retrieval_mode !== 'tool_loop') {
        throw new Error(`${pathName}.retrieval_mode must be tool_loop`);
    }
    if (typeof value.include_file_paths !== 'boolean') {
        throw new Error(`${pathName}.include_file_paths must be a boolean`);
    }
    if (typeof value.include_line_numbers !== 'boolean') {
        throw new Error(`${pathName}.include_line_numbers must be a boolean`);
    }

    return {
        enabled: value.enabled,
        retrieval_mode: 'tool_loop' as const,
        max_total_chars: requirePositiveInteger(value.max_total_chars, `${pathName}.max_total_chars`),
        include_file_paths: value.include_file_paths,
        include_line_numbers: value.include_line_numbers,
    };
}

function validateTranscriptContext(value: unknown, pathName: string) {
    assertObject(value, pathName);

    return {
        max_total_chars: requirePositiveInteger(value.max_total_chars, `${pathName}.max_total_chars`),
    };
}

function validateReviewLog(value: unknown, pathName: string) {
    assertObject(value, pathName);

    if (typeof value.enabled !== 'boolean') {
        throw new Error(`${pathName}.enabled must be a boolean`);
    }

    return {
        enabled: value.enabled,
        max_transcript_chars: requirePositiveInteger(
            value.max_transcript_chars,
            `${pathName}.max_transcript_chars`
        ),
    };
}

function validateProjectContext(value: unknown, pathName: string): ProjectContextConfig {
    if (value === undefined) {
        return {
            enabled: false,
            max_docs_chars_per_pack: 20_000,
            max_total_docs_chars: 40_000,
            packs: [],
        };
    }

    assertObject(value, pathName);

    if (typeof value.enabled !== 'boolean') {
        throw new Error(`${pathName}.enabled must be a boolean`);
    }

    const maxDocsCharsPerPack = requirePositiveInteger(
        value.max_docs_chars_per_pack,
        `${pathName}.max_docs_chars_per_pack`
    );
    const maxTotalDocsChars = requirePositiveInteger(
        value.max_total_docs_chars,
        `${pathName}.max_total_docs_chars`
    );

    if (!Array.isArray(value.packs)) {
        throw new Error(`${pathName}.packs must be an array`);
    }

    const packs = value.packs.map((pack, index) => validateProjectContextPack(pack, `${pathName}.packs.${index}`));

    return {
        enabled: value.enabled,
        max_docs_chars_per_pack: maxDocsCharsPerPack,
        max_total_docs_chars: maxTotalDocsChars,
        packs,
    };
}

function validateProjectContextPack(value: unknown, pathName: string): ProjectContextPack {
    assertObject(value, pathName);

    const name = requireNonEmptyString(value.name, `${pathName}.name`);
    const docsPath = requireNonEmptyString(value.docsPath, `${pathName}.docsPath`);

    let linkedWorkspaceName: string | undefined;
    if (value.linkedWorkspaceName !== undefined) {
        linkedWorkspaceName = requireNonEmptyString(value.linkedWorkspaceName, `${pathName}.linkedWorkspaceName`);
    }

    if (typeof value.enabled !== 'boolean') {
        throw new Error(`${pathName}.enabled must be a boolean`);
    }

    if (typeof value.includeByDefault !== 'boolean') {
        throw new Error(`${pathName}.includeByDefault must be a boolean`);
    }

    const maxDocsChars = requirePositiveInteger(value.maxDocsChars, `${pathName}.maxDocsChars`);

    return {
        name,
        docsPath,
        linkedWorkspaceName,
        enabled: value.enabled,
        includeByDefault: value.includeByDefault,
        maxDocsChars,
    };
}

function resolvePreset(value: unknown): MeetingCopilotPreset {
    if (!isPlainObject(value)) {
        return 'meeting-default';
    }
    const preset = (value as MeetingCopilotConfigFile).preset;
    if (preset === 'system-design-interview') {
        return preset;
    }
    return 'meeting-default';
}

function cloneDefaultConfig(preset: MeetingCopilotPreset = 'meeting-default'): MeetingCopilotConfig {
    if (preset === 'meeting-default') {
        return structuredClone(DEFAULT_MEETING_COPILOT_CONFIG);
    }
    return getDefaultMeetingCopilotConfig(preset);
}

function deepMerge(base: unknown, override: unknown): unknown {
    if (override === undefined) {
        return base;
    }
    if (Array.isArray(base) && Array.isArray(override)) {
        return override;
    }
    if (isPlainObject(base) && isPlainObject(override)) {
        const result: JsonObject = { ...base };
        for (const [key, value] of Object.entries(override)) {
            result[key] = key in result ? deepMerge(result[key], value) : value;
        }
        return result;
    }
    return override;
}

function assertObject(value: unknown, pathName: string): asserts value is JsonObject {
    if (!isPlainObject(value)) {
        throw new Error(`${pathName} must be an object`);
    }
}

function isPlainObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, pathName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${pathName} must be a non-empty string`);
    }
    return value;
}

function requireEnum<T extends readonly string[]>(
    value: unknown,
    pathName: string,
    allowed: T
): T[number] {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new Error(`${pathName} must be one of ${allowed.join(', ')}`);
    }
    return value as T[number];
}

function requirePositiveInteger(value: unknown, pathName: string): number {
    if (!Number.isInteger(value) || (value as number) <= 0) {
        throw new Error(`${pathName} must be a positive integer`);
    }
    return value as number;
}

function requireNonNegativeInteger(value: unknown, pathName: string): number {
    if (!Number.isInteger(value) || (value as number) < 0) {
        throw new Error(`${pathName} must be a non-negative integer`);
    }
    return value as number;
}

function requirePositiveNumber(value: unknown, pathName: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${pathName} must be positive`);
    }
    return value;
}

function requireFiniteNumber(value: unknown, pathName: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${pathName} must be a finite number`);
    }
    return value;
}
