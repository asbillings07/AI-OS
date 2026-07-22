import { describe, it, expect, vi } from "vitest";
import { LiveGmailSource, GmailAuthError, type AccessTokenProvider } from "./source.js";

const tokenProvider: AccessTokenProvider = { getAccessToken: async () => "access-token" };

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

describe("LiveGmailSource", () => {
  it("lists then hydrates each message with the bearer token", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer access-token");
      if (url.includes("/messages?")) return jsonResponse({ messages: [{ id: "m1" }, { id: "m2" }] });
      return jsonResponse({ id: url.includes("m1") ? "m1" : "m2", threadId: "t", snippet: "", payload: { headers: [] } });
    }) as unknown as typeof fetch;

    const source = new LiveGmailSource({ tokenProvider, fetchImpl });
    const messages = await source.fetchMessages();
    expect(messages.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    expect(calls[0]).toContain("in%3Ainbox");
  });

  it("raises GmailAuthError on a 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { ok: false, status: 401 })) as unknown as typeof fetch;
    const source = new LiveGmailSource({ tokenProvider, fetchImpl });
    await expect(source.fetchMessages()).rejects.toThrow(GmailAuthError);
  });

  it("does NOT treat a 403 as an auth failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { ok: false, status: 403 })) as unknown as typeof fetch;
    const source = new LiveGmailSource({ tokenProvider, fetchImpl });
    const error = await source.fetchMessages().catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GmailAuthError);
  });

  it("maps an aborted (timed-out) request to a timeout error", async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof fetch;
    const source = new LiveGmailSource({ tokenProvider, fetchImpl, timeoutMs: 10 });
    await expect(source.fetchMessages()).rejects.toThrow(/timed out/);
  });
});
