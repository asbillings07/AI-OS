import { describe, it, expect } from "vitest";
import { LogEvents } from "@orion/core";
import { LiveGmailSource, GmailAuthError, type AccessTokenProvider } from "./source.js";

const tokenProvider: AccessTokenProvider = { getAccessToken: async () => "access-token" };

const isList = (url: string): boolean => /\/messages\?/.test(url);
const idOf = (url: string): string | undefined => url.match(/\/messages\/([^?]+)/)?.[1];

function listResponse(ids: string[], nextPageToken?: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({ messages: ids.map((id) => ({ id })), nextPageToken }),
  } as unknown as Response;
}

function messageResponse(id: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({ id, threadId: "t", snippet: "", payload: { headers: [] } }),
  } as unknown as Response;
}

function errorResponse(
  status: number,
  opts: { reason?: string; retryAfter?: string | number } = {},
): Response {
  const headers = new Headers();
  if (opts.retryAfter !== undefined) headers.set("retry-after", String(opts.retryAfter));
  const body = opts.reason ? { error: { errors: [{ reason: opts.reason }] } } : {};
  return {
    ok: false,
    status,
    statusText: "ERR",
    headers,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/** An OK response whose body read (json) fails the first `failTimes` times. */
function flakyBodyResponse(id: string, failTimes: number, error: () => Error): { next: () => Response } {
  let calls = 0;
  return {
    next: () => {
      calls += 1;
      const shouldFail = calls <= failTimes;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: async () => {
          if (shouldFail) throw error();
          return { id, threadId: "t", snippet: "", payload: { headers: [] } };
        },
      } as unknown as Response;
    },
  };
}

interface Harness {
  source: LiveGmailSource;
  sleeps: number[];
  traces: Array<{ event: string; fields: Record<string, unknown> }>;
}

function makeSource(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof LiveGmailSource>[0]> = {},
): Harness {
  const sleeps: number[] = [];
  const traces: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const source = new LiveGmailSource({
    tokenProvider,
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    randomImpl: () => 0.5,
    onTrace: (event, fields) => traces.push({ event, fields }),
    ...overrides,
  });
  return { source, sleeps, traces };
}

const drops = (h: Harness) => h.traces.filter((t) => t.event === LogEvents.GmailMessageDropped);
const retries = (h: Harness) => h.traces.filter((t) => t.event === LogEvents.GmailRequestRetried);

describe("LiveGmailSource", () => {
  it("lists then hydrates each message with the bearer token, in list order", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer access-token");
      return isList(url) ? listResponse(["m1", "m2"]) : messageResponse(idOf(url)!);
    }) as unknown as typeof fetch;

    const { source } = makeSource(fetchImpl);
    const messages = await source.fetchMessages();
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(calls[0]).toContain("in%3Ainbox");
  });

  it("paginates via nextPageToken, dedups, and stops at maxMessages", async () => {
    const listCalls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) {
        listCalls.push(url);
        return listCalls.length === 1
          ? listResponse(["m1", "m2"], "page-2")
          : listResponse(["m2", "m3", "m4"], "page-3");
      }
      return messageResponse(idOf(url)!);
    }) as unknown as typeof fetch;

    const { source } = makeSource(fetchImpl, { maxMessages: 3, pageSize: 2 });
    const messages = await source.fetchMessages();
    // m2 appears on both pages but hydrates once; capped at 3, in first-seen order.
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(listCalls[0]).toContain("maxResults=2");
    // Second page only needs one more to reach the cap of 3.
    expect(listCalls[1]).toContain("maxResults=1");
  });

  it("fails the list stage on a repeated pageToken", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1"], "stuck");
      return messageResponse(idOf(url)!);
    }) as unknown as typeof fetch;

    const { source } = makeSource(fetchImpl, { maxMessages: 100 });
    await expect(source.fetchMessages()).rejects.toThrow(/repeated pageToken/);
  });

  it("retries a 429 then succeeds, honoring the jittered delay", async () => {
    let attempts = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1"]);
      attempts += 1;
      return attempts === 1 ? errorResponse(429) : messageResponse("m1");
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl, { baseRetryDelayMs: 500 });
    const messages = await h.source.fetchMessages();
    expect(messages.map((m) => m.id)).toEqual(["m1"]);
    expect(h.sleeps).toEqual([250]); // 0.5 * 500
    expect(retries(h)[0]!.fields).toMatchObject({ status: 429, operation: "message", attempt: 1 });
  });

  it("retries a 503 then succeeds", async () => {
    let attempts = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1"]);
      attempts += 1;
      return attempts === 1 ? errorResponse(503) : messageResponse("m1");
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl);
    expect((await h.source.fetchMessages()).map((m) => m.id)).toEqual(["m1"]);
    expect(retries(h)[0]!.fields).toMatchObject({ status: 503 });
  });

  it("honors a numeric Retry-After over the jitter delay", async () => {
    let attempts = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1"]);
      attempts += 1;
      return attempts === 1 ? errorResponse(429, { retryAfter: 2 }) : messageResponse("m1");
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl, { baseRetryDelayMs: 500 });
    await h.source.fetchMessages();
    expect(h.sleeps).toEqual([2000]); // max(250, 2000)
  });

  it("honors an HTTP-date Retry-After", async () => {
    let attempts = 0;
    const when = new Date(Date.now() + 3000).toUTCString();
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1"]);
      attempts += 1;
      return attempts === 1 ? errorResponse(503, { retryAfter: when }) : messageResponse("m1");
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl, { baseRetryDelayMs: 500 });
    await h.source.fetchMessages();
    expect(h.sleeps).toHaveLength(1);
    expect(h.sleeps[0]).toBeGreaterThan(2000);
    expect(h.sleeps[0]).toBeLessThanOrEqual(3000);
  });

  it("retries a rate-limited 403 but not a permission 403", async () => {
    let rateLimited = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["ok-msg", "denied"]);
      const id = idOf(url)!;
      if (id === "denied") return errorResponse(403, { reason: "insufficientPermissions" });
      rateLimited += 1;
      return rateLimited === 1
        ? errorResponse(403, { reason: "userRateLimitExceeded" })
        : messageResponse("ok-msg");
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl);
    const messages = await h.source.fetchMessages();
    expect(messages.map((m) => m.id)).toEqual(["ok-msg"]);
    expect(drops(h)).toHaveLength(1);
    expect(drops(h)[0]!.fields).toMatchObject({ messageId: "denied", reason: "insufficientPermissions" });
    expect(retries(h)[0]!.fields).toMatchObject({ status: 403, reason: "userRateLimitExceeded" });
  });

  it("retries a network rejection then succeeds", async () => {
    let attempts = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1"]);
      attempts += 1;
      if (attempts === 1) throw new Error("ECONNRESET");
      return messageResponse("m1");
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl);
    expect((await h.source.fetchMessages()).map((m) => m.id)).toEqual(["m1"]);
    expect(retries(h)[0]!.fields).toMatchObject({ reason: "network", status: 0 });
  });

  it("never retries or sleeps on a 401 and returns no partial result", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1", "m2"]);
      return idOf(url) === "m1" ? errorResponse(401) : messageResponse("m2");
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl);
    await expect(h.source.fetchMessages()).rejects.toThrow(GmailAuthError);
    expect(h.sleeps).toHaveLength(0);
  });

  it("keeps peak in-flight hydration within the concurrency limit", async () => {
    let current = 0;
    let peak = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1", "m2", "m3", "m4", "m5", "m6"]);
      current += 1;
      peak = Math.max(peak, current);
      await new Promise((resolve) => setTimeout(resolve, 5));
      current -= 1;
      return messageResponse(idOf(url)!);
    }) as unknown as typeof fetch;

    const { source } = makeSource(fetchImpl, { hydrationConcurrency: 2, maxMessages: 6 });
    const messages = await source.fetchMessages();
    expect(messages).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("returns results in list order despite out-of-order completion", async () => {
    const delays: Record<string, number> = { m1: 20, m2: 10, m3: 0 };
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1", "m2", "m3"]);
      const id = idOf(url)!;
      await new Promise((resolve) => setTimeout(resolve, delays[id]));
      return messageResponse(id);
    }) as unknown as typeof fetch;

    const { source } = makeSource(fetchImpl);
    const messages = await source.fetchMessages();
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("drops a message that stays failing after maxAttempts and keeps the rest", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1", "m2", "m3"]);
      const id = idOf(url)!;
      return id === "m2" ? errorResponse(500) : messageResponse(id);
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl, { maxAttempts: 2 });
    const messages = await h.source.fetchMessages();
    expect(messages.map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(drops(h)).toHaveLength(1);
    expect(drops(h)[0]!.fields).toMatchObject({ messageId: "m2", attempts: 2, status: 500 });
  });

  it("drops every message when all hydrations fail (sync health -> not ok)", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      return isList(url) ? listResponse(["m1", "m2"]) : errorResponse(404);
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl);
    expect(await h.source.fetchMessages()).toEqual([]);
    expect(drops(h)).toHaveLength(2);
  });

  it("returns empty (and drops nothing) for an empty inbox", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      return isList(url) ? listResponse([]) : messageResponse(idOf(url)!);
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl);
    expect(await h.source.fetchMessages()).toEqual([]);
    expect(drops(h)).toHaveLength(0);
  });

  it("rejects the whole sync when list retries are exhausted", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return errorResponse(503);
      return messageResponse(idOf(url)!);
    }) as unknown as typeof fetch;

    const { source } = makeSource(fetchImpl, { maxAttempts: 2 });
    await expect(source.fetchMessages()).rejects.toThrow(/503/);
  });

  it("maps an exhausted timeout on the list stage to a timeout error", async () => {
    const fetchImpl = (async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof fetch;

    const { source } = makeSource(fetchImpl, { maxAttempts: 2, timeoutMs: 10 });
    await expect(source.fetchMessages()).rejects.toThrow(/timed out/);
  });

  it("bounds a systemic hydration outage with the overall time budget", async () => {
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1", "m2", "m3"]);
      // Hang until the overall deadline aborts the request.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl, { maxSyncDurationMs: 30 });
    const messages = await h.source.fetchMessages();
    expect(messages).toEqual([]);
    expect(drops(h)).toHaveLength(3);
  });

  it("produces a deterministic jittered delay sequence", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      return isList(url) ? listResponse(["m1"]) : errorResponse(500);
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl, { maxAttempts: 4, baseRetryDelayMs: 100 });
    await h.source.fetchMessages();
    // window doubles each attempt; full jitter = 0.5 * window.
    expect(h.sleeps).toEqual([50, 100, 200]);
  });

  it("does not let a throwing onTrace change results", async () => {
    let attempts = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1", "m2"]);
      const id = idOf(url)!;
      if (id === "m2") return errorResponse(404);
      attempts += 1;
      return attempts === 1 ? errorResponse(429) : messageResponse("m1");
    }) as unknown as typeof fetch;

    const source = new LiveGmailSource({
      tokenProvider,
      fetchImpl,
      sleepImpl: async () => {},
      randomImpl: () => 0.5,
      onTrace: () => {
        throw new Error("tracer blew up");
      },
    });
    const messages = await source.fetchMessages();
    expect(messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("validates configuration at construction", () => {
    expect(() => new LiveGmailSource({ tokenProvider, pageSize: 0 })).toThrow(/pageSize/);
    expect(() => new LiveGmailSource({ tokenProvider, pageSize: 501 })).toThrow(/pageSize/);
    expect(() => new LiveGmailSource({ tokenProvider, maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(() => new LiveGmailSource({ tokenProvider, hydrationConcurrency: 0 })).toThrow(
      /hydrationConcurrency/,
    );
    expect(() => new LiveGmailSource({ tokenProvider, maxMessages: -1 })).toThrow(/maxMessages/);
    expect(() => new LiveGmailSource({ tokenProvider, timeoutMs: -1 })).toThrow(/timeoutMs/);
  });

  it("retries a hydration body-read failure then succeeds", async () => {
    const flaky = flakyBodyResponse("m1", 1, () => new Error("socket hang up"));
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      return isList(url) ? listResponse(["m1"]) : flaky.next();
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl);
    expect((await h.source.fetchMessages()).map((m) => m.id)).toEqual(["m1"]);
    expect(retries(h)[0]!.fields).toMatchObject({ operation: "message", reason: "network" });
  });

  it("retries a list body-read failure then succeeds", async () => {
    let listCalls = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) {
        listCalls += 1;
        if (listCalls === 1) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: new Headers(),
            json: async () => {
              throw new Error("ECONNRESET");
            },
          } as unknown as Response;
        }
        return listResponse(["m1"]);
      }
      return messageResponse(idOf(url)!);
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl);
    expect((await h.source.fetchMessages()).map((m) => m.id)).toEqual(["m1"]);
    expect(retries(h)[0]!.fields).toMatchObject({ operation: "list", reason: "network" });
  });

  it("treats a malformed OK body as non-retryable and drops the message", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) return listResponse(["m1"]);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const h = makeSource(fetchImpl);
    expect(await h.source.fetchMessages()).toEqual([]);
    expect(h.sleeps).toHaveLength(0); // never retried
    expect(drops(h)[0]!.fields).toMatchObject({ messageId: "m1", reason: "malformed_body", attempts: 1 });
  });

  it("settles within the budget when the token provider never resolves", async () => {
    const neverResolves: AccessTokenProvider = {
      getAccessToken: () => new Promise<string>(() => {}),
    };
    const source = new LiveGmailSource({
      tokenProvider: neverResolves,
      fetchImpl: (async () => listResponse([])) as unknown as typeof fetch,
      maxSyncDurationMs: 30,
      sleepImpl: async () => {},
    });

    const start = Date.now();
    await expect(source.fetchMessages()).rejects.toThrow(/aborted by sync budget/);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("allows sparse pages up to a conservative ceiling (four one-message pages)", async () => {
    let listCalls = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (isList(url)) {
        listCalls += 1;
        if (listCalls === 1) return listResponse(["m1"], "p2");
        if (listCalls === 2) return listResponse(["m2"], "p3");
        if (listCalls === 3) return listResponse(["m3"], "p4");
        return listResponse(["m4"]);
      }
      return messageResponse(idOf(url)!);
    }) as unknown as typeof fetch;

    const { source } = makeSource(fetchImpl, { maxMessages: 100, pageSize: 100 });
    const messages = await source.fetchMessages();
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });
});
