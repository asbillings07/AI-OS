import { describe, it, expect } from "vitest";
import {
  InProcessEventBus,
  SqliteEventStore,
  OrionRuntime,
  ProjectionHost,
  contextProjection,
  attentionProjection,
  buildWorkItems,
  buildSuppressOriginatorEvent,
  buildUnsuppressOriginatorEvent,
  makeEvent,
  EventTypes,
  type AttentionState,
  type ContextState,
  type EventStore,
  type WorkItem,
} from "@orion/core";
import { GmailSkill } from "./skill.js";

const NOW = "2026-07-15T17:00:00.000Z";

function runtimeOver(store: EventStore) {
  const bus = new InProcessEventBus();
  const context = new ProjectionHost(contextProjection);
  const attention = new ProjectionHost(attentionProjection);
  const runtime = new OrionRuntime({
    bus,
    store,
    projections: [context as ProjectionHost<unknown>, attention as ProjectionHost<unknown>],
  });
  const items = (): WorkItem[] =>
    buildWorkItems({
      context: context.state as ContextState,
      attention: attention.state as AttentionState,
      now: NOW,
    });
  return { runtime, context, attention, items };
}

/** The current action payload the server would derive from a surfaced Work Item. */
function actionPayload(item: WorkItem) {
  return { workItemId: item.id, subject: item.subject, basisEventIds: item.attentionBasisEventIds };
}

