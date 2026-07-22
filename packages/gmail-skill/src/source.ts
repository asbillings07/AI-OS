import { LogEvents } from "@orion/core";
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

/**
 * A non-auth request failure carrying just enough structured metadata for a
 * drop trace: the HTTP status (0 for network/timeout/deadline), the classified
 * reason, and how many attempts were made. Never carries the response body.
 */
export class GmailRequestError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly attempts: number;

  constructor(
    message: string,
    meta: { status: number; reason: string; attempts: number },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GmailRequestError";
    this.status = meta.status;
    this.reason = meta.reason;
    this.attempts = meta.attempts;
  }
}

/** A framework-free trace sink. Must never be relied on for control flow. */
export type GmailTrace = (event: string, fields: Record<string, unknown>) => void;

export interface LiveGmailSourceOptions {
  /** Where each request's bearer token comes from (refreshed elsewhere). */
  tokenProvider: AccessTokenProvider;
  /** Gmail search query, e.g. "in:inbox newer_than:7d". */
  query?: string;
  /** Total messages to ingest across all pages. Default 100. */
  maxMessages?: number;
  /** Gmail `maxResults` per list page (1..500). Default 100, not the max. */
  pageSize?: number;
  /** Concurrent message-hydration requests. Default 5. */
  hydrationConcurrency?: number;
  /** Total attempts per request, INCLUDING the initial one. Default 3. */
  maxAttempts?: number;
  /** Base for exponential full-jitter backoff (ms). Default 500. */
  baseRetryDelayMs?: number;
  /** Per-request timeout (ms), bounded further by the remaining budget. Default 15s. */
  timeoutMs?: number;
  /** Overall budget for the whole sync (ms). Aborts in-flight fetches. Default 30s. */
  maxSyncDurationMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable sleep so backoff is instant in tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable [0,1) source so jitter is deterministic in tests. */
  randomImpl?: () => number;
  /** Structured trace sink (default no-op); wrapped so throwing can't break ingestion. */
  onTrace?: GmailTrace;
}

interface GmailListResponse {
  messages?: Array<{ id: string }>;
  nextPageToken?: string;
}

interface RequestContext {
  readonly operation: "list" | "message";
  readonly deadlineAt: number;
  readonly deadlineSignal: AbortSignal;
}

const MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
/** Cap a single backoff window so a large `maxAttempts` can't compute an absurd delay. */
const MAX_BACKOFF_MS = 20_000;

function assertInteger(name: string, value: number, min: number, max?: number): void {
  const bound = max === undefined ? `>= ${min}` : `in [${min}, ${max}]`;
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new RangeError(`${name} must be an integer ${bound} (got ${value})`);
  }
}

