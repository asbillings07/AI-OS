# ADR-0010: Skill Architecture

> Status: Accepted
> Date: 2026-07-19 · Deciders: @asbillings07
> Related: #23 · builds on [ADR-0007](./0007-event-driven-architecture.md), [ADR-0008](./0008-event-bus.md), [ADR-0004](./0004-ai-recommends-rules-decide.md), [ADR-0005](./0005-context-is-a-first-class-domain-object.md)

## Context

Orion's long-term value comes from growing — Gmail today, then Calendar, GitHub, finance, travel, and beyond. If every capability is wired directly into the core, the core becomes a monolith that must be edited for each addition, and coupling grows without bound. Orion needs an **extensibility model**: a way to add capability without adding coupling.

The [Ubiquitous Language](../domain/ubiquitous-language.md) already names this unit a **Skill** (not "plugin" — a plugin is an implementation detail; a Skill is a capability the user recognizes: "the GitHub Skill found a stalled PR"). What remains is to fix the *architectural contract* a Skill must obey.

## Why now?

Even the Gmail-only MVP is, in effect, the first Skill. If it is built by reaching directly into the core and other components, it sets the template every future capability copies. Establishing the contract before the first Skill exists is what keeps the second, third, and tenth from calcifying a bad pattern ([Eng #8](../principles/engineering.md), #10).

## Decision

**A Skill is a modular, self-contained capability that extends Orion exclusively through events and Context — never by modifying the core or reaching into other Skills.**

The **contract** (durable, independent of any packaging/runtime technology):

- **A Skill communicates only through the [Event Bus](./0008-event-bus.md) and the [Context Query API](../architecture/context-query-api.md).** It consumes events, publishes events, and asks Context "what should I know?" It does **not** call other Skills directly or share global state with them ([ADR-0007](./0007-event-driven-architecture.md)).
- **A Skill may:** consume/publish events, process information, call external systems *behind an adapter* ([Eng #8](../principles/engineering.md)), generate Insights/Recommendations, contribute Work Items to Mission Control, and declare configuration.
- **A Skill may not:** modify core behavior, bypass platform services (bus, Context, storage), own global application state, or take an irreversible Action without passing through deterministic [Rules](../domain/ubiquitous-language.md) ([ADR-0004](./0004-ai-recommends-rules-decide.md)).
- **Skills are advisory by default.** Producing Recommendations is the norm; side-effecting Actions are gated ([ADR-0004](./0004-ai-recommends-rules-decide.md), [Eng #14](../principles/engineering.md)).
- **A Skill declares itself** via metadata/manifest (identity, the events it consumes/produces, configuration, and — later — the permissions it needs), so the platform can discover and configure it without hard-coding.
- **Lifecycle:** a Skill moves through *register → configure → initialize → run (consume/produce) → suspend/resume → upgrade → remove*. The platform owns this lifecycle; a Skill must tolerate being started, stopped, and replaced.

**Deliberately not decided here (reversible, per [Eng #12](../principles/engineering.md)):** how Skills are packaged and isolated — in-process modules for v0.1 ([Eng #9](../principles/engineering.md)); sandboxing, resource limits, separate processes, an SDK, a marketplace, and a full permission model are earned later. The contract above must survive those changes.

## In one sentence

> A Skill extends Orion only through events and Context — never by touching the core or other Skills — and is advisory unless it passes an Action through deterministic Rules.

## Consequences

- **Positive:** Capabilities are added without editing the core (open for extension, closed for modification); failure in one Skill is isolated behind the bus; the same contract scales from one in-process Skill to many independently-developed ones; "install the X Skill" becomes real product language.
- **Negative / costs:** The event/Context-only rule can feel indirect for simple cases (no quick direct call); a manifest/lifecycle adds ceremony even for the first Skill; a genuine permission/isolation model is deferred, so early Skills run trusted.
- **Follow-ups / new constraints:** A future ADR covers the permission/sandboxing model when untrusted or third-party Skills arrive; the [AI Abstraction Layer](./0011-ai-abstraction-layer.md) is how Skills reach AI (never a provider SDK directly); adapter boundaries ([Eng #8](../principles/engineering.md)) apply to every external call a Skill makes.

## Principles

- **Supports:** [Eng #6](../principles/engineering.md) (composition — small capabilities over a monolith), #8 (integrations behind adapters), #9 (in-process first), #10 (design for one, architect for many), #4/#14 (advisory; Rules gate side effects).
- **Trade-offs:** Accepts indirection and manifest/lifecycle ceremony in exchange for an extensibility model whose coupling stays flat as Orion grows.

## Alternatives considered

- **Monolithic core with capabilities built in:** rejected — every addition edits the core; coupling and review cost grow without bound.
- **Traditional plugin system (direct plugin-to-host and plugin-to-plugin calls):** rejected — recreates coupling and bypasses the event model ([ADR-0007](./0007-event-driven-architecture.md)).
- **Microservices per capability now:** rejected — premature distribution for a single-user MVP ([Eng #9](../principles/engineering.md), #12); the contract permits it later without requiring it now.
- **Dynamic scripting with core access:** rejected — unbounded access to core state defeats isolation and safety ([ADR-0004](./0004-ai-recommends-rules-decide.md)).
