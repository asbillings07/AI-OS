# Orion Domain Model

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issues: #17 Define the Orion Domain Model · #4 Design the Core Domain Model

If the [Vision](../vision/vision.md) explains *why* Orion exists, the [Ubiquitous Language](./ubiquitous-language.md) defines *the words*, and the [Mental Model](./mental-model.md) shows *how Orion thinks*, this document defines **the universe Orion understands** — the entities, their responsibilities, and how they relate.

This model is **implementation-agnostic**. It says nothing about databases, APIs, serialization, storage, or classes; those emerge *from* the model, they don't drive it (see [Out of scope](#out-of-scope)). Terms are defined once in the [Ubiquitous Language](./ubiquitous-language.md); here we focus on **responsibilities and relationships**.

---

## The three layers

Every entity lives in one of three layers, and Orion's whole job is moving *up* through them. Entities may relate across layers, but **responsibilities never move between them** — Reality doesn't make decisions, and Decision entities don't redefine Reality. Each layer has exactly one job.

```
  REALITY          "What happened?"      (Person, Organization, Project, Conversation,
     │                                     Source, Email, Calendar Event, GitHub Issue, Document)
     │  observed
     ▼
  UNDERSTANDING    "What does it mean?"   (Event, Observation, Context, Relationship,
     │                                     Signal, Insight, Timeline, Memory, Opportunity)
     │  reasoned
     ▼
  DECISION         "What should I do?"    (Work Item, Recommendation, Explanation, Decision,
                                           Goal, Task, Action, Rule, User Preference, Notification, Briefing)
```

Cross-cutting the layers is the **Platform** (Skill, Agent, Integration, Knowledge Source, Workspace, Mission Control) — the machinery that does the moving.

## The core relationship spine

The backbone that every other relationship hangs off — this is the [Decision Loop](./mental-model.md) as entities:

```
 Source ──emits──▶ Event ──updates──▶ Context ──reveals──▶ Signal ──raises──▶ Work Item
                                          ▲                                        │
                                          │                                 produces │
                     new Events ──────────┘                                        ▼
                          ▲                                             Recommendation (+ Explanation)
                          │                                                         │
                          └────────────── creates ── Decision ◀── informs ─────────┘
```

---

## Entities by layer

