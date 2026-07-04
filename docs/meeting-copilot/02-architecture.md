# Meeting Copilot Architecture

## Proposed Architecture

Meeting-copilot v1 should be implemented as a focused TypeScript feature area beside the existing Natively systems.

Proposed Electron main modules:

- `electron/meeting-copilot/types.ts`
  - Shared action config, run, transcript, tool, metrics, and IPC payload types.
- `electron/meeting-copilot/defaultActionConfig.ts`
  - Default OpenRouter/action/workspace config.
- `electron/meeting-copilot/ActionConfigStore.ts`
  - Loads defaults and optional local override JSON.
  - Validates config and exposes resolved actions.
- `electron/meeting-copilot/TranscriptBuffer.ts`
  - Meeting-only append-only finalized transcript chunks.
  - Fed from existing STT final transcript events in `electron/main.ts`.
- `electron/meeting-copilot/ContextBuilder.ts`
  - Builds `recent` and `full_cached` prompt contexts from snapshots.
- `electron/meeting-copilot/OpenRouterClient.ts`
  - Thin `fetch` based OpenRouter chat completions client.
- `electron/meeting-copilot/PromptCache.ts`
  - Anthropic/OpenRouter cache-control serialization and cache retry decisions.
- `electron/meeting-copilot/ActionRunManager.ts`
  - Action orchestration, run IDs, branch controllers, lifecycle, cancellation, metrics.
- `electron/meeting-copilot/CodeWorkspaceStore.ts`
  - Local workspace allowlist config.
- `electron/meeting-copilot/CodeTools.ts`
  - Safe `rg` search, file snippet reading, workspace listing, redaction, truncation.
- `electron/meeting-copilot/ToolLoop.ts`
  - Bounded non-streaming tool-call turns plus final streaming answer request.
- `electron/meeting-copilot/ProjectContextStore.ts`
  - Loads configured local project context packs from Markdown/text files.
  - Enforces docs path allowlisting, extension filters, exclusions, and char limits.
- `electron/meeting-copilot/FreshnessPolicy.ts`
  - Detects freshness-sensitive action topics and decides whether to verify, caveat, or skip.
- `electron/meeting-copilot/FreshnessTools.ts`
  - Optional read-only freshness lookups such as OpenRouter model catalog checks and bounded web search/fetch.
- `electron/meeting-copilot/MetricsStore.ts`
  - Sanitized compact local metrics records.
- `electron/meeting-copilot/ipc.ts`
  - Registration helpers called from `electron/ipcHandlers.ts`.

Proposed React renderer modules:

- `src/components/meeting-copilot/MeetingCopilotPanel.tsx`
  - Response panels, run list, copy/cancel controls, metrics summary.
- `src/components/meeting-copilot/ParallelRunPanel.tsx`
  - Fast answer and deep refinement panes.
- `src/components/meeting-copilot/PinnedContextEditor.tsx`
  - Editable pinned context block.
- `src/components/meeting-copilot/ToolActivity.tsx`
  - Bounded tool status display.
- `src/components/meeting-copilot/MetricsDebugPanel.tsx`
  - Debug display for sanitized metrics, including project-doc and freshness indicators when present.
- `src/hooks/useMeetingCopilot.ts`
  - Renderer state reducer for action events.

The first implementation slice should only create the action config layer. Runtime wiring, provider calls, hotkeys, transcript capture, UI panels, and code tools come later.

## Data Flow

```text
existing audio/STT provider
-> finalized transcript event in Electron main
-> MeetingCopilot TranscriptBuffer
-> hotkey action trigger
-> ActionRunManager
-> ContextBuilder
-> optional ToolLoop and CodeTools
-> optional FreshnessPolicy and FreshnessTools
-> OpenRouterClient
-> IPC events
-> React MeetingCopilotPanel
```

For a single action:

```text
hotkey
-> snapshot transcript
-> build recent or full_cached context
-> optional non-streaming tool rounds
-> streaming final answer request
-> token/status/metrics events
```

For a parallel action:

```text
hotkey
-> one transcript snapshot
-> fast branch builds recent context
-> deep branch builds full_cached context
-> fast branch streams immediately
-> deep branch may run tools, then streams refinement
-> each branch has its own AbortController and metrics
```

## State Separation

Meeting-copilot must keep transcript, action, evidence, and stable context stores separate.

### 1. Meeting Transcript

- Contains only finalized human/system meeting transcript chunks.
- Does not contain LLM answers, tool calls, tool results, debug notes, or action logs.
- Is append-only for prompt stability.
- V1 can be in-memory while the app is running.
- Later persistence should use stable chunk IDs and start/end timestamps.

