import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

describe('meeting-copilot error classification (ActionRunManager)', () => {
  test('classifies OpenRouter 401 errors as auth', async () => {
    const mod = await import(
      pathToFileURL(path.join(distRoot, 'ActionRunManager.js')).href
    );

    const emitted = [];
    const manager = new mod.ActionRunManager({
      config: {
        actions: {
          'quick-answer': {
            id: 'quick-answer',
            label: 'Quick Answer',
            hotkey: 'Command+Option+1',
            model: 'google/gemini-3.5-flash',
            context_mode: 'recent',
            cache_policy: 'none',
            max_tokens: 300,
            temperature: 0.7,
            reasoning: { effort: 'low' },
            prompt: 'Quick answer prompt',
            tools_enabled: false,
          },
        },
        code_context: { max_total_chars: 12000 },
      },
      transcriptSnapshotProvider: () => ({
        meeting_id: 'test-meeting',
        chunks: [{ text: 'Hello', start_ts: 0, end_ts: 1000, speaker: 'user' }],
      }),
      buildContext: (input) => ({
        messages: [],
        sections: { recent: '', full_cached: '', prompt: '' },
      }),
      buildMessages: () => ({ messages: [] }),
      openRouterClient: {
        async *streamChatCompletion() {
          throw Object.assign(new Error('HTTP 401 Unauthorized - invalid API key'), {
            name: 'Error',
          });
        },
      },
      emitEvent: (event) => emitted.push(event),
    });

    try { await manager.start({ actionId: 'quick-answer' }); } catch { /* start() re-throws on failure */ }

    const errorEvent = emitted.find((event) => event.type === 'action:error');
    assert.ok(errorEvent, 'expected action:error event');
    assert.match(String(errorEvent.error ?? ''), /api key/i);
    assert.equal(errorEvent.error_type, 'auth');
  });

  test('classifies rate-limit 429 errors', async () => {
    const mod = await import(
      pathToFileURL(path.join(distRoot, 'ActionRunManager.js')).href
    );

    const emitted = [];
    const manager = new mod.ActionRunManager({
      config: {
        actions: {
          'quick-answer': {
            id: 'quick-answer',
            label: 'Quick Answer',
            hotkey: 'Command+Option+1',
            model: 'google/gemini-3.5-flash',
            context_mode: 'recent',
            cache_policy: 'none',
            max_tokens: 300,
            temperature: 0.7,
            reasoning: { effort: 'low' },
            prompt: 'Quick answer prompt',
            tools_enabled: false,
          },
        },
        code_context: { max_total_chars: 12000 },
      },
      transcriptSnapshotProvider: () => ({
        meeting_id: 'test-meeting',
        chunks: [{ text: 'Hello', start_ts: 0, end_ts: 1000, speaker: 'user' }],
      }),
      buildContext: (input) => ({
        messages: [],
        sections: { recent: '', full_cached: '', prompt: '' },
      }),
      buildMessages: () => ({ messages: [] }),
      openRouterClient: {
        async *streamChatCompletion() {
          throw Object.assign(
            new Error('HTTP 429 Too Many Requests - rate limit exceeded'),
            { name: 'Error' }
          );
        },
      },
      emitEvent: (event) => emitted.push(event),
    });

    try { await manager.start({ actionId: 'quick-answer' }); } catch { /* start() re-throws on failure */ }

    const errorEvent = emitted.find((event) => event.type === 'action:error');
    assert.ok(errorEvent, 'expected action:error event');
    assert.match(String(errorEvent.error ?? ''), /rate.?limit/i);
    assert.equal(errorEvent.error_type, 'rate_limit');
  });

  test('classifies context-limit errors', async () => {
    const mod = await import(
      pathToFileURL(path.join(distRoot, 'ActionRunManager.js')).href
    );

    const emitted = [];
    const manager = new mod.ActionRunManager({
      config: {
        actions: {
          'deep-solution': {
            id: 'deep-solution',
            label: 'Deep Solution',
            hotkey: 'Command+Option+3',
            model: 'anthropic/claude-opus-4.8-fast',
            context_mode: 'full_cached',
            cache_policy: 'anthropic_explicit_1h',
            max_tokens: 1200,
            temperature: 0.2,
            reasoning: { effort: 'medium' },
            prompt: 'Deep solution prompt',
            tools_enabled: false,
          },
        },
        code_context: { max_total_chars: 12000 },
      },
      transcriptSnapshotProvider: () => ({
        meeting_id: 'test-meeting',
        chunks: [{ text: 'Hello', start_ts: 0, end_ts: 1000, speaker: 'user' }],
      }),
      buildContext: (input) => ({
        messages: [],
        sections: { recent: '', full_cached: '', prompt: '' },
      }),
      buildMessages: () => ({ messages: [] }),
      openRouterClient: {
        async *streamChatCompletion() {
          throw Object.assign(
            new Error('prompt too long: exceeds maximum context length'),
            { name: 'Error' }
          );
        },
      },
      emitEvent: (event) => emitted.push(event),
    });

    try { await manager.start({ actionId: 'deep-solution' }); } catch { /* start() re-throws on failure */ }

    const errorEvent = emitted.find((event) => event.type === 'action:error');
    assert.ok(errorEvent, 'expected action:error event');
    assert.match(String(errorEvent.error ?? ''), /context is too large/i);
    assert.equal(errorEvent.error_type, 'context_limit');
  });

  test('does not classify generic errors into specific buckets', async () => {
    const mod = await import(
      pathToFileURL(path.join(distRoot, 'ActionRunManager.js')).href
    );

    const emitted = [];
    const manager = new mod.ActionRunManager({
      config: {
        actions: {
          'quick-answer': {
            id: 'quick-answer',
            label: 'Quick Answer',
            hotkey: 'Command+Option+1',
            model: 'google/gemini-3.5-flash',
            context_mode: 'recent',
            cache_policy: 'none',
            max_tokens: 300,
            temperature: 0.7,
            reasoning: { effort: 'low' },
            prompt: 'Quick answer prompt',
            tools_enabled: false,
          },
        },
        code_context: { max_total_chars: 12000 },
      },
      transcriptSnapshotProvider: () => ({
        meeting_id: 'test-meeting',
        chunks: [{ text: 'Hello', start_ts: 0, end_ts: 1000, speaker: 'user' }],
      }),
      buildContext: (input) => ({
        messages: [],
        sections: { recent: '', full_cached: '', prompt: '' },
      }),
      buildMessages: () => ({ messages: [] }),
      openRouterClient: {
        async *streamChatCompletion() {
          throw new Error('DNS lookup failed for api.openrouter.ai');
        },
      },
      emitEvent: (event) => emitted.push(event),
    });

    try { await manager.start({ actionId: 'quick-answer' }); } catch { /* start() re-throws on failure */ }

    const errorEvent = emitted.find((event) => event.type === 'action:error');
    assert.ok(errorEvent, 'expected action:error event');
    assert.equal(errorEvent.error_type, undefined);
    assert.match(String(errorEvent.error ?? ''), /dns lookup/i);
  });

  test('redacts API keys in error messages emitted to renderer', async () => {
    const mod = await import(
      pathToFileURL(path.join(distRoot, 'ActionRunManager.js')).href
    );

    const emitted = [];
    const manager = new mod.ActionRunManager({
      config: {
        actions: {
          'quick-answer': {
            id: 'quick-answer',
            label: 'Quick Answer',
            hotkey: 'Command+Option+1',
            model: 'google/gemini-3.5-flash',
            context_mode: 'recent',
            cache_policy: 'none',
            max_tokens: 300,
            temperature: 0.7,
            reasoning: { effort: 'low' },
            prompt: 'Quick answer prompt',
            tools_enabled: false,
          },
        },
        code_context: { max_total_chars: 12000 },
      },
      transcriptSnapshotProvider: () => ({
        meeting_id: 'test-meeting',
        chunks: [{ text: 'Hello', start_ts: 0, end_ts: 1000, speaker: 'user' }],
      }),
      buildContext: (input) => ({
        messages: [],
        sections: { recent: '', full_cached: '', prompt: '' },
      }),
      buildMessages: () => ({ messages: [] }),
      openRouterClient: {
        async *streamChatCompletion() {
          throw new Error('Connection refused for api.openrouter.ai using key sk-orv1abcdef123456789012345');
        },
      },
      emitEvent: (event) => emitted.push(event),
    });

    try { await manager.start({ actionId: 'quick-answer' }); } catch { /* start() re-throws on failure */ }

    const errorEvent = emitted.find((event) => event.type === 'action:error');
    assert.ok(errorEvent, 'expected action:error event');
    assert.doesNotMatch(String(errorEvent.error ?? ''), /sk-orv1abcdef123456789012345/);
  });
});
