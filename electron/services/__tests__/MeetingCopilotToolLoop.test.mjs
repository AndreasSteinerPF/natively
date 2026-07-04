import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

async function loadToolLoopModule() {
  return import(pathToFileURL(path.join(distRoot, 'ToolLoop.js')).href);
}

function fakeOpenRouterClient() {
  const calls = [];
  return {
    calls,
    async createChatCompletion(request) {
      calls.push(request);
      if (calls.length > 1) {
        return {
          content: 'Final answer',
          raw: {},
          warnings: [],
          metrics: {},
        };
      }
      return {
        content: '',
        raw: {},
        warnings: [],
        metrics: {},
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'search_repo',
              arguments: JSON.stringify({ query: 'ToolLoop', workspace: 'app' }),
            },
          },
        ],
      };
    },
  };
}

function fakeCodeTools() {
  return {
    calls: [],
    async listWorkspaces() {
      this.calls.push(['listWorkspaces']);
      return [{ name: 'app', path: '/repo/app', enabled: true }];
    },
    async searchRepo(input) {
      this.calls.push(['searchRepo', input]);
      return [
        {
          workspace: 'app',
          path: 'src/example.ts',
          line: 42,
          preview: 'ToolLoop search hit',
        },
      ];
    },
    async readFileSlice(input) {
      this.calls.push(['readFileSlice', input]);
      return {
        workspace: 'app',
        path: 'src/example.ts',
        startLine: 40,
        endLine: 50,
        content: 'const example = true;',
      };
    },
  };
}

function createToolCallResponse(toolCalls, content = '') {
  return {
    content,
    raw: {},
    warnings: [],
    metrics: {},
    tool_calls: toolCalls,
  };
}

