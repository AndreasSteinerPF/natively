import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PINNED_CONTEXT_TEMPLATE = [
    'Current problem:',
    '',
    'Goal:',
    '',
    'Important constraints:',
    '',
    'Known decisions:',
    '',
    'Open questions:',
].join('\n');

export const PINNED_CONTEXT_MAX_CHARS = 12_000;

type StoredPinnedContext = {
    value: string;
};

export interface PinnedContextStoreOptions {
    configDir: string;
    fileName?: string;
    maxChars?: number;
}

function boundPinnedContextValue(value: unknown, maxChars: number): string {
    return String(value ?? '').slice(0, maxChars);
}

export class PinnedContextStore {
    private readonly configDir: string;
    private readonly fileName: string;
    private readonly maxChars: number;

    constructor(options: PinnedContextStoreOptions) {
        this.configDir = options.configDir;
        this.fileName = options.fileName ?? 'pinned-context.json';
        this.maxChars = options.maxChars ?? PINNED_CONTEXT_MAX_CHARS;
    }

    async load(): Promise<string> {
        try {
            const raw = await readFile(this.filePath(), 'utf8');
            const parsed = JSON.parse(raw) as StoredPinnedContext;
            if (!parsed || typeof parsed.value !== 'string') {
                return DEFAULT_PINNED_CONTEXT_TEMPLATE;
            }
            return boundPinnedContextValue(parsed.value, this.maxChars);
        } catch (error: unknown) {
            if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                (error as { code?: unknown }).code === 'ENOENT'
            ) {
                return DEFAULT_PINNED_CONTEXT_TEMPLATE;
            }
            return DEFAULT_PINNED_CONTEXT_TEMPLATE;
        }
    }

    async save(value: string): Promise<string> {
        const bounded = boundPinnedContextValue(value, this.maxChars);
        await mkdir(this.configDir, { recursive: true });
        await writeFile(
            this.filePath(),
            JSON.stringify({ value: bounded }, null, 2),
            'utf8'
        );
        return bounded;
    }

    async reset(): Promise<string> {
        return this.save(DEFAULT_PINNED_CONTEXT_TEMPLATE);
    }

    private filePath(): string {
        return path.join(this.configDir, this.fileName);
    }
}
