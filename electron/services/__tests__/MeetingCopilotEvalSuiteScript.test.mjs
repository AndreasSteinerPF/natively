import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

test('meeting-copilot eval suite dry-run loads cases and models without calling the provider', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-copilot-eval-suite-'));
  const caseDir = path.join(tempDir, 'case-a');
  const outDir = path.join(tempDir, 'out');
  const casesPath = path.join(tempDir, 'cases.json');

  try {
    await fs.mkdir(caseDir, { recursive: true });
    await fs.writeFile(path.join(caseDir, 'transcript.txt'), '[INTERVIEWER]: Design a queue.', 'utf8');
    await fs.writeFile(
      casesPath,
      JSON.stringify(
        {
          cases: [
            {
              id: 'case-a',
              action: 'guide-me',
              transcript: 'case-a/transcript.txt',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        'scripts/meeting-copilot-eval-suite.mjs',
        '--dry-run',
        '--cases',
        casesPath,
        '--models',
        'model-a,model-b',
        '--out-dir',
        outDir,
      ],
      { cwd: repoRoot, maxBuffer: 2_000_000 },
    );

    assert.match(stdout, /case-a/);
    assert.match(stdout, /model-a/);
    assert.match(stdout, /model-b/);
    assert.match(stdout, /completed 2 runs/i);

    const files = await fs.readdir(outDir);
    assert.equal(files.length, 2);
    assert.equal(files.some((file) => file.includes('model-a')), true);
    assert.equal(files.some((file) => file.includes('model-b')), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
