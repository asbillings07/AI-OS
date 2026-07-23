# ADR-0015: Cache Advisory AI Outputs by Content, Not by Revision

> Status: Accepted
> Date: 2026-07-22 · Deciders: @asbillings07
> Related: #80, [ADR-0011](0011-ai-abstraction-layer.md), [ADR-0009](0009-storage-strategy.md)

## Context

`readMissionControl` calls `ai.summarize()` for every thread Work Item on every render, with no caching. That is negligible against the default deterministic provider ([ADR-0011](0011-ai-abstraction-layer.md)) but becomes a real cost and latency surprise the moment a live provider is configured (`ORION_AI_API_KEY`) — the same live-provider work is redone on every render of an unchanged item. This was called out as a hard prerequisite before sustained live-provider usage when the Gmail integration and its reliability hardening shipped (#64/#67), and became the next concrete engineering slice once Personal Importance (#65) closed.

## Why now?

The Personal Importance dogfood (#79) is the first sustained, real-inbox usage of the decision loop. Caching is independent of that dogfood and does not block it — the deterministic provider makes AI cost irrelevant for now — but it is a prerequisite for the next piece of work that *does* need a live provider (User Understanding, #68/#71). Deciding the cache contract now, before a second AI-backed capability exists, keeps the design honest to one real caller instead of being shaped around speculative future usage.

## Decision

**We will cache validated AI advisory outputs in front of the unchanged `AiCapabilities` interface, keyed by content rather than by revision.**

- **The cache never changes what a caller can ask for.** It is a decorator around `AiCapabilities` ([ADR-0011](0011-ai-abstraction-layer.md)), not a new capability and not a change to `SummarizeRequest`/`ClassifyRequest`/`AiCapabilities`. A caller cannot tell, from the type system, whether caching is present.
- **Only a validated success is cacheable.** The cache sits in front of `AiLayer`, never a raw `AiProvider` — anything `AiLayer` throws (malformed, empty, aborted) never reaches the cache; anything it returns without throwing, including a coerced result, is a legitimate entry. Failures are never memoized.
- **The key is content-addressed, not revision-addressed.** It is built from the capability, an order-preserving normalized snapshot of the meaningful request fields (label order is never sorted — both providers' fallback and tie-break behavior is order-dependent), a prompt-contract version, an output-schema version, and the execution profile (provider + opaque model label). Two requests with identical meaningful content reuse a result even if they originated from different Events — a byte-identical new occurrence is still a hit. This deliberately avoids adding a revision/event-id parameter to the capability contract, which would itself be a contract change.
- **Concurrent identical requests coalesce onto one shared, in-flight promise.** A cache entry is created and stored *before* the call it represents is awaited, so a burst of callers for the same key all join the same call rather than fanning out.
- **Retention is bounded, and a pending entry is never subject to that bound.** An entry transitions from `pending` to `resolved` only on success; the retention clock starts at that transition, and only resolved entries are ever evicted (for age or for capacity, oldest-since-resolution first). A request that is still running cannot be starved by eviction of its own in-flight entry.
- **The cache is disposable, in-memory, per-process state — never written to the event log.** It is derived, not truth ([ADR-0009](0009-storage-strategy.md)); a process restart clears it, and that is correct.
- **Observability distinguishes a completed request from a cache eviction, and a hit/coalesced join from an actual provider invocation.** These are different moments with different honest fields (a hit has no meaningful "did the provider run" latency; an eviction has no "ok"/confidence at all) and are never collapsed into one fabricated shape.
- **Enabled by default.** The point of this ADR is that re-rendering an unchanged Work Item must not re-invoke a live provider out of the box, not behind an opt-in flag.

## In one sentence

> A cached advisory output is identified by what was asked and under what contract it was answered, never by which Event triggered asking it.

## Consequences

- **Positive:** A live provider becomes safe to use under repeated renders without a cost/latency surprise; the `AiCapabilities` boundary and ADR-0011's capability-only contract stay completely intact; cache correctness (coalescing, bounded retention, honest telemetry) is unit-testable independent of any real provider.
- **Negative / costs:** A second piece of concurrency-sensitive state to reason about correctly (pending vs. resolved, eviction ordering, coalescing); prompt/schema versioning is currently one coarse, hand-bumped constant rather than a real per-capability versioning system, so a subtle prompt change that isn't recognized as "different" risks a stale-but-undetected reuse until the constant is bumped.
- **Follow-ups / new constraints:** Finer-grained prompt versioning should arrive alongside real prompt templating, if/when that exists, rather than being invented speculatively now; this mechanism is a prerequisite for sustained live-provider use in User Understanding (#68/#71), which should build on it rather than inventing a second cache.

## Principles

- **Supports:** [Eng #7](../principles/engineering.md) (cost/latency/confidence observable at one chokepoint, not hidden by caching); [Eng #8](../principles/engineering.md) (the cache is a boundary-respecting adapter, not a leak of provider/model detail into application logic); [Eng #12](../principles/engineering.md) (defers finer prompt-versioning until it's earned); ADR-0009 (derived state stays disposable, not event-logged); ADR-0011 (the capability interface is the durable commitment; this sits entirely behind it).
- **Trade-offs:** Accepts a coarse, hand-maintained prompt-version constant now in exchange for not building speculative prompt-templating infrastructure before it is needed.

## Alternatives considered

- **Key by source revision (e.g. the thread's `latestEventId`) instead of content:** rejected — a new occurrence can carry byte-identical meaningful content, so this would produce unnecessary misses, and it would require adding a revision parameter to the capability contract, which ADR-0011 reserves as durable and unchanged.
- **Persist the cache (e.g. a SQLite table) so it survives a process restart:** rejected for v0.1 — the cache is definitionally derived and disposable ([ADR-0009](0009-storage-strategy.md)); persisting it would imply a durability guarantee this data was never meant to carry, for a cost (schema, migration, cleanup) not justified by the actual failure mode (a cold cache after restart is just a temporary run of misses).
- **Bake caching directly into `AiLayer`:** rejected — `AiLayer`'s job is validating/coercing provider output and recording usage; folding caching into it would couple two independently-testable concerns and make "does this provider result get cached" implicit rather than an explicit decorator any caller can see is or isn't present.
- **Sort `classify` labels for a set-based, order-independent key:** rejected — both providers currently exhibit order-dependent fallback/tie-break behavior on a no-match input, so this would be observably incorrect until a separate contract change made label order provably irrelevant to the result.
