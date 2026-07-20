# Architecture

> Primary question: **How is the system structured?**

This folder documents Orion's system structure: boundaries, event flows, adapters, component relationships, and the machinery that turns events into understanding. Architecture documents describe *how the pieces fit*; the *why* behind significant choices lives in [ADRs](../adr/), which architecture docs should cite rather than re-argue.

Architecture is expected to evolve with implementation. It must stay aligned with the [principles](../principles/) — every structural choice should be traceable to a principle or an ADR.

## Expected documents (to be established)

- **Reasoning model** — the conceptual pipeline: Raw Events → Normalized Events → Context → Signals → Understanding → Priorities → Recommendations → Actions. (Surfaced as a high-value future doc; may live here or at `docs/reasoning-model.md`.)
- **Context Engine architecture** — via #25 and its children (#26–#31): opportunity detection, timeline model, context lifecycle, prioritization engine, context query API, memory model.
- **Event flow & adapters** — how sources are ingested behind replaceable adapters (#8 engineering principle).

## Related ADRs

Event-Driven Architecture (#20), Event Bus (#21), Storage Strategy (#22), Skill Architecture (#23), AI Abstraction Layer (#24).
