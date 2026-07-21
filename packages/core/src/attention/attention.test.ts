import { describe, it, expect } from "vitest";
import { makeEvent, type EventEnvelope } from "../events/index.js";
import { EventTypes, type MessageReceivedPayload } from "../domain/index.js";
import { contextProjection } from "../understanding/context.js";
import { buildWorkItems } from "../prioritization/index.js";
import { attentionProjection } from "./projection.js";

const NOW = "2026-07-15T17:00:00.000Z";
const LATER = "2026-07-18T17:00:00.000Z";

function message(id: string, threadId: string, receivedAt: string): EventEnvelope {
  const payload: MessageReceivedPayload = {
    messageId: id,
    threadId,
    from: { name: "Dana Lee", address: "dana@acme.com" },
    to: [{ address: "me@orion.dev" }],
    subject: "Quick question",
    snippet: "Can you review the deck?",
    body: "Can you review the deck before Friday?",
    receivedAt,
  };
  return makeEvent({ type: EventTypes.MessageReceived, source: "gmail-skill", payload, id });
}

/** Fold events into BOTH projections, exactly as the runtime does. */
function project(events: EventEnvelope[]) {
  let context = contextProjection.init();
  let attention = attentionProjection.init();
  for (const event of events) {
    context = contextProjection.apply(context, event);
    attention = attentionProjection.apply(attention, event);
  }
  return { context, attention };
}

function visibleThreadIds(events: EventEnvelope[], now = NOW): string[] {
  const { context, attention } = project(events);
  return buildWorkItems({ context, attention, now })
    .filter((item) => item.subject.kind === "thread")
    .map((item) => item.subject.id);
}

/** The current action payload the server derives from a surfaced Work Item. */
function currentAction(type: string, subjectId: string, basisEventIds: string[], extra: object = {}) {
  return makeEvent({
    type,
    source: "user",
    payload: { workItemId: `wi-${subjectId}`, subject: { kind: "thread", id: subjectId }, basisEventIds, ...extra },
  });
}

function legacyAction(type: string, threadId: string, extra: object = {}) {
  return makeEvent({
    type,
    source: "user",
    payload: { workItemId: `wi-${threadId}`, threadId, ...extra },
  });
}

describe("Attention: evidence-scoped suppression (#46, ADR-0012)", () => {
  it("hides an acted item until a genuinely new occurrence arrives", () => {
    const m1 = message("m1", "t1", "2026-07-15T09:00:00.000Z");
    expect(visibleThreadIds([m1])).toContain("t1");

    const acted = currentAction(EventTypes.WorkItemActedOn, "t1", ["m1"]);
    expect(visibleThreadIds([m1, acted])).not.toContain("t1");

    // A new inbound message is a new revision the action never covered: it resurfaces.
    const m2 = message("m2", "t1", "2026-07-16T09:00:00.000Z");
    expect(visibleThreadIds([m1, acted, m2])).toContain("t1");
  });

  it("keeps a dismissed item hidden across pure re-derivation", () => {
    const m1 = message("m1", "t1", "2026-07-15T09:00:00.000Z");
    const dismissed = currentAction(EventTypes.WorkItemDismissed, "t1", ["m1"]);
    expect(visibleThreadIds([m1, dismissed])).not.toContain("t1");
    // Re-deriving at a later time (no new occurrence) does not resurface it.
    expect(visibleThreadIds([m1, dismissed], LATER)).not.toContain("t1");
  });

  it("hides a snoozed item until the window passes", () => {
    const m1 = message("m1", "t1", "2026-07-15T09:00:00.000Z");
    const snoozed = currentAction(EventTypes.WorkItemSnoozed, "t1", ["m1"], {
      snoozedUntil: "2026-07-16T09:00:00.000Z",
    });
    expect(visibleThreadIds([m1, snoozed], NOW)).not.toContain("t1");
    expect(visibleThreadIds([m1, snoozed], LATER)).toContain("t1");
  });

  it("fails open on a malformed snooze timestamp (never permanently hides work)", () => {
    const m1 = message("m1", "t1", "2026-07-15T09:00:00.000Z");
    const snoozed = currentAction(EventTypes.WorkItemSnoozed, "t1", ["m1"], { snoozedUntil: "not-a-date" });
    expect(visibleThreadIds([m1, snoozed], NOW)).toContain("t1");
  });

  it("lets the latest action win by append order", () => {
    const m1 = message("m1", "t1", "2026-07-15T09:00:00.000Z");
    const snooze = currentAction(EventTypes.WorkItemSnoozed, "t1", ["m1"], { snoozedUntil: LATER });
    const acted = currentAction(EventTypes.WorkItemActedOn, "t1", ["m1"]);
    const m2 = message("m2", "t1", "2026-07-16T09:00:00.000Z");

    // snooze THEN act: acted wins, so a new occurrence resurfaces it before the
    // snooze window would have expired.
    expect(visibleThreadIds([m1, snooze, acted, m2], NOW)).toContain("t1");
    // act THEN snooze: snooze wins, so it stays hidden despite the new occurrence.
    expect(visibleThreadIds([m1, acted, snooze, m2], NOW)).not.toContain("t1");
  });
});

describe("Attention: legacy thread dispositions replay faithfully (#46, ADR-0012)", () => {
  it("reopens a legacy acted thread on a later inbound message", () => {
    const m1 = message("m1", "t1", "2026-07-15T09:00:00.000Z");
    const acted = legacyAction(EventTypes.WorkItemActedOn, "t1");
    expect(visibleThreadIds([m1, acted])).not.toContain("t1");

    const m2 = message("m2", "t1", "2026-07-16T09:00:00.000Z");
    expect(visibleThreadIds([m1, acted, m2])).toContain("t1");
  });

  it("keeps a legacy dismissed thread muted even when the conversation continues", () => {
    const m1 = message("m1", "t1", "2026-07-15T09:00:00.000Z");
    const dismissed = legacyAction(EventTypes.WorkItemDismissed, "t1");
    const m2 = message("m2", "t1", "2026-07-16T09:00:00.000Z");
    expect(visibleThreadIds([m1, dismissed, m2])).not.toContain("t1");
  });

  it("reopens a legacy snoozed thread on inbound or on window expiry", () => {
    const m1 = message("m1", "t1", "2026-07-15T09:00:00.000Z");
    const snoozed = legacyAction(EventTypes.WorkItemSnoozed, "t1", { snoozedUntil: LATER });
    expect(visibleThreadIds([m1, snoozed], NOW)).not.toContain("t1");
    // Inbound reopens before the window...
    const m2 = message("m2", "t1", "2026-07-16T09:00:00.000Z");
    expect(visibleThreadIds([m1, snoozed, m2], NOW)).toContain("t1");
    // ...and the window expiry alone reopens it too.
    expect(visibleThreadIds([m1, snoozed], "2026-07-19T09:00:00.000Z")).toContain("t1");
  });
});
