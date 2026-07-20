# Memory

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issues: #31 Design the Memory Model · #25 Understanding Engine · #27 Timeline

**Memory** is what Orion permanently knows. Where [Context](./context-lifecycle.md) is Orion's *current* understanding of the user's situation, Memory is the durable knowledge that persists whether or not it is relevant right now — so understanding compounds instead of being rediscovered ([Engineering #11](../principles/engineering.md), the Vision's "attention compounds").

The distinction that defines this document:

> **Context is what Orion currently believes is relevant. Memory is what Orion should not forget.**

A meeting tomorrow is Context. *The user prefers deep work in the morning* is Memory. The first is transient and will resolve; the second remains true across countless situations and should quietly inform them all.

---

## Why Memory is separate from Context

Collapsing the two would force Orion to either drown active reasoning in permanent facts or forget things that matter the moment they stop being relevant. Keeping them separate lets each do one job:

- **Context** stays lean and current (it expires — see the [Context Lifecycle](./context-lifecycle.md)).
- **Memory** stays durable and quiet (it persists, and is *recalled into* Context when relevant).

Memory **influences** today's Context; it never *becomes* the Context. When a situation arises where a memory matters, it is recalled and layered onto the current picture, then steps back.

---

## What qualifies as a memory

Memory is not a copy of every event (that is what the immutable event stream and the [Timeline](./timeline.md) are for). A memory is a **durable, reusable piece of knowledge** — something that will still be useful long after the events that revealed it have scrolled into history.

```
  Timeline  = every significant thing that happened, in order
  Memory    = the small set of lasting truths distilled from it
```

### Categories

- **Personal** — relationships, preferences, routines, important dates, communication style.
- **Professional** — projects, architectural decisions, working habits, team relationships.
- **Knowledge** — concepts, decisions and their rationale, lessons learned, reference material (often fed by [Knowledge Sources](../domain/ubiquitous-language.md)).
- **Operational** — connected Skills, integration configuration, and standing [User Preferences](../domain/ubiquitous-language.md) (which are explicit and authoritative, unlike inferred memory).

---

## What a memory carries

Each memory should be able to answer "how do you know this, and how sure are you?" — because Memory feeds Recommendations, and Recommendations must be explainable ([Product #4](../principles/product.md)):

- **Type** and **related entities** — what it is about.
- **Provenance** — the events, observations, or user statements it came from.
- **Confidence** — how strongly Orion holds it (a user-stated fact ranks above an inferred pattern).
- **Created / last-verified** — memories can go stale and be re-confirmed.
- **Revision history** — memories evolve; the trail of how is preserved.

---

## Lifecycle

```
  Observation / Event / user statement
        │
        ▼
  Candidate memory        (Orion notices something might be durable)
        │  verification (evidence, repetition, or user confirmation)
        ▼
  Stored memory
        │  recalled into Context when relevant
        ▼
  Referenced ──▶ Updated (new evidence revises it)
        │
        ▼
  Retired (optional)      (proven wrong or no longer true)
```

- **Fact-derived vs. inferred.** A memory drawn directly from a user statement ("my daughter's birthday is Sept 30") is authoritative. A memory Orion *infers* ("the user seems to prefer async communication") is a candidate held with lower confidence until corroborated.
- **Correction over deletion.** A wrong memory is revised or retired with its history intact, not silently erased — consistent with Orion's preference for explainability and reversibility.
- **User control.** Because memories persist and shape future advice, the user must be able to see and correct what Orion "remembers." False memory is worse than no memory.

---

## Relationships

Memory sits inside the [Understanding Engine](./understanding-engine.md) and connects to:

- **Context Lifecycle** — durable truths are promoted out of transient context into Memory; Memory is recalled back into Context when relevant.
- **Timeline** — the Timeline records *what happened*; Memory distills *what lasts* from it. (This is why Memory is defined before Timeline: you cannot reason about time until you have said what persists through it.)
- **Opportunity Detection** and **Prioritization** — memories (preferences, goals, relationships) sharpen both what counts as an opportunity and how it is ranked.
- **Recommendations** — Memory supplies the durable knowledge that makes advice feel personal and informed.

---

## Boundaries

Memory does **not**: replace the Timeline, represent current situational state, perform reasoning, or store every raw event. It is a knowledge store queried through the [Context Query API](./context-query-api.md), not a second event log.

---

## Related documents

- [Understanding Engine](./understanding-engine.md) (#25) · [Context Lifecycle](./context-lifecycle.md) (#28) · [Timeline](./timeline.md) (#27)
- [Ubiquitous Language](../domain/ubiquitous-language.md) — Memory, Knowledge Source, User Preference
- [ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md) — context as first-class (Memory is its durable counterpart)
