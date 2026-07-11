# Meeting Copilot Eval Fixtures

Manual eval suite for system-design interview behavior. These cases are intentionally
for human review, not golden-output scoring.

Run all cases against the default comparison models:

```bash
OPENROUTER_API_KEY=... npm run eval:meeting-copilot:suite
```

Dry-run the assembled messages without calling a model:

```bash
npm run eval:meeting-copilot:suite -- --dry-run
```

Override models:

```bash
npm run eval:meeting-copilot:suite -- \
  --models google/gemini-3.5-flash,anthropic/claude-fable-5
```

Run one case:

```bash
npm run eval:meeting-copilot:suite -- --case smart-meter-fresh
```

Current cases:

- `smart-meter-fresh`: full problem statement in transcript; should start at Requirements & Scope.
- `smart-meter-screenshot-only`: transcript is intentionally empty; screenshot tests board/problem grounding.
- `smart-meter-capacity`: prior scope completed; should advance to Capacity & Constraints.
- `smart-meter-data-modeling`: prior scope and capacity completed; should advance to Core Entities & Data Model.
- `smart-meter-api-before-architecture`: interviewer asks to jump to architecture; should still advance to APIs & Access Patterns.
- `smart-meter-corrections-deep-dive`: interviewer asks a targeted drill-down; uses Go Deeper.
- `notification-ambiguous-fresh`: intentionally underspecified different-domain prompt; should clarify scope, not draw architecture.

Manual review rubric:

- `smart-meter-fresh`: must ground in the written requirements, call out corrections/reprocessing/tariffs, and not start at architecture.
- `smart-meter-screenshot-only`: must use screenshot facts; must not import prior/default domains or claim missing screenshot context.
- `smart-meter-capacity`: must compute ~580/s average, ~11.6k/s burst, 5k dashboard RPS, 5-minute freshness, and 300 ms p95.
- `smart-meter-data-modeling`: must use half-hourly readings, effective-time tariffs, customer/meter mapping, immutable raw data, and derived aggregates.
- `smart-meter-api-before-architecture`: must resist skipping the fixed flow; expected phase is APIs & Access Patterns, not High-Level Architecture.
- `smart-meter-corrections-deep-dive`: must distinguish point corrections from bulk reprocessing and build on the existing data model/architecture.
- `notification-ambiguous-fresh`: must ask or state minimal scope assumptions; any scale must be labeled as an assumption, and it must not jump into queues/databases prematurely.

To test screenshot grounding, add a real screenshot to a case folder and add it to
`cases.json`:

```json
"screenshots": ["smart-meter-screenshot-only/problem.png"]
```

Suggested screenshots to add:

- `smart-meter-screenshot-only/problem.png`: the full initial smart-meter problem statement.
- `smart-meter-corrections-deep-dive/board.png`: a board with the ingestion pipeline
  and storage model already sketched.
