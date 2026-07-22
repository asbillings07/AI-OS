import { describe, it, expect } from "vitest";
import { InProcessEventBus, SqliteEventStore, OrionRuntime, ProjectionHost } from "../index.js";
import { makeEvent, type EventEnvelope } from "../events/index.js";
import {
  EventTypes,
  originatorKey,
  type AssignmentReceivedPayload,
  type MessageReceivedPayload,
  type OriginatorRef,
  type ReviewRequestedPayload,
} from "../domain/index.js";
import { contextProjection, type ContextState } from "../understanding/context.js";
import {
  importanceContributionFor,
  importanceFor,
  importanceScore,
  originatorFor,
  personalImportanceProjection,
  NEUTRAL_IMPORTANCE,
  type PersonalImportanceState,
} from "./index.js";

// --- Builders -------------------------------------------------------------

function message(
  id: string,
  threadId: string,
  receivedAt: string,
  fromAddress: string,
  source = "gmail-skill",
): EventEnvelope {
  const payload: MessageReceivedPayload = {
    messageId: id,
    threadId,
    from: { address: fromAddress },
    to: [{ address: "me@orion.dev" }],
    subject: "Quick question",
    snippet: "…",
    body: "Can you take a look?",
    receivedAt,
  };
  return makeEvent({ type: EventTypes.MessageReceived, source, payload, id, occurredAt: receivedAt });
}

function reviewEvent(
  id: string,
  changeId: string,
  requestedAt: string,
  requestedBy: string | undefined,
  source = "github-skill",
): EventEnvelope {
  const payload: ReviewRequestedPayload = {
    reviewRequestId: id,
    changeId,
    title: "Add retry to the event store",
    requestedBy: requestedBy ? { externalId: requestedBy } : undefined,
    location: changeId,
    url: "https://example.com/pull/1",
    requestedAt,
  };
  return makeEvent({ type: EventTypes.ReviewRequested, source, payload, id, occurredAt: requestedAt });
}

function assignmentEvent(
  id: string,
  itemId: string,
  assignedAt: string,
  assignedBy: string | undefined,
  source = "github-skill",
): EventEnvelope {
  const payload: AssignmentReceivedPayload = {
    assignmentId: id,
    itemId,
    title: "Fix the flaky test",
    assignedBy: assignedBy ? { externalId: assignedBy } : undefined,
    location: itemId,
    url: "https://example.com/issues/1",
    assignedAt,
  };
  return makeEvent({ type: EventTypes.AssignmentReceived, source, payload, id, occurredAt: assignedAt });
}

/** A #46-shaped action Event, optionally carrying a stamped originator. */
function action(
  type: string,
  id: string,
  originator?: OriginatorRef,
  occurredAt = "2026-07-15T12:00:00.000Z",
): EventEnvelope {
  return makeEvent({
    type,
    source: "user",
    id,
    occurredAt,
    payload: {
      workItemId: "wi-x",
      subject: { kind: "thread", id: "t1" },
      basisEventIds: ["m1"],
      ...(originator ? { originator } : {}),
    },
  });
}

/** A pre-#46 legacy action Event: thread-only, no Subject, no originator. */
function legacyAction(type: string, id: string): EventEnvelope {
  return makeEvent({
    type,
    source: "user",
    id,
    payload: { workItemId: "wi-t1", threadId: "t1" },
  });
}

function contextFrom(events: EventEnvelope[]): ContextState {
  let state = contextProjection.init();
  for (const event of events) state = contextProjection.apply(state, event);
  return state;
}

function foldImportance(events: EventEnvelope[]): PersonalImportanceState {
  let state = personalImportanceProjection.init();
  for (const event of events) state = personalImportanceProjection.apply(state, event);
  return state;
}

const DANA: OriginatorRef = { namespace: "gmail-skill", id: "dana@acme.com" };

// --- originatorFor: namespace comes from source, not Subject.kind ----------

