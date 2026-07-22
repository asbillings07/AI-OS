import { describe, it, expect } from "vitest";
import { makeEvent } from "../events/index.js";
import {
  EventTypes,
  originatorKey,
  type MessageReceivedPayload,
  type OriginatorRef,
  type ReviewRequestedPayload,
} from "../domain/index.js";
import { contextProjection, type ContextState } from "../understanding/context.js";
import { detectOpportunities } from "../opportunity/index.js";
import { estimateCapacity } from "../capacity/index.js";
import { attentionProjection } from "../attention/index.js";
import { personalImportanceProjection, NEUTRAL_IMPORTANCE, type PersonalImportanceState } from "../importance/index.js";
import { buildWorkItems, prioritize, compareWorkItems, workItemId, type WorkItem } from "./index.js";

const NO_ATTENTION = attentionProjection.init();
const NO_IMPORTANCE = personalImportanceProjection.init();

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
      id: "wi-thread:t1",
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
    // WorkItem is a distributed union (kind paired to subject); the spread of a
    // Partial can't prove membership to the compiler, so we assert it in this test
    // scaffold. Callers pass a consistent kind/subject pair.
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
      importance: 0.5,
      reason: "",
      evidence: [],
      createdFromEventIds: [],
      attentionBasisEventIds: [],
      attentionRevision: "rev",
      importanceEvidenceEventIds: [],
      ...overrides,
    } as WorkItem;
  }

  it("gives every Subject kind a globally-unique Work Item id (no cross-kind collision)", () => {
    // A thread whose opaque id happens to look like a review's subjectKey must not
    // collide with an actual review of that change.
    const threadLike = workItemId({ kind: "thread", id: `review:${"acme/orion#128"}` });
    const review = workItemId({ kind: "review", id: "acme/orion#128" });
    expect(threadLike).not.toBe(review);
    expect(review).toBe("wi-review:acme/orion#128");
    expect(threadLike).toBe("wi-thread:review:acme/orion#128");
  });

  it("breaks ties by ordinal comparison, not host locale", () => {
    // In many locales 'a' sorts before 'Z'; ordinal (code-unit) order puts the
    // uppercase 'Z' (0x5A) before lowercase 'a' (0x61). We pin the ordinal result.
    const upper = itemFixture({ id: "u", subject: { kind: "review", id: "Z" }, kind: "ReviewNeeded" });
    const lower = itemFixture({ id: "l", subject: { kind: "review", id: "a" }, kind: "ReviewNeeded" });
    expect([lower, upper].slice().sort(compareWorkItems).map((i) => i.subject.id)).toEqual(["Z", "a"]);
    // Punctuation/Unicode ordering is likewise deterministic and stable.
    const punct = itemFixture({ id: "p", subject: { kind: "review", id: "a-b" }, kind: "ReviewNeeded" });
    const unicode = itemFixture({ id: "x", subject: { kind: "review", id: "a\u00e9" }, kind: "ReviewNeeded" });
    const sorted = [unicode, punct].slice().sort(compareWorkItems).map((i) => i.subject.id);
    expect(sorted).toEqual(["a-b", "a\u00e9"]);
  });

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

