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

    const { stdout, stderr } = await execFileAsync(
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

    assert.match(stdout, /Design a smart-meter ingestion system/);
    assert.match(stdout, /Guide one complete design phase/);
    assert.match(stdout, /image_url/);
    assert.match(stdout, /<base64 omitted>/);
    assert.match(stderr, /Dry-run messages written to/);

    const saved = await fs.readFile(outPath, 'utf8');
    assert.match(saved, /Design a smart-meter ingestion system/);
    assert.match(saved, /image_url/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
