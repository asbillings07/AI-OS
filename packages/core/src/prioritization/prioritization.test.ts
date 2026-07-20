import { describe, it, expect } from "vitest";
import { makeEvent } from "../events/index.js";
import { EventTypes, type MessageReceivedPayload } from "../domain/index.js";
import { contextProjection, type ContextState } from "../understanding/context.js";
import { detectOpportunities } from "../opportunity/index.js";
import { estimateCapacity } from "../capacity/index.js";
import { buildWorkItems, prioritize } from "./index.js";

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
    expect(opportunities[0]?.threadId).toBe("t1");
    expect(opportunities[0]?.kind).toBe("ReplyNeeded");
  });
});

describe("Prioritization (#29)", () => {
  it("produces structured, explainable Work Items", () => {
    const context = contextOf([message({ threadId: "t1", messageId: "m1" })]);
    const [item] = buildWorkItems(context, NOON);
    expect(item).toBeDefined();
    // The structured Explanation the reviewer asked for.
    expect(item).toMatchObject({
      id: "wi-t1",
      threadId: "t1",
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
    const [item] = buildWorkItems(context, NOON);
    expect(item?.reason).toContain("not replied");
    expect(item?.reason).toContain("direct question");
    // No summary was attached: the explanation stands entirely without AI.
    expect(item?.summary).toBeUndefined();
  });

  it("keeps the four inputs independent (not a single product)", () => {
    const context = contextOf([message({ threadId: "t1", messageId: "m1" })]);
    const [item] = buildWorkItems(context, NOON);
    expect(item).toHaveProperty("opportunity");
    expect(item).toHaveProperty("capacity");
    expect(item).toHaveProperty("commitment");
    expect(item).toHaveProperty("urgency");
  });

  it("low Capacity raises the attention bar, moving items to 'can wait'", () => {
    const context = contextOf([message({ threadId: "t1", messageId: "m1" })]);
    const opportunities = detectOpportunities(context, NOON);

    const highCapacity = prioritize(opportunities, { level: 0.9, evidence: [] }, context);
    const lowCapacity = prioritize(opportunities, { level: 0.1, evidence: [] }, context);

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
    const items = buildWorkItems(context, NOON);
    expect(items[0]?.threadId === "t1" || items[0]?.threadId === "t2").toBe(true);
    expect(items[items.length - 1]?.threadId).toBe("t3");
  });

  it("produces silence (no Work Items) when nothing awaits action", () => {
    const context = contextOf([
      message({ threadId: "t1", messageId: "m1", from: { address: "no-reply@news.com" }, body: "digest" }),
    ]);
    expect(buildWorkItems(context, NOON)).toHaveLength(0);
  });
});

describe("Capacity (#10)", () => {
  it("is lower outside working hours than during them", () => {
    const day = estimateCapacity("2026-07-15T17:00:00.000Z");
    const night = estimateCapacity("2026-07-15T04:00:00.000Z");
    expect(day.level).toBeGreaterThan(night.level);
    expect(day.evidence.length).toBeGreaterThan(0);
  });
});
