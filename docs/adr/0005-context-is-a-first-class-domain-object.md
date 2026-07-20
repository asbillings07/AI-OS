# ADR-0005: Context is a First-Class Domain Object

> Status: Accepted
> Date: 2026-07-19 · Deciders: @asbillings07
> Related: #11, #25 (Context Engine), #30 (Context Query API), #31 (Memory Model), [Domain](../domain/)

## Context

The naive way to build AI features is to assemble prompts on demand: each skill asks "give me the last 20 emails" and stuffs them into a model. This scatters retrieval logic everywhere, makes reasoning shallow and inconsistent, and treats context as a throwaway byproduct of prompt-building.

Orion's differentiator is that it should feel genuinely *aware*. That requires a durable, shared understanding of the user's situation that every part of the system can draw on — and that improves over time.

## Why now?

The moment skills start assembling prompts ad hoc ("grab the last ten emails"), that anti-pattern calcifies and becomes expensive to unwind. Deciding now — before the first skill is written — keeps context first-class from the start.

## Decision

**Context is a first-class domain object**, not something assembled ad hoc into prompts. The Context Engine maintains an evolving representation of the user's situation, derived from events (ADR-0002), and exposes it through a defined interface.

Skills and AI agents ask **"what should I know before helping the user?"** — they query Context; they do not each re-implement raw retrieval. Context is produced, stored, related, and queried as a core concept in its own right.

## In one sentence

> Context is a first-class thing Orion maintains, not something assembled per prompt.

## Consequences

- **Positive:** Consistent, reusable understanding across all skills; deeper reasoning; context that compounds (Engineering #5, #11); a clean seam for the Context Engine and its children (#26–#31).
- **Negative / costs:** Significant design work — representation, lifecycle, expiry, confidence, conflict resolution, querying (the open questions in #25). More upfront architecture than ad hoc prompting.
- **Follow-ups:** Context Engine (#25) and its sub-designs — lifecycle (#28), query API (#30), memory model (#31), timeline (#27), prioritization (#29), opportunity detection (#26).

## Principles

- **Supports:** Engineering #5 (derived from events), #6 (composition — a shared component vs. duplicated retrieval), #11 (age gracefully); Product #4 (explainability — context makes "why" possible).
- **Trade-offs:** Accepts substantial engine design complexity in exchange for genuine awareness and reusable reasoning, rather than shallow per-skill prompting.

## Alternatives considered

- **On-demand prompt assembly per skill**: rejected — shallow, inconsistent, non-reusable, no compounding.
- **A vector store as "context"**: rejected as *sufficient* — retrieval is a mechanism, not the first-class, related, explainable context concept we need.

---

> **Terminology note (2026-07):** Subsequent documentation refers to the subsystem described here as the *Understanding Engine* (see [architecture](../architecture/understanding-engine.md)). This ADR's architectural decision is unchanged.