```ts
type TranscriptChunk = {
  id: string;
  meeting_id: string;
  start_ts: string;
  end_ts: string;
  text: string;
  source?: "mic" | "system" | "mixed";
};
```

### 2. Action Run History

- One ephemeral LLM/tool conversation per invocation.
- Lives only for the current run while tools/final answer are executing.
- Compact sanitized record can be stored for debugging and metrics after completion.
- Raw previous messages are not included in later prompts by default.

### 3. Code Evidence Bundle

- Contains useful file snippets with file paths and line ranges.
- Created from current tool results or manually pinned code context.
- Included in model prompts only when freshly retrieved, pinned, or explicitly selected.
- Raw tool-call conversations are not reusable context.

### 4. Pinned/Custom Context

- Manually edited stable context.
- Included in both `recent` and `full_cached` prompts.
- Should not be mutated automatically in v1.
- Pinned code snippets may be stored separately from general pinned meeting context if that keeps UI clearer.

### 5. Project Context Packs

- Local Markdown/text docs associated with a repo workspace.
- Used as high-signal orientation: project purpose, architecture, decisions, tradeoffs, glossary, critical flows, known risks, and meeting cheat sheets.
- Treated as stable/cacheable context for full-cached actions.
- Never treated as source of truth for current implementation details when code evidence disagrees.
- Missing or invalid packs produce warnings and are skipped.

### 6. Dynamic Verification Evidence

- Contains fresh code evidence, OpenRouter model catalog checks, web verification results, and fetched-source extracts.
- Included only in the current action prompt.
- Not cacheable.
- Not reused in future prompts unless manually pinned or freshly retrieved again.
- Logs store only bounded metadata such as query count, source domains, result count, and timestamps by default.

## Action Run Lifecycle

1. User triggers an action by hotkey.
2. Main process resolves action config by `actionId`.
3. Main process creates an action run:
   - `runId`
   - `meetingId`
   - `actionId`
   - branch controllers
   - transcript snapshot marker
   - metrics timers
4. Main process emits `action:started`.
5. Main process snapshots transcript from `TranscriptBuffer`.
6. `ContextBuilder` builds the requested context mode:
   - `recent`: recent transcript window plus custom/pinned context
   - `full_cached`: stable instructions, custom context, project docs, pinned context, full transcript
7. If the action is tool-enabled:
   - `ToolLoop` sends non-streaming tool-call requests.
   - Valid tool calls are executed through `CodeTools`.
   - Tool results are redacted/truncated.
   - Tool activity events are emitted.
   - Final answer is requested with tools disabled and streamed.
8. If the action is not tool-enabled:
   - `OpenRouterClient` streams the answer directly.
9. If the action/topic needs freshness verification and the action allows it:
   - `FreshnessPolicy` decides whether to use a model catalog lookup, official-source lookup, web search, or a currentness caveat.
   - `FreshnessTools` produce bounded dynamic evidence and source metadata.
   - Freshness results are placed in dynamic evidence, not stable cached context.
10. Main process emits token deltas as bounded events.
11. On completion, main process emits compact metrics and a completion event.
12. On error, main process emits a sanitized error event and records failure metrics.
13. On cancellation, the relevant branch `AbortController` is aborted and a cancellation event is emitted.

## IPC Event Flow

Use namespaced channels and one typed event stream to avoid multiplying renderer listeners.

Renderer to main:

```ts
type MeetingCopilotInvoke =
  | { type: "action:start"; actionId: string }
  | { type: "action:cancel"; runId: string; branch?: "fast" | "deep" | "all" }
  | { type: "context:pin:update"; value: string }
  | { type: "context:pin:reset" }
  | { type: "code:search"; query: string; workspace?: string }
  | { type: "code:read"; path: string; startLine?: number; endLine?: number }
  | { type: "code:pin"; source: CodeSource }
  | { type: "code:clear" };
```

Main to renderer:

```ts
type MeetingCopilotEvent =
  | { type: "action:started"; runId: string; actionId: string; label: string }
  | { type: "action:token"; runId: string; pane: "main" | "fast" | "deep"; token: string }
  | { type: "action:tool_status"; runId: string; message: string }
  | { type: "action:completed"; runId: string; metrics: LlmCallMetrics }
  | { type: "action:error"; runId: string; error: string }
  | { type: "action:cancelled"; runId: string; branch?: "fast" | "deep" | "all" }
  | { type: "context:pin:updated"; value: string }
  | { type: "code:results"; results: SearchHit[] | FileSlice }
  | { type: "metrics:update"; metrics: LlmCallMetrics };
```

Implementation notes:

