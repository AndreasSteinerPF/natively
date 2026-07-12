import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const { TranscriptBuffer } = await import(
  pathToFileURL(path.join(distRoot, 'TranscriptBuffer.js')).href
);
const { buildMeetingCopilotContext } = await import(
  pathToFileURL(path.join(distRoot, 'ContextBuilder.js')).href
);
const { DEFAULT_PINNED_CONTEXT_TEMPLATE } = await import(
  pathToFileURL(path.join(distRoot, 'PinnedContextStore.js')).href
);
const { buildOpenRouterMessages } = await import(
  pathToFileURL(path.join(distRoot, 'PromptCache.js')).href
);

function makeBuffer() {
  return new TranscriptBuffer({ meetingId: 'meeting-123' });
}

function seedBuffer() {
  const buffer = makeBuffer();
  buffer.append({
    start_ts: '2026-07-03T10:00:00.000Z',
    end_ts: '2026-07-03T10:00:20.000Z',
    text: 'Kickoff and agenda',
    source: 'mic',
  });
  buffer.append({
    start_ts: '2026-07-03T10:08:00.000Z',
    end_ts: '2026-07-03T10:08:20.000Z',
    text: 'We should simplify the rollout path.',
    source: 'mixed',
  });
  buffer.append({
    start_ts: '2026-07-03T10:09:10.000Z',
    end_ts: '2026-07-03T10:09:30.000Z',
    text: 'The main risk is migration complexity.',
    source: 'system',
  });
  return buffer;
}

describe('MeetingCopilot TranscriptBuffer', () => {
  test('exports the transcript buffer and context builder primitives', () => {
    assert.equal(typeof TranscriptBuffer, 'function');
    assert.equal(typeof buildMeetingCopilotContext, 'function');
  });

  test('appends meeting-only transcript chunks with stable ids and immutable snapshots', () => {
    const buffer = makeBuffer();

    const firstChunk = buffer.append({
      start_ts: '2026-07-03T10:00:00.000Z',
      end_ts: '2026-07-03T10:00:05.000Z',
      text: 'First statement',
      source: 'mic',
    });

    const firstSnapshot = buffer.snapshot();

    const secondChunk = buffer.append({
      start_ts: '2026-07-03T10:00:06.000Z',
      end_ts: '2026-07-03T10:00:10.000Z',
      text: 'Second statement',
      source: 'system',
    });

    const secondSnapshot = buffer.snapshot();

    assert.deepEqual(firstChunk, {
      id: 'chunk:0001',
      meeting_id: 'meeting-123',
      start_ts: '2026-07-03T10:00:00.000Z',
      end_ts: '2026-07-03T10:00:05.000Z',
      text: 'First statement',
      source: 'mic',
    });
    assert.equal(secondChunk.id, 'chunk:0002');
    assert.equal(firstSnapshot.chunks.length, 1);
    assert.equal(secondSnapshot.chunks.length, 2);
    assert.equal(firstSnapshot.chunks[0].text, 'First statement');
    assert.equal(secondSnapshot.chunks[1].text, 'Second statement');
  });

  test('rejects assistant, tool, and action messages from the transcript buffer', () => {
    const buffer = makeBuffer();

    assert.throws(
      () => buffer.appendMessage({ role: 'assistant', text: 'Draft answer' }),
      /meeting-only transcript chunk/i
    );
    assert.throws(
      () => buffer.appendMessage({ role: 'tool', text: 'Tool output' }),
      /meeting-only transcript chunk/i
    );
    assert.throws(
      () => buffer.appendMessage({ role: 'action', text: 'Action event' }),
      /meeting-only transcript chunk/i
    );
  });

  test('snapshot returns copy data so caller mutation and later appends do not affect older snapshots', () => {
    const buffer = seedBuffer();
    const snapshot = buffer.snapshot();

    snapshot.chunks[0].text = 'Locally mutated';

    buffer.append({
      start_ts: '2026-07-03T10:10:00.000Z',
      end_ts: '2026-07-03T10:10:10.000Z',
      text: 'Fresh append',
      source: 'mic',
    });

    assert.equal(snapshot.chunks.length, 3);
    assert.equal(snapshot.chunks[0].text, 'Locally mutated');
    assert.equal(buffer.snapshot().chunks[0].text, 'Kickoff and agenda');
    assert.equal(buffer.snapshot().chunks.length, 4);
  });
});