describe("Personal Importance integration (#65)", () => {
  /** A #46-shaped action Event stamped with an OriginatorRef (see work-item-actions). */
  function actedOn(id: string, subject: { kind: string; id: string }, originator: OriginatorRef): ReturnType<typeof makeEvent> {
    return makeEvent({
      type: EventTypes.WorkItemActedOn,
      source: "user",
      id,
      payload: { workItemId: `wi-${subject.kind}:${subject.id}`, subject, basisEventIds: ["basis"], originator },
    });
  }

  function dismissed(id: string, subject: { kind: string; id: string }, originator: OriginatorRef): ReturnType<typeof makeEvent> {
    return makeEvent({
      type: EventTypes.WorkItemDismissed,
      source: "user",
      id,
      payload: { workItemId: `wi-${subject.kind}:${subject.id}`, subject, basisEventIds: ["basis"], originator },
    });
  }

  function foldImportance(events: ReturnType<typeof makeEvent>[]): PersonalImportanceState {
    return events.reduce((state, event) => personalImportanceProjection.apply(state, event), NO_IMPORTANCE);
  }

  const DANA: OriginatorRef = { namespace: "gmail-skill", id: "dana@acme.com" };

  function reviewRequested(
    id: string,
    changeId: string,
    requestedBy: string,
    requestedAt = "2026-07-15T12:00:00.000Z",
  ) {
    const payload: ReviewRequestedPayload = {
      reviewRequestId: id,
      changeId,
      title: "Add retry to the event store",
      requestedBy: { externalId: requestedBy },
      location: changeId,
      url: "https://example.com/pull/1",
      requestedAt,
    };
    return makeEvent({ type: EventTypes.ReviewRequested, source: "github-skill", id, payload, occurredAt: requestedAt });
  }

  it("stays identical to today's ranking when the originator has no learned history", () => {
    const context = contextOf([message({ threadId: "t1", messageId: "m1" })]);
    const withoutOption = items(context, NOON);
    const withEmptyImportance = buildWorkItems({ context, attention: NO_ATTENTION, importance: NO_IMPORTANCE, now: NOON });
    expect(withEmptyImportance[0]?.priority).toBe(withoutOption[0]?.priority);
    expect(withEmptyImportance[0]?.importance).toBe(NEUTRAL_IMPORTANCE);
  });

  it("raises priority for a thread whose sender the user consistently acts on", () => {
    const context = contextOf([message({ threadId: "t1", messageId: "m1" })]);
    const neutral = buildWorkItems({ context, attention: NO_ATTENTION, importance: NO_IMPORTANCE, now: NOON })[0]!;

    const importance = foldImportance([
      actedOn("act-1", { kind: "thread", id: "t1" }, DANA),
      actedOn("act-2", { kind: "thread", id: "t1" }, DANA),
    ]);
    const boosted = buildWorkItems({ context, attention: NO_ATTENTION, importance, now: NOON })[0]!;

    expect(boosted.importance).toBeCloseTo(0.75, 10);
    // The v1 weight (#65, ADR-0014): IMPORTANCE_WEIGHT(0.15) * (0.75-0.5) * 2.
    expect(boosted.priority - neutral.priority).toBeCloseTo(0.075, 10);
  });

  it("lowers priority for a thread whose sender the user consistently dismisses", () => {
    const context = contextOf([message({ threadId: "t1", messageId: "m1" })]);
    const neutral = buildWorkItems({ context, attention: NO_ATTENTION, importance: NO_IMPORTANCE, now: NOON })[0]!;

    const importance = foldImportance([
      dismissed("act-1", { kind: "thread", id: "t1" }, DANA),
      dismissed("act-2", { kind: "thread", id: "t1" }, DANA),
    ]);
    const lowered = buildWorkItems({ context, attention: NO_ATTENTION, importance, now: NOON })[0]!;

    expect(lowered.importance).toBeCloseTo(0.25, 10);
    expect(neutral.priority - lowered.priority).toBeCloseTo(0.075, 10);
  });

  it("adds an evidence-specific explanation and exposes importance provenance separately from the attention basis", () => {
    const context = contextOf([message({ threadId: "t1", messageId: "m1" })]);
    const importance = foldImportance([
      actedOn("act-1", { kind: "thread", id: "t1" }, DANA),
      actedOn("act-2", { kind: "thread", id: "t1" }, DANA),
    ]);
    const [item] = buildWorkItems({ context, attention: NO_ATTENTION, importance, now: NOON });

    expect(item?.reason).toContain("You've acted on more work from Dana Lee than you've dismissed.");
    expect(item?.importanceEvidenceEventIds).toEqual(["act-1", "act-2"]);
    // Importance provenance is distinct from the presentation revision.
    expect(item?.importanceEvidenceEventIds).not.toEqual(item?.attentionBasisEventIds);
  });

  it("omits the importance sentence and evidence when the score is neutral", () => {
    const context = contextOf([message({ threadId: "t1", messageId: "m1" })]);
    const [item] = items(context, NOON);
    expect(item?.reason).not.toContain("dismissed");
    expect(item?.importanceEvidenceEventIds).toEqual([]);
  });

  it("breaks a priority tie by importance before falling through to subjectKey", () => {
    const highImportance: WorkItem = {
      id: "wi-thread:a",
      subject: { kind: "thread", id: "a" },
      kind: "ReplyNeeded",
      title: "a",
      band: "can_wait",
      priority: 0.5,
      opportunity: 0.5,
      capacity: 0.5,
      commitment: 0.5,
      urgency: 0.5,
      importance: 0.75,
      reason: "",
      evidence: [],
      createdFromEventIds: [],
      attentionBasisEventIds: [],
      attentionRevision: "rev",
      importanceEvidenceEventIds: [],
    };
    const lowImportance: WorkItem = { ...highImportance, id: "wi-thread:z", subject: { kind: "thread", id: "z" }, importance: 0.25 };
    // "z" > "a" ordinally, so subjectKey alone would put z first; importance must win.
    expect([lowImportance, highImportance].slice().sort(compareWorkItems).map((i) => i.id)).toEqual([
      "wi-thread:a",
      "wi-thread:z",
    ]);
  });

  it("is source-neutral: a Gmail thread and a GitHub review with identical dispositions get the same contribution", () => {
    const github: OriginatorRef = { namespace: "github-skill", id: "octo" };
    const events = [message({ threadId: "t1", messageId: "m1" }), reviewRequested("r1", "acme/orion#1", "octo")];
    const context = events.reduce((state, event) => contextProjection.apply(state, event), contextProjection.init());

    const importance = foldImportance([
      actedOn("act-1", { kind: "thread", id: "t1" }, DANA),
      actedOn("act-2", { kind: "thread", id: "t1" }, DANA),
      actedOn("act-3", { kind: "review", id: "acme/orion#1" }, github),
      actedOn("act-4", { kind: "review", id: "acme/orion#1" }, github),
    ]);

    const ranked = buildWorkItems({ context, attention: NO_ATTENTION, importance, now: NOON });
    const thread = ranked.find((i) => i.subject.kind === "thread")!;
    const review = ranked.find((i) => i.subject.kind === "review")!;

    expect(thread.importance).toBeCloseTo(0.75, 10);
    expect(review.importance).toBeCloseTo(0.75, 10);
    expect(originatorKey(DANA)).not.toBe(originatorKey(github));
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
