import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const { ReviewLogStore } = await import(
  pathToFileURL(path.join(distRoot, 'ReviewLogStore.js')).href
);

describe('meeting-copilot review log store', () => {
  test('writes action review entries as per-meeting JSONL', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-copilot-review-log-'));
    const store = new ReviewLogStore({
      baseDir,
      now: () => new Date('2026-07-11T11:20:00.000Z'),
    });

    store.record({
      type: 'action_completed',
      meeting_id: 'meeting/demo:1',
      run_id: 'run-001',
      action_id: 'quick-answer',
      branch: 'single',
      final_text: 'Use LRU with TTL.',
      transcript_snapshot: {
        meeting_id: 'meeting/demo:1',
        chunks: [
          {
            id: 'chunk:0001',
            meeting_id: 'meeting/demo:1',
            start_ts: 0,
            end_ts: 1000,
            text: '[INTERVIEWER]: What eviction policy?',
            source: 'meeting',
          },
        ],
      },
      action_history_before: 'Guide Me\nStep: ADVANCE',
      image_paths: ['/tmp/board.png'],
      metrics: {
        total_tokens: 42,
      },
    });

    const files = fs.readdirSync(baseDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^meeting_demo_1\.jsonl$/);

    const lines = fs.readFileSync(path.join(baseDir, files[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.logged_at, '2026-07-11T11:20:00.000Z');
    assert.equal(parsed.final_text, 'Use LRU with TTL.');
    assert.equal(parsed.transcript_snapshot.chunks[0].text, '[INTERVIEWER]: What eviction policy?');
    assert.equal(parsed.metrics.total_tokens, 42);
  });
});
