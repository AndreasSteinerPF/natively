import path from 'node:path';

import type { WorkspaceConfig } from './types';

export type WorkspaceSummary = Pick<WorkspaceConfig, 'name' | 'path' | 'enabled'>;

type NormalizedWorkspace = WorkspaceConfig & {
    path: string;
};

function toPosixPath(value: string): string {
    return value.split(path.sep).join('/');
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeWorkspace(workspace: WorkspaceConfig): NormalizedWorkspace {
    return {
        ...workspace,
        path: path.resolve(workspace.path),
        max_snippets: Number.isFinite(workspace.max_snippets) ? Math.max(1, Math.trunc(workspace.max_snippets)) : 1,
        max_snippet_chars: Number.isFinite(workspace.max_snippet_chars)
            ? Math.max(1, Math.trunc(workspace.max_snippet_chars))
            : 1,
    };
}

export class CodeWorkspaceStore {
    private readonly workspaces: NormalizedWorkspace[];

    constructor(workspaces: WorkspaceConfig[]) {
        this.workspaces = workspaces.map((workspace) => normalizeWorkspace(workspace));
    }

    listWorkspaces(): WorkspaceSummary[] {
        return this.workspaces.map((workspace) => ({
            name: workspace.name,
            path: toPosixPath(workspace.path),
            enabled: workspace.enabled,
        }));
    }

    listEnabled(): WorkspaceConfig[] {
        return this.workspaces
            .filter((workspace) => workspace.enabled)
            .map((workspace) => ({
                ...workspace,
                path: toPosixPath(workspace.path),
            }));
    }

    getEnabledWorkspace(name?: string): WorkspaceConfig {
        const enabled = this.listEnabled();
        if (enabled.length === 0) {
            throw new Error('Meeting Copilot code tools require at least one enabled workspace');
        }

        if (name === undefined || name === '') {
            return enabled[0];
        }

        const match = enabled.find((workspace) => workspace.name === name);
        if (!match) {
            throw new Error(`Meeting Copilot workspace "${name}" is not enabled`);
        }

        return match;
    }

    resolveWorkspacePath(input: { workspace?: string; targetPath: string }): {
        workspace: WorkspaceConfig;
        absolutePath: string;
        relativePath: string;
    } {
        const enabled = this.listEnabled();
        if (enabled.length === 0) {
            throw new Error('Meeting Copilot code tools require at least one enabled workspace');
        }

        const targetPath = String(input.targetPath ?? '').trim();
        if (!targetPath) {
            throw new Error('Meeting Copilot code tools require a file path');
        }

        const absoluteTarget = path.resolve(targetPath);

        if (input.workspace !== undefined && input.workspace !== '') {
            const workspace = this.getEnabledWorkspace(input.workspace);
            const workspaceRoot = path.resolve(workspace.path);
            const resolvedTarget = path.isAbsolute(targetPath)
                ? path.resolve(targetPath)
                : path.resolve(workspaceRoot, targetPath);
            if (!isInsideOrEqual(workspaceRoot, resolvedTarget)) {
                throw new Error(`Meeting Copilot path "${targetPath}" is outside the enabled workspace "${workspace.name}"`);
            }
            return {
                workspace,
                absolutePath: resolvedTarget,
                relativePath: toPosixPath(path.relative(workspaceRoot, resolvedTarget)),
            };
        }

        if (!path.isAbsolute(targetPath)) {
            const workspace = enabled[0];
            const workspaceRoot = path.resolve(workspace.path);
            const absolutePath = path.resolve(workspaceRoot, targetPath);
            if (!isInsideOrEqual(workspaceRoot, absolutePath)) {
                throw new Error(`Meeting Copilot path "${targetPath}" is outside the enabled workspace "${workspace.name}"`);
            }
            return {
                workspace,
                absolutePath,
                relativePath: toPosixPath(path.relative(workspaceRoot, absolutePath)),
            };
        }

        for (const workspace of enabled) {
            const workspaceRoot = path.resolve(workspace.path);
            if (isInsideOrEqual(workspaceRoot, absoluteTarget)) {
                return {
                    workspace,
                    absolutePath: absoluteTarget,
                    relativePath: toPosixPath(path.relative(workspaceRoot, absoluteTarget)),
                };
            }
        }

        throw new Error(`Meeting Copilot path "${targetPath}" is outside the enabled workspace allowlist`);
    }
}
