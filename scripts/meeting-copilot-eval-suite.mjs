#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_CASES_PATH = 'test-fixtures/meeting-copilot-evals/system-design/cases.json';
const DEFAULT_MODELS = [
  'google/gemini-3.5-flash',
  'anthropic/claude-fable-5',
];

function usage() {
  return [
    'Usage:',
    '  npm run eval:meeting-copilot:suite -- [--models model-a,model-b] [--dry-run]',
    '',
    'Options:',
    `  --cases <path>       Case manifest. Default: ${DEFAULT_CASES_PATH}`,
    '  --case <id>          Run one case id only. Can be repeated.',
    '  --models <csv>       Comma-separated OpenRouter model slugs.',
    '  --dry-run            Assemble messages only; do not call the model.',
    '  --out-dir <path>     Output directory. Default: tmp/meeting-copilot-evals/suite-<timestamp>',
    '  --help               Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    cases: DEFAULT_CASES_PATH,
    caseIds: [],
    models: DEFAULT_MODELS,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--cases') {
      args.cases = next();
    } else if (arg === '--case') {
      args.caseIds.push(next());
    } else if (arg === '--models') {
      args.models = next().split(',').map((model) => model.trim()).filter(Boolean);
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--out-dir') {
      args.outDir = next();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function readManifest(casesPath) {
  const absolutePath = path.resolve(repoRoot, casesPath);
  const raw = await fs.readFile(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.cases)) {
    throw new Error(`Case manifest must contain a cases array: ${absolutePath}`);
  }
  return {
    baseDir: path.dirname(absolutePath),
    cases: parsed.cases,
  };
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

function resolveCasePath(baseDir, filePath) {
  if (!filePath) return undefined;
  return path.isAbsolute(filePath) ? filePath : path.join(baseDir, filePath);
}

async function runSingle(input) {
  const args = [
    'scripts/meeting-copilot-eval.mjs',
    '--action',
    input.caseDef.action ?? 'guide-me',
    '--transcript',
    resolveCasePath(input.baseDir, input.caseDef.transcript),
    '--model',
    input.model,
    '--out',
    input.outPath,
  ];

  for (const screenshot of input.caseDef.screenshots ?? []) {
    args.push('--screenshot', resolveCasePath(input.baseDir, screenshot));
  }
  if (input.caseDef.pinnedContext) {
    args.push('--pinned-context', resolveCasePath(input.baseDir, input.caseDef.pinnedContext));
  }
  if (input.caseDef.actionHistory) {
    args.push('--action-history', resolveCasePath(input.baseDir, input.caseDef.actionHistory));
  }
  if (input.dryRun) {
    args.push('--dry-run');
  }

  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd: repoRoot,
    maxBuffer: 10_000_000,
  });

  return { stdout, stderr };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.models.length === 0) {
    throw new Error('--models must include at least one model');
  }

  const { baseDir, cases } = await readManifest(args.cases);
  const selectedCaseIds = new Set(args.caseIds);
  const selectedCases = selectedCaseIds.size === 0
    ? cases
    : cases.filter((caseDef) => selectedCaseIds.has(caseDef.id));

  if (selectedCases.length === 0) {
    throw new Error('No eval cases selected');
  }

  const outDir = path.resolve(
    repoRoot,
    args.outDir ?? path.join('tmp', 'meeting-copilot-evals', `suite-${new Date().toISOString().replace(/[:.]/g, '-')}`),
  );
  await fs.mkdir(outDir, { recursive: true });

  let completed = 0;
  for (const caseDef of selectedCases) {
    if (!caseDef.id || !caseDef.transcript) {
      throw new Error('Each case must include id and transcript');
    }

    for (const model of args.models) {
      const outPath = path.join(outDir, `${safeName(caseDef.id)}__${safeName(model)}${args.dryRun ? '.json' : '.md'}`);
      process.stdout.write(`[${completed + 1}] ${caseDef.id} :: ${model} ... `);
      await runSingle({
        baseDir,
        caseDef,
        model,
        outPath,
        dryRun: args.dryRun,
      });
      completed += 1;
      process.stdout.write(`written ${path.relative(repoRoot, outPath)}\n`);
    }
  }

  console.log(`Completed ${completed} runs. Output directory: ${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
