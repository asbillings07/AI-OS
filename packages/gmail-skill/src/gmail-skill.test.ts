import { describe, it, expect } from "vitest";
import {
  InProcessEventBus,
  SqliteEventStore,
  OrionRuntime,
  ProjectionHost,
  contextProjection,
  attentionProjection,
  buildWorkItems,
  type ContextState,
} from "@orion/core";
import { gmailMessages } from "@orion/fixtures";
import type { RawGmailMessage } from "@orion/fixtures";
import { normalizeGmailMessage, parseAddress } from "./normalize.js";
import { GmailSkill } from "./skill.js";
import { FixtureGmailSource } from "./source.js";

const NOW = "2026-07-15T17:00:00.000Z";

describe("Gmail normalization (Eng #8: the vendor shape stops here)", () => {
  it("parses 'Name <email>' addresses", () => {
    expect(parseAddress("Dana Lee <dana@acme.com>")).toEqual({ name: "Dana Lee", address: "dana@acme.com" });
    expect(parseAddress("bare@example.com")).toEqual({ address: "bare@example.com" });
  });

  it("splits the To header without breaking quoted display names", () => {
    const raw: RawGmailMessage = {
      id: "g-multi",
      threadId: "th-multi",
      snippet: "hello",
      internalDate: "1752415200000",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Dana Lee <dana@acme.com>" },
          { name: "To", value: '"Doe, John" <john@example.com>, jane@example.com' },
          { name: "Subject", value: "Team sync" },
        ],
      },
    };
    const normalized = normalizeGmailMessage(raw);
    expect(normalized.direction).toBe("received");
    expect(normalized.payload.to).toEqual([
      { name: "Doe, John", address: "john@example.com" },
      { address: "jane@example.com" },
    ]);
  });

  it("decodes the base64url body and maps headers to domain fields for received messages", () => {
    const raw = gmailMessages.find((m) => m.id === "g-dana-1")!;
    const normalized = normalizeGmailMessage(raw);
    expect(normalized.direction).toBe("received");
    if (normalized.direction === "received") {
      const payload = normalized.payload;
      expect(payload.from).toEqual({ name: "Dana Lee", address: "dana@acme.com" });
      expect(payload.subject).toBe("Can you review the Q3 deck?");
      expect(payload.body).toContain("review the Q3 deck");
      expect(payload.threadId).toBe("th-dana");
      expect(payload.receivedAt).toBe("2026-07-13T14:00:00.000Z");
    }
  });

  it("normalizes a SENT label message into direction: sent", () => {
    const raw: RawGmailMessage = {
      id: "g-sent-1",
      threadId: "th-dana",
      labelIds: ["SENT"],
      snippet: "Sure, reviewing now",
      internalDate: "1752418800000",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Me <me@orion.dev>" },
          { name: "To", value: "Dana Lee <dana@acme.com>" },
          { name: "Subject", value: "Re: Can you review the Q3 deck?" },
        ],
      },
    };
    const normalized = normalizeGmailMessage(raw);
    expect(normalized.direction).toBe("sent");
    if (normalized.direction === "sent") {
      expect(normalized.payload.messageId).toBe("g-sent-1");
      expect(normalized.payload.from.address).toBe("me@orion.dev");
      expect(normalized.payload.to).toEqual([{ name: "Dana Lee", address: "dana@acme.com" }]);
      expect(normalized.payload.sentAt).toBe("2025-07-13T15:00:00.000Z");
    }
  });

  it("gives SENT label precedence over INBOX for self-addressed mail", () => {
    const raw: RawGmailMessage = {
      id: "g-self-1",
      threadId: "th-self",
      labelIds: ["INBOX", "SENT"],
      snippet: "Note to self",
      internalDate: "1752418800000",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Me <me@orion.dev>" },
          { name: "To", value: "Me <me@orion.dev>" },
          { name: "Subject", value: "Note to self" },
        ],
      },
    };
    const normalized = normalizeGmailMessage(raw);
    expect(normalized.direction).toBe("sent");
  });
});

function newRuntime() {
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

describe("Gmail Skill ingestion (ADR-0010)", () => {
  it("declares produces in manifest including MessageReceived and MessageSent", () => {
    const skill = new GmailSkill();
    expect(skill.manifest.produces).toEqual(["MessageReceived", "MessageSent"]);
  });

  it("turns fixtures into MessageReceived and MessageSent events on the log", async () => {
    const { runtime, store } = newRuntime();
    const skill = new GmailSkill({ source: new FixtureGmailSource() });
    const events = await skill.ingest(runtime);

    expect(events.length).toBe(gmailMessages.length);
    expect(store.count()).toBe(gmailMessages.length);
    expect(events.every((event) => event.type === "MessageReceived" || event.type === "MessageSent")).toBe(true);
    expect(events.every((event) => event.source === "gmail-skill")).toBe(true);
  });

  it("assigns deterministic event IDs: gmail:${id} for received and gmail:sent:${id} for sent", async () => {
    const rawSent: RawGmailMessage = {
      id: "raw-sent-1",
      threadId: "th-1",
      labelIds: ["SENT"],
      snippet: "Replied",
      internalDate: "1752418800000",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Me <me@orion.dev>" },
          { name: "To", value: "Dana <dana@acme.com>" },
        ],
      },
    };
    const { runtime, store } = newRuntime();
    const skill = new GmailSkill({
      source: {
        name: "test-source",
        fetchMessages: async () => [rawSent],
      },
    });
    const [event] = await skill.ingest(runtime);
    expect(event?.id).toBe("gmail:sent:raw-sent-1");
    expect(event?.type).toBe("MessageSent");
    expect(event?.occurredAt).toBe("2025-07-13T15:00:00.000Z");
    expect(store.count()).toBe(1);
  });

  it("is idempotent: re-ingesting adds nothing (at-least-once safe)", async () => {
    const { runtime, store } = newRuntime();
    const skill = new GmailSkill();
    await skill.ingest(runtime);
    await skill.ingest(runtime);
    expect(store.count()).toBe(gmailMessages.length);
  });

  it("drives the full pipeline: fixtures -> Context -> ranked Work Items", async () => {
    const { runtime, context, attention } = newRuntime();
    await new GmailSkill().ingest(runtime);

    const items = buildWorkItems({ context: context.state as ContextState, attention: attention.state, now: NOW });
    const threadIds = items.filter((item) => item.subject.kind === "thread").map((item) => item.subject.id);

    // People awaiting replies surface; automated senders produce silence.
    expect(threadIds).toContain("th-dana");
    expect(threadIds).toContain("th-priya");
    expect(threadIds).toContain("th-sam");
    expect(threadIds).not.toContain("th-news");
    expect(threadIds).not.toContain("th-gh");

    // Every surfaced item can explain itself with no AI.
    for (const item of items) {
      expect(item.reason.length).toBeGreaterThan(0);
      expect(item.evidence.length).toBeGreaterThan(0);
      expect(item.createdFromEventIds.length).toBeGreaterThan(0);
    }
  });
});
