# Domain

> Primary question: **What actually exists in Orion's universe?**
> Related issues: #16 Ubiquitous Language · #17 Orion Domain Model · #4 Core Domain Model · #5 Event Lifecycle

**The domain model is Orion's view of reality.** Every feature, event, recommendation, and decision ultimately maps back to the concepts defined here. If a concept doesn't belong in the domain, it shouldn't appear in the product. Get the domain right and the rest of the system becomes one implementation of it; get it wrong and no amount of engineering will save the product from incoherence.

This folder defines Orion's **ubiquitous language** — the shared vocabulary used consistently across code, documents, and conversation. The same concept must always have the same name and the same meaning, everywhere.

## A note on stability

The goal of this folder is **stability**. Features, integrations, and AI models will change constantly; the domain language should change *rarely*. If the ubiquitous language is churning, it's a sign Orion is still learning what it is. A stable domain is evidence of a mature understanding of the problem.

## The mental model (start here)

Orion is not a linear pipeline — it's a **loop**. Human decisions produce new events, which reshape context, which produce new recommendations. The single most important conceptual artifact in the repository is that loop:

**[mental-model.md](./mental-model.md)** — one page, one diagram, one explanation of how reality flows through Orion and back. Read it before reading any code.

```
Reality → Events → Context → Signals → Work Items → Recommendations → Human Decision ─┐
   ▲                                                                                   │
   └───────────────────────────── new events ─────────────────────────────────────────┘
```

Everything in Orion exists to improve a *future human decision*. That is the domain's deepest abstraction.

---

## Core concepts

The nouns that make up Orion's reality. (Definitions are formalized via #16/#17/#4/#5; the list and intent are fixed here.)

- **Event** — an immutable record that something happened.
- **Source** — the external system an event originates from (Gmail, Calendar, GitHub, bank, travel, weather…). *Source is a domain concept*; the **adapter** that talks to it is a technical concept. Sources translate their native data into Orion's domain model through adapters.
- **Context** — the continuously-evolving understanding of the user's situation, derived from events.
- **Signal** — a meaningful pattern or change detected within context.
- **Work Item** — something important enough to warrant the user's attention or action (see ADR-0003).
- **Recommendation** — an advisory suggestion produced by reasoning, always explainable.
- **Relationship** — a first-class connection *between* concepts (an email *belongs to* a project; a flight *conflicts with* a meeting; a deadline *affects* a work item). Context is largely built from relationships. (Likely v-next, but reserved in the language now.)
- **Rule** — deterministic logic that decides or enforces (see ADR-0004).
- **Attention** — the user's scarce resource that the whole system optimizes for (see ADR-0006).

## How each concept is documented

Every domain concept should eventually answer the same **four questions**, so the model stays consistent and complete:

1. **Definition** — what it is, in one precise sentence.
2. **Why it exists** — the reason it's in the domain at all.
3. **Lifecycle** — the states it moves through.
4. **Relationships** — how it connects to other concepts.

### Worked example: Event

- **Definition:** An immutable record that something happened.
- **Why:** Events preserve history and let Orion reconstruct context over time; understanding compounds because nothing is lost (Engineering #5).
- **Lifecycle:** `Created → Normalized → Enriched → Archived`.
- **Relationships:** originates from a **Source**; creates or updates **Context**; may generate **Signals**; may contribute to **Work Items**; can participate in **Recommendations**.

The remaining concepts get the same treatment as the domain-modeling issues land.

---

## Folder structure (as it grows)

The README introduces; individual documents become the authority:

- `mental-model.md` — the canonical loop (the mental model for everyone joining).
- `domain-model.md` — the concepts and their four-question definitions (#17, #4).
- `lifecycle.md` — event and work-item lifecycles (#5).
- `relationships.md` — how concepts relate (when relationships become first-class).

## Related ADRs

Several foundational ADRs define how these concepts behave: [Everything is an Event](../adr/0002-everything-is-an-event.md) (0002), [Everything important becomes a Work Item](../adr/0003-everything-important-becomes-a-work-item.md) (0003), [Context is a first-class domain object](../adr/0005-context-is-a-first-class-domain-object.md) (0005), [Attention is the primary resource](../adr/0006-attention-is-the-primary-resource.md) (0006).
