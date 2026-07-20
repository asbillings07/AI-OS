# ADR-0006: Attention is the Primary Resource

> Status: Accepted
> Date: 2026-07-19 · Deciders: @asbillings07
> Related: #11, #29 (Prioritization Engine), [Vision](../vision/vision.md), [Product Principles](../principles/product.md)

## Context

Most systems optimize for a resource: compute, storage, throughput, engagement, or user time-in-app. What a system optimizes for shapes every decision it makes. If Orion implicitly optimized for engagement or completeness, it would slowly become the very thing it exists to fight — another noisy tool competing for the user.

Orion's founding belief is that the user's **attention** is the scarce, valuable, protectable resource.

## Why now?

The optimization function must be fixed before the Prioritization Engine (#29) and the product's metrics are designed — otherwise the system quietly drifts toward measurable-but-wrong targets like engagement. Naming the right objective now prevents that drift.

## Decision

**Attention is Orion's primary resource, and the system optimizes to protect it.** This is the objective function the whole product is measured against. Every capability must answer: *"Does this help the user spend their attention better?"* — and if not, it doesn't belong.

Operationally: prioritization exists to spend attention well; the product succeeds when the user needs it *less*, not more; silence is a valid and valuable output.

## In one sentence

> Orion optimizes for protecting human attention above all other measurable outcomes.

## Consequences

- **Positive:** A single, coherent objective that resolves feature debates and prevents drift toward engagement metrics; makes "show less," "stay quiet," and "give permission to ignore" first-class outcomes rather than compromises.
- **Negative / costs:** We deliberately forgo engagement-based growth tactics and "more is better" instincts; success is partly qualitative (confidence, calm) and harder to measure than DAU.
- **Follow-ups:** The Prioritization Engine (#29) is the concrete mechanism for allocating attention; metrics must instrument attention outcomes, not engagement (Engineering #7).

## Principles

- **Supports:** Vision (attention as the resource); Product #1 (protect attention), #3 (clarity over completeness), #6 (calm, never optimize for engagement), #7 (confidence).
- **Trade-offs:** Accepts slower, non-engagement-driven growth and fuzzier success metrics in exchange for staying true to the product's entire reason to exist.

## Alternatives considered

- **Optimize for engagement / time-in-app**: rejected — directly opposed to the mission; would make Orion another attention thief.
- **Optimize for completeness / coverage**: rejected — "show everything" recreates the overload we're solving.
