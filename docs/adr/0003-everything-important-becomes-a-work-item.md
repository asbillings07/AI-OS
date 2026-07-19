# ADR-0003: Everything Important Becomes a Work Item

> Status: Accepted
> Date: 2026-07-19 · Deciders: @asbillings07
> Related: #11, #17 (Domain Model), #4 (Core Domain Model), [Domain](../domain/)

## Context

Events are raw facts, and most of them don't need the user. But some do — an email that blocks someone, a contract that changed, a flight that moved. We need a single, consistent domain concept for "something that has risen to the level of deserving the user's attention or action," independent of which source it came from.

Without such a concept, every source and every UI would invent its own notion of "important thing," and prioritization, explanation, and recovery would fragment.

## Why now?

Prioritization, "why this?" explanation, Mission Control rendering, and the domain model all need a single canonical unit of "importance" to build against. Establishing it now prevents each of them from inventing its own incompatible notion.

## Decision

**Anything important enough to warrant the user's attention becomes a Work Item.** A Work Item is a source-agnostic domain object derived from one or more events. It carries what the user needs to decide or act: what it is, why it matters (its reasoning), its stakes/urgency, and its current state.

Work Items are *derived by Orion from awareness*, not manually created and groomed by the user (consistent with ADR-0001). They can be surfaced, ranked, explained, deprioritized, and retired.

## In one sentence

> Anything important enough to act on becomes a single, derived, source-agnostic Work Item.

## Consequences

- **Positive:** One uniform unit for prioritization (ADR-0006), explanation ("why this?"), and recovery. Cross-source items look and behave consistently. Mission Control renders Work Items, not raw email.
- **Negative / costs:** We must define what elevates an event (or cluster of events) into a Work Item, and how items are updated/merged/retired as new events arrive.
- **Follow-ups:** The domain model (#17, #4) formalizes Work Item structure and lifecycle; prioritization consumes Work Items.

## Principles

- **Supports:** Product #2 (surface decisions, not data), #4 (explain why), #7 (confidence); Engineering #5 (derived from events), #8 (source-agnostic domain).
- **Trade-offs:** Introduces a derivation layer (events → work items) with its own rules; accepted because a shared domain object is what makes decisions, explanations, and recovery coherent.

## Alternatives considered

- **Render raw source objects (emails, invites) directly**: rejected — vendor-shaped, inconsistent, no cross-source coherence.
- **User-created tasks**: rejected — contradicts ADR-0001 (no maintenance burden).
