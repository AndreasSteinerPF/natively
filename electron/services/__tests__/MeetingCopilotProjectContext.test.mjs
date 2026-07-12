import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const {
  DEFAULT_MEETING_COPILOT_CONFIG,
  DEFAULT_MEETING_COPILOT_STABLE_INSTRUCTIONS,
  SYSTEM_DESIGN_MEETING_COPILOT_STABLE_INSTRUCTIONS,
  getDefaultMeetingCopilotConfig,
  getMeetingCopilotStableInstructions,
} = await import(
  pathToFileURL(path.join(distRoot, 'defaultActionConfig.js')).href
);
const { validateMeetingCopilotConfig } = await import(
  pathToFileURL(path.join(distRoot, 'ActionConfigStore.js')).href
);
const { ProjectContextStore } = await import(
  pathToFileURL(path.join(distRoot, 'ProjectContextStore.js')).href
);
const { buildMeetingCopilotContext } = await import(
  pathToFileURL(path.join(distRoot, 'ContextBuilder.js')).href
);
const { buildOpenRouterMessages } = await import(
  pathToFileURL(path.join(distRoot, 'PromptCache.js')).href
);
const { ActionRunManager } = await import(
  pathToFileURL(path.join(distRoot, 'ActionRunManager.js')).href
);
const { MetricsStore } = await import(
  pathToFileURL(path.join(distRoot, 'MetricsStore.js')).href
);

let tempRoot = '';

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-copilot-project-context-'));
});

