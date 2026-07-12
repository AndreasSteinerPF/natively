import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const { ActionRunManager } = await import(
  pathToFileURL(path.join(distRoot, 'ActionRunManager.js')).href
);

function createSnapshot() {
  return createSnapshotForMeeting('meeting-123');
}

function createSnapshotForMeeting(meetingId) {
  return {
    meeting_id: meetingId,
    chunks: [
      {
        id: 'chunk-001',
        meeting_id: meetingId,
        start_ts: '2026-07-03T10:00:00.000Z',
        end_ts: '2026-07-03T10:00:30.000Z',
        text: 'Design a scalable notification service.',
        source: 'mic',
      },
    ],
  };
}

function createConfig() {
  return {
    actions: {
      'guide-me': {
        label: 'Guide Me',
        trigger: { hotkey: 'Command+Option+2', slash: '/guide', button: false },
        model: 'anthropic/claude-opus-4.8',
        context_mode: 'full_cached',
        cache_policy: 'anthropic_explicit_1h',
        temperature: 0.2,
        prompt: 'Guide the current system design phase.',
      },
      'go-deeper': {
        label: 'Go Deeper',
        trigger: { hotkey: 'Command+Option+3', slash: '/deeper', button: false },
        model: 'anthropic/claude-opus-4.8',
        context_mode: 'full_cached',
        cache_policy: 'anthropic_explicit_1h',
        temperature: 0.2,
        prompt: 'Critique the current design.',
      },
    },
    code_context: {
      enabled: false,
      retrieval_mode: 'tool_loop',
      max_total_chars: 12000,
      include_file_paths: false,
      include_line_numbers: false,
    },
    transcript_context: {
      max_total_chars: 24000,
    },
    project_context: {
      enabled: false,
      max_docs_chars_per_pack: 20000,
      max_total_docs_chars: 40000,
      packs: [],
    },
  };
}

describe('meeting-copilot shared action state', () => {
  test('second action sees the completed text from the first action', async () => {
    const snapshot = createSnapshot();
    const builtContexts = [];
    const responses = [
      'Step: High-level architecture\nSay: Start with one API service and Postgres as the source of truth.',
      'Step: Deep dive\nSay: Add a queue to decouple writes from fanout.',
    ];
    const manager = new ActionRunManager({
      config: createConfig(),
      transcriptSnapshotProvider: () => snapshot,
      buildContext: (input) => {
        builtContexts.push(input);
        return { mode: input.mode, sections: [] };
      },
      buildMessages: () => ({ messages: [] }),
      openRouterClient: {
        streamChatCompletion: async function* () {
          const content = responses.shift() ?? '';
          yield { type: 'token', token: content };
          yield {
            type: 'done',
            result: {
              content,
              raw: {},
              warnings: [],
              metrics: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
          };
        },
      },
      emitEvent: () => {},
      createRunId: (() => {
        let id = 0;
        return () => `run-${++id}`;
      })(),
      now: (() => {
        let tick = 0;
        return () => ++tick;
      })(),
      getStableInstructions: () => 'Use transcript faithfully.',
      getCustomContext: () => '',
      getPinnedContext: () => '',
      getCodeContext: () => '',
    });

    await manager.start({ actionId: 'guide-me' });
    await manager.start({ actionId: 'go-deeper' });

    assert.equal(builtContexts[0].actionHistory, '');
    assert.deepEqual(builtContexts[0].actionHistoryEntries, []);
    assert.match(
      builtContexts[1].actionHistory,
      /Guide Me[\s\S]*Postgres as the source of truth\./
    );
    assert.deepEqual(builtContexts[1].actionHistoryEntries, [
      'Guide Me\nStep: High-level architecture\nSay: Start with one API service and Postgres as the source of truth.',
    ]);
  });

  test('action history is isolated across meeting ids', async () => {
    const builtContexts = [];
    const snapshots = [
      createSnapshotForMeeting('meeting-one'),
      createSnapshotForMeeting('meeting-two'),
    ];
    const responses = [
      'Step: Scope\nSay: This is an Uber-like ride-sharing service.',
      'Step: Scope\nSay: This is a clean new problem.',
    ];
    const manager = new ActionRunManager({
      config: createConfig(),
      transcriptSnapshotProvider: () => snapshots.shift(),
      buildContext: (input) => {
        builtContexts.push(input);
        return { mode: input.mode, sections: [] };
      },
      buildMessages: () => ({ messages: [] }),
      openRouterClient: {
        streamChatCompletion: async function* () {
          const content = responses.shift() ?? '';
          yield { type: 'token', token: content };
          yield {
            type: 'done',
            result: {
              content,
              raw: {},
              warnings: [],
              metrics: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
          };
        },
      },
      emitEvent: () => {},
      createRunId: (() => {
        let id = 0;
        return () => `run-${++id}`;
      })(),
      now: (() => {
        let tick = 0;
        return () => ++tick;
      })(),
      getStableInstructions: () => 'Use transcript faithfully.',
      getCustomContext: () => '',
      getPinnedContext: () => '',
      getCodeContext: () => '',
    });

    await manager.start({ actionId: 'guide-me' });
    await manager.start({ actionId: 'guide-me' });

    assert.equal(builtContexts[0].actionHistory, '');
    assert.equal(builtContexts[1].actionHistory, '');
    assert.deepEqual(builtContexts[0].actionHistoryEntries, []);
    assert.deepEqual(builtContexts[1].actionHistoryEntries, []);
  });
});
