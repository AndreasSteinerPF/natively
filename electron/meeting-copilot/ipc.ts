import { redactForLog } from '../utils/redactForLog';

import { MeetingCopilotEvent, MeetingCopilotInvoke } from './types';

export const MEETING_COPILOT_INVOKE_CHANNEL = 'meeting-copilot:invoke';
export const MEETING_COPILOT_EVENT_CHANNEL = 'meeting-copilot:event';
export const MEETING_COPILOT_MAX_EVENT_CHARS = 16_000;
export const MEETING_COPILOT_MAX_PINNED_CONTEXT_CHARS = 12_000;

type IpcMainLike = {
    removeHandler: (channel: string) => void;
    handle: (channel: string, listener: (event: unknown, payload: MeetingCopilotInvoke) => unknown) => void;
};

type WebContentsLike = {
    send: (channel: string, payload: MeetingCopilotEvent) => void;
};

type ActionRunManagerLike = {
    start: (payload: { actionId: string }) => Promise<unknown>;
    cancel: (payload: { runId: string; branch?: 'fast' | 'deep' | 'all' }) => Promise<unknown>;
};

type PinnedContextStoreLike = {
    load: () => Promise<string>;
    save: (value: string) => Promise<string>;
    reset: () => Promise<string>;
};

type CodeToolsLike = {
    listWorkspaces: () => Promise<unknown>;
    searchRepo: (input: { query: string; workspace?: string }) => Promise<unknown>;
    readFileSlice: (input: { path: string; workspace?: string; startLine?: number; endLine?: number }) => Promise<unknown>;
};

export interface RegisterMeetingCopilotIpcOptions {
    ipcMain: IpcMainLike;
    actionRunManager: ActionRunManagerLike;
    pinnedContextStore: PinnedContextStoreLike;
    webContents: WebContentsLike;
    codeTools?: CodeToolsLike;
}

function boundString(value: unknown): string {
    return String(value ?? '').slice(0, MEETING_COPILOT_MAX_EVENT_CHARS);
}

function sanitizeString(value: unknown): string {
    return boundString(redactForLog([String(value ?? '')]).trim());
}

function boundWarnings(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    return value
        .map((warning) => sanitizeString(warning))
        .filter((warning) => warning.length > 0)
        .slice(0, 8);
}

function sanitizeInvokeType(value: unknown): string {
    return sanitizeString(value);
}

function sanitizeInvokeId(value: unknown): string {
    return boundString(String(value ?? ''));
}

function boundPinnedContextValue(value: unknown): string {
    return String(value ?? '').slice(0, MEETING_COPILOT_MAX_PINNED_CONTEXT_CHARS);
}

function boundCodeString(value: unknown, maxChars: number): string {
    return String(value ?? '').slice(0, maxChars);
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }
    const truncated = Math.trunc(parsed);
    return truncated > 0 ? truncated : undefined;
}

function sanitizeBranch(value: unknown): 'fast' | 'deep' | 'all' | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (value === 'fast' || value === 'deep' || value === 'all') {
        return value;
    }

    throw new Error(`Meeting Copilot cancel branch "${sanitizeString(value)}" is invalid`);
}

function sanitizePane(value: unknown): 'main' | 'fast' | 'deep' | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (value === 'main' || value === 'fast' || value === 'deep') {
        return value;
    }

    throw new Error(`Meeting Copilot error pane "${sanitizeString(value)}" is invalid`);
}

function boundMetrics(event: Extract<MeetingCopilotEvent, { type: 'action:completed' | 'metrics:update' }>) {
    return {
        ...event.metrics,
        error: event.metrics.error ? sanitizeString(event.metrics.error) : event.metrics.error,
        error_type: event.metrics.error_type ? boundString(event.metrics.error_type) : event.metrics.error_type,
    };
}

