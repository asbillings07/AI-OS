import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  InProcessEventBus,
  SqliteEventStore,
  OrionRuntime,
  ProjectionHost,
  contextProjection,
  buildWorkItems,
  createLogger,
  makeEvent,
  EventTypes,
  LogEvents,
  type ContextState,
  type Logger,
  type WorkItem,
} from "@orion/core";
import { GmailSkill } from "@orion/gmail-skill";
import { GitHubSkill } from "@orion/github-skill";
import { createAi, type AiCapabilities } from "@orion/ai";

interface OrionService {
  runtime: OrionRuntime;
  context: ProjectionHost<ContextState>;
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
  const runtime = new OrionRuntime({
    bus,
    store,
    projections: [context as ProjectionHost<unknown>],
    logger,
  });

  // Rebuild understanding from the log (ADR-0009), then seed each fixture Skill
  // idempotently. Deterministic event ids dedupe on the append-only store, so
  // re-seeding on every boot is a no-op once present, and an existing Gmail-only
  // log also picks up GitHub. GitHub facts land on the log but produce no Work
  // Items yet — core has no GitHub interpretation until #45.
  await runtime.rebuild();
  await new GmailSkill().ingest(runtime);
  await new GitHubSkill().ingest(runtime);

  // The AI chokepoint reports usage; route it to the same structured trace.
  const ai = createAi({
    onUsage: (usage) => logger.event(LogEvents.AiInvoked, { ...usage }),
  });

  return { runtime, context, ai, logger };
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
}

/**
 * The read model Mission Control renders. Work Items come from deterministic
 * prioritization; the AI summary is layered on afterward as advisory context
 * only — every item's `reason`/`evidence` already explains itself without AI.
 */
export async function readMissionControl(): Promise<MissionControlView> {
  const { context, ai, logger } = await getService();
  const now = new Date().toISOString();
  const items = buildWorkItems(context.state, now, logger);

  // Follow-up (not in v0.1): live-provider summaries are recomputed per render.
  // Before enabling live AI by default, persist or cache advisory summaries by
  // immutable source event plus summarization-policy version. Negligible with
  // the deterministic default; a cost/latency surprise with a real provider.
  const enriched = await Promise.all(
    items.map(async (item): Promise<WorkItem> => {
      const thread = context.state.threads[item.threadId];
      const lastMessage = thread?.messages[thread.messages.length - 1];
      if (!lastMessage) return item;
      try {
        const { summary, confidence } = await ai.summarize({
          text: lastMessage.body,
          purpose: "email triage",
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
  };
}

export const WORK_ITEM_ACTIONS = ["acted", "snoozed", "dismissed"] as const;
export type WorkItemAction = (typeof WORK_ITEM_ACTIONS)[number];

/**
 * Record a user's decision as a new Event. This closes the loop: the event
 * updates Context, which changes prioritization on the next read (ADR-0002,
 * ADR-0005, ADR-0007, ADR-0008, ADR-0009 all at once).
 *
 * The trust boundary is here: we resolve the Work Item against what is actually
 * surfaced right now and verify both ids before writing anything. A forged or
 * stale id records nothing (never pollute the immutable log with unverified
 * user events) and returns false. Duplicate submissions are intentionally
 * benign: once acted/snoozed/dismissed, the thread is no longer surfaced, so a
 * repeat submit simply resolves to nothing and no-ops.
 *
 * Returns whether an event was recorded.
 */
export async function recordAction(
  workItemId: string,
  threadId: string,
  action: WorkItemAction,
): Promise<boolean> {
  const { runtime, context, logger } = await getService();

  const surfaced = buildWorkItems(context.state, new Date().toISOString(), logger).find(
    (item) => item.id === workItemId && item.threadId === threadId,
  );
  if (!surfaced) {
    return false;
  }

  switch (action) {
    case "acted":
      await runtime.record(
        makeEvent({ type: EventTypes.WorkItemActedOn, source: "user", payload: { workItemId, threadId } }),
      );
      break;
    case "dismissed":
      await runtime.record(
        makeEvent({ type: EventTypes.WorkItemDismissed, source: "user", payload: { workItemId, threadId } }),
      );
      break;
    case "snoozed": {
      const snoozedUntil = new Date(Date.now() + 24 * 3_600_000).toISOString();
      await runtime.record(
        makeEvent({
          type: EventTypes.WorkItemSnoozed,
          source: "user",
          payload: { workItemId, threadId, snoozedUntil },
        }),
      );
      break;
    }
  }

  // Only after the record durably succeeds — the trace must not claim an action
  // was recorded if persistence threw.
  logger.event(LogEvents.UserActionRecorded, { action, workItemId, threadId });
  return true;
}
