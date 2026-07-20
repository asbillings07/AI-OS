# Orion Documentation

> Status: Living · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issue: #12 Define Mission Control Documentation Strategy

Documentation in Orion is a **product artifact, not an afterthought.** Its job is to preserve the *reasoning* behind the system as it evolves over many years — long after the specific code, vendors, and frameworks have changed.

This directory intentionally separates concerns that most projects let blur together: *why the project exists*, *what kind of product it should be*, *how interactions should feel*, *how the software is built*, and *why specific decisions were made*. Each category answers **one primary question** and should avoid duplicating information that belongs elsewhere.

---

## Structure

```
/docs
  README.md            ← you are here (documentation strategy + index)
  /vision              Why Orion exists
    vision.md
  /principles          The rules that guide decisions
    product.md         What kind of product Orion should be
    design.md          How interactions should feel
    engineering.md     How the software is built
  /adr                 Architecture Decision Records (why decisions were made)
  /domain              Core concepts & ubiquitous language
  /architecture        System structure, boundaries, event flows, adapters
  /roadmap             Planned evolution over time (incl. MVP definition)
    mvp.md
  /scenarios           Real-world usage stories = living acceptance criteria
    mission-control-experience.md
```

## Document responsibilities

Each category answers exactly one primary question:

| Category | Primary question | Change frequency |
|---|---|---|
| **Vision** | Why does Orion exist? | Rarely |
| **Product Principles** | What kind of product should Orion become? | Rarely |
| **Design Principles** | What should users consistently experience? | Rarely |
| **Engineering Principles** | How do we engineer this system? | Rarely |
| **ADR** | Why was this decision made? | Append-only (one per decision) |
| **Domain** | What are the core concepts and their shared language? | Evolves with understanding |
| **Architecture** | How is the system structured? | Evolves with implementation |
| **Roadmap** | How will the product evolve over time? | Regularly |
| **Scenarios** | What should real usage look/feel like? | Grows over time |

The **principles** and **vision** are the stable core (the "governing documents"). The **ADR**, **domain**, **architecture**, and **roadmap** layers move faster and must stay *aligned* with the core — every significant decision should be traceable back to a principle.

## Current documents

- **Vision:** [vision.md](./vision/vision.md) (#1)
- **Principles:** [product.md](./principles/product.md) (#8) · [design.md](./principles/design.md) · [engineering.md](./principles/engineering.md) (#2)
- **Scenarios:** [mission-control-experience.md](./scenarios/mission-control-experience.md) (#7) — the flagship/anchor scenario
- **Roadmap:** [mvp.md](./roadmap/mvp.md) (#6)
- **ADR / Domain / Architecture:** see each folder's README (being established via #3, #11, #16, #17, #4, #5, #25)

---

## How to add or change documentation

1. **Pick the right home.** Every document belongs to exactly one category and answers that category's one question. If a doc wants to answer two questions, split it.
2. **Don't duplicate — link.** If information already lives elsewhere, reference it rather than restating it. Duplication is how docs drift out of sync.
3. **State the question at the top.** Each doc should make its purpose and scope obvious in the first lines (status, owner, related issue).
4. **Record decisions as ADRs.** Significant architectural or product decisions get an ADR (see `/adr`), and other docs cite the ADR rather than re-arguing it.
5. **Documentation ships with the change.** A feature or architectural change is not "done" until the docs that describe it are updated in the same PR (see [Contribution Guidelines](../CONTRIBUTING.md), #19).

## Review expectations

- **Governing documents** (vision, principles) change rarely and deliberately. Changes are reviewed as carefully as code and should explain *why* the understanding shifted — not just what changed.
- **Fast-moving documents** (adr, domain, architecture, roadmap, scenarios) are expected to evolve continuously and should be kept honest against reality.
- **Docs are cited, not just written.** The measure of these documents is whether they're referenced during design reviews, architecture discussions, and roadmap debates. ADRs must cite the principles they support or trade off (see Engineering Principles → "The living feedback loop").

## Planned / future documents

Surfaced during foundational work; tracked so they aren't lost:

- `principles/tone-and-voice.md` — Orion's voice and copy principles (calm, confident, transparent, humble, concise). Given that *copy is the interface*, this deserves the same weight as the other principle docs.
- `docs/philosophy.md` — the cross-product philosophy shared with Alliance Command Center ("preserve context → transform into understanding → help people decide").

The conceptual pipeline / loop (Events → Context → Signals → Work Items → Recommendations → Human Decision → new events) now lives at [domain/mental-model.md](./domain/mental-model.md).