Each entity lists its **responsibility** (what it's accountable for) and its **key relationships**. Definitions live in the [glossary](./ubiquitous-language.md).

### Reality layer

- **Source** — *Responsibility:* be the origin of facts. *Relationships:* emits **Events**; connected via an **Integration**; may be a **Knowledge Source**.
- **Person** — *Responsibility:* represent an individual. *Relationships:* participates in **Conversations**; associated with **Organizations**/**Projects**; referenced by **Events** and **Work Items**.
- **Organization** — *Responsibility:* represent a group/company. *Relationships:* groups **People**; associated with **Projects**.
- **Project** — *Responsibility:* represent an ongoing effort. *Relationships:* attaches **Work Items**, **Tasks**, **Conversations**; serves **Goals**.
- **Conversation** — *Responsibility:* represent a threaded exchange. *Relationships:* between **People**; source of **Events**; may raise **Work Items**.
- **Source-native entities** (**Email**, **Calendar Event**, **GitHub Issue**, **Document**) — *Responsibility:* represent concrete artifacts from a Source. *Relationships:* normalized into **Events**; referenced by **Work Items**; never leak vendor shape past the **Integration**.

### Understanding layer

- **Event** — *Responsibility:* record an immutable fact ([ADR-0002](../adr/0002-everything-is-an-event.md)). *Relationships:* comes from a **Source**; updates **Context**; may generate **Signals**; contributes to **Work Items**; participates in the **Timeline**.
- **Observation** — *Responsibility:* record something *Orion itself* noticed. *Relationships:* is an **Event** whose Source is Orion; feeds **Context**.
- **Context** — *Responsibility:* maintain the evolving understanding of the user's situation ([ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md)). *Relationships:* derived from **Events**; composed of **Relationships**; reveals **Signals**; persisted by **Memory**; consumed by **Skills**/**Agents**.
- **Relationship** — *Responsibility:* connect two concepts (Context is a graph, not a bag). *Relationships:* links any entities (Email→Project, Flight→Meeting, Deadline→Work Item).
- **Signal** — *Responsibility:* mark a meaningful change/relationship worth attention. *Relationships:* detected within **Context**; raises **Work Items**; a forward-looking Signal is an **Opportunity**.
- **Insight** — *Responsibility:* capture higher-order synthesis over time. *Relationships:* drawn from **Context** and the **Timeline**; surfaced in a **Briefing**.
- **Timeline** — *Responsibility:* provide the temporal ordering of Events and Context. *Relationships:* orders **Events**; feeds **Insights** and historical reasoning.
- **Memory** — *Responsibility:* retain Context/knowledge so understanding compounds. *Relationships:* persists **Context**; fed by **Knowledge Sources**; informs **Recommendations**.
- **Opportunity** — *Responsibility:* flag a proactively-detected situation worth acting on ([#26](./README.md)). *Relationships:* a kind of **Signal**; raises a **Work Item**.

### Decision layer

- **Work Item** — *Responsibility:* be the single canonical unit of "this deserves attention," derived by Orion ([ADR-0003](../adr/0003-everything-important-becomes-a-work-item.md)). *Relationships:* raised by **Signals**; may reference a **Task**/**Conversation**/**Email**; belongs to a **Project**/**Goal**; produces **Recommendations**; surfaced in **Mission Control**.
- **Recommendation** — *Responsibility:* advise what to do about a Work Item. *Relationships:* produced from a **Work Item**; carries an **Explanation**; proposes **Actions**; informs a **Decision**.
- **Explanation** — *Responsibility:* justify a judgment in human terms. *Relationships:* connects a **Recommendation** back to its **Signals/Context/Events**.
- **Decision** — *Responsibility:* be the human's choice — the point of the system. *Relationships:* informed by **Recommendations**; creates new **Events** (closing the loop).
- **Goal** — *Responsibility:* represent a desired outcome. *Relationships:* organizes **Tasks** and **Work Items**; gives them their *why*.
- **Task** — *Responsibility:* represent a discrete unit of work with a completion state. *Relationships:* serves a **Goal**; may be the subject of a **Work Item**.
- **Action** — *Responsibility:* be a concrete operation (often side-effecting). *Relationships:* proposed by a **Recommendation**; **gated by Rules** ([ADR-0004](../adr/0004-ai-recommends-rules-decide.md)).
- **Rule** — *Responsibility:* deterministically decide/enforce and gate irreversible Actions. *Relationships:* governs **Actions**; honors **User Preferences**.
- **User Preference** — *Responsibility:* be an explicit, authoritative user constraint. *Relationships:* constrains **Rules** and **Notifications**.
- **Notification** — *Responsibility:* deliver a rare, earned escalation. *Relationships:* about a **Work Item**; constrained by **User Preferences** ([Product #6](../principles/product.md)).
- **Briefing** — *Responsibility:* summarize what matters for the user. *Relationships:* synthesizes **Work Items** and **Insights**; delivered via **Mission Control**.

### Platform (cross-cutting)

- **Skill** — *Responsibility:* a composable capability. *Relationships:* consumes **Context**, produces **Recommendations**/**Actions**; asks Context "what should I know?" not raw data.
- **Agent** — *Responsibility:* an AI-driven reasoner (advisory). *Relationships:* uses **Skills** + **Context**; bounded by [ADR-0004](../adr/0004-ai-recommends-rules-decide.md).
- **Integration** — *Responsibility:* the replaceable technical connection to a Source. *Relationships:* connects a **Source**; isolates vendor shape ([Eng #8](../principles/engineering.md)).
- **Knowledge Source** — *Responsibility:* provide reference knowledge. *Relationships:* a kind of **Source**; feeds **Memory**/**Context**.
- **Workspace** — *Responsibility:* bound one user's Sources, Context, and Memory. *Relationships:* contains everything above (single-user in v0.1).
- **Mission Control** — *Responsibility:* present decisions-with-reasons. *Relationships:* surfaces **Work Items**, **Briefings**, **Explanations**.

> **Core entities (#4).** Issue #4 asks for a minimal core: **Work Item, Event, Source, Action, Context, Notification, Rule, User Preference.** Those are exactly the load-bearing entities above; the rest of the model extends around them. This document satisfies both #17 (full model) and #4 (core).

---

## How the model answers the key questions

The modeling questions from #17, answered with the entities above:

- **How does an Event become Context?** Events are applied to Context as they arrive; Context is the accumulated projection of the Event stream, enriched with **Relationships**. (Detailed in [Event Lifecycle](./event-lifecycle.md), #5.)
- **How is Context accumulated over time?** Via **Memory** (persistence) and the **Timeline** (ordering). Context is never a snapshot — it's the running projection, always rebuildable from Events.
- **When does Context produce an Opportunity?** When a **Signal** is forward-looking (something worth acting on *before* the user asks), it is classified as an **Opportunity** ([#26](./README.md)).
- **How are Opportunities prioritized?** As **Work Items**, by the Prioritization Engine against the objective function — **Attention** ([ADR-0006](../adr/0006-attention-is-the-primary-resource.md), [#29](./README.md)).
- **How do Goals relate to Tasks?** A **Goal** is an outcome; **Tasks** are units of work serving it; a **Work Item** is whatever Orion surfaces for attention, which may point at either.
- **How do Skills consume and produce Events?** Skills consume **Context** (not raw events) and produce **Recommendations**/**Actions**; their effects and Orion's own **Observations** re-enter as **Events**.
- **How does Memory influence decision-making?** **Memory** supplies durable **Context** and **Insights** to **Recommendations**, so past understanding shapes present advice.
- **How does Mission Control surface the most relevant information?** It renders the highest-priority **Work Items** as decisions, each with its **Explanation**, plus a **Briefing** and a quiet long tail.

## Design rationale (major modeling decisions)

- **Events are the source of truth; everything else is a projection.** No mutable "state" entity ([ADR-0002](../adr/0002-everything-is-an-event.md), [Eng #5](../principles/engineering.md)).
- **Work Item is the single attention-level abstraction.** One canonical unit prevents every source/UI from inventing its own ([ADR-0003](../adr/0003-everything-important-becomes-a-work-item.md)).
- **Context is a graph, not a bag.** First-class **Relationships** make cross-source reasoning possible ([ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md)).
- **A hard advisory/deterministic seam.** **Recommendations/Agents** advise; **Rules** decide and gate **Actions** ([ADR-0004](../adr/0004-ai-recommends-rules-decide.md)).
- **Domain over integration.** **Source** (domain) is distinct from **Integration** (adapter) so vendors stay replaceable ([Eng #8](../principles/engineering.md)).

## Out of scope

This model deliberately does **not** define: database schema, API contracts, event serialization, storage technologies, UI implementation, or programming-language classes. Those are downstream and must conform to this model, not reshape it (a decision to adopt any of them would be its own [ADR](../adr/)).

## Related documents

- [Ubiquitous Language](./ubiquitous-language.md) (#16) — definitions
- [Mental Model / Decision Loop](./mental-model.md) — how the entities flow
- [Event Lifecycle](./event-lifecycle.md) (#5) — how an Event moves through the system
- [ADRs 0001–0006](../adr/) — the decisions this model rests on
