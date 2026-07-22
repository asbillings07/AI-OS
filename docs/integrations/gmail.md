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

> [!NOTE]
> Google replaced the single "OAuth consent screen" page with the **Google Auth
> Platform**, which splits those settings across left-nav sections: **Branding**
> (app name/logo), **Audience** (user type, publishing status, test users),
> **Data Access** (scopes), and **Clients** (OAuth clients + redirect URIs). The
> steps below use that layout; older guides that mention one "OAuth consent
> screen" page are describing the pre-2025 UI.

1. In the [Google Cloud Console](https://console.cloud.google.com/), create (or
   pick) a project.
2. Enable the **Gmail API** (APIs & Services -> Library -> Gmail API -> Enable).
3. Open **APIs & Services -> OAuth consent screen** (this now lands on the
   **Google Auth Platform**). If nothing is configured yet, click **Get started**
   and complete the short flow (App name + support email, then **Audience**).
4. **Audience** (left nav): confirm the **User type** — for a personal Gmail
   account this is **External** (Internal only appears under a Google Workspace
   org). Publishing status and **Test users** also live here (see below).
5. **Data Access** (left nav) -> **Add or remove scopes** -> add:

   ```
   https://www.googleapis.com/auth/gmail.readonly
   ```

   Save.
6. **Clients** (left nav) -> **Create client** -> Application type
   **Web application**. Under **Authorized redirect URIs**, add exactly:

   ```
   http://localhost:3000/api/gmail/callback
   ```

   This must match `GOOGLE_OAUTH_REDIRECT_URI` character-for-character. Save.
7. Copy the **Client ID** and **Client secret** from the client you just created.

### Publishing status: Testing vs In production

(Set this under **Audience** in the Google Auth Platform.)


While the app is in **Testing**, Google issues refresh tokens that expire after
7 days and limits you to added test users — you would have to reconnect weekly.
For steady dogfooding, add yourself as a test user (quickest) or **Publish** the
app to **In production** (Google may show an "unverified app" screen you can
click through for your own account). Publishing here is only to escape the
testing-mode token expiry — it is **not** an invitation to serve other users.
See the threat model in [ADR-0013](../adr/0013-gmail-authorization-and-credential-storage.md#threat-model-dogfooding-explicit).

## 2. Configure the environment

First generate an encryption key (a `.env` file does not run shell commands, so
run this in your terminal and copy the output):

```bash
openssl rand -base64 32
```

Then copy [`.env.example`](../../.env.example) to
`apps/mission-control/.env.local` (git-ignored) and fill in, pasting the key you
just generated:

```dotenv
ORION_GMAIL_SOURCE=live
GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/api/gmail/callback
ORION_GMAIL_ACCOUNT=you@example.com
ORION_CREDENTIAL_ENCRYPTION_KEY=<paste the base64 key here>
```

`ORION_GMAIL_SOURCE` accepts only `fixture` (default) or `live`; any other value
is reported as a misconfiguration rather than silently reading fixtures.

`ORION_GMAIL_ACCOUNT` is the address Orion is allowed to read; the account you
authorize must match it, or the connection is rejected.

`ORION_CREDENTIAL_ENCRYPTION_KEY` must be a 32-byte key encoded as base64 (the
`openssl rand -base64 32` output). It encrypts the refresh token at rest. **Keep
it stable** — if you change it, the stored credential can no longer be decrypted
and Orion will report a misconfiguration until you reconnect.

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
- **Read-time sync.** Mail is fetched when Mission Control renders
  (`in:inbox newer_than:7d`, up to 100 messages). The list is paginated and
  messages are hydrated with bounded concurrency. Transient failures
  (`429` / `5xx` / rate-limit `403` / network / timeout) are retried with
  jittered backoff that honors `Retry-After`. A message still failing after its
  retries is dropped best-effort so one bad message never blanks the dashboard.
  The whole sync is bounded by an overall time budget (default 30s) whose
  deadline aborts in-flight requests, so a Gmail outage can never hang a render.
- **Reconnect vs retry.** A revoked/expired authorization (or an unrecoverable
  `401`) becomes a durable **Reconnect Gmail** prompt. Transient failures
  (timeouts, `5xx`, `403`, network) just mark the last sync unhealthy and retry
  on the next render. A sync that lists messages but hydrates none is unhealthy;
  partial success (some messages dropped, some ingested) stays healthy.

## Files that never get committed

`.env*`, `*.db`, and `gmail-*.json` are git-ignored. The encrypted credential
store lives at `apps/mission-control/.data/orion-credentials.db` by default
(override with `ORION_CREDENTIALS_DB_PATH`). Never commit your encryption key.
