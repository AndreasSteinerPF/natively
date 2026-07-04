# Slice 13 - Project Context Packs

## Goal

Add config-first local Project Context Packs so long-context Meeting Copilot actions can use bounded local Markdown/text docs as stable orientation context.

This slice is local-only. Do not add freshness/web tools, browser automation, embeddings, semantic RAG, background indexing, file editing, shell execution exposed to the model, or Rust/native changes.

## Exact Files To Create Or Modify

Create:

- `electron/meeting-copilot/ProjectContextStore.ts`
- `electron/services/__tests__/MeetingCopilotProjectContext.test.mjs`

Modify:

- `electron/meeting-copilot/types.ts`
- `electron/meeting-copilot/defaultActionConfig.ts`
- `electron/meeting-copilot/ActionConfigStore.ts`
- `electron/meeting-copilot/ContextBuilder.ts`
- `electron/meeting-copilot/PromptCache.ts`
- `electron/meeting-copilot/ActionRunManager.ts`
- `electron/meeting-copilot/MetricsStore.ts`
- `src/components/meeting-copilot/MeetingCopilotPanel.tsx`
- `src/components/meeting-copilot/MetricsDebugPanel.tsx`
- `docs/meeting-copilot/99-implementation-log.md`

Do not modify:

- Rust/native modules.
- Existing provider routers outside `electron/meeting-copilot/*`.
- Code tools except where a shared type needs to understand project context metrics.

## Public Types And Interfaces

Add config types:

```ts
type ProjectContextPack = {
  name: string;
  docsPath: string;
  linkedWorkspaceName?: string;
  enabled: boolean;
  includeByDefault: boolean;
  maxDocsChars: number;
};

type ProjectContextConfig = {
  enabled: boolean;
  max_docs_chars_per_pack: number;
  max_total_docs_chars: number;
  packs: ProjectContextPack[];
};
```

Add loaded-doc types:

```ts
type ProjectContextFile = {
  packName: string;
  relativePath: string;
  chars: number;
  text: string;
};

type ProjectContextBundle = {
  included: boolean;
  packNames: string[];
  files: ProjectContextFile[];
  text: string;
  chars: number;
  fileCount: number;
  warnings: string[];
  truncated: boolean;
};
```

Extend metrics:

```ts
type ProjectContextMetrics = {
  project_context_included?: boolean;
  project_context_pack_names?: string[];
  project_context_chars?: number;
  project_context_file_count?: number;
};
```

Suggested `ProjectContextStore` public shape:

```ts
class ProjectContextStore {
  constructor(config: ProjectContextConfig, options?: { logger?: Pick<Console, "warn"> });
  loadDefaultBundle(): Promise<ProjectContextBundle>;
  loadPack(name: string): Promise<ProjectContextBundle>;
}
```

## Behavior

- Load only enabled packs when `project_context.enabled` is true.
- Include only packs with `includeByDefault: true` in `full_cached` actions.
- Continue with an empty bundle if no packs are configured.
- Include only `.md`, `.mdx`, and `.txt`.
- Exclude `.git/`, `node_modules/`, `dist/`, `build/`, `target/`, `.env`, `.env.*`, `*.pem`, and `*.key`.
- Enumerate files deterministically by relative path.
- Apply `maxDocsChars` per pack and `max_total_docs_chars` globally.
- Produce warnings for missing folders, unreadable files, unsupported files skipped, empty packs, linked workspace misses, and truncation.
- Format prompt text as:

```text
<project_docs_context>
[pack: main-product file: 00-overview.md]
...

[pack: main-product file: 01-architecture.md]
...
</project_docs_context>
```

- Insert project docs in `full_cached` prompt order:
  - stable instructions
  - custom context
  - project docs context
  - pinned context
  - meeting transcript
  - dynamic evidence/current action outside cacheable blocks
- Do not include full packs in `recent` prompts by default.
- Mark project docs cacheable for Anthropic full-cached prompts.
- Show a minimal UI/debug indicator through existing metrics/panel surfaces:
  - `Project docs: included`
  - pack names
  - chars
  - file count

## Prompt Instruction Update

Extend stable instructions for long-context actions with the evidence hierarchy:

```text
Evidence hierarchy:
1. Meeting transcript is the source of truth for what was said.
2. Project docs are useful orientation and hypotheses.
3. Actual repo code is the source of truth for implementation details.
4. Fresh external sources are the source of truth for current public facts.
5. LLM prior knowledge may be stale.

Use project docs for orientation.
Verify implementation-sensitive claims against code.
When docs and code disagree, prefer code and say the docs appear stale, incomplete, or directionally correct only.
```

## Tests To Add

- Default config works with no project context packs.
- Config validation accepts one valid pack.
- Missing `docsPath` returns a warning and empty bundle.
- Only `.md`, `.mdx`, and `.txt` files are included.
- Excluded paths are ignored.
- Per-pack and global char limits are enforced.
- File order is deterministic.
- `full_cached` prompt includes project docs before transcript.
- `recent` prompt does not include full project docs by default.
- Project docs sections are cacheable in Anthropic prompt serialization.
- Metrics include included flag, pack names, chars, and file count.
- Metrics/log serialization does not include raw project doc text.

## Acceptance Criteria

- One or more local Project Context Packs can be configured through local config.
- Enabled default packs are read from local Markdown/text files.
- Missing or invalid packs produce warnings but do not fail actions.
- Full-cached actions include project docs before transcript.
- Recent/fast actions do not include full project docs by default.
- Project docs are cacheable stable context.
- Prompt instructions say docs are orientation and code is source of truth.
- Metrics/debug status indicate when project docs were included.
- Raw docs are not logged by default.

## Rollback Plan

- Remove `ProjectContextStore.ts` and its test file.
- Remove `project_context` config defaults/types.
- Remove project-doc insertion from `ContextBuilder`.
- Remove project-doc cache serialization from `PromptCache`.
- Remove project-context metrics fields from runtime display.
- Existing M0-M12 behavior should continue because project docs must be optional and default to no-op when absent.
