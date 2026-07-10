#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist-electron/electron/meeting-copilot');

function usage() {
  return [
    'Usage:',
    '  npm run eval:meeting-copilot -- --action guide-me --transcript ./transcript.txt [--screenshot ./board.png]',
    '',
    'Options:',
    '  --action <guide-me|go-deeper>       Meeting Copilot action to run. Default: guide-me',
    '  --transcript <path>                 Transcript text file. Required.',
    '  --screenshot <path>                 Optional screenshot/image path. Can be repeated.',
    '  --model <openrouter-model>          Optional model override.',
    '  --pinned-context <path>             Optional pinned-context text file.',
    '  --action-history <path>             Optional prior action history text file.',
    '  --dry-run                           Print assembled OpenRouter messages without calling the model.',
    '  --out <path>                        Output markdown path. Default: tmp/meeting-copilot-evals/<timestamp>.md',
    '  --help                              Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    action: 'guide-me',
    screenshots: [],
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
    } else if (arg === '--action') {
      args.action = next();
    } else if (arg === '--transcript') {
      args.transcript = next();
    } else if (arg === '--screenshot' || arg === '--image') {
      args.screenshots.push(next());
    } else if (arg === '--model') {
      args.model = next();
    } else if (arg === '--pinned-context') {
      args.pinnedContext = next();
    } else if (arg === '--action-history') {
      args.actionHistory = next();
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--out') {
      args.out = next();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function importDist(moduleName) {
  return import(pathToFileURL(path.join(distRoot, moduleName)).href);
}

async function readOptionalText(filePath) {
  if (!filePath) return '';
  return fs.readFile(path.resolve(repoRoot, filePath), 'utf8');
}

function imageMimeTypeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

async function buildImageBlocks(imagePaths) {
  const blocks = [];
  for (const imagePath of imagePaths.slice(0, 5)) {
    const absolutePath = path.resolve(repoRoot, imagePath);
    const data = await fs.readFile(absolutePath);
    blocks.push({
      type: 'image_url',
      image_url: {
        url: `data:${imageMimeTypeFromPath(absolutePath)};base64,${data.toString('base64')}`,
      },
    });
  }
  return blocks;
}

function appendImageBlocksToMessages(messages, imageBlocks) {
  if (imageBlocks.length === 0) return messages;

  const nextMessages = messages.map((message) => ({ ...message }));
  let lastUserIndex = -1;
  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    if (nextMessages[index].role === 'user') {
      lastUserIndex = index;
      break;
    }
  }

  if (lastUserIndex === -1) {
    nextMessages.push({ role: 'user', content: imageBlocks });
    return nextMessages;
  }

  const userMessage = nextMessages[lastUserIndex];
  const existingContent = userMessage.content;
  const content = Array.isArray(existingContent)
    ? [...existingContent, ...imageBlocks]
    : typeof existingContent === 'string' && existingContent.trim().length > 0
      ? [{ type: 'text', text: existingContent }, ...imageBlocks]
      : [...imageBlocks];

  nextMessages[lastUserIndex] = { ...userMessage, content };
  return nextMessages;
}

function createSnapshot(transcriptText) {
  const now = new Date().toISOString();
  return {
    meeting_id: `manual-eval-${Date.now()}`,
    chunks: transcriptText.trim().length > 0
      ? [
          {
            id: 'chunk-0001',
            meeting_id: 'manual-eval',
            start_ts: now,
            end_ts: now,
            text: transcriptText,
            source: 'mixed',
          },
        ]
      : [],
  };
}

function redactImageData(messages) {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type !== 'image_url') return block;
        return {
          type: 'image_url',
          image_url: {
            url: `${block.image_url.url.slice(0, 80)}...<base64 omitted>`,
          },
        };
      }),
    };
  });
}

async function writeOutput(filePath, content) {
  const absolutePath = path.resolve(repoRoot, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf8');
  return absolutePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (!args.transcript) {
    throw new Error(`--transcript is required\n\n${usage()}`);
  }
  if (!['guide-me', 'go-deeper'].includes(args.action)) {
    throw new Error('--action must be guide-me or go-deeper');
  }

  const [
    { getDefaultMeetingCopilotConfig, getMeetingCopilotStableInstructions },
    { buildMeetingCopilotContext },
    { buildOpenRouterMessages },
    { OpenRouterClient },
  ] = await Promise.all([
    importDist('defaultActionConfig.js'),
    importDist('ContextBuilder.js'),
    importDist('PromptCache.js'),
    importDist('OpenRouterClient.js'),
  ]);

  const config = getDefaultMeetingCopilotConfig('system-design-interview');
  const action = config.actions[args.action];
  if (!action || 'parallel' in action) {
    throw new Error(`Action ${args.action} is not available as a single system-design action`);
  }

  const transcript = await readOptionalText(args.transcript);
  const pinnedContext = await readOptionalText(args.pinnedContext);
  const actionHistory = await readOptionalText(args.actionHistory);
  const snapshot = createSnapshot(transcript);
  const branchConfig = {
    ...action,
    model: args.model ?? action.model,
  };

  const context = buildMeetingCopilotContext({
    mode: branchConfig.context_mode,
    snapshot,
    stableInstructions: getMeetingCopilotStableInstructions(config),
    customContext: '',
    projectDocsContext: '',
    pinnedContext,
    actionHistory,
    currentAction: branchConfig.prompt,
    contextMinutes: branchConfig.context_minutes,
    now: snapshot.chunks[snapshot.chunks.length - 1]?.end_ts ?? new Date().toISOString(),
    codeContext: '',
  });

  const serialized = buildOpenRouterMessages({
    context,
    cachePolicy: branchConfig.cache_policy,
  });
  const imageBlocks = await buildImageBlocks(args.screenshots);
  const messages = appendImageBlocksToMessages(serialized.messages, imageBlocks);

  const defaultOut = path.join(
    'tmp',
    'meeting-copilot-evals',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.action}.md`,
  );
  const outPath = args.out ?? defaultOut;

  if (args.dryRun) {
    const dryRunText = JSON.stringify(redactImageData(messages), null, 2);
    const savedPath = await writeOutput(outPath, dryRunText);
    console.log(dryRunText);
    console.error(`\nDry-run messages written to ${savedPath}`);
    return;
  }

  const client = new OpenRouterClient({ config: config.openrouter });
  const result = await client.createChatCompletion({
    model: branchConfig.model,
    messages,
    max_tokens: branchConfig.max_tokens,
    temperature: branchConfig.temperature,
    stream: false,
    reasoning: branchConfig.reasoning,
    session_id: `manual-eval-${args.action}-${Date.now()}`,
  });

  const output = [
    `# Meeting Copilot Eval`,
    '',
    `- action: ${args.action}`,
    `- model: ${branchConfig.model}`,
    `- transcript: ${path.resolve(repoRoot, args.transcript)}`,
    `- screenshots: ${args.screenshots.map((p) => path.resolve(repoRoot, p)).join(', ') || '(none)'}`,
    '',
    '## Response',
    '',
    result.content.trim(),
    '',
    '## Usage',
    '',
    '```json',
    JSON.stringify(result.usage ?? result.metrics ?? {}, null, 2),
    '```',
    '',
  ].join('\n');

  const savedPath = await writeOutput(outPath, output);
  console.log(result.content.trim());
  console.error(`\nEval output written to ${savedPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
