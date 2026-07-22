import path from "node:path";
import { parseEncryptionKey } from "./crypto.js";

/**
 * Source selection and OAuth configuration, read from the environment.
 *
 * Strict rule: fixtures are the default. `live` is opt-in via
 * `ORION_GMAIL_SOURCE=live`. When live is selected but the OAuth environment is
 * incomplete or invalid, we surface `issues` and refuse to construct a live
 * integration — we never quietly fall back to fixtures.
 *
 * Nothing here is a `NEXT_PUBLIC_` value; every field is server-only.
 */
export type GmailMode = "fixture" | "live";

export interface GmailLiveConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly account: string;
  readonly encryptionKey: string;
  readonly credentialsDbPath: string;
}

export type GmailConfig =
  | { readonly mode: "fixture" }
  | { readonly mode: "live"; readonly live: GmailLiveConfig }
  | { readonly mode: "live"; readonly live: null; readonly issues: readonly string[] };

type Env = Record<string, string | undefined>;

function defaultCredentialsDbPath(): string {
  return path.join(process.cwd(), ".data", "orion-credentials.db");
}

export function readGmailConfig(env: Env = process.env): GmailConfig {
  const mode: GmailMode = env.ORION_GMAIL_SOURCE === "live" ? "live" : "fixture";
  if (mode === "fixture") {
    return { mode: "fixture" };
  }

  const issues: string[] = [];
  const require = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) issues.push(`${name} is required for ORION_GMAIL_SOURCE=live.`);
    return value ?? "";
  };

  const clientId = require("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = require("GOOGLE_OAUTH_CLIENT_SECRET");
  const redirectUri = require("GOOGLE_OAUTH_REDIRECT_URI");
  const account = require("ORION_GMAIL_ACCOUNT");
  const encryptionKey = require("ORION_CREDENTIAL_ENCRYPTION_KEY");

  if (encryptionKey) {
    try {
      parseEncryptionKey(encryptionKey);
    } catch {
      issues.push(
        "ORION_CREDENTIAL_ENCRYPTION_KEY must be a 32-byte key encoded as base64.",
      );
    }
  }

  if (issues.length > 0) {
    return { mode: "live", live: null, issues };
  }

  return {
    mode: "live",
    live: {
      clientId,
      clientSecret,
      redirectUri,
      account,
      encryptionKey,
      credentialsDbPath: env.ORION_CREDENTIALS_DB_PATH?.trim() || defaultCredentialsDbPath(),
    },
  };
}
