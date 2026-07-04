# Meeting Copilot Repo Map

This map reflects the repository state inspected during the planning pass on 2026-07-03.

## Relevant Electron Main Files

- `electron/main.ts`
  - Owns the large `AppState` object.
  - Creates the main, overlay, and settings windows.
  - Wires STT provider transcript events into `IntelligenceManager`, RAG live transcript ingestion, and renderer display events.
  - Initializes `KeybindManager`, `SettingsManager`, `DatabaseManager`, `ProcessingHelper`, `LLMHelper`, and other services.
  - Sends push events to renderer surfaces with helper methods such as `sendToWindow`, `sendToMeetingSurfaces`, and `sendToSettingsSurfaces`.
  - Current global shortcut callback routes general/window actions directly and chat actions through renderer events.

- `electron/ipcHandlers.ts`
  - Central IPC registration point through `initializeIpcHandlers(appState)`.
  - Uses local wrappers such as `safeHandle` and `safeOn`.
  - Contains existing handlers for chat streaming, action buttons, settings, RAG, skills, credentials, dynamic actions, and other app features.
  - Existing chat stream handler uses per-sender `AbortController` tracking and sends token/done/error events back to the invoking renderer.

- `electron/preload.ts`
  - Exposes `window.electronAPI` to the renderer.
  - Must be kept in sync with `src/types/electron.d.ts` when adding meeting-copilot IPC.
  - Existing API surface is broad and event-subscription based.

- `electron/ProcessingHelper.ts`
  - Existing orchestration helper for screenshots, prompts, and assistant responses.
  - Should not become the main meeting-copilot orchestrator unless a narrow reuse point is obvious.

- `electron/LLMHelper.ts`
  - Existing large multiprovider LLM helper.
  - Contains existing Claude/Gemini/OpenAI/Groq/DeepSeek/LiteLLM/custom-provider logic, streaming paths, prompt tuning, and cache-related code.
  - Useful as reference for sanitization, streaming, and provider metrics, but meeting-copilot v1 should use a new thin OpenRouter client rather than extending this class.

- `electron/IntelligenceManager.ts`, `electron/IntelligenceEngine.ts`
  - Existing live intelligence pipeline for suggestions, refined answers, recaps, clarify, and follow-up questions.
  - Emits token batches to the UI.
  - Should be treated as a separate existing feature unless a small event-feed hook is needed.

- `electron/SessionTracker.ts`
  - Holds current session transcript/context state.
  - Important conflict: existing `fullTranscript` can include assistant messages and compacted transcript summaries. Meeting-copilot requires a meeting-only, append-only transcript buffer.

- `electron/MeetingPersistence.ts`
  - Persists meeting snapshots through `DatabaseManager`.
  - Current persistence is not an immutable chunk store.

- `electron/DatabaseManager.ts`
  - SQLite manager for meetings, transcripts, AI interactions, modes, RAG, and knowledge tables.
  - Useful for future durable metrics or action records, but v1 can start with a focused local JSON/SQLite store if that avoids broad migration risk.

- `electron/services/KeybindManager.ts`
  - Owns default keybinds, user overrides, global shortcut registration, and registration-failed events.
  - Stores keybinds at `app.getPath("userData")/keybinds.json`.
  - Existing chat shortcuts use `CommandOrControl+1` style defaults, not the required `Command+Shift+1` through `Command+Shift+6`.

- `electron/services/dynamic-actions/*`
  - Existing auto-detected dynamic action system.
  - Good UI/reference pattern for action cards and dismissal/acceptance, but not a direct fit for hotkey-driven configured actions.

- `electron/services/SkillsManager.ts`
  - Loads local `SKILL.md` style skills.
  - Not the right v1 mechanism for meeting-copilot action configuration.

- `electron/utils/redactForLog.ts`
  - Existing central redaction utility. Reuse or extend for meeting-copilot logs and metrics.

- `electron/services/telemetry/TelemetryService.ts`
  - Existing sanitized local telemetry JSONL service with optional remote sinks.
  - Candidate for compact metrics events, provided full transcript/snippets/tool logs are not written.

## Relevant React Renderer Files

- `src/components/NativelyInterface.tsx`
  - Main overlay experience.
  - Displays rolling transcript, chat messages, quick action buttons, dynamic actions, status, and streamed assistant output.
  - Maintains a single current streaming message path with refs such as `streamingMsgIdRef` and `streamingTextRef`.
  - Parallel Fast + Deep rendering likely needs a separate meeting-copilot panel/state model rather than reusing the single-message streaming path.

- `src/components/dynamic-actions/DynamicActionBar.tsx`
  - Displays existing dynamic action suggestions.
  - Useful reference for compact action UI, but v1 hotkeys are required and buttons are optional.

- `src/components/dynamic-actions/DynamicActionCard.tsx`
  - Existing individual action-card UI pattern.

