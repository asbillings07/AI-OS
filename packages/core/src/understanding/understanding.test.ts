import { describe, it, expect } from "vitest";
import { makeEvent } from "../events/index.js";
import { EventTypes, type MessageReceivedPayload, type MessageSentPayload } from "../domain/index.js";
import { contextProjection, latestThreadMessage, type ContextState } from "./context.js";
import { detectSignals } from "./signals.js";
import { detectOpportunities } from "../opportunity/index.js";
import { timelineProjection } from "./timeline.js";
import { buildWorkItems, attentionProjection } from "../index.js";

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

  it("increments outboundCount for multiple distinct external recipients", () => {
    const context = [
      sentMessage({
        threadId: "t1",
        messageId: "s1",
        from: { address: "me@orion.dev" },
        to: [
          { address: "dana@acme.com", name: "Dana" },
          { address: "john@example.com", name: "John" },
        ],
      }),
    ].reduce((state, event) => contextProjection.apply(state, event), contextProjection.init());

    expect(context.people["dana@acme.com"]?.outboundCount).toBe(1);
    expect(context.people["john@example.com"]?.outboundCount).toBe(1);
  });

  it("handles malformed and valid timestamps symmetrically across arrival orders", () => {
    const validTime = "2026-07-15T09:00:00.000Z";
    const malformedTime = "invalid-date";

    const malformedFirst = [
      message({ threadId: "t1", messageId: "m1", receivedAt: malformedTime }),
      message({ threadId: "t1", messageId: "m2", receivedAt: validTime }),
    ].reduce((state, event) => contextProjection.apply(state, event), contextProjection.init());

    const validFirst = [
      message({ threadId: "t1", messageId: "m2", receivedAt: validTime }),
      message({ threadId: "t1", messageId: "m1", receivedAt: malformedTime }),
    ].reduce((state, event) => contextProjection.apply(state, event), contextProjection.init());

    const person1 = malformedFirst.people["dana@acme.com"]!;
    const person2 = validFirst.people["dana@acme.com"]!;

    expect(person1.firstSeenAt).toBe(validTime);
    expect(person1.lastSeenAt).toBe(validTime);

    expect(person2.firstSeenAt).toBe(validTime);
    expect(person2.lastSeenAt).toBe(validTime);

    expect(malformedFirst.threads.t1?.firstMessageAt).toBe(validTime);
    expect(malformedFirst.threads.t1?.lastMessageAt).toBe(validTime);
    expect(validFirst.threads.t1?.firstMessageAt).toBe(validTime);
    expect(validFirst.threads.t1?.lastMessageAt).toBe(validTime);
  });

  it("cross-direction out-of-order delivery produces the same latest direction and Work Item", () => {
    const inbound = message({ threadId: "t1", messageId: "m1", body: "Question?", receivedAt: "2026-07-15T09:00:00.000Z" });
    const outbound = sentMessage({ threadId: "t1", messageId: "s1", body: "Answer!", sentAt: "2026-07-15T10:00:00.000Z" });

    // Order 1: Inbound then Outbound
    const context1 = [inbound, outbound].reduce(
      (state, event) => contextProjection.apply(state, event),
      contextProjection.init(),
    );

    // Order 2: Outbound then Inbound (delayed arrival of inbound)
    const context2 = [outbound, inbound].reduce(
      (state, event) => contextProjection.apply(state, event),
      contextProjection.init(),
    );

    expect(latestThreadMessage(context1.threads.t1!)?.direction).toBe("outbound");
    expect(latestThreadMessage(context2.threads.t1!)?.direction).toBe("outbound");

    const items1 = buildWorkItems({ context: context1, attention: attentionProjection.init(), now: "2026-07-15T12:00:00.000Z" });
    const items2 = buildWorkItems({ context: context2, attention: attentionProjection.init(), now: "2026-07-15T12:00:00.000Z" });

    expect(items1.find((item) => item.subject.id === "t1")).toBeUndefined();
    expect(items2.find((item) => item.subject.id === "t1")).toBeUndefined();
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

  it("detects ExplicitRequest and Invitation with direct message event provenance (#88)", () => {
    const context = fold([
      message({
        threadId: "t1",
        messageId: "m1",
        subject: "Invitation to Q3 Planning",
        body: "You are invited you to join our Q3 planning session. Please RSVP.",
      }),
      message({
        threadId: "t2",
        messageId: "m2",
        subject: "Action required on contract",
        body: "Please review and sign the attached draft.",
      }),
    ]);

    const sigsT1 = detectSignals(context, "2026-07-15T12:00:00.000Z").filter((s) => s.subject.id === "t1");
    const invSignal = sigsT1.find((s) => s.kind === "Invitation");
    expect(invSignal).toBeDefined();
    expect(invSignal?.strength).toBe(0.9);
    expect(invSignal?.sourceEventIds).toEqual(["evt-m1"]);

    const sigsT2 = detectSignals(context, "2026-07-15T12:00:00.000Z").filter((s) => s.subject.id === "t2");
    const reqSignal = sigsT2.find((s) => s.kind === "ExplicitRequest");
    expect(reqSignal).toBeDefined();
    expect(reqSignal?.strength).toBe(0.85);
    expect(reqSignal?.sourceEventIds).toEqual(["evt-m2"]);
  });

  it("automated sender with actionable invitation emits both LikelyLowValue and Invitation (#88)", () => {
    const context = fold([
      message({
        threadId: "t1",
        messageId: "m1",
        from: { address: "no-reply@calendar.example.com", name: "Calendar Bot" },
        subject: "Calendar invitation: Product Sync",
        body: "You have a meeting invitation to Product Sync. Accept or decline below.",
      }),
    ]);

    const sigs = detectSignals(context, "2026-07-15T12:00:00.000Z");
    const kinds = sigs.map((s) => s.kind);
    expect(kinds).toContain("LikelyLowValue");
    expect(kinds).toContain("Invitation");
  });

  it("automated informational message without request produces NO opportunities (#88)", () => {
    const context = fold([
      message({
        threadId: "t1",
        messageId: "m1",
        from: { address: "no-reply@weekly.example.com", name: "The Weekly" },
        subject: "Your Weekly Digest",
        body: "Here are this week's top stories and updates.",
      }),
    ]);

    const opps = detectOpportunities(context, "2026-07-15T12:00:00.000Z");
    expect(opps).toHaveLength(0);
  });

  it("does NOT emit Invitation or ExplicitRequest for informational or completed phrases (#88)", () => {
    const negativeCases = [
      { subject: "Meeting notes from yesterday", body: "Here are the notes from our call." },
      { subject: "Your calendar has been updated", body: "Room change for tomorrow." },
      { subject: "Event recap", body: "Highlights from last week's conference." },
      { subject: "Webinar recording", body: "Watch the session recording anytime." },
      { subject: "Approval received", body: "Your expense report was approved." },
      { subject: "Meet our new leadership team", body: "Welcoming our new VP." },
      { subject: "Meeting invitation accepted", body: "Dana accepted your invitation." },
      { subject: "Calendar invitation declined", body: "Sam declined the invite." },
      { subject: "Invitation canceled", body: "The sync has been canceled." },
      { subject: "RSVP confirmed", body: "Your spot is confirmed." },
    ];

    negativeCases.forEach((spec, idx) => {
      const context = fold([
        message({
          threadId: `t-${idx}`,
          messageId: `m-${idx}`,
          subject: spec.subject,
          body: spec.body,
        }),
      ]);
      const kinds = detectSignals(context, "2026-07-15T12:00:00.000Z").map((s) => s.kind);
      expect(kinds).not.toContain("Invitation");
      expect(kinds).not.toContain("ExplicitRequest");
    });
  });

  it("declarative requests do not claim to ask a direct question (#88)", () => {
    const context = fold([
      message({
        threadId: "t1",
        messageId: "m1",
        subject: "Contract signature needed",
        body: "Please sign the contract by Friday.",
      }),
    ]);

    const kinds = detectSignals(context, "2026-07-15T12:00:00.000Z").map((s) => s.kind);
    expect(kinds).toContain("ExplicitRequest");
    expect(kinds).not.toContain("DirectQuestion");
  });

  it("detects explicit requests and invitations when 'updated' or 'accepted' is in body without suppressing request (#88)", () => {
    // 1. "I updated the contract. Please review." -> ExplicitRequest
    const c1 = fold([message({ threadId: "t1", messageId: "m1", subject: "Contract update", body: "I updated the contract. Please review." })]);
    expect(detectSignals(c1, "2026-07-15T12:00:00.000Z").map((s) => s.kind)).toContain("ExplicitRequest");

    // 2. "The agenda was updated. Please RSVP." -> Invitation
    const c2 = fold([message({ threadId: "t2", messageId: "m2", subject: "Agenda update", body: "The agenda was updated. Please RSVP." })]);
    expect(detectSignals(c2, "2026-07-15T12:00:00.000Z").map((s) => s.kind)).toContain("Invitation");

    // 3. "Your request was accepted; please sign the agreement." -> ExplicitRequest
    const c3 = fold([message({ threadId: "t3", messageId: "m3", subject: "Request accepted", body: "Your request was accepted; please sign the agreement." })]);
    expect(detectSignals(c3, "2026-07-15T12:00:00.000Z").map((s) => s.kind)).toContain("ExplicitRequest");
  });

  it("clears earlier invitation when a later message in the active turn cancels or declines it (#88)", () => {
    const c = fold([
      message({ threadId: "t1", messageId: "m1", subject: "Meeting invitation: Sync", body: "Please RSVP to Sync." }),
      message({ threadId: "t1", messageId: "m2", subject: "Re: Meeting invitation: Sync", body: "Dana canceled the sync meeting." }),
    ]);
    const kinds = detectSignals(c, "2026-07-15T12:00:00.000Z").map((s) => s.kind);
    expect(kinds).not.toContain("Invitation");
  });

  it("bare 'following up' does NOT emit ExplicitRequest, but 'following up -- any thoughts' does (#88)", () => {
    const bareContext = fold([
      message({ threadId: "t1", messageId: "m1", subject: "Contract draft", body: "Just following up on my previous email." }),
    ]);
    expect(detectSignals(bareContext, "2026-07-15T12:00:00.000Z").map((s) => s.kind)).not.toContain("ExplicitRequest");

    const thoughtsContext = fold([
      message({ threadId: "t2", messageId: "m2", subject: "Contract draft", body: "Following up — any thoughts before Friday?" }),
    ]);
    expect(detectSignals(thoughtsContext, "2026-07-15T12:00:00.000Z").map((s) => s.kind)).toContain("ExplicitRequest");
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
