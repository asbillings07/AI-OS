import { describe, it, expect } from "vitest";
import { LogEvents, nullLogger, type OrionRuntime } from "@orion/core";
import { gmailMessages } from "@orion/fixtures";
import type { GmailSource, GmailTrace } from "@orion/gmail-skill";
import { ingestLiveGmail } from "./gmail-sync";

// GmailSkill.ingest only calls runtime.record; a no-op stub is enough to exercise
// the health rule without a real event store.
const runtime = { record: async () => {} } as unknown as OrionRuntime;

function sourceThatDrops(dropIds: string[], returned = gmailMessages.slice(0, 0)): (onTrace: GmailTrace) => GmailSource {
  return (onTrace) => ({
    name: "fake",
    async fetchMessages() {
      for (const id of dropIds) {
        onTrace(LogEvents.GmailMessageDropped, { messageId: id, attempts: 1, status: 500, reason: "test" });
      }
      return returned;
    },
  });
}

describe("ingestLiveGmail health", () => {
  it("reports ok:false when every listed message drops", async () => {
    const result = await ingestLiveGmail(runtime, nullLogger, sourceThatDrops(["a", "b"]));
    expect(result).toMatchObject({ mode: "live", ok: false, ingested: 0, dropped: 2 });
  });

  it("reports ok:true on partial success (some ingested, some dropped)", async () => {
    const one = gmailMessages.slice(0, 1);
    const result = await ingestLiveGmail(runtime, nullLogger, sourceThatDrops(["a"], one));
    expect(result).toMatchObject({ mode: "live", ok: true, ingested: 1, dropped: 1 });
  });

  it("reports ok:true for an empty inbox (nothing listed, nothing dropped)", async () => {
    const source: (onTrace: GmailTrace) => GmailSource = () => ({
      name: "fake",
      async fetchMessages() {
        return [];
      },
    });
    const result = await ingestLiveGmail(runtime, nullLogger, source);
    expect(result).toMatchObject({ mode: "live", ok: true, ingested: 0, dropped: 0 });
  });

  it("still counts drops when the logger throws", async () => {
    const throwingLogger = {
      event() {
        throw new Error("logger blew up");
      },
    };
    // The source must swallow the throwing tracer (mirrors LiveGmailSource#trace),
    // and the drop must already be counted before the logger runs.
    const source: (onTrace: GmailTrace) => GmailSource = (onTrace) => ({
      name: "fake",
      async fetchMessages() {
        try {
          onTrace(LogEvents.GmailMessageDropped, { messageId: "a", attempts: 1, status: 500, reason: "test" });
        } catch {
          // swallowed, exactly as the real source does
        }
        return [];
      },
    });
    const result = await ingestLiveGmail(runtime, throwingLogger, source);
    expect(result).toMatchObject({ ok: false, ingested: 0, dropped: 1 });
  });
});
