import { describe, it, expect } from "vitest";
import { makeEvent, type EventEnvelope } from "../events/index.js";
import {
  EventTypes,
  type AssignmentReceivedPayload,
  type CheckFailedPayload,
  type ReviewRequestedPayload,
} from "../domain/index.js";
import { contextProjection, type ContextState } from "./context.js";
import { checkSubjectId } from "./subject.js";
import { detectWorkSignals } from "./work-signals.js";
import { detectWorkOpportunities } from "./work-opportunities.js";
import { detectOpportunities, type ThreadOpportunity } from "../opportunity/index.js";
import { prioritize } from "../prioritization/index.js";
import { estimateCapacity } from "../capacity/index.js";

const NOW = "2026-07-16T17:00:00.000Z";

function reviewEvent(
  id: string,
  overrides: Partial<ReviewRequestedPayload> = {},
): EventEnvelope {
  const requestedAt = overrides.requestedAt ?? "2026-07-15T12:00:00.000Z";
  const payload: ReviewRequestedPayload = {
    reviewRequestId: id,
    changeId: "acme/orion#128",
    title: "Add retry to the event store",
    requestedBy: { externalId: "dana", displayName: "Dana Lee" },
    location: "acme/orion#128",
    url: "https://github.com/acme/orion/pull/128",
    requestedAt,
    ...overrides,
  };
  return makeEvent({ type: EventTypes.ReviewRequested, source: "github-skill", payload, id, occurredAt: requestedAt });
}

function assignmentEvent(id: string, overrides: Partial<AssignmentReceivedPayload> = {}): EventEnvelope {
  const assignedAt = overrides.assignedAt ?? "2026-07-15T12:00:00.000Z";
  const payload: AssignmentReceivedPayload = {
    assignmentId: id,
    itemId: "acme/orion#204",
    title: "Flaky prioritization test on CI",
    assignedBy: { externalId: "priya", displayName: "Priya Nair" },
    location: "acme/orion#204",
    url: "https://github.com/acme/orion/issues/204",
    assignedAt,
    ...overrides,
  };
  return makeEvent({ type: EventTypes.AssignmentReceived, source: "github-skill", payload, id, occurredAt: assignedAt });
}

function checkEvent(id: string, overrides: Partial<CheckFailedPayload> = {}): EventEnvelope {
  const failedAt = overrides.failedAt ?? "2026-07-15T14:20:00.000Z";
  const payload: CheckFailedPayload = {
    checkId: id,
    changeId: "acme/orion#126",
    checkName: "verify",
    title: 'verify failed on "Cross-source prioritization spike"',
    location: "acme/orion#126",
    url: "https://github.com/acme/orion/pull/126/checks",
    failedAt,
    ...overrides,
  };
  return makeEvent({ type: EventTypes.CheckFailed, source: "github-skill", payload, id, occurredAt: failedAt });
}

function contextOf(events: EventEnvelope[]): ContextState {
  return events.reduce((state, event) => contextProjection.apply(state, event), contextProjection.init());
}

describe("Context projection of collaborative-work facts (#45)", () => {
  it("accumulates two review occurrences on one change under a single subject", () => {
    const context = contextOf([
      reviewEvent("r1", { requestedAt: "2026-07-15T12:00:00.000Z" }),
      reviewEvent("r2", { requestedAt: "2026-07-15T15:00:00.000Z" }),
    ]);
    const reviews = Object.values(context.reviews);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.eventIds).toEqual(["r1", "r2"]);
  });

  it("lets the newest occurrence supply display fields even when ingested first", () => {
    // Newer (15:00) ingested FIRST, older (13:30) ingested LATER (a delayed poll).
    const context = contextOf([
      reviewEvent("newer", { requestedAt: "2026-07-15T15:00:00.000Z", title: "Newer title" }),
      reviewEvent("older", { requestedAt: "2026-07-15T13:30:00.000Z", title: "Older title" }),
    ]);
    const review = context.reviews["acme/orion#128"];
    expect(review?.title).toBe("Newer title");
    expect(review?.requestedAt).toBe("2026-07-15T15:00:00.000Z");
    expect(review?.latestEventId).toBe("newer");
    // Both occurrences are still recorded.
    expect(review?.eventIds).toEqual(["newer", "older"]);
  });

  it("keeps two differently-named checks on one change as separate subjects", () => {
    const context = contextOf([
      checkEvent("c1", { checkName: "verify" }),
      checkEvent("c2", { checkName: "typecheck" }),
    ]);
    expect(Object.keys(context.checks).sort()).toEqual(
      [checkSubjectId("acme/orion#126", "typecheck"), checkSubjectId("acme/orion#126", "verify")].sort(),
    );
  });

  it("keeps two failures of the same named check as one subject with two occurrences", () => {
    const context = contextOf([
      checkEvent("c1", { checkName: "verify", failedAt: "2026-07-15T14:20:00.000Z" }),
      checkEvent("c2", { checkName: "verify", failedAt: "2026-07-15T16:00:00.000Z" }),
    ]);
    const checks = Object.values(context.checks);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.eventIds).toEqual(["c1", "c2"]);
    expect(checks[0]?.failedAt).toBe("2026-07-15T16:00:00.000Z");
  });
});

