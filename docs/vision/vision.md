# Product Vision — Orion / Mission Control

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issue: #1 Define the Product Vision

> Attention is your most valuable resource. This system is designed to protect it.
>
> Mission Control exists so you can spend less time deciding what to do, and more time doing work that matters.

---

## 1. Vision Statement

**Orion is a personal operating system that serves as the intelligence layer for your digital life.**

"Operating system" describes the architecture — a coordinating layer above the tools you already use. "Intelligence layer" describes the value — it produces *understanding*, not just another place to look.

It ingests the constant stream of signals from your digital life — email, calendar, code, messages, tasks, money, travel — and turns that noise into a small number of clear, explained decisions. Instead of asking you to check ten tools and reconstruct your own priorities every morning, Orion presents a single surface — **Mission Control** — that answers one question:

> "What deserves my attention right now, and what can safely wait?"

Reducing anxiety isn't only about surfacing what's important. It's about giving you permission to confidently ignore everything else — and always being able to see *why*. Transparency isn't a feature we bolt on; it is Orion's core competitive advantage and the only durable basis for trust. That is the moat.

Orion is not a productivity tool that helps you do *more*. It is a decision-support system that helps you do the *right thing at the right time*.

---

## 2. The Problem

Knowledge workers don't suffer from a lack of information. They suffer from a lack of **filtered, contextualized, prioritized** information.

Concretely, today's reality looks like this:

- Signals are **fragmented** across many tools (Gmail, Calendar, GitHub, Slack, Jira, banking, travel). No tool has the whole picture.
- Every tool optimizes for **its own engagement**, not for the user's actual priorities.
- The human is forced to be the **integration layer** — mentally stitching together context across sources every single day.
- The result is **cognitive overload**: constant context-switching, decision fatigue, and the nagging fear of having missed something important.

The scarce resource is not time. It is **attention**. And nothing today is designed to protect it.

---

## 3. Target User

**Primary user (v0.1): the author.**

Orion is deliberately built for a single user first — a technical professional who:

- Operates across many tools and contexts simultaneously.
- Values focus and is frustrated by fragmentation and noise.
- Trusts systems that **explain themselves** over systems that feel like magic.
- Is comfortable with software being **advisory** and wants to keep the final decision.

Building for one real user (with real data and real stakes) keeps the product honest and avoids premature generalization. Broader audiences are explicitly a **later** concern (see Non-Goals).

---

## 4. Product Philosophy

Orion is guided by a small set of non-negotiable beliefs. (These are expanded in the Engineering Principles and Product Principles documents; summarized here as the north star.)

- **Protect attention above all.** Every feature must answer: *"Does this help the user spend their attention better?"* If not, it doesn't belong.
- **Surface decisions, not data.** The output is "here is what matters and why," not another inbox to triage.
- **Explainability over magic.** Every AI product today says *"trust us."* Orion says *"here's why."* The user must always be able to see the reasoning behind any recommendation — what signals, what context, what trade-off. (Why this matters as a moat is called out in the Vision Statement.)
- **AI advises; deterministic rules decide.** AI generates understanding and suggestions. Enforcement and irreversible actions run through deterministic, auditable rules.
- **Clarity over completeness.** A short, correct, confident answer beats an exhaustive one.
- **Attention compounds.** Every decision Orion makes should reduce *future* cognitive load, not merely solve today's problem. Each email, meeting, issue, financial event, and trip becomes accumulated understanding — making Orion smarter tomorrow than it is today. Orion isn't just helping you now; it is compounding context on your behalf.
- **No event exists in isolation.** A single email, meeting, expense, calendar invite, or GitHub issue has limited meaning by itself. Orion's value comes from understanding how events *relate* to one another over time — understanding compounds through context. This is the product reason the architecture is event-driven.
- **Preserve context. Never lose history.** Historical information isn't merely stored — it becomes increasingly useful over time. Orion's value grows as it accumulates context, which is exactly why the architecture is event-driven: nothing that happened is discarded, and the past stays queryable.
- **Local-first and private by default.** The user's life data is sensitive. Privacy is a design constraint, not a feature.
- **Every adapter is replaceable.** No source or vendor is load-bearing. The core reasons about *events and context*, not about Gmail or OpenAI specifically.

---

## 5. Guiding Principles (how we build)

