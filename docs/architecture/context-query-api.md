# The Context Query API

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issues: #30 Design the Context Query API · #25 Understanding Engine · #23 Skill Architecture · #24 AI Abstraction Layer

> **Ask for meaning, not data.**

That is the entire purpose of the Context Query API. It is the semantic contract through which everything in Orion — Skills, Agents, the Prioritization Engine, Mission Control — reaches the [Understanding Engine](./understanding-engine.md). Consumers ask questions about the user's world; they never reach around to raw sources.

> **On the name.** "API" here means a *domain-facing contract*, not a REST endpoint or any particular transport. It is described conceptually, like the rest of the Understanding layer; if a future reader finds "API" pulling them toward implementation, "Query Interface" is an equally valid name for the same idea.

---

## Raw data versus understanding

The difference this interface enforces:

```
  Without it (data):            With it (meaning):
  "What emails exist?"          "What should I know before this meeting?"
  "What meetings are today?"    "What requires my attention right now?"
  "Which issues are assigned?"  "What is currently blocked?"
```

Raw integrations expose data. The Understanding Engine exposes understanding. A Skill should not care whether an answer came from Gmail, GitHub, the calendar, or a future integration — it should ask *"what should I know?"* and trust the engine to synthesize the best answer from Context, Memory, Timeline, and Capacity.

This is the boundary that turns Orion from an *integration platform* into an *intelligence platform*: once everything asks the Context Query API instead of individual services, integrations become replaceable without touching a single consumer ([Engineering #8](../principles/engineering.md)).

---

## Responsibilities

The Context Query API is responsible for:

- **Exposing active understanding** — Context, Signals, Opportunities, Capacity, Timeline, and Memory — through one semantic surface.
- **Answering questions, not returning tables** — queries are about meaning and situation.
- **Returning evidence** — every answer can be accompanied by the Context, Signals, and Events that support it, so consumers can build [Explanations](../domain/ubiquitous-language.md) ([Product #4](../principles/product.md)).
- **Respecting confidence and relevance** — stale or low-confidence understanding is filtered or flagged, not silently mixed with fact.
- **Hiding storage and integrations** — consumers depend only on this contract, never on how or where anything is stored.

It is **not** responsible for: exposing raw integration APIs, performing workflows, modifying context, or executing external actions. It is a read-oriented window onto understanding.

---

## Kinds of question

The interface is organized around the *kinds of things consumers need to know*, not around sources:

- **Entity** — "What are my active projects?", "What goals are in flight?"
- **Relationship** — "What work relates to Project Atlas?", "Which meetings involve this customer?"
- **Temporal** — "What changed since yesterday?", "What has been waiting the longest?" (served from the [Timeline](./timeline.md)).
- **Situation** — "What should I know before this meeting?", "What is blocking me?", "What deserves my attention?"
- **Reasoning context** — "Assemble what's needed to plan," "…to write this reply," "…for a morning [Briefing](../domain/ubiquitous-language.md)."

That last category is how [Agents](../domain/ubiquitous-language.md) get their context: they request a *purpose-shaped* bundle of understanding rather than assembling prompts from raw retrieval — the anti-pattern [ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md) exists to prevent.

---

## Response shape (conceptual)

A response is understanding plus its justification, not a data dump:

```
  Query: "What should I focus on this morning?"
        │
        ▼
  Context Query API
        │
        ▼
  Relevant Context  +  Prioritized Work Items  +  Supporting evidence  +  Confidence
        │
        ▼
  (e.g., the Morning Briefing)
```

Answers should be **semantic, explainable, provider-agnostic, and optimized for reasoning rather than retrieval**. Where Orion is unsure, the response says so — never presenting a guess as a certainty ([Engineering #7](../principles/engineering.md)).

---

## Boundaries and extension

- **Read-oriented.** Consumers ask; they do not mutate understanding through this interface. Change enters Orion as Events, and understanding updates via the [Context Lifecycle](./context-lifecycle.md).
- **Extensible for Skills.** New [Skills](../domain/ubiquitous-language.md) can extend the question vocabulary without breaking existing consumers; the contract is stable even as understanding grows richer ([Skill Architecture, #23](./README.md)).
- **Stable contract, evolving internals.** Future capabilities (conversational retrieval, semantic search, streaming updates, context subscriptions) can be added underneath without changing what consumers rely on.

---

## Related documents

- [Understanding Engine](./understanding-engine.md) (#25) — the subsystem this interface fronts
- [Prioritization Engine](./prioritization-engine.md) (#29) · [Timeline](./timeline.md) (#27) · [Memory](./memory.md) (#31)
- [ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md) — context is first-class, queried not re-retrieved
