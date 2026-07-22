import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  InProcessEventBus,
  SqliteEventStore,
  OrionRuntime,
  ProjectionHost,
  contextProjection,
  attentionProjection,
  buildWorkItems,
  buildActionEvent,
  createLogger,
  latestThreadMessage,
  LogEvents,
  WORK_ITEM_ACTIONS,
  type AttentionState,
  type ContextState,
  type Logger,
  type WorkItem,
  type WorkItemAction,
} from "@orion/core";
import { GitHubSkill } from "@orion/github-skill";
import { createAi, type AiCapabilities } from "@orion/ai";
import type { GmailIntegrationState } from "@orion/gmail-auth";
import { getGmailIntegration } from "./gmail-auth";
import { syncConfiguredGmail, type GmailSyncResult } from "./gmail-sync";

interface OrionService {
  runtime: OrionRuntime;
  context: ProjectionHost<ContextState>;
  attention: ProjectionHost<AttentionState>;
  ai: AiCapabilities;
  logger: Logger;
}

// Cache the service on globalThis so it survives Next's dev HMR and is shared
// across requests in the same server process.
const globalForOrion = globalThis as unknown as { __orion?: Promise<OrionService> };

async function boot(): Promise<OrionService> {
  // ORION_DB_PATH lets the CLI tools (bootstrap/reset/rebuild/inspect) operate on
  // the same log the app reads. Default lives under the app dir.
  const dbPath = process.env.ORION_DB_PATH ?? path.join(process.cwd(), ".data", "orion.db");
  mkdirSync(path.dirname(dbPath), { recursive: true });

  // Off unless ORION_LOG is set; then a structured trace of the loop hits stderr.
  const logger = createLogger();

  const store = new SqliteEventStore(dbPath);
  const bus = new InProcessEventBus();
  const context = new ProjectionHost(contextProjection);
  const attention = new ProjectionHost(attentionProjection);
  const runtime = new OrionRuntime({
    bus,
    store,
    projections: [context as ProjectionHost<unknown>, attention as ProjectionHost<unknown>],
    logger,
  });

  // Rebuild understanding from the log (ADR-0009). GitHub still seeds from
  // fixtures at boot (idempotent by event id). Gmail is NOT ingested here — it is
  // synced at read time (see readMissionControl -> syncConfiguredGmail) so a
  // freshly connected account appears on the next render without a restart.
  await runtime.rebuild();
  await new GitHubSkill().ingest(runtime);

  // The AI chokepoint reports usage; route it to the same structured trace.
  const ai = createAi({
    onUsage: (usage) => logger.event(LogEvents.AiInvoked, { ...usage }),
  });

  return { runtime, context, attention, ai, logger };
}

function getService(): Promise<OrionService> {
  if (!globalForOrion.__orion) {
    globalForOrion.__orion = boot();
  }
  return globalForOrion.__orion;
}

export interface MissionControlView {
  needsAttention: WorkItem[];
  canWait: WorkItem[];
  generatedAt: string;
  providerName: string;
  gmail: GmailIntegrationState;
  gmailSync: GmailSyncResult;
}

/**
 * The read model Mission Control renders. Work Items come from deterministic
 * prioritization; the AI summary is layered on afterward as advisory context
 * only — every item's `reason`/`evidence` already explains itself without AI.
 *
 * Gmail is ingested here, at read time, before Work Items are built, so a newly
 * connected account shows up immediately. A live sync failure is surfaced via
 * `gmailSync` and never substitutes fixtures.
 */
export async function readMissionControl(): Promise<MissionControlView> {
  const { context, attention, ai, logger, runtime } = await getService();
  const gmailSync = await syncConfiguredGmail(runtime, logger);
  const gmail = await getGmailIntegration().state();
  const now = new Date().toISOString();
  const items = buildWorkItems({ context: context.state, attention: attention.state, now, logger });

  // Follow-up (not in v0.1): live-provider summaries are recomputed per render.
  // Before enabling live AI by default, persist or cache advisory summaries by
  // immutable source event plus summarization-policy version. Negligible with
  // the deterministic default; a cost/latency surprise with a real provider.
  const enriched = await Promise.all(
    items.map(async (item): Promise<WorkItem> => {
      // Summaries apply where a conversation body exists — a domain capability
      // distinction (this Subject is a conversation), not a vendor branch.
      if (item.subject.kind !== "thread") return item;
      const thread = context.state.threads[item.subject.id];
      // Summarize the CURRENT revision (newest occurrence), not the last appended
      // message — matching the attention basis the user is shown.
      const currentMessage = thread ? latestThreadMessage(thread) : undefined;
      if (!currentMessage) return item;
      try {
        const { summary, confidence } = await ai.summarize({
          text: currentMessage.body,
          purpose: "conversation triage",
          maxSentences: 1,
        });
        return { ...item, summary, summaryConfidence: confidence };
      } catch {
        return item;
      }
    }),
  );

  return {
    needsAttention: enriched.filter((item) => item.band === "needs_attention"),
    canWait: enriched.filter((item) => item.band === "can_wait"),
    generatedAt: now,
    providerName: ai.providerName,
    gmail,
    gmailSync,
  };
}

// The action vocabulary lives in @orion/core (alongside buildActionEvent) so the
// decision logic is testable without Next; re-exported here for the server action.
export { WORK_ITEM_ACTIONS };
export type { WorkItemAction };

/**
 * Record a user's decision as a new Event. This closes the loop: the event
 * updates the Attention projection, which changes what's visible on the next read
 * (ADR-0002, ADR-0007, ADR-0008, ADR-0009, ADR-0012 all at once).
 *
 * The trust boundary lives in `buildActionEvent` (@orion/core): the client submits
 * `workItemId` + `action` + `revision`, and the server re-resolves the item against
 * what is *currently visible*, derives Subject and basis from that surfaced Work
 * Item (never from client input), and records only if the recomputed revision token
 * still matches — so an action cannot silently apply to a newer revision.
 *
 * The decision runs *inside* `recordExclusive`, so the visibility/revision check
 * and the append are one serialized critical section (#61): two concurrent submits
 * against the same revision cannot both land — the second re-resolves, sees the
 * item gone, and records nothing. Deterministic action ids dedupe exact duplicates
 * on the log even across processes/replay. `now` is generated inside the callback
 * so visibility and the snooze deadline reflect when the section actually runs.
 *
 * Returns whether an event was recorded.
 */
export async function recordAction(
  workItemId: string,
  action: WorkItemAction,
  revision: string,
): Promise<boolean> {
  const { runtime, context, attention, logger } = await getService();

  const recorded = await runtime.recordExclusive(() =>
    buildActionEvent({
      context: context.state,
      attention: attention.state,
      now: new Date().toISOString(),
      workItemId,
      action,
      revision,
      logger,
    }),
  );

  // Only after the record durably succeeds — the trace must not claim an action
  // was recorded if persistence threw or the decision recorded nothing.
  if (recorded) {
    logger.event(LogEvents.UserActionRecorded, { action, workItemId });
  }
  return recorded;
}
