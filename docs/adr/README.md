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

These establish *how Orion is built*. Each records a **durable, vendor-agnostic stance** — none picks a specific database, broker, or model provider, because those fail the durability test and are deferred until reality forces them ([Eng #12](../principles/engineering.md)):

| ADR | Decision | Status |
|---|---|---|
| [0007](./0007-event-driven-architecture.md) | Event-Driven Architecture | Accepted |
| [0008](./0008-event-bus.md) | The Event Bus (one canonical, replayable pub/sub channel) | Accepted |
| [0009](./0009-storage-strategy.md) | Storage Strategy (events are the source of truth; the rest is projection) | Accepted |
| [0010](./0010-skill-architecture.md) | Skill Architecture (extend via events and Context, never the core) | Accepted |
| [0011](./0011-ai-abstraction-layer.md) | AI Abstraction Layer (ask for capabilities, not providers) | Accepted |
| [0012](./0012-attention-is-a-projection-distinct-from-context.md) | Attention is a Projection, Distinct from Context (source-neutral suppression) | Accepted |
| [0013](./0013-gmail-authorization-and-credential-storage.md) | Gmail Authorization and Credential Storage (server-side OAuth, encrypted refresh token, read-time sync) | Accepted |
| [0014](./0014-personal-importance-from-dispositions.md) | Personal Importance Learned from Attention Dispositions (source-neutral, rebuildable behavioral ranking signal) | Accepted |
| [0015](./0015-cache-advisory-ai-outputs.md) | Cache Advisory AI Outputs by Content, Not by Revision (disposable, content-addressed, coalesced) | Accepted |

(Note: some GitHub issue titles use provisional labels like "ADR-002: Event Bus." Those labels predate this numbering scheme; the canonical ids are assigned here when the ADR is written — e.g. issue #21 became ADR-0008.)

## Decision dependency graph

How the accepted decisions build on one another — philosophy at the top, technology stances below. An arrow means "rests on":

```
                 0001 Situational awareness (what Orion is)
                          │
   ┌──────────────┬───────┼───────────────┬───────────────┐
   ▼              ▼       ▼               ▼               ▼
0002 Events   0003 Work  0004 AI advises 0005 Context   0006 Attention
   │           Item      / Rules decide  first-class     is primary
   │              │           │               │               │
   ▼              │           │               │               │
0007 Event-driven architecture              │               │
   │                                          │               │
   ▼                                          │               │
0008 Event Bus                                │               │
   │                                          │               │
   ▼                                          │               │
0009 Storage strategy                         │               │
   │                                          │               │
   └───────────────┬──────────────────────────┘               │
                   ▼                                            │
             0010 Skill architecture  ◀── 0004, 0005           │
                   │                                            │
                   ▼                                            │
             0011 AI abstraction layer ◀── 0004, 0005, and the attention objective (0006)
```

Read top-down for onboarding: the philosophy ADRs (0001–0006) fix *how Orion thinks*; the technology ADRs (0007–0011) fix *how it is built*, each a consequence of the philosophy above it.

## How to write an ADR

1. Copy [`TEMPLATE.md`](./TEMPLATE.md) to `NNNN-your-title.md` using the next free number.
2. Fill in Context → Decision → Consequences.
3. **Cite the principles** it supports or trades off, in the `## Principles` section. This is required — it keeps the constitution and the architecture in a feedback loop (Engineering Principles → "The living feedback loop"). Every significant PR and ADR should be traceable to a principle.
4. Open it as **Proposed**, discuss, then mark **Accepted**.

## Related

- [Engineering Principles](../principles/engineering.md) — the constitution ADRs cite
- [Product Principles](../principles/product.md) · [Product Vision](../vision/vision.md)
- [Domain](../domain/) — concepts several of these ADRs define
