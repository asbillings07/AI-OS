# ADR-0008: The Event Bus

> Status: Accepted
> Date: 2026-07-19 · Deciders: @asbillings07
> Related: #21 · builds on [ADR-0007](./0007-event-driven-architecture.md), [ADR-0002](./0002-everything-is-an-event.md) · relates to [ADR-0009](./0009-storage-strategy.md), [ADR-0010](./0010-skill-architecture.md)

## Context

[ADR-0007](./0007-event-driven-architecture.md) fixed the style: components react to a stream of events. That raises the immediate question of *the mechanism* — how events actually get from producers to consumers. Without a single canonical answer, components will invent point-to-point channels and the loose coupling won ADR-0007 evaporates.

The forces: many independent producers and consumers (adapters, the [Understanding Engine](../architecture/understanding-engine.md) and its parts, Skills, Agents, Mission Control, Notifications) need to communicate without knowing about each other. They need reliable delivery, the ability to replay, and a consistent event shape — but the MVP is single-user and in-process, so a distributed broker would be premature ([Eng #9](../principles/engineering.md), #12).

## Why now?

The first vertical slice (#18) will have a producer (the Gmail adapter) and consumers (normalization, the Understanding Engine). The moment a second component needs to hear about an event, we either route it through one canonical bus or start hard-wiring components together. Deciding the contract now keeps that first wiring correct.

## Decision

**A single logical Event Bus is the canonical — and only sanctioned — channel for inter-component communication.** Components publish events to it and subscribe to the events they care about; they never call one another directly to propagate a happening.

The **durable contract** (independent of any technology):

- **Publish/subscribe with fan-out.** Producers don't know their consumers; any component may subscribe to an event type.
- **Events are immutable** ([ADR-0002](./0002-everything-is-an-event.md)) and carry a consistent envelope: identifier, type, timestamp, source, payload, and metadata including **correlation** and **causation** ids (so an event's lineage is traceable — [Eng #3](../principles/engineering.md), #7) and a **version**.
- **Replayable.** Because events are persisted as the source of truth ([ADR-0009](./0009-storage-strategy.md)), consumers and projections can be rebuilt by replaying the stream.
- **Consumers are idempotent.** Delivery is assumed to be at-least-once; consumers must tolerate duplicates (dedupe by event id). This is a stronger, more portable guarantee to design against than exactly-once.
- **Ordering is guaranteed only within a correlated stream**, not globally. Components must not depend on a global total order.
- **Failure handling is explicit:** retries with a dead-letter path for events a consumer cannot process, surfaced observably rather than dropped.

**Deliberately not decided here (reversible implementation, per [Eng #12](../principles/engineering.md)):** the concrete transport. v0.1 uses a simple **in-process** bus; an external broker (or per-consumer queues, distributed processing, scheduled/prioritized events) is adopted only when scale or multi-process needs force it. Swapping the transport must not change the contract above — that is the whole point of naming the contract separately from the tool.

## In one sentence

> One logical, replayable pub/sub Event Bus is the only way Orion's components talk; the transport behind it is a replaceable detail.

## Consequences

- **Positive:** Coupling stays flat — new components subscribe without touching existing ones; uniform, traceable event envelope enables explainability and audit; replay falls out of persistence + immutability; the in-process start keeps v0.1 trivial to run and test.
- **Negative / costs:** At-least-once + idempotency pushes real work onto every consumer; correlation/causation discipline must be maintained from the start; a single logical bus is a conceptual chokepoint that must stay observable.
- **Follow-ups / new constraints:** [Storage Strategy](./0009-storage-strategy.md) persists the event log the bus replays from; [Skill Architecture](./0010-skill-architecture.md) mandates that Skills communicate only via the bus; observability (event tracing, metrics) is required, not optional ([Eng #7](../principles/engineering.md)).

## Principles

- **Supports:** [Eng #5](../principles/engineering.md) (events source of truth / replay), #6 (composition), #8 (domain permanent — the envelope is ours, the transport is swappable), #12 (defer the broker until forced).
- **Trade-offs:** Accepts per-consumer idempotency complexity and the absence of global ordering in exchange for portability across transports and honest, at-least-once delivery semantics.

## Alternatives considered

- **Direct service-to-service calls:** rejected — recreates the coupling ADR-0007 exists to avoid.
- **Committing to a specific broker now (e.g. Kafka/NATS/Redis Streams):** rejected as an *ADR-level* decision — it fails the durability test and violates "prefer reversible decisions" ([Eng #12](../principles/engineering.md)). The choice lives in code when needed.
- **Exactly-once delivery as the contract:** rejected — expensive, transport-specific, and often illusory; at-least-once + idempotent consumers is simpler and more portable.
- **Global total ordering:** rejected — unnecessary for correctness and a scalability trap; per-correlation ordering is sufficient.
