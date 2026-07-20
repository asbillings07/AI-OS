import type {
  AiProvider,
  ClassifyRequest,
  ClassifyResult,
  SummarizeRequest,
  SummarizeResult,
} from "./capabilities.js";

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.length > 0);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/**
 * A deterministic, offline AI implementation (the default). It is honestly
 * extractive, not generative — so it reports low confidence — but it lets the
 * entire pipeline run with no API key, works forever under replay, and keeps CI
 * green without network or provider availability.
 */
export class DeterministicProvider implements AiProvider {
  readonly name = "deterministic";

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const maxSentences = request.maxSentences ?? 2;
    const sentences = splitSentences(request.text);
    const summary = sentences.slice(0, maxSentences).join(" ");
    return {
      summary: summary || request.text.trim().slice(0, 140),
      confidence: 0.4,
    };
  }

  async classify(request: ClassifyRequest): Promise<ClassifyResult> {
    const haystack = ` ${tokenize(request.text).join(" ")} `;
    let best = { label: request.labels[0] ?? "", score: 0 };
    for (const label of request.labels) {
      const score = tokenize(label).reduce(
        (sum, token) => sum + (haystack.includes(` ${token} `) ? 1 : 0),
        0,
      );
      if (score > best.score) {
        best = { label, score };
      }
    }
    return {
      label: best.label,
      confidence: best.score === 0 ? 0.1 : Math.min(0.9, best.score / (best.score + 1)),
    };
  }
}
