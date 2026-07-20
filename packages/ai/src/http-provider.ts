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
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;

  constructor(options: HttpAiProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.#model = options.model ?? "gpt-4o-mini";
  }

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const system = `You summarize ${request.purpose ?? "text"} in at most ${request.maxSentences ?? 2} sentences. Return only the summary.`;
    const summary = await this.#chat(system, request.text);
    return { summary: summary.trim(), confidence: 0.7 };
  }

  async classify(request: ClassifyRequest): Promise<ClassifyResult> {
    const system = `Classify the text as exactly one of: ${request.labels.join(", ")}. Reply with only the label.`;
    const raw = (await this.#chat(system, request.text)).trim().toLowerCase();
    const label = request.labels.find((candidate) => candidate.toLowerCase() === raw) ?? request.labels[0] ?? "";
    return { label, confidence: 0.7 };
  }

  async #chat(system: string, user: string): Promise<string> {
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.#model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
      }),
    });
    if (!response.ok) {
      throw new AiError(`AI provider request failed: ${response.status}`);
    }
    const data = (await response.json()) as ChatResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new AiError("AI provider returned no content");
    }
    return content;
  }
}
