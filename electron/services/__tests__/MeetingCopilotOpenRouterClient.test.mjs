import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const { buildMeetingCopilotContext } = await import(
  pathToFileURL(path.join(distRoot, 'ContextBuilder.js')).href
);
const { buildOpenRouterMessages, cacheControlForPolicy, shouldRetryWithoutCacheControl } = await import(
  pathToFileURL(path.join(distRoot, 'PromptCache.js')).href
);
const { OpenRouterClient } = await import(pathToFileURL(path.join(distRoot, 'OpenRouterClient.js')).href);

const TEST_OPENROUTER_ENV = 'TEST_OPENROUTER_API_KEY';
process.env[TEST_OPENROUTER_ENV] = 'test-openrouter-key';

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

function sseResponse(lines) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collectStream(generator) {
  const tokens = [];
  let final;
  for await (const event of generator) {
    if (event?.type === 'token') tokens.push(event.token);
    if (event?.type === 'done') final = event.result;
  }
  return { tokens, final };
}

describe('meeting-copilot openrouter transport', () => {
  test('compiled meeting-copilot transport modules export the prompt cache and client primitives', async () => {
    assert.equal(typeof buildOpenRouterMessages, 'function');
    assert.equal(typeof cacheControlForPolicy, 'function');
    assert.equal(typeof shouldRetryWithoutCacheControl, 'function');
    assert.equal(typeof OpenRouterClient, 'function');
  });

  test('full_cached context serializes cacheable blocks with Anthropic cache_control and leaves dynamic sections uncached', () => {
    const snapshot = {
      meeting_id: 'meeting-123',
      chunks: [
        {
          id: 'chunk:0001',
          meeting_id: 'meeting-123',
          start_ts: '2026-07-03T10:00:00.000Z',
          end_ts: '2026-07-03T10:00:30.000Z',
          text: 'Transcript body',
        },
      ],
    };

    const context = buildMeetingCopilotContext({
      mode: 'full_cached',
      snapshot,
      stableInstructions: 'Stable',
      customContext: 'Custom',
      pinnedContext: 'Pinned',
      codeContext: 'Code',
      currentAction: 'Act now',
    });

    const serialized = buildOpenRouterMessages({
      context,
      cachePolicy: 'anthropic_explicit_1h',
    });

    assert.equal(serialized.messages[0].role, 'system');
    assert.equal(serialized.messages[0].content.length, 4);
    assert.match(serialized.messages[0].content[0].text, /^Stable/);
    assert.match(
      serialized.messages[0].content[0].text,
      /Do not use private meeting transcript or private code as a web search query\./
    );
    assert.equal(serialized.messages[0].content[0].cache_control.ttl, '1h');
    assert.equal(serialized.messages[0].content[1].text, 'Custom');
    assert.equal(serialized.messages[0].content[1].cache_control.ttl, '1h');
    assert.equal(serialized.messages[0].content[2].text, 'Pinned');
    assert.equal(serialized.messages[0].content[2].cache_control.ttl, '1h');
    assert.match(serialized.messages[0].content[3].text, /Transcript body/);
    assert.equal(serialized.messages[0].content[3].cache_control, undefined);
    assert.equal(serialized.messages[1].role, 'user');
    assert.equal(Array.isArray(serialized.messages[1].content), true);
    assert.equal(serialized.messages[1].content.length, 2);
    assert.equal(serialized.messages[1].content[0].text, 'Code');
    assert.equal(serialized.messages[1].content[0].cache_control, undefined);
    assert.equal(serialized.messages[1].content[1].text, 'Act now');
    assert.equal(serialized.messages[1].content[1].cache_control, undefined);
  });

  test('cache policy mapping returns the expected Anthropic cache-control shapes', () => {
    assert.equal(cacheControlForPolicy('none'), undefined);
    assert.deepEqual(cacheControlForPolicy('anthropic_explicit_5m'), { type: 'ephemeral' });
    assert.deepEqual(cacheControlForPolicy('anthropic_explicit_1h'), { type: 'ephemeral', ttl: '1h' });
  });

  test('cache-control rejection logic retries only for 400/422 provider messages that mention cache_control', () => {
    assert.equal(
      shouldRetryWithoutCacheControl({ status: 400, message: 'invalid cache_control formatting' }),
      true
    );
    assert.equal(
      shouldRetryWithoutCacheControl({ status: 422, message: 'cache-control is unsupported' }),
      true
    );
    assert.equal(
      shouldRetryWithoutCacheControl({ status: 401, message: 'cache_control formatting rejected' }),
      false
    );
  });

  test('non-streaming chat posts to /chat/completions with headers, model, messages, max_tokens, temperature, stream:false, reasoning, and session_id', async () => {
    const fetchCalls = [];
    const client = new OpenRouterClient({
      config: {
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: TEST_OPENROUTER_ENV,
        default_headers: { 'HTTP-Referer': 'https://localhost/natively-private' },
      },
      fetch: async (url, init) => {
        fetchCalls.push({ url, init });
        return jsonResponse({
          choices: [{ message: { content: 'Hello there' } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
          },
        });
      },
    });

    const result = await client.createChatCompletion({
      model: 'anthropic/claude-opus-4.8-fast',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 123,
      temperature: 0.2,
      stream: false,
      reasoning: { effort: 'low' },
      session_id: 'session-123',
    });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(fetchCalls[0].init.method, 'POST');
    assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer test-openrouter-key');
    assert.equal(fetchCalls[0].init.headers['Content-Type'], 'application/json');
    assert.equal(fetchCalls[0].init.headers['HTTP-Referer'], 'https://localhost/natively-private');
    assert.equal(JSON.parse(fetchCalls[0].init.body).stream, false);
    assert.equal(JSON.parse(fetchCalls[0].init.body).reasoning.effort, 'low');
    assert.equal(JSON.parse(fetchCalls[0].init.body).session_id, 'session-123');
    assert.equal(result.content, 'Hello there');
    assert.equal(result.metrics.cached_tokens, 3);
    assert.equal(result.metrics.cache_write_tokens, 1);
  });

  test('non-streaming chat preserves tool serialization, tool_choice auto, reasoning, and tool_calls in the result', async () => {
    const fetchCalls = [];
    const client = new OpenRouterClient({
      config: {
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: TEST_OPENROUTER_ENV,
      },
      fetch: async (url, init) => {
        fetchCalls.push({ url, init });
        return jsonResponse({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'search_repo',
                      arguments: '{"query":"ToolLoop"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
      },
    });

    const result = await client.createChatCompletion({
      model: 'anthropic/claude-opus-4.8-fast',
      messages: [{ role: 'user', content: 'Inspect the code' }],
      max_tokens: 64,
      temperature: 0.1,
      stream: false,
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_repo',
            description: 'Search the repo.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        },
      ],
      tool_choice: 'auto',
      reasoning: { effort: 'medium' },
    });

    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body).tools?.[0].function.name, 'search_repo');
    assert.equal(JSON.parse(fetchCalls[0].init.body).tool_choice, 'auto');
    assert.equal(JSON.parse(fetchCalls[0].init.body).reasoning.effort, 'medium');
    assert.deepEqual(result.tool_calls?.[0].function.name, 'search_repo');
  });

  test('streaming chat sets stream:true and yields incremental token deltas from SSE data lines', async () => {
    const client = new OpenRouterClient({
      config: {
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: TEST_OPENROUTER_ENV,
      },
      fetch: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}',
          'data: {"choices":[{"delta":{"content":"lo"}}]}',
          'data: [DONE]',
        ]),
    });

    const collected = await collectStream(
      client.streamChatCompletion({
        model: 'google/gemini-3.5-flash',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 64,
        temperature: 0.3,
        stream: true,
      })
    );

    assert.deepEqual(collected.tokens, ['Hel', 'lo']);
    assert.equal(collected.final.content, 'Hello');
  });

  test('AbortSignal is passed through to fetch', async () => {
    const controller = new AbortController();
    let seenSignal;
    const client = new OpenRouterClient({
      config: {
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: TEST_OPENROUTER_ENV,
      },
      fetch: async (url, init) => {
        seenSignal = init.signal;
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
    });

    await client.createChatCompletion({
      model: 'google/gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 64,
      temperature: 0.3,
      stream: false,
      signal: controller.signal,
    });

    assert.equal(seenSignal, controller.signal);
  });

  test('cache-control rejection retries once without cache_control and returns a warning flag', async () => {
    let callCount = 0;
    let secondBody;
    const snapshot = {
      meeting_id: 'meeting-123',
      chunks: [
        {
          id: 'chunk:0001',
          meeting_id: 'meeting-123',
          start_ts: '2026-07-03T10:00:00.000Z',
          end_ts: '2026-07-03T10:00:30.000Z',
          text: 'Transcript body',
        },
      ],
    };
    const context = buildMeetingCopilotContext({
      mode: 'full_cached',
      snapshot,
      stableInstructions: 'Stable',
      customContext: 'Custom',
      pinnedContext: 'Pinned',
      codeContext: 'Code',
      currentAction: 'Act now',
    });
    const serialized = buildOpenRouterMessages({
      context,
      cachePolicy: 'anthropic_explicit_1h',
    });
    const client = new OpenRouterClient({
      config: {
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: TEST_OPENROUTER_ENV,
      },
      fetch: async (url, init) => {
        callCount += 1;
        const body = JSON.parse(init.body);
        if (callCount === 1) {
          return jsonResponse({ error: { message: 'invalid cache_control formatting' } }, { status: 400 });
        }
        secondBody = body;
        return jsonResponse({ choices: [{ message: { content: 'retry ok' } }] });
      },
    });

    const result = await client.createChatCompletion({
      model: 'anthropic/claude-opus-4.8-fast',
      messages: serialized.messages,
      max_tokens: 64,
      temperature: 0.2,
      stream: false,
      cache_policy: 'anthropic_explicit_1h',
    });

    assert.equal(callCount, 2);
    assert.equal(secondBody.messages[0].content[0].cache_control, undefined);
    assert.equal(result.warnings.includes('cache_control_disabled_after_provider_rejection'), true);
  });

  test('cache-control rejection without cache_control in the outgoing request does not retry', async () => {
    let callCount = 0;
    const client = new OpenRouterClient({
      config: {
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: TEST_OPENROUTER_ENV,
      },
      fetch: async () => {
        callCount += 1;
        return jsonResponse({ error: { message: 'invalid cache_control formatting' } }, { status: 400 });
      },
    });

    await assert.rejects(
      () =>
        client.createChatCompletion({
          model: 'anthropic/claude-opus-4.8-fast',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 64,
          temperature: 0.2,
          stream: false,
        }),
      /cache_control formatting/
    );

    assert.equal(callCount, 1);
  });

  test('unrelated 401 and 500 failures do not retry', async () => {
    let callCount = 0;
    const client = new OpenRouterClient({
      config: {
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: TEST_OPENROUTER_ENV,
      },
      fetch: async () => {
        callCount += 1;
        return jsonResponse(
          { error: { message: 'unauthorized cache_control but not retryable' } },
          { status: 401 }
        );
      },
    });

    await assert.rejects(
      () =>
        client.createChatCompletion({
          model: 'anthropic/claude-opus-4.8-fast',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 64,
          temperature: 0.2,
          stream: false,
        }),
      /unauthorized/
    );
    assert.equal(callCount, 1);
  });

  test('error messages redact bearer tokens and API-key-shaped strings', async () => {
    const client = new OpenRouterClient({
      config: {
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: TEST_OPENROUTER_ENV,
      },
      fetch: async () =>
        jsonResponse(
          {
            error: {
              message:
                'Authorization: Bearer sk-test-1234567890abcdef and secondary key natively_sk_secret_value',
            },
          },
          { status: 500 }
        ),
    });

    await assert.rejects(
      () =>
        client.createChatCompletion({
          model: 'anthropic/claude-opus-4.8-fast',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 64,
          temperature: 0.2,
          stream: false,
        }),
      /Bearer \[REDACTED\]/
    );
  });

  test('usage.prompt_tokens_details maps cached_tokens and cache_write_tokens into metrics', async () => {
    const client = new OpenRouterClient({
      config: {
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: TEST_OPENROUTER_ENV,
      },
      fetch: async () =>
        jsonResponse({
          choices: [{ message: { content: 'ok' } }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 4,
            total_tokens: 15,
            prompt_tokens_details: { cached_tokens: 7, cache_write_tokens: 2 },
          },
        }),
    });

    const result = await client.createChatCompletion({
      model: 'google/gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 64,
      temperature: 0.3,
      stream: false,
    });

    assert.equal(result.metrics.prompt_tokens, 11);
    assert.equal(result.metrics.completion_tokens, 4);
    assert.equal(result.metrics.total_tokens, 15);
    assert.equal(result.metrics.cached_tokens, 7);
    assert.equal(result.metrics.cache_write_tokens, 2);
  });
});
