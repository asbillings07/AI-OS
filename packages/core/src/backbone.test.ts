import { describe, it, expect } from "vitest";
import {
  InProcessEventBus,
  SqliteEventStore,
  OrionRuntime,
  ProjectionHost,
  makeEvent,
  type EventEnvelope,
  type Projection,
} from "./index.js";

/** A trivial projection: counts events per type. Enough to prove replay == live. */
interface Counts {
  total: number;
  byType: Record<string, number>;
}

const countingProjection: Projection<Counts> = {
  name: "counts",
  init: () => ({ total: 0, byType: {} }),
  apply: (state, event) => ({
    total: state.total + 1,
    byType: { ...state.byType, [event.type]: (state.byType[event.type] ?? 0) + 1 },
  }),
};

function newRuntime() {
  const store = new SqliteEventStore(":memory:");
  const bus = new InProcessEventBus();
  const host = new ProjectionHost(countingProjection);
  const runtime = new OrionRuntime({ bus, store, projections: [host as ProjectionHost<unknown>] });
  return { store, bus, host, runtime };
}

describe("event backbone (ADR-0002, ADR-0008, ADR-0009)", () => {
  it("updates projections live as events are recorded", async () => {
    const { runtime, host } = newRuntime();
    await runtime.record(makeEvent({ type: "MessageReceived", source: "gmail-skill", payload: {} }));
    await runtime.record(makeEvent({ type: "MessageReceived", source: "gmail-skill", payload: {} }));
    await runtime.record(makeEvent({ type: "WorkItemDismissed", source: "user", payload: {} }));

    expect(host.state.total).toBe(3);
    expect(host.state.byType).toEqual({ MessageReceived: 2, WorkItemDismissed: 1 });
  });

  it("rebuilds identical state from the log alone (replay == live)", async () => {
    const { store, host, runtime } = newRuntime();
    await runtime.record(makeEvent({ type: "MessageReceived", source: "gmail-skill", payload: {} }));
    await runtime.record(makeEvent({ type: "MessageReceived", source: "gmail-skill", payload: {} }));
    const liveState = structuredClone(host.state);

    // A fresh runtime over the SAME log must reconstruct the same state.
    const bus2 = new InProcessEventBus();
    const host2 = new ProjectionHost(countingProjection);
    const runtime2 = new OrionRuntime({ bus: bus2, store, projections: [host2 as ProjectionHost<unknown>] });
    await runtime2.rebuild();

    expect(host2.state).toEqual(liveState);
  });

  it("append is idempotent by event id (at-least-once delivery is safe)", () => {
    const store = new SqliteEventStore(":memory:");
    const event: EventEnvelope = makeEvent({
      type: "MessageReceived",
      source: "gmail-skill",
      payload: { subject: "hello" },
      id: "fixed-id-1",
    });
    store.append(event);
    store.append(event);
    store.append(event);
    expect(store.count()).toBe(1);
    expect(store.readAll()).toHaveLength(1);
  });

  it("preserves correlation and causation across a chain", () => {
    const root = makeEvent({ type: "MessageReceived", source: "gmail-skill", payload: {} });
    const derived = makeEvent({ type: "OpportunityDetected", source: "orion", payload: {}, causedBy: root });

    expect(derived.correlationId).toBe(root.correlationId);
    expect(derived.causationId).toBe(root.id);
    expect(root.causationId).toBeNull();
  });

  it("events are frozen (immutable in practice, ADR-0002)", () => {
    const event = makeEvent({ type: "MessageReceived", source: "gmail-skill", payload: { a: 1 } });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
  });
});
