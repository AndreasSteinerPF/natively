#!/usr/bin/env node

const DEFAULT_MODEL = 'anthropic/claude-fable-5';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

function usage() {
  return [
    'Usage:',
    '  npm run probe:openrouter-cache',
    '',
    'Options:',
    '  --model <openrouter-model>          Default: anthropic/claude-fable-5',
    '  --base-url <url>                    Default: https://openrouter.ai/api/v1',
    '  --ttl <5m|1h>                       Default: 1h',
    '  --calls <n>                         Default: 2',
    '  --wait-ms <n>                       Default: 2000',
    '  --stable-lines <n>                  Default: 1400',
    '  --stable-id <id>                    Default: fresh timestamp id; use a fixed value to test cross-run reuse',
    '  --include-explicit-breakpoint       Also put cache_control on the large text block',
    '  --help                             Show this help',
    '',
    'Environment:',
    '  OPENROUTER_API_KEY must be set.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    ttl: '1h',
    calls: 2,
    waitMs: 2000,
    stableLines: 1400,
    stableId: `fresh-${Date.now()}`,
    includeExplicitBreakpoint: false,
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
    } else if (arg === '--model') {
      args.model = next();
    } else if (arg === '--base-url') {
      args.baseUrl = next();
    } else if (arg === '--ttl') {
      args.ttl = next();
    } else if (arg === '--calls') {
      args.calls = Number.parseInt(next(), 10);
    } else if (arg === '--wait-ms') {
      args.waitMs = Number.parseInt(next(), 10);
    } else if (arg === '--stable-lines') {
      args.stableLines = Number.parseInt(next(), 10);
    } else if (arg === '--stable-id') {
      args.stableId = next();
    } else if (arg === '--include-explicit-breakpoint') {
      args.includeExplicitBreakpoint = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.ttl !== '5m' && args.ttl !== '1h') {
    throw new Error('--ttl must be 5m or 1h');
  }
  if (!Number.isInteger(args.calls) || args.calls < 2) {
    throw new Error('--calls must be an integer >= 2');
  }
  if (!Number.isInteger(args.waitMs) || args.waitMs < 0) {
    throw new Error('--wait-ms must be an integer >= 0');
  }
  if (!Number.isInteger(args.stableLines) || args.stableLines < 1) {
    throw new Error('--stable-lines must be an integer >= 1');
  }

  return args;
}

function cacheControl(ttl) {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

function stableText(lineCount, stableId) {
  return Array.from({ length: lineCount }, (_, index) =>
    [
      `Stable cache probe id: ${stableId}.`,
      `Stable cache probe line ${index}.`,
      'Domain: smart meter ingestion.',
      'Concepts: idempotency, late arrivals, corrections, tariffs, raw audit log, aggregation, dashboard cache, reprocessing.',
      'This content is intentionally repeated to exceed Anthropic prompt-cache minimum token thresholds.',
    ].join(' ')
  ).join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatUsage(usage) {
  const details = usage?.prompt_tokens_details ?? {};
  return {
    prompt_tokens: usage?.prompt_tokens,
    completion_tokens: usage?.completion_tokens,
    total_tokens: usage?.total_tokens,
    cached_tokens: details.cached_tokens,
    cache_write_tokens: details.cache_write_tokens,
  };
}

async function callOpenRouter(input) {
  const largeBlock = {
    type: 'text',
    text: input.stable,
  };
  if (input.includeExplicitBreakpoint) {
    largeBlock.cache_control = input.cacheControl;
  }

  const response = await fetch(`${input.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      session_id: input.sessionId,
      cache_control: input.cacheControl,
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'You are a concise prompt-cache probe assistant. Reply exactly as requested.' },
            largeBlock,
          ],
        },
        {
          role: 'user',
          content: `Probe call ${input.callNumber}: answer with only OK ${input.callNumber}.`,
        },
      ],
      temperature: 0,
      max_tokens: 8,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? JSON.stringify(body);
    throw new Error(`OpenRouter ${response.status}: ${message}`);
  }

  return body;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  const sessionId = `natively-cache-probe-${Date.now()}`;
  const control = cacheControl(args.ttl);
  const stable = stableText(args.stableLines, args.stableId);
  const results = [];

  console.log('OpenRouter cache probe');
  console.log(`model: ${args.model}`);
  console.log(`session_id: ${sessionId}`);
  console.log(`top_level_cache_control: ${JSON.stringify(control)}`);
  console.log(`explicit_breakpoint: ${args.includeExplicitBreakpoint ? 'yes' : 'no'}`);
  console.log(`stable_id: ${args.stableId}`);
  console.log(`stable_chars: ${stable.length}`);
  console.log('');

  for (let callNumber = 1; callNumber <= args.calls; callNumber += 1) {
    const startedAt = Date.now();
    const body = await callOpenRouter({
      apiKey,
      baseUrl: args.baseUrl,
      model: args.model,
      sessionId,
      cacheControl: control,
      stable,
      includeExplicitBreakpoint: args.includeExplicitBreakpoint,
      callNumber,
    });
    const elapsedMs = Date.now() - startedAt;
    const usage = formatUsage(body.usage);
    results.push({ callNumber, elapsedMs, usage });

    console.log(`call ${callNumber}:`);
    console.log(`  text: ${(body.choices?.[0]?.message?.content ?? '').trim()}`);
    console.log(`  latency_ms: ${elapsedMs}`);
    console.log(`  usage: ${JSON.stringify(usage)}`);

    if (callNumber < args.calls && args.waitMs > 0) {
      await sleep(args.waitMs);
    }
  }

  const first = results[0]?.usage ?? {};
  const later = results.slice(1);
  const firstWrite = numberOrZero(first.cache_write_tokens);
  const laterCached = later.reduce((sum, result) => sum + numberOrZero(result.usage.cached_tokens), 0);

  console.log('');
  if (laterCached > 0) {
    console.log(`PASS: later calls read ${laterCached} cached tokens.`);
    return;
  }
  if (firstWrite > 0) {
    console.log(`FAIL: first call wrote ${firstWrite} cache tokens, but later calls read 0 cached tokens.`);
    process.exitCode = 2;
    return;
  }

  console.log('FAIL: OpenRouter reported 0 cache_write_tokens and 0 cached_tokens.');
  console.log('This usually means the model/provider did not cache this request shape, or the prompt was below provider thresholds.');
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