after(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

async function createPackDir(name) {
  const dir = path.join(tempRoot, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeFile(relativePath, content) {
  const filePath = path.join(tempRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

function cloneConfig() {
  return structuredClone(DEFAULT_MEETING_COPILOT_CONFIG);
}

function createSnapshot() {
  return {
    meeting_id: 'meeting-123',
    chunks: [
      {
        id: 'chunk-001',
        meeting_id: 'meeting-123',
        start_ts: '2026-07-03T10:00:00.000Z',
        end_ts: '2026-07-03T10:00:30.000Z',
        text: 'The transcript should stay recent-only by default.',
        source: 'mic',
      },
    ],
  };
}

describe('meeting-copilot project context packs', () => {
  test('default config keeps project context disabled with no packs', () => {
    assert.equal(DEFAULT_MEETING_COPILOT_CONFIG.project_context.enabled, false);
    assert.deepEqual(DEFAULT_MEETING_COPILOT_CONFIG.project_context.packs, []);
  });

  test('default stable instructions include evidence hierarchy and docs-vs-code rule', () => {
    assert.match(DEFAULT_MEETING_COPILOT_STABLE_INSTRUCTIONS, /Evidence hierarchy/);
    assert.match(DEFAULT_MEETING_COPILOT_STABLE_INSTRUCTIONS, /Project docs are useful orientation/);
    assert.match(DEFAULT_MEETING_COPILOT_STABLE_INSTRUCTIONS, /Actual repo code is the source of truth/);
    assert.match(DEFAULT_MEETING_COPILOT_STABLE_INSTRUCTIONS, /When docs and code disagree, prefer code/);
  });

  test('system-design stable instructions prioritize screenshot context and reject stale prior problems', () => {
    const config = getDefaultMeetingCopilotConfig('system-design-interview');
    const instructions = getMeetingCopilotStableInstructions(config);

    assert.equal(instructions, SYSTEM_DESIGN_MEETING_COPILOT_STABLE_INSTRUCTIONS);
    assert.match(instructions, /Attached screenshot\/board\/problem statement is the source of truth/);
    assert.match(instructions, /Prior Guide Me \/ Go Deeper outputs are continuity hints only/);
    assert.match(instructions, /Only use details that appear in the attached screenshot, current transcript, or pinned context/);
    assert.doesNotMatch(instructions, /Uber|Twitter|TMF641|Blue Steel/);
    assert.doesNotMatch(instructions, /Use project docs for orientation/);
    assert.doesNotMatch(instructions, /Actual repo code is the source of truth/);
  });

  test('config validation accepts an enabled project context pack', () => {
    const config = validateMeetingCopilotConfig({
      ...cloneConfig(),
      project_context: {
        enabled: true,
        max_docs_chars_per_pack: 20_000,
        max_total_docs_chars: 40_000,
        packs: [
          {
            name: 'main-product',
            docsPath: path.join(tempRoot, 'main-product-docs'),
            linkedWorkspaceName: 'main-product-repo',
            enabled: true,
            includeByDefault: true,
            maxDocsChars: 12_000,
          },
        ],
      },
    });

    assert.equal(config.project_context.enabled, true);
    assert.equal(config.project_context.packs[0].name, 'main-product');
  });

  test('missing docs path returns a warning and an empty bundle', async () => {
    const store = new ProjectContextStore({
      enabled: true,
      max_docs_chars_per_pack: 1_000,
      max_total_docs_chars: 2_000,
      packs: [
        {
          name: 'missing',
          docsPath: path.join(tempRoot, 'does-not-exist'),
          enabled: true,
          includeByDefault: true,
          maxDocsChars: 1_000,
        },
      ],
    });

    const bundle = await store.loadDefaultBundle();

    assert.equal(bundle.included, false);
    assert.equal(bundle.files.length, 0);
    assert.equal(bundle.text, '');
    assert.ok(bundle.warnings.some((warning) => /missing/i.test(warning)));
  });

  test('includes only markdown and text files while skipping excluded paths', async () => {
    const docsDir = await createPackDir('docs-only');
    await writeFile('docs-only/00-overview.md', '# Overview\nThis is included.');
    await writeFile('docs-only/01-architecture.mdx', '# Architecture\nThis is included.');
    await writeFile('docs-only/02-notes.txt', 'Plain text is included.');
    await writeFile('docs-only/03-secret.pem', 'should be skipped');
    await writeFile('docs-only/.env', 'should be skipped');
    await writeFile('docs-only/.git/ignored.md', 'should be skipped');
    await writeFile('docs-only/node_modules/ignored.md', 'should be skipped');
    await writeFile('docs-only/dist/ignored.md', 'should be skipped');
    await writeFile('docs-only/build/ignored.md', 'should be skipped');
    await writeFile('docs-only/target/ignored.md', 'should be skipped');
    await writeFile('docs-only/04-binary.bin', 'should be skipped');

    const store = new ProjectContextStore({
      enabled: true,
      max_docs_chars_per_pack: 10_000,
      max_total_docs_chars: 20_000,
      packs: [
        {
          name: 'docs',
          docsPath: docsDir,
          enabled: true,
          includeByDefault: true,
          maxDocsChars: 10_000,
        },
      ],
    });

    const bundle = await store.loadDefaultBundle();

    assert.deepEqual(bundle.files.map((file) => file.relativePath), [
      '00-overview.md',
      '01-architecture.mdx',
      '02-notes.txt',
    ]);
    assert.match(bundle.text, /\[pack: docs file: 00-overview\.md\]/);
    assert.equal(bundle.text.includes('03-secret.pem'), false);
    assert.equal(bundle.text.includes('.env'), false);
    assert.equal(bundle.text.includes('node_modules'), false);
    assert.ok(bundle.warnings.some((warning) => /skipped/i.test(warning)));
  });

  test('deterministically orders files and enforces per-pack and global character limits', async () => {
    const docsDir = await createPackDir('bounded-docs');
    await writeFile('bounded-docs/b.md', 'b'.repeat(80));
    await writeFile('bounded-docs/a.md', 'a'.repeat(80));

    const store = new ProjectContextStore({
      enabled: true,
      max_docs_chars_per_pack: 100,
      max_total_docs_chars: 120,
      packs: [
        {
          name: 'bounded',
          docsPath: docsDir,
          enabled: true,
          includeByDefault: true,
          maxDocsChars: 90,
        },
      ],
    });

    const bundle = await store.loadDefaultBundle();

    assert.deepEqual(bundle.files.map((file) => file.relativePath), ['a.md', 'b.md']);
    assert.equal(bundle.chars <= 120, true);
    assert.equal(bundle.truncated, true);
  });

  test('warns when a pack links to a missing workspace name', async () => {
    const docsDir = await createPackDir('linked-docs');
    await writeFile('linked-docs/00-overview.md', 'Overview');
    const warnings = [];
    const store = new ProjectContextStore(
      {
        enabled: true,
        max_docs_chars_per_pack: 1_000,
        max_total_docs_chars: 2_000,
        packs: [
          {
            name: 'linked',
            docsPath: docsDir,
            linkedWorkspaceName: 'missing-workspace',
            enabled: true,
            includeByDefault: true,
            maxDocsChars: 1_000,
          },
        ],
      },
      {
        workspaceNames: ['different-workspace'],
        logger: { warn: (message) => warnings.push(message) },
      }
    );

    const bundle = await store.loadDefaultBundle();

    assert.equal(bundle.included, true);
    assert.ok(bundle.warnings.some((warning) => /missing workspace "missing-workspace"/.test(warning)));
    assert.ok(warnings.some((warning) => /missing workspace "missing-workspace"/.test(warning)));
  });

  test('full_cached prompts place project docs before pinned context and cache the docs section', () => {
    const context = buildMeetingCopilotContext({
      mode: 'full_cached',
      snapshot: createSnapshot(),
      stableInstructions: 'Stable instructions',
      customContext: 'Custom context',
      projectDocsContext: '<project_docs_context>\n[pack: main-product file: 00-overview.md]\nOrientation only.\n</project_docs_context>',
      pinnedContext: 'Pinned context',
      codeContext: 'Code context',
      currentAction: 'Current action',
    });

    assert.deepEqual(context.sections.map((section) => section.key), [
      'stable_instructions',
      'custom_context',
      'project_docs_context',
      'pinned_context',
      'action_instructions',
      'recent_transcript',
      'code_context',
      'current_action',
    ]);

    const serialized = buildOpenRouterMessages({
      context,
      cachePolicy: 'anthropic_explicit_1h',
    });

    assert.equal(serialized.messages[0].content[2].text.includes('<project_docs_context>'), true);
    assert.equal(serialized.messages[0].content[2].cache_control.ttl, '1h');
  });

  test('recent prompts include the project docs section when provided, ordered before the transcript', () => {
    // Quick-answer opts into this (project_docs_enabled) so cheap/fast models can still be
    // grounded in project docs, relying on Gemini-style implicit prompt caching — which only
    // hits if the docs stay part of the stable prefix, i.e. before the per-call-varying
    // transcript. See ActionRunManager.ts's executeBranch() for the per-branch gate.
    const context = buildMeetingCopilotContext({
      mode: 'recent',
      snapshot: createSnapshot(),
      stableInstructions: 'Stable instructions',
      customContext: 'Custom context',
      projectDocsContext: '<project_docs_context>\nShould appear.\n</project_docs_context>',
      pinnedContext: 'Pinned context',
      codeContext: 'Code context',
      currentAction: 'Current action',
      contextMinutes: 5,
      now: '2026-07-03T10:01:00.000Z',
    });

    assert.deepEqual(context.sections.map((section) => section.key), [
      'stable_instructions',
      'custom_context',
      'project_docs_context',
      'pinned_context',
      'recent_transcript',
      'current_action',
    ]);
  });

  test('recent prompts omit the project docs section when none is provided', () => {
    const context = buildMeetingCopilotContext({
      mode: 'recent',
      snapshot: createSnapshot(),
      stableInstructions: 'Stable instructions',
      customContext: 'Custom context',
      projectDocsContext: '',
      pinnedContext: 'Pinned context',
      codeContext: 'Code context',
      currentAction: 'Current action',
      contextMinutes: 5,
      now: '2026-07-03T10:01:00.000Z',
    });

    assert.equal(
      context.sections.some((section) => section.key === 'project_docs_context'),
      false
    );
  });

  test('action runs pass project context metrics through emitted metrics and the metrics store', async () => {
    const snapshot = createSnapshot();
    const emitted = [];
    const metricsStore = new MetricsStore();
    const config = cloneConfig();
    // Test-only fixture: a full_cached action. The real default config no
    // longer ships a standalone full_cached action outside tech-solver-parallel's
    // "deep" branch, but this test only needs full_cached context-mode behavior.
    config.actions['tech-solver'] = {
      label: 'tech-solver',
      trigger: { hotkey: 'Test+tech-solver', slash: '/tech-solver', button: false },
      model: 'anthropic/claude-opus-4.8-fast',
      context_mode: 'full_cached',
      cache_policy: 'anthropic_explicit_1h',
      max_tokens: 700,
      temperature: 0.25,
      reasoning: { effort: 'low' },
      tools_enabled: false,
      prompt: 'Test full_cached action.',
    };

    const manager = new ActionRunManager({
      config,
      transcriptSnapshotProvider: () => snapshot,
      buildContext: buildMeetingCopilotContext,
      buildMessages: buildOpenRouterMessages,
      openRouterClient: {
        streamChatCompletion: async function* () {
          yield {
            type: 'done',
            result: {
              content: 'done',
              raw: {},
              warnings: [],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 2,
                total_tokens: 12,
              },
              metrics: {
                prompt_tokens: 10,
                completion_tokens: 2,
                total_tokens: 12,
              },
            },
          };
        },
      },
      emitEvent: (event) => emitted.push(event),
      metricsStore,
      createRunId: () => 'run-001',
      now: (() => {
        const values = [100, 150];
        return () => values.shift() ?? 150;
      })(),
      getProjectContext: async () => ({
        included: true,
        packNames: ['main-product'],
        files: [
          {
            packName: 'main-product',
            relativePath: '00-overview.md',
            chars: 42,
            text: 'Orientation only.',
          },
        ],
        text: '<project_docs_context>\n[pack: main-product file: 00-overview.md]\nOrientation only.\n</project_docs_context>',
        chars: 42,
        fileCount: 1,
        warnings: [],
        truncated: false,
      }),
    });

    await manager.start({ actionId: 'tech-solver' });

    assert.equal(emitted[1].type, 'metrics:update');
    assert.equal(emitted[1].metrics.project_context_included, true);
    assert.deepEqual(emitted[1].metrics.project_context_pack_names, ['main-product']);
    assert.equal(emitted[1].metrics.project_context_chars, 42);
    assert.equal(emitted[1].metrics.project_context_file_count, 1);

    const entries = metricsStore.last();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].project_context_included, true);
    assert.deepEqual(entries[0].project_context_pack_names, ['main-product']);
    assert.equal(entries[0].project_context_chars, 42);
    assert.equal(entries[0].project_context_file_count, 1);
    assert.doesNotMatch(metricsStore.serialize(), /Orientation only/);
  });
});
