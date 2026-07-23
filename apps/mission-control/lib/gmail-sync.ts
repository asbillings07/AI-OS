import { LogEvents, type Logger, type OrionRuntime } from "@orion/core";
import {
  GmailSkill,
  LiveGmailSource,
  GmailAuthError,
  type GmailSource,
  type GmailTrace,
} from "@orion/gmail-skill";
import { ReconnectRequiredError } from "@orion/gmail-auth";
import { getGmailIntegration } from "./gmail-auth";

/**
 * Transient health of the last sync attempt — deliberately separate from the
 * authorization state. A timeout or network blip sets `ok: false` but does NOT
 * mean the account must reconnect.
 */
export interface GmailSyncResult {
  readonly mode: "fixture" | "live";
  readonly ok: boolean;
  /** Number of Gmail messages submitted this sync (idempotent on the log). */
  readonly ingested: number;
  /** Messages listed but abandoned this sync after best-effort hydration. */
  readonly dropped?: number;
  readonly skipped?: "disconnected" | "reconnect_required" | "misconfigured";
  readonly error?: string;
}

// Concurrent reads share one in-flight sync so a burst of requests fetches once.
let inFlight: Promise<GmailSyncResult> | null = null;

/**
 * Ingest the configured Gmail source at read time, before the read model is
 * built. This is what makes a fresh OAuth connection show up on the very next
 * render without a restart. Deterministic Gmail event ids keep repeat ingestion
 * idempotent, so previously ingested messages remain available even if this
 * attempt times out or fails. A live failure NEVER falls back to fixtures.
 *
 * Takes the logger already created in `orion.ts` so live resilience traces (retry,
 * drop) join the same structured stream — no second logger.
 */
export function syncConfiguredGmail(runtime: OrionRuntime, logger: Logger): Promise<GmailSyncResult> {
  if (!inFlight) {
    inFlight = runSync(runtime, logger).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function runSync(runtime: OrionRuntime, logger: Logger): Promise<GmailSyncResult> {
  const integration = getGmailIntegration();
  const state = await integration.state();

  if (state.mode === "fixture") {
    const events = await new GmailSkill().ingest(runtime);
    return { mode: "fixture", ok: true, ingested: events.length };
  }

  if (state.auth !== "connected") {
    // Live but not usable: surface it, ingest nothing, never substitute fixtures.
    return { mode: "live", ok: false, ingested: 0, skipped: state.auth };
  }

  const service = integration.service();
  if (!service) {
    return { mode: "live", ok: false, ingested: 0, skipped: "misconfigured" };
  }

  try {
    return await ingestLiveGmail(
      runtime,
      logger,
      (onTrace) =>
        new LiveGmailSource({
          tokenProvider: service,
          query: "(in:inbox OR in:sent) newer_than:7d",
          maxMessages: 100,
          onTrace,
        }),
    );
  } catch (error) {
    // A genuine auth failure flips the credential to reconnect_required; other
    // failures (timeout, 5xx, network) leave it connected for the next attempt.
    if (error instanceof ReconnectRequiredError) {
      return { mode: "live", ok: false, ingested: 0, skipped: "reconnect_required" };
    }
    if (error instanceof GmailAuthError) {
      await service.flagReconnectRequired();
      return { mode: "live", ok: false, ingested: 0, skipped: "reconnect_required" };
    }
    return { mode: "live", ok: false, ingested: 0, error: messageOf(error) };
  }
}

/**
 * The live ingest core, extracted so the drop-counting and health rule are
 * testable without the OAuth/SQLite integration singleton. `buildSource` receives
 * the trace sink so drops are counted through the same path the source uses.
 *
 * Health: an empty inbox and partial success are both healthy; only a total
 * hydration failure (messages were listed but none ingested) is `ok: false`.
 */
export async function ingestLiveGmail(
  runtime: OrionRuntime,
  logger: Logger,
  buildSource: (onTrace: GmailTrace) => GmailSource,
): Promise<GmailSyncResult> {
  let dropped = 0;
  const source = buildSource((event, fields) => {
    // Count the drop BEFORE logging. The source swallows a throwing tracer, so
    // counting first keeps all-drop health honest even if the logger throws.
    if (event === LogEvents.GmailMessageDropped) dropped += 1;
    logger.event(event, fields);
  });
  const events = await new GmailSkill({ source }).ingest(runtime);
  const ok = events.length > 0 || dropped === 0;
  return { mode: "live", ok, ingested: events.length, dropped };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
