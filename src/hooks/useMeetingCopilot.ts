import { useEffect, useMemo, useReducer } from 'react';

import type {
  LlmCallMetrics,
  MeetingCopilotEvent,
} from '../../electron/meeting-copilot/types';

export type MeetingCopilotPaneKey = 'main' | 'fast' | 'deep';
export type MeetingCopilotRunStatus =
  | 'started'
  | 'streaming'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface MeetingCopilotPaneState {
  text: string;
  truncated: boolean;
}

export interface MeetingCopilotRun {
  runId: string;
  actionId: string;
  label: string;
  status: MeetingCopilotRunStatus;
  panes: Record<MeetingCopilotPaneKey, MeetingCopilotPaneState>;
  paneErrors: Partial<Record<MeetingCopilotPaneKey, string>>;
  toolStatus: Partial<Record<MeetingCopilotPaneKey, string>>;
  metrics?: LlmCallMetrics;
  error?: string;
  error_type?: string;
  warnings?: string[];
}

export interface MeetingCopilotState {
  runIds: string[];
  runsById: Record<string, MeetingCopilotRun>;
  latestMetrics?: LlmCallMetrics;
}

type ElectronApiLike = {
  meetingCopilot: {
    invoke: (payload: {
      type: 'action:cancel';
      runId: string;
      branch?: 'fast' | 'deep' | 'all';
    }) => Promise<unknown>;
    onEvent?: (callback: (event: MeetingCopilotEvent) => void) => () => void;
  };
};

const MAX_RUN_TEXT_CHARS = 24_000;

function createEmptyPane(): MeetingCopilotPaneState {
  return {
    text: '',
    truncated: false,
  };
}

function createEmptyPanes(): Record<MeetingCopilotPaneKey, MeetingCopilotPaneState> {
  return {
    main: createEmptyPane(),
    fast: createEmptyPane(),
    deep: createEmptyPane(),
  };
}

function createRun(input: {
  runId: string;
  actionId?: string;
  label?: string;
}): MeetingCopilotRun {
  return {
    runId: input.runId,
    actionId: input.actionId ?? '',
    label: input.label ?? 'Meeting Copilot',
    status: 'started',
    panes: createEmptyPanes(),
    paneErrors: {},
    toolStatus: {},
  };
}

function ensureRun(
  state: MeetingCopilotState,
  input: {
    runId: string;
    actionId?: string;
    label?: string;
  }
): MeetingCopilotRun {
  const existing = state.runsById[input.runId];
  if (existing) {
    return existing;
  }
  return createRun(input);
}

function prependRunId(runIds: string[], runId: string): string[] {
  return [runId, ...runIds.filter((candidate) => candidate !== runId)];
}

function boundPaneText(currentText: string, delta: string): MeetingCopilotPaneState {
  const combined = `${currentText}${delta}`;
  if (combined.length <= MAX_RUN_TEXT_CHARS) {
    return {
      text: combined,
      truncated: false,
    };
  }

  return {
    text: `...${combined.slice(-(MAX_RUN_TEXT_CHARS - 3))}`,
    truncated: true,
  };
}

function updateRun(
  state: MeetingCopilotState,
  runId: string,
  updater: (run: MeetingCopilotRun) => MeetingCopilotRun,
  options?: {
    latestMetrics?: LlmCallMetrics;
    moveToFront?: boolean;
  }
): MeetingCopilotState {
  const updatedRun = updater(state.runsById[runId] ?? createRun({ runId }));
  return {
    runIds: options?.moveToFront ? prependRunId(state.runIds, runId) : state.runIds,
    runsById: {
      ...state.runsById,
      [runId]: updatedRun,
    },
    latestMetrics: options?.latestMetrics ?? state.latestMetrics,
  };
}

export const initialMeetingCopilotState: MeetingCopilotState = {
  runIds: [],
  runsById: {},
  latestMetrics: undefined,
};

