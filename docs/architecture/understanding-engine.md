# The Understanding Engine

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issues: #25 Design the Context Engine (renamed Understanding Engine) · children #26–#31, #10

The **Understanding Engine** is the subsystem that owns the entire middle layer of the [Mental Model](../domain/mental-model.md). It sits between raw reality and human decisions, and its single job is to turn a stream of isolated facts into a coherent, queryable, explainable understanding of the user's world.

This document is the anchor for the Understanding layer. It defines what the engine is responsible for, what it deliberately is not, and how its components fit together. Each component has its own document; this one exists so you can hold the whole thing in your head before diving in. It is **implementation-agnostic** — no databases, buses, or models appear here (those are [ADRs](../adr/) and, later, code).

---

## Orientation

Where the Understanding Engine sits in the whole:

```
  Reality              (Sources: Gmail, Calendar, GitHub, a bank, a travel provider, Orion itself)
     │  events
     ▼
  UNDERSTANDING ENGINE   ← this document
     │  meaning
     ▼
  Decision              (Work Items, Recommendations + Explanations, Rules)
     │
     ▼
  Mission Control       (decisions-with-reasons, presented to the user)
```

What the engine contains, and how meaning flows through it:

```
        Events
          │  applied to
          ▼
       Context ──built from──▶ Relationships
          │
          │  fed by            (Memory = what persists · Timeline = how it's viewed over time)
          │◀──────────────── Memory ─── Timeline
          │
          │  reveals
          ▼
       Signals ──synthesized into──▶ Insights
          │
          ├──────────────▶ Opportunity   "is there value in acting?"
          │
          └── informed by  Capacity      "can the user act well right now?"
```

Two things worth noticing immediately:

- **Everything moves upward toward meaning**, never toward more data. The engine's output is understanding, not a bigger pile of records.
- **Capacity enters here, not at the Decision layer.** It is *inferred* from Context (Orion estimates it), so it belongs to Understanding. It is an input the Decision layer consumes, not something the Decision layer invents.

---

## Responsibilities

The Understanding Engine is responsible for:

- **Consuming events** from the event stream and applying them to Context ([ADR-0002](../adr/0002-everything-is-an-event.md)).
- **Maintaining Context** as an evolving, graph-shaped understanding of the user's situation ([ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md)).
- **Detecting meaningful change** — surfacing Signals, and the forward-looking Signals that are Opportunities.
- **Synthesizing across time** — producing Insights, maintaining the Timeline, and preserving durable Memory.
- **Estimating Capacity** — how effectively the user can act right now.
- **Serving understanding** to the rest of the system through a semantic interface (the [Context Query API](./context-query-api.md)), so Skills and Agents ask *"what should I know?"* rather than fetching raw data.

The Understanding Engine is **not** responsible for:

- **Deciding or enforcing.** It produces understanding; Rules decide and gate Actions ([ADR-0004](../adr/0004-ai-recommends-rules-decide.md)).
- **Executing workflows or calling external systems.** Side effects live behind the Decision/Execution boundary.
- **Presenting UI.** Mission Control renders; the engine informs.
- **Owning event transport or storage.** Those are platform concerns (the Event Bus, storage strategy) below it.

This keeps the engine squarely in the Understanding layer: it answers *"what does it mean?"* and nothing else.

---

## The components

Each is a document in this folder. In reading order:

| Component | Question it answers | Doc |
| --- | --- | --- |
| Context Lifecycle | How is understanding created and how does it age? | [context-lifecycle.md](./context-lifecycle.md) (#28) |
| Memory | What should Orion never forget? | [memory.md](./memory.md) (#31) |
| Timeline | How did we get here? | [timeline.md](./timeline.md) (#27) |
| Capacity | Can the user act well right now? | [capacity.md](./capacity.md) (#10) |
| Opportunity Detection | Is there something worth doing? | [opportunity-detection.md](./opportunity-detection.md) (#26) |
| Prioritization Engine | Given everything, what rises to the top? | [prioritization-engine.md](./prioritization-engine.md) (#29) |
| Context Query API | How does the rest of Orion ask for meaning? | [context-query-api.md](./context-query-api.md) (#30) |

**Context** and **Relationships** are the substrate the whole engine is built on; they are defined in the [Domain Model](../domain/domain-model.md) and elaborated in the Context Lifecycle. **Signals** and **Insights** are likewise domain concepts; the engine is the machinery that produces them.

---

## Boundaries

The Understanding Engine has two clean seams:

- **Below (input):** it consumes a durable stream of Events. How events are transported and stored (the Event Bus, storage strategy) is deliberately out of scope here and belongs to technology ADRs (#20–22). The engine assumes only that events arrive and are replayable.
- **Above (output):** it exposes understanding through the [Context Query API](./context-query-api.md). Skills, Agents, the Prioritization Engine, and Mission Control are all *consumers*; none reach inside the engine or around it to raw sources.

Because everything above depends only on the query interface, the engine's internals can evolve without breaking consumers — the same "domain is permanent, integrations are temporary" discipline applied one layer up ([Engineering #8](../principles/engineering.md)).

---

## Design rationale

- **Understanding, not intelligence.** The engine is named for what the user gains (understanding), not for its mechanism (AI). AI is one tool inside it; the concept survives any model change.
- **Context is first-class.** Understanding is produced, stored, related, and queried as a concept in its own right, never assembled ad hoc per prompt ([ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md)).
- **A single objective.** Everything the engine produces exists to help allocate the user's **Attention** well ([ADR-0006](../adr/0006-attention-is-the-primary-resource.md)); it is not trying to surface more, only to surface what matters.
- **Composition over a monolith.** The engine is a set of small, understandable components, not one opaque pipeline ([Engineering #6](../principles/engineering.md)). Each can be reasoned about, tested, and replaced on its own.

---

## Open questions (resolved in the component docs)

- How is Context represented, and how does it expire? → [Context Lifecycle](./context-lifecycle.md)
- What persists forever versus what is transient? → [Memory](./memory.md)
- How are competing things ranked? → [Prioritization Engine](./prioritization-engine.md)
- How is uncertainty represented? → deferred to a future `understanding-confidence.md` (see [architecture README](./README.md)).

---

## Related documents

- [Mental Model / Decision Loop](../domain/mental-model.md) — the cognition this engine implements
- [Domain Model](../domain/domain-model.md) — the entities the engine operates on
- [Ubiquitous Language](../domain/ubiquitous-language.md) — definitions (Context, Signal, Insight, Opportunity, Capacity, Memory, Timeline)
- [ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md) · [ADR-0002](../adr/0002-everything-is-an-event.md) · [ADR-0006](../adr/0006-attention-is-the-primary-resource.md)