- `src/hooks/useShortcuts.ts`
  - Maps backend keybind action IDs to renderer shortcut arrays.
  - Existing local keydown shortcuts should remain consistent with main-process hotkey actions if meeting-copilot actions are surfaced in renderer.

- `src/types/electron.d.ts`
  - Renderer-facing type declarations for `window.electronAPI`.
  - Must be updated together with `electron/preload.ts` during implementation.

- `src/styles/*` and component CSS
  - Existing overlay styling should be reused for response panels, copy/stop controls, metrics, and tool status.

- `renderer/`
  - Appears to be a legacy or separate renderer package.
  - The current app UI work should target `src/` unless a later inspection proves otherwise.

## Existing IPC Patterns

- Main handler registration is centralized in `electron/ipcHandlers.ts`.
- Renderer calls use `ipcRenderer.invoke` for request/response operations and `ipcRenderer.on` for push events.
- Main push events generally call `webContents.send(...)` through helpers in `AppState`.
- Chat streaming currently uses:
  - renderer invoke: `gemini-chat-stream`
  - renderer stop: `gemini-chat-stream-stop`
  - main events: `gemini-stream-token`, `gemini-stream-done`, `gemini-stream-error`
  - per-sender stream state with `AbortController`
- Intelligence streaming currently batches tokens through `intelligence-token-batch` with a `kind` value.
- Existing dynamic actions use:
  - `dynamic-action:list`
  - `dynamic-action:accept`
  - `dynamic-action:dismiss`
  - push event `intelligence-dynamic-action`
- Global shortcuts are pushed to renderer as `global-shortcut` events with an action ID.

Meeting-copilot should add namespaced IPC channels rather than overloading Gemini-specific channels. A good future shape is:

- invoke channels:
  - `meeting-copilot:action-start`
  - `meeting-copilot:action-cancel`
  - `meeting-copilot:pin-update`
  - `meeting-copilot:pin-reset`
  - `meeting-copilot:code-search`
  - `meeting-copilot:code-read`
  - `meeting-copilot:code-pin`
  - `meeting-copilot:code-clear`
  - `meeting-copilot:metrics-list`
- push channel:
  - `meeting-copilot:event`

The push payload should be a bounded discriminated union carrying `runId`, `actionId`, `branch`, `pane`, token deltas, tool status, metrics, and error/completion events.

## Existing LLM/Provider Code

- `electron/LLMHelper.ts` is the main existing provider implementation.
- `electron/llm/ProviderRouter.ts` defines provider routing, route candidates, data-scope policies, and provider metadata.
- Existing providers include Gemini, OpenAI, Claude, Groq, DeepSeek, LiteLLM, custom cURL/OpenAI-compatible endpoints, Ollama, Codex CLI, and Natively API.
- Existing dependencies include SDKs such as `openai`, `@anthropic-ai/sdk`, `@google/genai`, and `groq-sdk`.
- Existing code has Anthropic prompt-cache-related logic for Claude direct calls. It appears to use `cache_control: { type: "ephemeral" }` style content blocks and thresholding.
- Existing code also has `electron/GeminiPromptCache.ts`.

Meeting-copilot v1 should not route through LangChain, MCP, RAG, Vercel AI SDK, or a broad provider abstraction. The planned OpenRouter client should be a small Electron-main module using `fetch` and OpenAI-compatible chat completion payloads.

Open questions for implementation:

- OpenRouter's current Anthropic prompt-caching payload must be verified at implementation time.
- Model slugs from the brief should remain configurable and should not be treated as guaranteed live model availability.
- Existing custom cURL/OpenAI-compatible provider support may look reusable, but the brief explicitly prefers a thin custom OpenRouter client.

## Existing Transcript/Audio State

- Audio/STT providers live under `electron/audio/*` and are created from `electron/main.ts`.
- Native audio/system modules are consumed through the existing native module wrapper.
- STT provider transcript events are currently handled in `electron/main.ts`.
- Final transcript text is passed into:
  - `IntelligenceManager.handleTranscript(...)`
  - RAG live transcript feed
  - renderer display event `native-audio-transcript`
- `electron/SessionTracker.ts` stores transcript-like context in `contextItems` and `fullTranscript`.
- `SessionTracker.addTranscript(...)` stores final transcript segments and can maintain interim state.
- `SessionTracker.addAssistantMessage(...)` appends assistant text into the same context/transcript structures.
- `SessionTracker.compactTranscriptIfNeeded(...)` summarizes older transcript content once the full transcript exceeds a threshold.
- `MeetingPersistence` and `DatabaseManager` persist transcript rows with speaker/content/timestamp data, but not the requested immutable chunk shape with stable chunk IDs and start/end timestamps.

Required conflict to resolve later:

- Meeting-copilot cannot use `SessionTracker.fullTranscript` directly as the canonical meeting transcript because it can include assistant messages and compacted summaries.
- V1 should introduce a dedicated meeting-copilot transcript buffer fed only by finalized meeting transcript events. It can be in-memory first, then persisted later with an immutable chunk schema.

