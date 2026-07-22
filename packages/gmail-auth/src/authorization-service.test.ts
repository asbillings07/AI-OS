import { describe, it, expect, vi } from "vitest";
import type { OAuth2Client, Credentials } from "google-auth-library";
import {
  GoogleAuthorizationService,
  GMAIL_READONLY_SCOPE,
  ReconnectRequiredError,
  CallbackRejectedError,
  AccountMismatchError,
} from "./authorization-service.js";
import { InMemoryCredentialStore } from "./in-memory-credential-store.js";
import type { StoredCredential } from "./credential-store.js";
import type { GmailLiveConfig } from "./config.js";

const config: GmailLiveConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "http://localhost:3000/api/gmail/callback",
  account: "me@example.com",
  encryptionKey: "unused-when-store-injected",
  credentialsDbPath: "unused-when-store-injected",
};

interface FakeOptions {
  tokens?: Credentials;
  invalidGrant?: boolean;
  transient?: boolean;
  rotateTo?: string;
  accessToken?: string;
}

function fakeClient(options: FakeOptions = {}) {
  const listeners = new Map<string, ((c: Credentials) => void)[]>();
  const client = {
    generateAuthUrl: vi.fn(
      (opts: { state?: string }) => `https://accounts.google.com/auth?state=${opts.state ?? ""}`,
    ),
    getToken: vi.fn(async () => ({
      tokens:
        options.tokens ??
        ({ refresh_token: "rt-initial", access_token: "at-initial", scope: GMAIL_READONLY_SCOPE } as Credentials),
    })),
    setCredentials: vi.fn(),
    on: vi.fn((event: string, cb: (c: Credentials) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return client;
    }),
    getAccessToken: vi.fn(async () => {
      if (options.invalidGrant) {
        const error = new Error("invalid_grant") as Error & { response?: unknown };
        error.response = { data: { error: "invalid_grant" } };
        throw error;
      }
      if (options.transient) throw new Error("ETIMEDOUT: transient network error");
      if (options.rotateTo) {
        for (const cb of listeners.get("tokens") ?? []) cb({ refresh_token: options.rotateTo });
      }
      return { token: options.accessToken ?? "fresh-access-token" };
    }),
    revokeToken: vi.fn(async () => ({})),
  };
  return client;
}

function serviceWith(
  client: ReturnType<typeof fakeClient>,
  store = new InMemoryCredentialStore(),
  profileEmail = "me@example.com",
  profileOk = true,
) {
  const fetchImpl = vi.fn(async () => ({
    ok: profileOk,
    status: profileOk ? 200 : 403,
    json: async () => ({ emailAddress: profileEmail }),
  })) as unknown as typeof fetch;
  const service = new GoogleAuthorizationService({
    store,
    config,
    clientFactory: () => client as unknown as OAuth2Client,
    fetchImpl,
  });
  return { service, store, client };
}

const activeCredential: StoredCredential = {
  account: "me@example.com",
  refreshToken: "rt-existing",
  status: "active",
  updatedAt: "2026-07-21T09:00:00.000Z",
};

describe("GoogleAuthorizationService.authorizationUrl", () => {
  it("requests offline access with the readonly scope and carries the state", () => {
    const client = fakeClient();
    const { service } = serviceWith(client);
    const url = service.authorizationUrl("state-123");
    expect(url).toContain("state=state-123");
    expect(client.generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        access_type: "offline",
        prompt: "consent",
        scope: [GMAIL_READONLY_SCOPE],
        state: "state-123",
      }),
    );
  });
});