describe("the decision loop (ADR-0002/0005/0007/0008/0009/0012)", () => {
  it("a user action feeds back, updates Attention, and re-prioritizes", async () => {
    const store = new SqliteEventStore(":memory:");
    const { runtime, items } = runtimeOver(store);
    await runtime.rebuild();
    await new GmailSkill().ingest(runtime);

    const before = items();
    const dana = before.find((item) => item.subject.id === "th-dana");
    expect(dana).toBeDefined();
    expect(dana?.band).toBe("needs_attention");

    // The user handles Dana's thread — a new Event flows back into the system,
    // scoped to exactly the revision they saw.
    await runtime.record(
      makeEvent({ type: EventTypes.WorkItemActedOn, source: "user", payload: actionPayload(dana!) }),
    );

    const after = items();
    expect(after.find((item) => item.subject.id === "th-dana")).toBeUndefined();
    expect(after.length).toBe(before.length - 1);
  });

  it("the action persists: a rebuild from the log alone reproduces the result", async () => {
    const store = new SqliteEventStore(":memory:");
    const first = runtimeOver(store);
    await first.runtime.rebuild();
    await new GmailSkill().ingest(first.runtime);

    const fyi = first.items().find((item) => item.subject.id === "th-fyi");
    expect(fyi).toBeDefined();
    await first.runtime.record(
      makeEvent({ type: EventTypes.WorkItemDismissed, source: "user", payload: actionPayload(fyi!) }),
    );

    // Fresh process over the same log: replay must reconstruct the same state.
    const second = runtimeOver(store);
    await second.runtime.rebuild();
    expect(second.items().find((item) => item.subject.id === "th-fyi")).toBeUndefined();
  });

  it("sending an outbound message removes the thread Work Item entirely, and a newer inbound resurfaces it", async () => {
    const store = new SqliteEventStore(":memory:");
    const { runtime, items } = runtimeOver(store);
    await runtime.rebuild();

    // Inbound question arrives
    await runtime.record(
      makeEvent({
        type: EventTypes.MessageReceived,
        source: "gmail-skill",
        id: "gmail:m-in-1",
        occurredAt: "2026-07-15T09:00:00.000Z",
        payload: {
          messageId: "m-in-1",
          threadId: "th-outbound-test",
          from: { name: "Dana", address: "dana@acme.com" },
          to: [{ address: "me@orion.dev" }],
          subject: "Deck feedback?",
          snippet: "Thoughts?",
          body: "Do you have thoughts on the deck?",
          receivedAt: "2026-07-15T09:00:00.000Z",
        },
      }),
    );

    expect(items().find((item) => item.subject.id === "th-outbound-test")).toBeDefined();

    // User sends outbound reply
    await runtime.record(
      makeEvent({
        type: EventTypes.MessageSent,
        source: "gmail-skill",
        id: "gmail:sent:m-out-1",
        occurredAt: "2026-07-15T10:00:00.000Z",
        payload: {
          messageId: "m-out-1",
          threadId: "th-outbound-test",
          from: { address: "me@orion.dev" },
          to: [{ name: "Dana", address: "dana@acme.com" }],
          subject: "Re: Deck feedback?",
          snippet: "Looks great!",
          body: "The deck looks great, thanks!",
          sentAt: "2026-07-15T10:00:00.000Z",
        },
      }),
    );

    // Work Item is completely removed from Mission Control (whole-obligation suppression)
    expect(items().find((item) => item.subject.id === "th-outbound-test")).toBeUndefined();

    // Newer inbound message arrives on the same thread
    await runtime.record(
      makeEvent({
        type: EventTypes.MessageReceived,
        source: "gmail-skill",
        id: "gmail:m-in-2",
        occurredAt: "2026-07-15T11:00:00.000Z",
        payload: {
          messageId: "m-in-2",
          threadId: "th-outbound-test",
          from: { name: "Dana", address: "dana@acme.com" },
          to: [{ address: "me@orion.dev" }],
          subject: "Re: Deck feedback?",
          snippet: "Awesome, one follow up",
          body: "Awesome! Can you check slide 4 as well?",
          receivedAt: "2026-07-15T11:00:00.000Z",
        },
      }),
    );

    // Resurfaces as an active Work Item
    const resurfaced = items().find((item) => item.subject.id === "th-outbound-test");
    expect(resurfaced).toBeDefined();
    expect(resurfaced?.reason).toContain("You've exchanged messages with this person.");
  });

  it("exact Context and Work Item parity after rebuilding a log containing MessageSent", async () => {
    const store = new SqliteEventStore(":memory:");
    const first = runtimeOver(store);
    await first.runtime.rebuild();

    await first.runtime.record(
      makeEvent({
        type: EventTypes.MessageReceived,
        source: "gmail-skill",
        id: "gmail:m-in-1",
        occurredAt: "2026-07-15T09:00:00.000Z",
        payload: {
          messageId: "m-in-1",
          threadId: "th-parity-1",
          from: { name: "Dana", address: "dana@acme.com" },
          to: [{ address: "me@orion.dev" }],
          subject: "Question 1",
          snippet: "Q1",
          body: "Question 1?",
          receivedAt: "2026-07-15T09:00:00.000Z",
        },
      }),
    );

    await first.runtime.record(
      makeEvent({
        type: EventTypes.MessageSent,
        source: "gmail-skill",
        id: "gmail:sent:m-out-1",
        occurredAt: "2026-07-15T10:00:00.000Z",
        payload: {
          messageId: "m-out-1",
          threadId: "th-parity-1",
          from: { address: "me@orion.dev" },
          to: [{ name: "Dana", address: "dana@acme.com" }],
          subject: "Re: Question 1",
          snippet: "Answer 1",
          body: "Here is answer 1",
          sentAt: "2026-07-15T10:00:00.000Z",
        },
      }),
    );

    await first.runtime.record(
      makeEvent({
        type: EventTypes.MessageReceived,
        source: "gmail-skill",
        id: "gmail:m-in-2",
        occurredAt: "2026-07-15T11:00:00.000Z",
        payload: {
          messageId: "m-in-2",
          threadId: "th-parity-2",
          from: { name: "Priya", address: "priya@acme.com" },
          to: [{ address: "me@orion.dev" }],
          subject: "Question 2",
          snippet: "Q2",
          body: "Question 2?",
          receivedAt: "2026-07-15T11:00:00.000Z",
        },
      }),
    );

    const liveContext = first.context.state;
    const liveItems = first.items();

    const second = runtimeOver(store);
    await second.runtime.rebuild();

    expect(second.context.state).toEqual(liveContext);
    expect(second.items()).toEqual(liveItems);
  });

  it("differentiates soft 'Not important' from hard 'Don't show again' and reversible unmute", async () => {
    const store = new SqliteEventStore(":memory:");
    const { runtime, attention, context, items } = runtimeOver(store);
    await runtime.rebuild();
    await new GmailSkill().ingest(runtime);

    const initial = items();
    const danaItem = initial.find((item) => item.subject.id === "th-dana");
    expect(danaItem).toBeDefined();
    expect(danaItem?.suppressionCandidate).toEqual({
      originator: { namespace: "gmail-skill", id: "dana@acme.com" },
      displayName: "Dana Lee",
    });

    // 1. Soft dismissal ("Not important")
    await runtime.record(
      makeEvent({ type: EventTypes.WorkItemDismissed, source: "user", payload: actionPayload(danaItem!) }),
    );
    expect(items().find((item) => item.subject.id === "th-dana")).toBeUndefined();

    // 2. Hard suppression ("Don't show again") on another item from Dana
    await runtime.record(
      makeEvent({
        type: EventTypes.MessageReceived,
        source: "gmail-skill",
        id: "gmail:m-dana-2",
        occurredAt: "2026-07-15T18:00:00.000Z",
        payload: {
          messageId: "m-dana-2",
          threadId: "th-dana-2",
          from: { name: "Dana Lee", address: "dana@acme.com" },
          to: [{ address: "me@orion.dev" }],
          subject: "Another question",
          snippet: "Second question",
          body: "Second question body?",
          receivedAt: "2026-07-15T18:00:00.000Z",
        },
      }),
    );

    const dana2Item = items().find((item) => item.subject.id === "th-dana-2");
    expect(dana2Item).toBeDefined();

    // Record hard originator suppression
    const suppressEvt = buildSuppressOriginatorEvent({
      context: context.state as ContextState,
      attention: attention.state as AttentionState,
      now: NOW,
      workItemId: dana2Item!.id,
      revision: dana2Item!.attentionRevision,
    });
    expect(suppressEvt).not.toBeNull();
    await runtime.record(suppressEvt!);

    // th-dana-2 is now hidden due to hard originator suppression
    expect(items().find((item) => item.subject.id === "th-dana-2")).toBeUndefined();

    // 3. Unmute
    const activeRule = (attention.state as AttentionState).suppressedOriginators[
      JSON.stringify(["gmail-skill", "dana@acme.com"])
    ];
    expect(activeRule).toBeDefined();

    const unsuppressEvt = buildUnsuppressOriginatorEvent({
      attention: attention.state as AttentionState,
      now: NOW,
      suppressionEventId: activeRule!.suppressionEventId,
    });
    expect(unsuppressEvt).not.toBeNull();
    await runtime.record(unsuppressEvt!);

    // th-dana-2 resurfaces after unmute
    expect(items().find((item) => item.subject.id === "th-dana-2")).toBeDefined();
    // th-dana remains hidden (soft-dismissed individually)
    expect(items().find((item) => item.subject.id === "th-dana")).toBeUndefined();
  });
});
