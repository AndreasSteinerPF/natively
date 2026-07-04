import { redactForLog } from '../utils/redactForLog';

import {
    ActionRunToolLoop,
    CodeToolName,
    OpenRouterChatCompletionRequest,
    OpenRouterMessage,
    ToolLoopCodeTools,
    ToolLoopResult,
    ToolLoopRunInput,
} from './types';

export const CODE_TOOL_SCHEMAS = [
    {
        type: 'function',
        function: {
            name: 'list_workspaces',
            description: 'List enabled local code workspaces that can be searched or read.',
            parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_repo',
            description: 'Search an allowlisted local workspace with ripgrep and return compact matching snippets.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', minLength: 1, maxLength: 240 },
                    workspace: { type: 'string', maxLength: 256 },
                },
                required: ['query'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a bounded UTF-8 line slice from an allowlisted local workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', minLength: 1, maxLength: 4096 },
                    workspace: { type: 'string', maxLength: 256 },
                    start_line: { type: 'integer', minimum: 1 },
                    end_line: { type: 'integer', minimum: 1 },
                },
                required: ['path'],
                additionalProperties: false,
            },
        },
    },
] as const;

type ToolCallFunction = {
    name?: unknown;
    arguments?: unknown;
};

type ToolCall = {
    id?: unknown;
    type?: unknown;
    function?: ToolCallFunction;
};

type OpenRouterClientLike = {
    createChatCompletion: (
        request: OpenRouterChatCompletionRequest
    ) => Promise<{ content: string; tool_calls?: unknown[]; warnings: string[]; metrics: unknown }>;
};

const MAX_TOOL_RESULT_CHARS = 4_000;
const MAX_STATUS_CHARS = 500;
const MAX_TOOL_RESULT_STRING_CHARS = 512;
const MAX_TOOL_RESULT_ARRAY_ITEMS = 12;
const MAX_TOOL_RESULT_OBJECT_KEYS = 20;

function sanitizeText(value: string): string {
    return redactForLog([value]).trim();
}

function boundString(value: unknown, maxChars: number): string {
    return sanitizeText(String(value ?? '')).slice(0, maxChars);
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }
    const truncated = Math.trunc(parsed);
    return truncated > 0 ? truncated : undefined;
}

function normalizeCodeToolName(value: unknown): CodeToolName {
    if (value === 'list_workspaces' || value === 'search_repo' || value === 'read_file') {
        return value;
    }
    throw new Error(`Meeting Copilot code tool "${sanitizeText(String(value ?? ''))}" is not supported`);
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null || raw === '') {
        return {};
    }

    if (typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }

    if (typeof raw !== 'string') {
        throw new Error('Meeting Copilot tool arguments must be JSON');
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Meeting Copilot tool arguments must be a JSON object');
        }
        return parsed as Record<string, unknown>;
    } catch {
        throw new Error('Meeting Copilot tool arguments must be valid JSON');
    }
}

