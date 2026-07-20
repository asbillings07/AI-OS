import {
  AiError,
  type AiCapabilities,
  type AiProvider,
  type AiUsage,
  type ClassifyRequest,
  type ClassifyResult,
  type SummarizeRequest,
  type SummarizeResult,
} from "./capabilities.js";

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * The single AI Abstraction Layer (ADR-0011). Wraps one provider and:
 *  - validates/coerces structured output (malformed output is handled, not a
 *    surprise downstream),
 *  - records usage (latency, success, confidence) at this one chokepoint,
 *  - keeps provider choice invisible to callers.
 */
export class AiLayer implements AiCapabilities {
  readonly #provider: AiProvider;
  readonly #onUsage: ((usage: AiUsage) => void) | undefined;

  constructor(provider: AiProvider, onUsage?: (usage: AiUsage) => void) {
    this.#provider = provider;
    this.#onUsage = onUsage;
  }

  get providerName(): string {
    return this.#provider.name;
  }

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const start = Date.now();
    try {
      const result = await this.#provider.summarize(request);
      if (typeof result.summary !== "string" || result.summary.length === 0) {
        throw new AiError("summarize: provider returned an empty summary");
      }
      const validated: SummarizeResult = {
        summary: result.summary,
        confidence: clampConfidence(result.confidence),
      };
      this.#record("summarize", start, true, validated.confidence);
      return validated;
    } catch (error) {
      this.#record("summarize", start, false);
      throw error;
    }
  }

  async classify(request: ClassifyRequest): Promise<ClassifyResult> {
    const start = Date.now();
    try {
      const result = await this.#provider.classify(request);
      // Structured validation: the label MUST be one the caller allowed.
      const label = request.labels.includes(result.label)
        ? result.label
        : (request.labels[0] ?? "");
      const validated: ClassifyResult = {
        label,
        confidence: request.labels.includes(result.label) ? clampConfidence(result.confidence) : 0,
      };
      this.#record("classify", start, true, validated.confidence);
      return validated;
    } catch (error) {
      this.#record("classify", start, false);
      throw error;
    }
  }

  #record(capability: AiUsage["capability"], start: number, ok: boolean, confidence?: number): void {
    this.#onUsage?.({
      capability,
      provider: this.#provider.name,
      latencyMs: Date.now() - start,
      ok,
      confidence,
    });
  }
}
