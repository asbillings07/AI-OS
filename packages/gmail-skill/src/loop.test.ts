import { describe, it, expect } from "vitest";
import {
  InProcessEventBus,
  SqliteEventStore,
  OrionRuntime,
  ProjectionHost,
  contextProjection,
  buildWorkItems,
  makeEvent,
  EventTypes,
  type ContextState,
  type EventStore,
} from "@orion/core";
import { GmailSkill } from "./skill.js";

const NOW = "2026-07-15T17:00:00.000Z";

function runtimeOver(store: EventStore) {
  const bus = new InProcessEventBus();
  const context = new ProjectionHost(contextProjection);
  const runtime = new OrionRuntime({ bus, store, projections: [context as ProjectionHost<unknown>] });
  return { runtime, context };
}

describe("the decision loop (ADR-0002/0005/0007/0008/0009)", () => {
  it("a user action feeds back, updates Context, and re-prioritizes", async () => {
    const store = new SqliteEventStore(":memory:");
    const { runtime, context } = runtimeOver(store);
    await runtime.rebuild();
    await new GmailSkill().ingest(runtime);

    const before = buildWorkItems(context.state as ContextState, NOW);
    const sam = before.find((item) => item.threadId === "th-sam");
    expect(sam).toBeDefined();
    expect(sam?.band).toBe("needs_attention");

    // The user handles Sam's thread — a new Event flows back into the system.
    await runtime.record(
      makeEvent({
        type: EventTypes.WorkItemActedOn,
        source: "user",
        payload: { workItemId: sam!.id, threadId: "th-sam" },
      }),
    );

    const after = buildWorkItems(context.state as ContextState, NOW);
    expect(after.find((item) => item.threadId === "th-sam")).toBeUndefined();
    expect(after.length).toBe(before.length - 1);
  });

  it("the action persists: a rebuild from the log alone reproduces the result", async () => {
    const store = new SqliteEventStore(":memory:");
    const first = runtimeOver(store);
    await first.runtime.rebuild();
    await new GmailSkill().ingest(first.runtime);
    await first.runtime.record(
      makeEvent({
        type: EventTypes.WorkItemDismissed,
        source: "user",
        payload: { workItemId: "wi-th-fyi", threadId: "th-fyi" },
      }),
    );

    // Fresh process over the same log: replay must reconstruct the same state.
    const second = runtimeOver(store);
    await second.runtime.rebuild();
    const rebuilt = buildWorkItems(second.context.state as ContextState, NOW);
    expect(rebuilt.find((item) => item.threadId === "th-fyi")).toBeUndefined();
  });
});
