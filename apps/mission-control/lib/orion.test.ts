import { describe, it, expect } from "vitest";
import { isValidSummary } from "@orion/ai";
import type { ContextState, WorkItem } from "@orion/core";
import {
  enrichWorkItemWithSummary,
  type SummarizeCapability,
} from "./orion";

const baseItem: WorkItem = {
  id: "wi-thread:th-1",
  kind: "ReplyNeeded",
  subject: { kind: "thread", id: "th-1" },
  title: "Default Thread Title",
  location: "th-1",
  url: "http://example.com",
  band: "needs_attention",
  priority: 0.5,
  opportunity: 0.5,
  capacity: 0.5,
  commitment: 0.5,
  urgency: 0.5,
  importance: 0.5,
  reason: "reason",
  evidence: [],
  createdFromEventIds: [],
  attentionBasisEventIds: [],
  attentionRevision: "rev-1",
  importanceEvidenceEventIds: [],
};

function makeContext(body?: string, subject?: string): ContextState {
  return {
    threads: {
      "th-1": {
        id: "th-1",
        messages: [
          {
            messageId: "m-1",
            direction: "inbound",
            from: { address: "sender@example.com", name: "Sender" },
            to: [{ address: "me@example.com" }],
            subject: subject ?? "Inbound Thread Subject",
            snippet: "snippet",
            body: body ?? "Inbound thread email body content.",
            occurredAt: "2026-07-23T12:00:00.000Z",
            eventId: "evt-1",
            source: "gmail-skill",
          },
        ],
        firstMessageAt: "2026-07-23T12:00:00.000Z",
        lastMessageAt: "2026-07-23T12:00:00.000Z",
      },
    },
    reviews: {},
    assignments: {},
    checks: {},
    people: {},
  };
}

describe("Mission Control read model summary enrichment & fallback (#87)", () => {
  it("isValidSummary validates non-empty strings and rejects invalid literals", () => {
    expect(isValidSummary("Review requested for Q3 deck")).toBe(true);
    expect(isValidSummary("")).toBe(false);
    expect(isValidSummary("   \n ")).toBe(false);
    expect(isValidSummary("undefined")).toBe(false);
    expect(isValidSummary("undefined.")).toBe(false);
    expect(isValidSummary("null")).toBe(false);
    expect(isValidSummary("null.")).toBe(false);
    expect(isValidSummary("[object Object]")).toBe(false);
    expect(isValidSummary("NaN")).toBe(false);
    expect(isValidSummary(undefined)).toBe(false);
  });

  it("valid AI output retains its summary and confidence", async () => {
    const context = makeContext("Body text here");
    const ai: SummarizeCapability = {
      async summarize() {
        return { summary: "AI Summary of conversation.", confidence: 0.85 };
      },
    };

    const result = await enrichWorkItemWithSummary(baseItem, context, ai);
    expect(result.summary).toBe("AI Summary of conversation.");
    expect(result.summaryConfidence).toBe(0.85);
  });

  it("provider failure falls back to body snippet without AI label", async () => {
    const context = makeContext("Detailed body text sentence one. Sentence two.");
    const failingAi: SummarizeCapability = {
      async summarize() {
        throw new Error("Provider unavailable");
      },
    };

    const result = await enrichWorkItemWithSummary(baseItem, context, failingAi);
    expect(result.summary).toBe("Detailed body text sentence one.");
    expect(result.summaryConfidence).toBeUndefined();
  });

  it("invalid AI output ('undefined.') falls back to deterministic body snippet", async () => {
    const context = makeContext("Detailed body text sentence one. Sentence two.");
    const invalidAi: SummarizeCapability = {
      async summarize() {
        return { summary: "undefined.", confidence: 0.9 };
      },
    };

    const result = await enrichWorkItemWithSummary(baseItem, context, invalidAi);
    expect(result.summary).toBe("Detailed body text sentence one.");
    expect(result.summaryConfidence).toBeUndefined();
  });

  it("missing or invalid body falls back to subject, then title", async () => {
    // 1. Missing body -> falls back to subject
    const contextSubjectOnly = makeContext("  ", "Subject sentence one.");
    const failingAi: SummarizeCapability = {
      async summarize() {
        throw new Error("Provider failed");
      },
    };

    const resSubject = await enrichWorkItemWithSummary(baseItem, contextSubjectOnly, failingAi);
    expect(resSubject.summary).toBe("Subject sentence one.");
    expect(resSubject.summaryConfidence).toBeUndefined();

    // 2. Missing/invalid body AND subject -> falls back to WorkItem title
    const contextInvalidBodySubject = makeContext("undefined", "null.");
    const itemWithTitle: WorkItem = { ...baseItem, title: "Title sentence one." };

    const resTitle = await enrichWorkItemWithSummary(itemWithTitle, contextInvalidBodySubject, failingAi);
    expect(resTitle.summary).toBe("Title sentence one.");
    expect(resTitle.summaryConfidence).toBeUndefined();
  });

  it("invalid preexisting summary and summaryConfidence are removed", async () => {
    const itemWithCorruptedSummary: WorkItem = {
      ...baseItem,
      summary: "undefined.",
      summaryConfidence: 0.95,
    };
    const contextNoBodySubject = makeContext("undefined", "null.");
    const itemWithInvalidTitle: WorkItem = {
      ...itemWithCorruptedSummary,
      title: "undefined.",
    };

    const failingAi: SummarizeCapability = {
      async summarize() {
        throw new Error("Provider failed");
      },
    };

    const result = await enrichWorkItemWithSummary(itemWithInvalidTitle, contextNoBodySubject, failingAi);
    expect(result.summary).toBeUndefined();
    expect(result.summaryConfidence).toBeUndefined();
  });

  it("fallback summaries are never labeled as AI-generated (summaryConfidence is undefined)", async () => {
    const context = makeContext("Body sentence.");
    const failingAi: SummarizeCapability = {
      async summarize() {
        throw new Error("Failed");
      },
    };

    const result = await enrichWorkItemWithSummary(baseItem, context, failingAi);
    expect(result.summary).toBe("Body sentence.");
    expect(result.summaryConfidence).toBeUndefined();
  });
});
