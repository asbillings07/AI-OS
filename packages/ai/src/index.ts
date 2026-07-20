import type { AiCapabilities, AiProvider, AiUsage } from "./capabilities.js";
import { AiLayer } from "./layer.js";
import { DeterministicProvider } from "./deterministic.js";
import { HttpAiProvider } from "./http-provider.js";

export * from "./capabilities.js";
export { AiLayer } from "./layer.js";
export { DeterministicProvider } from "./deterministic.js";
export { HttpAiProvider } from "./http-provider.js";

export interface CreateAiOptions {
  /** Force a specific provider (mainly for tests). */
  provider?: AiProvider;
  /** Observe usage at the chokepoint (latency, success, confidence). */
  onUsage?: (usage: AiUsage) => void;
  /** Environment to read config from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
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
 * Build the AI capability surface. With no configuration it returns the
 * deterministic provider, so Orion runs with no API key and no network. Set
 * ORION_AI_API_KEY (and optionally ORION_AI_BASE_URL / ORION_AI_MODEL) to route
 * capabilities to a real provider behind the same interface.
 */
export function createAi(options: CreateAiOptions = {}): AiCapabilities {
  const env = options.env ?? process.env;
  const provider = options.provider ?? selectProvider(env);
  return new AiLayer(provider, options.onUsage);
}
