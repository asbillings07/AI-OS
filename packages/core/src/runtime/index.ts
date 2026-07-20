import type { EventEnvelope } from "../events/index.js";
import type { EventBus, Unsubscribe } from "../bus/index.js";
import type { EventStore } from "../store/index.js";
import type { ProjectionHost } from "../projection/index.js";

export interface OrionRuntimeOptions {
  bus: EventBus;
  store: EventStore;
  /** Projection hosts to keep in sync with the log (live and on rebuild). */
  projections?: ReadonlyArray<ProjectionHost<unknown>>;
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

  constructor(options: OrionRuntimeOptions) {
    this.#bus = options.bus;
    this.#store = options.store;
    this.#projections = options.projections ?? [];
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

  /** Persist a new fact, then deliver it live. Order matters: log is truth. */
  async record(event: EventEnvelope): Promise<void> {
    this.#store.append(event);
    await this.#bus.publish(event);
  }

  /** Rebuild every projection from the log alone. */
  async rebuild(): Promise<void> {
    for (const projection of this.#projections) {
      projection.reset();
    }
    await this.#bus.replay(this.#store.readAll());
  }

  dispose(): void {
    for (const unsubscribe of this.#subscriptions) {
      unsubscribe();
    }
    this.#subscriptions.length = 0;
  }
}
