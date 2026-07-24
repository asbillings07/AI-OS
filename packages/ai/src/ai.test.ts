import { describe, it, expect } from "vitest";
import { createAi, isValidSummary, DeterministicProvider, type AiProvider, type AiObservation } from "./index.js";

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

  it("rejects an empty label set instead of inventing an empty-string label", async () => {
    const ai = createAi({ env: {} });
    await expect(ai.classify({ text: "anything", labels: [] })).rejects.toThrow(/labels must not be empty/);
  });

  it("rejects an empty label set even when the deterministic provider is called directly", async () => {
    const provider = new DeterministicProvider();
    await expect(provider.classify({ text: "anything", labels: [] })).rejects.toThrow(
      /labels must not be empty/,
    );
  });

  it("isValidSummary accurately distinguishes presentation-safe strings from invalid ones", () => {
    expect(isValidSummary("Discussed Q3 deck review")).toBe(true);
    expect(isValidSummary("   ")).toBe(false);
    expect(isValidSummary("undefined")).toBe(false);
    expect(isValidSummary("undefined.")).toBe(false);
    expect(isValidSummary("null")).toBe(false);
    expect(isValidSummary("null.")).toBe(false);
    expect(isValidSummary("[object Object]")).toBe(false);
    expect(isValidSummary("NaN")).toBe(false);
    expect(isValidSummary(undefined)).toBe(false);
    expect(isValidSummary(null)).toBe(false);
  });

  it("rejects an invalid summary string literal from a provider (e.g. 'undefined' or 'null')", async () => {
    const invalidProvider: AiProvider = {
      name: "invalid",
      async summarize() {
        return { summary: "undefined.", confidence: 0.9 };
      },
      async classify() {
        return { label: "a", confidence: 0.9 };
      },
    };
    const ai = createAi({ provider: invalidProvider });
    await expect(ai.summarize({ text: "hi" })).rejects.toThrow(/empty or invalid summary/);
  });

  it("rejects a whitespace-only summary from a provider", async () => {
    const blank: AiProvider = {
      name: "blank",
      async summarize() {
        return { summary: "   \n\t ", confidence: 0.9 };
      },
      async classify() {
        return { label: "a", confidence: 0.9 };
      },
    };
    const ai = createAi({ provider: blank });
    await expect(ai.summarize({ text: "hi" })).rejects.toThrow(/empty or invalid summary/);
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

  it("records usage at the chokepoint (#80: as a 'miss' request observation)", async () => {
    const observations: AiObservation[] = [];
    const ai = createAi({
      provider: new DeterministicProvider(),
      env: {},
      onUsage: (o) => observations.push(o),
    });
    await ai.summarize({ text: "One sentence here." });
    expect(observations).toHaveLength(1);
    const [observation] = observations;
    expect(observation?.kind).toBe("request");
    if (observation?.kind !== "request") throw new Error("expected a request observation");
    expect(observation.capability).toBe("summarize");
    expect(observation.provider).toBe("deterministic");
    expect(observation.ok).toBe(true);
    expect(observation.cache).toBe("miss");
    expect(observation.providerInvoked).toBe(true);
  });

  describe("caching (#80)", () => {
    it("is on by default: a second identical call is served from cache with no second provider invocation", async () => {
      const observations: AiObservation[] = [];
      const ai = createAi({
        provider: new DeterministicProvider(),
        env: {},
        onUsage: (o) => observations.push(o),
      });
      await ai.summarize({ text: "One sentence here." });
      await ai.summarize({ text: "One sentence here." });
      expect(observations.map((o) => (o.kind === "request" ? o.cache : o.kind))).toEqual(["miss", "hit"]);
    });

    it("cache: false disables caching even when ORION_AI_CACHE would otherwise enable it", async () => {
      let calls = 0;
      const counting: AiProvider = {
        name: "counting",
        async summarize() {
          calls++;
          return { summary: "x", confidence: 0.5 };
        },
        async classify() {
          return { label: "a", confidence: 0.5 };
        },
      };
      const ai = createAi({ provider: counting, cache: false, env: { ORION_AI_CACHE: "on" } });
      await ai.summarize({ text: "same" });
      await ai.summarize({ text: "same" });
      expect(calls).toBe(2);
    });

    it("explicit cache: true wins over ORION_AI_CACHE=off", async () => {
      let calls = 0;
      const counting: AiProvider = {
        name: "counting",
        async summarize() {
          calls++;
          return { summary: "x", confidence: 0.5 };
        },
        async classify() {
          return { label: "a", confidence: 0.5 };
        },
      };
      const ai = createAi({ provider: counting, cache: true, env: { ORION_AI_CACHE: "off" } });
      await ai.summarize({ text: "same" });
      await ai.summarize({ text: "same" });
      expect(calls).toBe(1);
    });

    it("ORION_AI_CACHE=off disables caching when `cache` is omitted", async () => {
      let calls = 0;
      const counting: AiProvider = {
        name: "counting",
        async summarize() {
          calls++;
          return { summary: "x", confidence: 0.5 };
        },
        async classify() {
          return { label: "a", confidence: 0.5 };
        },
      };
      const ai = createAi({ provider: counting, env: { ORION_AI_CACHE: "off" } });
      await ai.summarize({ text: "same" });
      await ai.summarize({ text: "same" });
      expect(calls).toBe(2);
    });

    it("still emits `kind: 'request'` observations with no `cache` field when disabled", async () => {
      const observations: AiObservation[] = [];
      const ai = createAi({
        provider: new DeterministicProvider(),
        cache: false,
        env: {},
        onUsage: (o) => observations.push(o),
      });
      await ai.summarize({ text: "One sentence here." });
      expect(observations).toHaveLength(1);
      const [observation] = observations;
      expect(observation?.kind).toBe("request");
      if (observation?.kind !== "request") throw new Error("expected a request observation");
      expect("cache" in observation).toBe(false);
    });
  });
});
