# Contributing to Orion

> Status: Living · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issue: #19 Create Contribution Guidelines

Thank you for contributing to Orion. This guide exists so that contributions are **consistent regardless of who writes the code — human or AI.** As Orion grows, consistency matters more than speed: a coherent codebase reduces review overhead, speeds onboarding, and keeps the architecture aligned with the philosophy that defines the product.

The golden rule: **every contribution should be traceable to the principles.** If you can't say which principle a change serves, that's a signal to stop and think.

---

## Start here: read the constitution first

Before writing code, read these in order. They take under an hour and will let you make good decisions without asking:

1. [Product Vision](./docs/vision/vision.md) — why Orion exists
2. [Engineering Principles](./docs/principles/engineering.md) — how we build (the constitution)
3. [Product Principles](./docs/principles/product.md) — how the product behaves
4. [Design Principles](./docs/principles/design.md) — how interactions feel
5. [Domain README](./docs/domain/README.md) — the vocabulary
6. [The Decision Loop (Mental Model)](./docs/domain/mental-model.md) — **how Orion thinks** (read this one twice)
7. [ADRs](./docs/adr/) — why the foundational decisions were made
8. Then open the code.

When evaluating any change, the first question is the one from the Mental Model: **"Where does this fit in the Decision Loop?"** If the answer is unclear, the design needs more thought.

---

## Development workflow

- **Issue first.** Every non-trivial change starts with an issue describing the problem and intent. Discussion and exploration belong in the issue or a design doc — not in code or an ADR.
- **Work from milestones.** Pick up work that belongs to the current milestone; avoid speculative work (Engineering #9, *Earn abstraction*).
- **Reference the issue** in your branch and PR (e.g. "Closes #42").
- **Keep PRs small and focused.** One logical change per PR. A reviewer should be able to hold the whole change in their head.

### Branch naming

```
<type>/<issue-number>-<short-kebab-summary>
```

`type` is one of: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. Examples:

```
feat/42-gmail-adapter-ingest
docs/19-contribution-guidelines
fix/57-priority-score-tie-break
```

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(optional-scope): <imperative summary>

<optional body: what & why, not how>

Refs #<issue>
```

- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`.
- Summary in the imperative mood ("add", not "added"), ≤ ~72 chars.
- Explain the *why* in the body when it isn't obvious. Never narrate the *how* — the diff already shows that.

### Issue lifecycle

`Open → In progress → In review → Done` (or `Won't do`). An issue is only **Done** when the code *and* its documentation are merged. Closing an issue without updated docs is not "done."

---

## Pull requests

Every PR uses the [pull request template](./.github/pull_request_template.md), which asks for Purpose, Scope, Testing, Related issues, and three short checklists that keep us aligned:

- **MVP Alignment** — does this belong in v0.1's "yes" list? If not, why now?
- **Principles** — which Product/Engineering/Design principles does it support or trade off?
- **Product checklist** — the six product tests (attention, decision, clarity, explainability, calm, restraint).

A PR that can't answer these honestly is usually a sign the change belongs to a different product, or a different time (see [MVP](./docs/roadmap/mvp.md)).

---

## Coding standards

These are the day-to-day expression of the [Engineering Principles](./docs/principles/engineering.md):

- **Readability over cleverness.** Code is read far more than written. Optimize for the next person (or AI) to understand it.
- **Composition over inheritance.** Build behavior by combining small pieces (Engineering #6, *Prefer composition over intelligence*). Avoid deep hierarchies and god-objects.
- **Explicitness over magic.** No hidden control flow, no surprising side effects. If a behavior must be guaranteed, it is code, not a prompt (ADR-0004).
- **Minimize unnecessary abstraction.** Don't abstract until a second real case forces it (Engineering #9, *Earn abstraction*). Prefer reversible designs (Engineering #12).
- **Consistent naming = the domain language.** Use the [ubiquitous language](./docs/domain/README.md) exactly. A concept called `Event` in the domain is `Event` in the code — never `Message`, `Record`, or `Item`.
- **Respect the boundaries.** Vendor SDKs and types stay behind adapters (Engineering #8). The reasoning layer (AI) never crosses into the decision/enforcement layer (deterministic) except through defined interfaces (ADR-0004).

## Architecture & ADRs

- **Follow accepted ADRs.** They are binding. If you believe one is wrong, don't quietly violate it — propose a superseding ADR.
- **Don't introduce new patterns without justification.** Prefer extending existing systems over creating parallel ones.
- **Write an ADR when the decision is significant and durable.** The durability test: *if the decision would still matter after replacing every technology in the stack, it probably deserves an ADR* (see [ADR README](./docs/adr/)). Most technology choices don't — capture those in code or an issue.
- **Every ADR cites principles.** Supports / trade-offs. This is the living feedback loop between the constitution and the architecture.

## Documentation

Documentation is a product artifact, not an afterthought (see [docs strategy](./docs/README.md)). Every change includes:

- **Docs updated in the same PR.** A feature isn't done until the docs that describe it are current.
- **The right home.** Put information in exactly one category (vision / principles / adr / domain / architecture / roadmap / scenarios) and **link** rather than duplicate.
- **ADR references** where a decision was involved.
- **Design rationale** for any non-obvious choice — capture the *why*, not a narration of the *what*.

## Testing philosophy

Grounded in Engineering #7 (*testable, observable, measurable, honest about confidence*):

- **Deterministic logic is tested at its contracts.** The decision/enforcement layer (ADR-0004) must be well covered — it's what provides guarantees.
- **Don't unit-test the model's creativity.** Test the *boundaries* around AI (inputs, validation, guardrails, fallbacks), not the exact prose of a summary.
- **Make outcomes observable.** Instrument the questions that matter (followed? useful? wrong? ignored? did it reduce attention?), not just system health.
- **Be honest about confidence.** Where output is uncertain, represent and surface that — never present a guess as a certainty.

## Code review standards

- Review against the **principles and ADRs**, not personal taste. Cite them in feedback.
- Check the **domain language** is used correctly.
- Confirm **docs shipped** with the change and the PR checklists are honestly completed.
- Prefer **small, kind, specific** feedback. Approve when it's better than before and aligned — not when it's perfect.

---

## AI-assisted development

Orion expects AI to help write it — and holds AI-generated contributions to the **same standard as human ones**:

- **Human review is required.** No AI-generated change merges without a human who understands it and takes responsibility for it.
- **Validate generated code.** Run it, test it, read it. Generated code that "looks right" is not evidence it is right.
- **Architectural compliance is non-negotiable.** AI contributions must follow the accepted ADRs, the domain language, and these coding standards. "The model wrote it that way" is not a justification.
- **Same documentation expectations.** AI-assisted changes update docs and complete the PR checklists like any other.
- **Attribution when helpful.** Note significant AI assistance in the PR description where it aids review or future understanding.

---

## Templates

- [Pull request template](./.github/pull_request_template.md)
- Issue templates: [Bug report](./.github/ISSUE_TEMPLATE/bug_report.md) · [Feature request](./.github/ISSUE_TEMPLATE/feature_request.md) · [Architecture proposal](./.github/ISSUE_TEMPLATE/architecture_proposal.md)
- [ADR template](./docs/adr/TEMPLATE.md)

This guide evolves with Orion. Changes to the process should be intentional, documented, and communicated — just like the code.