- Add invoke wrappers in `electron/preload.ts`.
- Add renderer types in `src/types/electron.d.ts`.
- Register handlers from `electron/ipcHandlers.ts`, preferably delegating to `electron/meeting-copilot/ipc.ts`.
- Keep token events as deltas, not full accumulated text.
- Cap tool status/result events before sending to the renderer.
- Do not send raw prompt, full transcript, full snippets, or raw tool results over debug events.

## OpenRouter Client Design

The client should be small and explicit.

Responsibilities:

- Read base URL and headers from action config.
- Resolve API key from `OPENROUTER_API_KEY` first, then a future secure credential source.
- Build OpenAI-compatible `/chat/completions` payloads.
- Support streaming and non-streaming calls.
- Parse SSE token deltas for final response streaming.
- Preserve tool-call payloads for non-streaming tool turns.
- Pass through `reasoning`.
- Pass through `tools` and `tool_choice`.
- Attach Anthropic cache-control payloads when requested by `PromptCache`.
- Use `AbortSignal` for cancellation.
- Collect sanitized timing and token usage metrics.
- Retry once without cache-control when the provider rejects cache-control formatting.

Non-responsibilities:

- No provider routing across the existing full app.
- No LangChain/LangGraph/MCP.
- No automatic model discovery in v1.
- No prompt summarization or token fallback.

Suggested public shape:

```ts
type ChatCompletionRequest = {
  model: string;
  messages: OpenRouterMessage[];
  tools?: OpenRouterTool[];
  tool_choice?: "auto" | "none";
  reasoning?: { effort?: ReasoningEffort };
  max_tokens: number;
  temperature: number;
  stream: boolean;
  session_id?: string;
  signal?: AbortSignal;
};
```

## Tool Loop Design

Tool-enabled actions use non-streaming calls while the model may request tools.

Allowed tools:

- `list_workspaces`
- `search_repo`
- `read_file`

Loop rules:

- Enable tools only for Tech Solver, Deep Solution, and the deep branch of Tech Solver: Fast + Deep.
- Validate tool name and JSON arguments before execution.
- Enforce `max_tool_rounds`.
- Enforce `max_tool_calls_per_round`.
- Enforce workspace allowlist before searching or reading.
- Execute `rg` with argument arrays, never shell strings.
- Return compact JSON tool results.
- Redact secrets and truncate snippets before they are appended to messages or sent to the provider.
- Distill useful tool results into a code evidence bundle for the final answer request.
- Do not preserve raw tool histories as future prompt context.

Final streaming after tools:

- If tool rounds produce evidence, build a final prompt containing transcript context plus distilled code evidence.
- Disable tools for the final request.
- Stream the final answer.
- If the model already returned a complete final answer and no additional streaming request is practical, render that final text directly and mark the fallback in metrics/debug state.

## Prompt Caching Design

Cache policies:

```ts
type CachePolicy =
  | "none"
  | "anthropic_explicit_5m"
  | "anthropic_explicit_1h";
```

For `full_cached` actions with Anthropic/OpenRouter:

- Use one stable session ID per meeting, for example `natively-meeting-<meeting_id>`.
- Cache stable instructions, custom context, project docs context, pinned context, and the full transcript so far.
- Do not cache current action instructions.
- Do not cache dynamic code context.
- Do not cache freshness results, model catalog responses, web search results, fetched web pages, current pricing checks, or current benchmark checks.
- Do not cache tool calls or tool results.
- Do not cache tool schemas if they change.

Prompt layout:

```text
system content blocks:
  <stable_instructions>...</stable_instructions>      cacheable
  <custom_context>...</custom_context>                cacheable
  <project_docs_context>...</project_docs_context>    cacheable
  <pinned_context>...</pinned_context>                cacheable
  <meeting_transcript_so_far>...</meeting_transcript_so_far>  cacheable

user content:
  <dynamic_evidence_context>...</dynamic_evidence_context>  not cacheable
  <current_action>...</current_action>                not cacheable
```

Implementation details:

- Serialize `cache_control` only when `cache_policy` is not `none`.
- Use `ttl: "1h"` for `anthropic_explicit_1h` when accepted by OpenRouter.
- Use `ttl: "5m"` for `anthropic_explicit_5m` when accepted.
- Fallback to `{ type: "ephemeral" }` if TTL is unsupported.
- If the request fails because cache-control formatting is rejected, retry once without cache-control.
- Surface a debug warning that caching was disabled for that request.
- Treat prompt caching as best effort and do not fail the user action solely because caching failed.

The exact OpenRouter Anthropic cache-control format must be verified during the OpenRouter client slice.

## Code Tool Design

Workspace config:

```ts
type WorkspaceConfig = {
  name: string;
  path: string;
  enabled: boolean;
  max_snippets: number;
  max_snippet_chars: number;
};
```

