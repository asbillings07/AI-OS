import type { EventEnvelope } from "../events/index.js";
import type { EventBus, Unsubscribe } from "../bus/index.js";
import type { EventStore } from "../store/index.js";
import type { ProjectionHost } from "../projection/index.js";
import { LogEvents, nullLogger, type Logger } from "../observability/index.js";

export interface OrionRuntimeOptions {
  bus: EventBus;
  store: EventStore;
  /** Projection hosts to keep in sync with the log (live and on rebuild). */
  projections?: ReadonlyArray<ProjectionHost<unknown>>;
  /** Optional structured logger. Defaults to a no-op (logging is opt-in). */
  logger?: Logger;
}

/**
 * Wires the event backbone together and enforces the ADR-0009 discipline:
 *
 *  - `record`  appends a new fact to the log, then publishes it. Projections
 *              update incrementally.
 *  - `rebuild` throws away all projection state and reconstructs it purely by
 *              replaying the log. Because replay uses the same delivery path as
 *              publish, projections cannot tell the difference.
 *
 * If `record` and `rebuild` ever produce different state, an ADR is being
 * violated, not the code.
 */
export class OrionRuntime {
  readonly #bus: EventBus;
  readonly #store: EventStore;
  readonly #projections: ReadonlyArray<ProjectionHost<unknown>>;
  readonly #subscriptions: Unsubscribe[] = [];
  readonly #logger: Logger;
  /** Tail of the record queue; serializes concurrent writers (see `record`). */
  #recordQueue: Promise<unknown> = Promise.resolve();

  constructor(options: OrionRuntimeOptions) {
    this.#bus = options.bus;
    this.#store = options.store;
    this.#projections = options.projections ?? [];
    this.#logger = options.logger ?? nullLogger;
    for (const projection of this.#projections) {
      this.#subscriptions.push(projection.attach(this.#bus));
    }
  }

  get bus(): EventBus {
    return this.#bus;
  }

  get store(): EventStore {
    return this.#store;
  }

  /**
   * Persist a new fact, then deliver it live. A thin wrapper over
   * `recordExclusive` (its `build` unconditionally yields the given event), kept
   * for the common case where the caller has already decided to record. The
   * contract below is really `recordExclusive`'s; see it for details.
   */
  async record(event: EventEnvelope): Promise<void> {
    await this.recordExclusive(() => event);
  }

  /**
   * An **in-process serialized conditional append** (not a database
   * transaction): run `build` inside the record critical section, and append +
   * publish only if it yields an event. The contract:
   *
   *  - **Atomic check-and-record.** `build` runs *after* every prior record has
   *    finished processing, so it can re-check current state (e.g. "is this Work
   *    Item still visible at this revision?") and abort by returning `null`. The
   *    check and the append are one critical section, closing the
   *    time-of-check/time-of-use gap a separate check-then-`record` leaves open.
   *    `build` must be **synchronous and side-effect-free** — it only decides.
   *    Note the projections `build` reads are current only for prior records that
   *    *published successfully*; a prior publish failure (below) advances the
   *    queue but may leave projections partially applied until `rebuild()`.
   *  - **Delivery idempotency.** Appending is idempotent by event id, and a
   *    duplicate is *not* re-delivered — storage idempotency alone would still
   *    let projections double-apply, so we publish only when the append newly
   *    inserted the event. Returns whether a new event was appended.
   *  - **Durable-append, then publish.** The log is the source of truth, so the
   *    event is committed before delivery. If a subscriber throws, `publish`
   *    rejects and this call rejects *after* the event is already durable, and
   *    projections may be left partially applied. The event stays on the log;
   *    a later `rebuild()` reconstructs consistent state from it. Consumers must
   *    therefore be idempotent (ADR-0008).
   *  - **Serialized delivery.** The runtime is a shared singleton (e.g. across
   *    Next.js server actions), so records are queued and processed one at a
   *    time. Concurrent callers can never interleave build/append/publish, which
   *    keeps the single-writer ordering ADR-0008 promises even if a subscriber
   *    awaits. A failed build or record must not stall the queue, so the chain
   *    continues regardless of any individual call's outcome.
   */
  async recordExclusive(build: () => EventEnvelope | null): Promise<boolean> {
    const result = this.#recordQueue.then(
      () => this.#buildAppendPublish(build),
      () => this.#buildAppendPublish(build),
    );
    this.#recordQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #buildAppendPublish(build: () => EventEnvelope | null): Promise<boolean> {
    const event = build();
    if (!event) return false;
    return this.#appendAndPublish(event);
  }

  async #appendAndPublish(event: EventEnvelope): Promise<boolean> {
    const isNew = this.#store.append(event);
    if (isNew) {
      this.#logger.event(LogEvents.EventRecorded, {
        id: event.id,
        type: event.type,
        source: event.source,
      });
      await this.#bus.publish(event);
    } else {
      this.#logger.event(LogEvents.EventDuplicate, { id: event.id, type: event.type });
    }
    return isNew;
  }

  /** Rebuild every projection from the log alone. */
  async rebuild(): Promise<void> {
    for (const projection of this.#projections) {
      projection.reset();
    }
    const events = this.#store.readAll();
    await this.#bus.replay(events);
    this.#logger.event(LogEvents.ProjectionRebuilt, {
      events: events.length,
      projections: this.#projections.length,
    });
  }

  dispose(): void {
    for (const unsubscribe of this.#subscriptions) {
      unsubscribe();
    }
    this.#subscriptions.length = 0;
  }
}
