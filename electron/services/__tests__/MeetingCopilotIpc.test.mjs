import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const {
  MEETING_COPILOT_EVENT_CHANNEL,
  MEETING_COPILOT_INVOKE_CHANNEL,
  boundMeetingCopilotEvent,
  registerMeetingCopilotIpc,
} = await import(pathToFileURL(path.join(distRoot, 'ipc.js')).href);

describe('meeting-copilot ipc', () => {
  function createPinnedContextStore(initialValue = 'Pinned V1') {
    let value = initialValue;
    return {
      load() {
        return Promise.resolve(value);
      },
      save(nextValue) {
        value = nextValue;
        return Promise.resolve(value);
      },
      reset() {
        value = 'Pinned reset';
        return Promise.resolve(value);
      },
    };
  }

  test('compiled meeting-copilot runtime exports the IPC constants and helpers', () => {
    assert.equal(typeof MEETING_COPILOT_INVOKE_CHANNEL, 'string');
    assert.equal(typeof MEETING_COPILOT_EVENT_CHANNEL, 'string');
    assert.equal(typeof boundMeetingCopilotEvent, 'function');
    assert.equal(typeof registerMeetingCopilotIpc, 'function');
  });

  test('event bounding trims oversized token and error strings before renderer delivery', () => {
    const boundedToken = boundMeetingCopilotEvent({
      type: 'action:token',
      runId: 'run-001',
      pane: 'main',
      token: 't'.repeat(20_000),
    });
    const boundedError = boundMeetingCopilotEvent({
      type: 'action:error',
      runId: 'run-001',
      error: 'e'.repeat(20_000),
    });
    const boundedCompleted = boundMeetingCopilotEvent({
      type: 'action:completed',
      runId: 'run-001',
      metrics: {},
      warnings: ['w'.repeat(20_000), 'Authorization: Bearer sk-test-secret'],
    });

    assert.equal(boundedToken.token.length, 16_000);
    assert.equal(boundedError.error.length, 16_000);
    assert.equal(boundedCompleted.warnings[0].length, 16_000);
    assert.doesNotMatch(boundedCompleted.warnings[1], /sk-test-secret/);
  });

  test('event bounding trims oversized pinned context strings before renderer delivery', () => {
    const boundedEvent = boundMeetingCopilotEvent({
      type: 'context:pin:updated',
      value: 'p'.repeat(20_000),
    });

    assert.equal(boundedEvent.value.length, 12_000);
  });

  test('event bounding trims action:tool_status payloads before renderer delivery', () => {
    const boundedEvent = boundMeetingCopilotEvent({
      type: 'action:tool_status',
      runId: 'run-001',
      pane: 'deep',
      message: 'm'.repeat(20_000),
    });

    assert.equal(boundedEvent.message.length, 16_000);
    assert.equal(boundedEvent.pane, 'deep');
  });

  test('IPC invoke handler dispatches action:start and action:cancel to the ActionRunManager dependency', async () => {
    const handlers = new Map();
    const startCalls = [];
    const cancelCalls = [];

    registerMeetingCopilotIpc({
      ipcMain: {
        removeHandler(channel) {
          handlers.delete(channel);
        },
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
      actionRunManager: {
        start(payload) {
          startCalls.push(payload);
          return Promise.resolve({ ok: true });
        },
        cancel(payload) {
          cancelCalls.push(payload);
          return Promise.resolve({ ok: true });
        },
      },
      pinnedContextStore: createPinnedContextStore(),
      webContents: {
        send() {},
      },
    });

    const invoke = handlers.get(MEETING_COPILOT_INVOKE_CHANNEL);
    await invoke({}, { type: 'action:start', actionId: 'quick-answer' });
    await invoke({}, { type: 'action:cancel', runId: 'run-001', branch: 'all' });

    assert.deepEqual(startCalls, [{ actionId: 'quick-answer' }]);
    assert.deepEqual(cancelCalls, [{ runId: 'run-001', branch: 'all' }]);
  });

  test('IPC invoke bounds oversized actionId and runId before dispatch', async () => {
    const handlers = new Map();
    const startCalls = [];
    const cancelCalls = [];
    const longActionId = 'a'.repeat(20_000);
    const longRunId = 'r'.repeat(20_000);

    registerMeetingCopilotIpc({
      ipcMain: {
        removeHandler(channel) {
          handlers.delete(channel);
        },
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
      actionRunManager: {
        start(payload) {
          startCalls.push(payload);
          return Promise.resolve({ ok: true });
        },
        cancel(payload) {
          cancelCalls.push(payload);
          return Promise.resolve({ ok: true });
        },
      },
      pinnedContextStore: createPinnedContextStore(),
      webContents: {
        send() {},
      },
    });

    const invoke = handlers.get(MEETING_COPILOT_INVOKE_CHANNEL);
    await invoke({}, { type: 'action:start', actionId: longActionId });
    await invoke({}, { type: 'action:cancel', runId: longRunId, branch: 'all' });

    assert.equal(startCalls[0].actionId.length, 16_000);
    assert.equal(cancelCalls[0].runId.length, 16_000);
  });

  test('IPC invoke rejects invalid cancel branch instead of passing it through', async () => {
    const handlers = new Map();
    const cancelCalls = [];

    registerMeetingCopilotIpc({
      ipcMain: {
        removeHandler(channel) {
          handlers.delete(channel);
        },
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
      actionRunManager: {
        start() {
          return Promise.resolve({ ok: true });
        },
        cancel(payload) {
          cancelCalls.push(payload);
          return Promise.resolve({ ok: true });
        },
      },
      pinnedContextStore: createPinnedContextStore(),
      webContents: {
        send() {},
      },
    });

    const invoke = handlers.get(MEETING_COPILOT_INVOKE_CHANNEL);
    await assert.rejects(
      () => invoke({}, { type: 'action:cancel', runId: 'run-001', branch: 'bad-branch' }),
      /Meeting Copilot cancel branch/
    );

    assert.equal(cancelCalls.length, 0);
  });

  test('event forwarding sends bounded MeetingCopilotEvent payloads to a webContents-like dependency', () => {
    const handlers = new Map();
    const sent = [];

    const registration = registerMeetingCopilotIpc({
      ipcMain: {
        removeHandler(channel) {
          handlers.delete(channel);
        },
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
      actionRunManager: {
        start() {
          return Promise.resolve({ ok: true });
        },
        cancel() {
          return Promise.resolve({ ok: true });
        },
      },
      pinnedContextStore: createPinnedContextStore(),
      webContents: {
        send(channel, payload) {
          sent.push({ channel, payload });
        },
      },
    });

    registration.emitToRenderer({
      type: 'action:token',
      runId: 'run-001',
      pane: 'main',
      token: 'x'.repeat(20_000),
    });

    assert.equal(sent[0].channel, MEETING_COPILOT_EVENT_CHANNEL);
    assert.equal(sent[0].payload.token.length, 16_000);
  });

  test('IPC invoke handles context:pin get, update, and reset while emitting context:pin:updated', async () => {
    const handlers = new Map();
    const sent = [];
    const storeCalls = [];
    let storedValue = 'Pinned V1';

    registerMeetingCopilotIpc({
      ipcMain: {
        removeHandler(channel) {
          handlers.delete(channel);
        },
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
      actionRunManager: {
        start() {
          return Promise.resolve({ ok: true });
        },
        cancel() {
          return Promise.resolve({ ok: true });
        },
      },
      pinnedContextStore: {
        async load() {
          storeCalls.push('load');
          return storedValue;
        },
        async save(value) {
          storeCalls.push({ save: value });
          storedValue = value;
          return storedValue;
        },
        async reset() {
          storeCalls.push('reset');
          storedValue = 'Pinned reset';
          return storedValue;
        },
      },
      webContents: {
        send(channel, payload) {
          sent.push({ channel, payload });
        },
      },
    });

    const invoke = handlers.get(MEETING_COPILOT_INVOKE_CHANNEL);
    const getResult = await invoke({}, { type: 'context:pin:get' });
    const updateResult = await invoke({}, { type: 'context:pin:update', value: 'x'.repeat(20_000) });
    const resetResult = await invoke({}, { type: 'context:pin:reset' });

    assert.deepEqual(getResult, { value: 'Pinned V1' });
    assert.equal(updateResult.value.length, 12_000);
    assert.deepEqual(resetResult, { value: 'Pinned reset' });
    assert.deepEqual(storeCalls, [
      'load',
      { save: 'x'.repeat(12_000) },
      'reset',
    ]);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], {
      channel: MEETING_COPILOT_EVENT_CHANNEL,
      payload: {
        type: 'context:pin:updated',
        value: 'x'.repeat(12_000),
      },
    });
    assert.deepEqual(sent[1], {
      channel: MEETING_COPILOT_EVENT_CHANNEL,
      payload: {
        type: 'context:pin:updated',
        value: 'Pinned reset',
      },
    });
  });

  test('IPC invoke dispatches code:list_workspaces, code:search, and code:read when code tools are available', async () => {
    const handlers = new Map();
    const codeCalls = [];

    registerMeetingCopilotIpc({
      ipcMain: {
        removeHandler(channel) {
          handlers.delete(channel);
        },
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
      actionRunManager: {
        start() {
          return Promise.resolve({ ok: true });
        },
        cancel() {
          return Promise.resolve({ ok: true });
        },
      },
      pinnedContextStore: createPinnedContextStore(),
      codeTools: {
        async listWorkspaces() {
          codeCalls.push(['list']);
          return [{ name: 'repo', path: '/repo', enabled: true }];
        },
        async searchRepo(input) {
          codeCalls.push(['search', input]);
          return [{ path: 'src/index.ts', line: 1, preview: 'hi' }];
        },
        async readFileSlice(input) {
          codeCalls.push(['read', input]);
          return { path: 'src/index.ts', startLine: 1, endLine: 2, content: 'hi' };
        },
      },
      webContents: {
        send() {},
      },
    });

    const invoke = handlers.get(MEETING_COPILOT_INVOKE_CHANNEL);
    const listResult = await invoke({}, { type: 'code:list_workspaces' });
    const searchResult = await invoke({}, { type: 'code:search', query: 'x'.repeat(500), workspace: 'y'.repeat(500) });
    const readResult = await invoke({}, {
      type: 'code:read',
      path: 'p'.repeat(5000),
      workspace: 'w'.repeat(500),
      startLine: -5,
      endLine: 4.2,
    });

    assert.deepEqual(listResult, [{ name: 'repo', path: '/repo', enabled: true }]);
    assert.deepEqual(searchResult, [{ path: 'src/index.ts', line: 1, preview: 'hi' }]);
    assert.deepEqual(readResult, { path: 'src/index.ts', startLine: 1, endLine: 2, content: 'hi' });
    assert.deepEqual(codeCalls[0], ['list']);
    assert.equal(codeCalls[1][0], 'search');
    assert.equal(codeCalls[1][1].query.length, 240);
    assert.equal(codeCalls[1][1].workspace.length, 256);
    assert.equal(codeCalls[2][0], 'read');
    assert.equal(codeCalls[2][1].path.length, 4096);
    assert.equal(codeCalls[2][1].workspace.length, 256);
    assert.equal(codeCalls[2][1].startLine, undefined);
    assert.equal(codeCalls[2][1].endLine, 4);
  });

  test('IPC invoke rejects code tools requests when codeTools is unavailable in this slice', async () => {
    const handlers = new Map();

    registerMeetingCopilotIpc({
      ipcMain: {
        removeHandler(channel) {
          handlers.delete(channel);
        },
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
      actionRunManager: {
        start() {
          return Promise.resolve({ ok: true });
        },
        cancel() {
          return Promise.resolve({ ok: true });
        },
      },
      pinnedContextStore: createPinnedContextStore(),
      webContents: {
        send() {},
      },
    });

    const invoke = handlers.get(MEETING_COPILOT_INVOKE_CHANNEL);
    await assert.rejects(
      () => invoke({}, { type: 'code:list_workspaces' }),
      /Meeting Copilot code tools are not available in this slice/
    );
  });
});
