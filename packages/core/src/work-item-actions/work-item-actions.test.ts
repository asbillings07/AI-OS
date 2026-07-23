import { describe, it, expect } from "vitest";
import {
  InProcessEventBus,
  SqliteEventStore,
  OrionRuntime,
  ProjectionHost,
} from "../index.js";
import { makeEvent, type EventEnvelope } from "../events/index.js";
import { EventTypes, type ReviewRequestedPayload } from "../domain/index.js";
import { contextProjection } from "../understanding/context.js";
import { attentionProjection } from "../attention/projection.js";
import { buildWorkItems, type WorkItem } from "../prioritization/index.js";
import {
  actionEventId,
  buildActionEvent,
  buildSuppressOriginatorEvent,
  buildUnsuppressOriginatorEvent,
  suppressOriginatorEventId,
  unsuppressOriginatorEventId,
  type WorkItemAction,
} from "./index.js";

const NOW = "2026-07-15T17:00:00.000Z";
const REVIEW_CHANGE = "acme/orion#128";

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
  return makeEvent({
    type: EventTypes.ReviewRequested,
    source: "github-skill",
    payload,
    id,
    occurredAt: requestedAt,
  });
}

/** A review whose requester is unknown, so no originator can be resolved. */
function reviewEventNoActor(id: string, requestedAt: string): EventEnvelope {
  const payload: ReviewRequestedPayload = {
    reviewRequestId: id,
    changeId: REVIEW_CHANGE,
    title: "Add retry to the event store",
    location: REVIEW_CHANGE,
    url: "https://github.com/acme/orion/pull/128",
    requestedAt,
  };
  return makeEvent({
    type: EventTypes.ReviewRequested,
    source: "github-skill",
    payload,
    id,
    occurredAt: requestedAt,
  });
}

/** A live runtime with both projections, exactly as Mission Control boots it. */
function harness() {
  const store = new SqliteEventStore(":memory:");
  const bus = new InProcessEventBus();
  const context = new ProjectionHost(contextProjection);
  const attention = new ProjectionHost(attentionProjection);
  const runtime = new OrionRuntime({
    bus,
    store,
    projections: [context as ProjectionHost<unknown>, attention as ProjectionHost<unknown>],
  });
  return { store, runtime, context, attention };
}

type Harness = ReturnType<typeof harness>;

function reviewItem(h: Harness, now = NOW): WorkItem {
  const item = buildWorkItems({ context: h.context.state, attention: h.attention.state, now }).find(
    (candidate) => candidate.subject.kind === "review",
  );
  if (!item) throw new Error("expected a visible review Work Item");
  return item;
}

/** Mirror Mission Control's recordAction: decide inside the serialized section. */
function submit(
  h: Harness,
  workItemId: string,
  action: WorkItemAction,
  revision: string,
  now = NOW,
): Promise<boolean> {
  return h.runtime.recordExclusive(() =>
    buildActionEvent({
      context: h.context.state,
      attention: h.attention.state,
      now,
      workItemId,
      action,
      revision,
    }),
  );
}

const userEvents = (h: Harness) => h.store.readAll().filter((event) => event.source === "user");

describe("work-item-actions: concurrent submissions record exactly one Event (#61)", () => {
  it("dedupes two identical concurrent actions against the same revision", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const item = reviewItem(h);

    const results = await Promise.all([
      submit(h, item.id, "acted", item.attentionRevision),
      submit(h, item.id, "acted", item.attentionRevision),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(userEvents(h)).toHaveLength(1);
    expect(userEvents(h)[0]?.type).toBe(EventTypes.WorkItemActedOn);
  });

  it("arbitrates an acted-vs-snoozed race to a single recorded Event", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const item = reviewItem(h);

    const results = await Promise.all([
      submit(h, item.id, "acted", item.attentionRevision),
      submit(h, item.id, "snoozed", item.attentionRevision),
    ]);

    // The in-process exclusive guard lets only the first land; the second
    // re-resolves inside the section, sees the item gone, and records nothing.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(userEvents(h)).toHaveLength(1);
  });
});

