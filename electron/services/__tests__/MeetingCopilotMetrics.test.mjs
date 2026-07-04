import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

async function loadMetricsStore() {
  return import(pathToFileURL(path.join(distRoot, 'MetricsStore.js')).href);
}

describe('meeting-copilot metrics store', () => {
  test('records a metric entry with known fields only', async () => {
    const mod = await loadMetricsStore();
    const store = new mod.MetricsStore();

    store.record({
      model: 'anthropic/claude-opus-4.8-fast',
      action_id: 'deep-solution',
      branch: 'single',
      success: true,
      prompt_tokens: 1200,
      completion_tokens: 200,
      code_context_included: true,
      freshness_query_count: 0,
      freshness_result_count: 0,
      freshness_error: 'verification_unavailable',
    });

    const entries = store.last();
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.model, 'anthropic/claude-opus-4.8-fast');
    assert.equal(entry.action_id, 'deep-solution');
    assert.equal(entry.branch, 'single');
    assert.equal(entry.success, true);
    assert.equal(entry.prompt_tokens, 1200);
    assert.equal(entry.completion_tokens, 200);
    assert.equal(entry.code_context_included, true);
    assert.equal(entry.freshness_query_count, 0);
    assert.equal(entry.freshness_result_count, 0);
    assert.equal(entry.freshness_error, 'verification_unavailable');
    assert.ok(typeof entry.logged_at === 'string');
    assert.ok(entry.logged_at.endsWith('Z') || entry.logged_at.includes('T'));
  });

  test('does not leak raw transcript or snippet content', async () => {
    const mod = await loadMetricsStore();
    const store = new mod.MetricsStore();

    store.record({
      model: 'google/gemini-3.5-flash',
      success: true,
      error: 'Bearer sk-or-v1-secret-key that should be redacted',
    });

    const entries = store.last();
    assert.equal(entries.length, 1);
    const entry = entries[0];

    assert.doesNotMatch(entry.error ?? '', /sk-or-v1-secret-key/);
    assert.doesNotMatch(entry.error ?? '', /Bearer\s+sk-or/);
  });

  test('redacts credential-shaped strings in error messages', async () => {
    const mod = await loadMetricsStore();
    const store = new mod.MetricsStore();

    store.record({
      model: 'google/gemini-3.5-flash',
      success: false,
      error: 'OpenRouter error: Invalid API key sk-ant-api03-abc123def456ghi789jkl',
    });

    const entries = store.last();
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.doesNotMatch(entry.error ?? '', /sk-ant-api03-abc123def456ghi789jkl/);
  });

  test('serializes to valid JSON without raw content', async () => {
    const mod = await loadMetricsStore();
    const store = new mod.MetricsStore();

    store.record({
      model: 'perplexity/sonar-pro-search',
      success: true,
      prompt_tokens: 500,
      completion_tokens: 100,
      cached_tokens: 200,
      freshness_sources: ['policy-only'],
    });

    const json = store.serialize();
    assert.doesNotThrow(() => JSON.parse(json));

    const parsed = JSON.parse(json);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].model, 'perplexity/sonar-pro-search');
    assert.equal(parsed[0].prompt_tokens, 500);
    assert.equal(parsed[0].cached_tokens, 200);
    assert.deepEqual(parsed[0].freshness_sources, ['policy-only']);
  });

  test('freshness status fields remain bounded and do not store transcript or code text', async () => {
    const mod = await loadMetricsStore();
    const store = new mod.MetricsStore();

    store.record({
      model: 'anthropic/claude-opus-4.8-fast',
      success: true,
      freshness_sources: ['policy-only', '   '],
      freshness_verified_at: '2026-07-04T10:00:00.000Z',
      freshness_error:
        'verification_unavailable Authorization: Bearer sk-or-v1-secret-key transcript says "customer secret roadmap"',
    });

    const entry = store.last()[0];
    assert.deepEqual(entry.freshness_sources, ['policy-only']);
    assert.equal(entry.freshness_verified_at, '2026-07-04T10:00:00.000Z');
    assert.doesNotMatch(entry.freshness_error ?? '', /sk-or-v1-secret-key/);
    assert.doesNotMatch(entry.freshness_error ?? '', /Bearer\s+sk-or-v1/);
  });

  test('bounds the number of stored entries', async () => {
    const mod = await loadMetricsStore();
    const store = new mod.MetricsStore();

    for (let i = 0; i < 600; i += 1) {
      store.record({
        model: 'google/gemini-3.5-flash',
        success: true,
        prompt_tokens: i,
      });
    }

    const entries = store.last();
    assert.ok(entries.length <= 500);
  });

  test('last() returns at most the requested count', async () => {
    const mod = await loadMetricsStore();
    const store = new mod.MetricsStore();

    for (let i = 0; i < 20; i += 1) {
      store.record({
        model: 'google/gemini-3.5-flash',
        success: true,
        prompt_tokens: i,
      });
    }

    assert.equal(store.last(5).length, 5);
    assert.equal(store.last(50).length, 20);
  });

  test('clear() empties all entries', async () => {
    const mod = await loadMetricsStore();
    const store = new mod.MetricsStore();

    store.record({
      model: 'google/gemini-3.5-flash',
      success: true,
    });
    assert.equal(store.last().length, 1);

    store.clear();
    assert.equal(store.last().length, 0);
  });

  test('strips error_type longer than 128 characters', async () => {
    const mod = await loadMetricsStore();
    const store = new mod.MetricsStore();

    store.record({
      model: 'anthropic/claude-opus-4.8-fast',
      success: false,
      error: 'Something went wrong',
      error_type: 'a'.repeat(200),
    });

    const entries = store.last();
    assert.equal(entries.length, 1);
    assert.ok((entries[0].error_type?.length ?? 0) <= 128);
  });

  test('sanitizes bearer and JWT tokens in error messages', async () => {
    const mod = await loadMetricsStore();
    const store = new mod.MetricsStore();

    store.record({
      model: 'anthropic/claude-opus-4.8-fast',
      success: false,
      error: 'Request failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNOyCOl',
    });

    const entries = store.last();
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.doesNotMatch(entry.error ?? '', /Bearer\s+eyJ/);
    assert.doesNotMatch(entry.error ?? '', /eyJhbGci/);
  });
});
