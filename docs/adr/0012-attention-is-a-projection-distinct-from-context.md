# ADR-0012: Attention is a Projection, Distinct from Context

> Status: Accepted
> Date: 2026-07-21 · Deciders: @asbillings07
> Related: #46 (Cross-source Prioritization), [ADR-0005](0005-context-is-a-first-class-domain-object.md), [ADR-0006](0006-attention-is-the-primary-resource.md), [ADR-0009](0009-storage-strategy.md)

## Context

Through the first vertical slice, "has the user dealt with this?" was recorded on the Context projection: a `WorkItemActedOn`/`Snoozed`/`Dismissed` event flipped a `status` field on the conversation's `ThreadContext`, and Signal detection skipped any thread that wasn't `open`. That worked because everything was a conversation.

Cross-source prioritization (#46) breaks that assumption. A Work Item can now be about a review, an assignment, or a failing check — none of which is a thread. Two problems surface at once:

1. **Suppression was thread-shaped.** The "handled/snoozed/dismissed" logic keyed on `threadId` and lived inside the thread-only understanding path. There was nowhere to record "the user handled this review."
2. **Reality and the user's response to it were entangled.** Context is supposed to be *reality* — what is true in the world, derived purely from source facts (ADR-0005). Whether the user has chosen to dismiss something is not a fact about the world; it is a fact about the *presentation*. Mixing the two meant Signal detection depended on the user's UI decisions, and a dismissal mutated the same projection that held ground truth.

There is also a subtler correctness issue. "Dismiss this" should mean "dismiss *what I am looking at*." If a genuinely new occurrence arrives later (a new reply, a re-requested review), the item should come back; but a late-arriving *older* fact — which grows provenance without changing what the user saw — should not. Thread `status` had no notion of *which revision* an action was taken against, so it could not draw that line.

## Why now?

#46 is the first moment a non-thread Work Item can be acted on, so it is the first moment the thread-shaped suppression model is provably insufficient. Deciding the model now — before a third and fourth Source arrive — keeps suppression source-neutral from the start instead of retrofitting it across every Skill later. It also unblocks a clean capacity signal: Capacity should reflect *visible attention demand*, which only exists once suppression is a first-class, queryable projection.

## Decision

**We will model the user's relationship to Orion's *presentation* as a separate projection, "Attention," distinct from Context.** Concretely:

- **Context stays reality.** It is derived only from source facts and no longer reacts to user actions for ranking purposes. (It still replays the legacy thread `status` field so old logs reconstruct byte-identically; nothing reads it.)
- **Attention is the single suppression authority.** A new `attention` projection folds `WorkItemActedOn`/`Snoozed`/`Dismissed` into a per-Subject `AttentionDisposition`. A pure `isVisible(opportunity, attention, now)` function is the *only* place that decides whether a reality-derived Opportunity is shown.
- **Actions are scoped to a revision.** Each current action records the exact occurrence ids the user saw (`basisEventIds`). An item resurfaces when a new revision appears (a basis id the action never covered) and stays quiet when only older facts trickle in. "The revision the user saw" is defined consistently for every Subject by the **occurrence winner** — the newest occurrence by domain timestamp with an Event-id tie-break — including conversations, whose current message is chosen this way rather than by message-array append order.
- **The action applies only to the revision actually rendered.** Mission Control renders a deterministic revision token (`attentionRevision`, derived from the Subject and its basis) into the action form. On submit the server recomputes the token from the currently-visible Work Item and records the action only if they match — an optimistic-concurrency check that prevents a click on a stale card from silently suppressing a newer revision the user never saw. Subject and basis are still derived server-side; the client token is compared, never trusted.
- **Suppression is source-neutral.** Dispositions key on `SubjectRef` (`subjectKey`), so a review, an assignment, a check, and a conversation are all suppressed through one mechanism.
- **Legacy events replay faithfully.** `AttentionDisposition` is a discriminated union: current `"evidence"` dispositions (Subject + basis) and pre-#46 `"legacy-subject"` dispositions (thread, no basis) that preserve the old semantics — dismissed is a durable mute; acted/snoozed reopen on a later inbound message.

## In one sentence

> Context is what is true; Attention is what the user has done about it — two projections of the same event log, joined only at the visibility stage.

## Consequences

- **Positive:** Suppression works identically for every Source with no per-Skill logic; Signal detection no longer depends on UI decisions (understanding is purely about reality); "dismiss what I'm looking at" is correct because actions are revision-scoped; Capacity can read visible attention demand cleanly.
- **Negative / costs:** A second projection to maintain and reason about; visibility is now a distinct pipeline stage rather than an early `continue`; a compatibility branch for legacy action events exists until they are retired.
- **Follow-ups / new constraints:** Retire the legacy `status` field and the `legacy-subject` disposition branch once no pre-#46 logs remain; multi-writer environments will need a real ordering discipline (v0.1 relies on single-process append order for "latest action wins"); cross-source correlation (suppressing an automated notification email that duplicates a structured event) builds on this seam.

## Principles

- **Supports:** Engineering #8 (source-neutral domain — suppression knows nothing about vendors); ADR-0005 (Context stays a pure reality projection); ADR-0006 (Attention as the primary resource — now literally a modeled projection); ADR-0009 (both are rebuildable folds over the one log).
- **Trade-offs:** Accepts the cost of a second projection and a legacy-compat branch in exchange for a clean reality/presentation separation and source-neutral suppression.

## Alternatives considered

- **Keep suppression in Context, generalized to all Subjects:** rejected — it re-entangles reality with the user's UI decisions and makes understanding depend on presentation, the exact problem #46 exposed.
- **Suppress inside each Skill:** rejected — every Source would reinvent handled/snoozed/dismissed, and Mission Control would need source-specific rules (violates Eng #8).
- **Subject-level suppression without a revision basis:** rejected — cannot distinguish "a new reply arrived" from "an older fact was backfilled," so it would either resurface too eagerly or mute genuinely new work.