describe("work-item-actions: the revision guard is enforced at record time (#61)", () => {
  it("records nothing for a stale revision", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const stale = reviewItem(h);

    // A genuinely newer occurrence arrives after the card was rendered.
    await h.runtime.record(reviewEvent("r2", "2026-07-16T12:00:00.000Z"));
    const countBefore = h.store.count();

    const recorded = await submit(h, stale.id, "acted", stale.attentionRevision);
    expect(recorded).toBe(false);
    expect(h.store.count()).toBe(countBefore);
  });

  it("records nothing (and returns false) for an unknown Work Item", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));

    const recorded = await submit(h, "wi-review:does-not-exist", "acted", "anything");
    expect(recorded).toBe(false);
    expect(userEvents(h)).toHaveLength(0);
  });

  it("records nothing for an unsupported action, even at a valid revision", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const item = reviewItem(h);

    // A hostile/forged action that bypassed compile-time typing must never mint
    // an Event with `type: undefined` — the exported trust boundary guards it.
    const recorded = await submit(
      h,
      item.id,
      "obliterate" as unknown as WorkItemAction,
      item.attentionRevision,
    );
    expect(recorded).toBe(false);
    expect(userEvents(h)).toHaveLength(0);
  });
});

describe("actionEventId: one deterministic id per action cycle (#61)", () => {
  const subject = { kind: "review", id: REVIEW_CHANGE } as const;
  const base = { action: "acted", subject, basisEventIds: ["r1"] } as const;

  it("is stable for identical inputs", () => {
    expect(actionEventId(base)).toBe(actionEventId(base));
  });

  it("is order-independent in the basis set", () => {
    expect(actionEventId({ ...base, basisEventIds: ["a", "b"] })).toBe(
      actionEventId({ ...base, basisEventIds: ["b", "a"] }),
    );
  });

  it("changes when the action, basis, or previous action id changes", () => {
    expect(actionEventId({ ...base, action: "snoozed" })).not.toBe(actionEventId(base));
    expect(actionEventId({ ...base, basisEventIds: ["r2"] })).not.toBe(actionEventId(base));
    expect(actionEventId({ ...base, previousActionEventId: "x" })).not.toBe(
      actionEventId({ ...base, previousActionEventId: "y" }),
    );
  });
});

describe("work-item-actions: snooze lifecycle survives expiry (#61)", () => {
  it("records a second Event when a resurfaced item is snoozed again", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));

    // Snooze it (24h) — this hides it.
    const first = reviewItem(h, NOW);
    expect(await submit(h, first.id, "snoozed", first.attentionRevision, NOW)).toBe(true);

    // After the window passes it resurfaces with the SAME basis (r1), so its
    // revision token is unchanged. Without chaining to the prior disposition's
    // id, the second snooze would recompute the same id and be permanently
    // deduped — the item could never be snoozed again.
    const AFTER = "2026-07-17T17:00:00.000Z";
    const second = reviewItem(h, AFTER);
    expect(second.attentionRevision).toBe(first.attentionRevision);
    expect(await submit(h, second.id, "snoozed", second.attentionRevision, AFTER)).toBe(true);

    const snoozes = h.store.readAll().filter((event) => event.type === EventTypes.WorkItemSnoozed);
    expect(snoozes).toHaveLength(2);
    expect(snoozes[0]?.id).not.toBe(snoozes[1]?.id);
  });
});

describe("work-item-actions: stamps a source-neutral originator (#65)", () => {
  it("stamps the winning source's actor onto the recorded action", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const item = reviewItem(h);
    await submit(h, item.id, "acted", item.attentionRevision);

    const recorded = userEvents(h)[0] as EventEnvelope;
    expect((recorded.payload as { originator?: unknown }).originator).toEqual({
      namespace: "github-skill",
      id: "dana",
    });
  });

  it("omits the originator when none is resolvable", async () => {
    const h = harness();
    await h.runtime.record(reviewEventNoActor("r1", "2026-07-15T12:00:00.000Z"));
    const item = reviewItem(h);
    await submit(h, item.id, "acted", item.attentionRevision);

    const recorded = userEvents(h)[0] as EventEnvelope;
    expect((recorded.payload as { originator?: unknown }).originator).toBeUndefined();
  });
});

