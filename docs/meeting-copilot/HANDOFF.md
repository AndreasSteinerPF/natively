# Meeting Copilot — macOS Testing Handoff

## Quick Start

```bash
# Clone & install
git clone git@github.com:AndreasSteinerPF/natively.git
cd natively
npm ci

# Set your OpenRouter API key
export OPENROUTER_API_KEY=sk-or-v1-...

# Start in dev mode
npm start          # alias for `npm run app:dev`
```

Dev mode runs Vite on port 5180 and Electron pointed at localhost:5180.

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

15 test files — all must pass.

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