function createAbortError(): Error {
    const error = new Error('Meeting Copilot tool loop aborted');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

function getStringLength(value: unknown): number {
    return typeof value === 'string' ? value.length : 0;
}

function validateNoAdditionalProperties(
    args: Record<string, unknown>,
    allowedKeys: string[],
    toolName: string
): void {
    for (const key of Object.keys(args)) {
        if (!allowedKeys.includes(key)) {
            throw new Error(`Meeting Copilot ${toolName} tool does not accept additional properties`);
        }
    }
}

function validateSearchRepoArgs(args: Record<string, unknown>): {
    query: string;
    workspace?: string;
} {
    validateNoAdditionalProperties(args, ['query', 'workspace'], 'search_repo');
    if (typeof args.query !== 'string' || getStringLength(args.query) < 1 || getStringLength(args.query) > 240) {
        throw new Error('Meeting Copilot search_repo tool requires a query string between 1 and 240 characters');
    }
    if (args.workspace !== undefined && (typeof args.workspace !== 'string' || getStringLength(args.workspace) > 256)) {
        throw new Error('Meeting Copilot search_repo tool workspace must be a string up to 256 characters');
    }
    return {
        query: args.query,
        workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
    };
}

function validateReadFileArgs(args: Record<string, unknown>): {
    path: string;
    workspace?: string;
    start_line?: number;
    end_line?: number;
} {
    validateNoAdditionalProperties(args, ['path', 'workspace', 'start_line', 'end_line'], 'read_file');
    if (typeof args.path !== 'string' || getStringLength(args.path) < 1 || getStringLength(args.path) > 4096) {
        throw new Error('Meeting Copilot read_file tool requires a path string between 1 and 4096 characters');
    }
    if (args.workspace !== undefined && (typeof args.workspace !== 'string' || getStringLength(args.workspace) > 256)) {
        throw new Error('Meeting Copilot read_file tool workspace must be a string up to 256 characters');
    }
    const start_line = positiveIntegerOrUndefined(args.start_line);
    const end_line = positiveIntegerOrUndefined(args.end_line);
    if (args.start_line !== undefined && start_line === undefined) {
        throw new Error('Meeting Copilot read_file tool start_line must be a positive integer');
    }
    if (args.end_line !== undefined && end_line === undefined) {
        throw new Error('Meeting Copilot read_file tool end_line must be a positive integer');
    }
    return {
        path: args.path,
        workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
        start_line,
        end_line,
    };
}

function validateListWorkspacesArgs(args: Record<string, unknown>): Record<string, never> {
    validateNoAdditionalProperties(args, [], 'list_workspaces');
    return {};
}

function normalizeValidatedToolArguments(
    name: CodeToolName,
    args: Record<string, unknown>
): Record<string, unknown> {
    switch (name) {
        case 'list_workspaces':
            return validateListWorkspacesArgs(args);
        case 'search_repo':
            return validateSearchRepoArgs(args);
        case 'read_file':
            return validateReadFileArgs(args);
    }
}

function getToolCallFunction(toolCall: unknown): ToolCallFunction {
    if (!toolCall || typeof toolCall !== 'object') {
        throw new Error('Meeting Copilot tool call payload is invalid');
    }

    const call = toolCall as ToolCall;
    if (!call.function || typeof call.function !== 'object') {
        throw new Error('Meeting Copilot tool call function is missing');
    }

    return call.function;
}

function toolCallId(toolCall: unknown, fallbackIndex: number): string {
    if (!toolCall || typeof toolCall !== 'object') {
        return `tool-call-${fallbackIndex + 1}`;
    }
    const call = toolCall as ToolCall;
    if (typeof call.id === 'string' && call.id.trim() !== '') {
        return boundString(call.id, 256);
    }
    return `tool-call-${fallbackIndex + 1}`;
}

function normalizeWorkspace(value: unknown): string | undefined {
    const text = boundString(value, 256);
    return text.length > 0 ? text : undefined;
}

function buildCompactJson(value: unknown, maxChars = MAX_TOOL_RESULT_CHARS): string {
    try {
        const bounded = boundJsonValue(value);
        const serialized = JSON.stringify(bounded);
        if (serialized.length <= maxChars) {
            return serialized;
        }
        return JSON.stringify({
            truncated: true,
            summary: sanitizeText(serialized).slice(0, Math.max(0, maxChars - 60)),
        });
    } catch {
        return JSON.stringify({ error: 'unserializable_result' });
    }
}

function boundJsonValue(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === 'string') {
        return sanitizeText(value).slice(0, MAX_TOOL_RESULT_STRING_CHARS);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }

    if (Array.isArray(value)) {
        const items = value.slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS).map((item) => boundJsonValue(item, depth + 1));
        return value.length > MAX_TOOL_RESULT_ARRAY_ITEMS
            ? {
                  items,
                  truncated: true,
                  omitted: value.length - MAX_TOOL_RESULT_ARRAY_ITEMS,
              }
            : items;
    }

    if (typeof value === 'object') {
        if (depth >= 4) {
            return {
                truncated: true,
                value: sanitizeText(JSON.stringify(value)).slice(0, MAX_TOOL_RESULT_STRING_CHARS),
            };
        }

        const record = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        let count = 0;
        for (const key of Object.keys(record)) {
            if (count >= MAX_TOOL_RESULT_OBJECT_KEYS) {
                result.truncated = true;
                result.omitted_keys = Object.keys(record).length - MAX_TOOL_RESULT_OBJECT_KEYS;
                break;
            }
            result[key] = boundJsonValue(record[key], depth + 1);
            count += 1;
        }
        return result;
    }

    return sanitizeText(String(value)).slice(0, MAX_TOOL_RESULT_STRING_CHARS);
}

