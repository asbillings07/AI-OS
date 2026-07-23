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
      // Nothing here rejects before reaching the provider (unlike classify's
      // empty-label check below), so `providerInvoked` is always true.
      const result = await this.#provider.summarize(request);
      const summary = typeof result.summary === "string" ? result.summary.trim() : "";
      if (summary.length === 0) {
        // Whitespace-only is as useless as empty — reject it, don't record success.
        throw new AiError("summarize: provider returned an empty summary");
      }
      const validated: SummarizeResult = {
        summary,
        confidence: clampConfidence(result.confidence),
      };
      this.#record("summarize", start, true, true, validated.confidence);
      return validated;
    } catch (error) {
      this.#record("summarize", start, false, true);
      throw error;
    }
  }

  async classify(request: ClassifyRequest): Promise<ClassifyResult> {
    const start = Date.now();
    // This is the one path where `providerInvoked` can end up false: the
    // empty-label check below can reject before `this.#provider.classify()` is
    // ever called (#80).
    let providerInvoked = false;
    try {
      // An empty label set has no valid answer — reject it up front rather than
      // inventing an empty-string label that violates the ClassifyRequest contract.
      const [firstLabel] = request.labels;
      if (firstLabel === undefined) {
        throw new AiError("classify: request.labels must not be empty");
      }
      providerInvoked = true;
      const result = await this.#provider.classify(request);
      // Structured validation: the label MUST be one the caller allowed.
      const allowed = request.labels.includes(result.label);
      const validated: ClassifyResult = {
        label: allowed ? result.label : firstLabel,
        confidence: allowed ? clampConfidence(result.confidence) : 0,
      };
      this.#record("classify", start, true, providerInvoked, validated.confidence);
      return validated;
    } catch (error) {
      this.#record("classify", start, false, providerInvoked);
      throw error;
    }
  }

  #record(
    capability: AiUsage["capability"],
    start: number,
    ok: boolean,
    providerInvoked: boolean,
    confidence?: number,
  ): void {
    try {
      this.#onUsage?.({
        capability,
        provider: this.#provider.name,
        modelName: this.#provider.modelName,
        latencyMs: Date.now() - start,
        ok,
        providerInvoked,
        confidence,
      });
    } catch {
      // A telemetry callback must never break the call it's observing.
    }
  }
}