describe("work-item-actions: durable originator suppression and unsuppression (#83)", () => {
  it("builds OriginatorSuppressed event with server-derived originator and deterministic ID", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const item = reviewItem(h);

    const recorded = await h.runtime.recordExclusive(() =>
      buildSuppressOriginatorEvent({
        context: h.context.state,
        attention: h.attention.state,
        now: NOW,
        workItemId: item.id,
        revision: item.attentionRevision,
        reason: "Too noisy",
      }),
    );

    expect(recorded).toBe(true);
    const events = userEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventTypes.OriginatorSuppressed);
    expect((events[0]?.payload as { originator: unknown }).originator).toEqual({
      namespace: "github-skill",
      id: "dana",
    });
  });

  it("rejects suppression for a stale revision or unknown work item", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const item = reviewItem(h);

    await h.runtime.record(reviewEvent("r2", "2026-07-16T12:00:00.000Z")); // updates revision

    const staleResult = await h.runtime.recordExclusive(() =>
      buildSuppressOriginatorEvent({
        context: h.context.state,
        attention: h.attention.state,
        now: NOW,
        workItemId: item.id,
        revision: item.attentionRevision,
      }),
    );
    expect(staleResult).toBe(false);

    const unknownResult = await h.runtime.recordExclusive(() =>
      buildSuppressOriginatorEvent({
        context: h.context.state,
        attention: h.attention.state,
        now: NOW,
        workItemId: "wi-unknown",
        revision: "rev",
      }),
    );
    expect(unknownResult).toBe(false);
  });

  it("builds OriginatorUnsuppressed event for valid active rule token and rejects stale token", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const item = reviewItem(h);

    // First suppress
    await h.runtime.recordExclusive(() =>
      buildSuppressOriginatorEvent({
        context: h.context.state,
        attention: h.attention.state,
        now: NOW,
        workItemId: item.id,
        revision: item.attentionRevision,
      }),
    );

    const activeRule = h.attention.state.suppressedOriginators[JSON.stringify(["github-skill", "dana"])];
    expect(activeRule).toBeDefined();

    // Reject invalid token
    const badUnsup = await h.runtime.recordExclusive(() =>
      buildUnsuppressOriginatorEvent({
        attention: h.attention.state,
        now: NOW,
        suppressionEventId: "wrong-id",
      }),
    );
    expect(badUnsup).toBe(false);

    // Accept valid token
    const validUnsup = await h.runtime.recordExclusive(() =>
      buildUnsuppressOriginatorEvent({
        attention: h.attention.state,
        now: NOW,
        suppressionEventId: activeRule!.suppressionEventId,
      }),
    );
    expect(validUnsup).toBe(true);

    const events = userEvents(h);
    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe(EventTypes.OriginatorUnsuppressed);
  });

  it("enforces expectedSuppressionHeadEventId guard: stale pre-unmute form rejected, fresh post-unmute form succeeds (#83)", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const preSuppressItem = reviewItem(h);
    expect(preSuppressItem.suppressionCandidate?.expectedSuppressionHeadEventId).toBeUndefined();

    // 1. First suppress using preSuppressItem
    const suppress1 = await h.runtime.recordExclusive(() =>
      buildSuppressOriginatorEvent({
        context: h.context.state,
        attention: h.attention.state,
        now: NOW,
        workItemId: preSuppressItem.id,
        revision: preSuppressItem.attentionRevision,
        expectedSuppressionHeadEventId: preSuppressItem.suppressionCandidate?.expectedSuppressionHeadEventId,
      }),
    );
    expect(suppress1).toBe(true);

    const activeRule = h.attention.state.suppressedOriginators[JSON.stringify(["github-skill", "dana"])];
    expect(activeRule).toBeDefined();

    // 2. Unmute
    const unmuteResult = await h.runtime.recordExclusive(() =>
      buildUnsuppressOriginatorEvent({
        attention: h.attention.state,
        now: NOW,
        suppressionEventId: activeRule!.suppressionEventId,
      }),
    );
    expect(unmuteResult).toBe(true);

    // 3. Stale submission attempt using pre-Unmute form (expectedSuppressionHeadEventId = undefined)
    const staleResult = await h.runtime.recordExclusive(() =>
      buildSuppressOriginatorEvent({
        context: h.context.state,
        attention: h.attention.state,
        now: NOW,
        workItemId: preSuppressItem.id,
        revision: preSuppressItem.attentionRevision,
        expectedSuppressionHeadEventId: preSuppressItem.suppressionCandidate?.expectedSuppressionHeadEventId,
      }),
    );
    expect(staleResult).toBe(false);

    // 4. Freshly rendered post-Unmute item carrying expectedSuppressionHeadEventId = <unmuteEventId>
    const postUnmuteItem = reviewItem(h);
    expect(postUnmuteItem.suppressionCandidate?.expectedSuppressionHeadEventId).toBe(
      h.attention.state.suppressionHeads[JSON.stringify(["github-skill", "dana"])],
    );

    // 5. Re-suppress with fresh token succeeds and produces new deterministic event ID
    const freshResult = await h.runtime.recordExclusive(() =>
      buildSuppressOriginatorEvent({
        context: h.context.state,
        attention: h.attention.state,
        now: NOW,
        workItemId: postUnmuteItem.id,
        revision: postUnmuteItem.attentionRevision,
        expectedSuppressionHeadEventId: postUnmuteItem.suppressionCandidate?.expectedSuppressionHeadEventId,
      }),
    );
    expect(freshResult).toBe(true);

    const suppressEvents = userEvents(h).filter((e) => e.type === EventTypes.OriginatorSuppressed);
    expect(suppressEvents).toHaveLength(2);
    expect(suppressEvents[0]?.id).not.toBe(suppressEvents[1]?.id);
  });

  it("deduplicates concurrent duplicate suppression submissions", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const item = reviewItem(h);

    const results = await Promise.all([
      h.runtime.recordExclusive(() =>
        buildSuppressOriginatorEvent({
          context: h.context.state,
          attention: h.attention.state,
          now: NOW,
          workItemId: item.id,
          revision: item.attentionRevision,
          expectedSuppressionHeadEventId: item.suppressionCandidate?.expectedSuppressionHeadEventId,
        }),
      ),
      h.runtime.recordExclusive(() =>
        buildSuppressOriginatorEvent({
          context: h.context.state,
          attention: h.attention.state,
          now: NOW,
          workItemId: item.id,
          revision: item.attentionRevision,
          expectedSuppressionHeadEventId: item.suppressionCandidate?.expectedSuppressionHeadEventId,
        }),
      ),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(userEvents(h)).toHaveLength(1);
    expect(userEvents(h)[0]?.type).toBe(EventTypes.OriginatorSuppressed);
  });
});

