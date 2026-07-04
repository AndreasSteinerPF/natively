# Slice 15 - Minimal Freshness Tools

## Goal

Add read-only bounded freshness tools after Slice 14 policy exists. Prefer OpenRouter model catalog lookup first. Add web search only if it can be configured and tested without leaking private transcript/code.

This slice requires a formal implementation plan before code.

## Exact Files To Create Or Modify

Create:

- `electron/meeting-copilot/FreshnessTools.ts`
- `electron/services/__tests__/MeetingCopilotFreshnessTools.test.mjs`

Modify:

- `electron/meeting-copilot/types.ts`
- `electron/meeting-copilot/OpenRouterClient.ts` if OpenRouter catalog lookup is implemented there.
- `electron/meeting-copilot/ContextBuilder.ts`
- `electron/meeting-copilot/PromptCache.ts` if a new dynamic section key is needed.
- `electron/meeting-copilot/ToolLoop.ts`
- `electron/meeting-copilot/ActionRunManager.ts`
- `electron/meeting-copilot/MetricsStore.ts`
- `src/components/meeting-copilot/MeetingCopilotPanel.tsx`
- `src/components/meeting-copilot/MetricsDebugPanel.tsx`
- `docs/meeting-copilot/99-implementation-log.md`

Do not modify:

- Rust/native modules.
- Browser automation.
- Code tools except for shared evidence/metrics types.
- Any module to support shell execution, file editing, form submission, login, purchases, or external state mutation.

## Public Types And Interfaces

```ts
type ModelInfo = {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: Record<string, unknown>;
  supported_parameters?: string[];
  source: "openrouter";
  checked_at: string;
};

type WebSearchResult = {
  title: string;
  url: string;
  domain: string;
  snippet?: string;
  checked_at: string;
};

type FreshnessEvidence = {
  used: boolean;
  sources: string[];
  queries: string[];
  resultCount: number;
  verifiedAt?: string;
  dynamicContextText: string;
  warnings: string[];
};
```

Suggested public shape:

```ts
class FreshnessTools {
  getOpenRouterModel(modelId: string, signal?: AbortSignal): Promise<ModelInfo>;
  listOpenRouterModels(filter?: { query?: string }, signal?: AbortSignal): Promise<ModelInfo[]>;
  webSearch?(query: string, signal?: AbortSignal): Promise<WebSearchResult[]>;
}
```

Minimal acceptable implementation:

- Implement OpenRouter model catalog lookup only.
- Leave web search unimplemented but represented as unavailable in policy/metrics.

## Behavior

- Prefer OpenRouter model catalog data for OpenRouter model availability, slugs, pricing, context length, and supported parameters.
- Use official-provider or web search tools only if explicitly configured and bounded.
- Construct generic queries. Never use raw private meeting transcript or private code text as a search query by default.
- Place freshness results in `<dynamic_evidence_context>`, after transcript/project docs and before current action.
- Freshness results are not cacheable.
- If freshness lookup fails, continue the action and mark current claims unverified/currentness-uncertain.
- Log only query metadata, source names/domains, result counts, timestamps, and bounded errors.

## Tests To Add

- OpenRouter model catalog lookup builds the expected request and returns bounded metadata.
- Model catalog failure returns a freshness warning and does not fail the action.
- Freshness evidence is placed in dynamic evidence, not cacheable prompt sections.
- Web search, if implemented, rejects private transcript/code-derived queries.
- Genericized web queries contain no internal repo paths, code snippets, or transcript phrases.
- Claim Check can use freshness tools.
- Deep Solution can use freshness tools.
- Fast branch does not block on web search.
- Metrics capture sources, query count, result count, verified timestamp, and errors without raw web pages.

## Acceptance Criteria

- Current external facts can be verified with configured freshness tools when available.
- OpenRouter-specific model facts prefer OpenRouter catalog data.
- Freshness checks are not run for every action by default.
- Freshness failures do not break actions.
- Current external claims are marked unverified when verification fails or is unavailable.
- Private transcript/code is not leaked into web queries by default.
- Freshness results are dynamic and non-cacheable.
- Raw web pages are not logged by default.

## Rollback Plan

- Remove `FreshnessTools.ts` and its tests.
- Remove freshness tool execution from `ActionRunManager`/`ToolLoop`.
- Keep Slice 14 policy caveats in place if desired; they are useful without tools.
- Remove freshness source metrics from display if they are only populated by tools.
