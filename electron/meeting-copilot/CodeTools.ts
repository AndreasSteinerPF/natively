import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile as nodeReadFile } from 'node:fs/promises';

import { redactForLog } from '../utils/redactForLog';

import type { CodeContextConfig, FileSlice, SearchHit } from './types';
import { CodeWorkspaceStore, type WorkspaceSummary } from './CodeWorkspaceStore';

export const RIPGREP_REQUIRED_MESSAGE =
    'ripgrep (`rg`) is required for code search. Install it with Homebrew or make sure it is available on PATH.';

export const DEFAULT_EXCLUDED_GLOBS = [
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
    'id_rsa',
    'id_ed25519',
    'node_modules/',
    '.git/',
    'dist/',
    'build/',
    'target/',
];

export const MAX_QUERY_CHARS = 240;
export const MAX_RESULTS = 24;
export const MAX_READ_LINES = 240;

const MAX_CAPTURE_CHARS = 32_000;
const MAX_PATH_CHARS = 4_096;
const MAX_WORKSPACE_CHARS = 256;

export type SpawnLike = (
    command: string,
    args: string[],
    options: { cwd: string; shell: false }
) => ChildProcessWithoutNullStreams;

type ReadFileLike = (path: string, encoding: 'utf8') => Promise<string>;

function toPosixPath(value: string): string {
    return value.split('\\').join('/');
}

function normalizeBoundedString(value: unknown, maxChars: number): string {
    return String(value ?? '').slice(0, maxChars);
}

function clampPositiveInteger(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    const truncated = Math.trunc(parsed);
    return truncated > 0 ? truncated : fallback;
}

function positiveOrUndefined(value: unknown): number | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }
    const truncated = Math.trunc(parsed);
    return truncated > 0 ? truncated : undefined;
}

function getLineBounds(totalLines: number, input: { startLine?: number; endLine?: number }): {
    startLine: number;
    endLine: number;
} {
    const safeStart = positiveOrUndefined(input.startLine) ?? 1;
    const defaultEnd = safeStart + MAX_READ_LINES - 1;
    const safeEnd = positiveOrUndefined(input.endLine) ?? defaultEnd;
    const startLine = Math.min(Math.max(1, safeStart), Math.max(1, totalLines));
    const maxWindowEnd = startLine + MAX_READ_LINES - 1;
    const endLine = Math.max(
        startLine,
        Math.min(Math.max(startLine, safeEnd), Math.max(startLine, totalLines), maxWindowEnd)
    );
    return { startLine, endLine };
}

function isExcludedRelativePath(relativePath: string): boolean {
    const normalized = toPosixPath(relativePath).replace(/^\.\/+/, '');
    const segments = normalized.split('/').filter(Boolean);
    const basename = segments.at(-1) ?? normalized;

    if (basename === '.env' || basename === 'id_rsa' || basename === 'id_ed25519') {
        return true;
    }
    if (basename.startsWith('.env.')) {
        return true;
    }
    if (basename.endsWith('.pem') || basename.endsWith('.key')) {
        return true;
    }
    return segments.some((segment) =>
        segment === 'node_modules' ||
        segment === '.git' ||
        segment === 'dist' ||
        segment === 'build' ||
        segment === 'target'
    );
}

function redactPrivateKeyBlocks(value: string): string {
    return value
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY BLOCK]')
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY BLOCK]')
        .replace(/-----END [^-]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY BLOCK]');
}

