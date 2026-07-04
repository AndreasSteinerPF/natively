import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const { buildTranscriptSnapshot } = await import(
  pathToFileURL(path.join(distRoot, 'TranscriptBridge.js')).href
);

const T1 = Date.UTC(2026, 6, 4, 10, 0, 0);
const T2 = Date.UTC(2026, 6, 4, 10, 0, 5);
const T3 = Date.UTC(2026, 6, 4, 10, 0, 10);

describe('buildTranscriptSnapshot', () => {
  test('filters out assistant-speaker segments', () => {
    const result = buildTranscriptSnapshot({
      meetingId: 'meeting-1',
      maxTotalChars: 10_000,
      segments: [
        { speaker: 'user', text: 'What do you think about the rollout plan?', timestamp: T1 },
        { speaker: 'assistant', text: 'Previous AI suggestion text', timestamp: T2 },
        { speaker: 'system', text: 'It should ship next week.', timestamp: T3 },
      ],
    });

    assert.equal(result.chunks.length, 2);
    assert.ok(result.chunks.every((chunk) => !chunk.text.includes('Previous AI suggestion')));
  });

  test('maps speaker to role label and source, converts timestamp to ISO', () => {
    const result = buildTranscriptSnapshot({
      meetingId: 'meeting-1',
      maxTotalChars: 10_000,
      segments: [
        { speaker: 'user', text: 'My question.', timestamp: T1 },
        { speaker: 'system', text: 'Their answer.', timestamp: T2 },
      ],
    });

    assert.equal(result.chunks[0].text, '[ME]: My question.');
    assert.equal(result.chunks[0].source, 'mic');
    assert.equal(result.chunks[0].start_ts, new Date(T1).toISOString());
    assert.equal(result.chunks[0].end_ts, new Date(T1).toISOString());
    assert.equal(result.chunks[0].meeting_id, 'meeting-1');

    assert.equal(result.chunks[1].text, '[INTERVIEWER]: Their answer.');
    assert.equal(result.chunks[1].source, 'system');
  });

  test('caps to the most recent contiguous chunks, dropping oldest first', () => {
    const result = buildTranscriptSnapshot({
      meetingId: 'meeting-1',
      maxTotalChars: 20,
      segments: [
        { speaker: 'user', text: 'first message here', timestamp: T1 },
        { speaker: 'user', text: 'second', timestamp: T2 },
      ],
    });

    assert.equal(result.chunks.length, 1);
    assert.equal(result.chunks[0].text, '[ME]: second');
  });

  test('returns an empty snapshot for no segments, without throwing', () => {
    const result = buildTranscriptSnapshot({
      meetingId: 'meeting-1',
      maxTotalChars: 10_000,
      segments: [],
    });

    assert.deepEqual(result, { meeting_id: 'meeting-1', chunks: [] });
  });

  test('drops a single chunk entirely if it alone exceeds maxTotalChars', () => {
    const result = buildTranscriptSnapshot({
      meetingId: 'meeting-1',
      maxTotalChars: 5,
      segments: [{ speaker: 'user', text: 'this message is too long to fit', timestamp: T1 }],
    });

    assert.deepEqual(result.chunks, []);
  });
});
