import { describe, it, expect } from "vitest";
import { createLogger, nullLogger, LogEvents } from "./index.js";

describe("structured logger", () => {
  it("does nothing by default (logging is opt-in)", () => {
    const lines: string[] = [];
    const logger = createLogger({ env: {}, write: (line) => lines.push(line) });
    logger.event(LogEvents.EventRecorded, { id: "e1" });
    expect(lines).toEqual([]);
    expect(logger).toBe(nullLogger);
  });

  it("emits one JSON line per event when enabled, with a timestamp and fields", () => {
    const lines: string[] = [];
    const logger = createLogger({
      enabled: true,
      now: () => "2026-07-20T00:00:00.000Z",
      write: (line) => lines.push(line),
    });
    logger.event(LogEvents.OpportunityDetected, { threadId: "t1", value: 0.7 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      t: "2026-07-20T00:00:00.000Z",
      evt: "opportunity.detected",
      threadId: "t1",
      value: 0.7,
    });
  });

  it.each([
    ["1", true],
    ["true", true],
    ["debug", true],
    ["", false],
    ["0", false],
    ["false", false],
    ["off", false],
  ])("reads ORION_LOG=%s as enabled=%s", (value, expected) => {
    const lines: string[] = [];
    const logger = createLogger({ env: { ORION_LOG: value }, write: (line) => lines.push(line) });
    logger.event("test");
    expect(lines.length > 0).toBe(expected);
  });

  it("never throws, even on non-serializable fields", () => {
    const logger = createLogger({ enabled: true, write: () => {} });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.event("boom", circular)).not.toThrow();
  });
});
