# Orion Ubiquitous Language

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issues: #16 Define Orion Ubiquitous Language · #17 Domain Model · #4 Core Domain Model

This is Orion's **canonical vocabulary**. Every concept below has exactly **one** definition, and that word means the same thing everywhere: documentation, ADRs, code, APIs, database schema, UI, AI prompts, and Skills. If a concept isn't here, it doesn't belong in the product (see [Domain README](./README.md)).

The language is deliberately **stable**. New features should *extend* this vocabulary, not invent synonyms. If the language churns, it means we're still learning what Orion is.

**How to read this glossary**

- Each term has a one-sentence **canonical definition** and its key **relationships**.
- Terms are grouped by role, starting with the [Decision Loop](./mental-model.md) spine.
- Where two terms are easy to confuse, a **Disambiguation** callout says exactly how they differ. Those callouts encode the trickiest modeling decisions — read them.

**Three layers.** The vocabulary naturally spans three layers, and Orion's whole job is moving *up* through them: **Reality** (People, Organizations, Projects, Emails…) → **Understanding** (Events, Context, Signals, Insights) → **Decision** (Work Items, Recommendations, Actions). This is the same arc as the [Decision Loop](./mental-model.md).

---

## 1. The Decision Loop (the spine)

These are the concepts of Orion's core [mental model](./mental-model.md): Reality → Events → Context → Signals → Work Items → Recommendations → Human Decision → new events.

