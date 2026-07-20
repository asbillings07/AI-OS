# The Context Lifecycle

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issues: #28 Design the Context Lifecycle · #25 Understanding Engine · #5 Event Lifecycle

[Context](../domain/domain-model.md) is Orion's evolving understanding of the user's situation. This document defines how a piece of context comes into being, is enriched, becomes stale, and is retired — without ever destroying the facts underneath it.

The governing idea:

> **Facts are forever. Context is temporary.**

An [Event](../domain/domain-model.md) is an immutable record that something happened ([ADR-0002](../adr/0002-everything-is-an-event.md)); it never changes and is never deleted. **Context is a projection over those facts** — Orion's *current interpretation* of them — and that interpretation is expected to change as new events arrive. Separating the two is what keeps Orion both accurate (facts are preserved) and relevant (understanding stays current). This is the same "no mutable State" stance from the [Ubiquitous Language](../domain/ubiquitous-language.md): context is a rebuildable projection, not a mutable store.

---

## The lifecycle

```
  Event
    │  applied to
    ▼
  Created ──▶ Enriched ──▶ Active ──▶ Resolved ──▶ Archived
                 ▲            │                        │
                 └── updated ─┘                        ▼
                (new events)                    Historical reference
                                              (still queryable, inert)
```

Not every piece of context traverses every stage, but every piece has a defined place in this progression.

- **Created** — a new event introduces something Orion did not previously understand (a new conversation, a new project, a new commitment). Context that does not yet exist is created rather than forced onto an unrelated piece.
- **Enriched** — subsequent events add detail, relationships, and confidence. Enrichment is where "a graph, not a bag" ([ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md)) is realized: new events mostly add *relationships* between things Orion already understands.
- **Active** — the context is part of Orion's current picture and can reveal [Signals](../domain/domain-model.md), inform [Capacity](./capacity.md), and be surfaced through the [Context Query API](./context-query-api.md).
- **Updated** — active context continues to change as reality changes. Updating is the normal state, not an exception; context is never assumed to be "final."
- **Resolved** — the situation the context described has concluded (the email was answered, the trip happened, the project shipped). Resolution is a *meaning* change, not a deletion.
- **Archived** — resolved context is retired from active reasoning so it stops competing for attention, but remains available for historical reasoning via the [Timeline](./timeline.md) and, where durable, [Memory](./memory.md).

---

## What drives transitions

Transitions are driven by **events and the passage of time**, never by manual bookkeeping (Orion derives, it does not require grooming — [ADR-0001](../adr/0001-situational-awareness-not-task-manager.md)):

- **New events** enrich, update, or resolve context.
- **Time** erodes relevance: a meeting that is central this morning is historical tomorrow. Context can carry a natural relevance decay so that "old and untouched" trends toward archived.
- **Explicit resolution** — an event that clearly concludes a situation (a reply sent, a task completed) resolves the related context.
- **User signals** — a user dismissing something is itself an event that can resolve or suppress the related context.

### Reactivation

Archived context is not deleted, so it can be **reactivated** when a new event makes a concluded situation relevant again (a "resolved" thread gets a new reply). Reactivation produces fresh active context linked to the prior history rather than mutating the archived record.

---

## Expiration and retention

- **Active context stays lean.** The point of expiration is to protect attention ([ADR-0006](../adr/0006-attention-is-the-primary-resource.md)): stale context that lingers degrades every downstream judgment. When in doubt, archive from active reasoning rather than delete.
- **History is never lost.** Because the underlying events are immutable, any context can be rebuilt. Archival changes *relevance*, not *existence*.
- **AI-generated context is held to a higher bar than fact-derived context.** Context derived directly from events (a reply was sent) is authoritative; context inferred by Orion (this project seems blocked) carries confidence and is more readily revised or expired. (Confidence itself is elaborated in the deferred `understanding-confidence.md`.)

---

## Example

```
  Email received
        │
        ▼
  Conversation context created
        │  reply drafted, related to a Project
        ▼
  Enriched (relationships added)
        │
        ▼
  Active (may raise a Work Item)
        │  reply sent
        ▼
  Resolved
        │  no further activity
        ▼
  Archived ──▶ available for historical reasoning
        ▲
        │ new reply arrives
        └── reactivated
```

---

## Boundaries

- The lifecycle governs **Context**, not **Events**. The [Event Lifecycle](../domain/event-lifecycle.md) (#5) covers the immutable side; this document covers the mutable interpretation built on top of it.
- It integrates with [Timeline](./timeline.md) (archived context becomes historical narrative), [Memory](./memory.md) (durable facts are promoted out of transient context), and [Opportunity Detection](./opportunity-detection.md) (active context is where opportunities are found).

---

## Related documents

- [Understanding Engine](./understanding-engine.md) (#25) — the subsystem this is part of
- [Event Lifecycle](../domain/event-lifecycle.md) (#5) — the immutable counterpart
- [Memory](./memory.md) (#31) · [Timeline](./timeline.md) (#27)
- [ADR-0002](../adr/0002-everything-is-an-event.md) · [ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md)
