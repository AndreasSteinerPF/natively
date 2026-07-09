# System Design Interview Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a meeting-copilot configuration path optimized for live system design interviews, with two actions (`Guide Me`, `Go Deeper`), shared action history, screenshot-aware continuity, and no repo/project-doc grounding by default.

**Architecture:** Keep the current meeting-copilot runtime and add a new config-level preset path that is selected manually through the JSON config file rather than through new UI. Extend the runtime context so prior action outputs become shared interview memory, then define new system-design-specific prompts and tests around that behavior.

**Tech Stack:** Electron/TypeScript, existing meeting-copilot runtime (`ActionConfigStore`, `ContextBuilder`, `ActionRunManager`), Node test runner

## Global Constraints

- No repo access by default.
- No custom project docs or pinned project context required by default.
- Shared state across `Guide Me` and `Go Deeper`; outputs must build on each other.
- Low reading load, but each `Guide Me` invocation must cover a whole phase, not only the immediate next move.
- The interview format assumes requirements are provided at the beginning; default behavior should not over-index on clarifying questions.
- Guidance should stay generic first, with a bias toward the user's familiar stack when concrete examples help.
- Preset selection does not need new UI; manual config-file selection is acceptable for this change.

---

## File Structure

- Modify: `electron/meeting-copilot/types.ts`
  - Add config typing for manual preset selection plus prompt sections for prior action memory and optional screenshot/board context if missing.
- Modify: `electron/meeting-copilot/defaultActionConfig.ts`
  - Split current default config from the new system-design interview preset factory/defaults.
- Modify: `electron/meeting-copilot/ActionConfigStore.ts`
  - Resolve config root defaults based on manual preset selection and validate the new root shape.
- Modify: `electron/meeting-copilot/ContextBuilder.ts`
  - Include shared action-history sections in prompt assembly and keep ordering stable.
- Modify: `electron/meeting-copilot/ActionRunManager.ts`
  - Persist completed action outputs as reusable shared interview state and pass them back into context construction.
- Modify: `src/components/meeting-copilot/MeetingCopilotPanel.tsx`
  - Keep labels readable for the new two-action preset and avoid “fast/deep refinement” language when the selected run is now `Guide Me` or `Go Deeper`.
- Modify: `src/hooks/useMeetingCopilot.ts`
  - Ensure visible panes and labels still behave sensibly once the parallel action is removed from the manual preset.
- Test: `electron/services/__tests__/MeetingCopilotActionConfig.test.mjs`
  - Cover preset selection, two-action defaults, and disabled code/project context behavior.
- Test: `electron/services/__tests__/MeetingCopilotTranscriptContext.test.mjs`
  - Cover shared action-history sections and ordering in recent/full context.
- Create: `electron/services/__tests__/MeetingCopilotSharedState.test.mjs`
  - Verify one action’s output flows into the next action’s context.
- Modify: `docs/meeting-copilot/01-action-config.md`
  - Document the manual config-file switch and new preset semantics.

### Task 1: Add Manual Preset Selection and System-Design Default Actions

**Files:**
- Modify: `electron/meeting-copilot/types.ts`
- Modify: `electron/meeting-copilot/defaultActionConfig.ts`
- Modify: `electron/meeting-copilot/ActionConfigStore.ts`
- Test: `electron/services/__tests__/MeetingCopilotActionConfig.test.mjs`

**Interfaces:**
- Consumes: existing `MeetingCopilotConfig`, `DEFAULT_MEETING_COPILOT_CONFIG`, `validateMeetingCopilotConfig()`
- Produces:
  - `MeetingCopilotPreset = 'meeting-default' | 'system-design-interview'`
  - `MeetingCopilotConfigFile` with optional `preset`
  - `getDefaultMeetingCopilotConfig(preset?: MeetingCopilotPreset): MeetingCopilotConfig`

- [ ] **Step 1: Write the failing config-default tests**

