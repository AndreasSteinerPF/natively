import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const moduleUrl = pathToFileURL(
  path.resolve(repoRoot, 'src/hooks/useMeetingCopilot.ts')
).href;

const {
  initialMeetingCopilotState,
  meetingCopilotReducer,
  getRunVisibleText,
  getCopyTextForRun,
  createMeetingCopilotCancel,
} = await import(moduleUrl);

function createStartedEvent(overrides = {}) {
  return {
    type: 'action:started',
    runId: 'run-1',
    actionId: 'quick-answer',
    label: 'Quick Answer',
    ...overrides,
  };
}

function createRunWithText(text = 'Hello world') {
  let state = meetingCopilotReducer(
    initialMeetingCopilotState,
    createStartedEvent()
  );
  state = meetingCopilotReducer(state, {
    type: 'action:token',
    runId: 'run-1',
    pane: 'main',
    token: text,
  });
  return state;
}

describe('useMeetingCopilot reducer', () => {
  test('token events append only to the addressed pane for the correct run', () => {
    const started = meetingCopilotReducer(
      initialMeetingCopilotState,
      createStartedEvent()
    );

    const next = meetingCopilotReducer(started, {
      type: 'action:token',
      runId: 'run-1',
      pane: 'fast',
      token: 'Fast lane',
    });

    assert.equal(next.runsById['run-1'].panes.fast.text, 'Fast lane');
    assert.equal(next.runsById['run-1'].panes.main.text, '');
  });

  test('completion and error events preserve previously streamed text', () => {
    const withText = createRunWithText();
    const completed = meetingCopilotReducer(withText, {
      type: 'action:completed',
      runId: 'run-1',
      metrics: { total_latency_ms: 42 },
      warnings: ['cache_control_disabled_after_provider_rejection'],
    });
    const errored = meetingCopilotReducer(completed, {
      type: 'action:error',
      runId: 'run-1',
      error: 'Provider timed out',
    });

    assert.equal(completed.runsById['run-1'].panes.main.text, 'Hello world');
    assert.deepEqual(completed.runsById['run-1'].warnings, ['cache_control_disabled_after_provider_rejection']);
    assert.equal(errored.runsById['run-1'].panes.main.text, 'Hello world');
  });

  test('pane-local error is preserved after another pane completes', () => {
    let state = meetingCopilotReducer(
      initialMeetingCopilotState,
      createStartedEvent({ actionId: 'tech-solver-parallel', label: 'Tech Solver: Fast + Deep' })
    );
    state = meetingCopilotReducer(state, {
      type: 'action:token',
      runId: 'run-1',
      pane: 'fast',
      token: 'Fast answer',
    });
    state = meetingCopilotReducer(state, {
      type: 'action:error',
      runId: 'run-1',
      pane: 'deep',
      error: 'Deep branch failed',
    });
    state = meetingCopilotReducer(state, {
      type: 'action:completed',
      runId: 'run-1',
      metrics: { total_latency_ms: 99 },
    });

    assert.equal(state.runsById['run-1'].panes.fast.text, 'Fast answer');
    assert.equal(state.runsById['run-1'].paneErrors?.deep, 'Deep branch failed');
    assert.equal(state.runsById['run-1'].error, undefined);
  });

  test('cancelled events preserve previously streamed text while marking the run cancelled', () => {
    const withText = createRunWithText('Keep this text');
    const cancelled = meetingCopilotReducer(withText, {
      type: 'action:cancelled',
      runId: 'run-1',
      branch: 'all',
    });

    assert.equal(cancelled.runsById['run-1'].status, 'cancelled');
    assert.equal(cancelled.runsById['run-1'].panes.main.text, 'Keep this text');
  });

  test('branch-local cancellation preserves the overall streaming run status', () => {
    let state = meetingCopilotReducer(
      initialMeetingCopilotState,
      createStartedEvent({
        runId: 'run-1',
        actionId: 'tech-solver-parallel',
        label: 'Tech Solver: Fast + Deep',
      })
    );
    state = meetingCopilotReducer(state, {
      type: 'action:token',
      runId: 'run-1',
      pane: 'fast',
      token: 'Fast answer keeps running',
    });
    state = meetingCopilotReducer(state, {
      type: 'action:cancelled',
      runId: 'run-1',
      branch: 'deep',
    });

    assert.equal(state.runsById['run-1'].status, 'streaming');
    assert.equal(state.runsById['run-1'].panes.fast.text, 'Fast answer keeps running');
  });

  test('started runs are kept in recency order and token text is bounded', () => {
    const longToken = 'x'.repeat(40_000);
    let state = meetingCopilotReducer(
      initialMeetingCopilotState,
      createStartedEvent({ runId: 'run-1', actionId: 'quick-answer', label: 'Quick Answer' })
    );
    state = meetingCopilotReducer(
      state,
      createStartedEvent({ runId: 'run-2', actionId: 'deep-answer', label: 'Deep Answer' })
    );
    state = meetingCopilotReducer(state, {
      type: 'action:token',
      runId: 'run-2',
      pane: 'main',
      token: longToken,
    });

    assert.deepEqual(state.runIds, ['run-2', 'run-1']);
    assert.ok(state.runsById['run-2'].panes.main.text.length <= 24_000);
  });

  test('cancel helper sends the expected invoke payload', async () => {
    const calls = [];
    const cancel = createMeetingCopilotCancel({
      meetingCopilot: {
        invoke: async (payload) => {
          calls.push(payload);
          return { cancelled: true };
        },
      },
    });

    await cancel('run-1', 'deep');

    assert.deepEqual(calls, [
      { type: 'action:cancel', runId: 'run-1', branch: 'deep' },
    ]);
  });

  test('visible text helper returns only the selected pane text', () => {
    const state = createRunWithText('Main output');
    const withPanes = meetingCopilotReducer(state, {
      type: 'action:token',
      runId: 'run-1',
      pane: 'deep',
      token: 'Deep output',
    });
    const run = withPanes.runsById['run-1'];

    assert.equal(getRunVisibleText(run, 'deep'), 'Deep output');
    assert.equal(getRunVisibleText(run, 'main'), 'Main output');
  });

  test('copy text uses only the selected pane text and excludes hidden panes, metadata, labels, and errors', () => {
    let state = meetingCopilotReducer(
      initialMeetingCopilotState,
      createStartedEvent({ label: 'Claim Check' })
    );
    state = meetingCopilotReducer(state, {
      type: 'action:token',
      runId: 'run-1',
      pane: 'main',
      token: 'Visible main pane',
    });
    state = meetingCopilotReducer(state, {
      type: 'action:token',
      runId: 'run-1',
      pane: 'deep',
      token: 'Hidden deep pane',
    });
    state = meetingCopilotReducer(state, {
      type: 'action:error',
      runId: 'run-1',
      error: 'Do not copy this',
    });
    state = meetingCopilotReducer(state, {
      type: 'action:completed',
      runId: 'run-1',
      metrics: {
        model: 'anthropic/test-model',
        total_latency_ms: 123,
      },
    });

    const run = state.runsById['run-1'];

    assert.equal(getCopyTextForRun(run, 'main'), 'Visible main pane');
    assert.equal(getCopyTextForRun(run, 'deep'), 'Hidden deep pane');
    assert.equal(getCopyTextForRun(run, 'main').includes('Hidden deep pane'), false);
    assert.equal(getCopyTextForRun(run, 'main').includes('Claim Check'), false);
    assert.equal(getCopyTextForRun(run, 'main').includes('Do not copy this'), false);
    assert.equal(getCopyTextForRun(run, 'main').includes('anthropic/test-model'), false);
  });

  test('tool status events store a compact latest status on the run', () => {
    const state = meetingCopilotReducer(initialMeetingCopilotState, {
      type: 'action:tool_status',
      runId: 'run-1',
      pane: 'deep',
      message: 'Searching repo for "ToolLoop"',
    });

    assert.equal(state.runsById['run-1'].toolStatus.deep, 'Searching repo for "ToolLoop"');
    assert.equal(state.runsById['run-1'].toolStatus.main, undefined);
  });
});
