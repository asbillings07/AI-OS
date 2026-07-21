# Capacity

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issues: #10 Situational Awareness & Opportunity Modeling · #29 Prioritization Engine · #25 Understanding Engine

> **Capacity is Orion's current estimate of how effectively the user can make progress right now.**

That sentence is the concept. Everything else in this document is *evidence for* it or *consequence of* it. Capacity is deliberately defined as an estimate about the **user**, not a list of environmental signals — the signals are how Orion arrives at the estimate, not the estimate itself.

Capacity exists because the right work depends on more than the work. An architecture review is an excellent use of a quiet morning at home and a terrible use of ten minutes in an airport boarding line. The task did not change; the user's capacity did.

---

## The two questions

Capacity is the missing counterpart to [Opportunity](./opportunity-detection.md). They answer different questions and must not be collapsed:

| Concept | Question | About |
| --- | --- | --- |
| **Opportunity** | Is there value in acting? | the world |
| **Capacity** | Can the user act well right now? | the user |

```
  Opportunity:  Renew passport.          (high value)
  Capacity:     15 minutes before a call. (low)
  → Prioritization: not now — surface something that fits this moment.
```

Keeping them separate gives the [Prioritization Engine](./prioritization-engine.md) clean, independent inputs instead of one overloaded score.

---

## Why Capacity belongs to Understanding

Capacity is not part of Reality — the user never states it. Orion **infers** it from Context. That places it firmly in the Understanding layer of the [Mental Model](../domain/mental-model.md), alongside Context, Signal, Insight, and Opportunity, and it is subject to the same [Context Lifecycle](./context-lifecycle.md): it is continuously re-estimated as events arrive, and it is always an interpretation carrying confidence, never a hard fact.

Because it is inferred, Capacity is offered as *understanding for the Decision layer to use*, never as a decision itself. Deterministic [Rules](../domain/ubiquitous-language.md) still gate anything with real consequences ([ADR-0004](../adr/0004-ai-recommends-rules-decide.md)).

---

## Evidence

Capacity is estimated from observable signals. The estimate is what matters; these are merely how Orion gets there.

### Initial signals (v0.x)

Cheap, already available from connected sources:

- **Available time** — the gap until the next commitment on the calendar.
- **Time of day** — and its fit with known routines.
- **Device** — is the user on something suited to the work (a phone is fine for approvals, poor for architecture)?
- **Connectivity** — is the network adequate for the task?
- **Location / setting** — office, home, or travel, where inferable.

### Future signals

Richer, added as evidence and trust grow — the estimate improves without the concept changing:

- **Energy** and focus depth over the course of a day.
- **Interruption risk** for the current window.
- **Habits and historical patterns** — when this user actually does deep work well.
- **Focus mode** and current attention state.

The concept is stable across all of these: adding a signal sharpens the estimate; it does not redefine Capacity.

> **v0.1 note — load is measured as visible attention demand.** In code the "current load" signal counts the number of Work Items Orion is *currently asking the user to consider* (`activeWorkCount`), not everything unresolved in the outside world. A dismissed or snoozed item stops weighing on Capacity while it is hidden and re-enters load when it resurfaces ([ADR-0012](../adr/0012-attention-is-a-projection-distinct-from-context.md)). This is deliberately source-neutral: Capacity does not know whether the work happens to be an email thread, a review, or a failing check.

---

## How Capacity shapes recommendations

Capacity lets Mission Control reason about *fit*, producing advice like:

- "You have 20 minutes before your next meeting — knock out these two approvals."
- "You're working from home this morning; this is the right window for the architecture review."
- "You're traveling — save deep work for tomorrow and clear these lightweight items instead."

The mechanism that turns Capacity + Opportunity (+ Commitment + Urgency) into a ranked list lives in the [Prioritization Engine](./prioritization-engine.md); Capacity's job is only to supply an honest estimate of the moment.

---

## Boundaries

Capacity does **not**: schedule, execute, decide, or present UI. It is an inferred understanding-layer estimate, queried like any other understanding through the [Context Query API](./context-query-api.md). Its accuracy is expected to be imperfect and to improve over time; it is always advisory.

---

## Related documents

- [Understanding Engine](./understanding-engine.md) (#25) · [Opportunity Detection](./opportunity-detection.md) (#26) · [Prioritization Engine](./prioritization-engine.md) (#29)
- [Ubiquitous Language](../domain/ubiquitous-language.md) — Capacity, Opportunity (and their disambiguation)
- [ADR-0006](../adr/0006-attention-is-the-primary-resource.md) — attention as the objective · [ADR-0004](../adr/0004-ai-recommends-rules-decide.md) — advisory vs. deterministic