```js
test('system-design preset resolves to exactly guide-me and go-deeper actions', () => {
  const config = getDefaultMeetingCopilotConfig('system-design-interview');
  assert.deepEqual(Object.keys(config.actions), ['guide-me', 'go-deeper']);
});

test('system-design preset disables repo/project-doc/web defaults', () => {
  const config = getDefaultMeetingCopilotConfig('system-design-interview');
  assert.equal(config.code_context.enabled, false);
  assert.equal(config.project_context.enabled, false);
  assert.equal(config.actions['guide-me'].project_docs_enabled, undefined);
  assert.equal(config.actions['go-deeper'].web_search_enabled, undefined);
});

test('config file can select the system-design preset manually', async () => {
  const dir = writeOverride('system-design-preset', { preset: 'system-design-interview' });
  const store = new ActionConfigStore({ configDir: dir });
  const config = await store.load();
  assert.deepEqual(Object.keys(config.actions), ['guide-me', 'go-deeper']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- electron/services/__tests__/MeetingCopilotActionConfig.test.mjs`
Expected: FAIL with `getDefaultMeetingCopilotConfig is not a function`, missing `preset` validation, or mismatched action IDs.

- [ ] **Step 3: Add preset-aware types and config factories**

```ts
export type MeetingCopilotPreset =
    | 'meeting-default'
    | 'system-design-interview';

export interface MeetingCopilotConfigFile extends Partial<MeetingCopilotConfig> {
    preset?: MeetingCopilotPreset;
}
```

```ts
export function getDefaultMeetingCopilotConfig(
    preset: MeetingCopilotPreset = 'meeting-default'
): MeetingCopilotConfig {
    if (preset === 'system-design-interview') {
        return {
            openrouter: DEFAULT_OPENROUTER_CONFIG,
            actions: {
                'guide-me': {
                    label: 'Guide Me',
                    trigger: { hotkey: 'Command+Shift+1', slash: '/guide', button: false },
                    model: 'anthropic/claude-opus-4.8',
                    context_mode: 'full_cached',
                    cache_policy: 'anthropic_explicit_1h',
                    temperature: 0.2,
                    reasoning: { effort: 'medium' },
                    prompt: SYSTEM_DESIGN_GUIDE_PROMPT,
                },
                'go-deeper': {
                    label: 'Go Deeper',
                    trigger: { hotkey: 'Command+Shift+2', slash: '/deeper', button: false },
                    model: 'anthropic/claude-opus-4.8',
                    context_mode: 'full_cached',
                    cache_policy: 'anthropic_explicit_1h',
                    temperature: 0.2,
                    reasoning: { effort: 'high' },
                    prompt: SYSTEM_DESIGN_DEEPER_PROMPT,
                },
            },
            workspaces: [],
            code_context: {
                enabled: false,
                retrieval_mode: 'tool_loop',
                max_total_chars: 0,
                include_file_paths: false,
                include_line_numbers: false,
            },
            transcript_context: {
                max_total_chars: 24_000,
            },
            project_context: {
                enabled: false,
                max_docs_chars_per_pack: 20_000,
                max_total_docs_chars: 40_000,
                packs: [],
            },
        };
    }

    return DEFAULT_MEETING_COPILOT_CONFIG;
}
```

- [ ] **Step 4: Make `ActionConfigStore` resolve defaults from `preset` before deep-merging overrides**

```ts
function resolveDefaultConfig(parsed: unknown): MeetingCopilotConfig {
    const preset = (
        typeof parsed === 'object' &&
        parsed !== null &&
        'preset' in parsed &&
        typeof (parsed as { preset?: unknown }).preset === 'string'
    ) ? (parsed as { preset: MeetingCopilotPreset }).preset : 'meeting-default';

    return getDefaultMeetingCopilotConfig(preset);
}
```

```ts
const parsed = JSON.parse(file) as unknown;
const defaultConfig = resolveDefaultConfig(parsed);
resolvedConfig = deepMerge(defaultConfig as unknown as JsonObject, parsed as JsonObject);
```

- [ ] **Step 5: Run the config tests and verify they pass**

Run: `npm test -- electron/services/__tests__/MeetingCopilotActionConfig.test.mjs`
Expected: PASS with new preset coverage and no regressions in meeting-default behavior.

