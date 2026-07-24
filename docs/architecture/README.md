# Architecture

> Primary question: **How is the system structured?**

This folder documents Orion's system structure: boundaries, event flows, adapters, component relationships, and the machinery that turns events into understanding. Architecture documents describe *how the pieces fit*; the *why* behind significant choices lives in [ADRs](../adr/), which architecture docs should cite rather than re-argue.

Architecture is expected to evolve with implementation. It must stay aligned with the [principles](../principles/) — every structural choice should be traceable to a principle or an ADR.

## Implementation

- [The First Vertical Slice](./vertical-slice.md) (#18) — the first end-to-end implementation: a Gmail message flows through the event backbone, the Understanding Engine, Opportunity/Capacity/Prioritization, and into Mission Control, with a user action closing the loop. Shows exactly how the ADRs map to code.
- [The Second Slice](./second-slice.md) (#44–#46) — a structurally different source (GitHub) flows through the *same* backbone. Shows what generalized cleanly, what the second source forced the core to learn (Subjects, the Attention projection, revision-scoped actions), and why cross-source correlation is deferred as the next domain trigger.

## The Understanding Engine

The **Understanding Engine** (formerly "Context Engine", #25) is the subsystem that owns the entire middle layer of the [Mental Model](../domain/mental-model.md) — everything between Reality and Decision:

```
  Reality  ──▶  Understanding Engine  ──▶  Decision  ──▶  Mission Control
```

It turns the raw event stream into meaning. Its documents, in reading order:

- [Understanding Engine](./understanding-engine.md) (#25) — the anchor: responsibilities, boundaries, and how the pieces fit.
- [Context Lifecycle](./context-lifecycle.md) (#28) — how Context is created, enriched, resolved, and archived ("facts are forever; context is temporary").
- [Timeline](./timeline.md) (#27) — the past: how persisted things are viewed over time.
- [Memory](./memory.md) (#31) — the permanent: durable knowledge, distinct from transient Context.
- [Capacity](./capacity.md) (#10) — an *input*: how effectively the user can act right now.
- [Opportunity Detection](./opportunity-detection.md) (#26) — what is *derived*: situations worth acting on.
- [Prioritization Engine](./prioritization-engine.md) (#29) — combining Opportunity, Capacity, Commitment, Urgency, and Personal Context into a ranked, explainable list.
- [Candidate Belief Extraction](./candidate-belief-extraction.md) (#71) — provider-neutral natural-language candidate belief extraction boundary with verbatim evidence grounding.
- [Context Query API](./context-query-api.md) (#30) — the semantic contract: ask for meaning, not data.

## Other expected documents (to be established)

- **Reasoning model** — the conceptual pipeline: Raw Events → Normalized Events → Context → Signals → Understanding → Priorities → Recommendations → Actions. (May live here or at `docs/reasoning-model.md`.)
- **Event flow & adapters** — how sources are ingested behind replaceable adapters (#8 engineering principle).
- **Understanding & confidence** — reasoning about uncertainty, confidence, and conflicting or missing signals. (Deferred; the seam is visible but out of scope for the first Understanding Engine pass.)
- **Hypothesis (in reserve)** — a possible first-class layer for *tentative* interpretations between Context and Opportunity, so inferences carry evidence before being promoted (Event → Context → Hypothesis → Evidence → Opportunity). Not planned yet; recorded so the idea isn't lost.

## Related ADRs

Event-Driven Architecture (#20), Event Bus (#21), Storage Strategy (#22), Skill Architecture (#23), AI Abstraction Layer (#24).
