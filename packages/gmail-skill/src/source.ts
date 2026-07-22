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

/**
 * Supplies a fresh Gmail access token on demand. `LiveGmailSource` depends only
 * on this seam, never on OAuth callbacks, client secrets, or credential storage
 * — those live behind the token provider (see `@orion/gmail-auth`).
 */
export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

/**
 * A genuine authentication failure from Gmail (HTTP 401). Distinct from other
 * failures on purpose: only this warrants flipping the credential to
 * "reconnect required". A 403 (permission/quota) or a timeout is NOT this.
 */
export class GmailAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GmailAuthError";
  }
}

export interface LiveGmailSourceOptions {
  /** Where each request's bearer token comes from (refreshed elsewhere). */
  tokenProvider: AccessTokenProvider;
  /** Gmail search query, e.g. "in:inbox newer_than:7d". */
  query?: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
  /** Abort a request that stalls longer than this (ms). Defaults to 15s. */
  timeoutMs?: number;
}

interface GmailListResponse {
  messages?: Array<{ id: string }>;
}

/**
 * The live source (ADR-0010: Skills own their adapters). Talks to the Gmail REST
 * API via fetch — no SDK, so no vendor types leak past this file. It fetches one
 * page per call; pagination, retries, and rate-limit handling are a later
 * Dogfood slice. A stalled request is aborted so it can never hang a render.
 */
export class LiveGmailSource implements GmailSource {
  readonly name = "gmail-live";
  readonly #options: LiveGmailSourceOptions;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: LiveGmailSourceOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async fetchMessages(): Promise<RawGmailMessage[]> {
    // One token per sync; the provider refreshes it as needed and caches it.
    const token = await this.#options.tokenProvider.getAccessToken();
    const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
    const params = new URLSearchParams({
      q: this.#options.query ?? "in:inbox newer_than:7d",
      maxResults: String(this.#options.maxResults ?? 25),
    });
    const list = await this.#json<GmailListResponse>(`${base}?${params.toString()}`, token);
    const ids = (list.messages ?? []).map((message) => message.id);
    return Promise.all(ids.map((id) => this.#json<RawGmailMessage>(`${base}/${id}?format=full`, token)));
  }

  async #json<T>(url: string, token: string): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`Gmail API request timed out after ${this.#timeoutMs}ms (${url})`);
      }
      throw error;
    }
    if (!response.ok) {
      // Only 401 is an authentication failure. 403 (permission/quota) and other
      // statuses are surfaced as generic errors — never as "reconnect required".
      if (response.status === 401) {
        throw new GmailAuthError(`Gmail API authentication failed (401) (${url})`);
      }
      throw new Error(
        `Gmail API request failed: ${response.status} ${response.statusText} (${url})`,
      );
    }
    return response.json() as Promise<T>;
  }
}
