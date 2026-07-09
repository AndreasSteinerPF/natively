# Meeting Copilot — macOS Testing Handoff

> **Testing in progress.** A live macOS testing session is underway (last updated
> **2026-07-04**). Before reading the generic instructions below, read
> **[§ Testing Session Status](#testing-session-status-2026-07-04)** — it records what
> is already verified, bugs already found & fixed (committed to `origin/main`), the *actual*
> working launch sequence (the `npm start` Quick Start below is **broken** — see the status
> section), and how to drive the GUI headlessly over CDP.

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

**One-time environment setup this checkout needed** (see § Physical mic pass below for full detail):
- `rustc`/`cargo` (install via `rustup`) + `npm run build:native` — the Rust native audio-capture module
  (`native-module/`) had no compiled `.node` binary; without it, mic/system-audio capture silently no-ops.
- `OPENROUTER_API_KEY` must be in the environment **before Electron launches** — persisted for this user in
  `~/.config/natively/env.sh` (chmod 600), sourced from `~/.zshrc`. If a fresh shell doesn't have it, `source
  ~/.zshrc` before launching, or check that file exists.
- To fully quit + relaunch Electron reliably: `pkill` won't match on `electron` — the app renames its main
  process to **`Natively`** at the OS level (`ps aux | grep -i natively` to find it, not `grep -i electron`
  alone, which will miss the main process and only catch the `Electron Helper (*)` children).
- **STT provider/model changes need a full quit+relaunch to take effect** — `prewarmSttProviders()` caches
  the constructed STT instances at app-launch and won't rebuild them for a running process, even mid-session
  Settings changes that persist to disk immediately. Starting a new meeting in the same running app does
  **not** pick up a just-changed provider/model.

### Bugs found & fixed (committed & pushed — `e9f100c` on `origin/main`)

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
| 2 | Mic/system-audio perms | ✅ | **Live-verified with a real physical mic.** macOS mic + screen-recording permissions granted and confirmed (`Init: Microphone/Screen recording permission status: granted`). Real speech captured, transcribed, and visible in both the live overlay-adjacent meeting record and the post-meeting Transcript tab. See § STT quality below for the road to get transcription actually usable — several real bugs/instability found and fixed along the way (native audio module never built, launcher crash, VAD over-fragmentation, local model instability). |
| 3 | All 6 hotkeys register | ✅ | Verified. |
| 4 | Hotkeys trigger while overlay active | ✅ | Live: pressed `⌘⇧1` (Quick Answer) while a real meeting/overlay was active; action fired, contacted OpenRouter, and returned a real (if initially transcript-starved) answer. Dispatch mechanism confirmed working independent of transcript quality. |
| 5 | Hotkey registration failures visible | ❌ | **Gap found.** Main process correctly detects registration failure and emits `keybinds:registration-failed` for any keybind id (`KeybindManager.ts:283-293`), but the renderer only surfaces it for one hardcoded id: `NativelyInterface.tsx:5337-5340` does `if (id !== 'chat:focusInput') return;` before showing a banner. For all 6 `meeting-copilot:*` hotkeys, a real registration failure is detected in the main process but never reaches the user — no banner, no toast. See § below for how this was found and why live reproduction was inconclusive. |
| 6 | Quick Answer uses recent transcript only | ✅ | **Live-verified after the transcript bridge fix.** Injected a fake transcript segment via the `NATIVELY_E2E=1` test seam (`__e2e__:inject-transcript` → `IntelligenceManager.handleTranscript`) containing a unique marker string; Quick Answer's streamed answer echoed it verbatim. Confirms real speech now reaches `recent` context mode end-to-end. |
| 7 | Tech/Deep use full transcript + pinned | ✅ | full_cached pipeline verified via pinned context. |
| 8 | cache_control on long-context; retry if disabled | 🟡 Partial | `cache_control` applied & serialized; needs long context to actually engage caching. |
| 9 | Fast+Deep shows fast before deep | ✅ | Fast pane streams/orders before deep. |
| 10 | Deep cancel leaves fast intact | ✅ | Verified (fire-and-forget start, cancel mid-flight). |
| 11 | Code workspaces searchable/readable via `rg` | ✅ | Live: Tech Solver's `search_repo`/`read_file` found & read a test file in a configured workspace, reported real content back. |
| 12 | Paths outside allowlist blocked | ✅ | Live: `read_file` on an absolute path outside the workspace threw a clean `action:error` ("outside the enabled workspace allowlist"); 0 leakage of the outside file's content in answer/logs/telemetry (grep-verified). |
| 13 | Excluded files (`.env`, keys) not sent | ✅ | Live: direct `read_file(".env")` inside the allowed workspace threw `"path \".env\" is excluded from code tools"`. Search-level exclusion (rg `--glob !<pattern>` in `CodeTools.searchRepo` for `.env`/`.pem`/`.key`/`id_rsa`/etc., `CodeTools.ts:12-24,246`) verified by source read + existing unit test `MeetingCopilotCodeTools.test.mjs` rather than a second live run (network outage mid-session; the model's own safety training also refused a literal "search for FAKE_SECRET" prompt before that, so a live re-run isn't more conclusive than the source+unit evidence already in hand). **Follow-up (2026-07-05): found and fixed a real gap** — this batch only tested bare `.env`, not `something.env` suffix patterns (e.g. `.dev.env`), which slipped through both `search_repo` and `read_file` exclusion checks. Fixed + regression-tested + live re-verified against a real repo containing a real `.dev.env` file — see § "Post-mic-pass follow-up testing" below. |
| 14 | Metrics: TTFT/latency/model/mode/cache/tool counts | ✅ | Fields present. |
| 15 | Transcript/snippets/keys/raw responses NOT logged | ✅ | `telemetry.jsonl` had only `app_start`/`credential_storage_status`; 0 secret/transcript matches. |
| 16 | No Rust/native changes; audio unaffected | ✅ | `git diff 70ae580^..HEAD` touches zero files under `native-module/`, no `.rs`/Cargo files, no audio-capture files; working tree confirms same. |
| 17 | Project context packs load from local docs | ✅ | Live: configured a `project_context.packs` entry (`test-docs`) pointing at a scratch docs folder with one `.md` file containing a marker string. Tech Solver's answer quoted the marker verbatim; metrics showed `project_context_included: true`, `project_context_pack_names: ["test-docs"]`, `project_context_file_count: 1`. A sibling `.env` file in the same folder was correctly skipped (warning: "only .md, .mdx, and .txt files are supported"). |
| 18 | Missing/unreadable project docs warn but actions still work | ✅ | Live: added a second pack (`missing-docs`) pointing at a nonexistent path. Run still completed successfully (`success: true`) with warnings: `"...could not be read: ENOENT..."` and `"...did not contain any supported Markdown or text files"` — action output was unaffected. |
| 19 | full_cached includes docs before transcript; recent/fast do not | ✅ | Live: injected a unique transcript marker (`QUOKKA_SPEECH_MARKER_5591`) via the `NATIVELY_E2E=1` seam alongside the docs marker (`ZEBRA_DOC_MARKER_7742`). Asked Tech Solver to list labeled context sections top-to-bottom — it reported `project_docs_context` before the transcript chunks, and quoted both markers correctly. Quick Answer (`recent` mode) run separately showed `project_context_included: false` / `project_context_chars: 0` even with docs configured, and the model self-reported "no project documentation in my context". Confirmed structurally in `ContextBuilder.ts`: `project_docs_context` section (line 96) is only added in the `full_cached` branch, before `meeting_transcript_so_far` (line 106); the `recent` branch (line 67) never references project docs. Telemetry re-checked: 0 matches for either marker. |
| 20 | Freshness failures → unverified, not crash | ✅ | Live: injected a transcript line mentioning a plausible-but-nonexistent model id (`anthropic/claude-nonexistent-999`) alongside a pricing question. Tech Solver's `freshness_check_used: true`, `freshness_query_count: 1`, `freshness_result_count: 0`, `freshness_error: "OpenRouter model catalog did not include anthropic/claude-nonexistent-999"` — run still completed (`success: true`) and the model explicitly stated the claim was unverified rather than guessing or crashing. Re-ran against Claim Check with a second freshness-sensitive line (breaking AI news, no model id) — same graceful-caveat behavior. Source-confirmed in `ActionRunManager.ts:764-778` (catalog-miss → `resultCount: 0` → unverified caveat text, not a throw) and `:731-745` (`no_safe_model_id` path when zero model ids are recognized). |
| 21 | Freshness/web queries exclude private transcript/code | ✅ | Source-confirmed: `FreshnessTools.fetchCatalog` (`FreshnessTools.ts:176-192`) issues a plain `GET {base_url}/models` with only an `Authorization` header and no body/query string — the full public model catalog is fetched once, then `ActionRunManager.buildFreshnessEvidence` matches a model id **locally** against it (`ActionRunManager.ts:753`, `FreshnessTools.ts:141`). The only "query" ever sent externally is nothing — no transcript or code content leaves the process. Live-confirmed by re-checking `telemetry.jsonl` after the freshness runs above: 0 matches for the injected transcript/model-id strings. |

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

**#2/#4 now live-verified with a real mic** (see § STT quality below for the road to get there — several
unrelated bugs found and fixed along the way). #17/#18/#19/#20/#21 are also fully verified (see checklist).
Only #5 remains untested — unrelated to this gap, no mic needed.

### Physical mic pass — STT quality journey (bugs found & fixed, final working config)

Getting from "app launches" to "usable real-speech transcript" surfaced four separate, unrelated bugs.
None of these are meeting-copilot bugs — they're pre-existing gaps in the app's audio/STT/launcher
infrastructure that this was the first real end-to-end test to exercise.

**1. Native audio module was never built.** `native-module/` (Rust, `napi-rs`) had no compiled `.node`
binary in this dev checkout — `MicrophoneCapture`/`SystemAudioCapture` both logged `Rust class
implementation not found` / `Cannot start: Rust module missing` and silently no-op'd. Mic permission was
granted, Local Whisper loaded fine, but zero real audio ever reached the pipeline. **Fix:** installed the
Rust toolchain (`rustup`, stable) and ran `npm run build:native`, which produced
`native-module/index.darwin-arm64.node`. Not committed — this is a one-time local dev-environment setup
step, not a code change. A future agent hitting the same symptom should check `rustc --version` /
`native-module/index.darwin-arm64.node` existence first.

**2. Launcher crashed on every single launch (Rust font-rasterizer, `fontations_ffi`).** Fully unrelated
to STT — see the dedicated write-up above (§ "Unrelated blocker found & fixed: launcher crash on every
launch"). Root cause: `OrchestratedToasterHost` rendering; fixed by removing it from `App.tsx` (personal
build, onboarding nudges not needed).

**3. VAD over-fragmentation on the local Whisper path.** `electron/audio/whisper/vadProcessor.ts`'s
`HANGOVER_FRAMES` closed a "speech segment" (and finalized the transcript) after only 300ms of silence —
shorter than a normal mid-sentence pause — so real speech came through as disconnected fragments
(`"Let's try something else." / "What about?" / "Evaluating and."`). Bumped to ~720ms
(`HANGOVER_FRAMES = 24`) after confirming (by reading `native-module/src/silence_suppression.rs`) that the
original "must stay below Rust's 500ms mic hangover" comment was overly conservative — Rust's
`SilenceSuppressor::process()` always forwards real speech frames immediately regardless of its internal
suppression state; the hangover there only governs when *silence* frames downgrade to lightweight
keepalives (a cloud-STT bandwidth/billing optimization, irrelevant to local inference). This meaningfully
reduced fragmentation but **only affects the `LocalWhisperSTT` code path** — `RestSTT.ts` (used by Groq/
Deepgram/etc.) doesn't use `VadProcessor.ts` at all; it just buffers ~3s windows and uploads via REST. Kept
in the codebase since it's a real, correct improvement for whoever uses local Whisper next, but it is
**not** what fixed the final working config below.

**4. Local Whisper model tradeoff: small models are fast but inaccurate; the big model crashes.**
- **Moonshine Base** (the on-device model this repo recommends for Apple Silicon, `hardwareDetect.ts:40-41`)
  streams in real time but consistently mis-transcribed ML/technical jargon even with fragmentation fixed:
  `"LLM"` → `"the element"` / `"an adolescent judge"`, `"precision and recall"` → `"position and recourse"`,
  `"embeddings"` → `"Belling's"`. Classic small-model vocabulary gap, not a bug — it just wasn't trained on
  much of this domain's terminology.
- **Whisper Large v3 Turbo** (`onnx-community/whisper-large-v3-turbo-ONNX`, the natural "bigger, more
  accurate" next step) **crashes the entire Electron app on load, 100% reproducibly**, on this machine.
  Confirmed via 3 separate attempts (including a fresh model download + full app restart each time) —
  always `EXC_BREAKPOINT`/`SIGTRAP` deep inside ONNX Runtime's memory allocator
  (`onnxruntime::BFCArena::Extend` → `CPUAllocator::Alloc` → `_posix_memalign`), triggered during
  `InferenceSession::Initialize()` while finalizing session state for this specific fp32 external-data
  checkpoint. Not investigated further (native ONNX Runtime internals, likely a CoreML-execution-provider +
  large-external-data-format interaction bug) — **not safe to select this model on this machine**; doing so
  crashes the app on the very next launch (or immediately, if a meeting is already active). If revisited,
  start by trying `dtype` overrides (e.g. int8/quantized instead of fp32) or the CPU-only execution provider
  (drop `coreml` from `providers=[...]`) to see if either avoids the allocator crash.
- **`localWhisperModel` is cached at app-launch pre-warm time, not read fresh per meeting.**
  `prewarmSttProviders()` (`electron/main.ts:2565`) guards with `if (this.googleSTT && this.googleSTT_User)
  return;` — so changing the STT provider/model via Settings while the app is running has **no effect**
  until a full quit + relaunch, even though `settings.json`/`credentials.enc` update immediately. Starting a
  new meeting does **not** pick up a mid-session model/provider change. Good to know for future agents: after
  any STT provider/model/key change, always fully quit (not just close-window) and relaunch before testing.

**Final working config: switched to Groq Whisper (cloud REST STT), `whisper-large-v3-turbo` model.**
Sidesteps both the local-model accuracy ceiling and the local-model crash entirely — Groq hosts the same
"Large v3 Turbo" weights server-side with no local ONNX Runtime involved. Set via
`window.electronAPI.testSttConnection('groq', key)` → `setGroqSttApiKey(key)` → `setSttProvider('groq')`
(same flow the Settings UI uses), then a full quit+relaunch. **Key is persisted in the app's own encrypted
`credentials.enc` store** (`CredentialsManager`), unlike `OPENROUTER_API_KEY` — no manual re-injection needed
on future launches; confirmed by a clean relaunch still resolving to `RestSTT (groq)` automatically.
Live-verified with real multi-sentence technical speech (RAG, LLM-as-a-judge, embeddings, evaluation
trade-offs) — transcript came through fully coherent and accurate, no fragmentation, no jargon
mis-transcription. This is the STT config to keep using for further live testing.

**Security note:** both the `OPENROUTER_API_KEY` and the Groq API key were shared directly in chat during
this session (the OpenRouter one was also visible in a screenshot background) — flagged to the user, who
should rotate both keys at their convenience since chat/session transcripts and screenshots are exactly
where secrets tend to leak from later.

### Post-mic-pass follow-up testing (2026-07-05)

Three additional tests requested once real speech was working end-to-end:

**1. Quick Answer picks the right pending question, not just the last utterance.** Live-verified: injected
a real technical question via the transcript, followed by two off-topic filler lines (small talk about
weather/sports). Quick Answer explicitly recognized the conversational drift ("the interviewer asked a
technical question... but the conversation shifted... without addressing it") and answered the actual
pending question rather than reacting to the filler. `recent` mode's ~2min window is wide enough, and the
model handles this correctly without any prompt changes needed.

**2. Custom repo context — found and fixed a real security gap.** Configured a real, substantial personal
repo (`~/done_diligence`, a RAG/multi-agent project with its own `.dev.env` file) as a `workspaces` entry,
plus its `docs/interview-prep/` as a `project_context` pack. While setting this up, found that
`CodeTools.ts`'s file-exclusion logic (`DEFAULT_EXCLUDED_GLOBS` for `search_repo`, `isExcludedRelativePath`
for `read_file`) only matched filenames that **start** with `.env` (`'.env'`, `.env.*`) — a real file like
`.dev.env` (which the repo's own `.gitignore` correctly excludes via `*.env`) would **not** have been
excluded, and its content (real resource/table names) could have leaked through both tools. **Fixed** in
`electron/meeting-copilot/CodeTools.ts`: added `'*.env'` to `DEFAULT_EXCLUDED_GLOBS` (search_repo's rg
excludes) and `basename.endsWith('.env')` to `isExcludedRelativePath` (read_file's path check). Added
regression tests to `MeetingCopilotCodeTools.test.mjs` (`.dev.env`, `staging.env` cases) — verified failing
before the fix, passing after. Live re-verified against the real repo: `read_file(".dev.env")` throws
`"path \".dev.env\" is excluded from code tools"`; `search_repo` for a term found in `.dev.env` returned
only legitimate source-code matches (env var *names* in `cdk_stack.py`), never the excluded file's content.
**This checklist #13 finding supersedes the earlier #11-13 batch's `.env` coverage** — that batch only
tested bare `.env`, not the `*.env` suffix pattern; re-verify with a `something.env`-style filename if
revisiting #13 on a fresh checkout.

**3. Action set reduced from 6 to 3.** Audited all 6 actions' full configs (model, context mode, tools,
token/reasoning budgets) side by side. Findings: **Tech Solver and Deep Solution were the same action on
one dial** — identical model (`anthropic/claude-opus-4.8-fast`), identical `full_cached` context mode,
identical tool-loop shape, differing only in reasoning effort (low vs medium) and token/tool-round budget.
**Tech Solver: Fast+Deep already subsumes both** — it runs a Quick-Answer-shaped fast pane and a
Tech/Deep-Solution-shaped deep pane in one hotkey press, the deep branch explicitly told to refine the fast
one. **Follow-up Questions was cut too** (user's call, "to keep things simple") — genuinely non-redundant
(only action producing a question-list rather than an answer) but low-frequency for this product's
primarily-answering-not-asking interview-assistant use case, and cutting it has zero effect on the other 3.
**Claim Check was kept** — the only action using a web-connected model (`perplexity/sonar-pro-search`),
structurally unique (fact-checking, not answering).

**Removed:** `tech-solver`, `deep-solution`, `followups` action definitions (`defaultActionConfig.ts`),
their keybind registrations (`KeybindManager.ts` `DEFAULT_KEYBINDS`), their hotkey routing entries
(`hotkeys.ts` `MEETING_COPILOT_HOTKEY_BINDINGS`), and their action-id branches in `FreshnessPolicy.ts`
(`actionAllowsFreshnessVerification`, `shouldOnlyCaveat` — now only reference `claim-check` and
`tech-solver-parallel`'s branches, since those are the only remaining actions freshness policy needs to
special-case). **Renumbered hotkeys to stay consecutive**: Quick Answer `⌘⇧1`, Claim Check `⌘⇧2` (was
`⌘⇧4`), Tech Solver: Fast+Deep `⌘⇧3` (was `⌘⇧6`) — `⌘⇧4/5/6` are now free. Updated 5 test files
(`MeetingCopilotActionConfig`, `MeetingCopilotHotkeys`, `MeetingCopilotFreshnessPolicy`,
`MeetingCopilotActionRunManager`, `MeetingCopilotProjectContext`) — tests that needed a generic
full_cached+tool-enabled single-branch action fixture (a shape the real defaults no longer expose standalone)
now insert one locally via a test-only `addFullCachedToolAction()` helper rather than relying on
`tech-solver`/`deep-solution` existing in `DEFAULT_MEETING_COPILOT_CONFIG`. **Also cleaned up the userData
config** (`~/Library/Application Support/Natively/meeting-copilot/meeting-copilot.config.json`) — it had
per-action model overrides for the removed actions, which would have crashed config validation on next
launch (a partial override with no base default to merge into is missing required `label`/`trigger` fields).
Full suite: 151/151 passing. Live-verified all 3 remaining actions fire correctly post-removal (Quick
Answer, Claim Check, Tech Solver: Fast+Deep — both fast and deep panes streamed).

### Deep branch: model swap + web search (2026-07-05)

**Model swap:** `tech-solver-parallel.deep` moved from `anthropic/claude-opus-4.8-fast` to
`anthropic/claude-opus-4.8` (user's call — primarily uses Dual Answers mode, so the fast pane
already covers latency-sensitive needs and the deep pane can afford non-fast Opus's extra quality).

**Web search:** added OpenRouter's built-in web plugin to the deep branch only, always on (not
freshness-gated). Implementation: `ActionRunManager.ts` sends `plugins: [{ id: 'web' }]` whenever
`branchConfig.web_search_enabled` is true; `OpenRouterClient.ts`/`types.ts` thread `plugins` through
to the request body; `ActionConfigStore.ts` validates `web_search_enabled` as an optional boolean.
No model-specific wiring needed — works the same regardless of which model runs the branch. Cost is
~$0.005/call (Exa, the default search engine, up to 10 results).

Verified two ways: (1) live, in-app — a `tech-solver-parallel` run answered a "what's the latest
Node.js version" style question with current, dated specifics; (2) definitively, via a direct
`curl` to OpenRouter bypassing the app entirely, using the exact same `plugins: [{"id": "web"}]`
parameter — response included a real `annotations` array with a `url_citation`
(`https://nodejs.org/en/blog/release/v24.11.0`, "Node.js — Node.js 24.11.0 (LTS)"). That field is
populated server-side by OpenRouter's search infrastructure, not generated by the model, so it's
structural proof the plugin is actually grounding on live search results, not just producing
plausible-sounding text.

Full suite: 154/154 passing after this change.

### Prompt & context-window audit for a 1:1 problem-solving/interview meeting (2026-07-05)

Audited all 3 actions' prompts and context settings against the actual target use case: a 1:1 where
the user presents a project they built (`~/done_diligence`, an AI due-diligence tool) and fields
follow-ups, deep dives, trade-offs, and "what if" questions from the other person. Traced the full
context-assembly path (`ContextBuilder.ts` → `PromptCache.ts` → `ActionRunManager.ts`) to see
exactly what each action's model receives. Findings and fixes:

1. **No mechanism enforced "answer the pending question, not the last utterance."** Transcript lines
   are labeled `[ME]`/`[INTERVIEWER]` (`TranscriptBridge.ts`), but nothing in the stable instructions
   or action prompts told the model to target the interviewer's last *unanswered* question rather
   than reacting to whatever line happens to be most recent — risky in this meeting shape, where the
   user monologues at length (per their own interview prep doc's "must-hit beats," single sections
   run 2–15 minutes) between the interviewer's questions. **Fixed**: added an explicit paragraph to
   `DEFAULT_MEETING_COPILOT_STABLE_INSTRUCTIONS` (shared by all actions) naming the `[ME]`/
   `[INTERVIEWER]` convention and instructing the model to always address the interviewer's most
   recent unanswered question/challenge, prioritize whatever's unaddressed if multiple things were
   raised, and fall back to helping extend the user's current point if nothing is pending. (An
   earlier live test had shown the model handling one scripted case correctly without this — but
   that was an observed behavior on one scenario, not an enforced rule.)

