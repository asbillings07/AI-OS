# Connecting a real Gmail inbox

This guide sets up **live** Gmail for dogfooding Orion against your own inbox. By
default Orion runs on captured fixtures and needs none of this; follow these
steps only when you want to read real mail. The design and rationale live in
[ADR-0013](../adr/0013-gmail-authorization-and-credential-storage.md).

> [!WARNING]
> This is a single-user, local, trusted-operator tool. Mission Control has **no
> user authentication** — anyone who can reach the server can read the connected
> inbox and connect/disconnect it. **Do not expose it publicly.** Run it on
> `localhost` (or a trusted private host) only.

## 1. Create a Google OAuth client

1. In the [Google Cloud Console](https://console.cloud.google.com/), create (or
   pick) a project.
2. Enable the **Gmail API** (APIs & Services -> Library -> Gmail API -> Enable).
3. Configure the **OAuth consent screen** (User type: External is fine for a
   personal account). Add the scope
   `https://www.googleapis.com/auth/gmail.readonly`.
4. Create an **OAuth client ID** of type **Web application**. Under
   **Authorized redirect URIs**, add exactly:

   ```
   http://localhost:3000/api/gmail/callback
   ```

   This must match `GOOGLE_OAUTH_REDIRECT_URI` character-for-character.
5. Copy the **Client ID** and **Client secret**.

### Publishing status: Testing vs In production

While the app is in **Testing**, Google issues refresh tokens that expire after
7 days and limits you to added test users — you would have to reconnect weekly.
For steady dogfooding, add yourself as a test user (quickest) or **Publish** the
app to **In production** (Google may show an "unverified app" screen you can
click through for your own account). Publishing here is only to escape the
testing-mode token expiry — it is **not** an invitation to serve other users.
See the threat model in [ADR-0013](../adr/0013-gmail-authorization-and-credential-storage.md#threat-model-dogfooding-explicit).

## 2. Configure the environment

Copy [`.env.example`](../../.env.example) to `apps/mission-control/.env.local`
(git-ignored) and fill in:

```bash
ORION_GMAIL_SOURCE=live
GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/api/gmail/callback
ORION_GMAIL_ACCOUNT=you@example.com
ORION_CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

`ORION_GMAIL_ACCOUNT` is the address Orion is allowed to read; the account you
authorize must match it, or the connection is rejected.

`ORION_CREDENTIAL_ENCRYPTION_KEY` must be a 32-byte key encoded as base64.
Generate one with `openssl rand -base64 32`. It encrypts the refresh token at
rest. **Keep it stable** — if you change it, the stored credential can no longer
be decrypted and Orion will report a misconfiguration until you reconnect.

## 3. Connect

1. Start Mission Control: `npm run build:mission-control` then
   `npm --workspace @orion/mission-control run start` (or `run dev`).
2. Open `http://localhost:3000`. The Gmail status card shows **Gmail not
   connected**.
3. Click **Connect Gmail**, complete Google's consent screen, and grant
   read-only access. You are redirected back and the card shows **Gmail
   connected — you@example.com**. Your inbox is synced on that render.

To stop, click **Disconnect** — this best-effort revokes the token with Google
and deletes the local credential.

## How it behaves

- **Fixtures are the default and live never falls back to them.** If live mode is
  misconfigured, the status card shows the issues and no mail is ingested — Orion
  will not silently show fixtures.
- **Read-time sync.** Mail is fetched when Mission Control renders (one page,
  `in:inbox newer_than:7d`, up to 25 messages, with a request timeout).
  Pagination, retries, and rate-limit handling are a later slice.
- **Reconnect vs retry.** A revoked/expired authorization (or an unrecoverable
  `401`) becomes a durable **Reconnect Gmail** prompt. Transient failures
  (timeouts, `5xx`, `403`, network) just mark the last sync unhealthy and retry
  on the next render.

## Files that never get committed

`.env*`, `*.db`, and `gmail-*.json` are git-ignored. The encrypted credential
store lives at `apps/mission-control/.data/orion-credentials.db` by default
(override with `ORION_CREDENTIALS_DB_PATH`). Never commit your encryption key.
