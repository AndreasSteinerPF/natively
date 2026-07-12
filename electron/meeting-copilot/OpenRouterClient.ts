import { redactForLog } from '../utils/redactForLog';

import {
    LlmCallMetrics,
    OpenRouterChatCompletionRequest,
    OpenRouterChatCompletionResult,
    OpenRouterConfig,
    OpenRouterMessage,
    OpenRouterStreamEvent,
    OpenRouterUsage,
} from './types';
import {
    cacheControlForPolicy,
    shouldRetryWithoutCacheControl,
    stripCacheControlFromMessages,
} from './PromptCache';

export interface OpenRouterClientOptions {
    config: OpenRouterConfig;
    apiKeyResolver?: () => string | Promise<string | undefined> | undefined;
    fetch?: typeof fetch;
    now?: () => number;
}

type RetryDecision = {
    retry: boolean;
    message: string;
};

type ProviderPayload = {
    model: string;
    messages: OpenRouterMessage[];
    max_tokens?: number;
    temperature: number;
    stream: boolean;
    tools?: unknown[];
    tool_choice?: 'auto' | 'none' | Record<string, unknown>;
    plugins?: unknown[];
    reasoning?: OpenRouterChatCompletionRequest['reasoning'];
    session_id?: string;
    cache_control?: OpenRouterChatCompletionRequest['cache_control'];
};

const DEFAULT_API_KEY_ENV = 'OPENROUTER_API_KEY';

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

function toFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeText(value: string): string {
    return redactForLog([value]).trim();
}

function normalizeMessageText(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        return value
            .map((block) => {
                if (block && typeof block === 'object' && 'text' in block && typeof (block as { text?: unknown }).text === 'string') {
                    return (block as { text: string }).text;
                }
                return '';
            })
            .filter(Boolean)
            .join('');
    }

    return '';
}

function normalizeUsage(usage: unknown): OpenRouterUsage | undefined {
    if (!usage || typeof usage !== 'object') {
        return undefined;
    }

    const record = usage as Record<string, unknown>;
    const details =
        record.prompt_tokens_details && typeof record.prompt_tokens_details === 'object'
            ? (record.prompt_tokens_details as Record<string, unknown>)
            : undefined;

    return {
        prompt_tokens: toFiniteNumber(record.prompt_tokens),
        completion_tokens: toFiniteNumber(record.completion_tokens),
        total_tokens: toFiniteNumber(record.total_tokens),
        prompt_tokens_details: details
            ? {
                  cached_tokens: toFiniteNumber(details.cached_tokens),
                  cache_write_tokens: toFiniteNumber(details.cache_write_tokens),
              }
            : undefined,
    };
}

function extractResponseMessage(parsed: unknown): string {
    if (!parsed || typeof parsed !== 'object') {
        return '';
    }

    const record = parsed as Record<string, unknown>;
    const error = record.error;
    if (typeof error === 'string') {
        return error;
    }
    if (error && typeof error === 'object') {
        const errorRecord = error as Record<string, unknown>;
        if (typeof errorRecord.message === 'string') {
            return errorRecord.message;
        }
    }
    if (typeof record.message === 'string') {
        return record.message;
    }
    if (typeof record.detail === 'string') {
        return record.detail;
    }

    return '';
}