function redactSensitiveCodeText(value: string): string {
    let redacted = redactForLog([value]);
    redacted = redactPrivateKeyBlocks(redacted);
    redacted = redacted
        .replace(/(Authorization:\s*Bearer\s+)[^\s'"]+/gi, '$1[REDACTED]')
        .replace(/(\b(?:OPENROUTER_API_KEY|api[_-]?key)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s'"]+)/gi, '$1[REDACTED]')
        .replace(/(\bpassword\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s'"]+)/gi, '$1[REDACTED]')
        .replace(/(\btoken\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s'"]+)/gi, '$1[REDACTED]');
    return redacted;
}

function truncateToChars(value: string, maxChars: number): string {
    if (maxChars <= 0) {
        return '';
    }
    return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function parseRgLine(line: string): SearchHit | null {
    const first = line.indexOf(':');
    if (first < 0) {
        return null;
    }
    const second = line.indexOf(':', first + 1);
    if (second < 0) {
        return null;
    }
    const third = line.indexOf(':', second + 1);
    if (third < 0) {
        return null;
    }

    const path = toPosixPath(line.slice(0, first));
    const lineNumber = Number(line.slice(first + 1, second));
    const preview = line.slice(third + 1);
    if (!Number.isFinite(lineNumber) || lineNumber <= 0) {
        return null;
    }
    return {
        path,
        line: Math.trunc(lineNumber),
        preview,
    };
}

function isMissingRgrepError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = Reflect.get(error, 'code');
    return code === 'ENOENT';
}

function collectProcessOutput(child: ChildProcessWithoutNullStreams): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';

        const append = (current: string, chunk: unknown): string => {
            const next = current + String(chunk ?? '');
            return next.length > MAX_CAPTURE_CHARS ? next.slice(0, MAX_CAPTURE_CHARS) : next;
        };

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout = append(stdout, chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr = append(stderr, chunk);
        });
        child.once('error', (error) => {
            reject(error);
        });
        child.once('close', (code) => {
            resolve({ stdout, stderr, code });
        });
    });
}

function readTextLines(text: string): string[] {
    return text.split(/\r?\n/);
}

function boundPreview(value: string, maxChars: number): string {
    return truncateToChars(redactSensitiveCodeText(value), maxChars);
}

export class CodeTools {
    private readonly workspaceStore: CodeWorkspaceStore;
    private readonly codeContext: CodeContextConfig;
    private readonly spawn: SpawnLike;
    private readonly readFile: ReadFileLike;

    constructor(options: {
        workspaceStore: CodeWorkspaceStore;
        codeContext: CodeContextConfig;
        spawn?: SpawnLike;
        readFile?: ReadFileLike;
    }) {
        this.workspaceStore = options.workspaceStore;
        this.codeContext = options.codeContext;
        this.spawn = options.spawn ?? nodeSpawn;
        this.readFile = options.readFile ?? nodeReadFile;
    }

    async listWorkspaces(): Promise<WorkspaceSummary[]> {
        return this.workspaceStore.listWorkspaces();
    }

    async searchRepo(input: { query: string; workspace?: string }): Promise<SearchHit[]> {
        this.ensureEnabled();

        const trimmedQuery = String(input.query ?? '').trim();
        if (!trimmedQuery || trimmedQuery.length > MAX_QUERY_CHARS) {
            throw new Error(`Meeting Copilot code search query must be between 1 and ${MAX_QUERY_CHARS} characters`);
        }
        const query = trimmedQuery;

        const workspace = this.workspaceStore.getEnabledWorkspace(
            input.workspace === undefined ? undefined : normalizeBoundedString(input.workspace, MAX_WORKSPACE_CHARS)
        );
        const maxSnippets = clampPositiveInteger(workspace.max_snippets, MAX_RESULTS);
        const maxSnippetChars = clampPositiveInteger(workspace.max_snippet_chars, 1);
        const args = [
            '--line-number',
            '--column',
            '--no-heading',
            '--color',
            'never',
            '--max-count',
            String(Math.min(maxSnippets, MAX_RESULTS)),
            ...DEFAULT_EXCLUDED_GLOBS.flatMap((glob) => ['--glob', `!${glob}`]),
            query,
            '.',
        ];

        let child: ChildProcessWithoutNullStreams;
        try {
            child = this.spawn('rg', args, { cwd: workspace.path, shell: false });
        } catch (error) {
            if (isMissingRgrepError(error)) {
                throw new Error(RIPGREP_REQUIRED_MESSAGE);
            }
            throw error;
        }

        let result;
        try {
            result = await collectProcessOutput(child);
        } catch (error) {
            if (isMissingRgrepError(error)) {
                throw new Error(RIPGREP_REQUIRED_MESSAGE);
            }
            throw error;
        }

        if (result.code !== 0 && result.code !== 1) {
            const stderr = boundPreview(result.stderr || result.stdout, 1_024);
            throw new Error(stderr ? `Meeting Copilot code search failed: ${stderr}` : 'Meeting Copilot code search failed');
        }

        const lines = readTextLines(result.stdout);
        const hits: SearchHit[] = [];
        let remainingChars = this.remainingContentBudget();

        for (const line of lines) {
            if (hits.length >= maxSnippets) {
                break;
            }
            if (!line.trim()) {
                continue;
            }
            const parsed = parseRgLine(line);
            if (!parsed) {
                continue;
            }
            const previewBudget = Math.max(1, Math.min(maxSnippetChars, remainingChars));
            const preview = boundPreview(parsed.preview, previewBudget);
            remainingChars = Math.max(0, remainingChars - preview.length);
            hits.push({
                workspace: workspace.name,
                path: parsed.path,
                line: parsed.line,
                preview,
            });
        }

        return hits;
    }

    async readFileSlice(input: {
        path: string;
        workspace?: string;
        startLine?: number;
        endLine?: number;
    }): Promise<FileSlice> {
        this.ensureEnabled();

        const targetPath = normalizeBoundedString(input.path, MAX_PATH_CHARS);
        const workspace = input.workspace === undefined
            ? undefined
            : normalizeBoundedString(input.workspace, MAX_WORKSPACE_CHARS);
        const resolved = this.workspaceStore.resolveWorkspacePath({
            workspace,
            targetPath,
        });

        if (isExcludedRelativePath(resolved.relativePath)) {
            throw new Error(`Meeting Copilot path "${resolved.relativePath}" is excluded from code tools`);
        }

        const content = await this.readFile(resolved.absolutePath, 'utf8');
        const lines = readTextLines(content);
        const bounds = getLineBounds(lines.length, input);
        const slice = lines.slice(bounds.startLine - 1, bounds.endLine).join('\n');
        const maxSnippetChars = clampPositiveInteger(resolved.workspace.max_snippet_chars, 1);
        const maxTotalChars = clampPositiveInteger(this.codeContext.max_total_chars, 1);
        const maxChars = Math.max(1, Math.min(maxSnippetChars, maxTotalChars));

        return {
            workspace: resolved.workspace.name,
            path: resolved.relativePath,
            startLine: bounds.startLine,
            endLine: bounds.endLine,
            content: truncateToChars(redactSensitiveCodeText(slice), maxChars),
        };
    }

    private ensureEnabled(): void {
        if (this.codeContext.enabled === false) {
            throw new Error('Meeting Copilot code tools are disabled in this slice');
        }
    }

    private remainingContentBudget(): number {
        const maxTotalChars = clampPositiveInteger(this.codeContext.max_total_chars, 1);
        return maxTotalChars > 0 ? maxTotalChars : MAX_CAPTURE_CHARS;
    }
}