describe('MeetingCopilot ContextBuilder', () => {
  test('recent context selects chunks by configured recent minutes and preserves prompt section order', () => {
    const snapshot = seedBuffer().snapshot();

    const result = buildMeetingCopilotContext({
      mode: 'recent',
      snapshot,
      contextMinutes: 2,
      now: '2026-07-03T10:10:00.000Z',
      stableInstructions: 'Use transcript faithfully.',
      customContext: 'Custom repo context.',
      pinnedContext: 'Pinned interview context.',
      currentAction: 'Give me a concise answer to say next.',
    });

    assert.deepEqual(
      result.sections.map((section) => section.key),
      ['stable_instructions', 'custom_context', 'pinned_context', 'recent_transcript', 'current_action']
    );
    assert.match(result.sections[3].content, /We should simplify the rollout path\./);
    assert.match(result.sections[3].content, /The main risk is migration complexity\./);
    assert.doesNotMatch(result.sections[3].content, /chunk:0002|start=|end=/);
    assert.doesNotMatch(result.sections[3].content, /Kickoff and agenda/);
  });

  test('pinned context remains ordered after custom context and context building does not mutate transcript chunks', () => {
    const snapshot = seedBuffer().snapshot();
    const beforeChunks = structuredClone(snapshot.chunks);

    const result = buildMeetingCopilotContext({
      mode: 'recent',
      snapshot,
      contextMinutes: 2,
      now: '2026-07-03T10:10:00.000Z',
      stableInstructions: 'Use transcript faithfully.',
      customContext: 'Custom repo context.',
      pinnedContext: 'Pinned interview context.',
      currentAction: 'Give me a concise answer to say next.',
    });

    assert.deepEqual(
      result.sections.map((section) => section.key),
      ['stable_instructions', 'custom_context', 'pinned_context', 'recent_transcript', 'current_action']
    );
    assert.equal(result.sections[1].content, 'Custom repo context.');
    assert.equal(result.sections[2].content, 'Pinned interview context.');
    assert.deepEqual(snapshot.chunks, beforeChunks);
  });

  test('full cached context includes short transcripts as a volatile recent tail', () => {
    const snapshot = seedBuffer().snapshot();

    const result = buildMeetingCopilotContext({
      mode: 'full_cached',
      snapshot,
      stableInstructions: 'Use transcript faithfully.',
      customContext: 'Custom repo context.',
      pinnedContext: 'Pinned interview context.',
      codeContext: 'Relevant code snippet context.',
      currentAction: 'Propose the best solution with tradeoffs.',
    });

    assert.deepEqual(
      result.sections.map((section) => section.key),
      [
        'stable_instructions',
        'custom_context',
        'pinned_context',
        'action_instructions',
        'recent_transcript',
        'code_context',
        'current_action',
      ]
    );

    assert.equal(result.sections[0].cache?.cacheable, true);
    assert.equal(result.sections[0].cache?.scope, 'metadata');
    assert.equal(result.sections[1].cache?.cacheable, true);
    assert.equal(result.sections[1].cache?.scope, 'metadata');
    assert.equal(result.sections[2].cache?.cacheable, true);
    assert.equal(result.sections[2].cache?.scope, 'metadata');
    assert.equal(result.sections[3].cache?.cacheable, true);
    assert.equal(result.sections[3].cache?.scope, 'metadata');
    assert.equal(result.sections[4].cache?.cacheable, false);
    assert.equal(result.sections[6].cache?.cacheable, false);
    assert.equal(result.sections[3].content, 'Propose the best solution with tradeoffs.');
    assert.equal(result.sections[6].content, 'Apply the action instructions to the current meeting context.');

    assert.match(result.sections[4].content, /^Kickoff and agenda/);
    assert.match(result.sections[4].content, /We should simplify the rollout path\./);
    assert.match(result.sections[4].content, /The main risk is migration complexity\./);
  });

  test('transcript formatting is compact and does not leak chunk metadata into the prompt', () => {
    const snapshot = {
      meeting_id: 'meeting-123',
      chunks: [
        {
          id: 'chunk:0001',
          meeting_id: 'meeting-123',
          start_ts: '2026-07-03T10:00:00.000Z',
          end_ts: '2026-07-03T10:00:00.000Z',
          text: '[ME]: First sentence.',
          source: 'mic',
        },
        {
          id: 'chunk:0002',
          meeting_id: 'meeting-123',
          start_ts: '2026-07-03T10:00:03.000Z',
          end_ts: '2026-07-03T10:00:03.000Z',
          text: '[ME]: Second sentence.',
          source: 'mic',
        },
        {
          id: 'chunk:0003',
          meeting_id: 'meeting-123',
          start_ts: '2026-07-03T10:00:06.000Z',
          end_ts: '2026-07-03T10:00:06.000Z',
          text: '[INTERVIEWER]: Follow-up question.',
          source: 'system',
        },
      ],
    };

    const result = buildMeetingCopilotContext({
      mode: 'recent',
      snapshot,
      contextMinutes: 10,
      now: '2026-07-03T10:01:00.000Z',
      stableInstructions: 'Use transcript faithfully.',
      customContext: '',
      pinnedContext: '',
      currentAction: 'Act.',
    });

    const transcript = result.sections.find((section) => section.key === 'recent_transcript')?.content ?? '';
    assert.equal(transcript, '[ME]: First sentence. Second sentence.\n[INTERVIEWER]: Follow-up question.');
    assert.doesNotMatch(transcript, /chunk:0001|start=|end=/);
  });

  test('default pinned context template is omitted from model context', () => {
    const result = buildMeetingCopilotContext({
      mode: 'full_cached',
      snapshot: seedBuffer().snapshot(),
      stableInstructions: 'Use transcript faithfully.',
      customContext: '',
      pinnedContext: DEFAULT_PINNED_CONTEXT_TEMPLATE,
      currentAction: 'Act.',
    });

    assert.equal(
      result.sections.some((section) => section.content.includes('Current problem:')),
      false,
      'empty pinned context template should not be sent to the model',
    );
  });

  test('full cached context keeps volatile recent transcript outside cacheable history', () => {
    const chunks = Array.from({ length: 16 }, (_, index) => ({
      id: `chunk:${String(index + 1).padStart(4, '0')}`,
      meeting_id: 'meeting-123',
      start_ts: `2026-07-03T10:${String(index).padStart(2, '0')}:00.000Z`,
      end_ts: `2026-07-03T10:${String(index).padStart(2, '0')}:00.000Z`,
      text: `[ME]: Turn ${index + 1}.`,
      source: 'mic',
    }));

    const result = buildMeetingCopilotContext({
      mode: 'full_cached',
      snapshot: { meeting_id: 'meeting-123', chunks },
      stableInstructions: 'Use transcript faithfully.',
      customContext: '',
      pinnedContext: '',
      currentAction: 'Act.',
    });

    const historySections = result.sections.filter((section) => section.key === 'meeting_transcript_so_far');
    const recentSection = result.sections.find((section) => section.key === 'recent_transcript');

    assert.ok(historySections.length >= 1);
    assert.equal(historySections.every((section) => section.cache?.cacheable === true), true);
    assert.equal(recentSection?.cache?.cacheable, false);
    assert.match(historySections.map((section) => section.content).join('\n'), /Turn 1\./);
    assert.doesNotMatch(historySections.map((section) => section.content).join('\n'), /Turn 16\./);
    assert.match(recentSection?.content ?? '', /Turn 16\./);

    const serialized = buildOpenRouterMessages({
      context: result,
      cachePolicy: 'anthropic_explicit_1h',
    });
    const cacheMarkedBlocks = serialized.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block.type === 'text' && block.cache_control);

    assert.ok(cacheMarkedBlocks.length >= 1);
    assert.ok(cacheMarkedBlocks.length <= 4, 'Anthropic cache-control supports a small bounded number of breakpoints');
  });

  test('full cached context marks action instructions as an explicit cache breakpoint', () => {
    const result = buildMeetingCopilotContext({
      mode: 'full_cached',
      snapshot: seedBuffer().snapshot(),
      stableInstructions: 'Use transcript faithfully.',
      customContext: '',
      pinnedContext: '',
      currentAction: 'Long stable action prompt that should be reused across repeated Guide Me calls.',
    });

    const serialized = buildOpenRouterMessages({
      context: result,
      cachePolicy: 'anthropic_explicit_1h',
    });
    const systemBlocks = Array.isArray(serialized.messages[0]?.content) ? serialized.messages[0].content : [];
    const actionBlock = systemBlocks.find(
      (block) =>
        block.type === 'text' &&
        block.text === 'Long stable action prompt that should be reused across repeated Guide Me calls.'
    );

    assert.equal(actionBlock?.cache_control?.ttl, '1h');
    assert.equal(serialized.messages[1]?.role, 'user');
    assert.equal(serialized.messages[1]?.content, 'Apply the action instructions to the current meeting context.');
  });

  test('freshness guidance stays non-cacheable and adjacent to current_action', () => {
    const snapshot = seedBuffer().snapshot();

    const result = buildMeetingCopilotContext({
      mode: 'full_cached',
      snapshot,
      stableInstructions: [
        'Use transcript faithfully.',
        'When model/provider/pricing/API/ranking/legal/news/current-event facts may have changed, verify with a current source before making confident claims.',
        'If verification is unavailable, say the claim is unverified or currentness-uncertain.',
        'Do not use private meeting transcript or private code as a web search query.',
      ].join('\n'),
      customContext: 'Custom repo context.',
      pinnedContext: 'Pinned interview context.',
      codeContext: 'Relevant code snippet context.',
      currentAction: 'Propose the best solution with tradeoffs.',
      freshnessGuidance:
        'This action may depend on current external facts. No freshness tool result is available, so mark those claims as unverified/currentness-uncertain.',
    });

    assert.deepEqual(
      result.sections.map((section) => section.key),
      [
        'stable_instructions',
        'custom_context',
        'pinned_context',
        'action_instructions',
        'recent_transcript',
        'code_context',
        'current_action',
        'current_action',
      ]
    );
    assert.match(result.sections[0].content, /Do not use private meeting transcript or private code as a web search query\./);
    assert.equal(result.sections[3].content, 'Propose the best solution with tradeoffs.');
    assert.equal(result.sections[3].cache?.cacheable, true);
    assert.equal(result.sections[6].content, 'Apply the action instructions to the current meeting context.');
    assert.equal(result.sections[6].cache?.cacheable, false);
    assert.match(result.sections[7].content, /current external facts/);
    assert.equal(result.sections[7].cache?.cacheable, false);
  });

  test('recent context includes action_history before current_action', () => {
    const snapshot = seedBuffer().snapshot();

    const result = buildMeetingCopilotContext({
      mode: 'recent',
      snapshot,
      contextMinutes: 2,
      now: '2026-07-03T10:10:00.000Z',
      stableInstructions: 'Use transcript faithfully.',
      customContext: '',
      pinnedContext: '',
      actionHistory: 'Guide Me: Use Postgres as the source of truth.',
      currentAction: 'Continue the next design phase.',
    });

    assert.deepEqual(
      result.sections.map((section) => section.key),
      ['stable_instructions', 'custom_context', 'pinned_context', 'recent_transcript', 'action_history', 'current_action']
    );
    assert.equal(result.sections[4].content, 'Guide Me: Use Postgres as the source of truth.');
  });

  test('full_cached context keeps action_history near the current action', () => {
    const snapshot = seedBuffer().snapshot();

    const result = buildMeetingCopilotContext({
      mode: 'full_cached',
      snapshot,
      stableInstructions: 'Use transcript faithfully.',
      customContext: '',
      pinnedContext: '',
      codeContext: '',
      actionHistory: 'Go Deeper: add a queue for async writes.',
      dynamicEvidenceContext: 'Board screenshot summary: API, queue, worker, Postgres.',
      currentAction: 'Refine the architecture phase.',
    });

    const actionInstructionsIndex = result.sections.findIndex((section) => section.key === 'action_instructions');
    const actionHistoryIndex = result.sections.findIndex((section) => section.key === 'action_history');
    const recentTranscriptIndex = result.sections.findIndex((section) => section.key === 'recent_transcript');
    const currentActionIndex = result.sections.findIndex((section) => section.key === 'current_action');

    assert.ok(actionInstructionsIndex >= 0);
    assert.ok(actionHistoryIndex > actionInstructionsIndex);
    assert.ok(recentTranscriptIndex > actionHistoryIndex);
    assert.ok(currentActionIndex > recentTranscriptIndex);
    assert.equal(result.sections[actionInstructionsIndex].cache?.cacheable, true);
    assert.equal(result.sections[actionHistoryIndex].cache?.cacheable, true);
    assert.equal(result.sections.at(-1)?.key, 'current_action');
  });

  test('full_cached context keeps action history entries as separate cacheable blocks', () => {
    const snapshot = seedBuffer().snapshot();

    const result = buildMeetingCopilotContext({
      mode: 'full_cached',
      snapshot,
      stableInstructions: 'Use transcript faithfully.',
      customContext: '',
      pinnedContext: '',
      codeContext: '',
      actionHistory: 'Guide Me\nFirst full response.\n\nGo Deeper\nSecond full response.',
      actionHistoryEntries: [
        'Guide Me\nFirst full response.',
        'Go Deeper\nSecond full response.',
      ],
      currentAction: 'Continue.',
    });

    const actionHistorySections = result.sections.filter((section) => section.key === 'action_history');
    assert.equal(actionHistorySections.length, 2);
    assert.equal(actionHistorySections[0].content, 'Guide Me\nFirst full response.');
    assert.equal(actionHistorySections[1].content, 'Go Deeper\nSecond full response.');
    assert.equal(actionHistorySections.every((section) => section.cache?.cacheable === true), true);

    const serialized = buildOpenRouterMessages({
      context: result,
      cachePolicy: 'anthropic_explicit_1h',
    });
    const systemBlocks = Array.isArray(serialized.messages[0]?.content) ? serialized.messages[0].content : [];
    const cachedHistoryBlocks = systemBlocks.filter(
      (block) => block.type === 'text' && /^Guide Me|^Go Deeper/.test(block.text)
    );
    assert.equal(cachedHistoryBlocks.length, 2);
    assert.equal(cachedHistoryBlocks.every((block) => block.cache_control?.ttl === '1h'), true);
  });
});
