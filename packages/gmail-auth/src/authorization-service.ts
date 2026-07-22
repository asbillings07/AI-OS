import { OAuth2Client, type Credentials } from "google-auth-library";
import type { AccessTokenProvider } from "@orion/gmail-skill";
import type { CredentialStore, StoredCredential } from "./credential-store.js";
import { CredentialCryptoError } from "./crypto.js";
import type { GmailLiveConfig } from "./config.js";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/**
 * The user must (re)authorize: no credential, a revoked/`invalid_grant` token,
 * or an unrecoverable 401. Never raised for transient network/timeout errors.
 */
export class ReconnectRequiredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReconnectRequiredError";
  }
}

/** The callback did not meet the contract (no refresh token, or scope not granted). */
export class CallbackRejectedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CallbackRejectedError";
  }
}

/** The authorized Google account is not the configured dogfood account. */
export class AccountMismatchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AccountMismatchError";
  }
}

/**
 * The authorization dimension of the integration. Source `mode` is part of the
 * state so the UI never shows "Connect Gmail" while Orion is deliberately on
 * fixtures. Transient sync health is intentionally NOT here (a timeout is not a
 * reconnect); it travels with the sync result instead.
 */
export type GmailIntegrationState =
  | { readonly mode: "fixture" }
  | { readonly mode: "live"; readonly auth: "misconfigured"; readonly issues: readonly string[] }
  | { readonly mode: "live"; readonly auth: "disconnected" }
  | { readonly mode: "live"; readonly auth: "connected"; readonly account: string }
  | { readonly mode: "live"; readonly auth: "reconnect_required"; readonly account: string };

export interface GoogleAuthorizationServiceOptions {
  readonly store: CredentialStore;
  readonly config: GmailLiveConfig;
  /** Injectable for tests: create the OAuth client and fetch the profile. */
  readonly clientFactory?: () => OAuth2Client;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Wraps google-auth-library's `OAuth2Client` behind Orion's seams (ADR-0013).
 * It owns Google's code exchange, credential validation, refresh, and rotation;
 * it does NOT own HTTP cookies or CSRF state (the route does). It implements
 * `AccessTokenProvider` so `LiveGmailSource` depends only on "give me a token,"
 * never on OAuth.
 */
export class GoogleAuthorizationService implements AccessTokenProvider {
  readonly #store: CredentialStore;
  readonly #config: GmailLiveConfig;
  readonly #clientFactory: () => OAuth2Client;
  readonly #fetch: typeof fetch;

  constructor(options: GoogleAuthorizationServiceOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#clientFactory =
      options.clientFactory ??
      (() =>
        new OAuth2Client({
          clientId: this.#config.clientId,
          clientSecret: this.#config.clientSecret,
          redirectUri: this.#config.redirectUri,
        }));
  }

  /** True when the configured redirect is https — used to set the state cookie's Secure flag. */
  get redirectIsHttps(): boolean {
    return this.#config.redirectUri.startsWith("https:");
  }

