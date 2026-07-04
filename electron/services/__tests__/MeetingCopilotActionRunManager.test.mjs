import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const { buildMeetingCopilotContext } = await import(
  pathToFileURL(path.join(distRoot, 'ContextBuilder.js')).href
);
const { buildOpenRouterMessages } = await import(
  pathToFileURL(path.join(distRoot, 'PromptCache.js')).href
);
const { ActionRunManager } = await import(
  pathToFileURL(path.join(distRoot, 'ActionRunManager.js')).href
);
const { OpenRouterClient } = await import(
  pathToFileURL(path.join(distRoot, 'OpenRouterClient.js')).href
);
const { DEFAULT_MEETING_COPILOT_CONFIG } = await import(
  pathToFileURL(path.join(distRoot, 'defaultActionConfig.js')).href
);

function createSnapshot() {
  return {
    meeting_id: 'meeting-123',
    chunks: [
      {
        id: 'chunk-001',
        meeting_id: 'meeting-123',
        start_ts: '2026-07-03T10:00:00.000Z',
        end_ts: '2026-07-03T10:00:30.000Z',
        text: 'We should answer the customer concern quickly.',
        source: 'mic',
      },
    ],
  };
}

function cloneConfig() {
  return structuredClone(DEFAULT_MEETING_COPILOT_CONFIG);
}

function collectUserText(request) {
  const userMessage = request.messages.find((message) => message.role === 'user');
  if (!userMessage) {
    return '';
  }

  if (Array.isArray(userMessage.content)) {
    return userMessage.content.map((block) => block.text).join('\n');
  }

  return String(userMessage.content ?? '');
}

