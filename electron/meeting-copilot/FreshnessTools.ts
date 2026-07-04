import { redactForLog } from '../utils/redactForLog';

import { ModelInfo, OpenRouterConfig } from './types';

export interface FreshnessToolsOptions {
    config: OpenRouterConfig;
    apiKeyResolver?: () => string | Promise<string | undefined> | undefined;
    fetch?: typeof fetch;
    now?: () => Date;
}

type OpenRouterCatalogModel = Record<string, unknown>;

const DEFAULT_API_KEY_ENV = 'OPENROUTER_API_KEY';
const MAX_ERROR_CHARS = 256;
const MAX_MODELS = 200;

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

function sanitizeText(value: string): string {
    return redactForLog([value])
        .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED]')
        .trim()
        .slice(0, MAX_ERROR_CHARS);
}

function toString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 256) : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const values = value
        .map((entry) => toString(entry))
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 32);

    return values.length > 0 ? values : undefined;
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 32));
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

function normalizeCatalogModels(parsed: unknown): OpenRouterCatalogModel[] {
    if (!parsed || typeof parsed !== 'object') {
        return [];
    }

    const record = parsed as Record<string, unknown>;
    const data = Array.isArray(record.data) ? record.data : Array.isArray(parsed) ? parsed : [];
    return data
        .filter((entry): entry is OpenRouterCatalogModel => !!entry && typeof entry === 'object')
        .slice(0, MAX_MODELS);
}

function normalizeModel(model: OpenRouterCatalogModel, checkedAt: string): ModelInfo | undefined {
    const id = toString(model.id);
    if (!id) {
        return undefined;
    }

    return {
        id,
        name: toString(model.name),
        context_length: toFiniteNumber(model.context_length),
        pricing: toPlainRecord(model.pricing),
        supported_parameters: toStringArray(model.supported_parameters),
        source: 'openrouter',
        checked_at: checkedAt,
    };
}

export class FreshnessTools {
    private readonly baseUrl: string;
    private readonly defaultHeaders: Record<string, string>;
    private readonly apiKeyEnv: string;
    private readonly apiKeyResolver?: () => string | Promise<string | undefined> | undefined;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => Date;

    constructor(options: FreshnessToolsOptions) {
        this.baseUrl = trimTrailingSlash(options.config.base_url);
        this.defaultHeaders = { ...(options.config.default_headers ?? {}) };
        this.apiKeyEnv = options.config.api_key_env || DEFAULT_API_KEY_ENV;
        this.apiKeyResolver = options.apiKeyResolver;
        this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.now = options.now ?? (() => new Date());
    }

    async getOpenRouterModel(modelId: string, signal?: AbortSignal): Promise<ModelInfo> {
        const normalizedModelId = toString(modelId);
        if (!normalizedModelId) {
            throw new Error('OpenRouter model catalog lookup requires a model id');
        }

        const models = await this.listOpenRouterModels(undefined, signal);
        const model = models.find((entry) => entry.id === normalizedModelId);
        if (!model) {
            throw new Error(`OpenRouter model catalog did not include ${sanitizeText(normalizedModelId)}`);
        }

        return model;
    }

    async listOpenRouterModels(
        filter?: { query?: string },
        signal?: AbortSignal
    ): Promise<ModelInfo[]> {
        const checkedAt = this.now().toISOString();
        const response = await this.fetchCatalog(signal);
        const parsed = await this.readJson(response);
        if (!response.ok) {
            throw this.makeHttpError(response.status, extractResponseMessage(parsed));
        }

        let models = normalizeCatalogModels(parsed)
            .map((entry) => normalizeModel(entry, checkedAt))
            .filter((entry): entry is ModelInfo => entry !== undefined);

        const query = filter?.query?.trim().toLowerCase();
        if (query) {
            models = models.filter(
                (model) =>
                    model.id.toLowerCase().includes(query) ||
                    (model.name?.toLowerCase().includes(query) ?? false)
            );
        }

        return models;
    }

    private async fetchCatalog(signal?: AbortSignal): Promise<Response> {
        const apiKey = await this.resolveApiKey();
        const url = `${this.baseUrl}/models`;
        try {
            return await this.fetchImpl(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    ...this.defaultHeaders,
                },
                signal,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`OpenRouter model catalog request failed: ${sanitizeText(message)}`);
        }
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

    private makeHttpError(status: number, message: string): Error {
        return new Error(
            `OpenRouter model catalog request failed (${status}): ${sanitizeText(
                message || `HTTP ${status}`
            )}`
        );
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
}
