import type { EventEnvelope } from "../events/index.js";

export type EventHandler = (event: EventEnvelope) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface SubscribeOptions {
  /** Only receive these event types. Omit to receive all. */
  types?: readonly string[];
}

/**
 * The Event Bus (ADR-0008): the single channel through which components speak.
 *
 * The defining property: a consumer cannot tell whether an event arrived live
 * (`publish`) or from history (`replay`). Both flow through the exact same
 * delivery path, so projections rebuild from the log with identical logic to
 * the way they handle new facts.
 */
export interface EventBus {
  /** Deliver a newly-recorded event to all matching subscribers. */
  publish(event: EventEnvelope): Promise<void>;
  /** Register a handler. Returns a function that removes it. */
  subscribe(handler: EventHandler, options?: SubscribeOptions): Unsubscribe;
  /** Re-deliver historical events (from the store) to rebuild projections. */
  replay(events: Iterable<EventEnvelope>): Promise<void>;
}

interface Subscription {
  readonly handler: EventHandler;
  readonly types?: readonly string[];
}

/**
 * In-process pub/sub. Sufficient and correct for v0.1's single process; the
 * transport is an implementation detail behind this interface (ADR-0008).
 * Delivery is sequential and awaited, so consumers observe a consistent order.
 */
export class InProcessEventBus implements EventBus {
  readonly #subscriptions = new Set<Subscription>();

  subscribe(handler: EventHandler, options?: SubscribeOptions): Unsubscribe {
    const subscription: Subscription = { handler, types: options?.types };
    this.#subscriptions.add(subscription);
    return () => {
      this.#subscriptions.delete(subscription);
    };
  }

  async publish(event: EventEnvelope): Promise<void> {
    await this.#deliver(event);
  }

  async replay(events: Iterable<EventEnvelope>): Promise<void> {
    for (const event of events) {
      await this.#deliver(event);
    }
  }

  async #deliver(event: EventEnvelope): Promise<void> {
    for (const subscription of this.#subscriptions) {
      if (subscription.types && !subscription.types.includes(event.type)) {
        continue;
      }
      await subscription.handler(event);
    }
  }
}
