import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const {
  RIPGREP_REQUIRED_MESSAGE,
  CodeTools,
} = await import(pathToFileURL(path.join(distRoot, 'CodeTools.js')).href);
const { CodeWorkspaceStore } = await import(
  pathToFileURL(path.join(distRoot, 'CodeWorkspaceStore.js')).href
);

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-copilot-code-tools-'));
}

function makeWorkspace(root, overrides = {}) {
  return {
    name: 'repo',
    path: root,
    enabled: true,
    max_snippets: 3,
    max_snippet_chars: 240,
    ...overrides,
  };
}

function createSpawnStub(options = {}) {
  const calls = [];
  const queue = [...(options.responses ?? [])];
  const spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, spawnOptions });
    const response = queue.shift() ?? {};
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = {
      stdout,
      stderr,
      on(event, listener) {
        if (event === 'close') {
          process.nextTick(() => listener(response.exitCode ?? 0));
        }
        if (event === 'error' && response.error) {
          process.nextTick(() => listener(response.error));
        }
        return child;
      },
      once(event, listener) {
        return child.on(event, listener);
      },
    };
    process.nextTick(() => {
      if (response.stdout) stdout.end(response.stdout);
      else stdout.end('');
      if (response.stderr) stderr.end(response.stderr);
      else stderr.end('');
    });
    return child;
  };
  return { calls, spawn };
}

before(() => {
  assert.equal(typeof CodeWorkspaceStore, 'function');
  assert.equal(typeof CodeTools, 'function');
});

after(() => {});

