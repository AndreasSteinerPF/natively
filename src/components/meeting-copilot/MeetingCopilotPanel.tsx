import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, Copy, Square, TriangleAlert } from 'lucide-react';

import {
  getCopyTextForRun,
  getRunVisibleText,
  getVisiblePaneKeys,
} from '../../hooks/useMeetingCopilot';
import type {
  MeetingCopilotPaneKey,
  MeetingCopilotRun,
  MeetingCopilotState,
} from '../../hooks/useMeetingCopilot';

type MeetingCopilotPanelProps = {
  state: MeetingCopilotState;
  cancel: (runId: string, branch?: 'fast' | 'deep' | 'all') => Promise<unknown>;
  systemDesignMode?: boolean;
};

const STATUS_LABELS: Record<MeetingCopilotRun['status'], string> = {
  started: 'Started',
  streaming: 'Streaming',
  completed: 'Complete',
  error: 'Error',
  cancelled: 'Cancelled',
};

const PANE_LABELS: Record<MeetingCopilotPaneKey, string> = {
  main: 'Answer',
  fast: 'Fast answer',
  deep: 'Deep answer',
};

function statusTone(status: MeetingCopilotRun['status']): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20';
    case 'error':
      return 'bg-rose-500/10 text-rose-300 border-rose-500/20';
    case 'cancelled':
      return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
    default:
      return 'bg-sky-500/10 text-sky-300 border-sky-500/20';
  }
}

