# Engineering Principles — Orion

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issue: #2 Engineering Principles

This document is Orion's **engineering constitution**. Where the [Product Vision](../vision/vision.md) says *what we're building and why*, this says *how we build it*.

> **Good engineering is not measured by technical sophistication, but by how reliably it advances the product philosophy.**

Three values recur throughout and constitute Orion's engineering identity: **trust**, **understanding**, and **longevity**. Almost every principle below ultimately serves one purpose — to increase the quality of human decisions.

**How to use this document**

- Every significant technical decision should be traceable to a principle here (or should prompt us to add/amend one).
- If a proposed design violates a principle, that's not automatically forbidden — but it requires an explicit, written justification (an ADR) explaining the trade-off.
- Principles are grouped by theme for skimming. Precedence (what wins in a conflict) is defined in the final section, not by list order within a theme.
- **This is a document to reference while building, not to keep rewriting.** Its value now comes from being cited, not polished.

**The living feedback loop (team rule)**

Every Architecture Decision Record must explicitly cite the principles it supports or intentionally trades off. For example:

```markdown
## Principles

Supports:
- #5 Events are the source of truth
- #8 The domain is permanent
- #9 Earn abstraction

Trade-offs:
- Slightly increases implementation complexity to preserve long-term replaceability.
```

This keeps the constitution and the architecture in a feedback loop: over time we can see whether these principles are genuinely guiding decisions or merely sitting in a document. (Formalized in the ADR Framework, #3.)

---

## I. Human-Centered

### 1. AI augments humans; it never replaces their judgment

Orion exists to make the *human* a better decision-maker, not to make decisions for them.

- **Why:** The user is accountable for their own life and work. Software that quietly takes over erodes trust and understanding. Our job is to amplify attention and judgment, not substitute for it.
- **In practice:** The default output of any capability is a *recommendation with reasoning*, not a completed action. The human stays in the loop for anything consequential.

### 2. Every feature must reduce cognitive load

If a change adds more to think about than it removes, it is a regression — no matter how impressive.

- **Why:** Attention is the scarce resource (see Vision). Features that add noise, dashboards, or decisions work against the entire purpose of the product.
- **In practice:** Every PR/feature answers: *"Does this help the user spend their attention better?"* Prefer removing a decision over adding an option. Defaults over settings.

### 3. Explainability over magic — reasoning must be traceable

Any recommendation the user sees must be answerable with *"here's why."* That requires the system to record what it reasoned over.

- **Why:** Transparency is Orion's moat and the only durable basis for trust (see Vision). "Magic" that can't be inspected can't be trusted, debugged, or improved.
- **In practice:** Capture the inputs to a decision — which events, which context, which signals, which rule or model produced the output. Explanations are a first-class output, not an afterthought. Prefer designs whose behavior can be surfaced to the user in plain language.

---

## II. Intelligence

### 4. AI advises; deterministic rules decide and enforce

Probabilistic models generate understanding and suggestions. Deterministic, auditable code enforces decisions, guardrails, and anything irreversible.

- **Why:** This isn't only about AI — it's about **risk boundaries**. LLMs are excellent at interpretation and terrible at guarantees. Correctness, safety, and reproducibility must not depend on a model's mood.
- **In practice:** Draw a hard line between the *reasoning layer* (AI, non-deterministic, advisory) and the *decision/enforcement layer* (rules, deterministic, testable):

```
LLM → Recommendation → Deterministic Validation → Action
```

  Any action with side effects passes through deterministic guardrails. **If a behavior must be guaranteed, it is code, not a prompt.**

### 5. Events are the source of truth; never lose history

Orion models the world as an append-only stream of events. Derived state (context, priorities, summaries) is a *projection* of that stream and can always be rebuilt.

- **Why:** Understanding compounds through context (see Vision: "No event exists in isolation" / "Attention compounds"). We use event sourcing not merely for replay, but because *understanding compounds over time*. If we discard or mutate history, we destroy the raw material that makes Orion smarter — and lose the ability to explain past reasoning.
- **In practice:** Ingested facts are stored immutably. We build projections/read-models from events, and we can replay to reconstruct or improve them. Deleting is a deliberate, privacy-driven exception (see #13), not a routine operation.

### 6. Prefer composition over intelligence

Systems should become smarter through *composition*, not complexity. The best solutions emerge from composing simple, understandable capabilities rather than building increasingly complicated ones.

- **Why:** Systems built from small deterministic pieces are easier to understand, explain, test, and evolve than large opaque pipelines. When someone proposes "let's build one super-agent," this principle says *no*.
- **In practice:** Prefer event pipelines, projections, small skills, and reusable reasoning components over monolithic agents:

```
Event → Normalizer → Context Builder → Reasoner → Priority Engine → Recommendation
```

### 7. Testable, observable, measurable, and honest about confidence

We can only trust a system we can measure — and we should never present a guess as a certainty.

- **Why:** Explainability (#3) and deterministic enforcement (#4) are only real if they're verifiable. Orion is also a *learning* system: engineering must make product outcomes observable, not just system health.
- **In practice:** Deterministic logic is unit-tested at its contracts. Boundaries are observable and auditable. Where output is uncertain, represent and surface confidence rather than hiding it. Instrument the questions that actually matter:
  - Did the user follow this recommendation, or override it?
  - Was it useful? How often was it wrong? How often was it ignored?
  - Did it reduce the attention the user had to spend?

---

## III. Architecture & Longevity

### 8. The domain is permanent; integrations are temporary

The core reasons about *events and context* — never about Gmail, OpenAI, Postgres, or any specific vendor. Gmail may disappear. OpenAI may disappear. Postgres may disappear. Orion's event and context model should not.

- **Why:** No integration or model provider should be load-bearing. Vendors change, break, and get replaced; the domain and the product philosophy outlive all of them.
- **In practice:** External systems live behind adapters that translate to/from Orion's internal model. Vendor types and SDKs do not leak past the adapter boundary. Swapping an email provider or an AI model should be a localized change. Every adapter is replaceable by construction.

### 9. Earn abstraction

Don't abstract until reality forces you to. Prefer the smallest design that could possibly work, then let real usage justify the next increment.

- **Why:** Premature abstraction is one of the fastest ways for a solo project to stop shipping. v0.1 is deliberately tiny (Gmail-only, advisory).
- **In practice:** Build the thinnest end-to-end slice first. Add abstraction when a *second real case* demands it, not before. A clear "no" is as valuable as a "yes."

### 10. Design for one, architect for many

Solve the author's real problem concretely, but keep the seams clean enough to generalize later without a rewrite.

- **Why:** Building for one real user keeps us honest; clean boundaries keep the door open (see Vision: "Build for one, design for many").
- **In practice:** Hard-code the user where it saves time, but never bake single-user assumptions into the event model, context model, or adapter contracts.

### 11. The system should age gracefully

Orion should become *more* useful as it accumulates context, while remaining understandable, maintainable, and explainable.

- **Why:** Most software decays as it grows; Orion should *appreciate*. Its value comes from compounding context, so the architecture must favor designs whose value grows over time rather than designs whose operational complexity grows over time.
- **In practice:** Favor append-only history and rebuildable projections (#5) and composed simple parts (#6) over accreting stateful complexity. Treat "does this design get better or just bigger as data grows?" as a real design question.

### 12. Prefer reversible decisions — engineering exists to preserve optionality

When possible, choose designs that preserve future options over designs that prematurely optimize for a single future. This is the principle *underneath* replaceable adapters (#8), earn abstraction (#9), design for one (#10), and the permanent domain (#8): **don't make irreversible architectural decisions until reality forces them.**

- **Why:** We know far less than we think we do. Reversible decisions let the product evolve with new understanding instead of becoming trapped by early assumptions.
- **In practice:** Delay commitments to vendors, abstractions, and distributed architectures until there is concrete evidence they are needed.

---

## IV. Safety

### 13. Privacy by default; local-first where practical

The user's life data is among the most sensitive data there is. We treat it that way from line one.

- **Why:** Orion only works if the user trusts it with email, calendar, finances, and more. A single careless default can end that trust permanently.
- **In practice:** Collect the minimum needed to reason and explain. Keep processing local when practical; send data off-device only with clear purpose and, ideally, user awareness. Secrets are never committed. Deletion is genuinely supported. Third-party data-sharing is opt-in, never assumed.

### 14. Deterministic reversibility for anything with side effects

Actions that touch the outside world must be safe by construction: reversible, guarded, and clearly bounded.

- **Why:** Advisory-before-agentic (see Vision) only holds if, when Orion *does* act, it cannot cause irreversible harm without an explicit deterministic gate.
- **In practice:** Side-effecting operations are gated, logged, and where possible reversible or confirmable. No irreversible action is taken purely on a model's say-so (follows from #4).

---

## Precedence & conflict resolution

When principles collide, resolve in this rough order of authority:

1. **Privacy & safety** — privacy (#13), reversibility (#14), and the deterministic-enforcement boundary (#4). Never traded away for convenience or cleverness.
2. **Trust-building properties** — explainability (#3) and human-in-the-loop (#1).
3. **Longevity of the core** — event-sourced truth (#5), permanent domain / replaceable integrations (#8), composition (#6), graceful aging (#11), and reversible decisions / preserved optionality (#12).
4. **Velocity** — earn abstraction (#9) and design for one (#10).

Any decision that overrides a higher principle for a lower one must be justified in an ADR. Three concrete conflicts you *will* hit, already resolved here:

- **privacy vs. performance** → privacy wins (#13 > velocity).
- **explainability vs. model sophistication** → explainability wins (#3 > raw capability).
- **speed vs. correctness** → correctness wins for anything affecting user trust. Not because performance doesn't matter, but because Orion's entire value proposition depends on trust.

## Related Documents

- [Product Vision](../vision/vision.md) (#1)
- [Product Principles](./product.md) (#8)
- [Design Principles](./design.md)
- [ADRs](../adr/) (#3, #11) — where principle trade-offs get recorded
- ADR: Event-Driven Architecture (#20), Event Bus (#21), Storage Strategy (#22), AI Abstraction Layer (#24)
