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
    assert.match(
      result.sections[3].content,
      /\[chunk:0002 start=2026-07-03T10:08:00.000Z end=2026-07-03T10:08:20.000Z\]\nWe should simplify the rollout path\./
    );
    assert.match(
      result.sections[3].content,
      /\[chunk:0003 start=2026-07-03T10:09:10.000Z end=2026-07-03T10:09:30.000Z\]\nThe main risk is migration complexity\./
    );
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

  test('full cached context includes all transcript chunks in stable order with cacheable metadata markers', () => {
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
        'meeting_transcript_so_far',
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
    assert.equal(result.sections[3].cache?.scope, 'data');
    assert.equal(result.sections[4].cache?.cacheable, false);
    assert.equal(result.sections[5].cache?.cacheable, false);

    assert.match(
      result.sections[3].content,
      /^\[chunk:0001 start=2026-07-03T10:00:00.000Z end=2026-07-03T10:00:20.000Z\]\nKickoff and agenda/
    );
    assert.match(result.sections[3].content, /\n\n\[chunk:0002 start=2026-07-03T10:08:00.000Z end=2026-07-03T10:08:20.000Z\]\n/);
    assert.match(result.sections[3].content, /\n\n\[chunk:0003 start=2026-07-03T10:09:10.000Z end=2026-07-03T10:09:30.000Z\]\n/);
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
        'meeting_transcript_so_far',
        'code_context',
        'current_action',
        'current_action',
      ]
    );
    assert.match(result.sections[0].content, /Do not use private meeting transcript or private code as a web search query\./);
    assert.equal(result.sections[5].content, 'Propose the best solution with tradeoffs.');
    assert.match(result.sections[6].content, /current external facts/);
    assert.equal(result.sections[6].cache?.cacheable, false);
  });
});
