# ADR-0002: Everything is an Event

> Status: Accepted
> Date: 2026-07-19 · Deciders: @asbillings07
> Related: #11, #5 (Event Lifecycle), #20 (Event-Driven Architecture), [Engineering Principles](../principles/engineering.md), [Domain](../domain/)

## Context

Orion ingests information from many heterogeneous sources (email, calendar, code, messages, finance, travel) and must reason across them over time. If each source is modeled with its own bespoke shape and mutable state, integrations become load-bearing, history is easily lost, and cross-source reasoning becomes ad hoc.

We also believe understanding *compounds* — no event exists in isolation, and value grows as context accumulates (Engineering #5, #11). That only works if the raw material is preserved and uniformly shaped.

## Why now?

The v0.1 Gmail ingestion pipeline (#6) and every downstream capability sit on top of this substrate. Choosing the data foundation late would force a rewrite of everything built on it, so it must be decided before ingestion begins.

## Decision

**Every fact Orion observes about the user's world is represented as an immutable Event.** All sources are normalized into a common event model and appended to an event log. Derived state (context, priorities, summaries, work items) is a *projection* of events and can always be rebuilt by replay.

Events are facts ("this happened"); they are never mutated or deleted as a routine operation.

## In one sentence

> Orion models reality as immutable events from which every other understanding is derived.

## Consequences

- **Positive:** One uniform substrate for all sources and all reasoning; complete, replayable history; the ability to explain past decisions; new projections can be built retroactively over old events.
- **Negative / costs:** Storage grows; we must design event schemas and versioning carefully; projections add indirection vs. reading a mutable row.
- **Follow-ups:** Event Lifecycle (#5), Event Bus (#21), and Storage Strategy (#22) ADRs build on this. Privacy-driven deletion is the deliberate exception (ADR/Engineering #13).

## Principles

- **Supports:** Engineering #5 (events as source of truth), #6 (composition — pipelines over monoliths), #11 (age gracefully), #8 (permanent domain, replaceable adapters).
- **Trade-offs:** Accepts storage growth and projection complexity to gain longevity, explainability, and compounding understanding.

## Alternatives considered

- **Per-source mutable models / CRUD**: rejected — loses history, hard to reason across sources, integrations become load-bearing.
- **Cache raw API responses only**: rejected — vendor-shaped, not a durable domain substrate.
