# Meeting Copilot PRD

## Product Goal

Customize this private Natively fork into a macOS-only live meeting copilot for technical, AI, product, architecture, and LLM-agent/evaluation discussions.

The v1 workflow is:

1. Existing Natively audio capture and transcription produce live meeting transcript text.
2. The user triggers a configured action with a macOS hotkey.
3. Electron main snapshots the relevant transcript, pinned context, custom context, and optionally bounded local code snippets.
4. Electron main sends a request to OpenRouter using a thin custom client.
5. The renderer displays streamed answers, tool status, metrics, and cancellation controls.

All persistent settings, transcript buffers, pinned context, action logs, code allowlists, and metrics remain local by default. The only planned outbound data path is the explicitly configured provider request.

Post-v1 extension goal:

- Add a Context & Verification Layer so long-context answers can use local project documentation for orientation, verify implementation-sensitive claims against code, and verify time-sensitive external facts when freshness tools are available.
- Preserve the evidence hierarchy:
  1. Meeting transcript is the source of truth for what was said.
  2. Project docs are useful internal orientation and hypotheses.
  3. Actual repo code is the source of truth for implementation details.
  4. Fresh external sources are the source of truth for current public facts.
  5. LLM prior knowledge is a fallback and may be stale.

## Non-Goals

- No stealth, proctoring-evasion, detection-bypass, or concealment behavior.
- No Windows or Linux v1 work beyond preserving whatever already exists.
- No Rust/native module changes unless an existing audio/native behavior is broken and cannot be reached from TypeScript.
- No LLM/tool orchestration in Rust.
- No LangChain, LangGraph, MCP, or Vercel AI SDK.
- No semantic RAG, embeddings, vector database, or autonomous repository agent in v1.
- No shell execution, package manager execution, test execution, git write operations, or file editing exposed to the model.
- No transcript summarization fallback, automatic topic segmentation, or automatic meeting memory manager.
- No token-budget fallback for long-context actions in v1.
- No automatic inclusion of previous action-run histories in future prompts.
- No generic multi-provider cache framework. Anthropic/OpenRouter explicit caching is the only v1 cache lane.
- No elaborate benchmark suite before the core workflow works.
- No background indexing, embeddings, vector database, semantic project-doc retrieval, automatic doc generation, or project knowledge graph for the Context & Verification extension.
- No always-on web browsing, background news monitoring, browser automation, scraping-heavy workflows, autonomous deep-research agent, or permanent external knowledge database.
- No private transcript or private code leakage into web search queries by default.

## Target Platform

V1 target platform is macOS only.

Implementation should stay primarily in:

- Electron main TypeScript for action orchestration, OpenRouter calls, context building, code search/read tools, metrics, config, and IPC.
- React/Vite renderer TypeScript for overlay panels, pinned context editing, code-context indicators, metrics/debug display, and cancellation/copy controls.

Platform assumptions:

- Hotkeys use macOS notation such as `Command+Shift+1`.
- Local app data can use macOS app support paths. The current Electron app still uses `app.getPath("userData")`; changing the product data directory should be treated as a separate migration decision.
- POSIX path handling is acceptable for v1.
- `ripgrep` / `rg` is assumed to be installed and available on `PATH` for future code search.
- If `rg` is unavailable, code search must fail with:

```text
ripgrep (`rg`) is required for code search. Install it with Homebrew or make sure it is available on PATH.
```

## Required V1 Features

- Configurable local action layer with five single actions and one parallel action:
  - Quick Answer
  - Tech Solver
  - Deep Solution
  - Claim Check
  - Follow-up Questions
  - Tech Solver: Fast + Deep
- Required hotkeys:
  - `Command+Shift+1` Quick Answer
  - `Command+Shift+2` Tech Solver
  - `Command+Shift+3` Deep Solution
  - `Command+Shift+4` Claim Check
  - `Command+Shift+5` Follow-up Questions
  - `Command+Shift+6` Tech Solver: Fast + Deep
- Recent transcript context mode for quick actions.
- Full transcript cached context mode for long-context actions.
- Editable pinned context block.
- Stable custom context block or config field.
- Thin custom OpenRouter client in Electron main TypeScript supporting:
  - OpenAI-compatible chat completions
  - streaming final responses
  - non-streaming tool-call turns
  - tool schemas and tool-result messages
  - Anthropic cache-control payloads
  - reasoning config passthrough
  - cancellation via `AbortController`
  - sanitized metrics
- Anthropic long-context lane through OpenRouter with explicit prompt caching.
- Cache-control retry behavior:
  - first attempt uses cache-control when configured
  - if formatting is rejected, retry once without cache-control
  - continue the action and surface a debug warning
- Parallel Fast + Deep action:
  - fast branch uses recent transcript only and streams immediately
  - deep branch uses full cached transcript and may use code tools
  - branches stream independently
  - one branch can fail without cancelling the other