describe('meeting-copilot tool loop', () => {
  test('exports the bounded code tool schemas for the three read-only tools only', async () => {
    const mod = await loadToolLoopModule();

    assert.deepEqual(
      mod.CODE_TOOL_SCHEMAS.map((schema) => schema.function.name),
      ['list_workspaces', 'search_repo', 'read_file']
    );
  });

  test('runs one tool round, emits compact status, and returns distilled code evidence without raw tool history', async () => {
    const mod = await loadToolLoopModule();
    const openRouterClient = fakeOpenRouterClient();
    const codeTools = fakeCodeTools();
    const statuses = [];
    const loop = new mod.ToolLoop({
      openRouterClient,
      codeTools,
    });

    const result = await loop.run({
      runId: 'run-001',
      pane: 'deep',
      messages: [{ role: 'user', content: 'Find the implementation detail' }],
      session_id: 'meeting-123:deep-solution',
      codeContextMaxChars: 600,
      branchConfig: {
        model: 'anthropic/claude-opus-4.8-fast',
        max_tokens: 1200,
        temperature: 0.2,
        cache_policy: 'anthropic_explicit_1h',
        reasoning: { effort: 'medium' },
        tools_enabled: true,
        max_tool_rounds: 2,
        max_tool_calls_per_round: 2,
        prompt: 'Analyze the technical/product problem deeply.',
      },
      emitStatus(message) {
        statuses.push(message);
      },
      signal: new AbortController().signal,
    });

    assert.equal(openRouterClient.calls.length, 2);
    assert.equal(codeTools.calls.length, 1);
    assert.deepEqual(codeTools.calls[0][0], 'searchRepo');
    assert.match(String(statuses[0]), /Searching repo/i);
    assert.match(String(statuses.at(-1)), /Generating final answer/i);
    assert.equal(result.metrics.tool_rounds, 2);
    assert.equal(result.metrics.tool_calls, 1);
    assert.equal(result.metrics.code_context_included, true);
    assert.match(result.evidenceText, /<code_context>/);
    assert.match(result.evidenceText, /src\/example\.ts/);
    assert.match(result.evidenceText, /lines=42-42/);
    assert.doesNotMatch(result.evidenceText, /tool_calls|Searching repo|Generating final answer/i);
  });

  test('rejects invalid tool arguments before calling local code tools', async () => {
    const mod = await loadToolLoopModule();
    const codeTools = fakeCodeTools();
    const openRouterClient = {
      calls: [],
      async createChatCompletion(request) {
        this.calls.push(request);
        return createToolCallResponse([
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'search_repo',
              arguments: JSON.stringify({
                query: ''.padEnd(241, 'x'),
                extra: true,
              }),
            },
          },
        ]);
      },
    };

    const loop = new mod.ToolLoop({
      openRouterClient,
      codeTools,
    });

    await assert.rejects(
      () =>
        loop.run({
          runId: 'run-invalid-search-extra',
          pane: 'main',
          messages: [{ role: 'user', content: 'Find the implementation detail' }],
          session_id: 'meeting-123:quick-answer',
          codeContextMaxChars: 600,
          branchConfig: {
            model: 'anthropic/claude-opus-4.8-fast',
            max_tokens: 1200,
            temperature: 0.2,
            cache_policy: 'none',
            reasoning: { effort: 'low' },
            tools_enabled: true,
            max_tool_rounds: 1,
            max_tool_calls_per_round: 1,
            prompt: 'Analyze the technical/product problem deeply.',
          },
          emitStatus() {},
          signal: new AbortController().signal,
        }),
      /Meeting Copilot search_repo tool does not accept additional properties/i
    );
    assert.equal(codeTools.calls.length, 0);

    const listWorkspacesClient = {
      calls: [],
      async createChatCompletion(request) {
        this.calls.push(request);
        return createToolCallResponse([
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'list_workspaces',
              arguments: JSON.stringify({ extra: true }),
            },
          },
        ]);
      },
    };
    const listWorkspacesLoop = new mod.ToolLoop({
      openRouterClient: listWorkspacesClient,
      codeTools: fakeCodeTools(),
    });

    await assert.rejects(
      () =>
        listWorkspacesLoop.run({
          runId: 'run-invalid-list',
          pane: 'main',
          messages: [{ role: 'user', content: 'List workspaces' }],
          session_id: 'meeting-123:quick-answer',
          codeContextMaxChars: 600,
          branchConfig: {
            model: 'anthropic/claude-opus-4.8-fast',
            max_tokens: 1200,
            temperature: 0.2,
            cache_policy: 'none',
            reasoning: { effort: 'low' },
            tools_enabled: true,
            max_tool_rounds: 1,
            max_tool_calls_per_round: 1,
            prompt: 'Analyze the technical/product problem deeply.',
          },
          emitStatus() {},
          signal: new AbortController().signal,
        }),
      /Meeting Copilot list_workspaces tool does not accept additional properties/i
    );
    assert.equal(listWorkspacesClient.calls.length, 1);

    const searchQueryClient = {
      calls: [],
      async createChatCompletion(request) {
        this.calls.push(request);
        return createToolCallResponse([
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'search_repo',
              arguments: JSON.stringify({ query: ''.padEnd(241, 'x') }),
            },
          },
        ]);
      },
    };
    const searchQueryLoop = new mod.ToolLoop({
      openRouterClient: searchQueryClient,
      codeTools: fakeCodeTools(),
    });

    await assert.rejects(
      () =>
        searchQueryLoop.run({
          runId: 'run-invalid-search-query',
          pane: 'main',
          messages: [{ role: 'user', content: 'Find the implementation detail' }],
          session_id: 'meeting-123:quick-answer',
          codeContextMaxChars: 600,
          branchConfig: {
            model: 'anthropic/claude-opus-4.8-fast',
            max_tokens: 1200,
            temperature: 0.2,
            cache_policy: 'none',
            reasoning: { effort: 'low' },
            tools_enabled: true,
            max_tool_rounds: 1,
            max_tool_calls_per_round: 1,
            prompt: 'Analyze the technical/product problem deeply.',
          },
          emitStatus() {},
          signal: new AbortController().signal,
        }),
      /Meeting Copilot search_repo tool requires a query string between 1 and 240 characters/i
    );
    assert.equal(searchQueryClient.calls.length, 1);
    assert.equal(codeTools.calls.length, 0);

    const readFileClient = {
      calls: [],
      async createChatCompletion(request) {
        this.calls.push(request);
        return createToolCallResponse([
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'src/example.ts', start_line: 0 }),
            },
          },
        ]);
      },
    };
    const readFileLoop = new mod.ToolLoop({
      openRouterClient: readFileClient,
      codeTools: fakeCodeTools(),
    });

    await assert.rejects(
      () =>
        readFileLoop.run({
          runId: 'run-invalid-read',
          pane: 'main',
          messages: [{ role: 'user', content: 'Inspect the file' }],
          session_id: 'meeting-123:deep-solution',
          codeContextMaxChars: 600,
          branchConfig: {
            model: 'anthropic/claude-opus-4.8-fast',
            max_tokens: 1200,
            temperature: 0.2,
            cache_policy: 'none',
            reasoning: { effort: 'medium' },
            tools_enabled: true,
            max_tool_rounds: 1,
            max_tool_calls_per_round: 1,
            prompt: 'Analyze the technical/product problem deeply.',
          },
          emitStatus() {},
          signal: new AbortController().signal,
        }),
      /Meeting Copilot read_file tool start_line must be a positive integer/i
    );
    assert.equal(readFileClient.calls.length, 1);
  });

  test('redacts provider-bound tool result messages and keeps them valid JSON', async () => {
    const mod = await loadToolLoopModule();
    const openRouterClient = {
      calls: [],
      async createChatCompletion(request) {
        this.calls.push(request);
        if (this.calls.length === 1) {
          return createToolCallResponse([
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({ path: 'src/secret.ts', start_line: 1, end_line: 2 }),
              },
            },
          ]);
        }
        return createToolCallResponse([], 'Final answer');
      },
    };
    const codeTools = {
      async listWorkspaces() {
        return [];
      },
      async searchRepo() {
        return [];
      },
      async readFileSlice() {
        return {
          workspace: 'app',
          path: 'src/secret.ts',
          startLine: 1,
          endLine: 2,
          content: 'Authorization: Bearer sk-test-secret\n' + 'x'.repeat(10_000),
        };
      },
    };

    const loop = new mod.ToolLoop({
      openRouterClient,
      codeTools,
    });

    await loop.run({
      runId: 'run-redaction',
      pane: 'main',
      messages: [{ role: 'user', content: 'Inspect the file' }],
      session_id: 'meeting-123:deep-solution',
      codeContextMaxChars: 600,
      branchConfig: {
        model: 'anthropic/claude-opus-4.8-fast',
        max_tokens: 1200,
        temperature: 0.2,
        cache_policy: 'none',
        reasoning: { effort: 'medium' },
        tools_enabled: true,
        max_tool_rounds: 2,
        max_tool_calls_per_round: 1,
        prompt: 'Analyze the technical/product problem deeply.',
      },
      emitStatus() {},
      signal: new AbortController().signal,
    });

    assert.equal(openRouterClient.calls.length, 2);
    const toolMessage = openRouterClient.calls[1].messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage, 'expected a tool message to be appended for the provider');
    assert.doesNotThrow(() => JSON.parse(toolMessage.content));
    assert.doesNotMatch(toolMessage.content, /sk-test-secret/);
    assert.doesNotMatch(toolMessage.content, /\.\.\./);
  });

  test('stops before the first provider round when the signal is already aborted', async () => {
    const mod = await loadToolLoopModule();
    const codeTools = fakeCodeTools();
    const openRouterClient = {
      calls: [],
      async createChatCompletion(request) {
        this.calls.push(request);
        return createToolCallResponse([], 'Final answer');
      },
    };
    const controller = new AbortController();
    controller.abort();

    const loop = new mod.ToolLoop({
      openRouterClient,
      codeTools,
    });

    await assert.rejects(
      () =>
        loop.run({
          runId: 'run-aborted-before-round',
          pane: 'main',
          messages: [{ role: 'user', content: 'Find the implementation detail' }],
          session_id: 'meeting-123:quick-answer',
          codeContextMaxChars: 600,
          branchConfig: {
            model: 'anthropic/claude-opus-4.8-fast',
            max_tokens: 1200,
            temperature: 0.2,
            cache_policy: 'none',
            reasoning: { effort: 'low' },
            tools_enabled: true,
            max_tool_rounds: 1,
            max_tool_calls_per_round: 1,
            prompt: 'Analyze the technical/product problem deeply.',
          },
          emitStatus() {},
          signal: controller.signal,
        }),
      /abort/i
    );

    assert.equal(openRouterClient.calls.length, 0);
    assert.equal(codeTools.calls.length, 0);
  });

  test('stops after a local tool call resolves if the signal aborts before the next provider turn', async () => {
    const mod = await loadToolLoopModule();
    const openRouterClient = {
      calls: [],
      async createChatCompletion(request) {
        this.calls.push(request);
        if (this.calls.length === 1) {
          return createToolCallResponse([
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'search_repo',
                arguments: JSON.stringify({ query: 'ToolLoop' }),
              },
            },
          ]);
        }
        return createToolCallResponse([], 'Final answer');
      },
    };
    let abortSignal;
    const codeTools = {
      async listWorkspaces() {
        return [];
      },
      async searchRepo(input) {
        abortSignal?.abort();
        return [{ workspace: 'app', path: 'src/example.ts', line: 42, preview: input.query }];
      },
      async readFileSlice() {
        return {
          workspace: 'app',
          path: 'src/example.ts',
          startLine: 1,
          endLine: 2,
          content: 'example',
        };
      },
    };
    const controller = new AbortController();
    abortSignal = controller;
    const loop = new mod.ToolLoop({
      openRouterClient,
      codeTools,
    });

    await assert.rejects(
      () =>
        loop.run({
          runId: 'run-abort-after-tool',
          pane: 'deep',
          messages: [{ role: 'user', content: 'Find the implementation detail' }],
          session_id: 'meeting-123:deep-solution',
          codeContextMaxChars: 600,
          branchConfig: {
            model: 'anthropic/claude-opus-4.8-fast',
            max_tokens: 1200,
            temperature: 0.2,
            cache_policy: 'none',
            reasoning: { effort: 'medium' },
            tools_enabled: true,
            max_tool_rounds: 2,
            max_tool_calls_per_round: 1,
            prompt: 'Analyze the technical/product problem deeply.',
          },
          emitStatus() {},
          signal: controller.signal,
        }),
      /abort/i
    );

    assert.equal(openRouterClient.calls.length, 1);
  });
});