export function meetingCopilotReducer(
  state: MeetingCopilotState,
  event: MeetingCopilotEvent
): MeetingCopilotState {
  switch (event.type) {
    case 'action:started': {
      const run = ensureRun(state, {
        runId: event.runId,
        actionId: event.actionId,
        label: event.label,
      });
      return updateRun(
        state,
        event.runId,
        () => ({
          ...run,
          actionId: event.actionId,
          label: event.label,
          status: run.panes.main.text || run.panes.fast.text || run.panes.deep.text ? 'streaming' : 'started',
          error: undefined,
        }),
        { moveToFront: true }
      );
    }
    case 'action:token': {
      const run = ensureRun(state, { runId: event.runId });
      const pane = run.panes[event.pane] ?? createEmptyPane();
      return updateRun(state, event.runId, () => ({
        ...run,
        status: 'streaming',
        panes: {
          ...run.panes,
          [event.pane]: boundPaneText(pane.text, event.token),
        },
      }));
    }
    case 'action:tool_status': {
      const run = ensureRun(state, { runId: event.runId });
      const pane = event.pane ?? 'main';
      return updateRun(state, event.runId, () => ({
        ...run,
        toolStatus: {
          ...run.toolStatus,
          [pane]: event.message,
        },
      }));
    }
    case 'action:completed': {
      const run = ensureRun(state, { runId: event.runId });
      return updateRun(
        state,
        event.runId,
        () => ({
          ...run,
          status: 'completed',
          metrics: event.metrics,
          error: undefined,
          warnings: event.warnings,
        }),
        { latestMetrics: event.metrics }
      );
    }
    case 'action:error': {
      const run = ensureRun(state, { runId: event.runId });
      const paneErrors = event.pane
        ? {
            ...run.paneErrors,
            [event.pane]: event.error,
          }
        : run.paneErrors;
      return updateRun(state, event.runId, () => ({
        ...run,
        status: event.pane ? run.status : 'error',
        error: event.pane ? run.error : event.error,
        error_type: event.error_type,
        paneErrors,
      }));
    }
    case 'action:cancelled': {
      const run = ensureRun(state, { runId: event.runId });
      return updateRun(state, event.runId, () => ({
        ...run,
        status:
          event.branch === undefined || event.branch === 'all'
            ? 'cancelled'
            : run.status,
      }));
    }
    case 'metrics:update':
      return {
        ...state,
        latestMetrics: event.metrics,
      };
    default:
      return state;
  }
}

export function getRunVisibleText(
  run: MeetingCopilotRun,
  pane: MeetingCopilotPaneKey = 'main'
): string {
  return run.panes[pane]?.text ?? '';
}

export function getCopyTextForRun(
  run: MeetingCopilotRun,
  pane: MeetingCopilotPaneKey = 'main'
): string {
  return getRunVisibleText(run, pane).trim();
}

export function getVisiblePaneKeys(run: MeetingCopilotRun): MeetingCopilotPaneKey[] {
  const ordered: MeetingCopilotPaneKey[] = ['main', 'fast', 'deep'];
  const visible = ordered.filter((pane) => run.panes[pane].text.trim().length > 0);
  return visible.length > 0 ? visible : ['main'];
}

export function createMeetingCopilotCancel(electronApiLike: ElectronApiLike) {
  return (runId: string, branch?: 'fast' | 'deep' | 'all') =>
    electronApiLike.meetingCopilot.invoke({
      type: 'action:cancel',
      runId,
      branch,
    });
}

export function useMeetingCopilot() {
  const [state, dispatch] = useReducer(
    meetingCopilotReducer,
    initialMeetingCopilotState
  );

  useEffect(() => {
    const unsubscribe = window.electronAPI?.meetingCopilot?.onEvent?.((event) => {
      dispatch(event);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  const cancel = useMemo(
    () => createMeetingCopilotCancel(window.electronAPI),
    []
  );

  return {
    state,
    cancel,
  };
}
