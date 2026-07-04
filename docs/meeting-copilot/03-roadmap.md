# Meeting Copilot Roadmap

## Milestone List

### M0 - Planning Documentation

Status: complete in this planning pass.

Outputs:

- `docs/meeting-copilot/00-prd.md`
- `docs/meeting-copilot/01-repo-map.md`
- `docs/meeting-copilot/02-architecture.md`
- `docs/meeting-copilot/03-roadmap.md`
- `docs/meeting-copilot/slices/01-action-config.md`
- `docs/meeting-copilot/99-implementation-log.md`

### M1 - Action Config Schema And Store

Purpose:

- Add the local configurable action layer without wiring runtime behavior.
- Validate the six required actions and default OpenRouter metadata.

Likely files:

- Create `electron/meeting-copilot/types.ts`
- Create `electron/meeting-copilot/defaultActionConfig.ts`
- Create `electron/meeting-copilot/ActionConfigStore.ts`
- Add tests under the existing Node test pattern, preferably `electron/services/__tests__/MeetingCopilotActionConfig.test.mjs`

Tests:

- Default config contains the five single actions plus one parallel action.
- Required hotkeys are present and unique.
- Invalid context mode, cache policy, reasoning effort, model, duplicate hotkey, and malformed parallel branch are rejected.
- Local override parsing is deterministic and does not require Electron runtime.

### M2 - Meeting-Only Transcript Buffer And Context Builder

Purpose:

- Add an append-only meeting-copilot transcript buffer separate from `SessionTracker.fullTranscript`.
- Add prompt construction for `recent` and `full_cached` modes.

Likely files:

- Create `electron/meeting-copilot/TranscriptBuffer.ts`
- Create `electron/meeting-copilot/ContextBuilder.ts`
- Extend `electron/meeting-copilot/types.ts`
- Add a narrow feed hook in `electron/main.ts` only after tests are in place

Tests:

- Transcript chunks append without rewriting older chunks.
- Assistant/tool/action messages are not accepted as transcript chunks.
- Recent mode selects the configured time window.
- Full cached mode includes the full transcript snapshot.
- Prompt section order matches the brief.
- Pinned/custom context insertion is stable.

### M3 - Thin OpenRouter Client Without Tools

Purpose:

- Add a small OpenRouter chat client for streaming and non-streaming calls.
- No action runtime wiring yet.

Likely files:

- Create `electron/meeting-copilot/OpenRouterClient.ts`
- Create `electron/meeting-copilot/PromptCache.ts`
- Extend `electron/meeting-copilot/types.ts`
- Add tests under existing Node test pattern

Tests:

- Request construction for streaming and non-streaming chat completions.
- Header/API key redaction in errors/logs.
- Reasoning config passthrough.
- Anthropic cache-control serialization.
- Retry-on-cache-control-rejection decision logic.
- Cancellation passes an `AbortSignal`.

### M4 - Single Action Runner And IPC Skeleton

Purpose:

- Run non-tool actions from main process using configured actions and OpenRouter.
- Stream token events to renderer through namespaced IPC.

Likely files:

- Create `electron/meeting-copilot/ActionRunManager.ts`
- Create `electron/meeting-copilot/ipc.ts`
- Modify `electron/ipcHandlers.ts`
- Modify `electron/preload.ts`
- Modify `src/types/electron.d.ts`

Tests:

- Action start creates run IDs and snapshots transcript once.
- Token/done/error payloads match the public IPC event union.
- Cancellation aborts the active run.
- Metrics include TTFT and total latency when streaming is mocked.
- IPC payloads are bounded and sanitized.

### M5 - Renderer Response Panel

Purpose:

- Add UI for started runs, streaming tokens, completion/errors, copy, cancel, and compact metrics.

Likely files:

- Create `src/hooks/useMeetingCopilot.ts`
- Create `src/components/meeting-copilot/MeetingCopilotPanel.tsx`
- Create `src/components/meeting-copilot/MetricsDebugPanel.tsx`
- Modify `src/components/NativelyInterface.tsx`
- Modify styles as needed

Tests:

- Reducer appends token deltas to the correct run/pane.
- Error/completion states do not lose previous text.
- Cancel action calls the preload API with the expected run/branch.
- Copy control copies only visible response text.

### M6 - Pinned Context Storage And Editor