  /**
   * The Google consent URL. `access_type=offline` + `prompt=consent` because
   * Google returns a refresh token only on initial offline authorization, and a
   * reconnect explicitly needs a replacement. `login_hint` is UX only — the
   * authorized account is verified against the profile in `handleCallback`.
   */
  authorizationUrl(state: string): string {
    return this.#clientFactory().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [GMAIL_READONLY_SCOPE],
      include_granted_scopes: true,
      login_hint: this.#config.account,
      state,
    });
  }

  /**
   * Exchange the code and validate the grant. The route has already validated
   * the CSRF state, so this takes only the code. On any rejection we best-effort
   * revoke the just-issued token and leave any existing credential untouched.
   */
  async handleCallback(code: string): Promise<StoredCredential> {
    const client = this.#clientFactory();
    const { tokens } = await client.getToken(code);

    const refreshToken = tokens.refresh_token;
    if (!refreshToken) {
      await this.#revokeQuietly(client, tokens.access_token);
      throw new CallbackRejectedError(
        "Google did not return a refresh token. Re-authorize with offline access (prompt=consent).",
      );
    }

    const grantedScopes = (tokens.scope ?? "").split(" ").filter(Boolean);
    if (!grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
      await this.#revokeQuietly(client, refreshToken);
      throw new CallbackRejectedError("The gmail.readonly scope was not granted.");
    }

    const accessToken = tokens.access_token;
    if (!accessToken) {
      await this.#revokeQuietly(client, refreshToken);
      throw new CallbackRejectedError("Google did not return an access token to verify the account.");
    }

    const email = await this.#fetchPrimaryEmail(accessToken);
    if (email.toLowerCase() !== this.#config.account.toLowerCase()) {
      await this.#revokeQuietly(client, refreshToken);
      throw new AccountMismatchError(
        `Authorized ${email}, but ORION_GMAIL_ACCOUNT is ${this.#config.account}. Existing credential left unchanged.`,
      );
    }

    const credential: StoredCredential = {
      account: this.#config.account,
      refreshToken,
      status: "active",
      updatedAt: new Date().toISOString(),
    };
    await this.#store.write(credential);
    return credential;
  }

  /**
   * A fresh access token (AccessTokenProvider). google-auth-library refreshes
   * automatically and keeps access tokens in memory. A rotated refresh token is
   * persisted via the `tokens` event. `invalid_grant`/revocation flips the
   * durable status to `reconnect_required`; transient errors propagate as-is.
   */
  async getAccessToken(): Promise<string> {
    const credential = await this.#store.read();
    if (!credential) {
      throw new ReconnectRequiredError("No Gmail credential stored; connect Gmail first.");
    }
    if (credential.status === "reconnect_required") {
      throw new ReconnectRequiredError("The stored Gmail authorization is no longer valid; reconnect.");
    }

    const client = this.#clientWithRefresh(credential.refreshToken);
    try {
      const { token } = await client.getAccessToken();
      if (!token) {
        throw new ReconnectRequiredError("Google returned no access token.");
      }
      return token;
    } catch (error) {
      if (error instanceof ReconnectRequiredError) throw error;
      if (isInvalidGrant(error)) {
        await this.#markReconnectRequired();
        throw new ReconnectRequiredError(
          "Gmail authorization was revoked or expired; reconnect required.",
          { cause: error },
        );
      }
      throw error; // transient/network — not a reconnect condition
    }
  }

  /** Called when a live read hit an unrecoverable 401: mark the credential unusable. */
  async flagReconnectRequired(): Promise<void> {
    await this.#markReconnectRequired();
  }

  async disconnect(): Promise<void> {
    const credential = await this.#store.read().catch(() => null);
    if (credential) {
      await this.#revokeQuietly(this.#clientFactory(), credential.refreshToken);
    }
    // Delete locally regardless of whether revoke succeeded.
    await this.#store.delete();
  }

  async integrationState(): Promise<GmailIntegrationState> {
    let credential: StoredCredential | null;
    try {
      credential = await this.#store.read();
    } catch (error) {
      if (error instanceof CredentialCryptoError) {
        return {
          mode: "live",
          auth: "misconfigured",
          issues: [error.message],
        };
      }
      throw error;
    }
    if (!credential) return { mode: "live", auth: "disconnected" };
    if (credential.status === "reconnect_required") {
      return { mode: "live", auth: "reconnect_required", account: credential.account };
    }
    return { mode: "live", auth: "connected", account: credential.account };
  }

  #clientWithRefresh(refreshToken: string): OAuth2Client {
    const client = this.#clientFactory();
    client.setCredentials({ refresh_token: refreshToken });
    // Google may rotate the refresh token; persist a new one if it does.
    client.on("tokens", (tokens: Credentials) => {
      if (tokens.refresh_token) {
        void this.#persistRotatedRefreshToken(tokens.refresh_token);
      }
    });
    return client;
  }

  async #persistRotatedRefreshToken(refreshToken: string): Promise<void> {
    const current = await this.#store.read().catch(() => null);
    if (!current) return;
    await this.#store.write({
      ...current,
      refreshToken,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
  }

  async #markReconnectRequired(): Promise<void> {
    const current = await this.#store.read().catch(() => null);
    if (!current || current.status === "reconnect_required") return;
    await this.#store.write({
      ...current,
      status: "reconnect_required",
      updatedAt: new Date().toISOString(),
    });
  }

  async #fetchPrimaryEmail(accessToken: string): Promise<string> {
    const response = await this.#fetch(PROFILE_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new CallbackRejectedError(
        `Could not read the Gmail profile to verify the account (${response.status}).`,
      );
    }
    const profile = (await response.json()) as { emailAddress?: string };
    if (!profile.emailAddress) {
      throw new CallbackRejectedError("Gmail profile did not include an email address.");
    }
    return profile.emailAddress;
  }

  async #revokeQuietly(client: OAuth2Client, token: string | null | undefined): Promise<void> {
    if (!token) return;
    try {
      await client.revokeToken(token);
    } catch {
      // Best-effort: a revoke failure must never block the caller.
    }
  }
}

/** Detect Google's `invalid_grant` (revoked/expired refresh token) across shapes. */
function isInvalidGrant(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    message?: unknown;
    response?: { data?: { error?: unknown } };
  };
  if (candidate.response?.data?.error === "invalid_grant") return true;
  return typeof candidate.message === "string" && candidate.message.includes("invalid_grant");
}