- [ ] **Step 6: Commit**

```bash
git add electron/meeting-copilot/types.ts electron/meeting-copilot/defaultActionConfig.ts electron/meeting-copilot/ActionConfigStore.ts electron/services/__tests__/MeetingCopilotActionConfig.test.mjs
git commit -m "feat: add system design meeting copilot preset"
```

### Task 2: Add Shared Action Memory to Prompt Context

**Files:**
- Modify: `electron/meeting-copilot/types.ts`
- Modify: `electron/meeting-copilot/ContextBuilder.ts`
- Test: `electron/services/__tests__/MeetingCopilotTranscriptContext.test.mjs`

**Interfaces:**
- Consumes: `BuildMeetingCopilotContextInput`, `PromptSectionKey`
- Produces:
  - `BuildMeetingCopilotContextInput.actionHistory?: string`
  - `PromptSectionKey` values for `action_history` and `board_context`

- [ ] **Step 1: Write the failing context-builder tests**

```js
test('recent context includes action_history before current_action', () => {
  const result = buildMeetingCopilotContext({
    mode: 'recent',
    snapshot,
    stableInstructions: 'Use transcript faithfully.',
    customContext: '',
    pinnedContext: '',
    actionHistory: 'Guide Me: Use Postgres as the source of truth.',
    currentAction: 'Continue the next design phase.',
  });

  assert.deepEqual(
    result.sections.map((section) => section.key),
    ['stable_instructions', 'custom_context', 'pinned_context', 'recent_transcript', 'action_history', 'current_action']
  );
});

test('full_cached context keeps board_context non-cacheable near the current action', () => {
  const result = buildMeetingCopilotContext({
    mode: 'full_cached',
    snapshot,
    stableInstructions: 'Use transcript faithfully.',
    customContext: '',
    pinnedContext: '',
    actionHistory: 'Go Deeper: add a queue for async writes.',
    dynamicEvidenceContext: 'Board screenshot summary: API, queue, worker, Postgres.',
    currentAction: 'Refine the architecture phase.',
  });

  assert.equal(result.sections.at(-2)?.key, 'action_history');
  assert.equal(result.sections.at(-1)?.key, 'current_action');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- electron/services/__tests__/MeetingCopilotTranscriptContext.test.mjs`
Expected: FAIL because `actionHistory` is ignored and the new prompt sections do not exist.

- [ ] **Step 3: Extend prompt-section types and context-builder ordering**

```ts
export type PromptSectionKey =
    | 'stable_instructions'
    | 'custom_context'
    | 'project_docs_context'
    | 'pinned_context'
    | 'recent_transcript'
    | 'meeting_transcript_so_far'
    | 'code_context'
    | 'dynamic_evidence_context'
    | 'action_history'
    | 'current_action';
```

```ts
export interface BuildMeetingCopilotContextInput {
    // ...
    actionHistory?: string;
}
```

```ts
...(input.actionHistory && input.actionHistory.trim().length > 0
    ? [section('action_history', input.actionHistory, { cacheable: false })]
    : []),
section('current_action', input.currentAction, { cacheable: false }),
```

- [ ] **Step 4: Keep recent/full context ordering stable and non-mutating**

```ts
const actionHistory = input.actionHistory?.trim() ?? '';
```

Place `action_history` after transcript/code/dynamic-evidence sections and before `current_action` in both `recent` and `full_cached` branches.

- [ ] **Step 5: Run the transcript-context tests and verify they pass**

Run: `npm test -- electron/services/__tests__/MeetingCopilotTranscriptContext.test.mjs`
Expected: PASS with the new `action_history` ordering and all previous section-order assertions updated.

- [ ] **Step 6: Commit**

```bash
git add electron/meeting-copilot/types.ts electron/meeting-copilot/ContextBuilder.ts electron/services/__tests__/MeetingCopilotTranscriptContext.test.mjs
git commit -m "feat: add shared action history to meeting copilot prompts"
```

### Task 3: Persist Completed Action Output Into Shared Interview State

