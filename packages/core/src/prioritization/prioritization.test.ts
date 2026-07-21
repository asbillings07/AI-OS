import { describe, it, expect } from "vitest";
import { makeEvent } from "../events/index.js";
import { EventTypes, type MessageReceivedPayload } from "../domain/index.js";
import { contextProjection, type ContextState } from "../understanding/context.js";
import { detectOpportunities } from "../opportunity/index.js";
import { estimateCapacity } from "../capacity/index.js";
import { attentionProjection } from "../attention/index.js";
import { buildWorkItems, prioritize, compareWorkItems, type WorkItem } from "./index.js";

const NO_ATTENTION = attentionProjection.init();

/** Build Work Items with no user disposition (the common case in these tests). */
function items(context: ContextState, now: string) {
  return buildWorkItems({ context, attention: NO_ATTENTION, now });
}

function message(overrides: Partial<MessageReceivedPayload> & { threadId: string; messageId: string }) {
  const payload: MessageReceivedPayload = {
    from: { name: "Dana Lee", address: "dana@acme.com" },
    to: [{ address: "me@orion.dev" }],
    subject: "Quick question",
    snippet: "Can you review the deck?",
    body: "Hi — can you review the deck before Friday?",
    receivedAt: "2026-07-15T15:00:00.000Z",
    ...overrides,
  };
  return makeEvent({ type: EventTypes.MessageReceived, source: "gmail-skill", payload, id: `evt-${payload.messageId}` });
}

function contextOf(events: ReturnType<typeof message>[]): ContextState {
  return events.reduce((state, event) => contextProjection.apply(state, event), contextProjection.init());
}

const NOON = "2026-07-15T17:00:00.000Z"; // within working hours (UTC)

describe("Opportunity detection (#26)", () => {
  it("creates a ReplyNeeded opportunity for a person's question, none for newsletters", () => {
    const context = contextOf([
      message({ threadId: "t1", messageId: "m1" }),
      message({
        threadId: "t2",
        messageId: "m2",
        from: { address: "no-reply@news.com" },
        subject: "Digest",
        body: "Weekly digest.",
      }),
    ]);
    const opportunities = detectOpportunities(context, NOON);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.subject).toEqual({ kind: "thread", id: "t1" });
    expect(opportunities[0]?.kind).toBe("ReplyNeeded");
  });
});

describe("Prioritization (#29)", () => {
  it("produces structured, explainable Work Items", () => {
    const context = contextOf([message({ threadId: "t1", messageId: "m1" })]);
    const [item] = items(context, NOON);
    expect(item).toBeDefined();
    // The structured Explanation the reviewer asked for.
    expect(item).toMatchObject({
      id: "wi-t1",
      subject: { kind: "thread", id: "t1" },
      title: "Quick question",
    });
    expect(typeof item?.priority).toBe("number");
    expect(item?.opportunity).toBeGreaterThan(0);
    expect(item?.reason.length).toBeGreaterThan(0);
    expect(item?.evidence.length).toBeGreaterThan(0);
    expect(item?.createdFromEventIds).toContain("evt-m1");
  });

  it("answers 'why is this here?' with no AI (deterministic explanation)", () => {
    const context = contextOf([message({ threadId: "t1", messageId: "m1" })]);
    const [item] = items(context, NOON);
    expect(item?.reason).toContain("not replied");
    expect(item?.reason).toContain("direct question");
    // No summary was attached: the explanation stands entirely without AI.
    expect(item?.summary).toBeUndefined();
  });

  it("keeps the four inputs independent (not a single product)", () => {
    const context = contextOf([message({ threadId: "t1", messageId: "m1" })]);
    const [item] = items(context, NOON);
    expect(item).toHaveProperty("opportunity");
    expect(item).toHaveProperty("capacity");
    expect(item).toHaveProperty("commitment");
    expect(item).toHaveProperty("urgency");
  });

  it("low Capacity raises the attention bar, moving items to 'can wait'", () => {
    const context = contextOf([message({ threadId: "t1", messageId: "m1" })]);
    const opportunities = detectOpportunities(context, NOON);

    const highCapacity = prioritize(opportunities, { level: 0.9, evidence: [] });
    const lowCapacity = prioritize(opportunities, { level: 0.1, evidence: [] });

    // Same intrinsic priority, different banding driven purely by Capacity.
    expect(highCapacity[0]?.priority).toBe(lowCapacity[0]?.priority);
    expect(highCapacity[0]?.band).toBe("needs_attention");
    expect(lowCapacity[0]?.band).toBe("can_wait");
  });

  it("ranks a known correspondent's question above a stranger's FYI", () => {
    const context = contextOf([
      // Known person: appears twice -> relationship/commitment.
      message({ threadId: "t1", messageId: "m1a", subject: "Deck", body: "Can you review the deck?" }),
      message({ threadId: "t2", messageId: "m1b", subject: "Deck follow-up", body: "Thanks!" }),
      // Stranger, no question.
      message({
        threadId: "t3",
        messageId: "m2",
        from: { name: "Stranger", address: "someone@elsewhere.com" },
        subject: "FYI",
        body: "Just sharing an update, no action needed.",
      }),
    ]);
    const ranked = items(context, NOON);
    expect(ranked[0]?.subject.id === "t1" || ranked[0]?.subject.id === "t2").toBe(true);
    expect(ranked[ranked.length - 1]?.subject.id).toBe("t3");
  });

  it("produces silence (no Work Items) when nothing awaits action", () => {
    const context = contextOf([
      message({ threadId: "t1", messageId: "m1", from: { address: "no-reply@news.com" }, body: "digest" }),
    ]);
    expect(items(context, NOON)).toHaveLength(0);
  });
});

