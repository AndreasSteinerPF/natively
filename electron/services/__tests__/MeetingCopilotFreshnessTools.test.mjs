import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

async function loadFreshnessTools() {
  return import(pathToFileURL(path.join(distRoot, 'FreshnessTools.js')).href);
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

describe('MeetingCopilot FreshnessTools', () => {
  test('getOpenRouterModel reads the OpenRouter catalog and returns bounded model metadata', async () => {
    const { FreshnessTools } = await loadFreshnessTools();
    const calls = [];
    const tools = new FreshnessTools({
      config: {
        base_url: 'https://openrouter.ai/api/v1/',
        api_key_env: 'OPENROUTER_API_KEY',
        default_headers: { 'HTTP-Referer': 'https://natively.test' },
      },
      apiKeyResolver: () => 'sk-or-v1-secret',
      now: () => new Date('2026-07-04T10:00:00.000Z'),
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          data: [
            {
              id: 'openai/gpt-4.1',
              name: 'OpenAI GPT-4.1',
              context_length: 1047576,
              pricing: { prompt: '0.000002', completion: '0.000008' },
              supported_parameters: ['tools', 'reasoning'],
              description: 'x'.repeat(2000),
            },
          ],
        });
      },
    });

    const model = await tools.getOpenRouterModel('openai/gpt-4.1');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/models');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-or-v1-secret');
    assert.equal(calls[0].init.headers['HTTP-Referer'], 'https://natively.test');
    assert.deepEqual(model, {
      id: 'openai/gpt-4.1',
      name: 'OpenAI GPT-4.1',
      context_length: 1047576,
      pricing: { prompt: '0.000002', completion: '0.000008' },
      supported_parameters: ['tools', 'reasoning'],
      source: 'openrouter',
      checked_at: '2026-07-04T10:00:00.000Z',
    });
  });

  test('OpenRouter catalog errors are bounded and redact API keys', async () => {
    const { FreshnessTools } = await loadFreshnessTools();
    const tools = new FreshnessTools({
      config: {
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: 'OPENROUTER_API_KEY',
      },
      apiKeyResolver: () => 'sk-or-v1-secret',
      fetch: async () =>
        jsonResponse(
          { error: { message: 'Invalid API key sk-or-v1-secret for catalog access' } },
          { status: 401 }
        ),
    });

    await assert.rejects(
      () => tools.getOpenRouterModel('openai/gpt-4.1'),
      (error) => {
        assert.match(error.message, /OpenRouter model catalog request failed \(401\)/);
        assert.doesNotMatch(error.message, /sk-or-v1-secret/);
        assert.ok(error.message.length <= 320);
        return true;
      }
    );
  });

  test('web search is explicitly unavailable in M15', async () => {
    const { FreshnessTools } = await loadFreshnessTools();
    const tools = new FreshnessTools({
      config: {
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: 'OPENROUTER_API_KEY',
      },
      apiKeyResolver: () => 'sk-or-v1-secret',
      fetch: async () => jsonResponse({ data: [] }),
    });

    assert.equal(typeof tools.webSearch, 'undefined');
  });
});
