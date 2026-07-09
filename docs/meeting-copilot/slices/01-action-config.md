# Slice 1 - Action Config Schema And Store

## Scope

Add a local meeting-copilot action configuration layer with validation and tests.

This slice must not:

- register hotkeys
- start action runs
- call OpenRouter
- build prompts
- modify renderer UI
- modify transcript/audio behavior
- modify Rust/native modules

## Exact Files To Create

- `electron/meeting-copilot/types.ts`
  - Public TypeScript types for action config, OpenRouter config, workspace config, cache policy, context mode, reasoning effort, metrics, and code source shapes.

- `electron/meeting-copilot/defaultActionConfig.ts`
  - Default config from the brief, including:
    - OpenRouter base URL and default headers
    - five single actions
    - one parallel Fast + Deep action
    - empty workspace allowlist
    - default code-context limits

- `electron/meeting-copilot/ActionConfigStore.ts`
  - Loads defaults.
  - Optionally loads a JSON override file from a provided config directory.
  - Validates the resolved config.
  - Exposes action lookup helpers.
  - Does not depend directly on Electron app lifecycle in tests.

- `electron/services/__tests__/MeetingCopilotActionConfig.test.mjs`
  - Node test file using the repository's existing compiled-output test style.

## Exact Files To Modify

- None required for runtime behavior in this slice.

Optional only if required by the current test runner:

- `package.json`
  - Add the new test file glob only if existing `npm test` does not already discover it.

Avoid modifying:

- `electron/main.ts`
- `electron/ipcHandlers.ts`
- `electron/preload.ts`
- `src/types/electron.d.ts`
- `src/components/*`
- `native-module/*`

## Public Types And Interfaces

The initial public contract should be close to the brief and intentionally narrow.

```ts
export type ContextMode = "recent" | "full_cached";

export type CachePolicy =
  | "none"
  | "anthropic_explicit_5m"
  | "anthropic_explicit_1h";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ActionBranch = "single" | "fast" | "deep";

export interface ReasoningConfig {
  effort?: ReasoningEffort;
}

export interface ActionTriggerConfig {
  hotkey: string;
  slash?: string;
  button?: boolean;
}

export interface ActionBranchConfig {
  model: string;
  context_mode: ContextMode;
  cache_policy: CachePolicy;
  context_minutes?: number;
  max_tokens: number;
  temperature: number;
  reasoning?: ReasoningConfig;
  tools_enabled?: boolean;
  max_tool_rounds?: number;
  max_tool_calls_per_round?: number;
  prompt: string;
}

export interface SingleActionConfig extends ActionBranchConfig {
  label: string;
  trigger: ActionTriggerConfig;
}

export interface ParallelActionConfig {
  label: string;
  trigger: ActionTriggerConfig;
  parallel: {
    fast: ActionBranchConfig;
    deep: ActionBranchConfig;
  };
}

export type MeetingCopilotActionConfig =
  | SingleActionConfig
  | ParallelActionConfig;

export interface OpenRouterConfig {
  base_url: string;
  api_key_env: string;
  default_headers?: Record<string, string>;
}

export interface WorkspaceConfig {
  name: string;
  path: string;
  enabled: boolean;
  max_snippets: number;
  max_snippet_chars: number;
}

export interface CodeContextConfig {
  enabled: boolean;
  retrieval_mode: "tool_loop";
  max_total_chars: number;
  include_file_paths: boolean;
  include_line_numbers: boolean;
}

export interface MeetingCopilotConfig {
  openrouter: OpenRouterConfig;
  actions: Record<string, MeetingCopilotActionConfig>;
  workspaces: WorkspaceConfig[];
  code_context: CodeContextConfig;
}
```

Store API:

```ts
export interface ActionConfigStoreOptions {
  configDir: string;
  fileName?: string;
}

export class ActionConfigStore {
  constructor(options: ActionConfigStoreOptions);
  load(): Promise<MeetingCopilotConfig>;
  getAction(actionId: string): MeetingCopilotActionConfig | undefined;
  listActions(): Array<{ id: string; action: MeetingCopilotActionConfig }>;
}

export function validateMeetingCopilotConfig(
  value: unknown
): MeetingCopilotConfig;
```

Manual preset selection:

- Set `"preset": "system-design-interview"` in `meeting-copilot.config.json` to load the two-action interview copilot defaults.
- You can still override any action fields directly in the same file after selecting the preset.

Example config:

