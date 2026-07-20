import { describe, it, expect } from "vitest";
import { makeEvent } from "../events/index.js";
import { EventTypes, type MessageReceivedPayload } from "../domain/index.js";
import { contextProjection, type ContextState } from "./context.js";
import { detectSignals } from "./signals.js";
import { timelineProjection } from "./timeline.js";

function message(overrides: Partial<MessageReceivedPayload> & { threadId: string; messageId: string }) {
  const payload: MessageReceivedPayload = {
    from: { name: "Dana Lee", address: "dana@acme.com" },
    to: [{ address: "me@orion.dev" }],
    subject: "Quick question",
    snippet: "Can you review the deck?",
    body: "Hi — can you review the deck before Friday?",
    receivedAt: "2026-07-15T09:00:00.000Z",
    ...overrides,
  };
  return makeEvent({ type: EventTypes.MessageReceived, source: "gmail-skill", payload, id: `evt-${payload.messageId}` });
}

function fold(events: ReturnType<typeof message>[]): ContextState {
  return events.reduce((state, event) => contextProjection.apply(state, event), contextProjection.init());
}

describe("Context projection (ADR-0005)", () => {
  it("groups messages into threads and tracks participants", () => {
    const context = fold([
      message({ threadId: "t1", messageId: "m1" }),
      message({ threadId: "t1", messageId: "m2", body: "Following up.", receivedAt: "2026-07-15T10:00:00.000Z" }),
    ]);
    const thread = context.threads.t1;
    expect(thread?.messages).toHaveLength(1 + 1);
    expect(thread?.participants).toContain("dana@acme.com");
    expect(thread?.participants).toContain("me@orion.dev");
    expect(thread?.status).toBe("open");
  });

  it("builds Person relationship strength across threads", () => {
    const context = fold([
      message({ threadId: "t1", messageId: "m1" }),
      message({ threadId: "t2", messageId: "m2", subject: "Another" }),
    ]);
    expect(context.people["dana@acme.com"]?.messageCount).toBe(2);
  });

  it("marks a thread handled when the user acts on it", () => {
    const received = message({ threadId: "t1", messageId: "m1" });
    const acted = makeEvent({
      type: EventTypes.WorkItemActedOn,
      source: "user",
      payload: { workItemId: "w1", threadId: "t1" },
    });
    const context = [received, acted].reduce(
      (state, event) => contextProjection.apply(state, event),
      contextProjection.init(),
    );
    expect(context.threads.t1?.status).toBe("handled");
  });
});