2. **`recent`-mode context windows were short for a monologue-heavy meeting.** `quick-answer` was 2
   min, `tech-solver-parallel.fast` was 3 min — fine for "hotkey pressed right as the question lands,"
   risky if the interviewer's question was several minutes back and the user is deep into explaining
   before triggering the hotkey. **Fixed**: bumped `quick-answer` to 4 min and `tech-solver-parallel.fast`
   to 5 min (matching `claim-check`, already 5 min). Still cheap/fast (`gemini-3.5-flash`, no caching).

3. **`quick-answer`/`claim-check` never receive project docs** — `project_docs_context` is only
   injected in `full_cached` mode (`ContextBuilder.ts`), so only `tech-solver-parallel.deep` sees the
   `interview-prep` doc pack; the two `recent`-mode actions and the fast branch have zero project
   awareness beyond whatever's been said in the transcript window. Not changed (loading the full
   ~20–40k char doc pack into every quick, uncached `gemini-3.5-flash` call would defeat the point of
   the fast path on cost/latency) — instead, relied on **pinned context**, which is injected in both
   `recent` and `full_cached` modes and was already the intended mechanism for exactly this
   (`PinnedContextStore.ts`'s own default template is "Current problem / Goal / Important
   constraints / Known decisions / Open questions"). Found it was still holding a leftover string
   from an earlier freshness test ("What is the current, latest stable version of Node.js..."), not
   real project content — **fixed** by writing a ~3000-char summary of the actual project (drawn from
   `~/done_diligence/docs/interview-prep/cheat-sheet.md` and `decision-and-collaboration.md`:
   architecture, the v1→v2 rewrite story, impact numbers, the extraction-vs-RAG trade-off, known
   limitations/open questions) into `~/Library/Application Support/Natively/meeting-copilot/pinned-context.json`.
   This now gives every action, in every mode, baseline grounding in the real project. **If you rerun
   this on a fresh checkout or for a different meeting/project, re-populate this file** — it's
   userData, not shipped with the repo, and the store falls back to an empty template otherwise.

4. **Prompt wording tightened** to reference the interviewer/pending-question framing explicitly and
   (for the deep branch) explicitly invite trade-off/what-if/deep-dive framing grounded in real
   project specifics rather than generic advice:
   - `quick-answer`: now "...answer the INTERVIEWER's pending question (or help me extend my current
     point if there is none)..."
   - `claim-check`: now explicitly "mine or the INTERVIEWER's" claim (was ambiguous about whose claim).
   - `tech-solver-parallel.fast`: mirrors quick-answer's framing.
   - `tech-solver-parallel.deep`: now explicitly frames the branch as likely answering "a deep-dive,
     trade-off, or 'what if you had done X instead' question about a system I built," instructs it to
     use project docs/code tools for specifics, and to reason about "how I would defend or reconsider
     the choice under scrutiny."

