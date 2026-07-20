import { describe, it, expect } from "vitest";
import { createAi, DeterministicProvider, type AiProvider, type AiUsage } from "./index.js";

describe("AI capability layer (ADR-0011)", () => {
  it("defaults to the deterministic, offline provider (no key required)", () => {
    const ai = createAi({ env: {} });
    expect(ai.providerName).toBe("deterministic");
  });

  it("routes to the http provider when a key is configured", () => {
    const ai = createAi({ env: { ORION_AI_API_KEY: "sk-test" } });
    expect(ai.providerName).toBe("http");
  });

  it("summarize is extractive and reproducible", async () => {
    const ai = createAi({ env: {} });
    const first = await ai.summarize({ text: "Alpha happened. Beta happened. Gamma happened.", maxSentences: 2 });
    const second = await ai.summarize({ text: "Alpha happened. Beta happened. Gamma happened.", maxSentences: 2 });
    expect(first.summary).toBe("Alpha happened. Beta happened.");
    expect(first).toEqual(second);
    expect(first.confidence).toBeLessThan(0.5);
  });

  it("classify always returns one of the allowed labels", async () => {
    const ai = createAi({ env: {} });
    const result = await ai.classify({
      text: "Can you please reply to this urgent request?",
      labels: ["needs_reply", "fyi", "low_value"],
    });
    expect(["needs_reply", "fyi", "low_value"]).toContain(result.label);
    expect(result.label).toBe("needs_reply");
  });

  it("coerces a provider label outside the allowed set (structured validation)", async () => {
    const rogue: AiProvider = {
      name: "rogue",
      async summarize() {
        return { summary: "x", confidence: 5 };
      },
      async classify() {
        return { label: "totally_made_up", confidence: 0.9 };
      },
    };
    const ai = createAi({ provider: rogue });
    const classified = await ai.classify({ text: "hi", labels: ["a", "b"] });
    expect(classified.label).toBe("a");
    expect(classified.confidence).toBe(0);
    const summarized = await ai.summarize({ text: "hi" });
    expect(summarized.confidence).toBe(1); // clamped from 5
  });

  it("records usage at the chokepoint", async () => {
    const usage: AiUsage[] = [];
    const ai = createAi({ provider: new DeterministicProvider(), onUsage: (u) => usage.push(u) });
    await ai.summarize({ text: "One sentence here." });
    expect(usage).toHaveLength(1);
    expect(usage[0]?.capability).toBe("summarize");
    expect(usage[0]?.provider).toBe("deterministic");
    expect(usage[0]?.ok).toBe(true);
  });
});
