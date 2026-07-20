import type { EventEnvelope } from "../events/index.js";
import type { EventBus, Unsubscribe } from "../bus/index.js";

/**
 * A Projection is derived state defined purely as a fold over the event log
 * (ADR-0009). It has semantic meaning (unlike a cache) and is always
 * rebuildable by replaying events from the beginning.
 */
export interface Projection<TState> {
  readonly name: string;
  /** The empty state, before any events. */
  init(): TState;
  /** Fold one event into the state. Must be pure and deterministic. */
  apply(state: TState, event: EventEnvelope): TState;
}

/**
 * Holds the live state of a single Projection and folds events into it. The
 * same `handle` method serves both live `publish` and historical `replay`,
 * which is what makes the two indistinguishable to the projection.
 */
export class ProjectionHost<TState> {
  #state: TState;

  constructor(private readonly projection: Projection<TState>) {
    this.#state = projection.init();
  }

  get name(): string {
    return this.projection.name;
  }

  get state(): TState {
    return this.#state;
  }

  /** Discard state so it can be rebuilt from scratch by replay. */
  reset(): void {
    this.#state = this.projection.init();
  }

  readonly handle = (event: EventEnvelope): void => {
    this.#state = this.projection.apply(this.#state, event);
  };

  /** Subscribe this projection to a bus for live updates. */
  attach(bus: EventBus): Unsubscribe {
    return bus.subscribe(this.handle);
  }
}
