import { redactForLog } from '../utils/redactForLog';

import { LlmCallMetrics } from './types';

interface MetricsStoreEntry {
    meeting_id?: string;
    action_id?: string;
    branch?: string;
    model?: string;
    context_mode?: string;
    cache_policy?: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_control_retry?: boolean;
    tool_rounds?: number;
    tool_calls?: number;
    time_to_first_token_ms?: number;
    total_latency_ms?: number;
    code_context_included?: boolean;
    project_context_included?: boolean;
    project_context_pack_names?: string[];
    project_context_chars?: number;
    project_context_file_count?: number;
    freshness_check_used?: boolean;
    freshness_sources?: string[];
    freshness_query_count?: number;
    freshness_result_count?: number;
    freshness_verified_at?: string;
    freshness_error?: string;
    success?: boolean;
    error?: string;
    error_type?: string;
    logged_at: string;
}

const MAX_ENTRIES = 500;

function sanitizeError(message: string | undefined): string {
    if (!message) {
        return '';
    }

    return redactForLog([message])
        .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED]')
        .slice(0, 256);
}

function sanitizeNames(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const names = value
        .map((entry) => String(entry ?? '').trim())
        .filter((entry) => entry.length > 0)
        .slice(0, 16);

    return names.length > 0 ? names : undefined;
}

export class MetricsStore {
    private entries: MetricsStoreEntry[] = [];

    record(metrics: LlmCallMetrics): void {
        const entry: MetricsStoreEntry = {
            meeting_id: typeof metrics.meeting_id === 'string' ? metrics.meeting_id : undefined,
            action_id: typeof metrics.action_id === 'string' ? metrics.action_id : undefined,
            branch: typeof metrics.branch === 'string' ? metrics.branch : undefined,
            model: typeof metrics.model === 'string' ? metrics.model : undefined,
            context_mode: typeof metrics.context_mode === 'string' ? metrics.context_mode : undefined,
            cache_policy: typeof metrics.cache_policy === 'string' ? metrics.cache_policy : undefined,
            prompt_tokens: typeof metrics.prompt_tokens === 'number' ? metrics.prompt_tokens : undefined,
            completion_tokens: typeof metrics.completion_tokens === 'number' ? metrics.completion_tokens : undefined,
            total_tokens: typeof metrics.total_tokens === 'number' ? metrics.total_tokens : undefined,
            cached_tokens: typeof metrics.cached_tokens === 'number' ? metrics.cached_tokens : undefined,
            cache_write_tokens: typeof metrics.cache_write_tokens === 'number' ? metrics.cache_write_tokens : undefined,
            cache_control_retry: typeof metrics.cache_control_retry === 'boolean' ? metrics.cache_control_retry : undefined,
            tool_rounds: typeof metrics.tool_rounds === 'number' ? metrics.tool_rounds : undefined,
            tool_calls: typeof metrics.tool_calls === 'number' ? metrics.tool_calls : undefined,
            time_to_first_token_ms: typeof metrics.time_to_first_token_ms === 'number' ? metrics.time_to_first_token_ms : undefined,
            total_latency_ms: typeof metrics.total_latency_ms === 'number' ? metrics.total_latency_ms : undefined,
            code_context_included: typeof metrics.code_context_included === 'boolean' ? metrics.code_context_included : undefined,
            project_context_included:
                typeof metrics.project_context_included === 'boolean'
                    ? metrics.project_context_included
                    : undefined,
            project_context_pack_names: sanitizeNames(metrics.project_context_pack_names),
            project_context_chars:
                typeof metrics.project_context_chars === 'number' ? metrics.project_context_chars : undefined,
            project_context_file_count:
                typeof metrics.project_context_file_count === 'number'
                    ? metrics.project_context_file_count
                    : undefined,
            freshness_check_used:
                typeof metrics.freshness_check_used === 'boolean'
                    ? metrics.freshness_check_used
                    : undefined,
            freshness_sources: sanitizeNames(metrics.freshness_sources),
            freshness_query_count:
                typeof metrics.freshness_query_count === 'number'
                    ? metrics.freshness_query_count
                    : undefined,
            freshness_result_count:
                typeof metrics.freshness_result_count === 'number'
                    ? metrics.freshness_result_count
                    : undefined,
            freshness_verified_at:
                typeof metrics.freshness_verified_at === 'string'
                    ? metrics.freshness_verified_at.slice(0, 64)
                    : undefined,
            freshness_error:
                typeof metrics.freshness_error === 'string'
                    ? sanitizeError(metrics.freshness_error)
                    : undefined,
            success: typeof metrics.success === 'boolean' ? metrics.success : undefined,
            error: sanitizeError(metrics.error),
            error_type: typeof metrics.error_type === 'string' ? metrics.error_type.slice(0, 128) : undefined,
            logged_at: new Date().toISOString(),
        };

        this.entries.push(entry);

        if (this.entries.length > MAX_ENTRIES) {
            this.entries = this.entries.slice(-Math.floor(MAX_ENTRIES * 0.8));
        }
    }

    last(count = 10): ReadonlyArray<MetricsStoreEntry> {
        return this.entries.slice(-Math.max(0, count));
    }

    clear(): void {
        this.entries = [];
    }

    serialize(): string {
        try {
            return JSON.stringify(this.entries);
        } catch {
            return '[]';
        }
    }
}
