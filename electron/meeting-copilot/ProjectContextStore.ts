import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
    ProjectContextBundle,
    ProjectContextConfig,
    ProjectContextFile,
    ProjectContextPack,
} from './types';

type LoggerLike = Pick<Console, 'warn'>;

type FileCandidate = {
    absolutePath: string;
    relativePath: string;
};

const ALLOWED_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', 'target']);
const EXCLUDED_BASENAMES = [
    /^\.env(?:\..+)?$/i,
    /\.pem$/i,
    /\.key$/i,
];

function toPosixPath(value: string): string {
    return value.split(path.sep).join('/');
}

function emptyBundle(): ProjectContextBundle {
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

function isExcludedFileName(name: string): boolean {
    return EXCLUDED_BASENAMES.some((pattern) => pattern.test(name));
}

function isSupportedContentFile(name: string): boolean {
    return ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function mergeWarnings(target: string[], source: string[]): void {
    for (const warning of source) {
        if (!target.includes(warning)) {
            target.push(warning);
        }
    }
}

function buildPromptText(files: ProjectContextFile[]): string {
    if (files.length === 0) {
        return '';
    }

    return `<project_docs_context>\n${files
        .map((file) => `[pack: ${file.packName} file: ${file.relativePath}]\n${file.text}`)
        .join('\n\n')}\n</project_docs_context>`;
}

export class ProjectContextStore {
    private readonly config: ProjectContextConfig;
    private readonly logger?: LoggerLike;
    private readonly workspaceNames?: Set<string>;

    constructor(config: ProjectContextConfig, options?: { logger?: LoggerLike; workspaceNames?: string[] }) {
        this.config = config;
        this.logger = options?.logger;
        this.workspaceNames = options?.workspaceNames ? new Set(options.workspaceNames) : undefined;
    }

    async loadDefaultBundle(): Promise<ProjectContextBundle> {
        if (!this.config.enabled) {
            return emptyBundle();
        }

        const packs = this.config.packs.filter((pack) => pack.enabled && pack.includeByDefault);
        return this.loadBundles(packs);
    }

    async loadPack(name: string): Promise<ProjectContextBundle> {
        if (!this.config.enabled) {
            return emptyBundle();
        }

        const pack = this.config.packs.find((candidate) => candidate.name === name && candidate.enabled);
        if (!pack) {
            const warning = `Project context pack "${name}" is not enabled or not configured`;
            this.warn(warning);
            return {
                ...emptyBundle(),
                warnings: [warning],
            };
        }

        return this.loadBundles([pack]);
    }

    private async loadBundles(packs: ProjectContextPack[]): Promise<ProjectContextBundle> {
        if (!this.config.enabled || packs.length === 0) {
            return emptyBundle();
        }

        const warnings: string[] = [];
        const files: ProjectContextFile[] = [];
        const packNames: string[] = [];
        let totalChars = 0;
        let truncated = false;

        for (const pack of packs) {
            if (
                pack.linkedWorkspaceName &&
                this.workspaceNames &&
                !this.workspaceNames.has(pack.linkedWorkspaceName)
            ) {
                const warning = `Project context pack "${pack.name}" references missing workspace "${pack.linkedWorkspaceName}"`;
                this.warn(warning);
                warnings.push(warning);
            }

            if (totalChars >= this.config.max_total_docs_chars) {
                truncated = true;
                const warning = `Project context truncated before pack "${pack.name}" because the global char limit was reached`;
                this.warn(warning);
                warnings.push(warning);
                break;
            }

            const packBundle = await this.loadPackFiles(pack, this.config.max_total_docs_chars - totalChars);
            mergeWarnings(warnings, packBundle.warnings);

            if (packBundle.files.length > 0) {
                packNames.push(pack.name);
                files.push(...packBundle.files);
                totalChars += packBundle.chars;
            }

            if (packBundle.truncated) {
                truncated = true;
            }
        }

        return {
            included: files.length > 0,
            packNames,
            files,
            text: buildPromptText(files),
            chars: totalChars,
            fileCount: files.length,
            warnings,
            truncated,
        };
    }

    private async loadPackFiles(
        pack: ProjectContextPack,
        remainingGlobalChars: number
    ): Promise<ProjectContextBundle> {
        const warnings: string[] = [];
        const collected = await this.collectFiles(pack);
        const packFiles = collected.candidates;
        mergeWarnings(warnings, collected.warnings);
        const maxPackChars = Math.min(
            this.config.max_docs_chars_per_pack,
            Number.isFinite(pack.maxDocsChars) ? Math.trunc(pack.maxDocsChars) : this.config.max_docs_chars_per_pack
        );
        const effectivePackLimit = Math.max(0, Math.min(maxPackChars, remainingGlobalChars));
        const files: ProjectContextFile[] = [];
        let chars = 0;
        let truncated = false;

        if (packFiles.length === 0) {
            const warning = `Project context pack "${pack.name}" did not contain any supported Markdown or text files`;
            this.warn(warning);
            warnings.push(warning);
            return {
                included: false,
                packNames: [],
                files: [],
                text: '',
                chars: 0,
                fileCount: 0,
                warnings,
                truncated: false,
            };
        }

        for (const candidate of packFiles) {
            if (chars >= effectivePackLimit) {
                truncated = true;
                const warning = `Project context pack "${pack.name}" was truncated at ${effectivePackLimit} chars`;
                this.warn(warning);
                warnings.push(warning);
                break;
            }

            let text: string;
            try {
                text = await readFile(candidate.absolutePath, 'utf8');
            } catch (error: unknown) {
                const warning = `Project context file "${candidate.relativePath}" in pack "${pack.name}" could not be read: ${this.describeError(error)}`;
                this.warn(warning);
                warnings.push(warning);
                continue;
            }

            const remaining = effectivePackLimit - chars;
            const boundedText = text.length > remaining ? text.slice(0, remaining) : text;
            const fileChars = boundedText.length;
            if (fileChars <= 0) {
                truncated = true;
                continue;
            }

            if (boundedText.length < text.length) {
                truncated = true;
                const warning = `Project context file "${candidate.relativePath}" in pack "${pack.name}" was truncated to ${fileChars} chars`;
                this.warn(warning);
                warnings.push(warning);
            }

            files.push({
                packName: pack.name,
                relativePath: candidate.relativePath,
                chars: fileChars,
                text: boundedText,
            });
            chars += fileChars;
        }

        if (!truncated && chars >= effectivePackLimit && packFiles.length > files.length) {
            truncated = true;
        }

        if (files.length === 0) {
            const warning = `Project context pack "${pack.name}" did not yield any readable content`;
            this.warn(warning);
            warnings.push(warning);
        }

        return {
            included: files.length > 0,
            packNames: files.length > 0 ? [pack.name] : [],
            files,
            text: buildPromptText(files),
            chars,
            fileCount: files.length,
            warnings,
            truncated,
        };
    }

    private async collectFiles(pack: ProjectContextPack): Promise<{
        candidates: FileCandidate[];
        warnings: string[];
    }> {
        const rootPath = path.resolve(pack.docsPath);
        const candidates: FileCandidate[] = [];
        const warnings: string[] = [];

        try {
            await this.walkDir(rootPath, rootPath, pack.name, candidates, warnings);
        } catch (error: unknown) {
            const warning = `Project context pack "${pack.name}" at "${toPosixPath(rootPath)}" could not be read: ${this.describeError(error)}`;
            this.warn(warning);
            warnings.push(warning);
            return { candidates: [], warnings };
        }

        return {
            candidates: candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
            warnings,
        };
    }

    private async walkDir(
        rootPath: string,
        currentPath: string,
        packName: string,
        candidates: FileCandidate[],
        warnings: string[]
    ): Promise<void> {
        let entries;
        try {
            entries = await readdir(currentPath, { withFileTypes: true });
        } catch (error: unknown) {
            throw error;
        }

        entries.sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
                    continue;
                }
                await this.walkDir(rootPath, path.join(currentPath, entry.name), packName, candidates, warnings);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            if (isExcludedFileName(entry.name)) {
                continue;
            }

            if (!isSupportedContentFile(entry.name)) {
                const relativePath = toPosixPath(path.relative(rootPath, path.join(currentPath, entry.name)));
                const warning = `Project context file "${relativePath}" in pack "${packName}" was skipped because only .md, .mdx, and .txt files are supported`;
                this.warn(warning);
                warnings.push(warning);
                continue;
            }

            candidates.push({
                absolutePath: path.join(currentPath, entry.name),
                relativePath: toPosixPath(path.relative(rootPath, path.join(currentPath, entry.name))),
            });
        }
    }

    private warn(message: string): void {
        this.logger?.warn?.(message);
    }

    private describeError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return String(error ?? 'unknown error');
    }
}
