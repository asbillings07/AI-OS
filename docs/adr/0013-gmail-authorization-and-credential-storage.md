# ADR-0013: Gmail Authorization and Credential Storage

> Status: Accepted
> Date: 2026-07-21 · Deciders: @asbillings07
> Related: [v0.1 Dogfood], [ADR-0009](0009-storage-strategy.md), [ADR-0010](0010-skill-architecture.md), [The Vertical Slice](../architecture/vertical-slice.md)

## Context

Through both vertical slices the Gmail Source read from captured fixtures. To dogfood Orion against a real inbox we need live Gmail data, which means authorizing against Google, holding a long-lived credential, and refreshing short-lived access tokens — without letting any of that leak into the domain (Eng #8) or the event log (ADR-0009).

Two things must stay true no matter how we do this:

1. **A Skill owns its adapters and credentials (ADR-0010).** The domain must never learn that Gmail, OAuth, or Google exist. `LiveGmailSource` should depend on "give me a bearer token," nothing more.
2. **Fixtures remain the default.** Live is opt-in and, when it fails, must never silently fall back to fixtures — a dogfood tool that quietly shows fake mail is worse than one that shows an error.

This is also explicitly **not** an Orion user-login system. There is one user (the developer), local and trusted. The "account" is the Gmail address whose mail Orion reads — a property of a data source, not a session identity.

## Why now?

The v0.1 Dogfood milestone is the first time Orion needs to face a real, external, credentialed system. Deciding the authorization and at-rest storage model now — before more sources (Calendar, more Google scopes) arrive — keeps the credential seam source-neutral and prevents each future integration from reinventing OAuth and secret storage.

## Decision

**We will authorize Gmail via a server-side Google OAuth 2.0 web-server flow, store only the refresh token (encrypted at rest, outside the event log), and expose access tokens to the Skill through a narrow `AccessTokenProvider` seam.** Concretely:

- **Web-server flow, readonly scope.** Mission Control redirects to Google's consent screen requesting only `https://www.googleapis.com/auth/gmail.readonly`, with `access_type=offline` + `prompt=consent` so Google returns a refresh token. A random `state` is stored in an HttpOnly cookie and verified (timing-safe) on the callback (CSRF). The callback route owns cookies and CSRF; the authorization service owns Google.
- **`google-auth-library` does the OAuth.** We use Google's official `OAuth2Client` for code exchange, refresh, and rotation rather than hand-rolling token endpoints. Its wire types never cross the `GoogleAuthorizationService` boundary.
- **Callback validation.** On callback we require a refresh token, verify `gmail.readonly` was actually granted (via `OAuth2Client.getTokenInfo(accessToken).scopes`, not the optional `scope` field on the token response), and verify the authorized account matches `ORION_GMAIL_ACCOUNT` (via the Gmail profile). Any failure best-effort revokes the just-issued token and leaves any existing credential unchanged.
- **Only the refresh token is persisted, encrypted, and out of the log.** A dedicated `CredentialStore` seam holds the single account's refresh token plus status/metadata. The SQLite implementation encrypts the refresh token with AES-256-GCM (`v1:` envelope; the account id bound as AAD). Access tokens are short-lived and kept in memory by the library. Credentials live in their own database — **never** in the event log, which is replayable and inspectable in ways a secret must not be (ADR-0009).
- **One cached client; refresh only when expired.** The service keeps a single `OAuth2Client` per stored refresh token and reuses it across renders. Because the library caches the access token in memory and only calls Google once it has expired, read-time sync does not re-exchange the refresh token on every page load. The cache is invalidated on reconnect, disconnect, and `invalid_grant`.
- **Rotation is status-preserving and observed.** If Google rotates the refresh token (via the library's `tokens` event), the store's `updateRefreshToken(token, updatedAt)` updates *only* the token and timestamp — it never rewrites `status`, so a rotation can never race a concurrent flip to `reconnect_required` back to `active`. The persistence promise is serialized and its failures are reported, not left unobserved.
- **A durable `reconnect_required` status.** A revoked or expired grant (`invalid_grant`), or an unrecoverable `401` at read time, flips the credential to `reconnect_required` — a durable state that survives restart and surfaces a "Reconnect" action. Transient failures (timeouts, `5xx`, network, and notably `403`) do **not** trigger reconnect; they are surfaced as sync health and retried on the next read. A decryption failure is treated as *misconfiguration* (wrong key), not a revocation.
- **Strict source selection.** `ORION_GMAIL_SOURCE` defaults to `fixture`; `live` is opt-in. When `live` is selected but the OAuth environment is missing/invalid, the integration reports issues and refuses to run — it never falls back to fixtures.
- **Read-time sync.** Live Gmail is ingested at read time (when Mission Control renders), not only at boot, so a freshly connected account appears on the next render without a restart. Deterministic Gmail event ids keep repeat ingestion idempotent (ADR-0009), so a failed attempt leaves previously ingested mail intact.

## Threat model (dogfooding, explicit)

This is a **single-user, local, trusted-operator** tool. The OAuth client may be published to "In production" in Google Cloud purely to escape the test-user/refresh-token-expiry limits — not to serve multiple users. The consequences:

- Do **not** expose Mission Control publicly. There is no Orion user authentication; anyone who can reach the server can read the connected inbox and trigger connect/disconnect.
- The encryption key (`ORION_CREDENTIAL_ENCRYPTION_KEY`) protects the refresh token at rest against casual disk/backup exposure. It does not defend against an attacker who already has code execution on the machine (the key is in the same environment).
- The same-origin/CSRF checks defend the connect/disconnect mutations for the local case; they are not a substitute for real auth on an exposed deployment.

## In one sentence

> Gmail is authorized once via Google's web-server flow; Orion keeps only an encrypted refresh token behind a `CredentialStore`, hands the Skill a token through `AccessTokenProvider`, and treats revocation as a durable "reconnect," misconfiguration as an error, and transient failures as retryable — never as a reason to fake data.

## Consequences

- **Positive:** The domain and the event log stay free of credentials and OAuth; swapping fixtures for live Gmail is a localized, opt-in change; refresh/rotation/reconnect are handled once and reusable by future Google scopes; failures are honest.
- **Negative / costs:** A second database (credentials) and an encryption key to manage; a new external dependency (`google-auth-library`); the "In production" publishing step is a sharp edge that must be paired with the "do not expose publicly" warning.
- **Follow-ups / new constraints:** _(original decision, preserved)_ Pagination, ret/backoff, and rate-limit handling for `LiveGmailSource` (this ADR fetched one page with a timeout); caching/versioning of advisory AI summaries before enabling a live provider; a real auth story if Orion is ever exposed beyond localhost.
- **Implemented follow-ups:** `LiveGmailSource` now paginates the message list, hydrates with a bounded order-preserving concurrency pool, retries transient failures (429 / 5xx / rate-limit-403 / network / timeout) with full-jitter backoff that honors `Retry-After`, drops individual messages best-effort, and bounds the whole sync with an overall time budget whose deadline aborts in-flight fetches — the auth contract is unchanged (only a 401 becomes reconnect). See the LiveGmailSource reliability slice (PR link to be added on open). Still open: advisory-summary caching/versioning; a real auth story beyond localhost.

## Principles

- **Supports:** Engineering #8 (the vendor/credential shape stops at the adapter — the domain never sees Gmail or OAuth); ADR-0009 (secrets stay out of the replayable log; live ingestion stays idempotent); ADR-0010 (the Skill owns its adapter and credentials behind a seam).
- **Trade-offs:** Accepts operational complexity (a key, a second DB, an external SDK) and a deliberately narrow threat model (trusted local single-user) in exchange for real dogfooding data with clean boundaries.

## Alternatives considered

- **Store tokens in a local JSON file (unencrypted):** rejected — a refresh token is a durable credential; plaintext on disk/backups is an unnecessary exposure even for a local tool.
- **Put credentials in the event log:** rejected — violates ADR-0009 (the log is replayable/inspectable and must not hold secrets) and would make "history is never lost" a liability.
- **Hand-roll the OAuth token endpoints:** rejected — refresh, rotation, and error taxonomy are exactly the parts worth delegating to Google's maintained library.
- **Fall back to fixtures when live fails:** rejected — silently showing fake mail defeats the purpose of dogfooding and hides real failures.
- **Fetch live Gmail only at boot:** rejected — a freshly connected account would not appear until a restart; read-time sync is the responsive, idempotent choice.

[v0.1 Dogfood]: ../../README.md