**Files:**
- Modify: `electron/meeting-copilot/ActionRunManager.ts`
- Create: `electron/services/__tests__/MeetingCopilotSharedState.test.mjs`

**Interfaces:**
- Consumes: `ActionRunManager.startAction()`, `buildContext()`, emitted `action:completed` events
- Produces:
  - internal `sharedActionHistoryByMeeting: Map<string, string[]>`
  - context-builder input field `actionHistory`

- [ ] **Step 1: Write the failing shared-state test**

```js
test('second action sees the completed text from the first action', async () => {
  const builtContexts = [];
  const manager = new ActionRunManager({
    config,
    transcriptSnapshotProvider: () => snapshot,
    buildContext: (input) => {
      builtContexts.push(input);
      return { mode: input.mode, sections: [] };
    },
    buildMessages: () => ({ messages: [] }),
    openRouterClient: fakeClient([
      'Step: High-level architecture\nSay: I would start with a single API service.',
      'Step: Deep dive\nSay: I would make Postgres the source of truth.',
    ]),
    emitEvent: () => {},
  });

  await drain(manager.startAction({ actionId: 'guide-me' }));
  await drain(manager.startAction({ actionId: 'go-deeper' }));

  assert.match(
    builtContexts[1].actionHistory,
    /Guide Me[\s\S]*single API service/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- electron/services/__tests__/MeetingCopilotSharedState.test.mjs`
Expected: FAIL because `ActionRunManager` does not retain prior outputs between action runs.

- [ ] **Step 3: Add per-meeting action-history storage and trimming**

```ts
private readonly sharedActionHistoryByMeeting = new Map<string, string[]>();

private appendSharedActionHistory(meetingId: string, entry: string): void {
    const existing = this.sharedActionHistoryByMeeting.get(meetingId) ?? [];
    const next = [...existing, entry].slice(-8);
    this.sharedActionHistoryByMeeting.set(meetingId, next);
}

private getSharedActionHistory(meetingId: string): string {
    return (this.sharedActionHistoryByMeeting.get(meetingId) ?? []).join('\n\n');
}
```

- [ ] **Step 4: Record completed action text and pass it into `buildContext()`**

```ts
const sharedHistory = this.getSharedActionHistory(snapshot.meeting_id);
const context = this.options.buildContext({
    // existing fields...
    actionHistory: sharedHistory,
});
```

```ts
this.appendSharedActionHistory(
    snapshot.meeting_id,
    `${action.label}\n${finalText.trim()}`
);
```

Use final pane text for single actions and per-branch labeled text for parallel actions that already exist in meeting-default.

- [ ] **Step 5: Run the shared-state test and nearby meeting-copilot tests**

Run: `npm test -- electron/services/__tests__/MeetingCopilotSharedState.test.mjs`
Expected: PASS

Run: `npm test -- electron/services/__tests__/MeetingCopilotActionRunManager.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add electron/meeting-copilot/ActionRunManager.ts electron/services/__tests__/MeetingCopilotSharedState.test.mjs
git commit -m "feat: persist meeting copilot action history across runs"
```

### Task 4: Tune the System-Design Prompts and Lightweight UI Copy

**Files:**
- Modify: `electron/meeting-copilot/defaultActionConfig.ts`
- Modify: `src/components/meeting-copilot/MeetingCopilotPanel.tsx`
- Modify: `src/hooks/useMeetingCopilot.ts`
- Modify: `docs/meeting-copilot/01-action-config.md`

**Interfaces:**
- Consumes: preset config from Task 1, shared action history from Task 3
- Produces:
  - `SYSTEM_DESIGN_GUIDE_PROMPT`
  - `SYSTEM_DESIGN_DEEPER_PROMPT`
  - visible pane labels that stay coherent when the selected preset uses only single-action runs

- [ ] **Step 1: Write the failing copy/prompt assertions**

```js
test('system-design guide prompt encodes full-step output fields', () => {
  const config = getDefaultMeetingCopilotConfig('system-design-interview');
  assert.match(config.actions['guide-me'].prompt, /Step:/);
  assert.match(config.actions['guide-me'].prompt, /Goal:/);
  assert.match(config.actions['guide-me'].prompt, /Draw:/);
  assert.match(config.actions['guide-me'].prompt, /Say:/);
  assert.match(config.actions['guide-me'].prompt, /Key Decisions:/);
});
```

