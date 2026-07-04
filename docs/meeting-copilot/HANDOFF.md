# Meeting Copilot — macOS Testing Handoff

> **Testing in progress.** A live macOS testing session is underway (last updated
> **2026-07-04**). Before reading the generic instructions below, read
> **[§ Testing Session Status](#testing-session-status-2026-07-04)** — it records what
> is already verified, two bugs already fixed (uncommitted), the *actual* working launch
> sequence (the `npm start` Quick Start below is **broken** — see the status section),
> and how to drive the GUI headlessly over CDP.

## Quick Start

> ⚠️ **`npm start` does not currently launch the app** (see Testing Session Status →
> "Broken launch path"). Use the working sequence documented there instead. The block
> below is the *intended* flow, kept for reference.

```bash
# Clone & install
git clone git@github.com:AndreasSteinerPF/natively.git
cd natively
npm ci

# Set your OpenRouter API key
export OPENROUTER_API_KEY=sk-or-v1-...

# Start in dev mode  (⚠️ currently exits 1 — see Testing Session Status)
npm start          # alias for `npm run app:dev`
```

Dev mode runs Vite on port 5180 and Electron pointed at localhost:5180.

---

## Testing Session Status (2026-07-04)

This section is the source of truth for the in-progress macOS verification effort.
It supersedes the generic Quick Start above where they disagree.

### Approach

- **Both transcript sources, in sequence.** Phase 1: validated the full run pipeline using
  **pinned context** (no STT / no mic) so every non-transcript item could be checked
  headlessly. Phase 2 (set up STT/mic) turned out to first need a real implementation fix —
  **see "✅ RESOLVED: live transcript is now wired to Meeting Copilot" in the checklist
  section below** — which is now done and live-verified via a test-only injection seam
  (no physical mic needed for that verification). What's left of Phase 2 is a genuinely
  mic-dependent pass (#2, #4).
- **Cheap models for pipeline testing.** Because we are validating *plumbing*, not output
  quality, all actions are overridden to `anthropic/claude-haiku-4.5` (keeps Anthropic
  prompt-caching in play while staying cheap). This override lives in a **local userData
  config that is NOT in the repo**:
  `~/Library/Application Support/natively/meeting-copilot/meeting-copilot.config.json`
  (overrides every action's model + `tech-solver-parallel`'s `parallel.fast`/`parallel.deep`).
  Delete that file to restore the real default models.
- **Headless GUI driving over CDP.** We do **not** focus-steal or use AppleScript. Electron
  is launched with `--remote-debugging-port=9222`; Playwright connects with
  `chromium.connectOverCDP('http://localhost:9222')` and drives the real renderer through
  its preload bridge (`window.electronAPI.meetingCopilot.invoke/onEvent`). For anything
  visual, **ask the user** for a screenshot/description — they are collaborating live.

### Working launch sequence (use this, not `npm start`)

`npm start` fails: `npm run build`'s `clean` step wipes `dist-electron/`, and the electron
`tsc` is `--noEmit`, so `dist-electron/electron/main.js` never gets produced → `electron:dev`
exits 1. Launch the three pieces yourself instead:

```bash
# 0. one-time / after electron code changes — actually emit dist-electron
npm run build:electron

# 1. Vite dev server (leave running)
npm run dev -- --port 5180 --strictPort

# 2. Electron pointed at the dev server, with CDP open (leave running)
NODE_ENV=development ./node_modules/.bin/electron --remote-debugging-port=9222 .
```

Confirm liveness before driving:
`lsof -nP -iTCP:5180 -sTCP:LISTEN` and `lsof -nP -iTCP:9222 -sTCP:LISTEN`.

> As of this update **both Vite and Electron are stopped** — relaunch with the above
> before any further live CDP testing.

### Bugs found & fixed (UNCOMMITTED — still in working tree)

`git status` shows these; they are real fixes, not scratch work. Review & commit when ready.

1. **Onboarding black-window / infinite render loop.** Vite resolved the bare import
   `./lib/onboarding/orchestrator` to a no-op stub `orchestrator.mjs` (its `getSnapshot`
   returned a fresh object each call → `useSyncExternalStore` infinite loop in
   `OrchestratedToasterHost.tsx` → black window). **Fix:** renamed the stub
   `src/lib/onboarding/orchestrator.mjs` → `orchestrator.pure.mjs` so the bare import
   resolves to the real `orchestrator.ts`; updated the two test imports
   (`__tests__/orchestrator.test.mjs`, `__tests__/stageCatalog.test.mjs`). The `.pure.mjs`
   file only exports the pure `shouldShowToaster` + `DEFAULT_USER_STATE` for `node --test`.

2. **Empty content block → 400 on full_cached actions.** Anthropic rejects requests whose
   text content blocks are empty (`messages: text content blocks must be non-empty`).
   `buildOpenRouterMessages` emitted an empty block whenever a section (e.g. the transcript,
   before any speech) was empty → every Tech Solver / Deep Solution fired with an empty
   transcript 400'd. **Fix:** `electron/meeting-copilot/PromptCache.ts` now skips
   empty/whitespace-only sections. Regression tests added:
   `electron/services/__tests__/MeetingCopilotPromptCache.test.mjs` (new), and
   `MeetingCopilotActionRunManager.test.mjs` updated (block count 4→2 + a non-empty guard,
   since the old assertion had codified the buggy empty-block behaviour).

### Checklist progress

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Start in dev mode | ⚠️ | Works via the manual 3-step sequence above; `npm start` is broken. |
| 2 | Mic/system-audio perms | ⬜ | Underlying transcript-wiring gap is now **fixed** (see § Transcript bridge below) — this item just needs an actual physical mic/permission-flow pass, not blocked on implementation anymore. |
| 3 | All 6 hotkeys register | ✅ | Verified. |
| 4 | Hotkeys trigger while overlay active | ⬜ | Unrelated to the transcript gap; still not yet tested. |
| 5 | Hotkey registration failures visible | ⬜ | Not blocked by the transcript gap — retest candidate independent of STT. |
| 6 | Quick Answer uses recent transcript only | ✅ | **Live-verified after the transcript bridge fix.** Injected a fake transcript segment via the `NATIVELY_E2E=1` test seam (`__e2e__:inject-transcript` → `IntelligenceManager.handleTranscript`) containing a unique marker string; Quick Answer's streamed answer echoed it verbatim. Confirms real speech now reaches `recent` context mode end-to-end. |
| 7 | Tech/Deep use full transcript + pinned | ✅ | full_cached pipeline verified via pinned context. |
| 8 | cache_control on long-context; retry if disabled | 🟡 Partial | `cache_control` applied & serialized; needs long context to actually engage caching. |
| 9 | Fast+Deep shows fast before deep | ✅ | Fast pane streams/orders before deep. |
| 10 | Deep cancel leaves fast intact | ✅ | Verified (fire-and-forget start, cancel mid-flight). |
| 11 | Code workspaces searchable/readable via `rg` | ✅ | Live: Tech Solver's `search_repo`/`read_file` found & read a test file in a configured workspace, reported real content back. |
| 12 | Paths outside allowlist blocked | ✅ | Live: `read_file` on an absolute path outside the workspace threw a clean `action:error` ("outside the enabled workspace allowlist"); 0 leakage of the outside file's content in answer/logs/telemetry (grep-verified). |
| 13 | Excluded files (`.env`, keys) not sent | ✅ | Live: direct `read_file(".env")` inside the allowed workspace threw `"path \".env\" is excluded from code tools"`. Search-level exclusion (rg `--glob !<pattern>` in `CodeTools.searchRepo` for `.env`/`.pem`/`.key`/`id_rsa`/etc., `CodeTools.ts:12-24,246`) verified by source read + existing unit test `MeetingCopilotCodeTools.test.mjs` rather than a second live run (network outage mid-session; the model's own safety training also refused a literal "search for FAKE_SECRET" prompt before that, so a live re-run isn't more conclusive than the source+unit evidence already in hand). |
| 14 | Metrics: TTFT/latency/model/mode/cache/tool counts | ✅ | Fields present. |
| 15 | Transcript/snippets/keys/raw responses NOT logged | ✅ | `telemetry.jsonl` had only `app_start`/`credential_storage_status`; 0 secret/transcript matches. |
| 16 | No Rust/native changes; audio unaffected | ✅ | `git diff 70ae580^..HEAD` touches zero files under `native-module/`, no `.rs`/Cargo files, no audio-capture files; working tree confirms same. |
| 17 | Project context packs load from local docs | ⬜ | Not blocked by the transcript gap (docs load independent of transcript) — retest candidate, no mic needed. |
| 18 | Missing/unreadable project docs warn but actions still work | ⬜ | Same as #17 — no mic needed. |
| 19 | full_cached includes docs before transcript; recent/fast do not | 🟡 Partial | **Transcript inclusion now live-verified**: same injected marker also appeared correctly in Tech Solver's (`full_cached`) answer. The "docs *before* transcript" ordering half still needs #17/#18 (project docs configured) to fully exercise — `ContextBuilder.ts:94-109` already places `project_docs_context` before `meeting_transcript_so_far` in code, just not live-confirmed with both present simultaneously. |
| 20 | Freshness failures → unverified, not crash | ⬜ | Not started — needs network (was down at last check, see below). |
| 21 | Freshness/web queries exclude private transcript/code | ⬜ | Not started — needs network. |

Legend: ✅ verified · 🟡 partial · ⬜ not started.

### ✅ RESOLVED: live transcript is now wired to Meeting Copilot

**Originally a real implementation gap** (not a mic/provider setup issue), discovered while scoping Phase 2
(STT): `electron/ipcHandlers.ts`'s `transcriptSnapshotProvider` unconditionally returned `chunks: []`, so no
live speech could ever reach Quick Answer's `recent` context mode or Tech Solver/Deep Solution's `full_cached`
mode, regardless of STT setup. Full root-cause writeup: `docs/superpowers/specs/2026-07-04-meeting-copilot-transcript-bridge-design.md`
(kept local, not committed — see that repo's `.gitignore` note in the same doc).

**Fix implemented** (plan: `docs/superpowers/plans/2026-07-04-meeting-copilot-transcript-bridge.md`, also local):
a new pure module `electron/meeting-copilot/TranscriptBridge.ts` (`buildTranscriptSnapshot`) transforms the
app's already-running `SessionTracker` transcript (via `IntelligenceManager.getCurrentMeetingTranscript()`)
into a `TranscriptSnapshot` — filtering out the *other*, unrelated live-captions feature's own past AI
suggestions, applying speaker-role labels (`[ME]:`/`[INTERVIEWER]:`), and capping total size to the most
recent content via a new `transcript_context.max_total_chars` config field (mirrors `code_context`'s pattern).
`electron/ipcHandlers.ts`'s `transcriptSnapshotProvider` now calls it instead of returning an empty array.
`SessionTracker.mapSpeakerToRole` was extracted to a standalone exported function so the bridge reuses the
exact same interviewer/me mapping. No changes to STT capture, `SessionTracker`'s core logic, or
`ContextBuilder`. New unit tests: `MeetingCopilotTranscriptBridge.test.mjs` (5 tests) plus 2 new config
validation tests in `MeetingCopilotActionConfig.test.mjs` — full meeting-copilot suite: 142/142 passing.

**Live re-verified without a physical mic**, using the app's own `NATIVELY_E2E=1` test-only IPC seam
(`__e2e__:inject-transcript` → `IntelligenceManager.handleTranscript`, the exact same method real STT
provider callbacks call from `electron/main.ts:1854` — see `electron/ipcHandlers.ts` around line 9330).
Injected two segments containing a unique marker string (`PINECONE_XRAY_MARKER`) via
`window.electronAPI.e2eInvoke('__e2e__:inject-transcript', { speaker, text, final, confidence })`; both
Quick Answer (`recent`) and Tech Solver (`full_cached`) echoed the marker back in their real, live model
output — proving the full pipeline (STT-equivalent input → `SessionTracker` → `TranscriptBridge` →
`ActionRunManager` → `ContextBuilder` → prompt → model) works end-to-end. Re-confirmed telemetry still has
zero matches for the injected content (checklist #15 holds even with real transcript data now flowing).

**Remaining, now genuinely mic-dependent (not implementation-blocked):** #2 (physical mic/permission flow)
and #4 (hotkey dispatch while overlay active) still need an actual microphone pass — the underlying gap that
blocked them is fixed, this is just "someone needs to talk into a real mic and watch it work," not further
implementation. #19's transcript-inclusion half is now live-verified; its "docs before transcript" ordering
half still needs #17/#18 (project docs configured) to fully exercise. #5, #17/#18, #20/#21 remain as
previously scoped — unrelated to this gap, not yet tested.

### Code-tools batch (#11–13) — how it was done

A test workspace allowlist was configured in the same userData override file used for the cheap
models (`workspaces` key, sibling to `actions` — see [§ Testing Session Status](#testing-session-status-2026-07-04)
approach section for the path). It pointed at a scratch dir containing a normal `src/math.ts`, a
`.env`, and a `secrets.pem`; a second, separate sibling dir (not in the allowlist) held a dummy
"outside" file to probe boundary enforcement. **Electron must be restarted after editing this
config file** — `ActionConfigStore.loadSync()` only runs once at IPC-handler init, there's no
hot-reload.

**Important lesson learned:** the assistant treats `pinned_context` as *untrusted background data*,
not instructions — a prompt embedded in pinned context asking it to call `search_repo`/`read_file`
was correctly ignored (this is deliberate prompt-injection hardening, matching
`DEFAULT_MEETING_COPILOT_STABLE_INSTRUCTIONS` in `defaultActionConfig.ts`). To steer tool calls for
testing, override the action's own `prompt` field instead (same config file, e.g.
`"tech-solver": { "model": "...", "prompt": "Call the read_file tool with path \"...\", ..." }`) —
that's a legitimate instruction the model will follow, and it's how #11/#12/#13 were actually
driven. Also worth knowing for future test authors: asking the model to search for something
literally named `FAKE_SECRET` triggers a values-based refusal (Haiku declines to help "exfiltrate
secrets" even in an obvious test harness) — use a neutral-looking string (a stray digit sequence,
etc.) if you need the model to cooperate with a search-based probe.

Remaining open items:
- **#20/#21** (freshness failures degrade gracefully; freshness/web queries exclude private
  transcript/code) — not yet started; should be doable in Phase 1 (no mic needed), similar
  CDP-driven approach against Claim Check / freshness-sensitive prompts. **Blocked right now**
  by a network outage (`openrouter.ai` and even unrelated hosts were unreachable as of this
  update — not an app bug, just check connectivity before resuming).
- **Phase 2 (STT)** for all ⛔ items — needs the user's mic + a transcript provider; not started.
- **Cleanup**: the test workspace config (`workspaces` key) and the tech-solver `prompt` override
  used for #11–13 should be removed from the userData config once done (or left for a future
  agent to reuse for regression checks — note it here either way to avoid confusion).

### CDP driver scripts (recreate in your scratchpad)

Session scratchpad scripts are not durable. The reusable pattern — connect over CDP, find the
launcher page, drive `meetingCopilot` IPC while collecting `onEvent` streams:

```js
// cdp-action.cjs  —  usage: node cdp-action.cjs <actionId> "<pinned context>"
const { chromium } = require('/Users/ad53819/natively/node_modules/playwright/index.js');
(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  let page = null;
  for (const ctx of browser.contexts())
    for (const p of ctx.pages())
      if (p.url().includes('window=launcher')) page = p;
  if (!page) { console.log('no launcher page'); process.exit(1); }
  const actionId = process.argv[2] || 'tech-solver';
  const pinned = process.argv[3] || "TEST: one concrete recommendation in one sentence.";
  const result = await page.evaluate(async ({ actionId, pinned }) => {
    const api = window.electronAPI && window.electronAPI.meetingCopilot;
    if (!api) return { fatal: 'meetingCopilot IPC missing' };
    const events = []; const panes = { main:'', fast:'', deep:'' };
    let completed=null, errored=null, started=null; const toolStatus=[];
    const unsub = api.onEvent((e) => {
      if (e.type==='action:started') started=e;
      else if (e.type==='action:token') panes[e.pane]=(panes[e.pane]||'')+e.token;
      else if (e.type==='action:tool_status') toolStatus.push(e.message);
      else if (e.type==='action:completed') completed=e;
      else if (e.type==='action:error') errored=e;
      events.push(e.type);
    });
    const out = {};
    try { await api.invoke({ type:'context:pin:update', value: pinned }); out.pinSet=true; }
    catch(e){ out.pinErr=String(e && e.message || e); }
    try { out.startRet = await api.invoke({ type:'action:start', actionId }); }
    catch(e){ out.startErr = String(e && e.message || e); }
    const t0=Date.now();
    while(!completed && !errored && Date.now()-t0 < 70000){ await new Promise(r=>setTimeout(r,250)); }
    unsub && unsub();
    out.eventTypes=events; out.started=started; out.toolStatus=toolStatus;
    out.tokenCounts={main:panes.main.length, fast:panes.fast.length, deep:panes.deep.length};
    out.answer=(panes.main||panes.deep||panes.fast||'').slice(0,600);
    out.completed=completed; out.errored=errored;
    return out;
  }, { actionId, pinned });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
```

Key points when recreating: `require` Playwright by **absolute path** into the repo's
`node_modules` (a `.cjs` in scratchpad can't resolve it otherwise, and Playwright is CJS);
select the page whose URL contains `window=launcher`; to test cancellation, fire
`action:start` **without `await`** (fire-and-forget) — otherwise `invoke` only resolves after
the whole run completes — then send `action:cancel` with `{runId, branch:'deep'}` mid-stream.
Valid action IDs: `quick-answer`, `tech-solver`, `deep-solution`, `claim-check`,
`follow-up-questions`, `tech-solver-parallel` (Fast+Deep).

## Build Verification

```bash
npm run build              # Vite + TypeScript
npm run build:electron     # Electron TypeScript → dist-electron
```

Both must exit 0 before launching.

## Test Suite

```bash
npm run build:electron

for f in electron/services/__tests__/MeetingCopilot*.test.mjs \
         src/hooks/__tests__/useMeetingCopilotReducer.test.mjs; do
  node --test "$f"
done
```

All test files must pass. Note the new regression test added during the testing session:
`electron/services/__tests__/MeetingCopilotPromptCache.test.mjs` (empty-content-block guard —
see Testing Session Status). It imports from `dist-electron/`, so run `npm run build:electron`
first.

## Architecture At A Glance

**Electron main** (`electron/meeting-copilot/`):

| Module | Role |
|--------|------|
| `types.ts` | All shared ActionConfig, Run, Transcript, Tool, Metrics, IPC types |
| `defaultActionConfig.ts` | Six actions with OpenRouter defaults, model slugs, prompts, limits |
| `ActionConfigStore.ts` | Loads defaults + optional local JSON override, validates |
| `TranscriptBuffer.ts` | Append-only finalized transcript chunks from STT |
| `ContextBuilder.ts` | Builds `recent`/`full_cached` prompt contexts |
| `OpenRouterClient.ts` | Thin fetch-based OpenRouter chat completions (stream + non-stream) |
| `PromptCache.ts` | Anthropic cache-control serialization + retry logic |
| `ActionRunManager.ts` | Orchestration: run lifecycle, branches, cancellation, metrics |
| `CodeWorkspaceStore.ts` | Local workspace allowlist config |
| `CodeTools.ts` | Safe `rg` search, file snippet reading, redaction |
| `ToolLoop.ts` | Bounded non-streaming tool-call turns + final streaming answer |
| `ProjectContextStore.ts` | Loads Markdown/text project docs from configured paths |
| `FreshnessPolicy.ts` | Detects freshness-sensitive topics; decides verify/caveat/skip |
| `FreshnessTools.ts` | Read-only OpenRouter `/models` catalog lookup |
| `MetricsStore.ts` | Sanitized compact local metrics records |
| `hotkeys.ts` | Hotkey → action mapping + starter wiring |
| `ipc.ts` | IPC registration helpers |

**Integration points** in existing files:

- `electron/ipcHandlers.ts` — wires ActionRunManager, FreshnessTools, ProjectContextStore, MetricsStore
- `electron/main.ts` — imports `startMeetingCopilotActionForKeybind` for keybind dispatch
- `electron/preload.ts` — exposes IPC channels to renderer
- `electron/services/KeybindManager.ts` — registers 6 meeting-copilot keybinds
- `src/components/NativelyInterface.tsx` — mounts MeetingCopilotPanel
- `src/types/electron.d.ts` — renderer-side IPC type declarations

**Renderer** (`src/components/meeting-copilot/`):

| Component | Role |
|-----------|------|
| `MeetingCopilotPanel.tsx` | Response panels, run list, copy/cancel, metrics summary |
| `MetricsDebugPanel.tsx` | Per-run metrics inspector |
| `PinnedContextEditor.tsx` | Editable pinned context block |

**State hook:** `src/hooks/useMeetingCopilot.ts` — renderer-side run state reducer.

## Hotkeys

| Shortcut | Action |
|----------|--------|
| `Command+Shift+1` | Quick Answer |
| `Command+Shift+2` | Tech Solver |
| `Command+Shift+3` | Deep Solution |
| `Command+Shift+4` | Claim Check |
| `Command+Shift+5` | Follow-up Questions |
| `Command+Shift+6` | Tech Solver: Fast + Deep |

Registered via `KeybindManager` in `electron/services/KeybindManager.ts`.

## Prerequisites

- `OPENROUTER_API_KEY` env var set before launch
- `ripgrep` (`rg`) on PATH (for code tools in Tech Solver / Deep Solution)
- macOS with microphone/system audio permissions granted

## What Each Action Does

| Action | Context | Model | Key Behavior |
|--------|---------|-------|-------------|
| Quick Answer | Recent transcript (~2 min) | `google/gemini-3.5-flash` | Fast, low tokens, no tools |
| Tech Solver | Full cached transcript + pinned context + project docs | `anthropic/claude-opus-4.8-fast` | Up to 2 tool rounds (`rg` search, file read) |
| Deep Solution | Full cached transcript + pinned context + project docs | `openai/gpt-5.4` | Higher reasoning, deeper analysis |
| Claim Check | Full cached transcript + pinned context | configurable | Verifies technical claims against code/transcript |
| Follow-up Questions | Recent transcript | `google/gemini-3.5-flash` | Suggests follow-ups |
| Tech Solver: Fast+Deep | Full cached (parallel) | Fast: `anthropic/claude-sonnet-4` / Deep: `anthropic/claude-opus-4.8-fast` | Fast answer renders first; deep refines independently |

## macOS Verification Checklist (from roadmap)

1. Start in dev mode on macOS
2. Confirm microphone/system audio permissions still work
3. Confirm all 6 hotkeys register successfully
4. Confirm hotkeys trigger while the overlay is active
5. Confirm hotkey registration failures are visible if another app owns the shortcut
6. Confirm Quick Answer uses recent transcript only
7. Confirm Tech Solver and Deep Solution use full transcript + pinned context
8. Confirm Anthropic cache-control is present on long-context requests; retry works if disabled
9. Confirm Tech Solver: Fast+Deep displays fast output before deep completes
10. Confirm deep branch cancellation leaves fast output intact
11. Confirm code workspaces can be searched/read with `rg`
12. Confirm paths outside allowlisted workspaces are blocked
13. Confirm excluded files (`.env`, private keys) are not sent
14. Confirm metrics show TTFT, total latency, model, context mode, cache fields, tool counts
15. Confirm full transcript, snippets, API keys, raw tool responses are NOT logged
16. Confirm no Rust/native modules changed; existing audio behavior still works
17. Confirm project context packs load from local docs folders on macOS paths
18. Confirm missing/unreadable project docs warn but actions still work
19. Confirm full-cached actions include project docs before transcript; recent/fast do not
20. Confirm freshness failures mark claims as unverified rather than crashing
21. Confirm freshness/web queries do not include private transcript or private code

## Project Context Packs (M13)

Optional. Configured per-action in the config. Enabled packs load `.md`, `.mdx`, `.txt` files
from local docs folders. Disabled by default. Injected before transcript in `full_cached` prompts.

To test: create a docs folder with `.md` files, configure a pack in the action config pointing
to it, then trigger a full-cached action.

## Freshness (M14+M15)

**M14 (policy):** Detects freshness-sensitive topics (model availability, pricing, APIs,
benchmarks, regulations, news) and decides whether to verify, caveat, or skip.
Network-free. Does not make external calls.

**M15 (tools):** Only implements OpenRouter `/models` catalog lookup. No general web search.
Configured via OpenRouter API key env var. If key/env missing, actions continue with
"unverified" caveats.

## Running Tests

```bash
# Build Electron first (required)
npm run build:electron

# All meeting-copilot tests
node --test electron/services/__tests__/MeetingCopilot*.test.mjs

# Plus renderer reducer
node --test src/hooks/__tests__/useMeetingCopilotReducer.test.mjs

# Full service test suite (includes meeting-copilot)
npm run test:services
```

## Key Paths

| What | Path |
|------|------|
| Planning docs | `docs/meeting-copilot/` |
| Slice specs | `docs/meeting-copilot/slices/` |
| Implementation log | `docs/meeting-copilot/99-implementation-log.md` |
| Electron main code | `electron/meeting-copilot/` |
| Tests | `electron/services/__tests__/MeetingCopilot*.test.mjs` |
| Renderer components | `src/components/meeting-copilot/` |
| Renderer state hook | `src/hooks/useMeetingCopilot.ts` |

## Git State

```
Last commit: merge: upstream/main — RAG/onboarding/eval fixes
Branch: main
Remote: git@github.com:AndreasSteinerPF/natively.git
Upstream: git@github.com:Natively-AI-assistant/natively-cluely-ai-assistant.git
```

All meeting-copilot files are tracked in a single commit (`70ae580`).
Upstream merged clean at `4fc630a` — no conflicts with meeting-copilot files.

## Docs Reference

- `docs/meeting-copilot/00-prd.md` — Product requirements, goals, non-goals
- `docs/meeting-copilot/01-repo-map.md` — Repository structure and existing systems
- `docs/meeting-copilot/02-architecture.md` — Proposed architecture and modules
- `docs/meeting-copilot/03-roadmap.md` — M0-M15 milestones, execution guidance, macOS checklist
- `docs/meeting-copilot/slices/01-action-config.md` — Slice 1 spec
- `docs/meeting-copilot/slices/13-project-context-packs.md` — M13 spec
- `docs/meeting-copilot/slices/14-freshness-policy.md` — M14 spec
- `docs/meeting-copilot/slices/15-freshness-tools.md` — M15 spec

## Known Limitations / Caveats

- All meeting-copilot files were **new additions** — the feature tree did not exist before
  the implementation commit. Git diff against upstream shows only net-new files.
- General web search is intentionally unavailable for M15; only OpenRouter model catalog
  lookup was implemented.
- Package config still declares Windows/Linux targets; v1 is macOS-only in behavior.
- Hotkey conflicts with other macOS apps will surface as registration failures — check
  System Preferences > Keyboard > Shortcuts if hotkeys don't fire.
