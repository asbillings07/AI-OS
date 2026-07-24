/**
 * The AI capability contract (ADR-0011). Callers ask for a *capability*
 * ("summarize this"), never for a provider or model. Every result is
 * structured and carries an honest `confidence`.
 */

export interface SummarizeRequest {
  text: string;
  /** Upper bound on summary length. Default 2. */
  maxSentences?: number;
  /** Optional framing for the summary, e.g. "email triage". */
  purpose?: string;
}

export interface SummarizeResult {
  summary: string;
  /** 0..1. Honest about uncertainty (Eng #7); the stub reports low confidence. */
  confidence: number;
}

export interface ClassifyRequest {
  text: string;
  /** The allowed labels; the result's label is always one of these. */
  labels: readonly string[];
}

export interface ClassifyResult {
  label: string;
  confidence: number;
}

/** Observability captured at the single AI chokepoint (Eng #7). */
export interface AiUsage {
  capability: "summarize" | "classify";
  provider: string;
  /** Opaque model/version label, mirrors `AiProvider.modelName` (#80). Never a vendor SDK type (Eng #8). */
  modelName?: string;
  latencyMs: number;
  ok: boolean;
  confidence?: number;
  /**
   * Did this call actually reach `AiProvider`? Usually true, but a call can be
   * rejected before ever calling the provider (e.g. `classify()` with an empty
   * label set, #80) — `ok: false` alone doesn't distinguish that from a provider
   * failure, so this is tracked explicitly rather than assumed.
   */
  providerInvoked: boolean;
}

/**
 * The application-facing capability surface. This is the ONLY way the rest of
 * Orion touches AI. It is advisory by construction — it produces understanding,
 * never side effects (ADR-0004).
 */
export interface AiCapabilities {
  readonly providerName: string;
  summarize(request: SummarizeRequest): Promise<SummarizeResult>;
  classify(request: ClassifyRequest): Promise<ClassifyResult>;
}

/**
 * A concrete provider (hosted or local) behind an adapter. Its SDK and types
 * never cross this boundary (Eng #8). The AI layer wraps it to validate output
 * and record usage.
 */
export interface AiProvider {
  readonly name: string;
  /**
   * Opaque model/version label, for observability and cache-key auditability
   * (#80) — never the provider SDK's own model type (Eng #8). Deliberately
   * NOT part of `AiCapabilities`: it stays an internal-adapter detail, not a
   * capability the rest of Orion can ask for (ADR-0011).
   */
  readonly modelName?: string;
  summarize(request: SummarizeRequest): Promise<SummarizeResult>;
  classify(request: ClassifyRequest): Promise<ClassifyResult>;
}

export class AiError extends Error {}

/**
 * Validate that a summary string is non-empty, non-whitespace, and not a malformed/
 * literal string value such as "undefined", "null", or "[object Object]".
 */
export function isValidSummary(summary: unknown): summary is string {
  if (typeof summary !== "string") return false;
  const trimmed = summary.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  if (
    lower === "undefined" ||
    lower === "undefined." ||
    lower === "null" ||
    lower === "null." ||
    lower === "[undefined]" ||
    lower === "[null]" ||
    lower === "[object object]" ||
    lower === "nan"
  ) {
    return false;
  }
  return true;
}