- **Source** — an external system that facts originate from (Gmail, Calendar, GitHub, a bank, a travel provider, and Orion itself). *Source is a domain concept*; the technical connection to it is an **Integration/adapter**. → produces Events.
- **Event** — an immutable record that something happened, captured from a Source ([ADR-0002](../adr/0002-everything-is-an-event.md)). The atomic fact. → contributes to Context.
- **Context** — Orion's continuously-evolving understanding of the user's situation, derived from Events ([ADR-0005](../adr/0005-context-is-a-first-class-domain-object.md)). Where isolated facts become a coherent picture and where **Relationships** emerge. → yields Signals.
- **Signal** — a meaningful change or relationship detected within Context. Not everything matters; a Signal is what does. → may raise a Work Item.
- **Work Item** — something important enough to warrant the user's attention or action, derived by Orion ([ADR-0003](../adr/0003-everything-important-becomes-a-work-item.md)). The canonical unit of "this matters." → may produce a Recommendation.
- **Recommendation** — an advisory, always-explainable suggestion about what to do about a Work Item. Orion advises; it never decides for the user ([ADR-0004](../adr/0004-ai-recommends-rules-decide.md)). → carries an Explanation, → informs a Decision.
- **Explanation** — the human-readable justification that connects a Recommendation (or any judgment) back to the Signals, Context, and Events that produced it. Explainability is a *domain* concept, not merely a UI feature — every Recommendation carries an Explanation, and "why this?" is answered from it ([Product #4](../principles/product.md), the moat in the Vision).
- **Decision** — the choice the human makes. The point of the whole system; everything exists to improve it. → creates new Events, closing the loop.
- **Attention** — the scarce *human* resource Orion exists to protect ([ADR-0006](../adr/0006-attention-is-the-primary-resource.md)). It belongs to the user, not the system. The objective function, not an entity.
- **Relationship** — a first-class connection *between* concepts (an Email *belongs to* a Project; a Flight *conflicts with* a Calendar Event; a Deadline *affects* a Work Item). Context is largely built from Relationships.

---

## 2. Understanding, knowledge & time

How Orion perceives, remembers, and reasons across time.

- **Observation** — a specific thing Orion itself notices, emitted as an Event whose Source is Orion (e.g., "no reply to Dana in 2 days"). Observations are how AI-generated noticing enters the event stream.
- **Insight** — a higher-order, synthesized understanding drawn from Context over time (a pattern, trend, or conclusion), more durable and strategic than a single Signal.
- **Timeline** — the ordered, temporal view of Events and Context — Orion's history laid out in time ([#27](./README.md)).
- **Memory** — retained Context and knowledge that persists and stays queryable over time, so understanding compounds ([#31](./README.md)).
- **Subject** — the persistent *thing* an Opportunity is about: a conversation, a change under review, an assigned unit of work, a failing check. Source-neutral by design ([Eng #8](../principles/engineering.md)) and identified by a `SubjectRef` (`kind` + `id`). Distinct from an *occurrence* (one Event): many occurrences over time contribute to one Subject. It is the key everything groups and suppresses on.
- **Opportunity** — a proactively detected situation worth acting on before the user asks ([#26](./README.md)). A forward-looking kind of Signal. Answers *"is there value in acting?"* Carries its own presentation (title, location, url) so the Decision layer never reaches back into Context.
- **Attention Disposition** — the user's recorded relationship to Orion's *presentation* of a Subject: handled, snoozed, or dismissed. It is what the **Attention** projection folds from user Action Events ([ADR-0012](../adr/0012-attention-is-a-projection-distinct-from-context.md)). Deliberately distinct from Context: Context is *reality*, a Disposition is *what the user did about it*. An Action is scoped to the exact revision the user saw, so a genuinely new occurrence resurfaces the item while a late-arriving older fact does not.
- **Capacity** — Orion's current estimate of how effectively the user can make progress *right now* ([#10](./README.md)). Answers *"can the user act well right now?"* Belongs to **Understanding** (Orion infers it, it is not stated). v0.1 derives it deterministically from time of day and *visible attention demand* (how many Work Items Orion is currently asking the user to consider); richer *evidence* — focus depth, interruption risk, device, connectivity — is deferred (Eng #9). Capacity is the estimate, not the evidence.
- **Briefing** — a synthesized summary delivered to the user (e.g., the morning briefing in Mission Control) — the readable output of Context, Signals, and Work Items.

> **Disambiguation — Observation vs Signal vs Insight.**
> An **Observation** is a *noticing* (Orion saw a specific thing, recorded as an Event). A **Signal** is *significance* (a change/relationship in Context that may deserve attention). An **Insight** is *synthesis* (a higher-level understanding across many things over time). Rough flow: Observations & Events → Context → Signals → Insights.

> **Disambiguation — Opportunity vs Capacity.**
> **Opportunity** is about *the world* — is there value in acting? **Capacity** is about *the user* — can they act well right now? They are independent: a high-Opportunity item can still be low priority when Capacity is low. Renewing a passport has real value (high Opportunity), but not in the 15 minutes before a meeting (low Capacity). Prioritization weighs both, alongside Commitment and Urgency ([#29](./README.md)).

---

## 3. Work, intent & control

What the user wants, what needs doing, and how Orion is kept safe.

- **Goal** — a desired outcome the user cares about, usually longer-horizon. Gives Work Items and Tasks their *why*.
- **Task** — a discrete unit of work with a completion state. A Task can be the subject of a Work Item.
- **Action** — a concrete operation Orion can recommend or (later) perform, especially one with side effects. Every side-effecting Action passes through deterministic **Rules** ([ADR-0004](../adr/0004-ai-recommends-rules-decide.md)).
- **Rule** — deterministic, auditable logic that decides or enforces. Rules — not AI — provide guarantees and gate irreversible Actions.
- **User Preference** — an explicit, user-stated configuration or constraint that Rules honor (e.g., "never notify me after 8pm"). Explicit and authoritative, unlike inferred Context.
- **Notification** — a rare, earned outbound alert about a genuine escalation. Never engagement-driven ([Product #6](../principles/product.md)).

> **Disambiguation — Work Item vs Task vs Action vs Goal.**
> A **Goal** is an *outcome* ("close the Acme deal"). A **Task** is a *unit of work* toward it ("send the contract"). A **Work Item** is *whatever Orion surfaces for attention* — it may point at a Task, an Email needing a reply, or a Decision; it is the attention-level abstraction, derived by Orion (not user-groomed, per [ADR-0001](../adr/0001-situational-awareness-not-task-manager.md)). An **Action** is the *operation* taken, gated by Rules.

---

## 4. Platform

The machinery that runs the loop.

- **Mission Control** — the primary surface where Orion presents Work Items as decisions-with-reasons ([experience](../scenarios/mission-control-experience.md)). The product's face.
- **Skill** — a composable capability that consumes Context and produces Recommendations or Actions. Skills are small and combined (composition over intelligence, [Eng #6](../principles/engineering.md)); they ask Context "what should I know?" rather than fetching raw data.
- **Agent** — an AI-driven actor that uses Skills and Context to reason. Advisory by construction ([ADR-0004](../adr/0004-ai-recommends-rules-decide.md)).
- **Integration** — the configured technical connection to a Source, implemented via a replaceable adapter ([Eng #8](../principles/engineering.md)). *Integration/adapter is technical; Source is domain.*
- **Knowledge Source** — a Source of reference material (documents, notes, wikis) as opposed to a stream of happenings. Feeds Memory and Context.
- **Workspace** — the bounded environment containing a user's Sources, Context, and Memory. (Single-user in v0.1; the seam that later allows more.)

> **Disambiguation — Source vs Integration vs Knowledge Source.**
> A **Source** is *where facts come from* (domain). An **Integration** is *the technical connection* to a Source (adapter, replaceable). A **Knowledge Source** is a Source of *reference knowledge* rather than events.

---

## 5. People & the outside world

The real-world entities that Events and Context are *about*. These are typically projected from Sources and referenced by Relationships.

- **Person** — an individual Orion knows about (the user, or someone they interact with).
- **Organization** — a company or group a Person or Project is associated with.
- **Project** — an ongoing effort that Work Items, Tasks, and Conversations attach to.
- **Conversation** — a threaded exchange (e.g., an email thread) between People.
- **Source-native entities** — concrete artifacts from Sources: **Email**, **Calendar Event**, **GitHub Issue**, **Document**. These are normalized into Events and referenced by Work Items; they never leak vendor shape past the adapter ([Eng #8](../principles/engineering.md)).

---

## Words we intentionally do not use

Negative vocabulary teaches newcomers what *not* to say. These words are avoided on purpose — using them is usually a sign a design has drifted from the philosophy:

- **Inbox / Feed** — Mission Control surfaces *decisions*, not collections to scroll through ([Product #2](../principles/product.md)).
- **Todo / Task List** — Orion *derives* work; it never requires manual grooming ([ADR-0001](../adr/0001-situational-awareness-not-task-manager.md)). ("Task" exists as a concept; a *task list as the product model* does not.)
- **Ticket / Queue** — implies a tracking system to be worked down; we reason about Work Items, not tickets.
- **Alert / Notification feed** — Notifications are rare and earned, never a stream ([Product #6](../principles/product.md)).
- **Assistant / Copilot** — Orion is a situational-awareness system, not a chatbot persona (Vision non-goals, [ADR-0001](../adr/0001-situational-awareness-not-task-manager.md)).
- **Smart / AI magic** — explainability over magic; if we can't explain it, we don't ship it ([Eng #3](../principles/engineering.md)).
- **State** — a *deliberate* omission. Orion avoids mutable "state" as a core abstraction: the source of truth is Events, and everything else (Context, Timeline, Work Items) is a rebuildable **projection** ([ADR-0002](../adr/0002-everything-is-an-event.md), [Eng #5](../principles/engineering.md)). When you catch yourself modeling "state," you probably mean events + a projection.

## Guidelines for introducing new terminology

1. **Reuse before inventing.** If an existing term nearly fits, use it. A new word must earn its place by naming a genuinely distinct concept.
2. **One canonical definition.** New terms get a single definition here, plus their relationships — before they appear in code or UI.
3. **Add a disambiguation** if the new term is close to an existing one, stating exactly how they differ.
4. **Deliberate and reviewed.** Vocabulary changes are reviewed like architecture; renaming a core concept is a significant, cross-cutting change.
5. **Reflect everywhere.** A term added or changed here must be propagated to code, schema, APIs, and prompts. Divergence is a bug.

## Relationship to other documents

- The **[mental model](./mental-model.md)** shows how the spine concepts flow (the Decision Loop).
- The **domain model** (#17/#4) defines each entity's responsibilities and full relationships/diagrams.
- **ADRs** ([0001–0006](../adr/)) fix the decisions behind several of these concepts.