export function boundMeetingCopilotEvent(event: MeetingCopilotEvent): MeetingCopilotEvent {
    switch (event.type) {
        case 'action:started':
            return {
                ...event,
                runId: boundString(event.runId),
                actionId: boundString(event.actionId),
                label: boundString(event.label),
            };
        case 'action:token':
            return {
                ...event,
                runId: boundString(event.runId),
                token: boundString(event.token),
            };
        case 'action:tool_status':
            return {
                ...event,
                runId: boundString(event.runId),
                pane: sanitizePane(event.pane),
                message: sanitizeString(event.message),
            };
        case 'action:error':
            return {
                ...event,
                runId: boundString(event.runId),
                error: sanitizeString(event.error),
                error_type: typeof event.error_type === 'string' ? sanitizeString(event.error_type) : undefined,
                pane: sanitizePane(event.pane),
            };
        case 'action:cancelled':
            return {
                ...event,
                runId: boundString(event.runId),
            };
        case 'action:completed':
            return {
                ...event,
                runId: boundString(event.runId),
                metrics: boundMetrics(event),
                warnings: boundWarnings(event.warnings),
            };
        case 'metrics:update':
            return {
                ...event,
                metrics: boundMetrics(event),
            };
        case 'context:pin:updated':
            return {
                ...event,
                value: boundPinnedContextValue(event.value),
            };
        default:
            return event;
    }
}

export function registerMeetingCopilotIpc(options: RegisterMeetingCopilotIpcOptions): {
    emitToRenderer: (event: MeetingCopilotEvent) => void;
} {
    const emitToRenderer = (event: MeetingCopilotEvent) => {
        options.webContents.send(MEETING_COPILOT_EVENT_CHANNEL, boundMeetingCopilotEvent(event));
    };

    options.ipcMain.removeHandler(MEETING_COPILOT_INVOKE_CHANNEL);
    options.ipcMain.handle(MEETING_COPILOT_INVOKE_CHANNEL, async (_event, payload) => {
        if (!payload || typeof payload !== 'object' || !('type' in payload)) {
            throw new Error('Meeting Copilot invoke payload is invalid');
        }

        if (payload.type === 'action:start') {
            return options.actionRunManager.start({
                actionId: sanitizeInvokeId(payload.actionId),
            });
        }

        if (payload.type === 'action:cancel') {
            return options.actionRunManager.cancel({
                runId: sanitizeInvokeId(payload.runId),
                branch: sanitizeBranch(payload.branch),
            });
        }

        if (payload.type === 'context:pin:get') {
            return {
                value: boundPinnedContextValue(await options.pinnedContextStore.load()),
            };
        }

        if (payload.type === 'context:pin:update') {
            const value = await options.pinnedContextStore.save(
                boundPinnedContextValue(payload.value)
            );
            emitToRenderer({
                type: 'context:pin:updated',
                value,
            });
            return { value };
        }

        if (payload.type === 'context:pin:reset') {
            const value = await options.pinnedContextStore.reset();
            emitToRenderer({
                type: 'context:pin:updated',
                value,
            });
            return { value };
        }

        if (payload.type === 'code:list_workspaces') {
            if (!options.codeTools) {
                throw new Error('Meeting Copilot code tools are not available in this slice');
            }
            return options.codeTools.listWorkspaces();
        }

        if (payload.type === 'code:search') {
            if (!options.codeTools) {
                throw new Error('Meeting Copilot code tools are not available in this slice');
            }
            return options.codeTools.searchRepo({
                query: boundCodeString(payload.query, 240),
                workspace: boundCodeString(payload.workspace, 256) || undefined,
            });
        }

        if (payload.type === 'code:read') {
            if (!options.codeTools) {
                throw new Error('Meeting Copilot code tools are not available in this slice');
            }
            return options.codeTools.readFileSlice({
                path: boundCodeString(payload.path, 4096),
                workspace: boundCodeString(payload.workspace, 256) || undefined,
                startLine: positiveIntegerOrUndefined(payload.startLine),
                endLine: positiveIntegerOrUndefined(payload.endLine),
            });
        }

        throw new Error(`Meeting Copilot invoke "${sanitizeInvokeType((payload as { type?: unknown }).type)}" is not available in this slice yet`);
    });

    return {
        emitToRenderer,
    };
}