Purpose:

- Add editable pinned context and include it in prompt building.

Likely files:

- Create `electron/meeting-copilot/PinnedContextStore.ts`
- Extend `electron/meeting-copilot/ipc.ts`
- Extend `electron/preload.ts`
- Extend `src/types/electron.d.ts`
- Create `src/components/meeting-copilot/PinnedContextEditor.tsx`

Tests:

- Pinned context saves/loads locally.
- Reset restores the template.
- Prompt builder includes pinned context after custom context.
- Pinned context updates do not mutate transcript chunks.

### M7 - Required Hotkeys

Purpose:

- Trigger actions through `Command+Shift+1` through `Command+Shift+6`.

Likely files:

- Modify `electron/services/KeybindManager.ts`
- Modify `electron/main.ts`
- Modify `src/hooks/useShortcuts.ts` only if local focused shortcuts are needed
- Possibly extend settings UI only if existing keybind editor requires it

Tests:

- Default meeting-copilot hotkeys are present.
- Existing keybind overrides still load.
- Duplicate registrations surface a registration-failed event.
- Hotkey action IDs map to meeting-copilot action IDs.

### M8 - Anthropic Full-Cached Lane

Purpose:

- Route Tech Solver and Deep Solution through full cached context and Anthropic/OpenRouter cache-control.

Likely files:

- Extend `ContextBuilder.ts`
- Extend `PromptCache.ts`
- Extend `ActionRunManager.ts`
- Extend `OpenRouterClient.ts`

Tests:

- `full_cached` includes cacheable blocks and excludes current action from cacheable blocks.
- Cache rejection retries once without cache-control.
- Cache warning is surfaced in debug/metrics event.
- Provider context-limit errors surface a clear user-facing error without fallback summarization.

### M9 - Parallel Fast + Deep Action

Purpose:

- Add the required concurrent action with separate fast and deep panes.

Likely files:

- Extend `ActionRunManager.ts`
- Extend `types.ts`
- Extend `MeetingCopilotPanel.tsx`
- Create `src/components/meeting-copilot/ParallelRunPanel.tsx`

Tests:

- Fast and deep branches share one transcript snapshot.
- Fast branch starts without waiting for deep branch.
- Deep branch failure does not clear fast branch output.
- Cancelling deep does not cancel completed fast output.
- Cancelling all aborts both active controllers.

### M10 - Workspace Allowlist And Manual Code Tools

Purpose:

- Add safe local code search/read primitives in Electron main.

Likely files:

- Create `electron/meeting-copilot/CodeWorkspaceStore.ts`
- Create `electron/meeting-copilot/CodeTools.ts`
- Extend `electron/meeting-copilot/types.ts`
- Extend IPC/preload/types if manual code search/read UI is added

Tests:

- Workspace path allowlist blocks outside paths.
- Excluded paths are not searched or read.
- Missing `rg` returns the required clear error.
- `rg` command uses argument arrays and not shell strings.
- Search result limits and snippet char limits are enforced.
- Secret redaction removes key/token/password/private-key-like values.

### M11 - Tool Loop And Final Streaming

Purpose:

- Enable bounded code tools for Tech Solver, Deep Solution, and the deep branch.

Likely files:

- Create `electron/meeting-copilot/ToolLoop.ts`
- Extend `ActionRunManager.ts`
- Extend `OpenRouterClient.ts`
- Extend `ToolActivity` UI

Tests:

- Tools are enabled only for configured actions/branches.
- Invalid tool name/arguments are rejected.
- Tool loop stops at max rounds and max calls per round.
- Tool results are redacted/truncated before provider messages.
- Final answer streams with tools disabled.
- Tool calls/results are not added to transcript.
- Previous raw tool history is not included in future prompts.

### M12 - Metrics, Redaction, And Polish ✅

Purpose:

- Harden logs, metrics, errors, debug UI, and user-facing indicators.

Likely files:

- Create or extend `electron/meeting-copilot/MetricsStore.ts`
- Extend `electron/utils/redactForLog.ts` if needed
- Extend `MetricsDebugPanel.tsx`
- Extend `MeetingCopilotPanel.tsx`

Tests:

- Metrics contain required fields and no raw transcript/snippet bodies.
- Error events redact API keys and bearer tokens.
- Code-context indicator is shown when snippets are included.
- Provider failures show actionable messages.

