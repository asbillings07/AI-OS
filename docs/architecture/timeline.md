# The Timeline

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issues: #27 Design the Timeline Model · #25 Understanding Engine · #31 Memory · #5 Event Lifecycle

The **Timeline** is Orion's memory of *how situations unfolded*. It is the temporal view of the Understanding layer: events, context changes, decisions, and interactions arranged in order and connected into narratives.

The temporal model in one line:

> **The Timeline records history. Context represents the present. Opportunities point toward the future.**

```
   Past            Present            Future
    │                 │                 │
    ▼                 ▼                 ▼
 Timeline   ──▶   Context    ──▶   Opportunities
```

A Timeline is **more than an activity log**. A log shows isolated rows; the Timeline understands *stories* — that an agenda, a meeting, its decisions, and the follow-ups that came out of it are one connected arc, not seven unrelated records.

---

## Why it comes after Memory

[Memory](./memory.md) defines *what persists* through time; the Timeline defines *how persisted things are viewed over time*. You cannot meaningfully order and relate history until you have said what is worth keeping — so Memory is the prerequisite concept, and the Timeline is the temporal lens over it and over the event stream.

---

## Responsibilities

The Timeline is responsible for:

- **Recording significant events and state changes** in chronological order.
- **Preserving temporal relationships** — what came before what, and what led to what.
- **Connecting related activity into narratives** rather than leaving it as disconnected records.
- **Supporting reasoning across time** — enabling [Insights](../domain/domain-model.md) and answering "how did we get here?"
- **Providing explainability** — an [Explanation](../domain/ubiquitous-language.md) often traces back through the Timeline to the events that justify a recommendation.

The Timeline is **not** responsible for: being the operational store, duplicating the immutable [Event](../domain/event-lifecycle.md) log, capturing every transient system tick, or performing business logic. It is a *view and a set of relationships over* history, not a second source of truth.

---

## What appears on the Timeline

The Timeline is selective — it records what is *significant*, in keeping with the attention objective ([ADR-0006](../adr/0006-attention-is-the-primary-resource.md)):

- **User activity** — a task completed, a meeting attended, a document created, a reply sent.
- **Context changes** — a project became blocked, a priority shifted, a deadline entered its warning window.
- **AI activity** — a briefing generated, an [Opportunity](./opportunity-detection.md) detected, an insight surfaced, a recommendation made.
- **System events** — an integration connected, a Skill installed (kept sparse; most system noise stays off the Timeline).

AI-generated entries are marked as such and carry their confidence, so history distinguishes *what happened* from *what Orion concluded*.

---

## Relationships (beyond chronology)

What turns a list into a narrative is the relationships between entries:

```
  Agenda created ──causes──▶ Meeting held ──produces──▶ Decision ──spawns──▶ Follow-up task
                                   │                                              │
                                   └──────────────── related to ─────────────────┘
```

Supported relationship kinds include **causes / consequences**, **parent / child**, **related**, **correlated**, and **milestone / decision / outcome**. These are the same first-class [Relationships](../domain/domain-model.md) that make Context "a graph, not a bag" ([ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md)), viewed along the time axis.

---

## How it is used

- **Historical reasoning** — "what happened before this meeting?", "what has been waiting the longest?" (served via the [Context Query API](./context-query-api.md)'s temporal queries).
- **Explainability** — recommendations can point at the arc that produced them.
- **Insight generation** — patterns across the Timeline become [Insights](../domain/domain-model.md) and feed [Briefings](../domain/ubiquitous-language.md).

---

## Boundaries

- The Timeline is rebuildable from the immutable event stream ([ADR-0002](../adr/0002-everything-is-an-event.md)); it is a projection, not a mutable store. Deleted or corrected information is represented as *new* entries, never by rewriting history.
- It draws on [Memory](./memory.md) for durable knowledge and on the [Context Lifecycle](./context-lifecycle.md) for how active context became historical.

---

## Related documents

- [Understanding Engine](./understanding-engine.md) (#25) · [Memory](./memory.md) (#31) · [Context Lifecycle](./context-lifecycle.md) (#28)
- [Event Lifecycle](../domain/event-lifecycle.md) (#5) — the immutable facts the Timeline orders
- [ADR-0002](../adr/0002-everything-is-an-event.md) · [ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md)
