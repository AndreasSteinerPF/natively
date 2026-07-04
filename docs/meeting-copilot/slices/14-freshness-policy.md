# Slice 14 - Freshness Policy And Currentness Caveats

## Goal

Add a policy layer that recognizes freshness-sensitive external facts and instructs the assistant to verify or caveat them. This slice should not add general web search yet.

Freshness policy is required before freshness tools because it controls privacy, when verification is allowed, and what happens when verification is unavailable.

## Exact Files To Create Or Modify

Create:

- `electron/meeting-copilot/FreshnessPolicy.ts`
- `electron/services/__tests__/MeetingCopilotFreshnessPolicy.test.mjs`

Modify:

- `electron/meeting-copilot/types.ts`
- `electron/meeting-copilot/ContextBuilder.ts`
- `electron/meeting-copilot/ActionRunManager.ts`
- `electron/meeting-copilot/MetricsStore.ts`
- `src/components/meeting-copilot/MeetingCopilotPanel.tsx`
- `src/components/meeting-copilot/MetricsDebugPanel.tsx`
- `docs/meeting-copilot/99-implementation-log.md`

Do not modify:

- Rust/native modules.
- Code tools.
- OpenRouter network behavior, except if needed to carry policy metadata.
- Web search or page fetch code. That belongs to Slice 15.

## Public Types And Interfaces

```ts
type FreshnessDecision = {
  sensitivity: "none" | "possible" | "required";
  allowed: boolean;
  shouldVerify: boolean;
  shouldCaveat: boolean;
  reason: string;
  categories: Array<
    | "model_availability"
    | "model_pricing"
    | "context_window"
    | "api_behavior"
    | "benchmark"
    | "provider_status"
    | "regulation"
    | "recent_release"
    | "company_announcement"
    | "current_event"
  >;
};

type FreshnessMetrics = {
  freshness_check_used?: boolean;
  freshness_sources?: string[];
  freshness_query_count?: number;
  freshness_result_count?: number;
  freshness_verified_at?: string;
  freshness_error?: string;
};
```

Suggested public shape:

```ts
function classifyFreshnessNeed(input: {
  actionId: string;
  branch?: "single" | "fast" | "deep";
  prompt: string;
  recentTranscriptText: string;
}): FreshnessDecision;
```

## Behavior

- Treat these topics as time-sensitive:
  - latest model releases
  - model availability
  - pricing
  - context windows
  - supported parameters
  - benchmark rankings
  - provider API behavior
  - provider outages/status
  - recent AI news
  - regulations/laws
  - company announcements
  - current events
- Do not trigger freshness for ordinary internal repo/project questions.
- Quick Answer, Follow-ups, and fast branch should not block on freshness tools.
- Claim Check and Deep Solution may verify current external facts when tools are configured.
- Tech Solver may verify only when the active topic is external/current.
- If freshness tools are unavailable, add prompt guidance to mark current claims as unverified/currentness-uncertain.
- Freshness decisions and metrics must not include raw transcript/code text.

## Prompt Instruction Update

Add concise freshness guidance to stable instructions:

```text
When model/provider/pricing/API/ranking/legal/news/current-event facts may have changed, verify with a current source before making confident claims.
If verification is unavailable, say the claim is unverified or currentness-uncertain.
Do not use private meeting transcript or private code as a web search query.
```

For actions where policy detects current external facts but no tool is available, the current action prompt should include:

```text
This action may depend on current external facts. No freshness tool result is available, so mark those claims as unverified/currentness-uncertain.
```

## Tests To Add

- Detects model availability, pricing, context-window, API behavior, benchmark, provider status, regulation, recent release, company announcement, and current-event topics.
- Does not trigger freshness for ordinary internal implementation questions.
- Quick Answer and fast branch produce `shouldCaveat: true` rather than blocking on verification.
- Claim Check and Deep Solution produce `shouldVerify: true` when freshness tools are configured.
- If no freshness tool is configured, prompts include unverified/currentness caveat guidance.
- Metrics capture policy decisions without raw transcript/code content.

## Acceptance Criteria

- The assistant prompt clearly distinguishes fresh external sources from stale prior knowledge.
- Freshness-sensitive topics are detected well enough to caveat or verify current claims.
- Fast actions remain fast and do not block on web verification.
- Claim Check and Deep Solution are allowed to verify freshness later.
- No private transcript/code is sent anywhere in this slice.
- Metrics/debug status can show that freshness was needed but unverified.

## Rollback Plan

- Remove `FreshnessPolicy.ts` and its tests.
- Remove freshness prompt additions from `ContextBuilder`.
- Remove freshness decision plumbing from `ActionRunManager`.
- Remove freshness metrics fields from display.
- Existing M0-M13 behavior should continue unchanged.