describe("Work Opportunity detection (#45)", () => {
  it("maps each fact to its interpreted Opportunity kind and subject kind", () => {
    const context = contextOf([reviewEvent("r1"), assignmentEvent("a1"), checkEvent("c1")]);
    const opps = detectWorkOpportunities(context, NOW);
    const byKind = new Map(opps.map((o) => [o.kind, o]));

    expect(byKind.get("ReviewNeeded")?.subject.kind).toBe("review");
    expect(byKind.get("AssignedActionNeeded")?.subject.kind).toBe("assignment");
    expect(byKind.get("RiskDetected")?.subject.kind).toBe("check");
    expect(opps).toHaveLength(3);
  });

  it("carries complete, deterministic, nonempty evidence and full event traceability", () => {
    const context = contextOf([
      reviewEvent("r1", { requestedAt: "2026-07-15T12:00:00.000Z" }),
      reviewEvent("r2", { requestedAt: "2026-07-15T15:00:00.000Z" }),
    ]);
    const [review] = detectWorkOpportunities(context, NOW);
    expect(review?.kind).toBe("ReviewNeeded");
    expect(review?.evidence.length).toBeGreaterThan(0);
    expect(review?.evidence.every((line) => line.length > 0)).toBe(true);
    // Traces to BOTH contributing occurrences.
    expect([...(review?.createdFromEventIds ?? [])].sort()).toEqual(["r1", "r2"]);
    // Deterministic: same inputs, same output.
    expect(detectWorkOpportunities(context, NOW)).toEqual(detectWorkOpportunities(context, NOW));
  });

  it("attaches a Commitment signal to reviews and assignments, but not to risks", () => {
    const context = contextOf([reviewEvent("r1"), assignmentEvent("a1"), checkEvent("c1")]);
    const opps = detectWorkOpportunities(context, NOW);
    const hasCommitment = (kind: string) =>
      opps.find((o) => o.kind === kind)?.signals.some((s) => s.kind === "Commitment");

    expect(hasCommitment("ReviewNeeded")).toBe(true);
    expect(hasCommitment("AssignedActionNeeded")).toBe(true);
    // A failed check is a risk, not an obligation the user took on.
    expect(hasCommitment("RiskDetected")).toBe(false);
  });

  it("derives deterministic Aging that clamps to [0,1] and ignores future-dated facts", () => {
    const aged = contextOf([reviewEvent("r1", { requestedAt: "2026-07-01T12:00:00.000Z" })]);
    const agingSignals = detectWorkSignals(aged, NOW).filter((s) => s.kind === "Aging");
    expect(agingSignals).toHaveLength(1);
    expect(agingSignals[0]!.strength).toBeGreaterThan(0);
    expect(agingSignals[0]!.strength).toBeLessThanOrEqual(1);

    const future = contextOf([reviewEvent("r2", { requestedAt: "2026-08-01T12:00:00.000Z" })]);
    expect(detectWorkSignals(future, NOW).some((s) => s.kind === "Aging")).toBe(false);
  });
});

describe("the decision layer is type-gated to thread subjects (#45 -> #46)", () => {
  it("prioritize cannot consume a non-thread Opportunity", () => {
    const context = contextOf([reviewEvent("r1")]);
    const [review] = detectWorkOpportunities(context, NOW);
    expect(review?.kind).toBe("ReviewNeeded");
    expect(review?.subject.kind).not.toBe("thread");

    // Compile-time proof that GitHub work structurally cannot enter Work Items
    // until #46: a ReviewNeeded is not assignable to the prioritizer's input.
    // @ts-expect-error — a ReviewNeeded Opportunity is not a ThreadOpportunity.
    const gated: readonly ThreadOpportunity[] = [review!];
    void gated;

    // The legitimate feed (the thread detector) emits nothing for GitHub-only
    // Context, so the prioritizer produces no Work Items.
    const items = prioritize(detectOpportunities(context, NOW), estimateCapacity(NOW, context));
    expect(items).toEqual([]);
  });
});
