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
   * Persist a new fact, then deliver it live. The contract:
   *
   *  - **Delivery idempotency.** Appending is idempotent by event id, and a
   *    duplicate is *not* re-delivered — storage idempotency alone would still
   *    let projections double-apply, so we publish only when the append newly
   *    inserted the event.
   *  - **Durable-append, then publish.** The log is the source of truth, so the
   *    event is committed before delivery. If a subscriber throws, `publish`
   *    rejects and `record` rejects *after* the event is already durable, and
   *    projections may be left partially applied. The event stays on the log;
   *    a later `rebuild()` reconstructs consistent state from it. Consumers must
   *    therefore be idempotent (ADR-0008).
   *  - **Serialized delivery.** The runtime is a shared singleton (e.g. across
   *    Next.js server actions), so records are queued and processed one at a
   *    time. Concurrent callers can never interleave append/publish, which keeps
   *    the single-writer ordering ADR-0008 promises even if a subscriber awaits.
   *    A failed record must not stall the queue, so the chain continues
   *    regardless of any individual call's outcome.
   */
  async record(event: EventEnvelope): Promise<void> {
    const result = this.#recordQueue.then(
      () => this.#appendAndPublish(event),
      () => this.#appendAndPublish(event),
    );
    this.#recordQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #appendAndPublish(event: EventEnvelope): Promise<void> {
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
