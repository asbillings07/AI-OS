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
  latencyMs: number;
  ok: boolean;
  confidence?: number;
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
  summarize(request: SummarizeRequest): Promise<SummarizeResult>;
  classify(request: ClassifyRequest): Promise<ClassifyResult>;
}

export class AiError extends Error {}
