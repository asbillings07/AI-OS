# Orion's Mental Model

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related: #17 Orion Domain Model · [Domain README](./README.md) · ADR-0002, 0003, 0005, 0006

This is the conceptual heart of Orion. One page, one diagram, one explanation. If you read only one document before reading the code, read this one. It is **not** implementation — it's how Orion thinks.

---

## The Decision Loop

```
                        ┌─────────────────────────────────────────────┐
                        │                                             │
                        ▼                                             │
   Reality ──▶ Events ──▶ Context ──▶ Signals ──▶ Work Items ──▶ Recommendations
                        │                                             │
                        │                                             ▼
                        │                                      Human Decision
                        │                                             │
                        └──────────────── new events ◀────────────────┘
```

We call this **the Decision Loop** — name it, so it can be reasoned about. ("This feature skips Context." "That bypasses the Decision Loop.")

Orion is **not a linear pipeline. It is a loop.** The human decision at the end produces new events at the beginning, and the cycle continues — each turn a little wiser than the last.

## The explanation

- **Reality** changes. Things happen in the user's world across many sources.
- **Events** capture reality as immutable facts (ADR-0002). Nothing is lost; history is preserved.
- **Context** is the evolving understanding derived from events (ADR-0005). This is where isolated facts become a coherent picture — and where relationships between things emerge.
- **Signals** are the meaningful changes and relationships discovered within context. Not everything matters; signals are what does.
- **Work Items** are the things important enough to deserve the user's attention or action (ADR-0003). Signals become work.
- **Recommendations** are advisory, always-explainable suggestions about what to do — the reasoning made actionable.
- **Human Decision** is the point of it all. Orion advises; the human decides (ADR-0004). Attention is spent — well, we hope (ADR-0006).
- **New Events.** The decision (and its aftermath) becomes new events, which reshape context, which produce new signals and recommendations. The loop turns.

## Why the loop matters

The final arrow — *Human Decision → new events* — is the part most systems miss. It's what makes Orion **compound**: every decision teaches it something, understanding accumulates, and the system grows more useful over time rather than decaying (Engineering #5, #11). A linear "pipeline" mental model would quietly discard exactly the feedback that makes Orion intelligent.

This also resolves a common question about what *kind* of system Orion is. It is not event-driven, AI-driven, or rule-driven. **Orion is decision-driven.** Events, context, signals, AI, and rules all exist for one reason: to improve a decision. That is the stronger abstraction, and it is why the loop — not any single stage — is the thing to reason about. When evaluating any future feature or design, the first question is simply: **where does this fit in the loop?** If the answer is unclear, it needs more thought.

## The deepest abstraction

Underneath every concept is a single idea:

> **Everything in Orion exists to improve a future human decision.**

- Events matter because they inform context.
- Context matters because it reveals signals.
- Signals matter because they surface work.
- Work matters because it informs recommendations.
- Recommendations matter because they improve decisions.
- Decisions create new events — and the loop begins again.

Every other document, ADR, and line of code is ultimately one implementation of this loop.
