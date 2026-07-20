# ADR-0009: Storage Strategy

> Status: Accepted
> Date: 2026-07-19 · Deciders: @asbillings07
> Related: #22 · builds on [ADR-0002](./0002-everything-is-an-event.md), [ADR-0007](./0007-event-driven-architecture.md), [ADR-0008](./0008-event-bus.md) · relates to [ADR-0005](./0005-context-is-a-first-class-domain-object.md)

## Context

Orion holds many kinds of information — events, context, memory, timeline, preferences, integration config, and AI artifacts — and they do not share the same nature. Some are immutable facts; some are continuously re-derived; some are ephemeral; some must persist indefinitely. Treating them all the same (one mutable table per thing, updated in place) would quietly destroy the properties Orion depends on: replay, audit, and the ability to reinterpret history.

The temptation is to pick a database and move on. But *which database* is not the durable decision — **how Orion classifies information and what it treats as the source of truth** is. That classification must outlive any storage technology ([Eng #8](../principles/engineering.md)).

## Why now?

The first slice persists Gmail-derived events and builds Context from them. If "important," "resolved," or "priority" get written back onto the stored facts, the immutable-events stance ([ADR-0002](./0002-everything-is-an-event.md)) is lost on day one. The classification has to be fixed before the first write.

## Decision

**Events are the single source of truth; everything else is a derived, rebuildable projection.** Storage is organized by the *nature* of the data, not by feature:

- **Immutable records — the source of truth.** Events (and audit/activity history) are stored **append-only**: never updated, never deleted in the normal course ([ADR-0002](./0002-everything-is-an-event.md), [Eng #5](../principles/engineering.md)). This is the one store that must never be lied to.
- **Derived data — rebuildable projections.** Context, Insights, Priorities, Recommendations, Briefings, Timeline, and [Capacity](../architecture/capacity.md) are **projections** of the event stream ([ADR-0005](./0005-context-is-a-first-class-domain-object.md)). They may be cached, snapshotted for performance, and **discarded and rebuilt** from events at any time. They are never the authority.
- **Operational data — conventional mutable records.** Goals, Tasks, Workspaces, settings, and integration configuration are legitimately mutable state and stored as ordinary records; where their history matters, changes are themselves emitted as events.
- **Knowledge & Memory — durable, provenanced.** [Memory](../architecture/memory.md) and knowledge carry provenance and confidence and persist across the lifetime of the workspace, distinct from transient Context.
- **AI artifacts — derived and disposable.** Embeddings, summaries, plans, and cached reasoning are treated as a **cache**: reproducible from events + current models, never a source of truth. Models improve; artifacts get regenerated.

> **Projection vs. Cache.** Both are derived from events and neither is authoritative, but they differ in intent. A **projection** is derived state with *semantic meaning* — it is queried as understanding (Context, Timeline, Priorities). A **cache** is a pure *performance optimization* with no semantic authority (embeddings, memoized summaries). Rebuilding a projection restores meaning; rebuilding a cache only restores speed.

Two rules make this concrete:

1. **Store facts, derive interpretation.** Store *that an email arrived*; do not store *that it is important* — importance is derived and will change as context and models evolve. (This is the storage expression of "facts are forever, context is temporary" — see [Context Lifecycle](../architecture/context-lifecycle.md).)
2. **Deletion is a deliberate, privacy-driven exception**, not routine ([Eng #13](../principles/engineering.md)), and must be genuinely supported when the user requests it.

**Deliberately not decided here (reversible, per [Eng #12](../principles/engineering.md)):** the specific technologies — relational vs. document vs. graph vs. object store vs. vector index. v0.1 favors the **smallest boring choice** that stores an append-only event log plus rebuildable projections ([Eng #9](../principles/engineering.md)); polyglot persistence (a vector store, a graph store) is adopted only when a real need forces it. Those are code/issue decisions, not ADRs.

## In one sentence

> The event log is the only source of truth; every other store is a rebuildable projection or a cache, and specific databases are deferred until needed.

## Consequences

- **Positive:** Replay, audit, and reinterpretation are structural, not features to add later; projections can be redesigned freely without data migrations of the truth; understanding compounds because raw facts are never overwritten ([Eng #5](../principles/engineering.md), #11); privacy deletion has a clear meaning.
- **Negative / costs:** Rebuilding projections has a compute cost and requires replay tooling; separating "fact" from "interpretation" demands discipline at every write; keeping derived stores eventually-consistent with the log adds design work.
- **Follow-ups / new constraints:** Snapshotting/indexing strategies for projections are implementation details to earn later; a future ADR would be warranted only if a *hard-to-reverse* storage commitment is made (e.g., adopting a specialized store as load-bearing).

## Principles

- **Supports:** [Eng #5](../principles/engineering.md) (events source of truth; never lose history), #8 (domain permanent; storage tech temporary), #11 (age gracefully), #12 (defer database choice), #13 (privacy-driven deletion).
- **Trade-offs:** Accepts projection-rebuild cost and eventual consistency in exchange for durability, auditability, and freedom to change every storage technology later.

## Alternatives considered

- **Single mutable relational database as the model (update-in-place):** rejected — destroys history and replay; contradicts [ADR-0002](./0002-everything-is-an-event.md). (A relational DB is fine as an *implementation* of the append-only log + projections; the rejection is of the mutate-in-place *model*.)
- **Polyglot persistence from the start:** rejected for v0.1 — premature complexity ([Eng #9](../principles/engineering.md)); introduce specialized stores only when reality demands.
- **Treating AI artifacts (embeddings/summaries) as source of truth:** rejected — they are derived from events and current models and must be regenerable, or Orion becomes unable to improve without data loss.
- **No source-of-truth distinction (every store equal):** rejected — without one authority, reconciling conflicting data becomes intractable and explanations lose their grounding.
