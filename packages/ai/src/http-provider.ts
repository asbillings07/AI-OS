import {
  AiError,
  type AiProvider,
  type ClassifyRequest,
  type ClassifyResult,
  type ExtractBeliefsRequest,
  type ExtractBeliefsResult,
  type SummarizeRequest,
  type SummarizeResult,
} from "./capabilities.js";

export interface HttpAiProviderOptions {
  apiKey: string;
  /** OpenAI-compatible base URL. Defaults to the OpenAI API. */
  baseUrl?: string;
  /** Model name — an implementation detail that never leaks past this adapter. */
  model?: string;
  /** Abort a request that stalls longer than this (ms). Defaults to 30s. */
  timeoutMs?: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * One concrete provider adapter (ADR-0011): an OpenAI-compatible chat endpoint
 * called via fetch. Its wire types never cross the AiProvider boundary. This is
 * NOT the default and is never exercised by the offline slice; it exists to
 * prove the seam — swapping providers is a localized change.
 */
export class HttpAiProvider implements AiProvider {
  readonly name = "http";
  readonly modelName: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: HttpAiProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.modelName = options.model ?? "gpt-4o-mini";
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const system = `You summarize ${request.purpose ?? "text"} in at most ${request.maxSentences ?? 2} sentences. Return only the summary.`;
    const summary = await this.#chat(system, request.text);
    return { summary: summary.trim(), confidence: 0.7 };
  }

  async classify(request: ClassifyRequest): Promise<ClassifyResult> {
    const [firstLabel] = request.labels;
    if (firstLabel === undefined) {
      throw new AiError("classify: request.labels must not be empty");
    }
    const system = `Classify the text as exactly one of: ${request.labels.join(", ")}. Reply with only the label.`;
    const raw = (await this.#chat(system, request.text)).trim().toLowerCase();
    const label = request.labels.find((candidate) => candidate.toLowerCase() === raw) ?? firstLabel;
    return { label, confidence: 0.7 };
  }

  async extractBeliefs(request: ExtractBeliefsRequest): Promise<ExtractBeliefsResult> {
    const systemPrompt = `You are an expert natural language analyzer for Orion, an AI Operating System.
Your task is to analyze a user's statement during a conversation and extract structured candidate beliefs about what matters to the user.

RULES:
1. ONLY extract beliefs explicitly stated or directly implied by the user's words.
2. DO NOT invent, assume, or hallucinate beliefs or evidence not present in the input text.
3. Every item in supportingEvidence MUST contain an evidenceText string that is an EXACT, VERBATIM substring of the user's statement text.
4. Categorize beliefs strictly into eligible categories: [values, roles_and_relationships, goals, priorities, constraints, routines].
5. Do NOT extract beliefs for categories not listed in eligible categories.
6. Temporal scope must be one of: [durable, current, bounded, unknown].
7. Assign confidence between 0.0 and 1.0 based on clarity and directness.
8. If the statement expresses no clear personal beliefs, or if the user is speaking strictly about third parties or expressing negations without positive belief, return an empty list of candidates [].

OUTPUT FORMAT:
Return strictly a JSON object with a "candidates" key containing an array of objects:
{
  "candidates": [
    {
      "subject": "short_subject_identifier",
      "claim": "Clear summary claim of the belief",
      "category": "category_name",
      "temporalScope": "durable" | "current" | "bounded" | "unknown",
      "evidenceText": "Top-level evidence snippet from statement",
      "supportingEvidence": [
        {
          "statementEnvelopeId": "target_envelope_id",
          "evidenceText": "VERBATIM text snippet from target statement"
        }
      ],
      "confidence": 0.9
    }
  ]
}`;
    const userPrompt = JSON.stringify(request, null, 2);
    let candidates: any[] = [];
    try {
      const raw = await this.#chat(systemPrompt, userPrompt);
      const cleanJson = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      const parsed = JSON.parse(cleanJson);
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).candidates)) {
        candidates = (parsed as any).candidates;
      }
    } catch {
      candidates = [];
    }
    return {
      candidates,
      inferenceMechanism: `http:${this.modelName}`,
      promptSchemaVersion: "v0.1",
      modelName: this.modelName,
    };
  }

  async #chat(system: string, user: string): Promise<string> {
    const url = `${this.#baseUrl}/chat/completions`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0,
        }),
        // Don't let a stalled connection hang the caller forever.
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new AiError(`AI provider request timed out after ${this.#timeoutMs}ms (${url})`);
      }
      throw error;
    }
    if (!response.ok) {
      throw new AiError(
        `AI provider request failed: ${response.status} ${response.statusText} (${url})`,
      );
    }
    const data = (await response.json()) as ChatResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new AiError("AI provider returned no content");
    }
    return content;
  }
}