function compactStatus(message: string): string {
    return boundString(message, MAX_STATUS_CHARS);
}

function formatEvidenceBlock(input: {
    workspace?: string;
    path: string;
    startLine: number;
    endLine: number;
    body: string;
}): string {
    const prefix = input.workspace ? `[file: ${input.workspace}:${input.path} lines=${input.startLine}-${input.endLine}]` : `[file: ${input.path} lines=${input.startLine}-${input.endLine}]`;
    return `${prefix}\n${sanitizeText(input.body)}`.trimEnd();
}

function appendEvidenceText(
    existing: string,
    block: string,
    maxChars: number
): string {
    if (maxChars <= 0 || !block.trim()) {
        return existing;
    }

    const opening = '<code_context>';
    const closing = '</code_context>';
    const hasOpening = existing.startsWith(opening);
    const base = hasOpening ? existing.slice(0, -closing.length) : opening;
    const separator = hasOpening && base !== opening ? '\n\n' : '\n';
    const candidate = `${base}${separator}${block}`;

    if (candidate.length + closing.length <= maxChars) {
        return `${candidate}\n${closing}`;
    }

    const remaining = Math.max(0, maxChars - base.length - separator.length - closing.length);
    if (remaining <= 0) {
        return hasOpening ? existing : '';
    }

    const truncatedBlock = block.slice(0, remaining);
    const truncatedCandidate = `${base}${separator}${truncatedBlock}`;
    return `${truncatedCandidate}\n${closing}`;
}

function initializeEvidenceState(): { evidenceText: string; seen: Set<string> } {
    return {
        evidenceText: '',
        seen: new Set<string>(),
    };
}

function evidenceKey(input: {
    workspace?: string;
    path: string;
    startLine: number;
    endLine: number;
}): string {
    return `${input.workspace ?? ''}:${input.path}:${input.startLine}-${input.endLine}`;
}

function normalizeReadRange(input: {
    start_line?: unknown;
    end_line?: unknown;
}): { startLine: number; endLine: number } {
    const startLine = positiveIntegerOrUndefined(input.start_line) ?? 1;
    const parsedEnd = positiveIntegerOrUndefined(input.end_line);
    const endLine = parsedEnd === undefined ? startLine : Math.max(startLine, parsedEnd);
    return { startLine, endLine };
}

function formatSearchHitEvidence(hit: {
    workspace?: string;
    path: string;
    line: number;
    preview: string;
}): string {
    return formatEvidenceBlock({
        workspace: hit.workspace,
        path: hit.path,
        startLine: hit.line,
        endLine: hit.line,
        body: hit.preview,
    });
}

function formatFileSliceEvidence(slice: {
    workspace?: string;
    path: string;
    startLine: number;
    endLine: number;
    content: string;
}): string {
    return formatEvidenceBlock({
        workspace: slice.workspace,
        path: slice.path,
        startLine: slice.startLine,
        endLine: slice.endLine,
        body: slice.content,
    });
}

export class ToolLoop implements ActionRunToolLoop {
    private readonly openRouterClient: OpenRouterClientLike;

    private readonly codeTools: ToolLoopCodeTools;

    constructor(options: {
        openRouterClient: OpenRouterClientLike;
        codeTools: ToolLoopCodeTools;
    }) {
        this.openRouterClient = options.openRouterClient;
        this.codeTools = options.codeTools;
    }

