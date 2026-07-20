# ADR-0007: Event-Driven Architecture

> Status: Accepted
> Date: 2026-07-19 · Deciders: @asbillings07
> Related: #20 · builds on [ADR-0002](./0002-everything-is-an-event.md) · precedes [ADR-0008](./0008-event-bus.md), [ADR-0009](./0009-storage-strategy.md)

## Context

Orion's job is to observe changes across many systems (email, calendar, GitHub, finances, travel) and turn them into understanding. Those changes are naturally *events*: an email arrives, a meeting begins, an issue is assigned, a Skill finishes running.

[ADR-0002](./0002-everything-is-an-event.md) already established the domain stance — *everything is an Event* — as a philosophy: facts are immutable and history is never lost. This ADR takes the next step and fixes the **architectural style** that follows from it: how components are wired together at runtime. The question is not "should facts be events" (decided) but "should components react to a flowing stream, or call each other directly."

The forces in tension: Orion will accumulate many capabilities (ingestion adapters, the [Understanding Engine](../architecture/understanding-engine.md) and its parts, Skills, Agents, Mission Control). If these call each other directly, coupling grows combinatorially and adding a capability means editing existing ones. Orion also needs replay, auditability, and the ability to reinterpret history as models improve — all of which favor reacting to a durable stream over synchronous call graphs.

## Why now?

This is the root architectural decision the other technology ADRs (Event Bus, Storage, Skill Architecture, AI Abstraction) build on; they cannot be coherent without it. Deciding before the first vertical slice (#18) is written prevents the default drift into direct service-to-service calls, which is expensive to unwind once components exist.

## Decision

**Orion is event-driven: components react to a flowing stream of immutable events rather than calling each other directly.** Producing and reacting to events is the primary integration pattern across the platform.

Specifically:

- Ingestion adapters translate external happenings into Orion **Events** (never leaking vendor shape — [Eng #8](../principles/engineering.md)).
- The Understanding Engine and Skills **consume** events and **emit** new events (including Orion's own [Observations](../domain/ubiquitous-language.md)); they do not reach into each other.
- Processing is **asynchronous and loosely coupled** by default; direct synchronous calls are the exception, reserved for cases that genuinely need a request/response answer (e.g. a query through the [Context Query API](../architecture/context-query-api.md)).
- The concrete transport (in-process dispatch for v0.1 vs. an external broker later) is deliberately **not** decided here — that is a reversible implementation choice ([Eng #12](../principles/engineering.md)) captured in [ADR-0008](./0008-event-bus.md) and code, not a durable architectural commitment.

## In one sentence

> Orion's components cooperate by reacting to a stream of immutable events, not by calling each other.

## Consequences

- **Positive:** Loose coupling and extensibility — new capabilities subscribe to events without modifying existing ones; natural fit for replay, audit, and reinterpreting history ([Eng #5](../principles/engineering.md), #11); failure isolation (a slow consumer doesn't block producers); a single, uniform mental model ("events flow through the system").
- **Negative / costs:** Asynchronous systems are harder to trace and reason about than linear call stacks; eventual consistency must be designed for; observability (tracing an event's journey) becomes essential rather than optional ([Eng #7](../principles/engineering.md)).
- **Follow-ups / new constraints:** The [Event Bus](./0008-event-bus.md) (#21) defines the mechanism; the [Storage Strategy](./0009-storage-strategy.md) (#22) defines events as the source of truth; [Skills](./0010-skill-architecture.md) (#23) communicate only through events. Request/response is allowed only for genuine queries, never to smuggle in tight coupling.

## Principles

- **Supports:** [Eng #5](../principles/engineering.md) (events are the source of truth), #6 (composition over intelligence — pipelines of small parts), #8 (domain permanent; integrations temporary), #11 (age gracefully via append-only history).
- **Trade-offs:** Accepts the added complexity of asynchronous reasoning and the observability burden (#7) in exchange for coupling that stays flat as the platform grows.

## Alternatives considered

- **Traditional layered / request-response architecture:** rejected — components would call each other directly, coupling grows with every capability, and replay/audit become bolt-ons.
- **Service-oriented / microservices from day one:** rejected — premature for a single-user MVP ([Eng #9](../principles/engineering.md), #12); distribution is an implementation option to earn later, not a starting architecture.
- **Workflow engine orchestration:** rejected as the *primary* model — centralized orchestration reintroduces coupling and fights the "compose small reactive parts" stance (#6).
- **Actor model:** shares the message-passing spirit and remains a viable *implementation* of consumers, but is not required as the platform-level contract; the event stream is the contract.
