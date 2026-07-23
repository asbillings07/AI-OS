import type { AiCapabilities, AiProvider, AiUsage } from "./capabilities.js";
import { AiLayer } from "./layer.js";
import { DeterministicProvider } from "./deterministic.js";
import { HttpAiProvider } from "./http-provider.js";
import { withCache, type AiCacheOptions, type AiObservation } from "./cache.js";

export * from "./capabilities.js";
export { AiLayer } from "./layer.js";
export { DeterministicProvider } from "./deterministic.js";
export { HttpAiProvider } from "./http-provider.js";
export {
  withCache,
  computeCacheKey,
  type AiCacheOptions,
  type AiObservation,
  type AiRequestObservation,
  type AiCacheEvictionObservation,
  type CacheKeyInput,
  type ExecutionProfile,
} from "./cache.js";

export interface CreateAiOptions {
  /** Force a specific provider (mainly for tests). */
  provider?: AiProvider;
  /** Observe every completed request, and any cache eviction, at the chokepoint. */
  onUsage?: (observation: AiObservation) => void;
  /** Environment to read config from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /**
   * Default true. An explicit value here always wins over `ORION_AI_CACHE`
   * (the env var is consulted only when this is omitted) — see
   * `resolveCacheEnabled`. `executionProfile`/`onUsage` are omitted: this
   * function derives and passes both itself, so advertising them here would
   * invite a caller to set values `createAi()` silently overrides.
   */
  cache?: boolean | Omit<AiCacheOptions, "executionProfile" | "onUsage">;
}

function selectProvider(env: Record<string, string | undefined>): AiProvider {
  const apiKey = env.ORION_AI_API_KEY;
  if (apiKey) {
    return new HttpAiProvider({
      apiKey,
      baseUrl: env.ORION_AI_BASE_URL,
      model: env.ORION_AI_MODEL,
    });
  }
  // Default: deterministic, offline, key-free.
  return new DeterministicProvider();
}

/**
 * ORION_AI_CACHE is truthy unless it's an explicit disable value — mirrors
 * `packages/core`'s ORION_LOG convention. Only consulted when `cache` wasn't
 * passed explicitly to `createAi()`.
 */
function cacheEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  const value = env.ORION_AI_CACHE;
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "off";
}

function resolveCacheEnabled(
  cache: boolean | Omit<AiCacheOptions, "executionProfile" | "onUsage"> | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (typeof cache === "boolean") return cache;
  if (cache !== undefined) return true; // an options object means "enabled, with these options"
  return cacheEnabledFromEnv(env);
}

/**
 * Build the AI capability surface. With no configuration it returns the
 * deterministic provider, so Orion runs with no API key and no network. Set
 * ORION_AI_API_KEY (and optionally ORION_AI_BASE_URL / ORION_AI_MODEL) to route
 * capabilities to a real provider behind the same interface.
 *
 * Caches validated results by default (#80) — re-requesting an unchanged
 * input never re-invokes the provider. Set `cache: false` (or
 * ORION_AI_CACHE=off) to disable, e.g. for tests that must force N
 * invocations.
 */
export function createAi(options: CreateAiOptions = {}): AiCapabilities {
  const env = options.env ?? process.env;
  const provider = options.provider ?? selectProvider(env);
  const cacheEnabled = resolveCacheEnabled(options.cache, env);

  const safelyObserve = (observation: AiObservation): void => {
    try {
      options.onUsage?.(observation);
    } catch {
      // Telemetry must never break a cache/AI operation.
    }
  };

  if (!cacheEnabled) {
    // AiLayer only knows about plain AiUsage; adapt it to the documented
    // AiObservation surface rather than leaking AiUsage out of an option
    // whose type is always AiObservation.
    return new AiLayer(provider, (usage: AiUsage) => safelyObserve({ kind: "request", ...usage }));
  }

  // A miss means "the cache delegated to AiLayer" — not necessarily "the
  // provider ran" (e.g. classify() can reject before ever reaching it).
  // AiLayer's own record already reflects that via `providerInvoked`; this
  // only adds the cache-specific tag.
  const layer = new AiLayer(provider, (usage: AiUsage) =>
    safelyObserve({ kind: "request", ...usage, cache: "miss" }),
  );

  const cacheOptions = typeof options.cache === "object" ? options.cache : {};
  return withCache(layer, {
    ...cacheOptions,
    executionProfile: { provider: provider.name, modelName: provider.modelName },
    onUsage: safelyObserve,
  });
}
