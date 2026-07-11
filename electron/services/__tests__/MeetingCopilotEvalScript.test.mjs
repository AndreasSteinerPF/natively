import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

test('meeting-copilot eval script dry-run assembles transcript and screenshot messages', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-copilot-eval-'));
  const transcriptPath = path.join(tempDir, 'transcript.txt');
  const screenshotPath = path.join(tempDir, 'screenshot.png');
  const outPath = path.join(tempDir, 'messages.json');

  try {
    await fs.writeFile(
      transcriptPath,
      '[INTERVIEWER]: Design a smart-meter ingestion system.\n[ME]: I am starting with requirements.',
      'utf8',
    );
    await fs.writeFile(
      screenshotPath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l6M7qgAAAABJRU5ErkJggg==',
        'base64',
      ),
    );

    await execFileAsync(
      process.execPath,
      [
        'scripts/meeting-copilot-eval.mjs',
        '--dry-run',
        '--action',
        'guide-me',
        '--transcript',
        transcriptPath,
        '--screenshot',
        screenshotPath,
        '--out',
        outPath,
      ],
      { cwd: repoRoot, maxBuffer: 2_000_000 },
    );

    const saved = await fs.readFile(outPath, 'utf8');
    assert.match(saved, /Design a smart-meter ingestion system/);
    assert.match(saved, /Guide one complete design phase/);
    assert.match(saved, /image_url/);
    assert.match(saved, /<base64 omitted>/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('meeting-copilot eval script dry-run supports system-design quick-answer', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-copilot-eval-quick-'));
  const transcriptPath = path.join(tempDir, 'transcript.txt');
  const outPath = path.join(tempDir, 'messages.json');

  try {
    await fs.writeFile(
      transcriptPath,
      '[INTERVIEWER]: What eviction policy would you use for this cache?',
      'utf8',
    );

    await execFileAsync(
      process.execPath,
      [
        'scripts/meeting-copilot-eval.mjs',
        '--dry-run',
        '--action',
        'quick-answer',
        '--transcript',
        transcriptPath,
        '--out',
        outPath,
      ],
      { cwd: repoRoot, maxBuffer: 2_000_000 },
    );

    const saved = await fs.readFile(outPath, 'utf8');
    assert.match(saved, /What eviction policy would you use/);
    assert.match(saved, /answer the INTERVIEWER's pending question directly/i);
    assert.match(saved, /Do not advance the system design phase/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
