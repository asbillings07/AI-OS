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
import { actionEventId, buildActionEvent, type WorkItemAction } from "./index.js";

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

describe("work-item-actions: recorded actions replay identically (#61, ADR-0009)", () => {
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
});
