# ADR-0014: Personal Importance Learned from Attention Dispositions

> Status: Accepted
> Date: 2026-07-22 · Deciders: @asbillings07
> Related: #65 (Learn personal importance from attention dispositions), #68 (User Understanding), [ADR-0004](0004-ai-recommends-rules-decide.md), [ADR-0005](0005-context-is-a-first-class-domain-object.md), [ADR-0006](0006-attention-is-the-primary-resource.md), [ADR-0009](0009-storage-strategy.md), [ADR-0012](0012-attention-is-a-projection-distinct-from-context.md)

## Context

Dogfooding the live Gmail integration (#64) surfaced a clear product finding: generic urgency/opportunity heuristics — "unread," "asks a direct question," "waiting a while" — fire almost identically for a newsletter and a note from your manager. Against a real inbox the ranking feels generic. This is not a defect in the engine; it is the absence of the *personal* signal the engine was designed to accept.

The substrate to learn that signal already exists. Since ADR-0012, every user decision is recorded as a source-neutral `WorkItemActedOn`/`Snoozed`/`Dismissed` Event, hardened against races and duplicates in #61. That is trustworthy behavioral evidence: what the user actually does with work, per Subject, over time.

Two forces are in tension. We want ranking to become personal, but we do not want to (a) overclaim — a couple of clicks is not an "established preference"; (b) leak vendor knowledge into the domain — the signal must key on *who work is from* without core ever learning what Gmail or GitHub are; or (c) entangle this with Capacity, which answers a different question ("can the user act well *right now*?") from importance ("does this *matter* to the user?").

## Why now?

Real-inbox dogfooding is the first moment the generic ranking is provably insufficient, and #61 is the first moment the disposition events are trustworthy enough to learn from. Deciding the shape of this signal now — before more Sources arrive — keeps it source-neutral from the start rather than retrofitting personalization across every Skill later. It also fixes the boundary with the broader User Understanding work (#68) before either grows into the other.

## Decision

**We will learn a bounded, ranking-specific behavioral signal — "Personal Importance" — from recorded attention dispositions, keyed by an immutable, source-neutral originator, and feed it into prioritization as a dedicated, explainable term.** Concretely:

- **Personal Importance is a behavioral signal, not an authoritative preference or belief.** It is a bounded input to ranking derived purely from what the user did. It is explicitly *not* a `User Preference` (an authoritative, user-stated constraint) and not an established belief about the user. That keeps it compatible with User Understanding (#68) and with future explicit corrections, which may override it.
- **The evidence key is an immutable, source-neutral `OriginatorRef { namespace, id }`** — "who this work is from." It is a foundational domain type (it lives beside the action payload), so both the action payload and the Importance module depend *downward* on it.
- **The namespace comes from the winning occurrence's stored `source`, never from `Subject.kind`.** Context now preserves the emitting Event's `source` on the message/review/assignment it remembers. Inferring `thread -> Gmail` / `review -> GitHub` would break the moment Slack emits a thread or Jira an assignment; carrying the real source label (`gmail-skill`, `github-skill`) keeps it honest with no vendor branch in core.
- **The originator is stamped onto the action Event at record time.** `buildActionEvent` resolves `originatorFor(subject, context)` once, inside the append critical section, and records it on the payload. The learning projection therefore reads a uniform key and never re-opens Context, branches on source, or queries mutable Skill data.
- **Adapters canonicalize source-native ids; core keeps them opaque.** Gmail already lowercases addresses; GitHub emits a canonical login. `originatorKey(o) = JSON.stringify([namespace, id])` — collision-safe where a `${namespace}:${id}` join would be ambiguous. Cross-source identity is deliberately *not* asserted (consistent with the `ActorRef` deferral): keys stay per-namespace.
- **The score is a pure, rebuildable function of integer counts.** `importanceScore` returns `0.5` (neutral) until at least two *decisive* actions (acted or dismissed) exist, then moves gradually and symmetrically: `0.5 + (acted - dismissed) / (2·(acted + dismissed + 2))`, clamped to `[0,1]`. Snoozes are recorded but never scored — "relevant, but not now" is not negative feedback. The whole signal rebuilds deterministically from the log (ADR-0009).
- **Ranking stays Context-independent and explainable.** `prioritize()` receives a precomputed numeric importance contribution (score, evidence ids, display name), never `ContextState` or `PersonalImportanceState` — `buildWorkItems` is the one place that resolves Context + the projection into that plain contribution, per visible Subject, before calling `prioritize()`. The contribution moves `priority` by a small, bounded, signed amount — `0.15 · (importance − 0.5) · 2`, so a neutral (`0.5`) contribution changes nothing — and breaks priority ties as a fifth tie-break dimension, after Urgency/Commitment/Opportunity and before the deterministic `subjectKey` fallback. The "why" is evidence-specific and source-neutral ("You've acted on more work from {name} than you've dismissed."), appended to the existing reason only when the score is off-neutral. Importance provenance (`importanceEvidenceEventIds`) is exposed on the Work Item separately from the presentation revision (`attentionBasisEventIds`).

## In one sentence

> Personal Importance is what the user's own actions reveal matters — a bounded, rebuildable, source-neutral behavioral signal keyed on who work is from, not an authoritative statement of preference.

## Consequences

- **Positive:** Ranking becomes personal with no Skill change and no vendor knowledge in core; the signal is fully rebuildable and explainable from the log; the reality/presentation/importance split stays clean (Context is truth, Attention is what the user did about it, Importance is what that implies for ranking); a Gmail sender and a GitHub actor with identical histories get identical contributions.
- **Negative / costs:** A third projection to maintain; Context now carries a `source` label on remembered facts (a small, additive field); the two-event decisive threshold means very new users see no personalization yet (by design — no cold-start penalty).
- **Follow-ups / new constraints:** `lastActionAt` is recorded but unused, reserved for future recency/decay; subject-characteristic importance keys (topic, not just originator) are deferred; reconciling this behavioral signal with explicit User Understanding/corrections (#68) is future work; when identity resolution exists, per-namespace originators could be unified.

## Principles

- **Supports:** Engineering #8 (source-neutral domain — importance keys on an originator label carried from the source, never on a vendor branch); ADR-0004 (this is an advisory ranking input, not a rule that decides *for* the user); ADR-0006 (personalizing ranking is protecting the user's attention); ADR-0009 (a pure, rebuildable fold over the one log); ADR-0012 (builds directly on the source-neutral disposition events).
- **Trade-offs:** Accepts a modest, deliberately conservative signal (two-event threshold, small weight) over a more aggressive one, trading early personalization strength for trustworthiness and the avoidance of overclaiming a "preference" from thin evidence.

## Alternatives considered

- **Overload `Opportunity` with the personal signal:** rejected — it muddies "is there value in acting?" (intrinsic) with "does this matter to *me*?" (learned), the two-concepts-in-one-number mistake #29 warned against. A dedicated term keeps each reasoning input clean.
- **Fold importance into Capacity:** rejected — Capacity is about conditions for doing work well; importance is about what matters. Combining them entangles two distinct questions.
- **Infer the originator namespace from `Subject.kind`:** rejected — it bakes a false `thread=Gmail` / `review=GitHub` assumption into core that breaks with the next Source; carrying the real `source` label is source-neutral and future-proof.
- **Key importance on the mutable Context/Skill data at ranking time:** rejected — it would re-open Context during ranking and make the signal depend on live lookups; stamping an immutable originator on the Event makes the projection a pure fold.
- **Call it "User Preference":** rejected — that term is reserved for authoritative, user-stated constraints (and the "when/where work fits" track). This is a behavioral inference, and naming it precisely keeps it subordinate to explicit user statements.