    async run(input: ToolLoopRunInput): Promise<ToolLoopResult> {
        const messages: OpenRouterMessage[] = [...input.messages];
        const maxRounds = Math.max(0, Math.trunc(input.branchConfig.max_tool_rounds ?? 0));
        const maxToolCallsPerRound = Math.max(0, Math.trunc(input.branchConfig.max_tool_calls_per_round ?? 0));
        const evidenceState = initializeEvidenceState();
        let toolRounds = 0;
        let toolCalls = 0;

        for (let roundIndex = 0; roundIndex < maxRounds; roundIndex += 1) {
            throwIfAborted(input.signal);
            const result = await this.openRouterClient.createChatCompletion({
                model: input.branchConfig.model,
                messages,
                max_tokens: input.branchConfig.max_tokens,
                temperature: input.branchConfig.temperature,
                stream: false,
                tools: [...CODE_TOOL_SCHEMAS],
                tool_choice: 'auto',
                reasoning: input.branchConfig.reasoning,
                session_id: input.session_id,
                cache_policy: 'none',
                signal: input.signal,
            });
            throwIfAborted(input.signal);
            toolRounds += 1;

            messages.push({
                role: 'assistant',
                content: result.content,
                tool_calls: result.tool_calls,
            });

            const allToolCalls = Array.isArray(result.tool_calls) ? result.tool_calls : [];
            const toolCallList = allToolCalls.slice(0, maxToolCallsPerRound);
            if (toolCallList.length === 0) {
                input.emitStatus?.(compactStatus('Generating final answer...'));
                return {
                    messages,
                    evidenceText: evidenceState.evidenceText,
                    metrics: {
                        tool_rounds: toolRounds,
                        tool_calls: toolCalls,
                        code_context_included: evidenceState.evidenceText.trim().length > 0,
                    },
                    warnings: result.warnings.length > 0 ? result.warnings : undefined,
                };
            }

            for (const [index, rawToolCall] of toolCallList.entries()) {
                const functionCall = getToolCallFunction(rawToolCall);
                const name = normalizeCodeToolName(functionCall.name);
                const callArgs = normalizeValidatedToolArguments(name, parseToolArguments(functionCall.arguments));
                input.emitStatus?.(compactStatus(this.describeToolCallStatus(name, callArgs)));
                const callId = toolCallId(rawToolCall, index);
                throwIfAborted(input.signal);
                const toolMessage = await this.executeToolCall({
                    callId,
                    name,
                    args: callArgs,
                    evidenceState,
                    maxEvidenceChars: input.codeContextMaxChars,
                });
                throwIfAborted(input.signal);

                toolCalls += 1;
                messages.push({
                    role: 'tool',
                    tool_call_id: callId,
                    name,
                    content: buildCompactJson(toolMessage),
                });
            }

            if (allToolCalls.length > toolCallList.length) {
                input.emitStatus?.(compactStatus('Generating final answer...'));
                return {
                    messages,
                    evidenceText: evidenceState.evidenceText,
                    metrics: {
                        tool_rounds: toolRounds,
                        tool_calls: toolCalls,
                        code_context_included: evidenceState.evidenceText.trim().length > 0,
                    },
                };
            }

            if (roundIndex >= maxRounds - 1) {
                input.emitStatus?.(compactStatus('Generating final answer...'));
                return {
                    messages,
                    evidenceText: evidenceState.evidenceText,
                    metrics: {
                        tool_rounds: toolRounds,
                        tool_calls: toolCalls,
                        code_context_included: evidenceState.evidenceText.trim().length > 0,
                    },
                };
            }
        }

        input.emitStatus?.(compactStatus('Generating final answer...'));
        return {
            messages,
            evidenceText: evidenceState.evidenceText,
            metrics: {
                tool_rounds: toolRounds,
                tool_calls: toolCalls,
                code_context_included: evidenceState.evidenceText.trim().length > 0,
            },
        };
    }