### M13 - Project Context Packs

Purpose:

- Add config-first local project documentation packs for long-context orientation.
- Include bounded Markdown/text docs in `full_cached` prompts before transcript.
- Mark project docs as cacheable stable context and capture safe metrics.

Likely files:

- Create `electron/meeting-copilot/ProjectContextStore.ts`
- Extend `electron/meeting-copilot/types.ts`
- Extend `electron/meeting-copilot/defaultActionConfig.ts`
- Extend `electron/meeting-copilot/ActionConfigStore.ts`
- Extend `electron/meeting-copilot/ContextBuilder.ts`
- Extend `electron/meeting-copilot/PromptCache.ts`
- Extend `electron/meeting-copilot/ActionRunManager.ts`
- Extend `electron/meeting-copilot/MetricsStore.ts`
- Extend `src/components/meeting-copilot/MeetingCopilotPanel.tsx`
- Add tests under `electron/services/__tests__/MeetingCopilotProjectContext.test.mjs`

Tests:

- Configuring one or more packs is validated.
- Missing/unreadable `docsPath` produces a warning and does not fail actions.
- Only `.md`, `.mdx`, and `.txt` files are included.
- Excluded paths are ignored.
- Per-pack and global char limits are enforced.
- Prompt order is stable and cache-friendly.
- `full_cached` prompts include project docs before transcript.
- `recent` prompts do not include full docs packs by default.
- Project docs are marked cacheable for Anthropic.
- Metrics capture docs inclusion, pack names, char count, and file count without raw doc content.

### M14 - Freshness Policy And Currentness Caveats

Purpose:

- Add the policy layer that detects freshness-sensitive topics and decides whether to verify, caveat, or skip.
- Add prompt instructions and metrics fields for verified vs unverified current external facts.
- Do not add web search yet unless the implementation plan explicitly narrows and verifies the privacy behavior first.

Likely files:

- Create `electron/meeting-copilot/FreshnessPolicy.ts`
- Extend `electron/meeting-copilot/types.ts`
- Extend `electron/meeting-copilot/ContextBuilder.ts`
- Extend `electron/meeting-copilot/ActionRunManager.ts`
- Extend `electron/meeting-copilot/MetricsStore.ts`
- Extend `src/components/meeting-copilot/MeetingCopilotPanel.tsx`
- Add tests under `electron/services/__tests__/MeetingCopilotFreshnessPolicy.test.mjs`

Tests:

- Model availability/pricing/context-window/API/benchmark/news/regulation topics are freshness-sensitive.
- Ordinary internal repo questions are not treated as freshness-sensitive.
- Quick Answer, Follow-ups, and fast branch do not block on freshness checks.
- Claim Check and Deep Solution allow freshness checks when configured.
- If no freshness tool is available, prompts/answers are instructed to mark current facts as unverified/currentness-uncertain.
- Metrics capture freshness policy decisions without raw transcript/code leakage.

### M15 - Minimal Freshness Tools

Purpose:

- Add read-only bounded freshness tools after the policy layer exists.
- Prefer OpenRouter model catalog lookup for OpenRouter-specific model facts.
- Add web search only if a configured provider or OpenRouter server-side capability can be integrated without private transcript/code leakage.

Likely files:

- Create `electron/meeting-copilot/FreshnessTools.ts`
- Extend `electron/meeting-copilot/OpenRouterClient.ts` if OpenRouter catalog access is implemented there.
- Extend `electron/meeting-copilot/ToolLoop.ts`
- Extend `electron/meeting-copilot/ActionRunManager.ts`
- Extend `electron/meeting-copilot/MetricsStore.ts`
- Extend `src/components/meeting-copilot/MeetingCopilotPanel.tsx`
- Add tests under `electron/services/__tests__/MeetingCopilotFreshnessTools.test.mjs`

Tests:

- OpenRouter model catalog lookup returns bounded model metadata.
- Web search, if implemented, rejects or genericizes private transcript/code-derived queries.
- Freshness results are placed in dynamic evidence, not cacheable blocks.
- Freshness failures do not fail the action.
- Current external claims are marked unverified when tools fail or are unavailable.
- Metrics capture source names/domains, query count, result count, verified timestamp, and errors without raw web pages.

## Implementation Order

