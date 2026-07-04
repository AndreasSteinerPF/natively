import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const {
  DEFAULT_PINNED_CONTEXT_TEMPLATE,
  PINNED_CONTEXT_MAX_CHARS,
  PinnedContextStore,
} = await import(pathToFileURL(path.join(distRoot, 'PinnedContextStore.js')).href);

const tempDirs = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function createStore(overrides = {}) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'meeting-copilot-pinned-context-'));
  tempDirs.push(configDir);

  return {
    configDir,
    store: new PinnedContextStore({
      configDir,
      fileName: 'pinned-context.json',
      ...overrides,
    }),
  };
}

describe('meeting-copilot pinned context store', () => {
  test('compiled meeting-copilot runtime exports the pinned context store primitives', () => {
    assert.equal(typeof DEFAULT_PINNED_CONTEXT_TEMPLATE, 'string');
    assert.equal(typeof PINNED_CONTEXT_MAX_CHARS, 'number');
    assert.equal(typeof PinnedContextStore, 'function');
  });

  test('load returns the default template when the file is missing or invalid', async () => {
    const { store: missingStore } = await createStore();
    assert.equal(await missingStore.load(), DEFAULT_PINNED_CONTEXT_TEMPLATE);

    const { configDir, store: invalidStore } = await createStore({ fileName: 'invalid.json' });
    await writeFile(path.join(configDir, 'invalid.json'), '{"value":42}', 'utf8');
    assert.equal(await invalidStore.load(), DEFAULT_PINNED_CONTEXT_TEMPLATE);
  });

  test('save persists a bounded pinned context string and reload returns the saved value', async () => {
    const { store } = await createStore();
    const saved = await store.save('Current problem:\n\nShip M6 safely.');
    const reloaded = await store.load();

    assert.equal(saved, 'Current problem:\n\nShip M6 safely.');
    assert.equal(reloaded, saved);
  });

  test('reset restores the template and save truncates oversized input', async () => {
    const { store } = await createStore();
    const oversized = 'x'.repeat(PINNED_CONTEXT_MAX_CHARS + 500);

    const saved = await store.save(oversized);
    const reset = await store.reset();

    assert.equal(saved.length, PINNED_CONTEXT_MAX_CHARS);
    assert.equal(reset, DEFAULT_PINNED_CONTEXT_TEMPLATE);
    assert.equal(await store.load(), DEFAULT_PINNED_CONTEXT_TEMPLATE);
  });
});