    private describeToolCallStatus(name: CodeToolName, args: Record<string, unknown>): string {
        if (name === 'list_workspaces') {
            return 'Listing workspaces...';
        }

        if (name === 'search_repo') {
            return `Searching repo for "${boundString(args.query, 120)}"...`;
        }

        const range = normalizeReadRange(args);
        return `Reading ${boundString(args.path, 180)} lines ${range.startLine}-${range.endLine}...`;
    }

    private async executeToolCall(input: {
        callId: string;
        name: CodeToolName;
        args: Record<string, unknown>;
        evidenceState: { evidenceText: string; seen: Set<string> };
        maxEvidenceChars: number;
    }): Promise<unknown> {
        switch (input.name) {
            case 'list_workspaces': {
                const result = await this.codeTools.listWorkspaces();
                return this.appendEvidenceFromResult(input, result);
            }
            case 'search_repo': {
                const query = boundString(input.args.query, 240);
                if (!query) {
                    throw new Error('Meeting Copilot search_repo tool requires a query');
                }
                const workspace = normalizeWorkspace(input.args.workspace);
                const result = await this.codeTools.searchRepo({ query, workspace });
                return this.appendEvidenceFromResult(input, result);
            }
            case 'read_file': {
                const path = boundString(input.args.path, 4096);
                if (!path) {
                    throw new Error('Meeting Copilot read_file tool requires a path');
                }
                const workspace = normalizeWorkspace(input.args.workspace);
                const { startLine, endLine } = normalizeReadRange(input.args);
                const result = await this.codeTools.readFileSlice({
                    path,
                    workspace,
                    startLine,
                    endLine,
                });
                return this.appendEvidenceFromResult(input, result);
            }
        }
    }

    private appendEvidenceFromResult(
        input: {
            evidenceState: { evidenceText: string; seen: Set<string> };
            maxEvidenceChars: number;
        },
        result: unknown,
    ): unknown {
        if (Array.isArray(result)) {
            for (const item of result) {
                if (!item || typeof item !== 'object') {
                    continue;
                }
                const hit = item as {
                    workspace?: string;
                    path?: string;
                    line?: number;
                    preview?: string;
                };
                if (typeof hit.path !== 'string' || typeof hit.line !== 'number' || typeof hit.preview !== 'string') {
                    continue;
                }
                const block = formatSearchHitEvidence({
                    workspace: normalizeWorkspace(hit.workspace),
                    path: hit.path,
                    line: hit.line,
                    preview: hit.preview,
                });
                const key = evidenceKey({
                    workspace: normalizeWorkspace(hit.workspace),
                    path: hit.path,
                    startLine: hit.line,
                    endLine: hit.line,
                });
                if (input.evidenceState.seen.has(key)) {
                    continue;
                }
                input.evidenceState.seen.add(key);
                input.evidenceState.evidenceText = appendEvidenceText(
                    input.evidenceState.evidenceText,
                    block,
                    input.maxEvidenceChars
                );
            }
            return result;
        }

        if (result && typeof result === 'object') {
            const slice = result as {
                workspace?: string;
                path?: string;
                startLine?: number;
                endLine?: number;
                content?: string;
            };
            if (
                typeof slice.path === 'string' &&
                typeof slice.startLine === 'number' &&
                typeof slice.endLine === 'number' &&
                typeof slice.content === 'string'
            ) {
                const normalizedWorkspace = normalizeWorkspace(slice.workspace);
                const block = formatFileSliceEvidence({
                    workspace: normalizedWorkspace,
                    path: slice.path,
                    startLine: slice.startLine,
                    endLine: slice.endLine,
                    content: slice.content,
                });
                const key = evidenceKey({
                    workspace: normalizedWorkspace,
                    path: slice.path,
                    startLine: slice.startLine,
                    endLine: slice.endLine,
                });
                if (!input.evidenceState.seen.has(key)) {
                    input.evidenceState.seen.add(key);
                    input.evidenceState.evidenceText = appendEvidenceText(
                        input.evidenceState.evidenceText,
                        block,
                        input.maxEvidenceChars
                    );
                }
            }
        }

        if (!input.evidenceState.evidenceText) {
            return result;
        }

        return result;
    }
}
