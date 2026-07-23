import { describe, it, expect } from "vitest";
import { makeEvent } from "../events/index.js";
import { EventTypes, type MessageReceivedPayload, type MessageSentPayload } from "../domain/index.js";
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

function sentMessage(overrides: Partial<MessageSentPayload> & { threadId: string; messageId: string }) {
  const payload: MessageSentPayload = {
    from: { name: "Me", address: "me@orion.dev" },
    to: [{ name: "Dana Lee", address: "dana@acme.com" }],
    subject: "Re: Quick question",
    snippet: "Here is the feedback.",
    body: "Looks good!",
    sentAt: "2026-07-15T10:00:00.000Z",
    ...overrides,
  };
  return makeEvent({ type: EventTypes.MessageSent, source: "gmail-skill", payload, id: `evt-sent-${payload.messageId}` });
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

  it("builds Person relationship counts across threads", () => {
    const context = [
      message({ threadId: "t1", messageId: "m1" }),
      message({ threadId: "t2", messageId: "m2", subject: "Another" }),
      sentMessage({ threadId: "t1", messageId: "s1" }),
    ].reduce((state, event) => contextProjection.apply(state, event), contextProjection.init());

    expect(context.people["dana@acme.com"]?.inboundCount).toBe(2);
    expect(context.people["dana@acme.com"]?.outboundCount).toBe(1);
    expect(context.people["dana@acme.com"]?.inboundEventIds).toEqual(["evt-m1", "evt-m2"]);
    expect(context.people["dana@acme.com"]?.outboundEventIds).toEqual(["evt-sent-s1"]);
  });

  it("deduplicates recipients per message and excludes self-addressed mail", () => {
    const context = [
      sentMessage({
        threadId: "t1",
        messageId: "s1",
        from: { address: "me@orion.dev" },
        to: [
          { address: "dana@acme.com", name: "Dana" },
          { address: "DANA@ACME.COM" }, // duplicate
          { address: "me@orion.dev" }, // self-addressed
          { address: " " }, // empty
        ],
      }),
    ].reduce((state, event) => contextProjection.apply(state, event), contextProjection.init());

    expect(context.people["dana@acme.com"]?.outboundCount).toBe(1);
    expect(context.people["dana@acme.com"]?.name).toBe("Dana");
    expect(context.people["me@orion.dev"]).toBeUndefined();
  });

  it("updates timestamps using domain occurrence time rather than append order", () => {
    // Late-arriving older message appended after a newer one
    const newer = message({ threadId: "t1", messageId: "m2", receivedAt: "2026-07-15T12:00:00.000Z" });
    const older = message({ threadId: "t1", messageId: "m1", receivedAt: "2026-07-15T08:00:00.000Z" });

    const context = [newer, older].reduce(
      (state, event) => contextProjection.apply(state, event),
      contextProjection.init(),
    );

    const thread = context.threads.t1!;
    expect(thread.firstMessageAt).toBe("2026-07-15T08:00:00.000Z");
    expect(thread.lastMessageAt).toBe("2026-07-15T12:00:00.000Z");

    const person = context.people["dana@acme.com"]!;
    expect(person.firstSeenAt).toBe("2026-07-15T08:00:00.000Z");
    expect(person.lastSeenAt).toBe("2026-07-15T12:00:00.000Z");
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

  it("does NOT emit FromKnownPerson for repeated inbound-only messages", () => {
    const context = fold([
      message({ threadId: "t1", messageId: "m1" }),
      message({ threadId: "t2", messageId: "m2", subject: "Another" }),
    ]);
    const kinds = detectSignals(context, "2026-07-15T12:00:00.000Z").map((s) => s.kind);
    expect(kinds).not.toContain("FromKnownPerson");
  });

  it("suppresses all reply-needed signals when latest message is outbound", () => {
    const inbound = message({ threadId: "t1", messageId: "m1", body: "Can you review this?", receivedAt: "2026-07-13T09:00:00.000Z" });
    const outbound = sentMessage({ threadId: "t1", messageId: "s1", body: "All done!", sentAt: "2026-07-13T10:00:00.000Z" });

    const context = [inbound, outbound].reduce(
      (state, event) => contextProjection.apply(state, event),
      contextProjection.init(),
    );

    const signals = detectSignals(context, "2026-07-15T12:00:00.000Z");
    const kinds = signals.map((s) => s.kind);

    expect(kinds).not.toContain("AwaitingReply");
    expect(kinds).not.toContain("DirectQuestion");
    expect(kinds).not.toContain("Aging");
  });

  it("resurfaces reply-needed signals when a newer inbound message arrives after outbound", () => {
    const inbound1 = message({ threadId: "t1", messageId: "m1", receivedAt: "2026-07-13T09:00:00.000Z" });
    const outbound = sentMessage({ threadId: "t1", messageId: "s1", sentAt: "2026-07-13T10:00:00.000Z" });
    const inbound2 = message({ threadId: "t1", messageId: "m2", body: "Thanks! One more question?", receivedAt: "2026-07-14T09:00:00.000Z" });

    const context = [inbound1, outbound, inbound2].reduce(
      (state, event) => contextProjection.apply(state, event),
      contextProjection.init(),
    );

    const signals = detectSignals(context, "2026-07-15T12:00:00.000Z");
    const kinds = signals.map((s) => s.kind);

    expect(kinds).toContain("AwaitingReply");
    expect(kinds).toContain("DirectQuestion");
    expect(kinds).toContain("FromKnownPerson");

    const knownPerson = signals.find((s) => s.kind === "FromKnownPerson")!;
    expect(knownPerson.sourceEventIds).toEqual(["evt-m1", "evt-sent-s1", "evt-m2"]);
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

  it("still produces Signals for a handled thread — suppression is Attention's job now (#46)", () => {
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
    // Signals describe reality; whether the user has handled the thread is a
    // presentation decision made later at the visibility stage (see attention.test.ts).
    expect(detectSignals(context, "2026-07-16T12:00:00.000Z").map((s) => s.kind)).toContain(
      "AwaitingReply",
    );
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

  it("records a legacy dismissal on Context status but still emits reality Signals (#46)", () => {
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
    // Legacy status is still replayed for byte-identical rebuilds (dismissed is a
    // durable mute Context keeps even when the conversation continues)...
    expect(context.threads.t1?.status).toBe("dismissed");
    // ...but Signals no longer read status; the durable-mute semantics live in the
    // Attention layer (see attention.test.ts, legacy-subject dispositions).
    expect(detectSignals(context, "2026-07-16T12:00:00.000Z").map((s) => s.kind)).toContain(
      "AwaitingReply",
    );
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

  it("emits Signals for a snoozed thread regardless of the snooze window (#46)", () => {
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

    // Reality is the same inside and outside the snooze window; the window only
    // governs *visibility*, which the Attention layer applies (see attention.test.ts).
    expect(detectSignals(context, "2026-07-15T18:00:00.000Z").map((s) => s.kind)).toContain(
      "AwaitingReply",
    );
    expect(detectSignals(context, "2026-07-16T10:00:00.000Z").map((s) => s.kind)).toContain(
      "AwaitingReply",
    );
  });

  it("resurfaces a snoozed thread immediately when a new inbound message arrives", () => {
    const events = [
      message({ threadId: "t1", messageId: "m1" }),
      makeEvent({
        type: EventTypes.WorkItemSnoozed,
        source: "user",
        payload: { workItemId: "w1", threadId: "t1", snoozedUntil: "2026-07-20T09:00:00.000Z" },
      }),
      // A reply lands well before the snooze window ends.
      message({ threadId: "t1", messageId: "m2", body: "Bumping — any thoughts?", receivedAt: "2026-07-15T12:00:00.000Z" }),
    ];
    const context = events.reduce(
      (state, event) => contextProjection.apply(state, event),
      contextProjection.init(),
    );
    // Fresh activity overrides the defer (email-client-style un-snooze).
    expect(context.threads.t1?.status).toBe("open");
    expect(context.threads.t1?.snoozedUntil).toBeUndefined();
    expect(detectSignals(context, "2026-07-15T13:00:00.000Z").map((s) => s.kind)).toContain(
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
