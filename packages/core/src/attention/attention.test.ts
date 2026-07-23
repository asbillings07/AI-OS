import { describe, it, expect } from "vitest";
import { makeEvent, type EventEnvelope } from "../events/index.js";
import { EventTypes, type MessageReceivedPayload, type ReviewRequestedPayload } from "../domain/index.js";
import { contextProjection } from "../understanding/context.js";
import { buildWorkItems, type WorkItem } from "../prioritization/index.js";
import { attentionProjection } from "./projection.js";
import { attentionRevision } from "./revision.js";

const NOW = "2026-07-15T17:00:00.000Z";
const LATER = "2026-07-18T17:00:00.000Z";
const REVIEW_CHANGE = "acme/orion#128";

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

function reviewEvent(id: string, requestedAt: string): EventEnvelope {
  const payload: ReviewRequestedPayload = {
    reviewRequestId: id,
    changeId: REVIEW_CHANGE,
    title: "Add retry to the event store",
    requestedBy: { externalId: "dana", displayName: "Dana Lee" },
    location: REVIEW_CHANGE,
    url: "https://github.com/acme/orion/pull/128",
    requestedAt,
  };
  return makeEvent({ type: EventTypes.ReviewRequested, source: "github-skill", payload, id, occurredAt: requestedAt });
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

function items(events: EventEnvelope[], now = NOW): WorkItem[] {
  const { context, attention } = project(events);
  return buildWorkItems({ context, attention, now });
}

function reviewVisible(events: EventEnvelope[], now = NOW): boolean {
  return items(events, now).some((item) => item.subject.kind === "review");
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

describe("Attention: suppression works for non-thread Subjects too (#46, ADR-0012)", () => {
  const reviewAction = (type: string, basisEventIds: string[], extra: object = {}) =>
    makeEvent({
      type,
      source: "user",
      payload: { workItemId: `wi-review:${REVIEW_CHANGE}`, subject: { kind: "review", id: REVIEW_CHANGE }, basisEventIds, ...extra },
    });

  it("completes the full action loop for a ReviewNeeded Work Item", () => {
    const r1 = reviewEvent("r1", "2026-07-15T12:00:00.000Z");
    expect(reviewVisible([r1])).toBe(true);

    // Handle it: hidden.
    const acted = reviewAction(EventTypes.WorkItemActedOn, ["r1"]);
    expect(reviewVisible([r1, acted])).toBe(false);

    // An OLDER occurrence backfills — the display winner stays r1, so it stays hidden.
    const r0 = reviewEvent("r0", "2026-07-15T09:00:00.000Z");
    expect(reviewVisible([r1, acted, r0])).toBe(false);

    // A genuinely NEWER occurrence arrives — a revision the action never covered,
    // so the review resurfaces.
    const r2 = reviewEvent("r2", "2026-07-16T12:00:00.000Z");
    expect(reviewVisible([r1, acted, r2])).toBe(true);
  });

  it("keeps a snoozed review hidden until expiry even when new evidence arrives", () => {
    const r1 = reviewEvent("r1", "2026-07-15T12:00:00.000Z");
    const snoozed = reviewAction(EventTypes.WorkItemSnoozed, ["r1"], { snoozedUntil: LATER });
    expect(reviewVisible([r1, snoozed], NOW)).toBe(false);

    // A new occurrence does NOT break the snooze before it expires...
    const r2 = reviewEvent("r2", "2026-07-16T12:00:00.000Z");
    expect(reviewVisible([r1, snoozed, r2], NOW)).toBe(false);
    // ...and the window expiry surfaces it again.
    expect(reviewVisible([r1, snoozed], "2026-07-19T12:00:00.000Z")).toBe(true);
  });
});

describe("Attention: optimistic-concurrency revision token (#46, blocking 1)", () => {
  it("changes when a genuinely new occurrence arrives, so a stale action is rejectable", () => {
    const r1 = reviewEvent("r1", "2026-07-15T12:00:00.000Z");
    const rendered = items([r1]).find((item) => item.subject.kind === "review")!;

    // The token the form carried is exactly what the server recomputes from the
    // same revision — a duplicate submit against the same card still matches.
    expect(rendered.attentionRevision).toBe(attentionRevision(rendered.subject, rendered.attentionBasisEventIds));

    // A newer occurrence arrives after render: the current token differs, so the
    // server's equality check rejects an action taken against the old card.
    const r2 = reviewEvent("r2", "2026-07-16T12:00:00.000Z");
    const current = items([r1, r2]).find((item) => item.subject.kind === "review")!;
    expect(current.attentionRevision).not.toBe(rendered.attentionRevision);

    // Recording the STALE basis (r1) leaves the review visible (r2 uncovered);
    // recording the CURRENT basis (r2) hides it. This is why the token guard matters.
    const staleAct = reviewActionFor(rendered);
    expect(reviewVisible([r1, r2, staleAct])).toBe(true);
    const currentAct = reviewActionFor(current);
    expect(reviewVisible([r1, r2, currentAct])).toBe(false);
  });

  it("is order-independent in the basis set", () => {
    const subject = { kind: "review", id: REVIEW_CHANGE } as const;
    expect(attentionRevision(subject, ["a", "b"])).toBe(attentionRevision(subject, ["b", "a"]));
  });
});

/** The current action Event the server would derive from a surfaced review item. */
function reviewActionFor(item: WorkItem): EventEnvelope {
  return makeEvent({
    type: EventTypes.WorkItemActedOn,
    source: "user",
    payload: { workItemId: item.id, subject: item.subject, basisEventIds: item.attentionBasisEventIds },
  });
}

describe("Attention: durable originator suppression (#83)", () => {
  const aliceGmail = { namespace: "gmail-skill", id: "alice@acme.com" };
  const aliceGithub = { namespace: "github-skill", id: "alice@acme.com" };

  function suppressEvent(id: string, originator: { namespace: string; id: string }, reason?: string): EventEnvelope {
    return makeEvent({
      id,
      type: EventTypes.OriginatorSuppressed,
      source: "user",
      payload: { originator, reason },
    });
  }

  function unsuppressEvent(
    id: string,
    originator: { namespace: string; id: string },
    suppressionEventId: string,
    reason?: string,
  ): EventEnvelope {
    return makeEvent({
      id,
      type: EventTypes.OriginatorUnsuppressed,
      source: "user",
      payload: { originator, suppressionEventId, reason },
    });
  }

  it("records active rule in suppressedOriginators and updates suppressionHeads", () => {
    const s1 = suppressEvent("sup1", aliceGmail);
    const { attention } = project([s1]);

    expect(attention.suppressedOriginators[JSON.stringify(["gmail-skill", "alice@acme.com"])]).toEqual({
      originator: aliceGmail,
      suppressionEventId: "sup1",
      suppressedAt: s1.occurredAt,
      reason: undefined,
    });
    expect(attention.suppressionHeads[JSON.stringify(["gmail-skill", "alice@acme.com"])]).toBe("sup1");
  });

  it("removes active rule on matching OriginatorUnsuppressed token and updates head", () => {
    const s1 = suppressEvent("sup1", aliceGmail);
    const u1 = unsuppressEvent("unsup1", aliceGmail, "sup1");
    const { attention } = project([s1, u1]);

    expect(attention.suppressedOriginators[JSON.stringify(["gmail-skill", "alice@acme.com"])]).toBeUndefined();
    expect(attention.suppressionHeads[JSON.stringify(["gmail-skill", "alice@acme.com"])]).toBe("unsup1");
  });

  it("ignores stale/mismatched OriginatorUnsuppressed token (projection no-op)", () => {
    const s1 = suppressEvent("sup1", aliceGmail);
    const uStale = unsuppressEvent("unsup-stale", aliceGmail, "wrong-id");
    const { attention } = project([s1, uStale]);

    expect(attention.suppressedOriginators[JSON.stringify(["gmail-skill", "alice@acme.com"])]?.suppressionEventId).toBe("sup1");
    expect(attention.suppressionHeads[JSON.stringify(["gmail-skill", "alice@acme.com"])]).toBe("sup1");
  });

  it("supports suppress -> unmute -> suppress cycles with sequential heads", () => {
    const s1 = suppressEvent("sup1", aliceGmail);
    const u1 = unsuppressEvent("unsup1", aliceGmail, "sup1");
    const s2 = suppressEvent("sup2", aliceGmail);
    const { attention } = project([s1, u1, s2]);

    expect(attention.suppressedOriginators[JSON.stringify(["gmail-skill", "alice@acme.com"])]?.suppressionEventId).toBe("sup2");
    expect(attention.suppressionHeads[JSON.stringify(["gmail-skill", "alice@acme.com"])]).toBe("sup2");
  });

  it("hides work items matching a suppressed originator regardless of subject disposition", () => {
    const m1 = message("m1", "t1", "2026-07-15T09:00:00.000Z"); // From dana@acme.com (gmail-skill)
    expect(visibleThreadIds([m1])).toContain("t1");

    const danaGmail = { namespace: "gmail-skill", id: "dana@acme.com" };
    const sup = suppressEvent("sup-dana", danaGmail);

    expect(visibleThreadIds([m1, sup])).not.toContain("t1");
  });

  it("respects namespace boundaries when muting an originator", () => {
    const m1 = message("m1", "t1", "2026-07-15T09:00:00.000Z"); // From dana@acme.com (gmail-skill)
    const supGithub = suppressEvent("sup-github", { namespace: "github-skill", id: "dana@acme.com" });

    // Muting github-skill:dana@acme.com does NOT hide gmail-skill:dana@acme.com
    expect(visibleThreadIds([m1, supGithub])).toContain("t1");
  });
});
