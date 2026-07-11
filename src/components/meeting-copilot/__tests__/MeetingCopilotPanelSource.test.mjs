import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(__dirname, '../MeetingCopilotPanel.tsx');
const source = readFileSync(SOURCE_PATH, 'utf8');

test('system design mode renders reducer order directly so newest runs appear at the top', () => {
  assert.ok(
    source.includes('systemDesignMode ? state.runIds : state.runIds.slice(0, 3)'),
    'system design mode must use state.runIds directly; action:started prepends new runs',
  );
  assert.ok(
    !source.includes('[...state.runIds].reverse()'),
    'system design mode must not reverse runIds because that pushes new runs to the bottom',
  );
});

test('system design mode scrolls to the top when the newest run changes', () => {
  assert.ok(
    source.includes('systemDesignScrollRef'),
    'system design scroll container should have a dedicated ref',
  );
  assert.ok(
    source.includes('systemDesignScrollRef.current.scrollTop = 0'),
    'new system design runs should snap the scroll container to the top',
  );
});
