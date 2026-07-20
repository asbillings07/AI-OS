# Event Lifecycle

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issues: #5 Event Lifecycle · [ADR-0002](../adr/0002-everything-is-an-event.md)

This document traces how a fact moves through Orion — from the moment it's detected to the moment it's archived. Because [everything is an Event](../adr/0002-everything-is-an-event.md) and Events are the source of truth, this lifecycle underpins almost every feature.

---

## The key distinction: two lifecycles, one pipeline

Issue #5 sketches a single chain — *Detected → Normalized → Enriched → Classified → Prioritized → Scheduled → Completed → Archived*. Modeling it carefully reveals that this chain actually spans **two different things**, and separating them is important:

1. **The Event** is an *immutable fact*. It is detected, normalized, and enriched at ingestion, then persisted — and never changes. An Event is never "completed"; facts don't get done.
2. **The Work Item** is the *unit of attention* an Event (via Signals) may raise. It is what gets classified, prioritized, scheduled, acted on, and resolved.

This matches our "[no State](./ubiquitous-language.md)" stance: the Event is truth; the Work Item's changing status is a **projection** rebuildable from Events, not mutable state living on the Event.

```
   ── EVENT (immutable fact) ──►│──── WORK ITEM (attention, a projection) ────►
 Detected → Normalized → Enriched → Persisted        Raised/Classified → Prioritized
                                       │                     ↑          → Surfaced
                                       └── updates Context ──┘          → Scheduled/Deferred
                                                                        → Acted → Resolved
                                                                        → Retired/Archived
```

## Stage-by-stage: the Event

An Event's life is short and then permanent:

1. **Detected** — a Source produces something (an email arrives, a commit lands), or Orion itself notices something (an **Observation**). Raw, vendor-shaped, via an **Integration**.
2. **Normalized** — the raw input is mapped into Orion's canonical Event shape, stripping vendor specifics at the adapter boundary ([Eng #8](../principles/engineering.md)). No vendor types travel further.
3. **Enriched** — the Event is linked to known entities and **Relationships** (this Email belongs to this Project/Conversation/Person). Enrichment may *emit new derived Events/Observations*; it does not mutate the original.
4. **Persisted (immutable)** — the Event is committed to the append-only log. From here it never changes. It **updates Context** and may generate **Signals**.
5. **Archived** — with age, an Event moves to colder storage. It is **never deleted** as a routine operation (privacy-driven deletion is the deliberate exception, [Eng #13](../principles/engineering.md)); history is preserved so understanding keeps compounding.

## Stage-by-stage: the Work Item

When a Signal from an Event crosses the threshold of mattering, a Work Item is raised and moves through *its* lifecycle:

1. **Raised / Classified** — a **Signal** (or **Opportunity**) elevates something into a **Work Item** ([ADR-0003](../adr/0003-everything-important-becomes-a-work-item.md)); it's categorized by what it is and what it asks of the user.
2. **Prioritized** — ranked against the objective function, **Attention** ([ADR-0006](../adr/0006-attention-is-the-primary-resource.md), [#29](./README.md)). Most things rank *down*.
3. **Surfaced** — high-priority Work Items appear in **Mission Control** as decisions-with-reasons, each carrying an **Explanation**; the rest stay in the quiet long tail.
4. **Scheduled / Deferred** — timing is resolved: act now, or "can safely wait" until its moment.
5. **Acted upon** — the user makes a **Decision** (advisory model, [ADR-0004](../adr/0004-ai-recommends-rules-decide.md)); any resulting **Action** passes through **Rules**.
6. **Resolved / Completed** — the Work Item no longer needs the user. Orion retires it gracefully (see recovery/retirement in the [experience](../scenarios/mission-control-experience.md)).
7. **Retired / Archived** — it leaves the active surface. The Decision and its aftermath become **new Events**, closing the loop.

**Corrections feed back.** If the user dismisses or reprioritizes a Work Item, that correction is itself an Event that reshapes Context and future prioritization — recovery is part of the lifecycle, not an exception.

## How #5's stages map

| #5 stage | Belongs to | Notes |
|---|---|---|
| Detected | Event | raw from a Source (or an Observation) |
| Normalized | Event | mapped to canonical shape at the adapter |
| Enriched | Event | linked to entities/Relationships; may emit derived Events |
| Classified | Work Item | a Signal raises and categorizes it |
| Prioritized | Work Item | ranked against Attention |
| Scheduled | Work Item | now vs. can-wait |
| Completed | Work Item | Events are never "completed" — Work Items are |
| Archived | both | Events archived (never deleted); Work Items retired |

## Immutability & replay

Because the Event log is append-only, **every downstream stage is a projection** — Context, the Timeline, prioritized Work Items, and Briefings can all be *rebuilt* by replaying Events. This is what lets Orion improve retroactively (a better prioritizer can re-derive better Work Items from old Events) and always explain a past decision ([ADR-0002](../adr/0002-everything-is-an-event.md), [Eng #5](../principles/engineering.md), [Eng #11](../principles/engineering.md)).

## Why this influences almost every feature

- **Ingestion** (e.g., the v0.1 Gmail adapter, [MVP](../roadmap/mvp.md)) implements Detected → Normalized → Enriched.
- **The Understanding Engine** (#25) consumes persisted Events and maintains Context/Signals.
- **Prioritization** (#29) and **Mission Control** operate on the Work Item lifecycle.
- **Explainability** depends on the immutable trail of Events behind each Work Item.

## Related documents

- [Mental Model / Decision Loop](./mental-model.md) — the conceptual loop this lifecycle implements
- [Domain Model](./domain-model.md) (#17/#4) — the entities referenced here
- [Ubiquitous Language](./ubiquitous-language.md) (#16) — definitions
- [ADR-0002 Everything is an Event](../adr/0002-everything-is-an-event.md)
