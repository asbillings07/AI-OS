# ADR-0011: AI Abstraction Layer

> Status: Accepted
> Date: 2026-07-19 · Deciders: @asbillings07
> Related: #24 · builds on [ADR-0004](./0004-ai-recommends-rules-decide.md), [ADR-0010](./0010-skill-architecture.md) · relates to [ADR-0005](./0005-context-is-a-first-class-domain-object.md)

## Context

AI is one of Orion's primary capabilities, but the AI landscape moves faster than almost anything else in the stack — providers, models, pricing, and APIs change constantly. If provider SDKs and model names are scattered through the codebase, Orion becomes coupled to today's vendor, and swapping or mixing models becomes a cross-cutting rewrite. This directly threatens [Eng #8](../principles/engineering.md) (*the domain is permanent; integrations are temporary* — and a model provider is an integration).

There is also a safety dimension. [ADR-0004](./0004-ai-recommends-rules-decide.md) draws a hard line: AI advises, deterministic Rules decide and enforce. That line is far easier to hold if *all* AI flows through one place that can be observed, bounded, and validated, rather than being called ad hoc from anywhere.

## Why now?

The first slice summarizes and reasons over email — the first real AI calls. If those calls go straight to a provider SDK, that pattern spreads to every subsequent Skill and the coupling calcifies (the same "decide before the anti-pattern sets in" logic as [ADR-0005](./0005-context-is-a-first-class-domain-object.md)).

## Decision

**All AI access goes through a single AI Abstraction Layer, and the application asks for a *capability*, not a provider or model.** No provider-specific logic exists outside this layer.

The **durable contract**:

- **Capability-based, not model-based.** Callers ask for *"summarize this,"* *"extract these structured entities,"* *"reason about these priorities"* — never for "GPT-5" or "Claude." The layer decides which model serves a capability, so provider choice never leaks into application or [Skill](./0010-skill-architecture.md) logic.
- **Provider-agnostic by construction.** Concrete providers (hosted or local) live behind **adapters** ([Eng #8](../principles/engineering.md)); their SDKs and types never cross the boundary. Adding or swapping a provider is a localized change.
- **Structured, validated output.** The layer returns typed/structured results validated against a schema; malformed output is a handled error, not a surprise downstream. This is part of how the advisory/deterministic seam ([ADR-0004](./0004-ai-recommends-rules-decide.md)) is enforced — a model's output is *proposed*, then validated by deterministic code.
- **Advisory only.** The layer produces understanding and recommendations; it never takes a side-effecting Action. Tool/function calls it exposes route back through the Event Bus and deterministic Rules, never straight to the outside world ([ADR-0004](./0004-ai-recommends-rules-decide.md), [Eng #14](../principles/engineering.md)).
- **Observable and honest about confidence.** Token usage, latency, cost, success rate, and confidence are captured at this one chokepoint ([Eng #7](../principles/engineering.md)); uncertainty is represented, never hidden.
- **Prompts are managed, not scattered.** Prompt templates and system prompts are versioned artifacts owned by this layer, with Context injected via the [Context Query API](../architecture/context-query-api.md) ([ADR-0005](./0005-context-is-a-first-class-domain-object.md)) rather than each caller assembling raw retrieval.

**Deliberately not decided here (reversible, per [Eng #12](../principles/engineering.md)):** which provider(s) to use, and whether to build capability-based *routing* (cost/latency/quality/offline selection) now. v0.1 may wire a **single provider behind the capability interface** and add routing only when a second model earns its place ([Eng #9](../principles/engineering.md)). The interface is the commitment; the routing sophistication behind it is earned.

## In one sentence

> Orion asks for AI *capabilities*, never for a specific model or provider, and every AI call flows through one observable, advisory, provider-agnostic layer.

## Consequences

- **Positive:** Providers and models can change, mix, or run locally without touching application logic ([Eng #8](../principles/engineering.md)); the advisory/deterministic boundary ([ADR-0004](./0004-ai-recommends-rules-decide.md)) has a single enforcement point; cost/latency/quality are observable in one place; prompts stop sprawling.
- **Negative / costs:** The abstraction has a real design cost and can lag provider-specific features (the newest capability may not be exposed immediately); a capability interface is one more layer to maintain for the single-provider MVP.
- **Follow-ups / new constraints:** A capability router (model selection, fallback, cost/latency optimization) is a later addition behind the same interface; multimodal, ensembles, and local inference extend the abstraction rather than exposing provider APIs; Skills reach AI *only* through this layer.

## Principles

- **Supports:** [Eng #8](../principles/engineering.md) (provider is a replaceable integration), #4/#14 (advisory layer; deterministic gates for side effects), #3/#7 (single point for explainability, cost, and confidence), #12 (defer routing and provider choice).
- **Trade-offs:** Accepts an abstraction that may trail the latest provider feature, in exchange for never being coupled to a single vendor and keeping the safety boundary enforceable in one place.

## Alternatives considered

- **Direct provider SDK calls throughout the code:** rejected — couples Orion to one vendor and scatters the safety boundary; the exact anti-pattern this ADR prevents.
- **Model-based interface (callers request a named model):** rejected — leaks provider/model choice into application logic and defeats routing.
- **Full multi-provider routing built now:** rejected for v0.1 — premature ([Eng #9](../principles/engineering.md), #12); the interface allows it later without requiring it now.
- **An external AI gateway service:** a viable *implementation* of this layer later, but not required as the architecture; the contract is what matters, not where it runs.