describe("cross-source ranking is source-neutral (#46)", () => {
  function itemFixture(overrides: Partial<WorkItem>): WorkItem {
    return {
      id: "wi-x",
      subject: { kind: "thread", id: "x" },
      kind: "ReplyNeeded",
      title: "x",
      band: "can_wait",
      priority: 0.5,
      opportunity: 0.5,
      capacity: 0.5,
      commitment: 0.5,
      urgency: 0.5,
      reason: "",
      evidence: [],
      createdFromEventIds: [],
      attentionBasisEventIds: [],
      ...overrides,
    };
  }

  it("breaks exact ties by subjectKey, never by detector/array order", () => {
    // Two items identical on every ranked dimension: only the subject differs.
    const gh = itemFixture({ id: "wi-review:z", subject: { kind: "review", id: "z" }, kind: "ReviewNeeded" });
    const email = itemFixture({ id: "wi-thread:a", subject: { kind: "thread", id: "a" } });

    // Whatever order they arrive in, the deterministic tie-break wins.
    const forward = [gh, email].slice().sort(compareWorkItems).map((i) => i.id);
    const backward = [email, gh].slice().sort(compareWorkItems).map((i) => i.id);
    expect(forward).toEqual(backward);
    // "review:z" < "thread:a" lexicographically, so the review sorts first.
    expect(forward[0]).toBe("wi-review:z");
  });

  it("still ranks strictly by priority when priorities differ", () => {
    const high = itemFixture({ id: "hi", subject: { kind: "review", id: "hi" }, priority: 0.9 });
    const low = itemFixture({ id: "lo", subject: { kind: "thread", id: "lo" }, priority: 0.2 });
    expect([low, high].slice().sort(compareWorkItems).map((i) => i.id)).toEqual(["hi", "lo"]);
  });
});

describe("Capacity (#10)", () => {
  it("is lower outside working hours than during them", () => {
    const day = estimateCapacity("2026-07-15T17:00:00.000Z");
    const night = estimateCapacity("2026-07-15T04:00:00.000Z");
    expect(day.level).toBeGreaterThan(night.level);
    expect(day.evidence.length).toBeGreaterThan(0);
  });

  it("falls as attention demand rises (source-neutral load)", () => {
    const light = estimateCapacity(NOON, { activeWorkCount: 1 });
    const heavy = estimateCapacity(NOON, { activeWorkCount: 6 });
    expect(heavy.level).toBeLessThan(light.level);
    expect(heavy.evidence.join(" ")).toContain("things need you");
  });
});