describe('meeting-copilot code tools', () => {
  test('CodeWorkspaceStore.listEnabled returns only enabled workspaces with normalized absolute POSIX paths', () => {
    const tempRoot = makeTempRoot();
    try {
      const nested = path.join(tempRoot, 'repo');
      fs.mkdirSync(nested, { recursive: true });
      const store = new CodeWorkspaceStore([
        makeWorkspace(nested, { name: 'repo-a' }),
        makeWorkspace(path.join(tempRoot, 'disabled'), { name: 'repo-b', enabled: false }),
      ]);

      assert.deepEqual(store.listEnabled(), [
        {
          name: 'repo-a',
          path: path.resolve(nested).split(path.sep).join('/'),
          enabled: true,
          max_snippets: 3,
          max_snippet_chars: 240,
        },
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('resolveWorkspacePath accepts relative file paths inside the workspace and rejects traversal and foreign absolute paths', () => {
    const tempRoot = makeTempRoot();
    try {
      const workspaceRoot = path.join(tempRoot, 'repo');
      fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      const store = new CodeWorkspaceStore([makeWorkspace(workspaceRoot)]);

      const resolved = store.resolveWorkspacePath({ targetPath: 'src/index.ts' });
      assert.equal(resolved.workspace.name, 'repo');
      assert.equal(resolved.absolutePath, path.resolve(workspaceRoot, 'src/index.ts'));
      assert.equal(resolved.relativePath, 'src/index.ts');

      assert.throws(() => store.resolveWorkspacePath({ targetPath: '../outside.ts' }), /outside the enabled workspace/i);
      assert.throws(() => store.resolveWorkspacePath({ targetPath: path.join(tempRoot, 'outside.ts') }), /outside the enabled workspace/i);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('readFileSlice rejects excluded files and directories before reading', async () => {
    const tempRoot = makeTempRoot();
    try {
      const workspaceRoot = path.join(tempRoot, 'repo');
      fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });
      fs.mkdirSync(path.join(workspaceRoot, 'node_modules/pkg'), { recursive: true });
      fs.mkdirSync(path.join(workspaceRoot, 'dist'), { recursive: true });
      fs.mkdirSync(path.join(workspaceRoot, 'build'), { recursive: true });
      fs.mkdirSync(path.join(workspaceRoot, 'target'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, '.env'), 'SECRET=1');
      fs.writeFileSync(path.join(workspaceRoot, 'id_rsa'), 'PRIVATE KEY');
      fs.writeFileSync(path.join(workspaceRoot, 'cert.pem'), 'CERT');
      fs.writeFileSync(path.join(workspaceRoot, '.git', 'config'), 'x');
      fs.writeFileSync(path.join(workspaceRoot, 'node_modules', 'pkg', 'index.js'), 'x');
      fs.writeFileSync(path.join(workspaceRoot, 'dist', 'bundle.js'), 'x');
      fs.writeFileSync(path.join(workspaceRoot, 'build', 'bundle.js'), 'x');
      fs.writeFileSync(path.join(workspaceRoot, 'target', 'bundle.js'), 'x');

      const store = new CodeWorkspaceStore([makeWorkspace(workspaceRoot)]);
      const tools = new CodeTools({
        workspaceStore: store,
        codeContext: {
          enabled: true,
          retrieval_mode: 'tool_loop',
          max_total_chars: 10_000,
          include_file_paths: true,
          include_line_numbers: true,
        },
        readFile: async (filePath) => fs.promises.readFile(filePath, 'utf8'),
      });

      await assert.rejects(() => tools.readFileSlice({ path: '.env' }), /excluded/i);
      await assert.rejects(() => tools.readFileSlice({ path: 'id_rsa' }), /excluded/i);
      await assert.rejects(() => tools.readFileSlice({ path: 'cert.pem' }), /excluded/i);
      await assert.rejects(() => tools.readFileSlice({ path: '.git/config' }), /excluded/i);
      await assert.rejects(() => tools.readFileSlice({ path: 'node_modules/pkg/index.js' }), /excluded/i);
      await assert.rejects(() => tools.readFileSlice({ path: 'dist/bundle.js' }), /excluded/i);
      await assert.rejects(() => tools.readFileSlice({ path: 'build/bundle.js' }), /excluded/i);
      await assert.rejects(() => tools.readFileSlice({ path: 'target/bundle.js' }), /excluded/i);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('readFileSlice bounds line ranges and redacts secrets in returned content', async () => {
    const tempRoot = makeTempRoot();
    try {
      const workspaceRoot = path.join(tempRoot, 'repo');
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceRoot, 'src', 'config.ts'),
        [
          'line 1',
          'Authorization: Bearer sk-test-123',
          'password: secret',
          'api_key = value',
          '-----BEGIN PRIVATE KEY-----',
          'line 6',
        ].join('\n')
      );

      const store = new CodeWorkspaceStore([makeWorkspace(workspaceRoot)]);
      const tools = new CodeTools({
        workspaceStore: store,
        codeContext: {
          enabled: true,
          retrieval_mode: 'tool_loop',
          max_total_chars: 120,
          include_file_paths: true,
          include_line_numbers: true,
        },
        readFile: async (filePath) => fs.promises.readFile(filePath, 'utf8'),
      });

      const result = await tools.readFileSlice({
        path: 'src/config.ts',
        startLine: 2,
        endLine: 5,
      });

      assert.equal(result.path, 'src/config.ts');
      assert.equal(result.startLine, 2);
      assert.equal(result.endLine, 5);
      assert.doesNotMatch(result.content, /sk-test-123|secret|value|BEGIN PRIVATE KEY/);
      assert.match(result.content, /Authorization: Bearer \[REDACTED\]/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('readFileSlice clamps explicit endLine to the maximum read window', async () => {
    const tempRoot = makeTempRoot();
    try {
      const workspaceRoot = path.join(tempRoot, 'repo');
      fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceRoot, 'src', 'large.ts'),
        Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join('\n')
      );

      const store = new CodeWorkspaceStore([
        makeWorkspace(workspaceRoot, { max_snippet_chars: 20_000 }),
      ]);
      const tools = new CodeTools({
        workspaceStore: store,
        codeContext: {
          enabled: true,
          retrieval_mode: 'tool_loop',
          max_total_chars: 20_000,
          include_file_paths: true,
          include_line_numbers: true,
        },
        readFile: async (filePath) => fs.promises.readFile(filePath, 'utf8'),
      });

      const result = await tools.readFileSlice({
        path: 'src/large.ts',
        startLine: 10,
        endLine: 400,
      });

      assert.equal(result.startLine, 10);
      assert.equal(result.endLine, 249);
      assert.match(result.content, /line 249/);
      assert.doesNotMatch(result.content, /line 250/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('readFileSlice redacts quoted api keys, passwords, and tokens', async () => {
    const tempRoot = makeTempRoot();
    try {
      const workspaceRoot = path.join(tempRoot, 'repo');
      fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceRoot, 'src', 'secrets.ts'),
        [
          'OPENROUTER_API_KEY="sk-openrouter-secret"',
          "api_key='quoted-api-secret'",
          'password: "quoted-password-secret"',
          "token = 'quoted-token-secret'",
        ].join('\n')
      );

      const store = new CodeWorkspaceStore([makeWorkspace(workspaceRoot)]);
      const tools = new CodeTools({
        workspaceStore: store,
        codeContext: {
          enabled: true,
          retrieval_mode: 'tool_loop',
          max_total_chars: 10_000,
          include_file_paths: true,
          include_line_numbers: true,
        },
        readFile: async (filePath) => fs.promises.readFile(filePath, 'utf8'),
      });

      const result = await tools.readFileSlice({ path: 'src/secrets.ts' });

      assert.doesNotMatch(
        result.content,
        /sk-openrouter-secret|quoted-api-secret|quoted-password-secret|quoted-token-secret/
      );
      assert.match(result.content, /OPENROUTER_API_KEY=\[REDACTED\]/);
      assert.match(result.content, /api_key=\[REDACTED\]/);
      assert.match(result.content, /password: \[REDACTED\]/);
      assert.match(result.content, /token = \[REDACTED\]/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('searchRepo rejects empty and oversized queries, uses rg with argv array, appends default excludes, and reports missing rg with the required message', async () => {
    const tempRoot = makeTempRoot();
    try {
      const workspaceRoot = path.join(tempRoot, 'repo');
      fs.mkdirSync(workspaceRoot, { recursive: true });

      const { calls, spawn } = createSpawnStub({
        responses: [
          {
            stdout: 'src/app.ts:12:3:Authorization: Bearer sk-test\n',
            exitCode: 0,
          },
        ],
      });

      const store = new CodeWorkspaceStore([makeWorkspace(workspaceRoot)]);
      const tools = new CodeTools({
        workspaceStore: store,
        codeContext: {
          enabled: true,
          retrieval_mode: 'tool_loop',
          max_total_chars: 120,
          include_file_paths: true,
          include_line_numbers: true,
        },
        spawn,
      });

      await assert.rejects(() => tools.searchRepo({ query: '' }), /query/i);
      await assert.rejects(() => tools.searchRepo({ query: 'x'.repeat(241) }), /query/i);

      const hits = await tools.searchRepo({ query: 'Authorization' });
      assert.equal(calls[0].command, 'rg');
      assert.equal(calls[0].spawnOptions.cwd, path.resolve(workspaceRoot));
      assert.equal(calls[0].spawnOptions.shell, false);
      assert.ok(Array.isArray(calls[0].args));
      assert.ok(calls[0].args.includes('--line-number'));
      assert.ok(calls[0].args.includes('--column'));
      assert.ok(calls[0].args.includes('--no-heading'));
      assert.ok(calls[0].args.includes('--color'));
      assert.ok(calls[0].args.includes('never'));
      assert.ok(calls[0].args.some((arg) => arg === '--glob'));
      assert.ok(calls[0].args.some((arg) => arg === '!node_modules/'));
      assert.ok(calls[0].args.some((arg) => arg === 'Authorization'));
      assert.equal(hits.length, 1);
      assert.match(hits[0].preview, /Authorization: Bearer \[REDACTED\]/);

      const missingTools = new CodeTools({
        workspaceStore: store,
        codeContext: {
          enabled: true,
          retrieval_mode: 'tool_loop',
          max_total_chars: 120,
          include_file_paths: true,
          include_line_numbers: true,
        },
        spawn: () => {
          const err = new Error('spawn rg missing');
          err.code = 'ENOENT';
          throw err;
        },
      });
      await assert.rejects(
        () => missingTools.searchRepo({ query: 'Authorization' }),
        (error) => error instanceof Error && error.message === RIPGREP_REQUIRED_MESSAGE
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('search hits are capped by max snippets and preview content is redacted', async () => {
    const tempRoot = makeTempRoot();
    try {
      const workspaceRoot = path.join(tempRoot, 'repo');
      fs.mkdirSync(workspaceRoot, { recursive: true });
      const { spawn } = createSpawnStub({
        responses: [
          {
            stdout: [
              'src/a.ts:1:1:Authorization: Bearer sk-a',
              'src/b.ts:2:1:Authorization: Bearer sk-b',
              'src/c.ts:3:1:Authorization: Bearer sk-c',
              'src/d.ts:4:1:Authorization: Bearer sk-d',
            ].join('\n'),
            exitCode: 0,
          },
        ],
      });

      const store = new CodeWorkspaceStore([makeWorkspace(workspaceRoot, { max_snippets: 2, max_snippet_chars: 40 })]);
      const tools = new CodeTools({
        workspaceStore: store,
        codeContext: {
          enabled: true,
          retrieval_mode: 'tool_loop',
          max_total_chars: 40,
          include_file_paths: true,
          include_line_numbers: true,
        },
        spawn,
      });

      const hits = await tools.searchRepo({ query: 'Authorization' });
      assert.equal(hits.length, 2);
      assert.doesNotMatch(hits[0].preview, /sk-a|sk-b|sk-c|sk-d/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
