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
- `smart-meter-screenshot-only`: transcript is intentionally empty; add a screenshot to test board/problem grounding.
- `smart-meter-capacity`: prior scope completed; should advance to Capacity & Constraints.
- `smart-meter-data-modeling`: prior scope and capacity completed; should advance to Core Entities & Data Model.
- `smart-meter-corrections-deep-dive`: interviewer asks a targeted drill-down; uses Go Deeper.

To test screenshot grounding, add a real screenshot to a case folder and add it to
`cases.json`:

```json
"screenshots": ["smart-meter-screenshot-only/problem.png"]
```

Suggested screenshots to add:

- `smart-meter-screenshot-only/problem.png`: the full initial smart-meter problem statement.
- `smart-meter-corrections-deep-dive/board.png`: a board with the ingestion pipeline
  and storage model already sketched.
