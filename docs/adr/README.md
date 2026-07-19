# Architecture Decision Records (ADRs)

> Primary question: **Why was this decision made?**
> Related issues: #3 Create the ADR Framework · #11 Establish the ADR Strategy

An **ADR** captures a significant decision, the context that forced it, and its consequences — so that years from now, anyone can understand *why* Orion is the way it is, even after the code and vendors have changed. ADRs are how we preserve reasoning, not just outcomes.

**An ADR records a decision, not a discussion.** If a decision has not yet been made, capture the exploration in an issue or a design document instead — an ADR is written when there is something to *decide*, not to think out loud. This keeps ADRs from becoming design journals.

Orion's ADRs are unusual in one deliberate way: **we establish product philosophy and domain decisions before technology decisions.** Most projects start with "use PostgreSQL / use React." We start with "Orion is a situational awareness system," "everything is an event," "AI recommends, rules decide." Technology choices may change; these should not.

---

## Lifecycle

Every ADR has a status:

- **Proposed** — drafted and under discussion; not yet binding.
- **Accepted** — the decision is in force. Code and other docs should comply.
- **Superseded** — replaced by a later ADR. Must link to the ADR that replaces it (and vice versa). The old ADR is kept, never deleted (history is never lost — Engineering Principle #5).
- **Deprecated** — no longer relevant, but not directly replaced.

An accepted ADR is not edited to change its decision; instead a *new* ADR supersedes it. Typos and clarifications may be edited in place.

**ADRs age — that's the point.** Older ADRs are not expected to represent current architecture; their purpose is to preserve historical context. The *current* architectural position is the chain of **Accepted** ADRs after accounting for any superseding decisions. A superseded ADR is not wrong or obsolete clutter — it's the record of how we got here.

## Numbering

- ADRs are numbered sequentially with a **4-digit, zero-padded** id: `0001`, `0002`, … Numbers are **never reused**, even for superseded/deprecated ADRs.
- Filenames: `NNNN-kebab-case-title.md` (e.g. `0002-everything-is-an-event.md`).
- The number is permanent; the title may be lightly clarified but the id never changes.

## Foundational ADR roadmap (philosophy first)

These six establish *how Orion thinks*. They come before any technology ADR (per #11):

| ADR | Decision | Status |
|---|---|---|
| [0001](./0001-situational-awareness-not-task-manager.md) | Orion is a Situational Awareness System, not a Task Manager | Accepted |
| [0002](./0002-everything-is-an-event.md) | Everything is an Event | Accepted |
| [0003](./0003-everything-important-becomes-a-work-item.md) | Everything important becomes a Work Item | Accepted |
| [0004](./0004-ai-recommends-rules-decide.md) | AI Recommends, Rules Decide | Accepted |
| [0005](./0005-context-is-a-first-class-domain-object.md) | Context is a First-Class Domain Object | Accepted |
| [0006](./0006-attention-is-the-primary-resource.md) | Attention is the Primary Resource | Accepted |

## When technology ADRs become appropriate

Implementation ADRs (database, framework, hosting, AI provider, event bus, storage, etc.) are written **only after** the foundational ADRs above are accepted, and **only when** a decision is (a) significant, (b) hard to reverse, and (c) actually needed now (Engineering Principle #12, *Prefer reversible decisions* — don't decide until reality forces it).

**The durability test — what deserves an ADR:** *If the decision would still matter after replacing every technology in the stack, it probably deserves an ADR.* The six foundational ADRs pass this trivially (they never mention a vendor). Most day-to-day technology choices (Redis, a CSS framework, a logging library, CI details) do **not** — capture those in code, comments, or an issue. Reserve ADRs for decisions whose *reasoning* must outlive the tools.

The technology decisions already scoped as issues become ADRs `0007+` when their time comes:

- Event-Driven Architecture (#20), Event Bus (#21), Storage Strategy (#22), Skill Architecture (#23), AI Abstraction Layer (#24).

(Note: some GitHub issue titles use provisional labels like "ADR-002: Event Bus." Those labels predate this numbering scheme; the canonical ids are assigned here when the ADR is written.)

## How to write an ADR

1. Copy [`TEMPLATE.md`](./TEMPLATE.md) to `NNNN-your-title.md` using the next free number.
2. Fill in Context → Decision → Consequences.
3. **Cite the principles** it supports or trades off, in the `## Principles` section. This is required — it keeps the constitution and the architecture in a feedback loop (Engineering Principles → "The living feedback loop"). Every significant PR and ADR should be traceable to a principle.
4. Open it as **Proposed**, discuss, then mark **Accepted**.

## Related

- [Engineering Principles](../principles/engineering.md) — the constitution ADRs cite
- [Product Principles](../principles/product.md) · [Product Vision](../vision/vision.md)
- [Domain](../domain/) — concepts several of these ADRs define