export function MeetingCopilotPanel({
  state,
  cancel,
  systemDesignMode = false,
}: MeetingCopilotPanelProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [paneByRunId, setPaneByRunId] = useState<
    Record<string, MeetingCopilotPaneKey>
  >({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const visibleRunIds = useMemo(
    () => (systemDesignMode ? [...state.runIds].reverse() : state.runIds.slice(0, 3)),
    [state.runIds, systemDesignMode]
  );
  const visibleRuns = useMemo(
    () => visibleRunIds.map((runId) => state.runsById[runId]).filter(Boolean),
    [state.runsById, visibleRunIds]
  );

  useEffect(() => {
    if (visibleRunIds.length === 0) {
      setSelectedRunId(null);
      return;
    }

    if (!selectedRunId || !state.runsById[selectedRunId]) {
      setSelectedRunId(visibleRunIds[0]);
    }
  }, [selectedRunId, state.runsById, visibleRunIds]);

  useEffect(() => {
    if (!copiedKey) {
      return;
    }

    const timer = window.setTimeout(() => setCopiedKey(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedKey]);

  if (visibleRuns.length === 0) {
    return null;
  }

  const selectedRun =
    (selectedRunId && state.runsById[selectedRunId]) || visibleRuns[0];

  if (systemDesignMode) {
    return (
      <div className="relative no-drag mx-4 mt-2 mb-1">
        <div
          data-system-design-scroll="true"
          className="rounded-[14px] border border-white/10 px-3 py-3 overlay-subtle-surface max-h-[280px] overflow-y-auto"
        >
          <div className="flex items-center justify-between gap-2 pb-2">
            <span className="text-[11px] font-medium overlay-text-primary">
              AI Responses
            </span>
            <span className="text-[10px] overlay-text-muted">
              Cmd+Up / Cmd+Down to scroll
            </span>
          </div>
          <div className="flex flex-col gap-3">
            {visibleRuns.map((run, index) => {
              const paneKeys = getVisiblePaneKeys(run);
              const paneKey = paneKeys[0];
              const visibleText = getRunVisibleText(run, paneKey).trim();
              const copyText = getCopyTextForRun(run, paneKey);
              const isCopied = copiedKey === `${run.runId}:${paneKey}`;
              const isActive =
                run.status === 'started' || run.status === 'streaming';
              const toolStatus = run.toolStatus?.[paneKey];

              return (
                <section
                  key={run.runId}
                  className={index === 0 ? '' : 'border-t border-white/10 pt-3'}
                >
                  <header className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[11px] font-medium overlay-text-primary">
                          {run.label}
                        </span>
                        <span
                          className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] ${statusTone(run.status)}`}
                        >
                          {STATUS_LABELS[run.status]}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        aria-label="Copy response"
                        className="rounded-md p-1 transition-colors overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive"
                        onClick={async () => {
                          await navigator.clipboard?.writeText(copyText);
                          setCopiedKey(`${run.runId}:${paneKey}`);
                        }}
                        title="Copy response"
                      >
                        {isCopied ? (
                          <Check className="h-3.5 w-3.5 text-emerald-300" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                      {isActive ? (
                        <button
                          type="button"
                          aria-label="Cancel response"
                          className="rounded-md p-1 transition-colors overlay-icon-surface overlay-icon-surface-hover text-rose-300"
                          onClick={() => void cancel(run.runId)}
                          title="Cancel response"
                        >
                          <Square className="h-3.5 w-3.5 fill-current" />
                        </button>
                      ) : null}
                    </div>
                  </header>

                  <div className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-5 overlay-text-primary">
                    {visibleText || <span className="overlay-text-muted">...</span>}
                  </div>
                  {toolStatus ? (
                    <div className="mt-1 break-words text-[10px] leading-4 overlay-text-muted">
                      {toolStatus}
                    </div>
                  ) : null}
                  {(run.error || run.paneErrors[paneKey]) ? (
                    <div className="mt-2 flex flex-col gap-0.5">
                      <div className="flex items-start gap-1.5 text-[10px] text-rose-300">
                        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="break-words">
                          {run.error ?? run.paneErrors[paneKey]}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {run.warnings?.length ? (
                    <div className="mt-2 flex items-start gap-1.5 text-[10px] text-amber-300">
                      <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                      <span className="break-words">{run.warnings.join(' ')}</span>
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative no-drag mx-4 mt-2 mb-1">
      <div className="flex flex-col gap-2 rounded-[14px] border border-white/10 px-3 py-3 overlay-subtle-surface">
        {visibleRuns.map((run) => {
          const paneKeys = getVisiblePaneKeys(run);
          const selectedPane =
            paneByRunId[run.runId] && paneKeys.includes(paneByRunId[run.runId])
              ? paneByRunId[run.runId]
              : paneKeys[0];
          const visibleText = getRunVisibleText(run, selectedPane).trim();
          const copyText = getCopyTextForRun(run, selectedPane);
          const isCopied = copiedKey === `${run.runId}:${selectedPane}`;
          const isSelected = selectedRun?.runId === run.runId;
          const isActive =
            run.status === 'started' || run.status === 'streaming';
          const toolStatus = run.toolStatus?.[selectedPane];

          return (
            <section
              key={run.runId}
              className={`rounded-[12px] border px-3 py-2 transition-colors ${
                isSelected
                  ? 'border-white/20 bg-white/5'
                  : 'border-white/10 bg-black/10'
              }`}
            >
              <header className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedRunId(run.runId)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[11px] font-medium overlay-text-primary">
                      {run.label}
                    </span>
                    <span
                      className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] ${statusTone(run.status)}`}
                    >
                      {STATUS_LABELS[run.status]}
                    </span>
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    aria-label="Copy response"
                    className="rounded-md p-1 transition-colors overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive"
                    onClick={async () => {
                      await navigator.clipboard?.writeText(copyText);
                      setCopiedKey(`${run.runId}:${selectedPane}`);
                    }}
                    title="Copy response"
                  >
                    {isCopied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-300" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {isActive ? (
                    <button
                      type="button"
                      aria-label="Cancel response"
                      className="rounded-md p-1 transition-colors overlay-icon-surface overlay-icon-surface-hover text-rose-300"
                      onClick={() =>
                        void cancel(
                          run.runId,
                          selectedPane === 'main' ? undefined : selectedPane
                        )
                      }
                      title="Cancel response"
                    >
                      <Square className="h-3.5 w-3.5 fill-current" />
                    </button>
                  ) : null}
                </div>
              </header>

              {paneKeys.length > 1 ? (
                <div className="mt-2 flex gap-1">
                  {paneKeys.map((paneKey) => (
                    <button
                      key={paneKey}
                      type="button"
                      onClick={() =>
                        setPaneByRunId((current) => ({
                          ...current,
                          [run.runId]: paneKey,
                        }))
                      }
                      className={`rounded-md px-1.5 py-0.5 text-[10px] ${
                        selectedPane === paneKey
                          ? 'bg-white/10 overlay-text-primary'
                          : 'overlay-text-muted'
                      }`}
                    >
                      {PANE_LABELS[paneKey]}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-5 overlay-text-primary">
                {visibleText || <span className="overlay-text-muted">...</span>}
              </div>
              {toolStatus ? (
                <div className="mt-1 break-words text-[10px] leading-4 overlay-text-muted">
                  {toolStatus}
                </div>
              ) : null}

              {(run.error || run.paneErrors[selectedPane]) ? (
                <div className="mt-2 flex flex-col gap-0.5">
                  <div className="flex items-start gap-1.5 text-[10px] text-rose-300">
                    <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="break-words">
                      {run.error ?? run.paneErrors[selectedPane]}
                    </span>
                  </div>
                  {run.error_type && run.status === 'error' ? (
                    <span className="ml-[22px] rounded-md border border-rose-500/20 bg-rose-500/5 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-rose-400/80">
                      {run.error_type}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {run.warnings?.length ? (
                <div className="mt-2 flex items-start gap-1.5 text-[10px] text-amber-300">
                  <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="break-words">{run.warnings.join(' ')}</span>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