function extractChoice(parsed: unknown): Record<string, unknown> | undefined {
    if (!parsed || typeof parsed !== 'object') {
        return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const choices = Array.isArray(record.choices) ? record.choices : undefined;
    const firstChoice = choices?.[0];
    if (!firstChoice || typeof firstChoice !== 'object') {
        return undefined;
    }

    return firstChoice as Record<string, unknown>;
}

function extractStreamToken(parsed: unknown): string {
    const choice = extractChoice(parsed);
    if (!choice) {
        return '';
    }

    const delta = choice.delta;
    if (!delta || typeof delta !== 'object') {
        return '';
    }

    const record = delta as Record<string, unknown>;
    return normalizeMessageText(record.content);
}

function parseSseData(data: string): unknown {
    try {
        return JSON.parse(data);
    } catch {
        return undefined;
    }
}

function toRetryDecision(status: number, message: string): RetryDecision {
    return {
        retry: shouldRetryWithoutCacheControl({ status, message }),
        message,
    };
}

function hasCacheControl(body: ProviderPayload): boolean {
    if (body.cache_control !== undefined) {
        return true;
    }

    return body.messages.some((message) => {
        if (!Array.isArray(message.content)) {
            return false;
        }

        return message.content.some((block) => block.type === 'text' && block.cache_control !== undefined);
    });
}

export class OpenRouterClient {
    private readonly baseUrl: string;
    private readonly defaultHeaders: Record<string, string>;
    private readonly apiKeyEnv: string;
    private readonly config: OpenRouterConfig;
    private readonly apiKeyResolver?: () => string | Promise<string | undefined> | undefined;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;

    constructor(options: OpenRouterClientOptions) {
        this.config = options.config;
        this.baseUrl = trimTrailingSlash(this.config.base_url);
        this.defaultHeaders = { ...(this.config.default_headers ?? {}) };
        this.apiKeyEnv = this.config.api_key_env || DEFAULT_API_KEY_ENV;
        this.apiKeyResolver = options.apiKeyResolver;
        this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.now = options.now ?? (() => (globalThis.performance?.now?.() ?? Date.now()));
    }

    async createChatCompletion(request: OpenRouterChatCompletionRequest): Promise<OpenRouterChatCompletionResult> {
        const startedAt = this.now();
        const { response, retryUsed } = await this.sendWithRetry(request);
        const raw = await this.readJson(response);
        const endedAt = this.now();
        return this.buildResult(raw, request, startedAt, endedAt, retryUsed);
    }

    async *streamChatCompletion(
        request: OpenRouterChatCompletionRequest
    ): AsyncGenerator<OpenRouterStreamEvent, OpenRouterChatCompletionResult, void> {
        const startedAt = this.now();
        const { response, retryUsed } = await this.sendWithRetry(request);
        if (!response.body) {
            throw this.makeError('OpenRouter stream response did not include a body', { request });
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';
        let usage: OpenRouterChatCompletionResult['usage'];
        let firstTokenAt: number | undefined;
        let finishReason: string | undefined;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (value) {
                    buffer += decoder.decode(value, { stream: true });
                }

                while (true) {
                    const delimiterIndex = buffer.indexOf('\n\n');
                    if (delimiterIndex === -1) {
                        break;
                    }

                    const eventText = buffer.slice(0, delimiterIndex);
                    buffer = buffer.slice(delimiterIndex + 2);
                    const data = this.extractSseData(eventText);
                    if (!data) {
                        continue;
                    }
                    if (data === '[DONE]') {
                        const endedAt = this.now();
                        const result = this.buildResult(
                            {
                                choices: [{ message: { content }, finish_reason: finishReason }],
                                usage,
                            },
                            request,
                            startedAt,
                            endedAt,
                            retryUsed,
                            firstTokenAt
                        );
                        yield { type: 'done', result };
                        return result;
                    }

                    const parsed = parseSseData(data);
                    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
                        throw this.makeError(extractResponseMessage(parsed), { request });
                    }

                    const token = extractStreamToken(parsed);
                    if (token) {
                        if (firstTokenAt === undefined) {
                            firstTokenAt = this.now();
                        }
                        content += token;
                        yield { type: 'token', token };
                    }

                    const chunkFinishReason = extractChoice(parsed)?.finish_reason;
                    if (typeof chunkFinishReason === 'string' && chunkFinishReason) {
                        finishReason = chunkFinishReason;
                    }

                    const parsedUsage = normalizeUsage((parsed as Record<string, unknown> | undefined)?.usage);
                    if (parsedUsage) {
                        usage = parsedUsage;
                    }
                }

                if (done) {
                    break;
                }
            }
        } finally {
            reader.releaseLock();
        }

        const endedAt = this.now();
        const result = this.buildResult(
            {
                choices: [{ message: { content }, finish_reason: finishReason }],
                usage,
            },
            request,
            startedAt,
            endedAt,
            retryUsed,
            firstTokenAt
        );
        yield { type: 'done', result };
        return result;
    }

    private extractSseData(eventText: string): string | undefined {
        const dataLines = eventText
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart());

        if (dataLines.length === 0) {
            return undefined;
        }

        return dataLines.join('\n');
    }

    private async sendWithRetry(
        request: OpenRouterChatCompletionRequest
    ): Promise<{ response: Response; retryUsed: boolean }> {
        const body = this.buildBody(request);
        const attempt = await this.post(body, request.signal);
        if (attempt.response.ok) {
            return { response: attempt.response, retryUsed: false };
        }

        const retryDecision = await this.readRetryDecision(attempt.response);
        if (!retryDecision.retry || !hasCacheControl(body)) {
            throw await this.makeHttpError(attempt.response.status, retryDecision.message, request);
        }

        const retryBody = {
            ...body,
            messages: stripCacheControlFromMessages(body.messages),
            cache_control: undefined,
        };
        const retryAttempt = await this.post(retryBody, request.signal);
        if (retryAttempt.response.ok) {
            return { response: retryAttempt.response, retryUsed: true };
        }

        const retryError = await this.readRetryDecision(retryAttempt.response);
        throw await this.makeHttpError(retryAttempt.response.status, retryError.message, request, true);
    }

    private async post(body: ProviderPayload, signal?: AbortSignal): Promise<{ response: Response }> {
        const apiKey = await this.resolveApiKey();
        const url = `${this.baseUrl}/chat/completions`;
        try {
            const response = await this.fetchImpl(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    ...this.defaultHeaders,
                },
                body: JSON.stringify(body),
                signal,
            });

            return { response };
        } catch (error) {
            throw this.normalizeFetchError(error, body.model);
        }
    }

    private buildBody(request: OpenRouterChatCompletionRequest): ProviderPayload {
        return {
            model: request.model,
            messages: request.messages,
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            stream: request.stream,
            tools: request.tools,
            tool_choice: request.tool_choice,
            plugins: request.plugins,
            reasoning: request.reasoning,
            session_id: request.session_id,
            cache_control: request.cache_policy ? cacheControlForPolicy(request.cache_policy) : undefined,
        };
    }

    private async readJson(response: Response): Promise<unknown> {
        const text = await response.text();
        if (!text) {
            return {};
        }

        try {
            return JSON.parse(text);
        } catch {
            return { raw: text };
        }
    }

    private async readRetryDecision(response: Response): Promise<RetryDecision> {
        const body = await this.readJson(response);
        const message = extractResponseMessage(body) || (body && typeof body === 'object' && 'raw' in body ? String((body as { raw: unknown }).raw) : '');
        return toRetryDecision(response.status, message);
    }

    private async makeHttpError(
        status: number,
        message: string,
        request: OpenRouterChatCompletionRequest,
        retryUsed = false
    ): Promise<Error> {
        const sanitizedMessage = sanitizeText(message || `HTTP ${status}`);
        const error = new Error(`OpenRouter request failed (${status}): ${sanitizedMessage}`);
        (error as Error & { status?: number; retryUsed?: boolean; model?: string }).status = status;
        (error as Error & { status?: number; retryUsed?: boolean; model?: string }).retryUsed = retryUsed;
        (error as Error & { status?: number; retryUsed?: boolean; model?: string }).model = request.model;
        return error;
    }

    private makeError(message: string, input: { request: OpenRouterChatCompletionRequest }): Error {
        const sanitizedMessage = sanitizeText(message || 'OpenRouter request failed');
        const error = new Error(`OpenRouter request failed: ${sanitizedMessage}`);
        (error as Error & { model?: string }).model = input.request.model;
        return error;
    }

    private normalizeFetchError(error: unknown, model: string): Error {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const sanitizedMessage = sanitizeText(rawMessage || 'OpenRouter request failed');
        const normalized = new Error(`OpenRouter request failed: ${sanitizedMessage}`);
        (normalized as Error & { model?: string }).model = model;
        return normalized;
    }

    private async resolveApiKey(): Promise<string> {
        const resolved =
            (this.apiKeyResolver ? await this.apiKeyResolver() : undefined) ??
            process.env[this.apiKeyEnv] ??
            process.env[DEFAULT_API_KEY_ENV];
        if (!resolved || resolved.trim() === '') {
            throw new Error(`Missing OpenRouter API key: set ${this.apiKeyEnv}`);
        }
        return resolved;
    }

    private buildResult(
        raw: unknown,
        request: OpenRouterChatCompletionRequest,
        startedAt: number,
        endedAt: number,
        retryUsed: boolean,
        firstTokenAt?: number
    ): OpenRouterChatCompletionResult {
        const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        const choice = extractChoice(parsed);
        const message = choice?.message && typeof choice.message === 'object' ? (choice.message as Record<string, unknown>) : undefined;
        const content = normalizeMessageText(message?.content);
        const toolCalls = Array.isArray(message?.tool_calls) ? message?.tool_calls : undefined;
        const usage = normalizeUsage(parsed.usage);

        const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
        const metrics = this.buildMetrics(usage, request, startedAt, endedAt, firstTokenAt, retryUsed);
        const warnings = retryUsed ? ['cache_control_disabled_after_provider_rejection'] : [];

        return {
            content,
            raw,
            warnings,
            metrics,
            tool_calls: toolCalls,
            usage,
            finish_reason: finishReason,
        };
    }

    private buildMetrics(
        usage: OpenRouterUsage | undefined,
        request: OpenRouterChatCompletionRequest,
        startedAt: number,
        endedAt: number,
        firstTokenAt: number | undefined,
        retryUsed: boolean
    ): LlmCallMetrics {
        return {
            model: request.model,
            cache_policy: request.cache_policy,
            prompt_tokens: usage?.prompt_tokens,
            completion_tokens: usage?.completion_tokens,
            total_tokens: usage?.total_tokens,
            cached_tokens: usage?.prompt_tokens_details?.cached_tokens,
            cache_write_tokens: usage?.prompt_tokens_details?.cache_write_tokens,
            cache_control_retry: retryUsed,
            time_to_first_token_ms: firstTokenAt === undefined ? undefined : Math.max(0, firstTokenAt - startedAt),
            total_latency_ms: Math.max(0, endedAt - startedAt),
            success: true,
        };
    }
}