Updated `EXPECTED_DEFAULTS` in `MeetingCopilotActionConfig.test.mjs` to match the new prompt text and
`context_minutes` values. Full suite: 154/154 passing (no new tests added — this was a config/prompt
content change, not new behavior to cover).

### Follow-up refinement to the audit above (2026-07-05, same day)

Two corrections after user review:

1. **"Answer the pending question" was too narrow.** Reframed as "help me in the discussion
   generally" — answer a pending question if there is one, otherwise surface whatever would
   actually help (a sharper phrasing, a forgotten detail, a risk worth flagging, a natural next
   point), rather than forcing an answer to a question that wasn't asked. Reworded the stable
   instructions and the `quick-answer`/`tech-solver-parallel.fast` prompts accordingly.

2. **Found a real bug in the deep-branch prompt: it referenced an answer it never receives.**
   `fast` and `deep` run via `Promise.all([...])` in `ActionRunManager.ts` (`executeBranch` calls
   at lines ~510-535) — genuinely concurrent, each building its own context independently from the
   same transcript/pinned-context/project-docs snapshot, with **no data passed between them**. The
   deep prompt said "Improve, correct, or qualify the fast answer," which the model has no way to
   do since it never sees the fast answer's text — risked the model hedging around or hallucinating
   what the fast pane probably said. Rewrote the deep prompt to explicitly state it does not see
   the fast answer and should not refer to it, and to stand on its own as a deeper, independent
   take (still framed around trade-offs/deep-dives/"what if" scenarios, still told to ground in
   project docs/code/web search rather than generic advice). If a real "deep branch revises the
   fast branch's actual text" behavior is ever wanted, that requires making `deep` wait on `fast`'s
   result and threading it into `deep`'s context — a real latency trade-off against the current
   fully-parallel design, not done here.