```tsx
assert.equal(PANE_LABELS.main, 'Answer');
assert.equal(STATUS_LABELS.completed, 'Complete');
```

Add or update a UI-level test only if one already exists nearby; otherwise keep this validation in config tests and manual QA.

- [ ] **Step 2: Run tests to verify prompt assertions fail**

Run: `npm test -- electron/services/__tests__/MeetingCopilotActionConfig.test.mjs`
Expected: FAIL until the new prompt text is present.

- [ ] **Step 3: Write the final system-design prompts**

```ts
const SYSTEM_DESIGN_GUIDE_PROMPT = [
  'You are my live system design interview copilot.',
  'Requirements are given up front; do not default to discovery questions.',
  'Infer the current design phase and likely problem pattern from the transcript and prior action history.',
  'Return exactly these sections: Step, Goal, Draw, Say, Key Decisions.',
  'Guide one complete phase, not a micro-step.',
  'Draw should be ordered whiteboarding actions.',
  'Say should be short interview-ready lines I can speak while drawing.',
  'Prefer generic architecture language, but bias toward Python, FastAPI/Sanic, Postgres-first, Redis, Kafka/RabbitMQ/SQS, AWS familiarity, and simplicity.',
].join('\\n');
```

```ts
const SYSTEM_DESIGN_DEEPER_PROMPT = [
  'You are my live system design interview reviewer.',
  'Use the transcript, prior action history, and any screenshot-derived board context to critique the current design.',
  'Strengthen weak tradeoffs, identify missing components, and suggest sharper follow-up language.',
  'Build on the current design; do not restart from scratch unless the current design is fundamentally broken.',
  'Keep the response concise enough to use live.',
].join('\\n');
```

- [ ] **Step 4: Update panel copy only where current wording is misleading**

```tsx
const PANE_LABELS: Record<MeetingCopilotPaneKey, string> = {
  main: 'Answer',
  fast: 'Fast answer',
  deep: 'Deep answer',
};
```

Do not add preset-selection UI. Only keep the existing UI neutral so `Go Deeper` output does not inherit stale “refinement” language from the previous meeting-specific setup.

- [ ] **Step 5: Document the manual config-file switch and verify the build/test slice**

Update `docs/meeting-copilot/01-action-config.md` with:

```md
Set `"preset": "system-design-interview"` in `meeting-copilot.config.json` to load the two-action interview copilot defaults. You can still override any action fields directly in the same file.
```

Run: `npm test -- electron/services/__tests__/MeetingCopilotActionConfig.test.mjs electron/services/__tests__/MeetingCopilotTranscriptContext.test.mjs electron/services/__tests__/MeetingCopilotSharedState.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add electron/meeting-copilot/defaultActionConfig.ts src/components/meeting-copilot/MeetingCopilotPanel.tsx src/hooks/useMeetingCopilot.ts docs/meeting-copilot/01-action-config.md electron/services/__tests__/MeetingCopilotActionConfig.test.mjs electron/services/__tests__/MeetingCopilotTranscriptContext.test.mjs electron/services/__tests__/MeetingCopilotSharedState.test.mjs
git commit -m "feat: add system design interview copilot prompts"
```

## Self-Review

- Spec coverage:
  - Manual preset selection: Task 1
  - Two actions only: Task 1
  - Shared action history: Tasks 2 and 3
  - Screenshot/board-aware continuity via context wiring: Tasks 2 and 4
  - No repo/project-doc grounding by default: Task 1
  - System-design framework prompts and familiar-stack bias: Task 4
- Placeholder scan: no `TBD`, `TODO`, or undefined tasks remain.
- Type consistency:
  - `MeetingCopilotPreset` is defined in Task 1 and used consistently later.
  - `actionHistory` is added in Task 2 before Task 3 consumes it.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-09-system-design-interview-copilot.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