## Existing Hotkey/Action/Skill Mechanisms

- `electron/services/KeybindManager.ts`
  - Best starting point for required macOS hotkeys.
  - Has default bindings, user override loading, validation, global registration, and failure events.
  - Current default actions do not include meeting-copilot action IDs.
  - Current `shouldRegister` registers most actions in overlay mode, but only selected general/window actions in launcher mode.

- `src/hooks/useShortcuts.ts`
  - Renderer-local shortcut mapping for existing keybind action IDs.
  - Can be extended if local focused shortcuts are wanted in addition to global shortcuts.

- Existing quick actions in `NativelyInterface.tsx`
  - Include UI buttons and chat intents such as clarify, questions, and what-to-say.
  - These are not the same as the required configurable meeting-copilot actions.

- Dynamic actions
  - Auto-detected from transcript/mode patterns.
  - Should stay separate from the deterministic hotkey action config.

- Skills manager
  - Loads local skill files and supports skill settings.
  - Should not be used as the action config store for v1.

## Existing Storage/Config Mechanisms

- `electron/SettingsManager.ts`
  - JSON file backed app settings at `app.getPath("userData")/settings.json`.
  - Good pattern for simple local config and atomic writes.

- `electron/services/KeybindManager.ts`
  - JSON file backed keybind overrides at `app.getPath("userData")/keybinds.json`.

- `electron/CredentialsManager.ts`
  - Stores encrypted credentials with Electron `safeStorage` when available and a machine-bound fallback.
  - Existing provider credentials do not appear to include a first-class OpenRouter key.
  - Slice 1 can rely on `OPENROUTER_API_KEY` as config metadata only; later slices can add secure credential storage/UI.

- `electron/DatabaseManager.ts`
  - SQLite database for meetings, transcripts, AI interactions, modes, RAG, embeddings, and knowledge.
  - Avoid expanding this until the in-memory action flow is proven, because schema changes are higher-risk.

- `electron/services/telemetry/TelemetryService.ts`
  - Candidate for sanitized action metrics, with careful event shapes that exclude raw transcript, snippets, and tool logs.

Proposed config storage for v1:

- Default config in Electron main TypeScript.
- Optional local override JSON under `app.getPath("userData")`, for example `meeting-copilot.actions.json`.
- Secure OpenRouter API key source via `OPENROUTER_API_KEY` first, then existing credential storage/UI in a later slice.

## Native/Rust Modules To Leave Alone

Do not modify these for meeting-copilot v1:

- `native-module/src/audio_config.rs`
- `native-module/src/keyboard_tap.rs`
- `native-module/src/lib.rs`
- `native-module/src/license.rs`
- `native-module/src/microphone.rs`
- `native-module/src/process_name.rs`
- `native-module/src/resampler.rs`
- `native-module/src/silence_suppression.rs`
- `native-module/src/speaker/core_audio.rs`
- `native-module/src/speaker/macos.rs`
- `native-module/src/speaker/mod.rs`
- `native-module/src/speaker/sck.rs`
- `native-module/src/speaker/windows.rs`
- `native-module/src/stealth_window.rs`
- `native-module/src/vad.rs`
- `native-module/index.js`
- `native-module/index.d.ts`
- native `Cargo.toml`, `package.json`, and build scripts

Meeting-copilot should consume existing audio/transcript signals from Electron main TypeScript.

## Brief Conflicts Found In Current Codebase

1. Existing session transcript state is not meeting-only. `SessionTracker.addAssistantMessage(...)` adds assistant messages to the same transcript/context structures.
2. Existing session transcript state is not append-only. `SessionTracker.compactTranscriptIfNeeded(...)` summarizes and removes older transcript entries.
3. Existing transcript persistence is not an immutable chunk log. `DatabaseManager.saveMeeting(...)` rewrites transcript child rows for a meeting snapshot.
4. Existing default chat shortcuts use `CommandOrControl+1` style bindings, not `Command+Shift+1` through `Command+Shift+6`.
5. Existing global shortcut registration is mode-sensitive. Meeting-copilot hotkey availability must be explicitly defined for active meeting/overlay mode.
6. The app still has Windows/Linux packaging targets in `package.json`. V1 should avoid adding cross-platform work, but packaging cleanup is a separate decision.
7. The repository includes native/feature paths with stealth terminology. The meeting-copilot work must not extend those paths or add concealment behavior.
8. Existing RAG/knowledge systems are substantial, but v1 code context must avoid semantic RAG and use bounded `rg`/file-read tools.
9. Existing multiprovider logic is broad, but the brief requires a thin custom OpenRouter client for this feature.
10. Existing app data path is tied to the current Electron app identity, not explicitly `natively-private`. Migrating that path can strand existing settings and should not be bundled into Slice 1.