describe("originatorFor: source-provenance namespace (#65)", () => {
  it("derives a thread originator from the latest message's sender and source", () => {
    const context = contextFrom([message("m1", "t1", "2026-07-15T12:00:00.000Z", "dana@acme.com")]);
    expect(originatorFor({ kind: "thread", id: "t1" }, context)).toEqual({
      namespace: "gmail-skill",
      id: "dana@acme.com",
    });
  });

  it("takes the namespace from the winning source Event, never from Subject.kind", () => {
    // A thread can come from a non-Gmail source. The namespace must follow the
    // actual source label, so importance stays correct as new Sources arrive.
    const context = contextFrom([
      message("m1", "t1", "2026-07-15T12:00:00.000Z", "dana@slack.example", "slack-skill"),
    ]);
    expect(originatorFor({ kind: "thread", id: "t1" }, context)?.namespace).toBe("slack-skill");
  });

  it("does NOT restamp the originator from a late-arriving older message", () => {
    // m1 (Dana) wins by occurrence time; a backfilled older message from Evan
    // grows provenance but must not become the current originator.
    const context = contextFrom([
      message("m1", "t1", "2026-07-15T12:00:00.000Z", "dana@acme.com"),
      message("m0", "t1", "2026-07-15T09:00:00.000Z", "evan@acme.com"),
    ]);
    expect(originatorFor({ kind: "thread", id: "t1" }, context)?.id).toBe("dana@acme.com");
  });

  it("uses a genuinely newer sender as the originator for the new revision", () => {
    const context = contextFrom([
      message("m1", "t1", "2026-07-15T12:00:00.000Z", "dana@acme.com"),
      message("m2", "t1", "2026-07-16T12:00:00.000Z", "carol@acme.com"),
    ]);
    expect(originatorFor({ kind: "thread", id: "t1" }, context)?.id).toBe("carol@acme.com");
  });

  it("derives review and assignment originators from the winning source", () => {
    const reviewCtx = contextFrom([reviewEvent("r1", "acme/orion#1", "2026-07-15T12:00:00.000Z", "dana")]);
    expect(originatorFor({ kind: "review", id: "acme/orion#1" }, reviewCtx)).toEqual({
      namespace: "github-skill",
      id: "dana",
    });

    const assignCtx = contextFrom([assignmentEvent("a1", "acme/orion#2", "2026-07-15T12:00:00.000Z", "erin")]);
    expect(originatorFor({ kind: "assignment", id: "acme/orion#2" }, assignCtx)).toEqual({
      namespace: "github-skill",
      id: "erin",
    });
  });

  it("keeps latestSource coupled to latestEventId for a review's winning occurrence", () => {
    // A newer review from actor A arrives, then an OLDER review from a different
    // source/actor B is backfilled. The occurrence winner (latestEventId) must
    // stay A's, so latestSource — and therefore the derived namespace — must
    // stay A's too. This is the invariant Personal Importance depends on: the
    // namespace can never drift from whichever occurrence actually won.
    const context = contextFrom([
      reviewEvent("r-new", "acme/orion#1", "2026-07-16T12:00:00.000Z", "dana", "github-skill"),
      reviewEvent("r-old", "acme/orion#1", "2026-07-15T09:00:00.000Z", "bilbo", "gitlab-skill"),
    ]);
    expect(originatorFor({ kind: "review", id: "acme/orion#1" }, context)).toEqual({
      namespace: "github-skill",
      id: "dana",
    });
  });

  it("keeps latestSource coupled to latestEventId for an assignment's winning occurrence", () => {
    const context = contextFrom([
      assignmentEvent("a-new", "acme/orion#2", "2026-07-16T12:00:00.000Z", "erin", "github-skill"),
      assignmentEvent("a-old", "acme/orion#2", "2026-07-15T09:00:00.000Z", "frodo", "jira-skill"),
    ]);
    expect(originatorFor({ kind: "assignment", id: "acme/orion#2" }, context)).toEqual({
      namespace: "github-skill",
      id: "erin",
    });
  });

  it("returns null when there is no meaningful originator", () => {
    const context = contextFrom([reviewEvent("r1", "acme/orion#1", "2026-07-15T12:00:00.000Z", undefined)]);
    // A check has no person; a missing requester and an unknown subject resolve to nothing.
    expect(originatorFor({ kind: "check", id: "acme/orion#1:check:ci" }, context)).toBeNull();
    expect(originatorFor({ kind: "review", id: "acme/orion#1" }, context)).toBeNull();
    expect(originatorFor({ kind: "thread", id: "missing" }, context)).toBeNull();
  });
});

// --- originatorKey: collision-safe ----------------------------------------

describe("originatorKey: collision-safe (#65)", () => {
  it("does not collide when a naive ns:id join would", () => {
    // Both would be "a:b:c" under `${namespace}:${id}`.
    const left: OriginatorRef = { namespace: "a:b", id: "c" };
    const right: OriginatorRef = { namespace: "a", id: "b:c" };
    expect(originatorKey(left)).not.toBe(originatorKey(right));
  });

  it("keeps the same external id in two namespaces separate", () => {
    expect(originatorKey({ namespace: "gmail-skill", id: "dana" })).not.toBe(
      originatorKey({ namespace: "github-skill", id: "dana" }),
    );
  });
});

// --- importanceScore: exact v1 curve --------------------------------------