- Bounded read-only code context tools in Electron main:
  - `list_workspaces`
  - `search_repo`
  - `read_file`
- Workspace allowlist enforcement.
- Secret and sensitive-file exclusion/redaction before snippets are sent to providers.
- IPC for action start, token streaming, tool status, completion, errors, metrics, pinned context updates, code search/read, and cancellation.
- Renderer response UI showing action label, model, context mode, transcript window/snapshot, code-context indicator, tool status, metrics, stop/cancel, and copy.
- Metrics/debug UI with model, context mode, cache token fields when available, tool rounds/calls, time to first token, total latency, success/error state.
- Explicit state separation:
  - meeting transcript
  - action run history
  - code evidence bundle
  - pinned/custom context

## Context & Verification Extension Features

Project Context Packs:

- Local config can define one or more project context packs.
- Each pack points at a local docs folder containing ordinary `.md`, `.mdx`, or `.txt` files.
- Packs can be enabled/disabled, included by default, and optionally linked to a code workspace name.
- Missing/unreadable docs folders produce clear debug warnings and do not break actions.
- Long-context `full_cached` actions include enabled default project docs before the transcript.
- Recent/fast actions do not include full project docs by default.
- Project docs are stable/cacheable context for Anthropic full-cached prompts.
- Prompt instructions clearly state that project docs are orientation and actual code wins for implementation details.

Freshness & web verification:

- The assistant treats current external facts as time-sensitive, including model availability, pricing, context windows, API behavior, benchmark rankings, provider outages, regulations/laws, recent releases, company announcements, and current events.
- If freshness tools are unavailable or fail, answers should mark current claims as unverified/currentness-uncertain instead of presenting stale prior knowledge confidently.
- Freshness checks are not run for every action by default.
- Claim Check and Deep Solution may use freshness checks when the topic is external/current.
- Fast actions do not block on web verification; they can say verification is needed or pending.
- Freshness results are dynamic/non-cacheable context and are placed outside stable cached prompt blocks.
- Freshness queries must be genericized so private transcript/code details are not sent to web search by default.

## Deferred Features

- Slash commands and visible action buttons unless they are trivial to add after hotkeys work.
- Automatic pinned-context drafting from transcript.
- Persistent action-run browser beyond compact debug records.
- Durable transcript schema migration to immutable chunk rows.
- Full macOS app identity and data-directory migration to `natively-private`.
- Semantic repository retrieval, embeddings, vector indexes, or code intelligence.
- Automatic transcript summarization or fallback windowing for provider context-limit failures.
- Multi-meeting memory manager.
- Multi-provider caching abstraction.
- Windows/Linux packaging or compatibility work.
- Provider model availability validation against live OpenRouter metadata.
- Polished UI for project context pack selection, docs browsing, freshness source viewing, or per-action source controls.
- OpenRouter model catalog integration beyond the minimal freshness tool slice.
- General web search/fetch integration until the freshness policy, query sanitization, and metrics layer are in place.

## Success Criteria

- A user can configure OpenRouter and local actions without changing code.
- Required `Command+Shift+1` through `Command+Shift+6` hotkeys trigger the right actions during a meeting on macOS.
- Quick Answer and Follow-up Questions use only recent transcript context.
- Tech Solver and Deep Solution use full transcript context, pinned/custom context, Anthropic/OpenRouter long-context config, and explicit cache-control when enabled.
- Tech Solver: Fast + Deep streams a fast response before the deep branch completes.
- Deep branch and code-enabled actions can search/read allowlisted code snippets and then stream a final answer.
- Transcript data remains human/system meeting transcript only. LLM responses, tool calls, and tool results are not appended to it.
- Previous action-run messages are not included in future prompts by default.
- Code evidence can be included only when pinned, selected, or freshly retrieved for the current action.
- IPC payloads remain bounded and do not ship raw debug logs to the renderer.
- Logs and metrics redact secrets and avoid storing full transcripts, full snippets, and raw tool responses by default.
- Provider/cache errors are surfaced clearly without crashing the app.
- No Rust/native files are modified for v1.

Context & Verification extension success criteria:

- One or more project context packs can be configured in local config.
- Enabled packs load bounded Markdown/text docs and ignore excluded paths.
- Full-cached prompts include project docs before transcript and mark them cacheable.
- Recent/fast prompts do not receive full docs packs by default.
- Metrics/debug status show whether project docs were included, which packs were used, total chars, and file count.
- Prompt instructions distinguish meeting transcript, project docs, code evidence, fresh sources, and stale prior knowledge.
- Freshness-sensitive topics can be detected well enough to caveat or verify current external claims.
- Claim Check and Deep Solution can use freshness tools when configured.
- Freshness failures do not fail actions; current claims are marked unverified/currentness-uncertain.
- Raw project docs and raw web pages are not logged by default.
