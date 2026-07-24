import { createHash } from "node:crypto";
import {
  AiError,
  isValidSummary,
  type AiCapabilities,
  type AiUsage,
  type ClassifyRequest,
  type ClassifyResult,
  type ExtractBeliefsRequest,
  type ExtractBeliefsResult,
  type SummarizeRequest,
  type SummarizeResult,
} from "./capabilities.js";

/**
 * Cache advisory AI outputs by stable input content (#80). A decorator around
 * `AiCapabilities` — it never changes that contract (ADR-0011) — that memoizes
 * validated results and coalesces concurrent identical requests. Storage is an
 * in-memory `Map`, per process, never persisted: derived/disposable state stays
 * out of the event log (ADR-0009). Keyed by content, not by source revision
 * (ADR-0015) — a byte-identical new occurrence is still a hit.
 */

/** The provider + model identity a cached entry (and its key) is scoped to. */
export interface ExecutionProfile {
  readonly provider: string;
  readonly modelName?: string;
}

interface NormalizedSummarizeRequest {
  readonly text: string;
  readonly purpose: string | undefined;
  readonly maxSentences: number;
}

interface NormalizedClassifyRequest {
  readonly text: string;
  /** Caller-supplied order, deliberately preserved — see `computeCacheKey`. */
  readonly labels: readonly string[];
}

/**
 * Normalizes documented defaults (an omitted `maxSentences` and an explicit
 * `2` share a key). This same object is both hashed and delegated to `inner`
 * (never the caller's original `request`), so `SummarizeRequest`-compatible
 * types matter here — `purpose` stays `undefined`, not `null`, for that
 * reason; `JSON.stringify` already omits an `undefined` key identically to an
 * absent one, so the key is exactly as stable either way.
 */
function normalizeSummarizeRequest(request: SummarizeRequest): NormalizedSummarizeRequest {
  return {
    text: request.text,
    purpose: request.purpose,
    maxSentences: request.maxSentences ?? 2,
  };
}

function normalizeClassifyRequest(request: ClassifyRequest): NormalizedClassifyRequest {
  return { text: request.text, labels: [...request.labels] };
}

export interface CacheKeyInput {
  readonly capability: "summarize" | "classify" | "extract_beliefs";
  readonly request: unknown;
  readonly executionProfile: ExecutionProfile;
  readonly promptVersion: string;
  readonly schemaVersion: number;
}

/**
 * `JSON.stringify` collapses `NaN`, `Infinity`, and `-Infinity` all to the
 * literal `null`, which would silently collide three observably-different
 * `maxSentences` values (`HttpAiProvider` puts the value straight into its
 * prompt) into one cache key. Tag any non-finite number so it round-trips to
 * a distinct, stable string instead of `null` — the tag shape can never
 * collide with a legitimate string/number field, since it only ever replaces
 * an actual `number`-typed value, never a string.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    typeof val === "number" && !Number.isFinite(val)
      ? { __nonFiniteNumber: Number.isNaN(val) ? "NaN" : val > 0 ? "Infinity" : "-Infinity" }
      : val,
  );
}

/**
 * Pure, exported so version/profile isolation is unit-testable directly
 * (#80): every field is explicit input, never a closed-over module constant.
 *
 * Label order is deliberately NOT normalized — both `AiProvider`s fall back to
 * the first label, and the deterministic provider's tie-break is
 * order-dependent, so reordered labels are a genuinely different request.
 */