1. **Start absurdly small.** v0.1 does one loop end-to-end, well. A clear "no" list matters as much as the "yes" list.
2. **Event-driven core.** The world is modeled as a stream of events; context is derived from those events.
3. **Context is a first-class concept**, not something assembled ad hoc into prompts. Skills ask "what should I know before helping the user?" — not "give me the last 20 emails."
4. **Advisory before agentic.** Orion earns the right to *act* by first proving it can *understand and advise* reliably.
5. **Build for one, design for many.** Solve the author's problem concretely, but keep abstractions clean enough to generalize later.

---

## 6. Non-Goals

Orion is **not**, at least not initially:

- **Not a to-do / project management app.** It reasons about your work; it doesn't replace Jira or Todoist.
- **Not a chatbot.** Conversation is a means, not the product. The product is the daily decision surface.
- **Not an autonomous agent (yet).** No irreversible actions taken on the user's behalf in early versions.
- **Not multi-user / not a SaaS (yet).** No teams, no accounts system, no monetization concerns in v0.1.
- **Not omnichannel.** No mobile, no voice, no Slack/Jira/GitHub/Calendar integrations in v0.1 (see MVP definition — v0.1 is Gmail-only).
- **Not a data lake.** We store what's needed to reason and explain, not everything for its own sake.

---

## 7. Long-Term Aspiration

Orion aims to become the trusted operating system for personal attention.

Just as operating systems coordinate a computer's hardware and enterprise platforms coordinate organizational workflows, Orion coordinates the user's digital life.

Applications produce information. **Orion produces understanding.**

Rather than replacing the tools people already use, Orion becomes the intelligence layer above them — helping users understand what deserves their attention, why it matters, and what should happen next.

The long-term vision is not to own every workflow. The long-term vision is to become the layer through which users understand and navigate those workflows.

One useful analogy is the **Bloomberg Terminal**. Professionals don't pay for Bloomberg because it has charts; they pay because it is the place where they *understand what's happening*. Orion aspires to occupy a similar role for an individual's digital life: not because it owns your email or your calendar, but because it becomes **the place where understanding happens**. The analogy is about *where understanding happens*, not about matching Bloomberg feature-for-feature — and that is a fundamentally different ambition from building "an AI assistant."

---

## 8. Success Criteria

### 8.1 Qualitative (the real test)

Orion is succeeding when the author can honestly say:

- "Within ~10 seconds of opening Mission Control, I know what deserves my attention today."
- "I trust it enough to *stop* checking some tools directly."
- "When it flags something, I understand *why* — and it's usually right."
- "It reduces my anxiety about missing something important."

### 8.2 Quantitative (early signals to instrument)

These are candidate metrics to validate later, not commitments:

- **Time-to-clarity:** seconds from opening Mission Control to knowing the day's top priorities (target: < 10s).
- **Priority precision:** of items Orion ranks as high-priority, what fraction the user agrees with (target: high, and rising over time).
- **Missed-signal rate:** how often the user later discovers something important that Orion failed to surface (target: near zero for the covered source).
- **Trust / reliance:** frequency the user acts on Orion's recommendation vs. overrides it.
- **Attention reclaimed:** reduction in direct visits to the underlying tool (e.g. checking Gmail directly).

---

## 9. What Winning Looks Like (1–2 year horizon)

Orion becomes the **first thing the user opens** and the **layer they trust** to tell them what matters — across email first, then calendar, code, messages, and life logistics. It feels genuinely *aware* rather than reactive, it always explains itself, and it demonstrably gives the user back the one thing nothing else protects: their attention.

### The emotional outcome: confidence

Attention, prioritization, and explanation are the mechanics. The *outcome* is **confidence**.

> Orion succeeds when users stop wondering whether they've forgotten something important — because they trust Mission Control to surface what truly matters, and to tell them what can safely wait.

That is the direct answer to the cognitive overload and fear-of-missing-something described in the problem statement. When the anxiety of "did I miss something?" disappears, Orion has done its job.

---

## Open Questions

- How do we measure "attention reclaimed" without being creepy or heavy-handed about tracking?
- Where exactly is the line between "advisory" and "agentic," and what earns crossing it?
- How much history must Orion retain to reason well, and how does that square with local-first/privacy?

## Related Documents

- [Engineering Principles](../principles/engineering.md) (#2)
- [Product Principles](../principles/product.md) (#8)
- [Design Principles](../principles/design.md)
- [The Mission Control Experience](../scenarios/mission-control-experience.md) (#7)
- [MVP Definition](../roadmap/mvp.md) (#6)