describe("importanceScore: v1 curve (#65)", () => {
  it("is neutral until two decisive actions exist (no cold-start penalty)", () => {
    expect(importanceScore({ acted: 0, dismissed: 0 })).toBe(NEUTRAL_IMPORTANCE);
    expect(importanceScore({ acted: 1, dismissed: 0 })).toBe(NEUTRAL_IMPORTANCE);
    expect(importanceScore({ acted: 0, dismissed: 1 })).toBe(NEUTRAL_IMPORTANCE);
  });

  it("moves gradually and symmetrically off neutral", () => {
    expect(importanceScore({ acted: 2, dismissed: 0 })).toBeCloseTo(0.75, 10);
    expect(importanceScore({ acted: 0, dismissed: 2 })).toBeCloseTo(0.25, 10);
    expect(importanceScore({ acted: 1, dismissed: 1 })).toBeCloseTo(0.5, 10);
    expect(importanceScore({ acted: 3, dismissed: 1 })).toBeCloseTo(0.5 + 2 / 12, 10);
  });

  it("stays within [0,1] and never reaches the extremes", () => {
    const high = importanceScore({ acted: 100, dismissed: 0 });
    const low = importanceScore({ acted: 0, dismissed: 100 });
    expect(high).toBeGreaterThan(0.9);
    expect(high).toBeLessThan(1);
    expect(low).toBeLessThan(0.1);
    expect(low).toBeGreaterThan(0);
  });
});

// --- projection: folding dispositions -------------------------------------

describe("personalImportanceProjection: folding (#65)", () => {
  it("accumulates counts and evidence for a stamped originator", () => {
    const state = foldImportance([
      action(EventTypes.WorkItemActedOn, "act-1", DANA),
      action(EventTypes.WorkItemActedOn, "act-2", DANA),
      action(EventTypes.WorkItemDismissed, "act-3", DANA),
    ]);
    const entry = state.byOriginator[originatorKey(DANA)]!;
    expect(entry).toMatchObject({ acted: 2, dismissed: 1, snoozed: 0 });
    expect(entry.evidenceEventIds).toEqual(["act-1", "act-2", "act-3"]);
    expect(importanceFor(state, DANA)).toBeCloseTo(0.5 + 1 / 10, 10);
  });

  it("records snoozes but never lets them move the score off neutral", () => {
    const state = foldImportance([
      action(EventTypes.WorkItemSnoozed, "act-1", DANA),
      action(EventTypes.WorkItemSnoozed, "act-2", DANA),
      action(EventTypes.WorkItemSnoozed, "act-3", DANA),
    ]);
    const entry = state.byOriginator[originatorKey(DANA)]!;
    expect(entry).toMatchObject({ acted: 0, dismissed: 0, snoozed: 3 });
    // Snoozes never qualify as decisive evidence, so no ids and no recency.
    expect(entry.evidenceEventIds).toEqual([]);
    expect(entry.lastActionAt).toBeUndefined();
    expect(importanceFor(state, DANA)).toBe(NEUTRAL_IMPORTANCE);
  });

  it("stays neutral for legacy action events (no stamped originator)", () => {
    const state = foldImportance([
      legacyAction(EventTypes.WorkItemActedOn, "act-1"),
      legacyAction(EventTypes.WorkItemDismissed, "act-2"),
    ]);
    expect(state.byOriginator).toEqual({});
    expect(importanceFor(state, DANA)).toBe(NEUTRAL_IMPORTANCE);
  });

  it("records lastActionAt as the last qualifying action in append order", () => {
    const state = foldImportance([
      action(EventTypes.WorkItemActedOn, "act-1", DANA, "2026-07-15T12:00:00.000Z"),
      action(EventTypes.WorkItemSnoozed, "act-2", DANA, "2026-07-16T12:00:00.000Z"),
      action(EventTypes.WorkItemDismissed, "act-3", DANA, "2026-07-17T12:00:00.000Z"),
    ]);
    // The snooze is later but not qualifying; the dismissal is the last decisive action.
    expect(state.byOriginator[originatorKey(DANA)]!.lastActionAt).toBe("2026-07-17T12:00:00.000Z");
  });

  it("keeps the same external id in two namespaces independent", () => {
    const gmail: OriginatorRef = { namespace: "gmail-skill", id: "dana" };
    const github: OriginatorRef = { namespace: "github-skill", id: "dana" };
    const state = foldImportance([
      action(EventTypes.WorkItemActedOn, "act-1", gmail),
      action(EventTypes.WorkItemActedOn, "act-2", gmail),
      action(EventTypes.WorkItemDismissed, "act-3", github),
      action(EventTypes.WorkItemDismissed, "act-4", github),
    ]);
    expect(importanceFor(state, gmail)).toBeCloseTo(0.75, 10);
    expect(importanceFor(state, github)).toBeCloseTo(0.25, 10);
  });

  it("rebuilds an identical live state purely by replaying the log (ADR-0009)", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const liveHost = new ProjectionHost(personalImportanceProjection);
      const liveRuntime = new OrionRuntime({
        bus: new InProcessEventBus(),
        store,
        projections: [liveHost as ProjectionHost<unknown>],
      });

      await liveRuntime.record(action(EventTypes.WorkItemActedOn, "act-1", DANA));
      await liveRuntime.record(action(EventTypes.WorkItemDismissed, "act-2", DANA));
      await liveRuntime.record(action(EventTypes.WorkItemActedOn, "act-3", DANA));

      const live = structuredClone(liveHost.state);

      // A second runtime over the SAME store, with its own fresh projection host,
      // proves the state above was actually reconstructed from the log — not just
      // recomputed by the same in-memory fold.
      const rebuiltHost = new ProjectionHost(personalImportanceProjection);
      const rebuildRuntime = new OrionRuntime({
        bus: new InProcessEventBus(),
        store,
        projections: [rebuiltHost as ProjectionHost<unknown>],
      });
      await rebuildRuntime.rebuild();

      expect(rebuiltHost.state).toEqual(live);
    } finally {
      store.close();
    }
  });

  it("is source-neutral: identical histories on a Gmail and a GitHub key score identically", () => {
    const gmail: OriginatorRef = { namespace: "gmail-skill", id: "dana@acme.com" };
    const github: OriginatorRef = { namespace: "github-skill", id: "octo" };
    const history = (o: OriginatorRef, prefix: string) => [
      action(EventTypes.WorkItemActedOn, `${prefix}-1`, o),
      action(EventTypes.WorkItemActedOn, `${prefix}-2`, o),
      action(EventTypes.WorkItemDismissed, `${prefix}-3`, o),
    ];
    const state = foldImportance([...history(gmail, "g"), ...history(github, "h")]);
    expect(importanceFor(state, gmail)).toBe(importanceFor(state, github));
  });
});

