# ADR-0004: AI Recommends, Rules Decide

> Status: Accepted
> Date: 2026-07-19 · Deciders: @asbillings07
> Related: #11, #24 (AI Abstraction Layer), [Engineering Principles](../principles/engineering.md)

## Context

Orion depends on AI to interpret messy, unstructured signals and generate understanding. But AI models are non-deterministic, occasionally wrong, and cannot offer guarantees. A product whose entire value rests on *trust* cannot let correctness, safety, or irreversible actions depend on a model's output alone.

We need a clear architectural boundary that lets us use AI for what it's great at (interpretation) without letting it be the thing that *enforces* anything.

## Why now?

Before we build the first AI-driven features (v0.1 summarization and priority scoring, #6), the risk boundary must already exist — otherwise model output and guarantees get entangled from day one and are painful to separate later.

## Decision

**AI recommends; deterministic rules decide and enforce.** There is a hard line between:

- the **reasoning layer** — AI-driven, non-deterministic, *advisory*: it summarizes, scores, detects, suggests; and
- the **decision/enforcement layer** — deterministic, auditable code: it validates, gates, and executes anything with consequences.

**If a behavior must be guaranteed, it is code, not a prompt.** Any action with side effects passes through deterministic guardrails. No irreversible action is taken on a model's say-so.

```
AI → Recommendation → Deterministic Validation → Action
```

## In one sentence

> AI may interpret reality, but only deterministic code may guarantee outcomes.

## Consequences

- **Positive:** Safety and correctness don't depend on model behavior; recommendations are explainable and overridable; we can swap AI providers without changing guarantees (supports #24 AI Abstraction Layer).
- **Negative / costs:** More engineering than "let the model do it" — we must build the deterministic decision/guardrail layer and keep the boundary clean.
- **Follow-ups:** The AI Abstraction Layer ADR (#24) defines how providers plug into the reasoning layer behind an adapter.

## Principles

- **Supports:** Engineering #1 (augment, not replace), #4 (AI advises, rules enforce), #14 (deterministic reversibility); Product #4 (explain why), #7 (confidence).
- **Trade-offs:** Accepts additional engineering effort and some limits on end-to-end AI autonomy in exchange for trust, safety, and vendor-independence.

## Alternatives considered

- **End-to-end agent that both decides and acts**: rejected — no guarantees, unsafe for irreversible actions, opaque.
- **Rules only (no AI)**: rejected — can't interpret messy real-world signals into understanding.