1. M1 Action config schema and store.
2. M2 Transcript buffer and context builder.
3. M3 OpenRouter client without tools.
4. M4 Single action runner and IPC skeleton.
5. M5 Renderer response panel.
6. M6 Pinned context storage and editor.
7. M7 Required hotkeys.
8. M8 Anthropic full-cached lane.
9. M9 Parallel Fast + Deep action.
10. M10 Workspace allowlist and manual code tools.
11. M11 Tool loop and final streaming.
12. M12 Metrics, redaction, and polish.
13. M13 Project Context Packs.
14. M14 Freshness policy and currentness caveats.
15. M15 Minimal freshness tools.

This order keeps each slice independently testable and avoids starting with UI or provider work before the contracts are stable.

M13-M15 are a post-v1 Context & Verification extension. Implement M13 first because it is local, deterministic, and low-risk. Do not combine M14/M15 with M13; freshness touches privacy, external network behavior, provider-specific APIs, and answer policy.

## Execution Guidance

The files under `docs/meeting-copilot/slices/` are slice specs, not full Superpowers implementation plans.

- M1 can be implemented directly from `docs/meeting-copilot/slices/01-action-config.md` by one main agent.
- M13 can be implemented from `docs/meeting-copilot/slices/13-project-context-packs.md` by one main agent, but a short formal plan is still useful if the implementer is unfamiliar with the M0-M12 code.
- M14 and M15 require formal Superpowers implementation plans before code.
- For later slices that touch IPC, renderer UI, provider behavior, streaming, hotkeys, transcript state, code tools, or security/privacy behavior, first generate a formal Superpowers implementation plan from the slice or milestone.
- Formal plans should use `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md` unless the user requests a different location.
- Formal plans should be executed with `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
- Parallel agents should either receive one independent slice/spec each or perform read-only investigation/review tasks. Avoid multiple write agents editing the same files.
- After every implementation slice, append changed files, commands run, results, and any scope changes to `docs/meeting-copilot/99-implementation-log.md`.

As of 2026-07-03, official Codex guidance recommends `gpt-5.5` for complex coding, computer use, knowledge work, and research workflows. It recommends `gpt-5.4-mini` for faster, lower-cost lighter coding tasks and subagents. Use `gpt-5.4` when a workflow is pinned to GPT-5.4 or when a middle ground between depth and cost is appropriate.

## Agent And Model Recommendations

| Milestone | Execution style | Recommended model/agent |
| --- | --- | --- |
| M1 Action config schema and store | Direct from slice spec; one main agent; no subagents needed | `gpt-5.4-mini` is acceptable; use `gpt-5.4` for extra caution |
| M2 Transcript buffer and context builder | Formal plan recommended before code; one main write agent | `gpt-5.5`; optional `gpt-5.4-mini` read-only subagent to audit existing transcript tests |
| M3 OpenRouter client without tools | Formal plan recommended; one main write agent | `gpt-5.5` or `gpt-5.4`; use main agent to verify current OpenRouter docs |
| M4 Single action runner and IPC skeleton | Formal plan required; one main write agent | `gpt-5.5` |
| M5 Renderer response panel | Formal plan required; one main write agent | `gpt-5.5`; optional `gpt-5.4-mini` read-only UI/repo mapper |
| M6 Pinned context storage and editor | Formal plan recommended; one main write agent | `gpt-5.4` or `gpt-5.5` |
| M7 Required hotkeys | Formal plan recommended; one main write agent | `gpt-5.4` or `gpt-5.5`; macOS manual verification later |
| M8 Anthropic full-cached lane | Formal plan required; one main write agent | `gpt-5.5` |
| M9 Parallel Fast + Deep action | Formal plan required; one main write agent | `gpt-5.5` |
| M10 Workspace allowlist and manual code tools | Formal plan required; one main write agent | `gpt-5.5`; optional `gpt-5.4-mini` read-only security/test-gap subagent |
| M11 Tool loop and final streaming | Formal plan required; one main write agent | `gpt-5.5` with higher reasoning effort |
| M12 Metrics, redaction, and polish | Formal plan recommended; one main write agent | `gpt-5.5`; optional `gpt-5.4-mini` read-only log/privacy audit |
| M13 Project Context Packs | Direct from slice or short formal plan; one main write agent | `gpt-5.4-mini` is acceptable; use `gpt-5.4` reviewer for prompt/cache behavior |
| M14 Freshness policy and currentness caveats | Formal plan required; one main write agent plus privacy review | `gpt-5.4` or stronger; use `gpt-5.4-mini` only for read-only test-gap review |
| M15 Minimal freshness tools | Formal plan required; one main write agent plus privacy/security review | `gpt-5.5` or strongest available; external-source behavior should get a stronger reviewer |

## Risks And Mitigations

- Risk: Existing `SessionTracker` mixes assistant messages and compacted summaries with transcript context.
  - Mitigation: create a dedicated meeting-copilot transcript buffer and feed it only finalized meeting transcript events.

- Risk: Existing keybind defaults conflict with required hotkeys or user overrides.
  - Mitigation: add new meeting-copilot action IDs and defaults, then preserve existing user override loading.

- Risk: OpenRouter Anthropic cache-control shape may differ from the brief.
  - Mitigation: isolate cache serialization in `PromptCache`, verify provider docs during implementation, and retry once without cache-control.

- Risk: Existing `NativelyInterface` has a single streaming message model.
  - Mitigation: add a separate meeting-copilot run reducer/panel that supports run IDs and panes.

- Risk: Code snippets could leak secrets.
  - Mitigation: enforce workspace allowlists, default excludes, snippet limits, and redaction before provider calls and logs.

- Risk: Broad existing provider/RAG systems invite accidental scope creep.
  - Mitigation: keep OpenRouter client and `rg` tools in `electron/meeting-copilot/*` and do not depend on RAG/vector services.

- Risk: macOS global shortcuts can fail due to OS/app conflicts.
  - Mitigation: reuse `KeybindManager` registration-failed reporting and show a clear debug/status message.

- Risk: App data path migration to `natively-private` could lose existing settings.
  - Mitigation: defer product identity/data-directory migration until after core v1 behavior works.

- Risk: Project docs can be stale and conflict with code.
  - Mitigation: prompt hierarchy states docs are orientation and code wins; code-enabled actions should verify implementation-sensitive claims against actual code.

- Risk: Full project docs can bloat fast/recent prompts and slow down live meeting use.
  - Mitigation: include full packs only in `full_cached`; recent/fast actions get no full pack by default.

- Risk: Web verification could leak private meeting or code details through search queries.
  - Mitigation: implement freshness policy before tools, genericize queries, skip verification when private context is required, and log only bounded source metadata.

- Risk: Freshness checks can make every action slow or unreliable.
  - Mitigation: do not run checks by default; allow them mainly for Claim Check, Deep Solution, and current-fact Tech Solver cases; failures produce caveats instead of action failure.

## macOS Verification Later

These checks require a macOS app run and should be performed after implementation slices reach runtime behavior:

1. Start the app in dev mode on macOS.
2. Confirm microphone/system audio permissions still work.
3. Confirm global hotkeys `Command+Shift+1` through `Command+Shift+6` register successfully.
4. Confirm hotkeys trigger while the overlay/meeting surface is active.
5. Confirm hotkey registration failures are visible if another app owns a shortcut.
6. Confirm Quick Answer uses recent transcript only.
7. Confirm Tech Solver and Deep Solution use full transcript and pinned context.
8. Confirm Anthropic cache-control is present on long-context OpenRouter requests and retry works when disabled.
9. Confirm Tech Solver: Fast + Deep displays fast output before deep output completes.
10. Confirm deep branch cancellation leaves fast output intact.
11. Confirm configured code workspaces can be searched/read with `rg`.
12. Confirm paths outside allowlisted workspaces are blocked.
13. Confirm excluded files such as `.env` and private keys are not sent.
14. Confirm metrics show TTFT, total latency, model, context mode, cache fields, and tool counts where available.
15. Confirm full transcript, full snippets, API keys, and raw tool responses are not logged by default.
16. Confirm no Rust/native modules changed and existing audio behavior still works.
17. Confirm configured project context packs load from local docs folders on macOS paths.
18. Confirm missing/unreadable project docs produce warnings but actions still work.
19. Confirm full-cached actions include project docs before transcript and recent/fast actions do not include full packs.
20. Confirm freshness failures mark current claims as unverified rather than crashing actions.
21. Confirm web/search queries, if implemented, do not include private meeting transcript or private code text by default.