function messageEvent(
  id: string,
  threadId: string,
  receivedAt: string,
  fromAddress: string,
  source = "gmail-skill",
): EventEnvelope {
  return makeEvent({
    type: EventTypes.MessageReceived,
    source,
    id,
    occurredAt: receivedAt,
    payload: {
      messageId: id,
      threadId,
      from: { address: fromAddress },
      to: [{ address: "me@orion.dev" }],
      subject: "Thread test",
      snippet: "Test",
      body: "Test body",
      receivedAt,
    },
  });
}

describe("work-item-actions: recorded actions replay identically (#61, #83, ADR-0009)", () => {
  it("rebuilds the same Attention state from the log alone", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const item = reviewItem(h);
    await submit(h, item.id, "acted", item.attentionRevision);
    const liveAttention = structuredClone(h.attention.state);

    const bus2 = new InProcessEventBus();
    const context2 = new ProjectionHost(contextProjection);
    const attention2 = new ProjectionHost(attentionProjection);
    const runtime2 = new OrionRuntime({
      bus: bus2,
      store: h.store,
      projections: [context2 as ProjectionHost<unknown>, attention2 as ProjectionHost<unknown>],
    });
    await runtime2.rebuild();

    expect(attention2.state).toEqual(liveAttention);
  });

  it("rebuilds exact active suppression state and visible Work Items from log alone (#83)", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const item = reviewItem(h);

    await h.runtime.recordExclusive(() =>
      buildSuppressOriginatorEvent({
        context: h.context.state,
        attention: h.attention.state,
        now: NOW,
        workItemId: item.id,
        revision: item.attentionRevision,
      }),
    );

    const liveAttention = structuredClone(h.attention.state);
    const liveItems = buildWorkItems({ context: h.context.state, attention: h.attention.state, now: NOW });

    const bus2 = new InProcessEventBus();
    const context2 = new ProjectionHost(contextProjection);
    const attention2 = new ProjectionHost(attentionProjection);
    const runtime2 = new OrionRuntime({
      bus: bus2,
      store: h.store,
      projections: [context2 as ProjectionHost<unknown>, attention2 as ProjectionHost<unknown>],
    });
    await runtime2.rebuild();

    expect(attention2.state).toEqual(liveAttention);
    expect(buildWorkItems({ context: context2.state, attention: attention2.state, now: NOW })).toEqual(liveItems);
  });

  it("rebuilds exact suppress -> unmute -> re-suppress state including suppressionHeads (#83)", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z"));
    const preSuppressItem = reviewItem(h);

    // Suppress
    const suppressResult = await h.runtime.recordExclusive(() =>
      buildSuppressOriginatorEvent({
        context: h.context.state,
        attention: h.attention.state,
        now: NOW,
        workItemId: preSuppressItem.id,
        revision: preSuppressItem.attentionRevision,
        expectedSuppressionHeadEventId: preSuppressItem.suppressionCandidate?.expectedSuppressionHeadEventId,
      }),
    );
    expect(suppressResult).toBe(true);

    const activeRule = h.attention.state.suppressedOriginators[JSON.stringify(["github-skill", "dana"])];
    expect(activeRule).toBeDefined();

    // Unmute
    const unmuteResult = await h.runtime.recordExclusive(() =>
      buildUnsuppressOriginatorEvent({
        attention: h.attention.state,
        now: NOW,
        suppressionEventId: activeRule!.suppressionEventId,
      }),
    );
    expect(unmuteResult).toBe(true);

    // Re-render fresh Work Item post-Unmute
    const postUnmuteItem = reviewItem(h);
    expect(postUnmuteItem.suppressionCandidate?.expectedSuppressionHeadEventId).toBe(
      h.attention.state.suppressionHeads[JSON.stringify(["github-skill", "dana"])],
    );

    // Re-suppress
    const resuppressResult = await h.runtime.recordExclusive(() =>
      buildSuppressOriginatorEvent({
        context: h.context.state,
        attention: h.attention.state,
        now: NOW,
        workItemId: postUnmuteItem.id,
        revision: postUnmuteItem.attentionRevision,
        expectedSuppressionHeadEventId: postUnmuteItem.suppressionCandidate?.expectedSuppressionHeadEventId,
      }),
    );
    expect(resuppressResult).toBe(true);

    const reActiveRule = h.attention.state.suppressedOriginators[JSON.stringify(["github-skill", "dana"])];
    expect(reActiveRule).toBeDefined();

    const liveAttention = structuredClone(h.attention.state);
    const liveItems = buildWorkItems({ context: h.context.state, attention: h.attention.state, now: NOW });

    const bus2 = new InProcessEventBus();
    const context2 = new ProjectionHost(contextProjection);
    const attention2 = new ProjectionHost(attentionProjection);
    const runtime2 = new OrionRuntime({
      bus: bus2,
      store: h.store,
      projections: [context2 as ProjectionHost<unknown>, attention2 as ProjectionHost<unknown>],
    });
    await runtime2.rebuild();

    expect(attention2.state.suppressedOriginators).toEqual(liveAttention.suppressedOriginators);
    expect(attention2.state.suppressionHeads).toEqual(liveAttention.suppressionHeads);
    expect(buildWorkItems({ context: context2.state, attention: attention2.state, now: NOW })).toEqual(liveItems);
  });

  it("keeps new revisions from the same suppressed originator hidden before and after rebuild (#83)", async () => {
    const h = harness();
    await h.runtime.record(reviewEvent("r1", "2026-07-15T12:00:00.000Z")); // dana
    const item = reviewItem(h);

    await h.runtime.recordExclusive(() =>
      buildSuppressOriginatorEvent({
        context: h.context.state,
        attention: h.attention.state,
        now: NOW,
        workItemId: item.id,
        revision: item.attentionRevision,
      }),
    );

    // Newer occurrence from same originator dana
    await h.runtime.record(reviewEvent("r2", "2026-07-16T12:00:00.000Z"));

    const liveItems = buildWorkItems({ context: h.context.state, attention: h.attention.state, now: NOW });
    expect(liveItems.find((wi) => wi.subject.id === REVIEW_CHANGE)).toBeUndefined();

    const bus2 = new InProcessEventBus();
    const context2 = new ProjectionHost(contextProjection);
    const attention2 = new ProjectionHost(attentionProjection);
    const runtime2 = new OrionRuntime({
      bus: bus2,
      store: h.store,
      projections: [context2 as ProjectionHost<unknown>, attention2 as ProjectionHost<unknown>],
    });
    await runtime2.rebuild();

    const rebuiltItems = buildWorkItems({ context: context2.state, attention: attention2.state, now: NOW });
    expect(rebuiltItems).toEqual(liveItems);
    expect(rebuiltItems.find((wi) => wi.subject.id === REVIEW_CHANGE)).toBeUndefined();
  });

  it("resurfaces thread when a different current originator arrives, identically after rebuild (#83)", async () => {
    const h = harness();
    // Message 1 from dana@acme.com
    await h.runtime.record(messageEvent("m1", "t1", "2026-07-15T09:00:00.000Z", "dana@acme.com"));

    const threadItem = buildWorkItems({ context: h.context.state, attention: h.attention.state, now: NOW }).find(
      (wi) => wi.subject.id === "t1",
    );
    expect(threadItem).toBeDefined();

    // Suppress gmail-skill:dana@acme.com
    await h.runtime.recordExclusive(() =>
      buildSuppressOriginatorEvent({
        context: h.context.state,
        attention: h.attention.state,
        now: NOW,
        workItemId: threadItem!.id,
        revision: threadItem!.attentionRevision,
      }),
    );

    // Now thread t1 is hidden
    expect(
      buildWorkItems({ context: h.context.state, attention: h.attention.state, now: NOW }).find(
        (wi) => wi.subject.id === "t1",
      ),
    ).toBeUndefined();

    // Message 2 on same thread t1 from carol@acme.com (different originator)
    await h.runtime.record(messageEvent("m2", "t1", "2026-07-16T09:00:00.000Z", "carol@acme.com"));

    // Thread t1 resurfaces because current originator is now carol@acme.com
    const liveItems = buildWorkItems({ context: h.context.state, attention: h.attention.state, now: NOW });
    expect(liveItems.find((wi) => wi.subject.id === "t1")).toBeDefined();

    // Rebuild log and verify exact parity
    const bus2 = new InProcessEventBus();
    const context2 = new ProjectionHost(contextProjection);
    const attention2 = new ProjectionHost(attentionProjection);
    const runtime2 = new OrionRuntime({
      bus: bus2,
      store: h.store,
      projections: [context2 as ProjectionHost<unknown>, attention2 as ProjectionHost<unknown>],
    });
    await runtime2.rebuild();

    const rebuiltItems = buildWorkItems({ context: context2.state, attention: attention2.state, now: NOW });
    expect(rebuiltItems).toEqual(liveItems);
    expect(rebuiltItems.find((wi) => wi.subject.id === "t1")).toBeDefined();
  });
});
