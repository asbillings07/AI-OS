import { randomUUID } from "node:crypto";

/**
 * The immutable Event envelope (ADR-0002: everything important is an Event).
 *
 * Events are facts: they describe something that happened, are never mutated,
 * and are the single source of truth (ADR-0009). Everything else in Orion is a
 * projection derived by replaying these.
 *
 * The envelope is deliberately domain-centric. It carries no knowledge of any
 * integration (Eng #8): `source` is a free-form origin label, never a vendor
 * type baked into `type`.
 */
export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  /** Stable unique id. Used for idempotent, at-least-once delivery (ADR-0008). */
  readonly id: string;
  /** Domain event type, e.g. "MessageReceived". Never vendor-specific. */
  readonly type: TType;
  /** When the fact occurred, ISO 8601 UTC. */
  readonly occurredAt: string;
  /** Where the fact came from: a Skill/adapter, "orion", or "user". */
  readonly source: string;
  /** Schema version of this event type. Evolves additively (ADR-0008). */
  readonly version: number;
  /** Groups every event in one causal chain (one Gmail message -> its follow-ons). */
  readonly correlationId: string;
  /** The event that directly caused this one, or null for a root fact. */
  readonly causationId: string | null;
  /** The event-type-specific body. */
  readonly payload: TPayload;
}

/** Recursively freezes an object so Events are immutable in practice, not just by type. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export interface NewEventInput<TType extends string, TPayload> {
  type: TType;
  source: string;
  payload: TPayload;
  version?: number;
  /** Omit for a root fact; pass the causing event to continue its causal chain. */
  causedBy?: EventEnvelope | null;
  /** Overridable only for deterministic tests/replay; defaults to now. */
  occurredAt?: string;
  /** Overridable only for deterministic tests; defaults to a random UUID. */
  id?: string;
}

/**
 * Constructs a frozen Event. If `causedBy` is provided, the new event inherits
 * its correlationId and records it as the causation, preserving the chain.
 */
export function makeEvent<TType extends string, TPayload>(
  input: NewEventInput<TType, TPayload>,
): EventEnvelope<TType, TPayload> {
  const id = input.id ?? randomUUID();
  const causedBy = input.causedBy ?? null;
  return deepFreeze({
    id,
    type: input.type,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    source: input.source,
    version: input.version ?? 1,
    correlationId: causedBy?.correlationId ?? id,
    causationId: causedBy?.id ?? null,
    payload: input.payload,
  });
}
