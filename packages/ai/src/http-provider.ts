import {
  AiError,
  type AiProvider,
  type ClassifyRequest,
  type ClassifyResult,
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