describe("GoogleAuthorizationService.handleCallback", () => {
  it("stores an active credential on the happy path", async () => {
    const { service, store } = serviceWith(fakeClient());
    const credential = await service.handleCallback("code");
    expect(credential.status).toBe("active");
    expect((await store.read())?.refreshToken).toBe("rt-initial");
  });

  it("rejects when Google returns no refresh token, and revokes", async () => {
    const client = fakeClient({
      tokens: { access_token: "at", scope: GMAIL_READONLY_SCOPE } as Credentials,
    });
    const { service, store } = serviceWith(client);
    await expect(service.handleCallback("code")).rejects.toThrow(CallbackRejectedError);
    expect(client.revokeToken).toHaveBeenCalled();
    expect(await store.read()).toBeNull();
  });

  it("rejects when gmail.readonly was not granted", async () => {
    const client = fakeClient({
      tokens: { refresh_token: "rt", access_token: "at", scope: "" } as Credentials,
    });
    const { service } = serviceWith(client);
    await expect(service.handleCallback("code")).rejects.toThrow(CallbackRejectedError);
    expect(client.revokeToken).toHaveBeenCalled();
  });

  it("rejects an account mismatch and leaves an existing credential unchanged", async () => {
    const store = new InMemoryCredentialStore(activeCredential);
    const { service } = serviceWith(fakeClient(), store, "someone-else@example.com");
    await expect(service.handleCallback("code")).rejects.toThrow(AccountMismatchError);
    expect(await store.read()).toEqual(activeCredential);
  });
});

describe("GoogleAuthorizationService.getAccessToken", () => {
  it("throws ReconnectRequired when no credential is stored", async () => {
    const { service } = serviceWith(fakeClient());
    await expect(service.getAccessToken()).rejects.toThrow(ReconnectRequiredError);
  });

  it("throws ReconnectRequired when the credential is already reconnect_required", async () => {
    const store = new InMemoryCredentialStore({ ...activeCredential, status: "reconnect_required" });
    const client = fakeClient();
    const { service } = serviceWith(client, store);
    await expect(service.getAccessToken()).rejects.toThrow(ReconnectRequiredError);
    expect(client.getAccessToken).not.toHaveBeenCalled();
  });

  it("returns a fresh access token", async () => {
    const store = new InMemoryCredentialStore(activeCredential);
    const { service } = serviceWith(fakeClient(), store);
    expect(await service.getAccessToken()).toBe("fresh-access-token");
  });

  it("marks reconnect_required on invalid_grant", async () => {
    const store = new InMemoryCredentialStore(activeCredential);
    const { service } = serviceWith(fakeClient({ invalidGrant: true }), store);
    await expect(service.getAccessToken()).rejects.toThrow(ReconnectRequiredError);
    expect((await store.read())?.status).toBe("reconnect_required");
  });

  it("does not mark reconnect on a transient error (leaves credential active)", async () => {
    const store = new InMemoryCredentialStore(activeCredential);
    const { service } = serviceWith(fakeClient({ transient: true }), store);
    await expect(service.getAccessToken()).rejects.toThrow(/transient/);
    expect((await store.read())?.status).toBe("active");
  });

  it("persists a rotated refresh token", async () => {
    const store = new InMemoryCredentialStore(activeCredential);
    const { service } = serviceWith(fakeClient({ rotateTo: "rt-rotated" }), store);
    await service.getAccessToken();
    expect((await store.read())?.refreshToken).toBe("rt-rotated");
  });
});

describe("GoogleAuthorizationService lifecycle", () => {
  it("flagReconnectRequired flips a stored credential", async () => {
    const store = new InMemoryCredentialStore(activeCredential);
    const { service } = serviceWith(fakeClient(), store);
    await service.flagReconnectRequired();
    expect((await store.read())?.status).toBe("reconnect_required");
  });

  it("disconnect revokes and deletes", async () => {
    const store = new InMemoryCredentialStore(activeCredential);
    const client = fakeClient();
    const { service } = serviceWith(client, store);
    await service.disconnect();
    expect(client.revokeToken).toHaveBeenCalled();
    expect(await store.read()).toBeNull();
  });

  it("reports integration state across authorization outcomes", async () => {
    const disconnected = serviceWith(fakeClient(), new InMemoryCredentialStore());
    expect(await disconnected.service.integrationState()).toEqual({
      mode: "live",
      auth: "disconnected",
    });

    const connected = serviceWith(fakeClient(), new InMemoryCredentialStore(activeCredential));
    expect(await connected.service.integrationState()).toEqual({
      mode: "live",
      auth: "connected",
      account: "me@example.com",
    });

    const stale = serviceWith(
      fakeClient(),
      new InMemoryCredentialStore({ ...activeCredential, status: "reconnect_required" }),
    );
    expect(await stale.service.integrationState()).toEqual({
      mode: "live",
      auth: "reconnect_required",
      account: "me@example.com",
    });
  });
});