```json
{
  "preset": "system-design-interview"
}
```

Example with a direct override:

```json
{
  "preset": "system-design-interview",
  "actions": {
    "guide-me": {
      "model": "anthropic/claude-fable-5"
    },
    "go-deeper": {
      "model": "anthropic/claude-fable-5"
    }
  }
}
```

Operational note for local agents:

- If you want an agent or local workflow to use the system-design interview copilot, instruct it to write `meeting-copilot.config.json` with `"preset": "system-design-interview"` before launching or reloading the app.
- The preset loads two actions only: `Guide Me` and `Go Deeper`.
- It disables repo/code-context and project-doc grounding by default and keeps shared action history across runs.

Implementation detail:

- `validateMeetingCopilotConfig` can be a small hand-written validator in v1.
- Do not add a new schema library unless the repository already has an appropriate dependency.

## Default Actions Required In This Slice

The default config must include these action IDs:

- `quick-answer`
- `tech-solver`
- `deep-solution`
- `claim-check`
- `followups`
- `tech-solver-parallel`

Required hotkeys:

- `Command+Shift+1`
- `Command+Shift+2`
- `Command+Shift+3`
- `Command+Shift+4`
- `Command+Shift+5`
- `Command+Shift+6`

Default model slugs should come from the brief but remain plain configuration values. Do not validate live availability.

## Validation Rules

Validate at least:

- `openrouter.base_url` is a non-empty HTTP(S) URL.
- `openrouter.api_key_env` is a non-empty environment variable name.
- `actions` is a non-empty object.
- Each action has a non-empty `label`.
- Each action has a non-empty `trigger.hotkey`.
- Hotkeys are unique across actions.
- Single actions have no `parallel` property.
- Parallel actions have both `parallel.fast` and `parallel.deep`.
- Each branch has:
  - non-empty `model`
  - valid `context_mode`
  - valid `cache_policy`
  - positive integer `max_tokens`
  - finite numeric `temperature`
  - non-empty `prompt`
- `context_minutes`, when present, is positive.
- `reasoning.effort`, when present, is valid.
- `max_tool_rounds`, when present, is a non-negative integer.
- `max_tool_calls_per_round`, when present, is a non-negative integer.
- Workspaces have non-empty `name` and `path`.
- Workspace snippet limits are positive.
- `code_context.max_total_chars` is positive.

Validation should throw a clear error message that identifies the offending path, for example:

```text
actions.tech-solver.context_mode must be one of recent, full_cached
```

## Tests To Add

Add tests in `electron/services/__tests__/MeetingCopilotActionConfig.test.mjs`.

Test cases:

1. Default config validates.
2. Default config includes exactly the six required action IDs.
3. Default hotkeys match `Command+Shift+1` through `Command+Shift+6`.
4. Default hotkeys are unique.
5. `quick-answer`, `claim-check`, and `followups` use `recent` context.
6. `tech-solver` and `deep-solution` use `full_cached` context.
7. `tech-solver-parallel.fast` uses `recent` and has tools disabled.
8. `tech-solver-parallel.deep` uses `full_cached` and has tools enabled.
9. Invalid context mode is rejected with a useful path in the error.
10. Invalid cache policy is rejected.
11. Duplicate hotkeys are rejected.
12. Empty model is rejected.
13. Missing parallel deep branch is rejected.
14. Invalid workspace path/name is rejected.
15. Loading from an override file uses the supplied `configDir`, not Electron globals.

The tests should avoid network, Electron app startup, native modules, and renderer imports.

## Acceptance Criteria

- The new modules compile with `npm run build:electron`.
- The new tests pass through the repository test command or a documented focused test command.
- No runtime behavior changes occur before later slices wire the config into the app.
- No Rust/native files are touched.
- No OpenRouter requests are made.
- No hotkeys are registered.
- The config is concrete enough for later slices to use without changing the public type names.

## Rollback Plan

Rollback is low risk because this slice should not be wired into runtime behavior.

To revert:

1. Delete `electron/meeting-copilot/types.ts`.
2. Delete `electron/meeting-copilot/defaultActionConfig.ts`.
3. Delete `electron/meeting-copilot/ActionConfigStore.ts`.
4. Delete `electron/services/__tests__/MeetingCopilotActionConfig.test.mjs`.
5. Revert any optional `package.json` test glob change if it was needed.

No database migration, settings migration, credential migration, native change, or renderer cleanup should be required.