Full suite: 154/154 passing after this refinement.

### Installable app build, OpenRouter key persistence, project-docs truncation, and quick-answer project grounding (2026-07-05)

Several follow-ups from a real macOS install + end-to-end test pass:

**Installable app.** `npm run app:build` (unsigned, ad-hoc signed via `scripts/ad-hoc-sign.js`,
`identity: null` in `package.json`'s `build.mac` — no Apple Developer account needed) is the right
script for a personal install. It uncovered two pre-existing TypeScript bugs unrelated to this
session's other work (confirmed via `git stash` against the last committed state before any of
this session's changes): `OpenRouterClient.ts`'s `sendWithRetry()` didn't set `retryUsed: false` on
the non-retry success path (missing property on the returned type), and `PromptCache.ts`'s
`CACHEABLE_SECTION_KEYS` `Set` had an `as const`-inferred type narrower than `PromptSectionKey`,
failing `.has()`'s type check for keys like `'recent_transcript'`. Both fixed (the `Set` now
explicitly typed `Set<PromptSectionKey>`). The **DMG target is broken on this machine** —
`dmgbuild` (electron-builder's Python DMG tool) hit `OSError: Read-only file system:
'/Volumes/Natively 2.8.0/.VolumeIcon.icns'` deterministically, twice in a row, trying to write the
volume icon before the mounted image was writable. Not root-caused further; the **zip target builds
successfully every time** and is functionally equivalent for a personal install (unzip → drag to
`/Applications`), so that's the path used. Real Developer ID signing (the user has a paid account)
would likely also fix this since `electron-builder.signed.cjs` already documents that
electron-builder's own DMG creation corrupts the signature and works around it with a separate
`create-dmg` rebuild step — not set up in this session (no Developer ID cert installed yet; requires
generating one in Xcode plus `xcrun notarytool store-credentials`, both needing interactive user
input). Ad-hoc-signed builds also mean **Screen/System Audio Recording permission must be re-granted
after every rebuild** — macOS ties TCC grants to the exact code signature, which changes on every
ad-hoc-signed build. Real signing would fix this too (stable signature across builds).

**OpenRouter key now persists properly.** It was env-var-only (`process.env.OPENROUTER_API_KEY`),
which never reaches a packaged app launched normally (Finder/Dock/Spotlight don't source
`~/.zshrc` — only a terminal-launched process inherits that). Added it to the same encrypted
`CredentialsManager` store already used for the Groq STT key: `getOpenRouterApiKey()` /
`setOpenRouterApiKey()` in `CredentialsManager.ts`, a `set-openrouter-api-key` IPC handler in
`ipcHandlers.ts`, exposed via `preload.ts`, and a new "OpenRouter (Meeting Copilot)" field in
Settings → AI Providers (`AIProvidersSettings.tsx`, styled like the LiteLLM block — no
preferred-model/test-connection support, just a masked key input, since those don't apply here).
`resolveMeetingCopilotOpenRouterApiKey()` in `ipcHandlers.ts` now checks the store first, falling
back to the env var for the dev workflow. No config-store validation tests needed (this is UI/IPC
wiring, not `MeetingCopilotConfig` shape) — verified via `tsc` (both renderer and electron) and the
full existing suite (154 + 42 credentials tests, all passing).

**Project-docs truncation was hiding most of the interview-prep pack.** The `interview-prep` pack
is 291,665 chars total across all files (`README.md`, `interview-playbook.md`, `war-stories.md`,
`narratives/`, `reference/`, etc.), but the userData config's `max_docs_chars_per_pack` /
`max_total_docs_chars` / the pack's `maxDocsChars` were all `20000` — under 7% of the material was
reaching the model. Files load in alphabetical order (`ProjectContextStore.ts`'s `walkDir()` sorts
by `relativePath`), so everything past `evaluation-design.md` was silently dropped entirely, not
just individual files being cut short. Raised all three to `320000` in
`~/Library/Application Support/Natively/meeting-copilot/meeting-copilot.config.json` (userData, not
repo) and verified directly against `ProjectContextStore.loadDefaultBundle()`: `truncated: false`,
zero warnings, full 290,471 chars loading. This only affects `tech-solver-parallel.deep` (the only
`full_cached` branch) — see next item for why the other actions didn't have this problem in the
first place, and now do use (some of) the docs too.

**Quick-answer (and any other `recent`-mode branch) can now opt into the project docs pack**, via a
new `project_docs_enabled` flag on `ActionBranchConfig`/`ActionRunManager`'s `RunnerBranchConfig`
(`types.ts`, `ActionRunManager.ts`), validated in `ActionConfigStore.ts` exactly like
`web_search_enabled`. Previously `project_docs_context` was structurally impossible to get into
`recent` mode — `ContextBuilder.ts`'s `'recent'` branch never read `input.projectDocsContext` at
all (proved this directly: fed a distinctive marker string into `buildMeetingCopilotContext({mode:
'recent', projectDocsContext: 'MARKER', ...})` and confirmed it never appears in any output
section). Fixed in `ContextBuilder.ts`: the `'recent'` branch now includes a `project_docs_context`
section when non-empty, positioned **before** `pinned_context`/`recent_transcript` — this ordering
matters because Gemini 2.5+ models (quick-answer runs `google/gemini-3.5-flash`) get **automatic
implicit prompt caching** via OpenRouter (confirmed via OpenRouter's and Google's own docs — no
`cache_control` breakpoints needed unlike Anthropic, ~90% discount on cache hits, ~1,024-token
minimum, but the *stable* part of the prompt must come first with per-call-varying content pushed
to the end, or the cache won't hit). `ActionRunManager.ts`'s `actionNeedsProjectContext()` (renamed
from `actionUsesFullCachedContext()`) now loads the project-context bundle whenever any branch is
`full_cached` OR has `project_docs_enabled: true`; `executeBranch()` gates the actual
`projectDocsContext` value per-branch (`context_mode === 'full_cached' || project_docs_enabled`) so
a sibling branch without the flag (e.g. `tech-solver-parallel.fast`) stays lean even when the bundle
was loaded for the action overall. Enabled by default on `quick-answer` only. Residual caveat:
OpenRouter's implicit-cache TTL is short (~3-5 min average) — the *first* quick-answer press in a
burst, or any press after a gap longer than that, still pays full cost/latency for the ~75K-token
docs; only closely-spaced repeat presses benefit. Added regression coverage: `ContextBuilder`-level
ordering/inclusion tests in `MeetingCopilotProjectContext.test.mjs` (replacing a now-outdated test
that asserted `recent` mode *always* omits project docs), config-shape tests in
`MeetingCopilotActionConfig.test.mjs`, and two `ActionRunManager`-level end-to-end tests in
`MeetingCopilotActionRunManager.test.mjs` (quick-answer receives docs ordered before the transcript;
claim-check, without the flag, never does). Full suite: 159 meeting-copilot tests passing.

### Truncated answers ("Complete" but cut off mid-sentence) and debug UI removal (2026-07-06)

Live testing surfaced a real, reproducible bug: Quick Answer responses were sometimes cut off
mid-sentence (e.g. "...in v2, we traded that" with nothing after) while still showing a green
"Complete" badge. Root cause: `OpenRouterClient.ts`'s streaming loop only ever extracted
`delta.content` tokens and `usage` from each SSE chunk — it never read `choice.finish_reason` at
all, so the app had **no way to distinguish** a natural stop (`finish_reason: 'stop'`) from a
hard cutoff at the token budget (`finish_reason: 'length'`). Every non-errored, non-cancelled
stream got labeled "Complete" regardless. This became much more likely to trigger for
`quick-answer` specifically once `project_docs_enabled` (previous entry) gave the cheap/fast model
enough material to want to write well past its `max_tokens: 300` cap.

Two things were fixed, not just papered over:

1. **`finish_reason` is now captured** end-to-end — tracked across streaming chunks in
   `OpenRouterClient.ts` (mirrors how `usage` is aggregated: keep the latest non-empty value seen,
   thread it into the same synthetic `raw` object passed to `buildResult()` at both the `[DONE]`
   and stream-exhausted exit points) and extracted in `buildResult()` for the non-streaming path
   too (`createChatCompletion()` already gets it for free from the real API response). Added to
   `OpenRouterChatCompletionResult.finish_reason`. This is available for future diagnosis/telemetry
   even though nothing surfaces it as a user-facing warning (see next point for why).

2. **Removed the fixed `max_tokens` cap from all 4 branches** (`quick-answer`, `claim-check`,
   `tech-solver-parallel.fast`, `tech-solver-parallel.deep`) in `defaultActionConfig.ts`, rather
   than just raising the numbers or showing a "truncated" warning band-aid — per explicit
   direction: fix the cause, don't decorate the symptom. `max_tokens` is now optional end-to-end:
   `ActionBranchConfig`/`RunnerBranchConfig`/`OpenRouterChatCompletionRequest`/the internal
   `ProviderPayload` type in `OpenRouterClient.ts` (`types.ts`, `ActionRunManager.ts`,
   `OpenRouterClient.ts`), `ActionConfigStore.ts`'s `validateBranch()` only validates it when
   present, and `buildBody()` passes `request.max_tokens` straight through — when `undefined`,
   `JSON.stringify` drops the key entirely, so OpenRouter/the provider falls back to the model's
   own real output ceiling instead of an artificial one we invented. The actual length control is
   now purely the prompt (quick-answer's prompt already says "strictly 1-3 sentences... even
   though the project docs contain much more detail than that"), not a token budget that could
   truncate a legitimate longer answer mid-word. Added a regression test in
   `MeetingCopilotActionConfig.test.mjs` asserting none of the 4 real default branches set
   `max_tokens`, so this doesn't silently regress. Full suite: 160 meeting-copilot tests passing.

**Also removed the always-visible debug metrics UI** per explicit request — the per-run metric
chip row (Model/Context/Project docs/Packs/Docs chars/Files/Freshness/TTFT/Latency, shown inline
under each run's header) and the separate `MetricsDebugPanel` component (Model/Context/Cache/
Project Docs/Pack Names/Docs Chars/Docs Files/Freshness Queries/Freshness Results/Freshness
Status/Cached/Cache Write/TTFT/Latency grid, shown below all run cards) were cluttering the
answer view. Removed both render sites, their now-dead helper functions (`formatMetricChip`,
`runMetadata`) from `MeetingCopilotPanel.tsx`, and deleted `MetricsDebugPanel.tsx` outright (no
longer referenced anywhere). Errors and warnings (`run.error`, `run.warnings`) are kept — those
are operational signals, not debug internals. The underlying metrics collection
(`LlmCallMetrics`, `emitEvent`, `MetricsStore`) is untouched — this only removes the in-app display,
not the data.

### "Pending question" logic didn't recognize when it had already been answered (2026-07-06)

Live testing found the flip side of the earlier "answer the pending question, not the last line"
fix: once the INTERVIEWER asked something and the user substantively answered it and moved on to
elaborating on their own point, a later Quick Answer press would still re-answer the *original,
already-resolved* question instead of helping with whatever the user was currently saying. Root
cause was in the stable instructions' wording itself — it told the model that [ME] lines after a
question are always "thinking out loud, restating it, or partway through an answer" (i.e. always
still-pending), with no criterion for when a question should be considered done. So the model
over-indexed on "there was a question earlier and nothing new has been asked since" and kept
treating it as perpetually open.

Fixed by adding an explicit PENDING vs RESOLVED distinction to
`DEFAULT_MEETING_COPILOT_STABLE_INSTRUCTIONS` in `defaultActionConfig.ts`: a question stays
pending only until the user's own lines give it a real, substantive answer; the moment that
happens, it's resolved, even if no new INTERVIEWER line has followed, and re-answering a resolved
question "because it's the last one asked" is explicitly called out as the mistake to avoid. This
is a wording-only change (no code path change) — same shared instructions block used by
`quick-answer`, `claim-check`, and both `tech-solver-parallel` branches. Full suite: 160
meeting-copilot tests passing (no test changes needed — no test asserts the exact stable
instructions text).

### Claim Check replaced by a standalone Deep Answer action; deep prompts tightened for readability (2026-07-06)

Two more live-testing findings, both user-directed:

1. **Deep answers had gotten too long to read during a live interview.** Removing the fixed
   `max_tokens` cap (previous entry) fixed truncation but exposed the flip side: `Opus` with tools
   and web search enabled will happily write a very long, essay-like answer once nothing bounds it.
   Since there's no token cap anymore, the *only* lever is the prompt. Added an explicit
   readability instruction to both deep prompts (`tech-solver-parallel.deep` and the new
   `deep-answer`, see next item): "lead with the single most important point, then at most 2-3
   short supporting points — do not write an essay, and stop once you have made the key points
   even if there is more you could say."

2. **`Claim Check` (`Command+Shift+2`) replaced by a standalone `Deep Answer` action.** User's
   call: rather than a fact-checking action, `Command+Shift+2` now gives a deep, thorough answer
   on its own — same shape as `tech-solver-parallel`'s `deep` branch (`anthropic/claude-opus-4.8`,
   `full_cached`, `tools_enabled`, `web_search_enabled: true`) but as an independent single-branch
   action, not paired with a fast pane. So there are now two ways to get a deep answer: `Command+
   Shift+2` (deep alone, immediately) or `Command+Shift+3` (fast pane first, deep alongside it).
   `deep-answer`'s prompt is the same as `tech-solver-parallel.deep`'s minus the "you do not see
   the fast answer" framing (not applicable — there's no fast sibling to disclaim). Updated
   `FreshnessPolicy.ts`'s `actionAllowsFreshnessVerification()` to check `'deep-answer'` instead of
   `'claim-check'` (unchanged otherwise — quick-answer/tech-solver.fast still caveat-only,
   tech-solver.deep still verify-allowed). Removed `claim-check` from `defaultActionConfig.ts`,
   `hotkeys.ts`'s `MEETING_COPILOT_HOTKEY_BINDINGS`, and `KeybindManager.ts`'s `DEFAULT_KEYBINDS`;
   added `deep-answer` to each at the same `Command+Shift+2` slot. Updated every test that
   referenced `claim-check` across `MeetingCopilotActionConfig`, `MeetingCopilotActionRunManager`
   (including adding `tools_enabled = false` overrides to freshness tests that relied on
   `claim-check` having no tools, since `deep-answer` defaults to `tools_enabled: true` and the
   test manager doesn't wire a `toolLoop` stub), `MeetingCopilotFreshnessPolicy`,
   `MeetingCopilotHotkeys`, and the renderer's `useMeetingCopilotReducer` test. One test
   (`MeetingCopilotActionRunManager`'s "recent-mode branch without `project_docs_enabled`") had to
   be rewritten rather than just renamed — it specifically needed a *recent-mode* action lacking
   the flag, and `deep-answer` is `full_cached` (always gets docs), so it now targets
   `tech-solver-parallel.fast` instead. Full suite: 160 meeting-copilot tests passing.

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

**Freshness (#20/#21) — how it was done:** freshness classification (`FreshnessPolicy.classifyFreshnessNeed`)
reads from the *live transcript* + the action's static config prompt — **not** from pinned context — so to
steer it, inject a freshness-sensitive line via the `NATIVELY_E2E=1` transcript-injection seam (same one used
for the transcript-bridge verification), e.g. a pricing/news question mentioning a plausible model id under a
known public provider prefix (`anthropic/`, `openai/`, `google/`, etc. — see `PUBLIC_MODEL_PROVIDERS` in
`ActionRunManager.ts`). Using a **nonexistent** model id (e.g. `anthropic/claude-nonexistent-999`) reliably
triggers the catalog-miss failure path without needing to break real network/API access. Only actions where
`actionAllowsFreshnessVerification` returns true attempt verification (`claim-check`, `deep-solution`,
`tech-solver` branch `single`, `tech-solver-parallel` branch `deep`) — `quick-answer`/`followups`/`fast`
branch always just caveat.

### #5 (hotkey registration failure visibility) — found a real gap, not fixed yet

Tried two ways to force a genuine "another app/OS owns this shortcut" failure:
1. A throwaway Electron process (`app.whenReady().then(() => globalShortcut.register('Command+Shift+2', ...))`,
   launched with its own `--user-data-dir` so it doesn't collide with the main app's single-instance lock)
   pre-registered Tech Solver's accelerator before starting the main app.
2. Rebinding Tech Solver to `Command+Space` (Spotlight) via a `keybinds.json` override in userData.

**Both times `globalShortcut.isRegistered()` still returned `true`** — on this macOS setup, Electron's
Carbon-based global-hotkey registration doesn't reliably fail cross-process (unlike Windows' `RegisterHotKey`,
which enforces true OS-wide uniqueness). So live-reproducing the failure branch in `KeybindManager.ts:283-293`
was inconclusive. **Reverted both experiments immediately** (killed the hijacker process, deleted the
`keybinds.json` override, restarted Electron) — Spotlight and the default hotkeys are back to normal.

Regardless of live reproduction, reading `KeybindManager.ts` and `NativelyInterface.tsx` together shows a
real, source-confirmed gap: when the failure branch *does* fire, it emits `keybinds:registration-failed` for
**any** keybind id, but the renderer's only consumer (`NativelyInterface.tsx:5335-5342`) hardcodes
`if (id !== 'chat:focusInput') return;` — so all 6 `meeting-copilot:*` hotkeys get silently dropped, no
banner/toast ever shows. **Not fixed in this session** — user chose to document only. If picked up later,
the fix is a small renderer change (extend or generalize that effect to cover `meeting-copilot:*` ids too),
should go through brainstorming → plan → implement like the transcript bridge did, not a quick patch.

### Unrelated blocker found & fixed: launcher crash on every launch (Rust font-rasterizer)

While setting up for the physical mic pass, hit an unrelated pre-existing bug that made the **launcher
window crash on every single launch** — not a meeting-copilot issue, but it blocked all further testing
since the launcher is where "Start Natively" lives.

**Symptom:** launcher window showed a stale black frame with an unrelated Hindsight (long-term memory)
error banner frozen on screen; every other window (Settings, Overlay, Model Selector, Cropper) loaded and
responded fine. macOS crash reports (`~/Library/Logs/DiagnosticReports/Electron Helper (Renderer)-*.ips`)
showed a consistent `EXC_BREAKPOINT`/`SIGTRAP` crash inside Chromium's Rust font-shaping backend
(`fontations_ffi`) every time — deterministic, survived a full app relaunch **and** a full machine reboot,
so it was not GPU-driver/process-state flakiness.

**Root cause, found by bisection** (temporarily disabling launcher-only components one at a time, per-change
full quit+relaunch): the app's onboarding nudge system (`OrchestratorProvider`/`OrchestratedToasterHost` in
`src/App.tsx`, driven by `OnboardingOrchestrator` in `src/lib/onboarding/orchestrator.ts`) renders one of
several "toaster" banners (permissions, browser extension, trial promo, support/donation, review prompt).
Rendering one of these toasters — with some glyph/font combination in its content — reliably crashes
Chromium's Rust font rasterizer on this machine. The orchestrator's background `requestAnimationFrame` drain
loop (`orch.start(...)` in `App.tsx:203`) runs regardless of whether the host is mounted and is **not** the
crash trigger by itself (verified: it still runs after the fix below, harmlessly, since nothing subscribes to
render UI) — the crash is specifically in rendering the toaster component's DOM/text.

**Fix applied** (`src/App.tsx`, personal build — this instance doesn't need onboarding nudges): removed the
`<OrchestratorProvider><OrchestratedToasterHost /></OrchestratorProvider>` render from the launcher JSX
entirely. Did not touch `orchestrator.ts`/`stageCatalog.ts`/the individual toaster components — they're
simply no longer mounted. Live-verified stable: launcher loads instantly and stays CDP-responsive
(`1+1` eval) after repeated full quit+relaunch cycles, no new crash reports generated.

**Not yet done**: pin down which *specific* toaster/glyph triggers the Fontations crash (only bisected to
"the host as a whole", not to one exact component) — not necessary once the host is removed, but worth
knowing if a future agent wants to restore onboarding nudges instead of leaving them off. If restoring,
start by testing `PermissionsToaster` and `TrialPromoToaster` individually (most complex text content of
the five), and consider filing/checking upstream Electron/Chromium issues for `fontations_ffi` SIGTRAP
crashes as an alternative to further bisection.

Remaining open items:
- **Phase 2 (STT)** for #2/#4 — needs the user's mic; the transcript-wiring gap that blocked
  them is fixed (see § Transcript bridge above), so this is now a physical mic pass, not
  further implementation.
- **Cleanup**: the test workspace config (`workspaces` key), the `project_context` test-docs/
  missing-docs packs (#17–19), and the tech-solver `prompt` override used for #11–13 should be
  removed from the userData config once done (or left for a future agent to reuse for
  regression checks — note it here either way to avoid confusion). Test docs folder:
  `<scratchpad>/test-project-docs/` (contains `architecture.md` with marker `ZEBRA_DOC_MARKER_7742`
  and an `ignored.env` used to confirm exclusion). The injected transcript (marker strings +
  freshness test lines) lives only in the live `SessionTracker` in-memory state — it clears on
  Electron restart, no cleanup needed there.

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
| `defaultActionConfig.ts` | Three actions with OpenRouter defaults, model slugs, prompts, limits |
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
- `electron/services/KeybindManager.ts` — registers 3 meeting-copilot keybinds
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

> **Reduced from 6 to 3 actions on 2026-07-05** — see § "Action set reduced from 6 to 3" below for
> the audit and rationale. Tech Solver, Deep Solution, and Follow-up Questions were removed as
> standalone actions; historical checklist entries elsewhere in this doc that mention them describe
> findings from when they still existed and remain valid (the underlying code paths, e.g.
> `tech-solver-parallel`'s `deep` branch, still exercise the same mechanics).
> **Claim Check replaced by Deep Answer on `Command+Shift+2` (2026-07-06)** — see § "Claim Check
> replaced by a standalone Deep Answer action" below.

| Shortcut | Action |
|----------|--------|
| `Command+Shift+1` | Quick Answer |
| `Command+Shift+2` | Deep Answer |
| `Command+Shift+3` | Tech Solver: Fast + Deep |

Registered via `KeybindManager` in `electron/services/KeybindManager.ts`.

## Prerequisites

- `OPENROUTER_API_KEY` env var set before launch (or the OpenRouter key set in Settings → AI Providers)
- `ripgrep` (`rg`) on PATH (for code tools in Deep Answer and Tech Solver: Fast+Deep's `deep` branch)
- macOS with microphone/system audio permissions granted

## What Each Action Does

| Action | Context | Model | Key Behavior |
|--------|---------|-------|-------------|
| Quick Answer | Recent transcript (~4 min) + pinned context + project docs | `google/gemini-3.5-flash` | Fast, no tools; project docs included (Gemini implicit caching) |
| Deep Answer | Full cached + pinned context + project docs + web search | `anthropic/claude-opus-4.8` | Standalone thorough answer with up to 2 tool rounds (`rg` search, file read) plus OpenRouter's built-in web search plugin (always on) |
| Tech Solver: Fast+Deep | fast: recent (~5 min) + pinned context; deep: full cached + pinned context + project docs + web search | Fast: `google/gemini-3.5-flash` / Deep: `anthropic/claude-opus-4.8` | Fast answer renders first, no tools; deep branch refines it the same way Deep Answer does, but alongside a fast first pass |

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

> **Note (2026-07-05):** this is the original fixed roadmap checklist (#1-21) and is left as-written
> for historical traceability with `03-roadmap.md` and the checklist table above. Since the action
> set was reduced from 6 to 3 (see § "Action set reduced from 6 to 3"), read #3 as "all 3 hotkeys"
> and #7 ("Tech Solver and Deep Solution use full transcript + pinned context") as covered by
> Tech Solver: Fast+Deep's `deep` branch, which still exercises full_cached + pinned context + tools
> exactly as Tech Solver/Deep Solution did before removal.

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
Last commit: fix(meeting-copilot): wire live transcript, fix empty-block 400s and onboarding crash (e9f100c)
Branch: main (in sync with origin/main)
Remote: git@github.com:AndreasSteinerPF/natively.git
Upstream: git@github.com:Natively-AI-assistant/natively-cluely-ai-assistant.git
```

All meeting-copilot files are tracked in a single commit (`70ae580`).
Upstream merged clean at `4fc630a` — no conflicts with meeting-copilot files.
Transcript bridge + bug fixes pushed in `e9f100c` (see § Testing Session Status).

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