describe("Signal detection (deterministic)", () => {
  it("raises AwaitingReply + DirectQuestion for a person's question", () => {
    const context = fold([message({ threadId: "t1", messageId: "m1" })]);
    const kinds = detectSignals(context, "2026-07-15T12:00:00.000Z").map((s) => s.kind);
    expect(kinds).toContain("AwaitingReply");
    expect(kinds).toContain("DirectQuestion");
  });

  it("classifies automated senders as LikelyLowValue and nothing else", () => {
    const context = fold([
      message({
        threadId: "t9",
        messageId: "m9",
        from: { address: "no-reply@newsletter.com" },
        subject: "Weekly digest",
        body: "Here is your weekly digest.",
      }),
    ]);
    const kinds = detectSignals(context, "2026-07-15T12:00:00.000Z").map((s) => s.kind);
    expect(kinds).toEqual(["LikelyLowValue"]);
  });

  it("produces no Signals for handled threads", () => {
    const received = message({ threadId: "t1", messageId: "m1" });
    const acted = makeEvent({
      type: EventTypes.WorkItemActedOn,
      source: "user",
      payload: { workItemId: "w1", threadId: "t1" },
    });
    const context = [received, acted].reduce(
      (state, event) => contextProjection.apply(state, event),
      contextProjection.init(),
    );
    expect(detectSignals(context, "2026-07-16T12:00:00.000Z")).toHaveLength(0);
  });

  it("reopens a handled thread when a new inbound message arrives", () => {
    const events = [
      message({ threadId: "t1", messageId: "m1" }),
      makeEvent({
        type: EventTypes.WorkItemActedOn,
        source: "user",
        payload: { workItemId: "w1", threadId: "t1" },
      }),
      message({ threadId: "t1", messageId: "m2", body: "Any update?", receivedAt: "2026-07-16T09:00:00.000Z" }),
    ];
    const context = events.reduce(
      (state, event) => contextProjection.apply(state, event),
      contextProjection.init(),
    );
    expect(context.threads.t1?.status).toBe("open");
    expect(detectSignals(context, "2026-07-16T12:00:00.000Z").map((s) => s.kind)).toContain(
      "AwaitingReply",
    );
  });

  it("keeps a dismissed thread muted even when a new message arrives (durable mute)", () => {
    const events = [
      message({ threadId: "t1", messageId: "m1" }),
      makeEvent({
        type: EventTypes.WorkItemDismissed,
        source: "user",
        payload: { workItemId: "w1", threadId: "t1" },
      }),
      message({ threadId: "t1", messageId: "m2", body: "Still there?", receivedAt: "2026-07-16T09:00:00.000Z" }),
    ];
    const context = events.reduce(
      (state, event) => contextProjection.apply(state, event),
      contextProjection.init(),
    );
    expect(context.threads.t1?.status).toBe("dismissed");
    expect(detectSignals(context, "2026-07-16T12:00:00.000Z")).toHaveLength(0);
  });

  it("clears snoozedUntil when a snoozed thread transitions to another status", () => {
    const events = [
      message({ threadId: "t1", messageId: "m1" }),
      makeEvent({
        type: EventTypes.WorkItemSnoozed,
        source: "user",
        payload: { workItemId: "w1", threadId: "t1", snoozedUntil: "2026-07-16T09:00:00.000Z" },
      }),
      makeEvent({
        type: EventTypes.WorkItemActedOn,
        source: "user",
        payload: { workItemId: "w1", threadId: "t1" },
      }),
    ];
    const context = events.reduce(
      (state, event) => contextProjection.apply(state, event),
      contextProjection.init(),
    );
    expect(context.threads.t1?.status).toBe("handled");
    expect(context.threads.t1?.snoozedUntil).toBeUndefined();
  });

  it("keeps a snoozed thread silent until snoozedUntil, then lets it resurface", () => {
    const received = message({ threadId: "t1", messageId: "m1" });
    const snoozed = makeEvent({
      type: EventTypes.WorkItemSnoozed,
      source: "user",
      payload: { workItemId: "w1", threadId: "t1", snoozedUntil: "2026-07-16T09:00:00.000Z" },
    });
    const context = [received, snoozed].reduce(
      (state, event) => contextProjection.apply(state, event),
      contextProjection.init(),
    );

    // Still inside the snooze window: silent.
    expect(detectSignals(context, "2026-07-15T18:00:00.000Z")).toHaveLength(0);
    // Past the snooze window: resurfaces as a normal actionable thread.
    expect(detectSignals(context, "2026-07-16T10:00:00.000Z").map((s) => s.kind)).toContain(
      "AwaitingReply",
    );
  });

  it("raises an Aging signal once a thread waits long enough", () => {
    const context = fold([message({ threadId: "t1", messageId: "m1", receivedAt: "2026-07-13T09:00:00.000Z" })]);
    const kinds = detectSignals(context, "2026-07-15T09:00:00.000Z").map((s) => s.kind);
    expect(kinds).toContain("Aging");
  });

  it("evidence and source events are present for explainability", () => {
    const context = fold([message({ threadId: "t1", messageId: "m1" })]);
    const awaiting = detectSignals(context, "2026-07-15T12:00:00.000Z").find((s) => s.kind === "AwaitingReply");
    expect(awaiting?.evidence.length).toBeGreaterThan(0);
    expect(awaiting?.sourceEventIds).toContain("evt-m1");
  });
});

describe("Timeline projection", () => {
  it("records notable moments in order", () => {
    const timeline = [
      message({ threadId: "t1", messageId: "m1" }),
      message({ threadId: "t2", messageId: "m2", subject: "Second" }),
    ].reduce((state, event) => timelineProjection.apply(state, event), timelineProjection.init());
    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.label).toContain("Dana Lee");
  });
});
