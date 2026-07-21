# Opportunity Detection

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issues: #26 Design Opportunity Detection · #25 Understanding Engine · #29 Prioritization Engine

**Opportunity Detection** is where understanding becomes actionable. It watches Context for the moment a collection of facts becomes *something the user should actually care about*, and names it an [Opportunity](../domain/domain-model.md).

An Opportunity answers exactly one question:

> **Is there value in acting?**

That is all. It is a statement about the world, not about the user's moment and not about rank.

---

## Opportunity is not Prioritization

This is the most important boundary in this document. Detecting that something is worth doing is a completely separate operation from deciding whether to do it *now*. An Opportunity carries no timing verdict.

```
  Renew passport        Opportunity: high     Capacity: low      →  Priority: low (for now)
  Reply to manager      Opportunity: medium   Capacity: high     →  Priority: high
```

High Opportunity can be low priority, and vice versa. Opportunity Detection produces the "is there value?" input; the [Prioritization Engine](./prioritization-engine.md) combines it with [Capacity](./capacity.md), Commitment, and Urgency to decide what rises to the top. Conflating the two is how a system ends up recommending deep work in an airport line.

> **Events describe what happened. Context explains what it means. Opportunities suggest what to do next.**

---

## Types of opportunity

Not every opportunity is a task. Orion recognizes four kinds:

- **Action** — the user should *do* something (reply to an important email, prepare for a meeting, review a stalled PR).
- **Awareness** — the user should *know* something (a market move, a travel disruption, a legal deadline).
- **Optimization** — the user *could improve* something (batch similar work, consolidate meetings, reduce context switching).
- **Risk** — something *may need intervention* (a missed deadline, an overloaded calendar, a forgotten follow-up, a failing integration).

Framing awareness and risk as opportunities — not just tasks — is what lets Orion protect attention rather than merely generate to-dos.

---

## Responsibilities

Opportunity Detection is responsible for:

- **Consuming Context** (not raw events) and detecting meaningful patterns within it.
- **Identifying** risks and opportunities across the four types above.
- **Explaining** why each opportunity exists — every Opportunity carries an [Explanation](../domain/ubiquitous-language.md) tracing back to the Signals, Context, and Events behind it ([Product #4](../principles/product.md)).
- **Scoring confidence** — how sure Orion is that this is real.
- **Re-evaluating continuously** as Context changes (an opportunity can strengthen, weaken, or dissolve).

It is **not** responsible for: ranking opportunities against each other (that is Prioritization), executing anything, deciding on the user's behalf, maintaining long-term state, or presenting UI.

---

## Lifecycle

```
  Context updated
        │
        ▼
  Pattern detected ──▶ Opportunity created (typed, scored, explained)
        │                        │
        │                        ▼
        │                 handed to Prioritization
        │
        └── context changes ──▶ Opportunity updated / merged / split / resolved
```

Opportunities are derived from [Context](./context-lifecycle.md), so they share its impermanence: when the underlying situation resolves, the opportunity resolves with it. Duplicate detections of the same underlying situation should **merge**; a broad situation may **split** into distinct opportunities.

---

## An Opportunity as a Signal

In the domain model, an Opportunity is a **forward-looking [Signal](../domain/domain-model.md)** — a significance in Context that points at something worth doing before the user asks. It may raise a [Work Item](../domain/domain-model.md), which is the canonical unit Mission Control surfaces ([ADR-0003](../adr/0003-everything-important-becomes-a-work-item.md)). Opportunity Detection is the machinery that produces these forward-looking Signals.

---

## Boundaries

Opportunity Detection reads from the [Understanding Engine](./understanding-engine.md) and writes into the [Prioritization Engine](./prioritization-engine.md). It never reaches around Context to raw sources, and it never ranks or acts — it only says, with a reason and a confidence, "there is value here."

---

## v0.1 implementation notes (#44/#45)

The first two Sources (Gmail, GitHub) exercise the model concretely. These notes record the decisions the code makes so they can be reviewed like architecture.

### Subject: what an Opportunity is about

An Opportunity is about a **Subject** — a source-neutral reference to the *persistent thing* Orion may act on, distinct from the *occurrence* Events that reveal it. Subject identity is deliberately stable across occurrences:

- `thread` -> conversation id
- `review` -> the change under review
- `assignment` -> the assigned unit of work
- `check` -> the pair of change and check name (two independent checks on one change stay distinct; retries of one check stay one subject)

Signals and Opportunities carry a `SubjectRef`, not a source-specific id, so the model does not bend around Gmail or GitHub.

### Opportunity kinds are interpretations, not facts

Kinds name the actionable interpretation and never shadow an `EventTypes` fact:

- `ReplyNeeded` (subject: thread) — from a `MessageReceived` fact. Type: Action.
- `ReviewNeeded` (subject: review) — from a `ReviewRequested` fact. Type: Action.
- `AssignedActionNeeded` (subject: assignment) — from an `AssignmentReceived` fact. Type: Action.
- `RiskDetected` (subject: check) — from a `CheckFailed` fact. Type: Risk.

The model is a discriminated union, so `kind` and `subject.kind` are locked together in the type system.

### Commitment is an explicit obligation

Where a Source states obligation directly (a review requested *from you*, an item assigned *to you*), detection emits a first-class `Commitment` Signal. This is distinct from a relationship-derived expectation (a message from someone you often correspond with). Prioritization currently combines both into one factor (see the [Prioritization Engine](./prioritization-engine.md)); a failed check is a **Risk**, not a Commitment.

### Lifecycle limitation: derived work is currently monotonic

The vocabulary records obligation *appearing* (review requested, assignment received, check failed) but not yet *disappearing* (withdrawn, reassigned, later-succeeded). So review/assignment/check Context is **monotonic** in v0.1: once a subject is present, no source fact clears it. A future user action (#46) controls **presentation** and must **not** be read as evidence the external condition resolved. A live Source will need resolution facts (e.g. `ReviewRequestWithdrawn`, `AssignmentRemoved`, `CheckSucceeded`) or a general state-transition strategy.

### Cross-source correlation is not yet solved

The fixtures include an automated Gmail notification and a GitHub `ReviewRequested` that describe the **same external occurrence through two Sources** — an event-level correlation *candidate*, not yet proof of de-duplication (today only the GitHub side becomes an Opportunity; the automated email is silent). #46 must choose a policy: correlate the facts before detection, allow both candidate Opportunities and then collapse them, or define automated-email suppression as the correlation rule.

### The decision layer is type-gated to threads until #46

In #45 GitHub Opportunities are detected and proven, but the Prioritization Engine and Mission Control accept only thread Opportunities (enforced in the type system, not just by convention). Composing both Sources into one ranked, presented, actionable view is #46.

---

## Related documents

- [Understanding Engine](./understanding-engine.md) (#25) · [Capacity](./capacity.md) (#10) · [Prioritization Engine](./prioritization-engine.md) (#29)
- [Domain Model](../domain/domain-model.md) — Opportunity as a forward-looking Signal
- [ADR-0003](../adr/0003-everything-important-becomes-a-work-item.md) · [ADR-0006](../adr/0006-attention-is-the-primary-resource.md)
