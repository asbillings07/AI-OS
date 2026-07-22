import { mkdirSync } from "node:fs";
import path from "node:path";
import { createLogger, LogEvents } from "@orion/core";
import {
  readGmailConfig,
  SqliteCredentialStore,
  GoogleAuthorizationService,
  type GmailIntegrationState,
} from "@orion/gmail-auth";

/**
 * The Gmail integration for this process. Resolves the configured mode once and
 * caches it: fixture, misconfigured-live (with issues), or a live authorization
 * service. `service()` is null unless a live service was constructed, so callers
 * cannot accidentally drive OAuth in fixture mode.
 */
export interface GmailIntegration {
  state(): Promise<GmailIntegrationState>;
  service(): GoogleAuthorizationService | null;
}

// Cache on globalThis so it survives Next's dev HMR and is shared across requests.
const globalForGmail = globalThis as unknown as { __orionGmail?: GmailIntegration };

export function getGmailIntegration(): GmailIntegration {
  if (!globalForGmail.__orionGmail) {
    globalForGmail.__orionGmail = build();
  }
  return globalForGmail.__orionGmail;
}

function build(): GmailIntegration {
  const config = readGmailConfig();

  if (config.mode === "fixture") {
    return { state: async () => ({ mode: "fixture" }), service: () => null };
  }

  if (config.live === null) {
    const issues = config.issues;
    return {
      state: async () => ({ mode: "live", auth: "misconfigured", issues }),
      service: () => null,
    };
  }

  const { credentialsDbPath, encryptionKey } = config.live;
  mkdirSync(path.dirname(credentialsDbPath), { recursive: true });
  const store = new SqliteCredentialStore(credentialsDbPath, encryptionKey);
  const logger = createLogger();
  const service = new GoogleAuthorizationService({
    store,
    config: config.live,
    onError: (error) =>
      logger.event(LogEvents.GmailCredentialPersistFailed, { error: String(error) }),
  });

  return { state: () => service.integrationState(), service: () => service };
}
