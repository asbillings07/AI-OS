# ADR-0016: Model User Understanding as Evidence-Backed, Evolving Beliefs

> Status: Proposed
> Date: 2026-07-24 · Deciders: @asbillings07
> Related: #68 (Model user understanding), #31 (Memory), #53 (Context baseline), #57 (Learned preferences), #59 (Inspectable context), #65 (Personal importance), #70 (Natural language onboarding), #71 (Belief extraction), #72 (Evolving projection), #79 (Dogfood validation), [ADR-0002](0002-everything-is-an-event.md), [ADR-0004](0004-ai-recommends-rules-decide.md), [ADR-0005](0005-context-is-a-first-class-domain-object.md), [ADR-0009](0009-storage-strategy.md), [ADR-0014](0014-personal-importance-from-dispositions.md)

## Context

Dogfooding Orion against a real inbox (#79) established a fundamental product insight: generic urgency heuristics ("unread," "direct question") and originator-based importance scores (ADR-0014) improve baseline ranking, but remain insufficient when evaluated across varied conversations. An originator's past disposition history provides bounded ranking evidence, but it cannot make global claims about the importance of every message from that sender.

For example, an email from a frequent collaborator containing an urgent action request deserves immediate attention, whereas an informational FYI or casual check-in from that same collaborator can wait. Prioritizing effectively requires understanding the user's intent, active goals, constraints, role obligations, and current working situation.

Without a formal model of user understanding, personalization risks degrading into either a flat mutable profile table (which loses provenance, history, and inspectability) or an unconstrained bag of LLM prompts (which introduces nondeterminism, replay drift, and unexplainable behavior). Orion requires an architectural contract that unifies user understanding while upholding our core principles: events are truth, rules decide, and human judgment remains authoritative.

## Why now?

Orion is advancing into the Adaptive Personal Context sequence: natural-language onboarding (#70), candidate belief extraction (#71), and the evolving User Understanding projection (#72). Deciding the architectural boundary now—before implementing extraction pipelines or UI controls—prevents user understanding from becoming an ad-hoc mutable table, an uncurated prompt buffer, or an opaque black box. It also explicitly constrains ADR-0014 (Personal Importance), ensuring originator-based behavioral scores remain subordinate to explicit user statements and contextual intent.

## Decision

**We will represent User Understanding as an evolving, evidence-backed set of Beliefs maintained as a specialized, rebuildable projection over the canonical Event Log (ADR-0002, ADR-0009).** A Belief is a correctable hypothesis about what matters to the user, held with uncertainty, tied to explicit evidence, and governed by deterministic precedence and privacy constraints.

### 1. Vocabulary & Domain Boundaries

Orion maintains strict boundaries between related domain concepts:

| Concept | Definition | Architectural Status |
| --- | --- | --- |
| **Event** | An immutable record of something that happened in reality (e.g. `MessageReceived`, `WorkItemActedOn`). | Source of Truth (Event Log) |
| **Timeline** | A chronological view of significant events across sources. | Rebuildable View |
| **Memory** | Durable, reusable knowledge distilled from evidence and recalled when relevant (ADR-0009 / `memory.md`). Not a copy of every event. | Distilled Domain Fact |
| **Context** | Rebuildable representation of the user's current situation (threads, reviews, assignments, people). | Active State Projection |
| **Preference** | An explicit, authoritative operational policy declared by the user (e.g. working hours, snooze defaults, notification channels). | Authoritative Rule |
| **Belief** | A correctable hypothesis about the user supported by evidence and held with uncertainty (e.g. goals, roles, active projects, contextual priorities). An inferred preference remains a **Belief** until the user explicitly adopts it as a **Preference**. | Evolving Hypothesis |
| **User Understanding** | The capability that maintains, projects, and exposes active beliefs derived from evidence. | Specialized Projection |
| **Evidence** | Referenceable Events or facts that support or contradict a belief. | Provenance Reference (`sourceEventIds`) |
| **Confidence** | The strength of evidentiary support for a belief within its authority level. Confidence is neither truth, authority, nor permission to act. | Non-authoritative derived metadata |

> **Deterministic Confidence Constraint:** AI-reported confidence is proposal metadata. Deterministic policy may normalize, cap, or disregard it; a model cannot increase a proposal's authority by assigning itself high confidence.

### 2. Orthogonal Metadata Dimensions

Rather than conflating origin, derivation, verification, and state into a single flat enum, every Belief carries four orthogonal dimensions:

1. **Evidence Origin**: `user_statement` (direct input), `user_behavior` (dispositions/actions), `source_data` (integrations), `system_observation` (environmental context).
2. **Derivation**: `declared_directly` (stated by user), `deterministic_inference` (derived by rules), `ai_assisted_inference` (extracted by LLM).
3. **Verification**: `unconfirmed` (proposed/inferred hypothesis), `user_confirmed` (verified by user).
4. **Lifecycle**: `candidate` (proposed), `active` (currently applied), `contradicted` (challenged by new evidence), `superseded` (replaced by newer belief), `rejected` (explicitly dismissed by user), `forgotten` (removed per user privacy request).

#### Deterministic Authority Precedence

When active beliefs conflict or overlap, Orion resolves authority using a strict deterministic hierarchy:

```text
current user-declared belief, including a correction
> user-confirmed inferred belief
> policy-eligible unconfirmed inferred belief
```

A rejection acts as a veto over the rejected claim and its existing evidence path rather than an active belief tier. An observed behavioral pattern is evidence, not an active belief tier. Conflicts within the same authority level are resolved by scope specificity and effective timestamp (`validFrom`), **never** by selecting whichever item carries a higher AI confidence score.

### 3. Temporal & Contradiction Semantics

Beliefs are not permanent facts; they evolve over time as reality changes. Every active belief tracks `validFrom`, `lastSupportedAt`, and optional `reviewAfter` or `expiresAt`.

Support and contradiction judgments are recorded as domain events (e.g. `UserBeliefSupported`, `UserBeliefContradicted`), capturing the supporting/contradicting event IDs and the rule or model version involved. Replay folds these recorded judgments deterministically rather than re-evaluating historical evidence with newer inference logic.

#### Category-Specific Decay & Expiration Rules

- **Current-priority beliefs:** Expire quickly unless renewed by fresh evidence or user statements.
- **Inferred routines and behavioral patterns:** Weaken gradually without reinforcement and yield to direct schedule/context signals.
- **Explicit preferences:** Remain authoritative until changed, deleted, or their declared validity ends.
- **Values and core-relationship beliefs:** Do not decay merely with elapsed time. Contradictory evidence may trigger review, but replacement requires appropriate confirmation or direct correction. Operational relationships (e.g. "Primary manager is Dana") may update automatically from authoritative source data without requiring personal confirmation.

### 4. Deterministic Replay Across AI Inference

To preserve Orion's fundamental storage and replay invariants (ADR-0004, ADR-0009):

> **AI may propose a belief, but it may not mutate the active belief projection directly.**

When an AI capability extracts a candidate belief from natural language (#71) or behavioral patterns (#57), it emits an immutable event on the log (e.g. `UserBeliefProposed`). This proposal event records:
- Proposed belief payload (category, subject, claim)
- Supporting evidence event IDs (`sourceEventIds`)
- Inference mechanism / model version
- Creation time and belief scope
- Initial confidence score
- Confirmation requirements

The User Understanding projection folds these proposal events—alongside confirmation (`UserBeliefConfirmed`), correction (`UserBeliefCorrected`), rejection (`UserBeliefRejected`), and supersession events—purely deterministically. Replaying the event log reconstructs the exact active belief state without re-invoking live AI models or drifting history over time.

### 5. Correction, Rejection, Forgetting, and Privacy Rules

User control over understanding must be explicit, granular, and inspectable (#59):

- **Correction**: Supersedes an existing belief with user-provided information. The previous belief transitions to `superseded` without deleting historical events.
- **Rejection**: Invalidates a proposed or active inference and marks its supporting evidence IDs so the same inference is not immediately re-proposed from old facts.
- **Forget**: Removes the belief from active use and marks its retained evidence per privacy policy and ADR-0009's deletion exception.
- **Pause Learning**: Temporarily halts new belief extraction within a category without deleting active history.

> **Replay Invariant:** Rejecting or forgetting a belief must prevent deterministic replay from silently reactivating it from pre-rejection or pre-forgetting evidence. Reactivation requires qualifying new evidence or an explicit user action under the applicable policy.

#### Privacy & Side-Effect Authorization Constraints

- **Side-Effect Constraint**: No belief—confirmed or unconfirmed—authorizes consequential external action by itself. Deterministic policy decides whether and how beliefs may influence behavior, and every side effect remains governed by ADR-0004.
- **Category Policies**: Orion enforces four deterministic category policies for belief processing: `allowed`, `confirmation_required`, `opt_in`, and `prohibited`. Candidates in `confirmation_required` categories may be presented to the user for explicit confirmation, but cannot influence ranking, presentation, or recommendations prior to confirmation.
- **User Control**: Users may inspect, correct, reject, or forget any belief, and may disable both collection and learning by category (#59).
- **Minimization**: Orion retains only the minimum evidence required for provenance and explainability. User-derived beliefs and evidence must never influence another user's understanding.
- **Negative Evidence**: Absence of evidence is never treated as negative preference evidence.

### 6. Actionability Decision Matrix

Active beliefs guide Orion according to four constrained actionability tiers based on belief eligibility:

| Belief State | Permitted Influence |
| --- | --- |
| **Declared or confirmed active** | Reversible ranking, presentation, and uncertain suggestions as policy permits. |
| **Eligible unconfirmed** | Ask for confirmation; cautious reversible influence only when explicitly allowed by policy. |
| **Sensitive and confirmation-required** | Ask only; no ranking or presentation influence before confirmation. |
| **Rejected, forgotten, expired, or prohibited** | Must not use for any purpose. |

> **Universal Side-Effect Rule:** Consequential external side effects (e.g. sending messages, deleting data, applying external mutations) remain governed universally by ADR-0004—even declared or confirmed beliefs cannot authorize external actions by themselves.

### 7. Worked Examples

#### Example 1: Strengthening & Confirmation
1. **Observation**: Orion observes three consecutive PR reviews completed for `acme/orion` within 1 hour of request.
2. **AI Proposal**: AI capability emits `UserBeliefProposed` with claim *"User prioritizes acme/orion PR reviews"*, origin `user_behavior`, derivation `ai_assisted_inference`, verification `unconfirmed`, lifecycle `candidate`.
3. **Actionability**: Tier 2 — Orion surfaces a lightweight check-in: *"I noticed you usually handle acme/orion PRs right away. Should I treat these as high priority?"*
4. **Confirmation**: User selects "Yes". System emits `UserBeliefConfirmed`. The projection transitions the belief to verification `user_confirmed` and lifecycle `active`.

#### Example 2: Priority Shift & Supersession
1. **State**: User has an active belief: *"Focusing on Q2 audit preparation"* (`validFrom: 2026-04-01`).
2. **Statement**: On July 1, the user states during onboarding/check-in: *"Q2 audit is done; my primary focus now is Q3 launch."*
3. **Event**: System emits `UserBeliefCorrected` referencing the old belief ID.
4. **Projection**: Old belief transitions to `superseded` (`expiresAt: 2026-07-01`). New belief *"Focusing on Q3 launch"* becomes `active` with origin `user_statement`, derivation `declared_directly`.
5. **Replay Integrity**: Event log preserves both statements; current ranking reads only the active Q3 belief.

#### Example 3: Empirical #79 Dogfood Finding (Intent vs Originator)
1. **Context**: Sender Sam (`sam@partner.io`) has a positive originator importance score (ADR-0014) from past completed work. Sam sends two emails:
   - Email A: *"Contract draft — please review terms by Friday."* (Explicit action request)
   - Email B: *"FYI — quick update on team staffing."* (Informational update)
2. **Evaluation**:
   - Originator history contributes a bounded positive background contribution.
   - Email A carries an `ExplicitRequest` signal and aligns with active goal *"Finalize partner contract"*, reaching **Needs Attention**.
   - Email B carries no action signal (`LikelyLowValue` / FYI) and remains in **Can Wait**.
3. **Outcome**: Personal Importance provides a bounded background signal, but item intent and active user beliefs determine final prioritization. Orion does not form a global, simplistic judgment that "everything from Sam is important." *(Note: numeric priority scores such as `0.73` vs `0.32` are non-normative implementation outputs from the current dogfood build.)*

## In one sentence

> User Understanding is a rebuildable projection of evidence-backed, correctable beliefs that contextualizes what matters to the user without mutating history, overclaiming certainty, or bypassing human authority.

## Consequences

- **Positive:** Unifies Memory, Context, Preference, and Importance into a clear domain architecture; keeps AI personalizations fully rebuildable and explainable from events; prevents flat mutable profile tables; respects user corrections as absolute authority; protects privacy.
- **Negative / costs:** Requires explicit event schemas for belief proposals, confirmations, corrections, rejections, and forgetting; requires managing belief lifecycle state and expiration in a new projection.
- **Follow-ups / new constraints:** Requires implementing belief proposal events in #71 and projection state in #72; requires building inspection and correction UI in #59; requires updating onboarding contracts in #70.

## Principles

- **Supports (Primary):**
  - **#1 (Human judgment remains authoritative):** Direct user corrections and rejections outrank inferences.
  - **#3 (Explainability and traceable reasoning):** Every active belief links directly to supporting evidence IDs.
  - **#4 (Deterministic enforcement):** Belief projections fold events deterministically; AI proposes, rules decide.
  - **#5 (Events remain the source of truth):** Beliefs are rebuildable projections over the canonical event log.
  - **#7 (Honest, testable confidence):** Confidence is non-authoritative derived metadata; a model cannot self-assign authority.
  - **#11 (The system ages gracefully):** Temporal decay, expiration, and supersession ensure stale beliefs expire naturally.
  - **#13 (Privacy and minimization):** Category privacy policies, user control, evidence minimization, and strict cross-user isolation.
- **Cites:** #6 (Attention is primary), #8 (Source-neutral domain), #12 (Prefer reversible decisions), #14 (Isolate side effects).
- **Trade-offs:** Accepts the overhead of explicit event schemas and proposal/confirmation loops over quick, unconstrained LLM prompt injections to guarantee rebuildability, safety, and user trust.

## Alternatives considered

- **Flat mutable user profile table:** Rejected — mutates state in place, losing provenance, auditability, and replay capability (violates ADR-0002 and ADR-0009).
- **Treating every belief as Memory:** Rejected — conflates distilled historical facts ("User worked at Acme in 2024") with evolving, uncertain hypotheses ("User is currently focused on Q3 launch").
- **Treating beliefs as Preferences:** Rejected — Preferences are explicit, authoritative operational policies (e.g. working hours). Inferred beliefs are hypotheses held with uncertainty and lower authority.
- **Prompt-only personalization:** Rejected — passing uncurated conversation history or raw text into LLM prompts creates nondeterministic ranking drift, eliminates inspectability, and cannot be corrected cleanly by the user.
- **Independent mutable profile store outside the canonical Event Log:** Rejected — isolates user understanding from the event log, creating synchronization gaps and preventing deterministic replay (note: User Understanding can exist as a distinct bounded context, but its state must remain a rebuildable projection over canonical events).
