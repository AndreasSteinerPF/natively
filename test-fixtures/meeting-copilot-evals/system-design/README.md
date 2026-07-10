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

To test screenshot grounding, add a real screenshot to a case folder and add it to
`cases.json`:

```json
"screenshots": ["smart-meter-fresh/problem.png"]
```

Suggested screenshots to add:

- `smart-meter-fresh/problem.png`: the full initial smart-meter problem statement.
- `smart-meter-corrections-deep-dive/board.png`: a board with the ingestion pipeline
  and storage model already sketched.