// --- importanceContributionFor: the plain data prioritize() actually sees -----

describe("importanceContributionFor: evidence only when the score is off-neutral (#65)", () => {
  const context = contextFrom([message("m1", "t1", "2026-07-15T12:00:00.000Z", "dana@acme.com")]);
  const subject = { kind: "thread" as const, id: "t1" };

  it("is neutral with empty evidence when the originator has no history at all", () => {
    const contribution = importanceContributionFor(subject, context, personalImportanceProjection.init());
    expect(contribution).toMatchObject({ score: NEUTRAL_IMPORTANCE, evidenceEventIds: [] });
  });

  it("stays neutral with empty evidence below the two-decisive-action threshold (sparse history)", () => {
    // One acted Event exists (and is recorded on the entry), but a single decisive
    // action must not move the score, and the below-threshold entry must not leak
    // out as evidence for a score that never actually moved.
    const state = foldImportance([action(EventTypes.WorkItemActedOn, "act-1", DANA)]);
    const contribution = importanceContributionFor(subject, context, state);
    expect(contribution).toMatchObject({ score: NEUTRAL_IMPORTANCE, evidenceEventIds: [] });
  });

  it("stays neutral with empty evidence at an exact acted/dismissed balance", () => {
    // Two decisive actions exist (clearing the threshold) but they cancel out to
    // exactly neutral; the entry's evidence ids must still not be exposed.
    const state = foldImportance([
      action(EventTypes.WorkItemActedOn, "act-1", DANA),
      action(EventTypes.WorkItemDismissed, "act-2", DANA),
    ]);
    const contribution = importanceContributionFor(subject, context, state);
    expect(contribution).toMatchObject({ score: NEUTRAL_IMPORTANCE, evidenceEventIds: [] });
  });

  it("exposes the exact evidence ids once the score is genuinely off-neutral", () => {
    const state = foldImportance([
      action(EventTypes.WorkItemActedOn, "act-1", DANA),
      action(EventTypes.WorkItemActedOn, "act-2", DANA),
    ]);
    const contribution = importanceContributionFor(subject, context, state);
    expect(contribution?.score).toBeCloseTo(0.75, 10);
    expect(contribution?.evidenceEventIds).toEqual(["act-1", "act-2"]);
  });

  it("returns null (no contribution at all) when there is no meaningful originator", () => {
    const checkContext = contextFrom([]);
    const contribution = importanceContributionFor({ kind: "check", id: "x" }, checkContext, personalImportanceProjection.init());
    expect(contribution).toBeNull();
  });
});