Search behavior:

- Require `rg` on `PATH`.
- If missing, return the exact user-facing error from the PRD.
- Spawn `rg` with argument arrays.
- Cap query length.
- Cap total results.
- Exclude sensitive and high-noise paths by default:
  - `.env`
  - `.env.*`
  - `*.pem`
  - `*.key`
  - `id_rsa`
  - `id_ed25519`
  - `node_modules/`
  - `.git/`
  - `dist/`
  - `build/`
  - `target/`
- Return path, line range, and compact snippet.

Read behavior:

- Resolve and normalize requested path.
- Require path to stay inside an enabled workspace.
- Require range bounds or apply conservative defaults.
- Cap bytes/chars read.
- Redact secrets before returning snippets.
- Include file path and line numbers in evidence.

Safety:

- No shell execution.
- No file writes.
- No tests/package managers/git operations.
- No renderer direct file access.
- All code tool calls execute in Electron main.

## Project Context Pack Design

Configuration:

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

Loading behavior:

- Resolve `docsPath` as a local POSIX path.
- Include only `.md`, `.mdx`, and `.txt` files.
- Exclude `.git/`, `node_modules/`, `dist/`, `build/`, `target/`, `.env`, `.env.*`, `*.pem`, and `*.key`.
- Enumerate files deterministically by relative path so prompt order stays cache-friendly.
- Read bounded file content until pack and global char limits are reached.
- Format docs as a single `<project_docs_context>` block with file headers and relative paths.
- Record warnings for missing folders, unreadable files, empty packs, linked workspace misses, and truncation.

Prompt rules:

- Use project docs for high-level orientation, terminology, decisions, tradeoffs, risks, and meeting preparation.
- Verify implementation-sensitive claims against actual code when code tools are enabled and the answer depends on current behavior.
- When docs and code disagree, prefer code and say the docs appear stale, incomplete, or directionally correct only.
- Do not include full packs in recent/fast actions by default; at most include a small already-loaded overview/glossary/cheatsheet subset in a later optional slice.

## Freshness Verification Design

Freshness policy:

- Treat model availability, pricing, context windows, supported parameters, API behavior, benchmark rankings, provider outages, regulations/laws, recent releases, company announcements, and current events as time-sensitive.
- Do not run freshness checks for ordinary internal repo questions.
- Claim Check and Deep Solution may verify current external facts when tools are configured.
- Tech Solver may verify when the active topic is external/current.
- Quick Answer, Follow-ups, and the fast branch should not block on web search by default; they should caveat currentness when needed.

Freshness tools:

- Prefer source-specific checks before general web search.
- For OpenRouter-specific model facts, prefer OpenRouter model catalog data.
- For provider-specific behavior, prefer official docs when a source-specific tool is available.
- For broader recent facts, use bounded web search only if configured.
- Do not submit forms, log in, access private/paywalled systems, post content, purchase anything, or modify external state.

Privacy:

- Never send private meeting transcript or private code text as a web search query by default.
- Generate generic freshness queries, for example `OpenRouter Claude model pricing context length`, not meeting-specific or repo-specific queries.
- If a private detail is required to formulate the query, skip web search and mark the claim as unverified/currentness-uncertain.
- Do not log full web pages or raw source extracts by default.

## Metrics And Logging Design

Record one metrics object per LLM call or branch:

```ts
type LlmCallMetrics = {
  meeting_id: string;
  action_id: string;
  branch?: "single" | "fast" | "deep";
  model: string;
  context_mode: string;
  cache_policy: CachePolicy;
  prompt_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  completion_tokens?: number;
  tool_rounds?: number;
  tool_calls?: number;
  time_to_first_token_ms?: number;
  total_latency_ms?: number;
  code_context_included?: boolean;
  project_context_included?: boolean;
  project_context_pack_names?: string[];
  project_context_chars?: number;
  project_context_file_count?: number;
  freshness_check_used?: boolean;
  freshness_sources?: string[];
  freshness_query_count?: number;
  freshness_result_count?: number;
  freshness_verified_at?: string;
  freshness_error?: string;
  success: boolean;
  error_type?: string;
};
```

Logging rules:

- Do not log full transcript by default.
- Do not log full code snippets by default.
- Do not log raw tool responses by default.
- Do not log full project docs by default.
- Do not log full web pages by default.
- Do not log API keys, bearer tokens, or authorization headers.
- Redact credential-like strings from errors.
- Store compact action records locally for debugging.
- Renderer debug UI receives metrics, not raw prompts.

Metrics implementation can start as an in-memory and JSONL local store, then move to SQLite if persistent querying becomes important.