export function computeCacheKey(input: CacheKeyInput): string {
  const material = stableStringify([
    input.capability,
    input.schemaVersion,
    input.promptVersion,
    input.executionProfile.provider,
    // `null` (never `""`), so an absent model is never conflated with a
    // genuinely empty-string one — `AiProvider.modelName` is an optional
    // string, and both states are currently representable even though an
    // empty HTTP model would normally itself be a misconfiguration.
    input.executionProfile.modelName ?? null,
    input.request,
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/** Bumped by hand whenever `SummarizeResult`/`ClassifyResult`'s shape changes. */
const SCHEMA_VERSION: Record<"summarize" | "classify" | "extract_beliefs", number> = {
  summarize: 1,
  classify: 1,
  extract_beliefs: 1,
};

/**
 * Bumped by hand whenever a provider's prompt-construction logic changes.
 * Coarse (one constant, not per-provider/per-capability) — there's no real
 * prompt-templating system yet, so finer granularity would be speculative.
 */
const PROMPT_VERSION = "v1";

/** Implementation defaults, not architectural commitments (ADR-0015). */
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface AiRequestObservation extends AiUsage {
  readonly kind: "request";
  /** Present only when caching is enabled. */
  readonly cache?: "hit" | "coalesced" | "miss";
}

export interface AiCacheEvictionObservation {
  readonly kind: "cache_eviction";
  readonly reason: "expired" | "capacity";
  readonly capability: "summarize" | "classify" | "extract_beliefs";
  readonly provider: string;
  readonly modelName?: string;
}

export type AiObservation = AiRequestObservation | AiCacheEvictionObservation;

export interface AiCacheOptions {
  /** Bounds resolved (completed) entries only. Pending entries are never bounded. Default 200. */
  maxEntries?: number;
  /** Measured from resolution, not request start. Default 24h. */
  maxAgeMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Folded into the cache key and preserved on every entry for auditability. */
  executionProfile?: ExecutionProfile;
  onUsage?: (observation: AiObservation) => void;
}

/**
 * Deep clone and freeze. Every caller — a hit, a coalesced joiner, and the
 * original delegator alike — gets its own deep copy, so one caller mutating a
 * nested returned value (e.g. `ExtractBeliefsResult.candidates`) can never
 * corrupt the shared cache entry or another caller's copy.
 */
function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function cloneResult<T extends object>(result: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(result);
  }
  return JSON.parse(JSON.stringify(result));
}

interface CacheEntry {
  promise: Promise<object>;
  state: "pending" | "resolved";
  /** Set only when `state` transitions to `"resolved"` — the TTL clock starts here. */
  storedAt?: number;
  readonly capability: "summarize" | "classify" | "extract_beliefs";
  readonly provider: string;
  readonly modelName?: string;
}

/**
 * Wrap any `AiCapabilities` to cache validated results. `inner` is expected to
 * already be a validating layer (typically `AiLayer`) — this decorator only
 * ever sees, and therefore only ever caches, whatever `inner` decides to
 * return without throwing (a coerced success counts; a thrown `AiError`
 * never reaches the cache at all).
 */
export function withCache(inner: AiCapabilities, options: AiCacheOptions = {}): AiCapabilities {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const executionProfile = options.executionProfile ?? { provider: inner.providerName };
  const onUsage = options.onUsage;
  const store = new Map<string, CacheEntry>();

  function emit(observation: AiObservation): void {
    try {
      onUsage?.(observation);
    } catch {
      // Telemetry must never break a cache operation.
    }
  }

  /**
   * Bounds only resolved entries, oldest-since-resolution first. This is
   * deliberately "resolution-ordered retention," not LRU: a hit does not
   * re-touch an entry, only the pending -> resolved transition does.
   */
  function enforceCapacity(): void {
    let resolvedCount = 0;
    for (const entry of store.values()) {
      if (entry.state === "resolved") resolvedCount++;
    }
    if (resolvedCount <= maxEntries) return;
    for (const [key, entry] of store) {
      if (resolvedCount <= maxEntries) break;
      if (entry.state !== "resolved") continue;
      store.delete(key);
      resolvedCount--;
      emit({
        kind: "cache_eviction",
        reason: "capacity",
        capability: entry.capability,
        provider: entry.provider,
        modelName: entry.modelName,
      });
    }
  }

  async function cached<T extends object>(
    capability: "summarize" | "classify" | "extract_beliefs",
    key: string,
    call: () => Promise<T>,
  ): Promise<T> {
    const start = now();

    let existing = store.get(key);
    // TTL is measured from resolution and checked lazily, per-key, at lookup —
    // a pending entry is never subject to this check (no `storedAt` yet).
    if (existing?.state === "resolved" && existing.storedAt !== undefined && now() - existing.storedAt > maxAgeMs) {
      store.delete(key);
      emit({
        kind: "cache_eviction",
        reason: "expired",
        capability: existing.capability,
        provider: existing.provider,
        modelName: existing.modelName,
      });
      existing = undefined;
    }

    if (existing) {
      const cache: "hit" | "coalesced" = existing.state === "resolved" ? "hit" : "coalesced";
      try {
        const result = (await existing.promise) as T;
        if (capability === "summarize" && !isValidSummary((result as unknown as SummarizeResult).summary)) {
          if (store.get(key) === existing) {
            store.delete(key);
          }
          throw new AiError("summarize: cached summary is invalid");
        }
        emit({
          kind: "request",
          capability,
          provider: existing.provider,
          modelName: existing.modelName,
          latencyMs: now() - start,
          ok: true,
          providerInvoked: false,
          cache,
          confidence: "confidence" in result ? (result as any).confidence : undefined,
        });
        return cloneResult(result);
      } catch (error) {
        // A coalesced joiner never deletes the entry itself — only the
        // original delegator's guarded catch below does (identity-checked),
        // so a stale reference here can never clobber a newer replacement.
        emit({
          kind: "request",
          capability,
          provider: existing.provider,
          modelName: existing.modelName,
          latencyMs: now() - start,
          ok: false,
          providerInvoked: false,
          cache,
        });
        throw error;
      }
    }

    // Clone `inner`'s result into a cache-owned object *before* freezing it —
    // freezing the object `inner` itself returned could mutate state owned or
    // reused by that implementation, which is not this decorator's to touch.
    // Every future hit/coalesced read shares this exact clone (the same
    // settled promise), so freezing it here protects all of them; callers
    // still never receive it directly — see `cloneResult` below.
    const promise = call().then((result) => {
      if (capability === "summarize" && !isValidSummary((result as unknown as SummarizeResult).summary)) {
        throw new AiError("summarize: summary is invalid");
      }
      return deepFreeze(cloneResult(result)) as T;
    });
    const entry: CacheEntry = {
      promise,
      state: "pending",
      capability,
      provider: executionProfile.provider,
      modelName: executionProfile.modelName,
    };
    store.set(key, entry);

    try {
      const result = await promise;
      // Identity-checked: only this entry's own transition may promote it.
      if (store.get(key) === entry) {
        entry.state = "resolved";
        entry.storedAt = now();
        // Re-insert at the end: retention order reflects resolution time, not
        // request-start time (out-of-order resolution must not evict the
        // entry that is actually most recently completed).
        store.delete(key);
        store.set(key, entry);
        enforceCapacity();
      }
      return cloneResult(result);
    } catch (error) {
      // Never cache a failure — and never let a stale/superseded entry delete
      // a newer one that has since taken its slot.
      if (store.get(key) === entry) {
        store.delete(key);
      }
      throw error;
    }
  }

  return {
    get providerName(): string {
      return inner.providerName;
    },
    summarize(request: SummarizeRequest): Promise<SummarizeResult> {
      const snapshot = normalizeSummarizeRequest(request);
      const key = computeCacheKey({
        capability: "summarize",
        request: snapshot,
        executionProfile,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION.summarize,
      });
      // Delegate the exact snapshot that was hashed — never the caller's
      // original (possibly still-mutable) request — so the key and the value
      // actually produced can never desync.
      return cached("summarize", key, () => inner.summarize(snapshot));
    },
    classify(request: ClassifyRequest): Promise<ClassifyResult> {
      const snapshot = normalizeClassifyRequest(request);
      const key = computeCacheKey({
        capability: "classify",
        request: snapshot,
        executionProfile,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION.classify,
      });
      return cached("classify", key, () => inner.classify(snapshot));
    },
    extractBeliefs(request: ExtractBeliefsRequest): Promise<ExtractBeliefsResult> {
      const key = computeCacheKey({
        capability: "extract_beliefs",
        request,
        executionProfile,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION.extract_beliefs,
      });
      return cached("extract_beliefs", key, () => inner.extractBeliefs(request));
    },
  };
}