function createClock(values) {
  const queue = [...values];
  const last = values.at(-1) ?? 0;
  return () => (queue.length > 0 ? queue.shift() : last);
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createToolLoopStub(options = {}) {
  const calls = [];
  return {
    calls,
    async run(input) {
      calls.push(input);
      return {
        messages: input.messages,
        evidenceText: options.evidenceText ?? '',
        metrics: {
          tool_rounds: options.toolRounds ?? 1,
          tool_calls: options.toolCalls ?? 0,
          code_context_included: (options.evidenceText ?? '').trim().length > 0,
        },
      };
    },
  };
}

function createBranchStreamController(options = {}) {
  const { waitForToken = true } = options;
  const started = deferred();
  const releaseToken = deferred();
  const releaseDone = deferred();
  return {
    started,
    releaseToken,
    releaseDone,
    async *stream(request, token) {
      started.resolve(request);
      if (waitForToken) {
        await releaseToken.promise;
      }
      yield { type: 'token', token };
      await releaseDone.promise;
      yield {
        type: 'done',
        result: {
          content: token,
          raw: {},
          warnings: [],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
          metrics: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
      };
    },
  };
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

describe('meeting-copilot action runner', () => {
  test('compiled meeting-copilot runtime exports the ActionRunManager primitive', () => {
    assert.equal(typeof ActionRunManager, 'function');
  });

  test('action start creates a deterministic runId, snapshots transcript once, emits action:started, and sends a streamed completion request', async () => {
    const snapshot = createSnapshot();
    const emitted = [];
    const snapshotCalls = [];
    const openRouterCalls = [];
    const config = cloneConfig();
    const manager = new ActionRunManager({
      config,
      transcriptSnapshotProvider: () => {
        snapshotCalls.push('snapshot');
        return snapshot;
      },
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          openRouterCalls.push(request);
          yield { type: 'token', token: 'Hello' };
          yield {
            type: 'done',
            result: {
              content: 'Hello',
              raw: {},
              warnings: [],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 3,
                total_tokens: 15,
              },
              metrics: {
                prompt_tokens: 12,
                completion_tokens: 3,
                total_tokens: 15,
              },
            },
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: () => 'run-001',
      now: createClock([100, 125, 180]),
      sessionId: 'meeting-123:quick-answer',
    });

    await manager.start({ actionId: 'quick-answer' });

    assert.equal(snapshotCalls.length, 1);
    assert.equal(openRouterCalls.length, 1);
    assert.deepEqual(emitted[0], {
      type: 'action:started',
      runId: 'run-001',
      actionId: 'quick-answer',
      label: 'Quick Answer',
    });
    assert.deepEqual(emitted[1], {
      type: 'action:token',
      runId: 'run-001',
      pane: 'main',
      token: 'Hello',
    });
    assert.equal(openRouterCalls[0].model, config.actions['quick-answer'].model);
    assert.equal(openRouterCalls[0].max_tokens, config.actions['quick-answer'].max_tokens);
    assert.equal(openRouterCalls[0].temperature, config.actions['quick-answer'].temperature);
    assert.equal(openRouterCalls[0].reasoning.effort, 'low');
    assert.equal(openRouterCalls[0].session_id, 'meeting-123:quick-answer');
    assert.equal(Array.isArray(openRouterCalls[0].messages), true);
    assert.equal(openRouterCalls[0].stream, true);
    assert.equal(openRouterCalls[0].cache_policy, 'none');
    assert.equal(Array.isArray(openRouterCalls[0].messages[0].content), true);
    assert.equal(openRouterCalls[0].messages[0].content.every((block) => block.cache_control === undefined), true);
    assert.match(
      openRouterCalls[0].messages[0].content.map((block) => block.text).join('\n'),
      /currentness-uncertain|web search query/
    );
  });

  test('tech-solver and deep-solution run through full_cached context with Anthropic cache-control and derived session ids', async () => {
    const snapshot = createSnapshot();
    const emitted = [];
    const openRouterCalls = [];
    const config = cloneConfig();
    const toolLoop = createToolLoopStub({
      evidenceText: '<code_context>\n[file: src/example.ts lines=42-42]\n...</code_context>',
      toolRounds: 1,
      toolCalls: 1,
    });
    const manager = new ActionRunManager({
      config,
      transcriptSnapshotProvider: () => snapshot,
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          openRouterCalls.push(request);
          yield {
            type: 'done',
            result: {
              content: 'done',
              raw: {},
              warnings: [],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 5,
                total_tokens: 25,
              },
              metrics: {
                prompt_tokens: 20,
                completion_tokens: 5,
                total_tokens: 25,
              },
            },
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      toolLoop,
      createRunId: (() => {
        const ids = ['run-tech', 'run-deep'];
        return () => ids.shift();
      })(),
      now: createClock([10, 20, 30, 40]),
      getCodeContext: () => 'Code context block',
    });

    await manager.start({ actionId: 'tech-solver' });
    await manager.start({ actionId: 'deep-solution' });

    assert.equal(openRouterCalls.length, 2);
    assert.equal(toolLoop.calls.length, 2);
    for (const [index, actionId] of ['tech-solver', 'deep-solution'].entries()) {
      const request = openRouterCalls[index];
      const action = config.actions[actionId];
      assert.equal(request.model, action.model);
      assert.equal(request.max_tokens, action.max_tokens);
      assert.equal(request.temperature, action.temperature);
      assert.equal(request.reasoning.effort, action.reasoning.effort);
      assert.equal(request.cache_policy, 'anthropic_explicit_1h');
      assert.equal(request.session_id, `meeting-123:${actionId}`);
      assert.equal(request.stream, true);
      assert.equal(Array.isArray(request.messages[0].content), true);
      // Empty cacheable sections (custom_context, pinned_context) are omitted so
      // Anthropic never receives an empty text content block (which 400s). Only
      // the non-empty cacheable sections remain: stable_instructions + transcript.
      assert.equal(request.messages[0].content.length, 2);
      assert.equal(request.messages[0].content.every((block) => block.cache_control?.ttl === '1h'), true);
      assert.equal(request.messages[0].content.every((block) => block.text.trim().length > 0), true);
      assert.equal(Array.isArray(request.messages[1].content), true);
      assert.equal(request.messages[1].content.length, 2);
      assert.equal(request.messages[1].content[0].text, '<code_context>\n[file: src/example.ts lines=42-42]\n...</code_context>');
      assert.equal(request.messages[1].content[0].cache_control, undefined);
      assert.equal(request.messages[1].content[1].text, action.prompt);
      assert.equal(request.messages[1].content[1].cache_control, undefined);
    }

    assert.equal(emitted.filter((event) => event.type === 'action:started').length, 2);
    assert.equal(emitted.filter((event) => event.type === 'action:completed').length, 2);
  });

  test('freshness-sensitive quick answers add an unverified currentness caveat without blocking', async () => {
    const openRouterCalls = [];
    const config = cloneConfig();
    config.actions['quick-answer'].prompt = 'What is the latest OpenAI pricing right now?';
    const managerWithPrompt = new ActionRunManager({
      config,
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          openRouterCalls.push(request);
          yield {
            type: 'done',
            result: {
              content: 'Pricing may have changed.',
              raw: {},
              warnings: [],
              usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
              metrics: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
            },
          };
        },
      },
      emitEvent: () => {},
      createRunId: () => 'run-fresh-quick',
      getStableInstructions: () => 'Base instructions.',
      now: createClock([0, 5, 10]),
    });

    await managerWithPrompt.start({ actionId: 'quick-answer' });

    assert.equal(openRouterCalls.length, 1);
    assert.match(collectUserText(openRouterCalls[0]), /unverified\/currentness-uncertain/);
  });

  test('deep-solution metrics mark freshness as unverified when tools are unavailable', async () => {
    const emitted = [];
    const config = cloneConfig();
    config.actions['deep-solution'].tools_enabled = false;
    config.actions['deep-solution'].prompt =
      'Compare the current context windows and pricing for the latest OpenAI and Anthropic models.';

    const manager = new ActionRunManager({
      config,
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* () {
          yield {
            type: 'done',
            result: {
              content: 'Current facts need verification.',
              raw: {},
              warnings: [],
              usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
              metrics: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
            },
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: () => 'run-fresh-deep',
      now: createClock([0, 5, 10]),
    });

    await manager.start({ actionId: 'deep-solution' });

    const metricsEvent = emitted.find((event) => event.type === 'metrics:update');
    assert.equal(metricsEvent.metrics.freshness_check_used, undefined);
    assert.equal(metricsEvent.metrics.freshness_error, 'verification_unavailable');
    assert.equal(metricsEvent.metrics.freshness_result_count, 0);
  });

  test('freshness-eligible actions with tools available keep caveat when no safe model id exists', async () => {
    const emitted = [];
    const openRouterCalls = [];
    const config = cloneConfig();
    config.actions['deep-solution'].tools_enabled = false;
    config.actions['deep-solution'].prompt =
      'Compare the current context windows and pricing for the latest OpenAI and Anthropic models.';

    const manager = new ActionRunManager({
      config,
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          openRouterCalls.push(request);
          yield {
            type: 'done',
            result: {
              content: 'Freshness tools can verify this later.',
              raw: {},
              warnings: [],
              usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
              metrics: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
            },
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: () => 'run-fresh-tools-available',
      freshnessTools: {
        async getOpenRouterModel(modelId) {
          throw new Error(`unexpected lookup for ${modelId}`);
        },
      },
      hasFreshnessTools: () => true,
      now: createClock([0, 5, 10]),
    });

    await manager.start({ actionId: 'deep-solution' });

    const metricsEvent = emitted.find((event) => event.type === 'metrics:update');
    assert.equal(metricsEvent.metrics.freshness_error, 'no_safe_model_id');
    assert.equal(metricsEvent.metrics.freshness_query_count, 0);
    assert.match(collectUserText(openRouterCalls[0]), /No safe public OpenRouter model ID/);
    assert.match(collectUserText(openRouterCalls[0]), /unverified\/currentness-uncertain/);
  });

  test('claim-check uses OpenRouter catalog freshness for safely recognized public model slugs', async () => {
    const emitted = [];
    const openRouterCalls = [];
    const freshnessCalls = [];
    const config = cloneConfig();
    config.actions['claim-check'].prompt =
      'Check whether openai/gpt-4.1 is currently available on OpenRouter and include its context window.';

    const manager = new ActionRunManager({
      config,
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          openRouterCalls.push(request);
          yield {
            type: 'done',
            result: {
              content: 'Verified.',
              raw: {},
              warnings: [],
              usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
              metrics: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
            },
          };
        },
      },
      freshnessTools: {
        async getOpenRouterModel(modelId) {
          freshnessCalls.push(modelId);
          return {
            id: modelId,
            name: 'OpenAI GPT-4.1',
            context_length: 1047576,
            pricing: { prompt: '0.000002', completion: '0.000008' },
            supported_parameters: ['tools'],
            source: 'openrouter',
            checked_at: '2026-07-04T10:00:00.000Z',
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: () => 'run-fresh-catalog',
      hasFreshnessTools: () => true,
      now: createClock([0, 5, 10]),
    });

    await manager.start({ actionId: 'claim-check' });

    assert.deepEqual(freshnessCalls, ['openai/gpt-4.1']);
    const userText = collectUserText(openRouterCalls[0]);
    assert.match(userText, /<dynamic_evidence_context>/);
    assert.match(userText, /OpenRouter model catalog/);
    assert.match(userText, /openai\/gpt-4\.1/);
    assert.match(userText, /context_length: 1047576/);
    assert.doesNotMatch(userText, /customer concern quickly/);

    const userMessage = openRouterCalls[0].messages.find((message) => message.role === 'user');
    assert.equal(Array.isArray(userMessage.content), true);
    const dynamicBlock = userMessage.content.find((block) =>
      block.text.includes('<dynamic_evidence_context>')
    );
    assert.equal(dynamicBlock.cache_control, undefined);

    const metricsEvent = emitted.find((event) => event.type === 'metrics:update');
    assert.equal(metricsEvent.metrics.freshness_check_used, true);
    assert.deepEqual(metricsEvent.metrics.freshness_sources, ['OpenRouter model catalog']);
    assert.equal(metricsEvent.metrics.freshness_query_count, 1);
    assert.equal(metricsEvent.metrics.freshness_result_count, 1);
    assert.equal(metricsEvent.metrics.freshness_verified_at, '2026-07-04T10:00:00.000Z');
    assert.equal(metricsEvent.metrics.freshness_error, undefined);
  });

  test('freshness lookup failures keep the action running with bounded caveat metrics', async () => {
    const emitted = [];
    const openRouterCalls = [];
    const config = cloneConfig();
    config.actions['claim-check'].prompt =
      'Check whether anthropic/claude-3.5-sonnet is currently available on OpenRouter.';

    const manager = new ActionRunManager({
      config,
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          openRouterCalls.push(request);
          yield {
            type: 'done',
            result: {
              content: 'Unverified.',
              raw: {},
              warnings: [],
              usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
              metrics: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
            },
          };
        },
      },
      freshnessTools: {
        async getOpenRouterModel() {
          throw new Error('OpenRouter failed with Authorization: Bearer sk-or-v1-secret');
        },
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: () => 'run-fresh-failure',
      hasFreshnessTools: () => true,
      now: createClock([0, 5, 10]),
    });

    await manager.start({ actionId: 'claim-check' });

    assert.equal(openRouterCalls.length, 1);
    assert.match(collectUserText(openRouterCalls[0]), /unverified\/currentness-uncertain/);
    assert.doesNotMatch(collectUserText(openRouterCalls[0]), /sk-or-v1-secret/);

    const metricsEvent = emitted.find((event) => event.type === 'metrics:update');
    assert.equal(metricsEvent.metrics.freshness_check_used, true);
    assert.deepEqual(metricsEvent.metrics.freshness_sources, ['OpenRouter model catalog']);
    assert.equal(metricsEvent.metrics.freshness_query_count, 1);
    assert.equal(metricsEvent.metrics.freshness_result_count, 0);
    assert.match(metricsEvent.metrics.freshness_error, /OpenRouter failed/);
    assert.doesNotMatch(metricsEvent.metrics.freshness_error, /sk-or-v1-secret/);
  });

  test('freshness verification does not query private transcript text when no safe model slug exists', async () => {
    const emitted = [];
    const openRouterCalls = [];
    const freshnessCalls = [];
    const config = cloneConfig();
    config.actions['claim-check'].prompt =
      'Check the current provider status for the model we discussed.';
    const snapshot = createSnapshot();
    snapshot.chunks[0].text =
      'Customer secret roadmap says the private codename is atlas-coral; do not leak this.';

    const manager = new ActionRunManager({
      config,
      transcriptSnapshotProvider: () => snapshot,
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          openRouterCalls.push(request);
          yield {
            type: 'done',
            result: {
              content: 'No safe catalog lookup.',
              raw: {},
              warnings: [],
              usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
              metrics: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
            },
          };
        },
      },
      freshnessTools: {
        async getOpenRouterModel(modelId) {
          freshnessCalls.push(modelId);
          throw new Error('should not be called');
        },
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: () => 'run-no-safe-model',
      hasFreshnessTools: () => true,
      now: createClock([0, 5, 10]),
    });

    await manager.start({ actionId: 'claim-check' });

    assert.deepEqual(freshnessCalls, []);
    const userText = collectUserText(openRouterCalls[0]);
    assert.match(userText, /No safe public OpenRouter model ID/);
    assert.match(userText, /unverified\/currentness-uncertain/);
    assert.doesNotMatch(userText, /atlas-coral/);
    const metricsEvent = emitted.find((event) => event.type === 'metrics:update');
    assert.equal(metricsEvent.metrics.freshness_check_used, undefined);
    assert.equal(metricsEvent.metrics.freshness_query_count, 0);
    assert.equal(metricsEvent.metrics.freshness_result_count, 0);
    assert.equal(metricsEvent.metrics.freshness_error, 'no_safe_model_id');
  });

  test('tool-enabled actions stop before the final provider turn if the run is cancelled after the tool loop resolves', async () => {
    const snapshot = createSnapshot();
    const emitted = [];
    const toolLoopCalls = [];
    const streamCalls = [];
    let manager;

    manager = new ActionRunManager({
      config: cloneConfig(),
      transcriptSnapshotProvider: () => snapshot,
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        async *streamChatCompletion(request) {
          streamCalls.push(request);
          yield {
            type: 'done',
            result: {
              content: 'should not stream',
              raw: {},
              warnings: [],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              metrics: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          };
        },
      },
      toolLoop: {
        async run(input) {
          toolLoopCalls.push(input);
          await manager.cancel({ runId: 'run-tech-cancel', branch: 'all' });
          return {
            messages: input.messages,
            evidenceText: '<code_context>\n[file: src/example.ts lines=42-42]\n...</code_context>',
            metrics: {
              tool_rounds: 1,
              tool_calls: 1,
              code_context_included: true,
            },
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: () => 'run-tech-cancel',
      now: createClock([0, 5, 10]),
      sessionId: 'meeting-123:tech-solver',
    });

    await manager.start({ actionId: 'tech-solver' });

    assert.equal(toolLoopCalls.length, 1);
    assert.equal(streamCalls.length, 0);
    assert.equal(emitted.some((event) => event.type === 'action:completed'), false);
    assert.equal(emitted.some((event) => event.type === 'action:cancelled'), true);
  });

  test('cache-control retry warnings surface through action:completed metrics in the runner path', async () => {
    const emitted = [];
    const fetchCalls = [];
    const toolLoop = createToolLoopStub();
    const client = new OpenRouterClient({
      config: cloneConfig().openrouter,
      fetch: async (url, init) => {
        fetchCalls.push({ url, init });
        if (fetchCalls.length === 1) {
          return jsonResponse({ error: { message: 'invalid cache_control formatting' } }, { status: 400 });
        }
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"Retry ok"}}]}',
          'data: [DONE]',
        ]);
      },
      apiKeyResolver: () => 'test-openrouter-key',
    });
    const manager = new ActionRunManager({
      config: cloneConfig(),
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: client,
      emitEvent: (event) => emitted.push(event),
      toolLoop,
      createRunId: () => 'run-retry',
      now: createClock([100, 110, 120, 130]),
      getCodeContext: () => 'Code context block',
    });

    await manager.start({ actionId: 'tech-solver' });

    assert.equal(fetchCalls.length, 2);
    assert.equal(toolLoop.calls.length, 1);
    assert.equal(emitted.at(-1).type, 'action:completed');
    assert.equal(emitted.at(-1).metrics.cache_control_retry, true);
    assert.equal(emitted.at(-1).metrics.success, true);
    assert.deepEqual(emitted.at(-1).warnings, ['cache_control_disabled_after_provider_rejection']);
  });

  test('provider context-limit errors surface a clear action:error message without fallback summarization', async () => {
    const emitted = [];
    const toolLoop = createToolLoopStub({
      evidenceText: '<code_context>\n[file: src/example.ts lines=1-3]\n...</code_context>',
    });
    const manager = new ActionRunManager({
      config: cloneConfig(),
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* () {
          throw new Error('Maximum context length exceeded: prompt too long for this meeting');
        },
      },
      emitEvent: (event) => emitted.push(event),
      toolLoop,
      createRunId: () => 'run-context-limit',
      now: createClock([50, 55]),
      getCodeContext: () => 'Code context block that pushes the limit',
    });

    await assert.rejects(
      () => manager.start({ actionId: 'deep-solution' }),
      /reduce code context/i
    );

    assert.equal(emitted[0].type, 'action:started');
    assert.equal(toolLoop.calls.length, 1);
    assert.equal(emitted.at(-1).type, 'action:error');
    assert.match(
      emitted.at(-1).error,
      /reduce code context|clear pinned context|start a new meeting\/session/i
    );
  });

  test('action start reads the latest pinned context at start time', async () => {
    const snapshot = createSnapshot();
    let pinnedContext = 'Pinned V1';
    const capturedContexts = [];

    const manager = new ActionRunManager({
      config: cloneConfig(),
      transcriptSnapshotProvider: () => snapshot,
      buildContext: (input) => {
        capturedContexts.push(input);
        return buildMeetingCopilotContext(input);
      },
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* () {
          yield {
            type: 'done',
            result: {
              content: 'done',
              raw: {},
              warnings: [],
              usage: undefined,
              metrics: {},
            },
          };
        },
      },
      emitEvent: () => {},
      createRunId: () => 'run-pinned',
      now: createClock([0, 10]),
      sessionId: 'meeting-123:pinned',
      getPinnedContext: () => pinnedContext,
    });

    pinnedContext = 'Pinned V2';
    await manager.start({ actionId: 'quick-answer' });

    assert.equal(capturedContexts.length, 1);
    assert.equal(capturedContexts[0].pinnedContext, 'Pinned V2');
  });

  test('action start waits for asynchronous pinned context loading before building context', async () => {
    const snapshot = createSnapshot();
    const capturedContexts = [];
    let resolvePinnedContext;
    const pinnedContextPromise = new Promise((resolve) => {
      resolvePinnedContext = resolve;
    });

    const manager = new ActionRunManager({
      config: cloneConfig(),
      transcriptSnapshotProvider: () => snapshot,
      buildContext: (input) => {
        capturedContexts.push(input);
        return buildMeetingCopilotContext(input);
      },
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* () {
          yield {
            type: 'done',
            result: {
              content: 'done',
              raw: {},
              warnings: [],
              usage: undefined,
              metrics: {},
            },
          };
        },
      },
      emitEvent: () => {},
      createRunId: () => 'run-pinned-async',
      now: createClock([0, 10]),
      sessionId: 'meeting-123:pinned-async',
      getPinnedContext: () => pinnedContextPromise,
    });

    const startPromise = manager.start({ actionId: 'quick-answer' });
    await flushMicrotasks();
    assert.equal(capturedContexts.length, 0);

    resolvePinnedContext('Persisted pinned context');
    await startPromise;

    assert.equal(capturedContexts.length, 1);
    assert.equal(capturedContexts[0].pinnedContext, 'Persisted pinned context');
  });

  test('streaming token events are bounded to 16k chars and completion emits TTFT and total latency metrics from the mocked stream clock', async () => {
    const emitted = [];
    const longToken = 'x'.repeat(20_000);
    const manager = new ActionRunManager({
      config: cloneConfig(),
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* () {
          yield { type: 'token', token: longToken };
          yield {
            type: 'done',
            result: {
              content: 'done',
              raw: {},
              warnings: [],
              usage: {
                prompt_tokens: 44,
                completion_tokens: 12,
                total_tokens: 56,
              },
              metrics: {
                prompt_tokens: 44,
                completion_tokens: 12,
                total_tokens: 56,
              },
            },
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: () => 'run-ttft',
      now: createClock([100, 125, 180]),
      sessionId: 'meeting-123:claim-check',
    });

    await manager.start({ actionId: 'claim-check' });

    assert.equal(emitted[1].type, 'action:token');
    assert.equal(emitted[1].token.length, 16_000);
    const completed = emitted.find((event) => event.type === 'action:completed');
    assert.equal(completed.metrics.time_to_first_token_ms, 25);
    assert.equal(completed.metrics.total_latency_ms, 80);
    assert.equal(completed.metrics.action_id, 'claim-check');
    assert.equal(completed.metrics.meeting_id, 'meeting-123');
    assert.equal(completed.metrics.success, true);
  });

  test('cancel aborts the active run and emits action:cancelled', async () => {
    const emitted = [];
    let capturedSignal;
    let releaseDone;
    const blocked = new Promise((resolve) => {
      releaseDone = resolve;
    });
    const manager = new ActionRunManager({
      config: cloneConfig(),
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          capturedSignal = request.signal;
          await blocked;
          yield {
            type: 'done',
            result: {
              content: '',
              raw: {},
              warnings: [],
              usage: undefined,
              metrics: {},
            },
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: () => 'run-cancel',
      now: createClock([0, 5, 10]),
      sessionId: 'meeting-123:followups',
    });

    const runPromise = manager.start({ actionId: 'followups' });
    await flushMicrotasks();
    await manager.cancel({ runId: 'run-cancel', branch: 'all' });
    assert.equal(capturedSignal.aborted, true);
    releaseDone();
    await runPromise;
    assert.deepEqual(emitted.at(-1), {
      type: 'action:cancelled',
      runId: 'run-cancel',
      branch: 'all',
    });
  });

  test('a second action start is rejected while another run is active without extra snapshot or OpenRouter calls', async () => {
    const emitted = [];
    const snapshotCalls = [];
    const openRouterCalls = [];
    let releaseDone;
    const blocked = new Promise((resolve) => {
      releaseDone = resolve;
    });
    const manager = new ActionRunManager({
      config: cloneConfig(),
      transcriptSnapshotProvider: () => {
        snapshotCalls.push('snapshot');
        return createSnapshot();
      },
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          openRouterCalls.push(request);
          await blocked;
          yield {
            type: 'done',
            result: {
              content: '',
              raw: {},
              warnings: [],
              usage: undefined,
              metrics: {},
            },
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: (() => {
        const ids = ['run-1', 'run-2'];
        return () => ids.shift();
      })(),
      now: createClock([0, 10, 20]),
      sessionId: 'meeting-123:single-active',
    });

    const firstRun = manager.start({ actionId: 'quick-answer' });
    await flushMicrotasks();

    await assert.rejects(
      () => manager.start({ actionId: 'claim-check' }),
      /Another Meeting Copilot action is already running/
    );

    assert.equal(snapshotCalls.length, 1);
    assert.equal(openRouterCalls.length, 1);
    assert.deepEqual(emitted.at(-1), {
      type: 'action:error',
      runId: 'run-2',
      error: 'Another Meeting Copilot action is already running in this slice',
    });

    releaseDone();
    await firstRun;
  });

  test('unknown action emits and throws a sanitized error', async () => {
    const emitted = [];
    const manager = new ActionRunManager({
      config: cloneConfig(),
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* () {},
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: () => 'run-missing',
      now: createClock([1]),
      sessionId: 'meeting-123:missing',
    });

    await assert.rejects(
      () => manager.start({ actionId: 'missing\nOPENROUTER_API_KEY=secret' }),
      /Meeting Copilot action/
    );

    assert.equal(emitted[0].type, 'action:error');
    assert.equal(emitted[0].runId, 'run-missing');
    assert.equal(/OPENROUTER_API_KEY=secret/.test(emitted[0].error), false);
  });

  test('tech-solver-parallel snapshots once, starts fast and deep streams concurrently, and keeps branch requests isolated', async () => {
    const snapshot = createSnapshot();
    const config = cloneConfig();
    const emitted = [];
    const snapshotCalls = [];
    const openRouterCalls = [];
    const fast = createBranchStreamController({ waitForToken: false });
    const deep = createBranchStreamController();
    const fastTokenSeen = deferred();

    const manager = new ActionRunManager({
      config,
      transcriptSnapshotProvider: () => {
        snapshotCalls.push('snapshot');
        return snapshot;
      },
      buildContext: (input) => {
        return buildMeetingCopilotContext(input);
      },
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          openRouterCalls.push(request);
          if (request.session_id?.endsWith(':deep')) {
            yield* deep.stream(request, 'Deep answer');
            return;
          }
          yield* fast.stream(request, 'Fast answer');
        },
      },
      emitEvent: (event) => {
        emitted.push(event);
        if (event.type === 'action:token' && event.pane === 'fast') {
          fastTokenSeen.resolve();
        }
      },
      toolLoop: createToolLoopStub({
        evidenceText: '<code_context>\n[file: src/example.ts lines=12-18]\n...</code_context>',
      }),
      createRunId: () => 'run-parallel',
      now: createClock([10, 20, 30, 40, 50, 60, 70, 80]),
      sessionId: ({ runId, actionId, branch }) =>
        branch ? `${runId}:${actionId}:${branch}` : `${runId}:${actionId}`,
    });

    const startPromise = manager.start({ actionId: 'tech-solver-parallel' });
    await flushMicrotasks();

    assert.equal(snapshotCalls.length, 1);
    const startedEvents = emitted.filter((event) => event.type === 'action:started');
    assert.equal(startedEvents.length, 1);
    await fastTokenSeen.promise;
    assert.equal(openRouterCalls.length, 2);
    assert.deepEqual(
      openRouterCalls.map((request) => ({
        model: request.model,
        cache_policy: request.cache_policy,
        session_id: request.session_id,
        messageCount: request.messages.length,
      })),
      [
        {
          model: config.actions['tech-solver-parallel'].parallel.fast.model,
          cache_policy: 'none',
          session_id: 'run-parallel:tech-solver-parallel:fast',
          messageCount: 2,
        },
        {
          model: config.actions['tech-solver-parallel'].parallel.deep.model,
          cache_policy: 'anthropic_explicit_1h',
          session_id: 'run-parallel:tech-solver-parallel:deep',
          messageCount: 2,
        },
      ]
    );

    deep.releaseToken.resolve();
    fast.releaseDone.resolve();
    deep.releaseDone.resolve();
    await Promise.resolve();
    await startPromise;

    assert.equal(
      emitted.filter((event) => event.type === 'action:token' && event.pane === 'fast').length,
      1
    );
    assert.equal(
      emitted.filter((event) => event.type === 'action:token' && event.pane === 'deep').length,
      1
    );
    assert.equal(
      emitted.filter((event) => event.type === 'action:completed').length,
      1
    );
    assert.equal(
      emitted.filter((event) => event.type === 'metrics:update').length,
      2
    );
  });

  test('deep branch failure emits a branch-local action:error without cancelling fast output', async () => {
    const emitted = [];
    let fastProceed;
    const fastProceedPromise = new Promise((resolve) => {
      fastProceed = resolve;
    });
    let fastStarted;
    const fastStartedPromise = new Promise((resolve) => {
      fastStarted = resolve;
    });
    let deepStarted;
    const deepStartedPromise = new Promise((resolve) => {
      deepStarted = resolve;
    });

    const manager = new ActionRunManager({
      config: cloneConfig(),
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          if (request.session_id?.endsWith(':deep')) {
            deepStarted();
            await Promise.resolve();
            throw new Error('deep branch exploded');
          }

          fastStarted();
          yield {
            type: 'token',
            token: 'Fast branch text',
          };
          await fastProceedPromise;
          yield {
            type: 'done',
            result: {
              content: 'Fast branch text',
              raw: {},
              warnings: [],
              usage: undefined,
              metrics: {},
            },
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      toolLoop: createToolLoopStub({
        evidenceText: '<code_context>\n[file: src/example.ts lines=12-18]\n...</code_context>',
      }),
      createRunId: () => 'run-branches',
      now: createClock([10, 20, 30, 40, 50, 60]),
      sessionId: ({ runId, actionId, branch }) =>
        branch ? `${runId}:${actionId}:${branch}` : `${runId}:${actionId}`,
    });

    const startPromise = manager.start({ actionId: 'tech-solver-parallel' });
    await flushMicrotasks();
    await Promise.all([fastStartedPromise, deepStartedPromise]);
    fastProceed();
    await startPromise;

    const errorEvent = emitted.find((event) => event.type === 'action:error');
    assert.equal(errorEvent.pane, 'deep');
    assert.equal(
      emitted.some((event) => event.type === 'action:token' && event.pane === 'fast'),
      true
    );
    assert.equal(emitted.at(-1).type, 'action:completed');
  });

  test('cancelling only the deep branch aborts the deep controller and leaves fast running', async () => {
    const emitted = [];
    let fastStarted;
    const fastStartedPromise = new Promise((resolve) => {
      fastStarted = resolve;
    });
    let deepStarted;
    const deepStartedPromise = new Promise((resolve) => {
      deepStarted = resolve;
    });
    let fastSignal;
    let deepSignal;
    let releaseFastDone;
    let releaseDeepDone;
    const fastDone = new Promise((resolve) => {
      releaseFastDone = resolve;
    });
    const deepDone = new Promise((resolve) => {
      releaseDeepDone = resolve;
    });

    const manager = new ActionRunManager({
      config: cloneConfig(),
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          if (request.session_id?.endsWith(':deep')) {
            deepSignal = request.signal;
            deepStarted();
            await deepDone;
            yield {
              type: 'done',
              result: {
                content: '',
                raw: {},
                warnings: [],
                usage: undefined,
                metrics: {},
              },
            };
            return;
          }

          fastSignal = request.signal;
          fastStarted();
          await fastDone;
          yield {
            type: 'done',
            result: {
              content: '',
              raw: {},
              warnings: [],
              usage: undefined,
              metrics: {},
            },
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      toolLoop: createToolLoopStub({
        evidenceText: '<code_context>\n[file: src/example.ts lines=12-18]\n...</code_context>',
      }),
      createRunId: () => 'run-cancel-branch',
      now: createClock([10, 20, 30, 40]),
      sessionId: ({ runId, actionId, branch }) =>
        branch ? `${runId}:${actionId}:${branch}` : `${runId}:${actionId}`,
    });

    const startPromise = manager.start({ actionId: 'tech-solver-parallel' });
    await flushMicrotasks();
    await Promise.all([fastStartedPromise, deepStartedPromise]);

    const result = await manager.cancel({ runId: 'run-cancel-branch', branch: 'deep' });
    assert.deepEqual(result, { cancelled: true });
    assert.equal(deepSignal.aborted, true);
    assert.equal(fastSignal.aborted, false);

    releaseDeepDone();
    releaseFastDone();
    await startPromise;

    assert.equal(
      emitted.some((event) => event.type === 'action:cancelled' && event.branch === 'deep'),
      true
    );
    assert.equal(emitted.at(-1).type, 'action:completed');
  });

  test('cancelling all branches aborts both branch controllers', async () => {
    let fastStarted;
    const fastStartedPromise = new Promise((resolve) => {
      fastStarted = resolve;
    });
    let deepStarted;
    const deepStartedPromise = new Promise((resolve) => {
      deepStarted = resolve;
    });
    let fastSignal;
    let deepSignal;
    let releaseFastDone;
    let releaseDeepDone;
    const fastDone = new Promise((resolve) => {
      releaseFastDone = resolve;
    });
    const deepDone = new Promise((resolve) => {
      releaseDeepDone = resolve;
    });

    const manager = new ActionRunManager({
      config: cloneConfig(),
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* (request) {
          if (request.session_id?.endsWith(':deep')) {
            deepSignal = request.signal;
            deepStarted();
            await deepDone;
            return;
          }

          fastSignal = request.signal;
          fastStarted();
          await fastDone;
          return;
        },
      },
      emitEvent: () => {},
      toolLoop: createToolLoopStub({
        evidenceText: '<code_context>\n[file: src/example.ts lines=12-18]\n...</code_context>',
      }),
      createRunId: () => 'run-cancel-all',
      now: createClock([10, 20, 30, 40]),
      sessionId: ({ runId, actionId, branch }) =>
        branch ? `${runId}:${actionId}:${branch}` : `${runId}:${actionId}`,
    });

    const startPromise = manager.start({ actionId: 'tech-solver-parallel' });
    await flushMicrotasks();
    await Promise.all([fastStartedPromise, deepStartedPromise]);

    const result = await manager.cancel({ runId: 'run-cancel-all', branch: 'all' });
    assert.deepEqual(result, { cancelled: true });
    assert.equal(deepSignal.aborted, true);
    assert.equal(fastSignal.aborted, true);

    releaseDeepDone();
    releaseFastDone();
    await startPromise;
  });

  test('tech-solver runs the tool loop before the final streamed answer and keeps tools out of the final stream request', async () => {
    const emitted = [];
    const toolLoopCalls = [];
    const streamCalls = [];
    const config = cloneConfig();
    config.code_context.max_total_chars = 777;
    const manager = new ActionRunManager({
      config,
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        async *streamChatCompletion(request) {
          streamCalls.push(request);
          yield {
            type: 'token',
            token: 'Final answer',
          };
          yield {
            type: 'done',
            result: {
              content: 'Final answer',
              raw: {},
              warnings: ['final-warning'],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              metrics: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          };
        },
      },
      toolLoop: {
        async run(input) {
          toolLoopCalls.push(input);
          return {
            messages: [
              { role: 'user', content: 'Find the implementation detail' },
              {
                role: 'assistant',
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
              {
                role: 'tool',
                tool_call_id: 'call-1',
                name: 'search_repo',
                content: '{"hits":[{"path":"src/example.ts","line":42}]}',
              },
            ],
            evidenceText: '<code_context>\n[file: src/example.ts lines=42-42]\n...</code_context>',
            metrics: {
              tool_rounds: 1,
              tool_calls: 1,
              code_context_included: true,
            },
            warnings: ['tool-warning'],
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: () => 'run-tech-tools',
      now: createClock([0, 5, 10, 20, 30]),
      sessionId: 'meeting-123:tech-solver',
    });

    await manager.start({ actionId: 'tech-solver' });

    assert.equal(toolLoopCalls.length, 1);
    assert.equal(toolLoopCalls[0].codeContextMaxChars, 777);
    assert.equal(streamCalls.length, 1);
    assert.equal(streamCalls[0].stream, true);
    assert.equal(streamCalls[0].tools, undefined);
    assert.equal(streamCalls[0].messages.some((message) => Array.isArray(message.tool_calls)), false);
    assert.deepEqual(
      emitted.filter((event) => event.type === 'action:started').map((event) => event.actionId),
      ['tech-solver']
    );
    const completed = emitted.find((event) => event.type === 'action:completed');
    assert.deepEqual(completed.warnings, ['tool-warning', 'final-warning']);
  });

  test('tech-solver-parallel runs the deep tool loop without blocking the fast branch', async () => {
    const emitted = [];
    const toolLoopCalls = [];
    const streamCalls = [];
    const gate = deferred();
    const config = cloneConfig();
    const manager = new ActionRunManager({
      config,
      transcriptSnapshotProvider: () => createSnapshot(),
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        async *streamChatCompletion(request) {
          streamCalls.push(request);
          if (request.model === config.actions['tech-solver-parallel'].parallel.deep.model) {
            await gate.promise;
          }
          yield {
            type: 'done',
            result: {
              content: request.model,
              raw: {},
              warnings: [],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              metrics: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          };
        },
      },
      toolLoop: {
        async run(input) {
          toolLoopCalls.push(input);
          return {
            messages: input.messages,
            evidenceText: '<code_context>\n[file: src/example.ts lines=12-18]\n...</code_context>',
            metrics: { tool_rounds: 1, tool_calls: 1, code_context_included: true },
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      createRunId: () => 'run-parallel-tools',
      now: createClock([0, 1, 2, 3, 4, 5, 6, 7]),
      sessionId: 'meeting-123:tech-solver-parallel',
    });

    const startPromise = manager.start({ actionId: 'tech-solver-parallel' });
    await flushMicrotasks();
    gate.resolve();
    await startPromise;

    assert.equal(toolLoopCalls.length, 1);
    assert.equal(streamCalls.length, 2);
    assert.equal(streamCalls.some((request) => request.model === config.actions['tech-solver-parallel'].parallel.fast.model), true);
    assert.equal(streamCalls.some((request) => request.model === config.actions['tech-solver-parallel'].parallel.deep.model), true);
    assert.equal(emitted.filter((event) => event.type === 'action:started').length, 1);
  });
});
