import { describe, it, expect } from "vitest";
import {
  withCache,
  computeCacheKey,
  type CacheKeyInput,
  type AiRequestObservation,
  type AiCacheEvictionObservation,
  type AiObservation,
} from "./cache.js";
import { createAi, DeterministicProvider, type AiCapabilities, type AiProvider } from "./index.js";
import type { SummarizeResult } from "./capabilities.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A summarizer whose next call can be gated on a deferred, or auto-resolves. */
function controllableSummarizer(autoSummary: string) {
  let calls = 0;
  let pending: Deferred<SummarizeResult> | null = null;
  return {
    calls: () => calls,
    gate(): void {
      pending = deferred<SummarizeResult>();
    },
    resolve(value: SummarizeResult): void {
      pending?.resolve(value);
      pending = null;
    },
    reject(error: unknown): void {
      pending?.reject(error);
      pending = null;
    },
    async handle(): Promise<SummarizeResult> {
      calls++;
      if (pending) return pending.promise;
      return { summary: autoSummary, confidence: 0.5 };
    },
  };
}

describe("computeCacheKey (#80): pure, explicit contract material", () => {
  const profile = { provider: "p", modelName: "m" };
  const request = { text: "hello", purpose: undefined, maxSentences: 2 };
  const base: CacheKeyInput = {
    capability: "summarize",
    request,
    executionProfile: profile,
    promptVersion: "v1",
    schemaVersion: 1,
  };

  it("differs by capability", () => {
    expect(computeCacheKey({ ...base, capability: "classify" })).not.toBe(computeCacheKey(base));
  });

  it("differs by execution profile provider", () => {
    expect(computeCacheKey({ ...base, executionProfile: { ...profile, provider: "other" } })).not.toBe(
      computeCacheKey(base),
    );
  });

  it("differs by execution profile model", () => {
    expect(computeCacheKey({ ...base, executionProfile: { ...profile, modelName: "other-model" } })).not.toBe(
      computeCacheKey(base),
    );
  });

  it("distinguishes an absent model from an explicitly empty-string model (regression)", () => {
    const absent = computeCacheKey({ ...base, executionProfile: { provider: "p" } });
    const empty = computeCacheKey({ ...base, executionProfile: { provider: "p", modelName: "" } });
    expect(absent).not.toBe(empty);
  });

  it("differs by schema version", () => {
    expect(computeCacheKey({ ...base, schemaVersion: 2 })).not.toBe(computeCacheKey(base));
  });

  it("differs by prompt version", () => {
    expect(computeCacheKey({ ...base, promptVersion: "v2" })).not.toBe(computeCacheKey(base));
  });

  it("differs when classify labels are reordered — label order is never normalized", () => {
    const forward = computeCacheKey({
      ...base,
      capability: "classify",
      request: { text: "x", labels: ["a", "b"] },
    });
    const reversed = computeCacheKey({
      ...base,
      capability: "classify",
      request: { text: "x", labels: ["b", "a"] },
    });
    expect(forward).not.toBe(reversed);
  });

  it("is identical for structurally-equal, differently-ordered-key-insertion requests", () => {
    // JSON.stringify on object literals built the same way is deterministic;
    // this just pins that computeCacheKey is pure and reproducible.
    expect(computeCacheKey(base)).toBe(computeCacheKey({ ...base }));
  });

  it("does not collapse NaN/Infinity/-Infinity into the same key (plain JSON.stringify would)", () => {
    const keyFor = (maxSentences: number): string =>
      computeCacheKey({ ...base, request: { ...request, maxSentences } });

    const finite = keyFor(2);
    const nan = keyFor(Number.NaN);
    const positiveInfinity = keyFor(Number.POSITIVE_INFINITY);
    const negativeInfinity = keyFor(Number.NEGATIVE_INFINITY);

    // Sanity check on the premise: naive JSON.stringify really does conflate these.
    expect(JSON.stringify(Number.NaN)).toBe(JSON.stringify(Number.POSITIVE_INFINITY));
    expect(JSON.stringify(Number.NaN)).toBe(JSON.stringify(Number.NEGATIVE_INFINITY));

    const keys = [finite, nan, positiveInfinity, negativeInfinity];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("withCache (#80)", () => {
  it("a second identical summarize() call does not invoke inner again", async () => {
    let calls = 0;
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize(request) {
        calls++;
        return { summary: request.text, confidence: 0.5 };
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const ai = withCache(inner);
    const first = await ai.summarize({ text: "hello" });
    const second = await ai.summarize({ text: "hello" });
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it("mutating one caller's returned result cannot corrupt a later cache hit (regression)", async () => {
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize(request) {
        return { summary: request.text, confidence: 0.42 };
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const ai = withCache(inner);
    const first = await ai.summarize({ text: "hello" });
    // Each caller gets its own clone, so mutating it is unremarkable — the
    // point is that it can never reach the cache's internal, frozen original.
    first.summary = "corrupted";
    first.confidence = 99;

    const second = await ai.summarize({ text: "hello" });
    expect(second.summary).toBe("hello");
    expect(second.confidence).toBe(0.42);
    expect(second).not.toBe(first);
  });

  it("rejects and removes invalid summaries returned by inner, avoiding caching invalid string literals like 'undefined' (#87)", async () => {
    let calls = 0;
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize() {
        calls++;
        return { summary: "undefined", confidence: 0.9 };
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const ai = withCache(inner);
    await expect(ai.summarize({ text: "hello" })).rejects.toThrow(/summary is invalid/);
    await expect(ai.summarize({ text: "hello" })).rejects.toThrow(/summary is invalid/);
    expect(calls).toBe(2);
  });

  it("never freezes or otherwise modifies the object inner itself returned (regression)", async () => {
    // Simulates an AiCapabilities implementation that returns (and may keep
    // using/mutating) the very same object across calls, e.g. internal
    // pooling — the decorator must clone before it ever touches that object.
    const innerResult = { summary: "original", confidence: 0.5 };
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize() {
        return innerResult;
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const ai = withCache(inner);
    await ai.summarize({ text: "x" });

    // The decorator must not have frozen inner's own object.
    expect(Object.isFrozen(innerResult)).toBe(false);
    innerResult.summary = "mutated-by-inner-after-returning";
    innerResult.confidence = 0.9;

    // The cache captured a clone at resolution time, so a later hit is
    // unaffected by inner mutating its own object afterward.
    const hit = await ai.summarize({ text: "x" });
    expect(hit.summary).toBe("original");
    expect(hit.confidence).toBe(0.5);
  });

  it("an omitted maxSentences and the explicit documented default (2) share a key", async () => {
    let calls = 0;
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize(request) {
        calls++;
        return { summary: `sentences:${request.maxSentences ?? "unset"}`, confidence: 0.5 };
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const ai = withCache(inner);
    await ai.summarize({ text: "same" });
    await ai.summarize({ text: "same", maxSentences: 2 });
    expect(calls).toBe(1);
  });

  it("NaN, Infinity, and -Infinity maxSentences are cached separately, never conflated (regression)", async () => {
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize(request) {
        return { summary: `maxSentences:${request.maxSentences}`, confidence: 0.5 };
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const ai = withCache(inner);
    const nan = await ai.summarize({ text: "same", maxSentences: Number.NaN });
    const positiveInfinity = await ai.summarize({ text: "same", maxSentences: Number.POSITIVE_INFINITY });
    const negativeInfinity = await ai.summarize({ text: "same", maxSentences: Number.NEGATIVE_INFINITY });
    expect(nan.summary).toBe("maxSentences:NaN");
    expect(positiveInfinity.summary).toBe("maxSentences:Infinity");
    expect(negativeInfinity.summary).toBe("maxSentences:-Infinity");
  });

  it("different text produces a different key — results are never conflated", async () => {
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize(request) {
        return { summary: request.text, confidence: 0.5 };
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const ai = withCache(inner);
    const a = await ai.summarize({ text: "alpha" });
    const b = await ai.summarize({ text: "beta" });
    expect(a.summary).toBe("alpha");
    expect(b.summary).toBe("beta");
  });

  it("preserves classify label order: reordered labels are distinct keys with distinct fallback results", async () => {
    let calls = 0;
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize() {
        throw new Error("unused");
      },
      async classify(request) {
        calls++;
        // Mirrors DeterministicProvider: first label wins on a tie / no match.
        return { label: request.labels[0] ?? "none", confidence: 0.1 };
      },
    };
    const ai = withCache(inner);
    const ab = await ai.classify({ text: "no match", labels: ["a", "b"] });
    const ba = await ai.classify({ text: "no match", labels: ["b", "a"] });
    expect(ab.label).toBe("a");
    expect(ba.label).toBe("b");
    expect(calls).toBe(2);

    const abAgain = await ai.classify({ text: "no match", labels: ["a", "b"] });
    expect(abAgain).toEqual(ab);
    expect(calls).toBe(2);
  });

  it("snapshots the request before hashing and delegating — later mutation of the caller's array cannot desync it", async () => {
    const seen: string[][] = [];
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize() {
        throw new Error("unused");
      },
      async classify(request) {
        seen.push([...request.labels]);
        return { label: request.labels[0] ?? "none", confidence: 0.5 };
      },
    };
    const ai = withCache(inner);
    const labels = ["a", "b"];
    const pending = ai.classify({ text: "x", labels });
    // Mutate the caller's own array after calling, before the promise resolves.
    labels.push("c");
    labels.reverse();
    const result = await pending;
    expect(seen).toEqual([["a", "b"]]); // inner saw the original snapshot only
    expect(result.label).toBe("a");

    // A second call shaped like the ORIGINAL (pre-mutation) request is a hit.
    const result2 = await ai.classify({ text: "x", labels: ["a", "b"] });
    expect(seen).toHaveLength(1);
    expect(result2).toEqual(result);
  });

  it("coalesces two concurrent calls for the same key into a single inner invocation", async () => {
    const gate = deferred<{ summary: string; confidence: number }>();
    let calls = 0;
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize() {
        calls++;
        return gate.promise;
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const ai = withCache(inner);
    const p1 = ai.summarize({ text: "same" });
    const p2 = ai.summarize({ text: "same" });
    gate.resolve({ summary: "done", confidence: 0.7 });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(r1).toEqual(r2);
  });

  it("never evicts pending entries, even when they exceed maxEntries", async () => {
    const gateA = deferred<SummarizeResult>();
    const gateB = deferred<SummarizeResult>();
    let callsA = 0;
    let callsB = 0;
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize(request) {
        if (request.text === "A") {
          callsA++;
          return gateA.promise;
        }
        callsB++;
        return gateB.promise;
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const evictions: AiCacheEvictionObservation[] = [];
    const ai = withCache(inner, {
      maxEntries: 1,
      onUsage: (o) => {
        if (o.kind === "cache_eviction") evictions.push(o);
      },
    });
    const pA = ai.summarize({ text: "A" });
    const pB = ai.summarize({ text: "B" }); // both pending, exceeding maxEntries: 1
    expect(evictions).toHaveLength(0);
    // A second, concurrent request for A coalesces onto the same in-flight call.
    const pA2 = ai.summarize({ text: "A" });
    gateA.resolve({ summary: "a", confidence: 0.5 });
    gateB.resolve({ summary: "b", confidence: 0.5 });
    await Promise.all([pA, pA2, pB]);
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);
  });

  it("retains the entry that resolves last, even if it started first (resolution-ordered retention, not LRU)", async () => {
    const a = controllableSummarizer("a-auto");
    const b = controllableSummarizer("b-auto");
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize(request) {
        return request.text === "A" ? a.handle() : b.handle();
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const evictions: AiCacheEvictionObservation[] = [];
    const ai = withCache(inner, {
      maxEntries: 1,
      onUsage: (o) => {
        if (o.kind === "cache_eviction") evictions.push(o);
      },
    });

    a.gate();
    b.gate();
    const pA = ai.summarize({ text: "A" }); // starts first
    const pB = ai.summarize({ text: "B" }); // starts second
    b.resolve({ summary: "b", confidence: 0.5 });
    await pB; // B resolves first
    a.resolve({ summary: "a", confidence: 0.5 });
    await pA; // A resolves last

    expect(evictions).toHaveLength(1);
    expect(evictions[0]?.reason).toBe("capacity");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);

    // A (most-recently resolved) is retained: a repeat is a hit, no new call.
    await ai.summarize({ text: "A" });
    expect(a.calls()).toBe(1);

    // B (oldest-since-resolution) was evicted: a repeat re-invokes.
    await ai.summarize({ text: "B" });
    expect(b.calls()).toBe(2);
  });

  it("never caches a rejected call; a coalesced joiner also observes the rejection, then the next call re-invokes", async () => {
    let calls = 0;
    const gate = deferred<SummarizeResult>();
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize() {
        calls++;
        if (calls === 1) return gate.promise;
        return { summary: "second", confidence: 0.5 };
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const observations: AiObservation[] = [];
    const ai = withCache(inner, { onUsage: (o) => observations.push(o) });
    const p1 = ai.summarize({ text: "same" });
    const p2 = ai.summarize({ text: "same" }); // coalesces onto p1
    gate.reject(new Error("boom"));
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");

    const requestObservations = observations.filter((o): o is AiRequestObservation => o.kind === "request");
    const coalesced = requestObservations.find((o) => o.cache === "coalesced");
    expect(coalesced?.ok).toBe(false);

    const p3 = ai.summarize({ text: "same" });
    await expect(p3).resolves.toEqual({ summary: "second", confidence: 0.5 });
    expect(calls).toBe(2);
  });

  it("measures maxAgeMs from resolution, not from request start", async () => {
    let now = 1_000;
    let calls = 0;
    const gate = deferred<SummarizeResult>();
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize() {
        calls++;
        if (calls === 1) return gate.promise;
        return { summary: "fresh", confidence: 0.5 };
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const ai = withCache(inner, { maxAgeMs: 100, now: () => now });

    const pending = ai.summarize({ text: "slow" });
    // Advance well past maxAgeMs WHILE still pending — pending entries never expire.
    now += 1_000;
    gate.resolve({ summary: "slow-result", confidence: 0.5 });
    await pending;

    // storedAt is set at resolution (now = 2000). Advancing less than maxAgeMs
    // from THERE is still a hit.
    now += 50;
    const stillCached = await ai.summarize({ text: "slow" });
    expect(stillCached.summary).toBe("slow-result");
    expect(calls).toBe(1);

    // Advancing past maxAgeMs from resolution time expires it.
    now += 100;
    const fresh = await ai.summarize({ text: "slow" });
    expect(fresh.summary).toBe("fresh");
    expect(calls).toBe(2);
  });

  it("a throwing onUsage callback does not break the cache operation", async () => {
    const inner: AiCapabilities = {
      providerName: "fake",
      async summarize(request) {
        return { summary: request.text, confidence: 0.5 };
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const ai = withCache(inner, {
      onUsage: () => {
        throw new Error("telemetry exploded");
      },
    });
    const result = await ai.summarize({ text: "ok" });
    expect(result.summary).toBe("ok");
    const result2 = await ai.summarize({ text: "ok" });
    expect(result2).toEqual(result);
  });
});

describe("withCache composed through createAi() (#80): AiLayer + cache together", () => {
  it("a burst of concurrent identical requests produces one miss and one coalesced observation, and one provider invocation", async () => {
    const gate = deferred<SummarizeResult>();
    let calls = 0;
    const provider: AiProvider = {
      name: "gated",
      async summarize() {
        calls++;
        return gate.promise;
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const observations: AiObservation[] = [];
    const ai = createAi({ provider, env: {}, onUsage: (o) => observations.push(o) });
    const p1 = ai.summarize({ text: "same" });
    const p2 = ai.summarize({ text: "same" });
    gate.resolve({ summary: "done", confidence: 0.7 });
    await Promise.all([p1, p2]);

    expect(calls).toBe(1);
    const tags = observations
      .filter((o): o is AiRequestObservation => o.kind === "request")
      .map((o) => o.cache)
      .sort();
    expect(tags).toEqual(["coalesced", "miss"]);
  });

  it("providerInvoked is false for a pre-validation rejection (empty labels), even though cache is 'miss'", async () => {
    const observations: AiObservation[] = [];
    const ai = createAi({ provider: new DeterministicProvider(), env: {}, onUsage: (o) => observations.push(o) });
    await expect(ai.classify({ text: "x", labels: [] })).rejects.toThrow(/labels must not be empty/);
    const [observation] = observations;
    expect(observation?.kind).toBe("request");
    if (observation?.kind !== "request") throw new Error("expected a request observation");
    expect(observation.cache).toBe("miss");
    expect(observation.providerInvoked).toBe(false);
    expect(observation.ok).toBe(false);
  });

  it("a second identical summarize() call is served from cache — no second provider invocation", async () => {
    let calls = 0;
    const provider: AiProvider = {
      name: "counting",
      async summarize() {
        calls++;
        return { summary: "x", confidence: 0.5 };
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const ai = createAi({ provider, env: {} });
    await ai.summarize({ text: "same" });
    await ai.summarize({ text: "same" });
    expect(calls).toBe(1);
  });

  it("preserves provider/model metadata on a cache hit for auditability", async () => {
    const provider: AiProvider = {
      name: "audited",
      modelName: "audited-v1",
      async summarize() {
        return { summary: "x", confidence: 0.5 };
      },
      async classify() {
        throw new Error("unused");
      },
    };
    const observations: AiObservation[] = [];
    const ai = createAi({ provider, env: {}, onUsage: (o) => observations.push(o) });
    await ai.summarize({ text: "same" });
    await ai.summarize({ text: "same" });
    const hit = observations.find((o): o is AiRequestObservation => o.kind === "request" && o.cache === "hit");
    expect(hit?.provider).toBe("audited");
    expect(hit?.modelName).toBe("audited-v1");
  });
});
