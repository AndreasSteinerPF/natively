# System Design Interview Copilot Design

## Goal

Add a dedicated meeting-copilot preset optimized for live system design interviews. It should avoid repo and custom project context by default, use a shared interview history across actions, and guide the user through a strong system-design framework that builds coherently across turns.

## Product Outcome

The user can start a live interview, receive the full prompt and constraints up front, and use two actions:

- `Guide Me`: produce the complete playbook for the current system-design phase.
- `Go Deeper`: critique or expand the current design artifact, optionally using screenshots.

The copilot should work with transcript alone at the start, then become screenshot-aware as the user shares Excalidraw or prompt screenshots later in the interview.

## Core Constraints

- No repo access by default.
- No custom project docs or pinned project context required by default.
- Shared state across `Guide Me` and `Go Deeper`; outputs must build on each other.
- Low reading load, but each `Guide Me` invocation must cover a whole phase, not only the immediate next move.
- The interview format assumes requirements are provided at the beginning; default behavior should not over-index on clarifying questions.
- Guidance should stay generic first, with a bias toward the user's familiar stack when concrete examples help:
  - Python
  - FastAPI or Sanic
  - Postgres by default unless access patterns or scale clearly favor another store
  - Redis for caching
  - Kafka, RabbitMQ, or SQS depending on fit
  - AWS familiarity, but vendor-neutral wording by default
  - Simplicity over unnecessary sophistication

## User Interaction Model

### Guide Me

`Guide Me` is the primary action. Each invocation returns the full package for the current design phase.

Expected shape:

- `Step`: current framework phase
- `Goal`: what the phase must accomplish
- `Draw`: ordered drawing actions for Excalidraw
- `Say`: short, interview-ready narration lines to speak while drawing
- `Key Decisions`: the important tradeoffs or assumptions to mention for that phase

The response should be compact, but each section must cover the whole phase well enough that the user can work for a few minutes without re-triggering the copilot.

### Go Deeper

`Go Deeper` is the critique and refinement action. It should:

- inspect the current transcript context
- inspect screenshot/board state when available
- critique the current design area
- surface missing components or weak tradeoffs
- suggest stronger follow-up language
- write its conclusions back into the shared state so the next `Guide Me` call continues from the improved design

## System Design Framework

The action logic should use an adaptive framework rather than a rigid fixed script.

Default phases:

1. Parse requirements
2. Scope the solution
3. Estimate scale when material
4. Define interfaces and boundaries
5. High-level architecture
6. Key deep dives
7. Tradeoffs and extensions

Interpretation rules:

- If the interviewer jumps ahead to a subsystem or tradeoff, the current phase can skip forward.
- If a previous phase is already covered in transcript history, do not repeat it.
- If a screenshot shows a partially complete board, tailor the `Draw` instructions to the current board instead of restating a fresh design.

## Problem Pattern Bias

The copilot should infer a likely pattern from the prompt or transcript, such as:

- feed / timeline
- chat / messaging
- search
- storage / file service
- scheduler / job execution
- analytics / event pipeline
- rate limiting / control plane
- generic backend service

This pattern inference is a soft bias, not a hard lock. It should influence the suggested architecture, likely failure modes, and deep-dive areas, but must revise easily when the prompt or screenshot points elsewhere.

## Context and Memory

The preset should rely on a single shared interview state:

- recent transcript
- earlier transcript needed for continuity
- prior `Guide Me` outputs
- prior `Go Deeper` outputs
- screenshot-derived board state when present
- current inferred framework phase
- current inferred problem pattern
- active design assumptions and unresolved risks

Both actions read and write this shared state. Newer accepted refinements should override older assumptions unless the transcript shows the user rejected them.

## Prompt/Model Behavior

- Optimize for strong reasoning and coherent continuation across turns.
- Keep answers speakable and usable in a live interview.
- Favor generic architectural terms first; mention concrete tools only when they help explain a sensible implementation path.
- Prefer Postgres as the default persistence choice unless the design clearly benefits from another store.
- Avoid suggesting exotic or over-engineered components without a strong reason.
- Do not use web search by default.
- Do not ground against repo code or project docs by default.

## Configuration Shape

Implement this as a new meeting-copilot preset/configuration rather than replacing the existing default meeting setup.

Expected characteristics:

- Two actions only: `guide-me`, `go-deeper`
- Project docs disabled by default
- Repo/code tools disabled by default
- Transcript context kept large enough for continuity
- Screenshot-aware context included when available
- Models biased toward high reasoning quality; one action may still prefer a faster model if quality remains strong enough for live usage

## Likely Code Touchpoints

- `electron/meeting-copilot/defaultActionConfig.ts`
  - define the new preset defaults and action prompts
- `electron/meeting-copilot/types.ts`
  - extend config typing if presets or additional prompt metadata are needed
- `electron/meeting-copilot/ActionConfigStore.ts`
  - load/select the new preset if the store currently assumes one default shape
- `electron/meeting-copilot/ContextBuilder.ts`
  - ensure screenshot-derived context and action history are assembled for shared continuity
- `electron/meeting-copilot/ActionRunManager.ts`
  - persist action outputs into shared state if not already done
- `src/components/meeting-copilot/MeetingCopilotPanel.tsx`
  - surface the preset and simplify action labels if needed

Additional touchpoints may be required after code inspection, but the implementation should stay inside the meeting-copilot path unless current architecture forces a broader change.

## Testing Requirements

- Unit tests for the new default config shape and action count
- Tests proving repo/project-doc context is disabled for this preset by default
- Tests proving shared action history flows into later action context
- Tests proving screenshot context is included when available without requiring it at startup
- Tests proving prompts reflect system-design framework behavior rather than meeting/deep-code-review behavior

## Non-Goals

- Reworking the global mode system
- Replacing the existing meeting-copilot experience
- Building a full custom per-user stack editor in this change
- Introducing web search or repo-grounding into the default system-design interview preset
