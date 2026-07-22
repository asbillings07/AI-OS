# The Prioritization Engine

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issues: #29 Design the Prioritization Engine · #26 Opportunity Detection · #10 Capacity · #25 Understanding Engine

The **Prioritization Engine** is Orion's executive function. If the [Understanding Engine](./understanding-engine.md) is the brain, this is the part that turns awareness into focus. It answers the question the whole product exists to answer:

> **Given everything happening in my world, what should I focus on next?**

People are overwhelmed by information, not starved of it. Most tools surface everything equally — email, calendar, notifications, news — and leave the ranking to the human. The Prioritization Engine does that ranking, consistently and transparently, so Mission Control can present a deliberately small, ordered set of decisions rather than another inbox.

Its objective function is fixed: it exists to allocate the user's **Attention** well ([ADR-0006](../adr/0006-attention-is-the-primary-resource.md)), never to maximize output or engagement.

---

## Five reasoning inputs, not one formula

Prioritization weighs four **independent, intrinsic** dimensions plus one **learned** one. They are deliberately kept separate because they answer genuinely different questions, and collapsing them hides reasoning the user needs to trust:

| Dimension | Question | Source |
| --- | --- | --- |
| **Opportunity** | Is there value in acting? | [Opportunity Detection](./opportunity-detection.md) (#26) |
| **Capacity** | Can the user act well right now? | [Capacity](./capacity.md) (#10) |
| **Commitment** | Has the user committed to this? | Goals, promises, intent, [User Preferences](../domain/ubiquitous-language.md) |
| **Urgency** | How time-sensitive is it? | Deadlines, expiry, calendar pressure |
| **Personal Importance** | Does the user tend to act on work from whoever this is from? | Learned from recorded [Attention Dispositions](../domain/ubiquitous-language.md) ([ADR-0014](../adr/0014-personal-importance-from-dispositions.md), #65) |

**Commitment and Urgency are not the same thing.** A promise you made to a colleague is a strong commitment with no deadline; a flash sale is highly urgent with no commitment. Treating them as one variable would let genuine urgency masquerade as importance, or let quiet commitments get buried. They may *eventually* be combined in an implementation, but the model keeps them distinct so the reasoning stays legible.

**Personal Importance is different in kind from the other four.** Opportunity, Capacity, Commitment, and Urgency are all derived from the current moment's facts. Personal Importance is *learned* — a bounded behavioral signal folded from the user's own past decisions (acted on vs. dismissed), keyed to a source-neutral originator, never an authoritative belief about the person and never a substitute for an explicit [User Preference](../domain/ubiquitous-language.md). It stays neutral (contributes nothing) until there is enough decisive history to move it, so a Subject Orion has never seen anyone act on ranks exactly as it would today.

> **This is not arithmetic.** `priority = opportunity × capacity × commitment × urgency` is explicitly *not* the model. These are reasoning inputs, and how they are weighed and resolved is left open for implementation and learning. Presenting prioritization as a fixed product would overclaim precision Orion does not have.

> **v0.1 note — the Commitment input is currently a blend.** In code the Commitment factor takes the stronger of an explicit obligation (a `Commitment` Signal, e.g. an assignment or a review requested from you) and a relationship-derived expectation (a `FromKnownPerson` Signal). These are not conceptually identical — one is a duty, the other is social weight — so the computation names the combined value honestly (`responsibilityStrength`) rather than pretending they are the same. They may split into separate dimensions later.

> **v0.1 note — Personal Importance is a bounded adjustment, not a fifth vote of equal weight.** It moves `priority` by at most a small, symmetric amount around neutral (see [ADR-0014](../adr/0014-personal-importance-from-dispositions.md) for the exact v1 curve and weight). Personal Importance can decide close calls between intrinsic scores, but its bounded adjustment prevents it from overcoming sufficiently large intrinsic differences. On an exact final-priority tie, Urgency, Commitment, and Opportunity remain earlier tie-breakers.

```
  Opportunity          ┐
  Capacity             │
  Commitment           ├──▶  Prioritization  ──▶  ranked Work Items  ──▶  Mission Control
  Urgency              │      (weigh · resolve · explain)
  Personal Importance  ┘
```

---

## Responsibilities

The Prioritization Engine is responsible for:

- **Consuming Opportunities of every kind** and evaluating them against Capacity, Commitment, and Urgency. As of #46 the ranker is **source-neutral**: it consumes any Opportunity — a conversation, a review, an assignment, a failing check — through one vocabulary. A Work Item is about a source-neutral `Subject`, never a `threadId`, and each Opportunity carries its own presentation (title, location, url) so ranking never reaches back into Context. Ties are broken deterministically by `subjectKey`, so the order detectors happen to run in can never bias the result.
- **Producing a ranked set of [Work Items](../domain/domain-model.md)** — the canonical attention-level unit ([ADR-0003](../adr/0003-everything-important-becomes-a-work-item.md)).
- **Explaining every ranking** — each item carries an [Explanation](../domain/ubiquitous-language.md) of *why it is where it is* ([Product #4](../principles/product.md)). "Why is this first?" must always be answerable, in source-neutral language.
- **Re-ranking continuously** as Context, Attention, Capacity, and new Opportunities change.
- **Producing silence when appropriate** — an empty or short list is a valid, valuable output, not a failure ([ADR-0006](../adr/0006-attention-is-the-primary-resource.md)).

It is **not** responsible for: detecting opportunities, estimating capacity, deciding *visibility*, executing tasks, deciding on the user's behalf, or presenting UI. It ranks; the user decides.

### Reality in, presentation out: the visibility stage

Prioritization operates on Opportunities derived purely from **reality** (Context). Whether the user has already *handled, snoozed, or dismissed* a situation is a fact about **presentation**, not reality, and is modeled separately as the **Attention** projection ([ADR-0012](../adr/0012-attention-is-a-projection-distinct-from-context.md)). A single `isVisible(opportunity, attention, now)` function — the sole suppression authority — filters reality-derived Opportunities before ranking. Actions are scoped to the exact revision the user saw (`attentionBasisEventIds`, defined by the newest occurrence by domain time for *every* Subject kind, conversations included), so a genuinely new occurrence resurfaces an item while a late-arriving older fact stays quiet. A rendered `attentionRevision` token lets the server reject an action taken against a stale card (optimistic concurrency) rather than suppress something the user never saw.

---

## Urgency versus importance

A recurring failure mode of productivity tools is equating *urgent* with *important*. The Prioritization Engine keeps them separate: Urgency is one of the four intrinsic inputs. A low-urgency, high-commitment goal (long-term, easy to neglect) must be able to out-rank a high-urgency, low-value interruption. This is precisely why the four intrinsic inputs are modeled independently.

---

## Example

```
  New email from manager
        │
        ▼
  Opportunity detected (Action, high value, explained)
        │
        ▼
  Prioritization: Opportunity high · Capacity high (between meetings) ·
                  Commitment high (manager) · Urgency medium
        │
        ▼
  Ranked near top of Mission Control, with its Explanation
```

Contrast the passport from [Opportunity Detection](./opportunity-detection.md): high Opportunity, but low Capacity in this moment, so it ranks low *for now* and resurfaces when a fitting window appears.

---

## Boundaries and future

- The engine consumes understanding through the [Context Query API](./context-query-api.md) and feeds ranked Work Items to Mission Control and future Skills/Agents (advisory only — [ADR-0004](../adr/0004-ai-recommends-rules-decide.md)).
- Personal Importance ([ADR-0014](../adr/0014-personal-importance-from-dispositions.md), #65) is the first adaptive-weighting input to land; it is a narrow behavioral signal, not the general "learned preferences" the product vision describes — that remains open for future evolution.
- Future evolution (richer feedback loops, additional learned dimensions) must not change the public contract: *ranked, explainable Work Items in, attention protected*. How things are weighed can learn; *that* rankings are explainable cannot.

---

## Related documents

- [Understanding Engine](./understanding-engine.md) (#25) · [Opportunity Detection](./opportunity-detection.md) (#26) · [Capacity](./capacity.md) (#10)
- [Mission Control Experience](../scenarios/mission-control-experience.md) — what a ranked, explained list feels like
- [ADR-0006](../adr/0006-attention-is-the-primary-resource.md) — attention as objective · [ADR-0003](../adr/0003-everything-important-becomes-a-work-item.md) — Work Item as the unit
