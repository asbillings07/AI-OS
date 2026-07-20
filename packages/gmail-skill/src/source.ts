import { gmailMessages, type RawGmailMessage } from "@orion/fixtures";

/**
 * Where raw Gmail messages come from. The Skill depends on this seam, not on
 * Gmail itself, so fixtures and live OAuth are interchangeable (ADR-0010: a
 * Skill owns its adapters). Fixtures-first keeps runs offline and replayable
 * (ADR-0009), but the seam itself is a Skill-architecture boundary.
 */
export interface GmailSource {
  readonly name: string;
  fetchMessages(): Promise<RawGmailMessage[]>;
}

/** The default, offline source: captured fixtures. No network, no keys. */
export class FixtureGmailSource implements GmailSource {
  readonly name = "gmail-fixtures";
  readonly #messages: RawGmailMessage[];

  constructor(messages: RawGmailMessage[] = gmailMessages) {
    this.#messages = messages;
  }

  async fetchMessages(): Promise<RawGmailMessage[]> {
    return this.#messages;
  }
}

export interface LiveGmailSourceOptions {
  /** A valid OAuth 2.0 access token with gmail.readonly scope. */
  accessToken: string;
  /** Gmail search query, e.g. "in:inbox newer_than:7d". */
  query?: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}

interface GmailListResponse {
  messages?: Array<{ id: string }>;
}

/**
 * The live source (ADR-0010: Skills own their own credentials). Talks to the
 * Gmail REST API via fetch — no SDK, so no vendor types leak past this file.
 * Not exercised by the offline slice or tests; it exists to prove that swapping
 * fixtures for real Gmail is a localized change behind the same interface.
 */
export class LiveGmailSource implements GmailSource {
  readonly name = "gmail-live";
  readonly #options: LiveGmailSourceOptions;
  readonly #fetch: typeof fetch;

  constructor(options: LiveGmailSourceOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async fetchMessages(): Promise<RawGmailMessage[]> {
    const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
    const params = new URLSearchParams({
      q: this.#options.query ?? "in:inbox newer_than:7d",
      maxResults: String(this.#options.maxResults ?? 25),
    });
    const list = await this.#json<GmailListResponse>(`${base}?${params.toString()}`);
    const ids = (list.messages ?? []).map((message) => message.id);
    return Promise.all(ids.map((id) => this.#json<RawGmailMessage>(`${base}/${id}?format=full`)));
  }

  async #json<T>(url: string): Promise<T> {
    const response = await this.#fetch(url, {
      headers: { authorization: `Bearer ${this.#options.accessToken}` },
    });
    if (!response.ok) {
      // Include status text and the URL so OAuth/query failures are actionable.
      throw new Error(
        `Gmail API request failed: ${response.status} ${response.statusText} (${url})`,
      );
    }
    return response.json() as Promise<T>;
  }
}
