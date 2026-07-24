import { describe, it, expect } from "vitest";
import { isValidSummary } from "@orion/ai";

describe("Mission Control read model summary presentation safety (#87)", () => {
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
});