function assertNonNegativeFinite(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0 (got ${value})`);
  }
}

/**
 * The live source (ADR-0010: Skills own their adapters). Talks to the Gmail REST
 * API via fetch — no SDK, so no vendor types leak past this file.
 *
 * Hardened for sustained dogfooding: it paginates the message list, hydrates with
 * a bounded, order-preserving concurrency pool, retries transient failures
 * (429/5xx/rate-limit-403/network/timeout) with full-jitter backoff that honors
 * `Retry-After`, and drops individual messages best-effort so one flaky message
 * never blanks the dashboard. The whole sync is bounded by an overall time budget
 * whose deadline aborts real in-flight fetches — so a Gmail outage can never hang
 * a render. Auth is unchanged: only a 401 becomes `GmailAuthError` (reconnect);
 * a 401 rejects the whole op and no partial result is returned after it.
 */
export class LiveGmailSource implements GmailSource {
  readonly name = "gmail-live";
  readonly #tokenProvider: AccessTokenProvider;
  readonly #query: string;
  readonly #maxMessages: number;
  readonly #pageSize: number;
  readonly #hydrationConcurrency: number;
  readonly #maxAttempts: number;
  readonly #baseRetryDelayMs: number;
  readonly #timeoutMs: number;
  readonly #maxSyncDurationMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #onTrace: GmailTrace;
  readonly #maxPages: number;

  constructor(options: LiveGmailSourceOptions) {
    this.#tokenProvider = options.tokenProvider;
    this.#query = options.query ?? "in:inbox newer_than:7d";
    this.#maxMessages = options.maxMessages ?? 100;
    this.#pageSize = options.pageSize ?? 100;
    this.#hydrationConcurrency = options.hydrationConcurrency ?? 5;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxSyncDurationMs = options.maxSyncDurationMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = options.randomImpl ?? Math.random;
    this.#onTrace = options.onTrace ?? (() => {});

    assertInteger("maxMessages", this.#maxMessages, 0);
    assertInteger("pageSize", this.#pageSize, 1, 500);
    assertInteger("hydrationConcurrency", this.#hydrationConcurrency, 1);
    assertInteger("maxAttempts", this.#maxAttempts, 1);
    assertNonNegativeFinite("baseRetryDelayMs", this.#baseRetryDelayMs);
    assertNonNegativeFinite("timeoutMs", this.#timeoutMs);
    assertNonNegativeFinite("maxSyncDurationMs", this.#maxSyncDurationMs);

    // Defensive page ceiling: enough pages to reach maxMessages even if pages come
    // back short, but bounded so a server emitting endless distinct tokens can't loop.
    this.#maxPages = Math.ceil(this.#maxMessages / this.#pageSize) * 2 + 1;
  }

  async fetchMessages(): Promise<RawGmailMessage[]> {
    if (this.#maxMessages === 0) return [];
    // One token per sync; the provider refreshes it as needed and caches it.
    const token = await this.#tokenProvider.getAccessToken();

    // The overall deadline aborts real in-flight fetches (not a Promise.race that
    // leaves requests running). Each attempt further caps its own timeout by the
    // remaining budget below.
    const deadline = new AbortController();
    const deadlineAt = Date.now() + this.#maxSyncDurationMs;
    const timer = setTimeout(
      () => deadline.abort(new Error("Gmail sync time budget exhausted")),
      this.#maxSyncDurationMs,
    );
    (timer as { unref?: () => void }).unref?.();

    try {
      const ids = await this.#listIds(token, deadlineAt, deadline.signal);
      return await this.#hydrate(ids, token, deadlineAt, deadline.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Page the list endpoint until `maxMessages` is collected or there is no next
   * page. Ids are deduped across pages preserving first-seen order. A repeated
   * page token or exceeding the max page count is a list-stage failure — as is
   * running out of budget: without ids we can't proceed, so the sync fails and
   * self-heals on the next render.
   */
  async #listIds(token: string, deadlineAt: number, deadlineSignal: AbortSignal): Promise<string[]> {
    const collected: string[] = [];
    const seenIds = new Set<string>();
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    let pages = 0;

    while (collected.length < this.#maxMessages) {
      if (this.#remaining(deadlineAt) <= 0) {
        throw new Error("Gmail list stage exceeded the sync time budget");
      }
      if (pages >= this.#maxPages) {
        throw new Error(`Gmail list stage exceeded the max page count (${this.#maxPages})`);
      }

      const remainingCap = this.#maxMessages - collected.length;
      const params = new URLSearchParams({
        q: this.#query,
        maxResults: String(Math.min(this.#pageSize, remainingCap)),
      });
      if (pageToken) params.set("pageToken", pageToken);

      const page = await this.#request<GmailListResponse>(`${MESSAGES_URL}?${params.toString()}`, token, {
        operation: "list",
        deadlineAt,
        deadlineSignal,
      });

      for (const message of page.messages ?? []) {
        if (!seenIds.has(message.id)) {
          seenIds.add(message.id);
          collected.push(message.id);
          if (collected.length >= this.#maxMessages) break;
        }
      }

      pages += 1;
      const next = page.nextPageToken;
      if (!next) break;
      if (seenTokens.has(next)) {
        throw new Error("Gmail list returned a repeated pageToken");
      }
      seenTokens.add(next);
      pageToken = next;
    }

    return collected;
  }

  /**
   * Hydrate ids with a bounded pool. Successes are written at their original list
   * index so the returned order matches the Gmail list order regardless of
   * completion order — keeping event append order deterministic. A 401 rejects
   * the whole operation and stops scheduling new work (no partial result is
   * returned after a 401); any other per-item failure is dropped and traced once.
   * Once the budget is spent, unfinished ids are dropped rather than scheduled.
   */
  async #hydrate(
    ids: string[],
    token: string,
    deadlineAt: number,
    deadlineSignal: AbortSignal,
  ): Promise<RawGmailMessage[]> {
    const results: (RawGmailMessage | undefined)[] = new Array(ids.length);
    let nextIndex = 0;
    let authError: GmailAuthError | null = null;

    const worker = async (): Promise<void> => {
      while (true) {
        if (authError) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= ids.length) return;
        const id = ids[index];

        if (this.#remaining(deadlineAt) <= 0) {
          this.#trace(LogEvents.GmailMessageDropped, {
            messageId: id,
            attempts: 0,
            status: 0,
            reason: "sync_budget_exhausted",
          });
          continue;
        }

        try {
          results[index] = await this.#request<RawGmailMessage>(
            `${MESSAGES_URL}/${id}?format=full`,
            token,
            { operation: "message", deadlineAt, deadlineSignal },
          );
        } catch (error) {
          if (error instanceof GmailAuthError) {
            authError = error;
            return;
          }
          const failure =
            error instanceof GmailRequestError
              ? error
              : new GmailRequestError(String(error), { status: 0, reason: "error", attempts: 1 });
          this.#trace(LogEvents.GmailMessageDropped, {
            messageId: id,
            attempts: failure.attempts,
            status: failure.status,
            reason: failure.reason,
          });
        }
      }
    };

    const workerCount = Math.min(this.#hydrationConcurrency, ids.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // A 401 anywhere is fatal: never return a partial result after auth failed.
    if (authError) throw authError;
    return results.filter((message): message is RawGmailMessage => message !== undefined);
  }

  /**
   * One request with retry/backoff. Classification lives entirely here: a 401 is
   * a fatal `GmailAuthError`; 429/5xx/rate-limit-403/network/timeout are retried
   * up to `maxAttempts` (total, including the first) with full-jitter backoff,
   * `delay = max(jitter, Retry-After)`; the deadline aborts the underlying fetch.
   */
  async #request<T>(url: string, token: string, ctx: RequestContext): Promise<T> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      const remaining = this.#remaining(ctx.deadlineAt);
      if (remaining <= 0) {
        throw new GmailRequestError(`Gmail ${ctx.operation} request ran out of budget (${url})`, {
          status: 0,
          reason: "deadline",
          attempts: attempt - 1,
        });
      }

      let response: Response;
      try {
        response = await this.#fetch(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.any([ctx.deadlineSignal, AbortSignal.timeout(Math.min(this.#timeoutMs, remaining))]),
        });
      } catch (error) {
        // The deadline is fatal for this request; a per-attempt timeout or network
        // error is transient and eligible for retry.
        if (ctx.deadlineSignal.aborted) {
          throw new GmailRequestError(`Gmail ${ctx.operation} request aborted by sync budget (${url})`, {
            status: 0,
            reason: "deadline",
            attempts: attempt,
          });
        }
        const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
        const delayMs = this.#nextDelay(attempt, ctx.deadlineAt, 0);
        if (delayMs === null) {
          const label = reason === "timeout" ? "timed out" : "network error";
          throw new GmailRequestError(
            `Gmail ${ctx.operation} request ${label} after ${attempt} attempt(s) (${url})`,
            { status: 0, reason, attempts: attempt },
            { cause: error },
          );
        }
        this.#traceRetry(ctx, attempt, 0, reason, delayMs);
        await this.#sleep(delayMs);
        continue;
      }

      if (response.ok) return (await response.json()) as T;

      if (response.status === 401) {
        throw new GmailAuthError(`Gmail API authentication failed (401) (${url})`);
      }

      const reason = await this.#reasonFrom(response);
      if (!this.#isRetryable(response.status, reason)) {
        throw new GmailRequestError(
          `Gmail API request failed: ${response.status} ${response.statusText} (${url})`,
          { status: response.status, reason: reason ?? "http_error", attempts: attempt },
        );
      }

      const retryAfterMs = parseRetryAfter(response.headers);
      const delayMs = this.#nextDelay(attempt, ctx.deadlineAt, retryAfterMs);
      if (delayMs === null) {
        throw new GmailRequestError(
          `Gmail API request failed after ${attempt} attempt(s): ${response.status} (${url})`,
          { status: response.status, reason: reason ?? "http_error", attempts: attempt },
        );
      }
      this.#traceRetry(ctx, attempt, response.status, reason ?? "http_error", delayMs);
      await this.#sleep(delayMs);
    }
  }

  /**
   * The delay before the next attempt, or null when we must stop: either the
   * attempt budget is spent, or the wait would exceed the remaining time budget.
   */
  #nextDelay(attempt: number, deadlineAt: number, retryAfterMs: number): number | null {
    if (attempt >= this.#maxAttempts) return null;
    const window = Math.min(MAX_BACKOFF_MS, this.#baseRetryDelayMs * 2 ** (attempt - 1));
    const jitter = this.#random() * window;
    const delayMs = Math.max(jitter, retryAfterMs);
    // Don't begin another retry (or honor a long Retry-After) beyond the budget.
    if (delayMs >= this.#remaining(deadlineAt)) return null;
    return delayMs;
  }

  #traceRetry(ctx: RequestContext, attempt: number, status: number, reason: string, delayMs: number): void {
    this.#trace(LogEvents.GmailRequestRetried, {
      operation: ctx.operation,
      attempt,
      maxAttempts: this.#maxAttempts,
      status,
      reason,
      delayMs,
    });
  }

  #trace(event: string, fields: Record<string, unknown>): void {
    try {
      this.#onTrace(event, fields);
    } catch {
      // A tracer must never break the ingestion it observes.
    }
  }

  #remaining(deadlineAt: number): number {
    return deadlineAt - Date.now();
  }

  #isRetryable(status: number, reason: string | undefined): boolean {
    if (RETRYABLE_STATUSES.has(status)) return true;
    if (status === 403 && reason !== undefined && RATE_LIMIT_REASONS.has(reason)) return true;
    return false;
  }

  /**
   * Pull Google's error reason from the response body, tolerating malformed or
   * non-JSON bodies (returns undefined rather than throwing). Never surfaces the
   * body itself. Shape: `{ error: { errors: [{ reason }], status } }`.
   */
  async #reasonFrom(response: Response): Promise<string | undefined> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return undefined;
    }
    const error = (body as { error?: unknown })?.error as
      | { errors?: Array<{ reason?: unknown }>; status?: unknown }
      | undefined;
    if (error && Array.isArray(error.errors)) {
      const match = error.errors.find((entry) => typeof entry?.reason === "string");
      if (match && typeof match.reason === "string") return match.reason;
    }
    if (typeof error?.status === "string") return error.status;
    return undefined;
  }
}

/**
 * Parse `Retry-After` into ms. RFC 9110 permits either delta-seconds or an
 * HTTP-date; support both. Returns 0 for anything unparseable so it never
 * outweighs the jitter delay.
 */
function parseRetryAfter(headers: Headers | undefined): number {
  const raw = headers?.get?.("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 0;
}
