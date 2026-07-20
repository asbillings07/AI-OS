import { describe, it, expect } from "vitest";
import {
  InProcessEventBus,
  SqliteEventStore,
  OrionRuntime,
  ProjectionHost,
  contextProjection,
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
    const payload = normalizeGmailMessage(raw);
    // A naive split(",") would produce a bogus "doe" recipient.
    expect(payload.to).toEqual([
      { name: "Doe, John", address: "john@example.com" },
      { address: "jane@example.com" },
    ]);
  });

  it("decodes the base64url body and maps headers to domain fields", () => {
    const raw = gmailMessages.find((m) => m.id === "g-dana-1")!;
    const payload = normalizeGmailMessage(raw);
    expect(payload.from).toEqual({ name: "Dana Lee", address: "dana@acme.com" });
    expect(payload.subject).toBe("Can you review the Q3 deck?");
    expect(payload.body).toContain("review the Q3 deck");
    expect(payload.threadId).toBe("th-dana");
    expect(payload.receivedAt).toBe("2026-07-13T14:00:00.000Z");
  });
});

function newRuntime() {
  const store = new SqliteEventStore(":memory:");
  const bus = new InProcessEventBus();
  const context = new ProjectionHost(contextProjection);
  const runtime = new OrionRuntime({ bus, store, projections: [context as ProjectionHost<unknown>] });
  return { store, runtime, context };
}

describe("Gmail Skill ingestion (ADR-0010)", () => {
  it("turns fixtures into MessageReceived events on the log", async () => {
    const { runtime, store } = newRuntime();
    const skill = new GmailSkill({ source: new FixtureGmailSource() });
    const events = await skill.ingest(runtime);

    expect(events.length).toBe(gmailMessages.length);
    expect(store.count()).toBe(gmailMessages.length);
    expect(events.every((event) => event.type === "MessageReceived")).toBe(true);
    expect(events.every((event) => event.source === "gmail-skill")).toBe(true);
  });

  it("is idempotent: re-ingesting adds nothing (at-least-once safe)", async () => {
    const { runtime, store } = newRuntime();
    const skill = new GmailSkill();
    await skill.ingest(runtime);
    await skill.ingest(runtime);
    expect(store.count()).toBe(gmailMessages.length);
  });

  it("drives the full pipeline: fixtures -> Context -> ranked Work Items", async () => {
    const { runtime, context } = newRuntime();
    await new GmailSkill().ingest(runtime);

    const items = buildWorkItems(context.state as ContextState, NOW);
    const threadIds = items.map((item) => item.threadId);

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
