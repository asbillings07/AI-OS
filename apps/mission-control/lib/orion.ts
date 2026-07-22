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
  createLogger,
  latestThreadMessage,
  makeEvent,
  EventTypes,
  LogEvents,
  type AttentionState,
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

  // Rebuild understanding from the log (ADR-0009), then seed each fixture Skill
  // idempotently. Deterministic event ids dedupe on the append-only store, so
  // re-seeding on every boot is a no-op once present, and an existing Gmail-only
  // log also picks up GitHub. Both Sources surface as source-neutral Work Items
  // through the same decision layer (#46).
  await runtime.rebuild();
  await new GmailSkill().ingest(runtime);
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
}

/**
 * The read model Mission Control renders. Work Items come from deterministic
 * prioritization; the AI summary is layered on afterward as advisory context
 * only — every item's `reason`/`evidence` already explains itself without AI.
 */
export async function readMissionControl(): Promise<MissionControlView> {
  const { context, attention, ai, logger } = await getService();
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
  };
}

export const WORK_ITEM_ACTIONS = ["acted", "snoozed", "dismissed"] as const;
export type WorkItemAction = (typeof WORK_ITEM_ACTIONS)[number];

/**
 * Record a user's decision as a new Event. This closes the loop: the event
 * updates the Attention projection, which changes what's visible on the next read
 * (ADR-0002, ADR-0007, ADR-0008, ADR-0009, ADR-0012 all at once).
 *
 * The trust boundary is here. The client submits `workItemId` + `action` +
 * `revision`. We re-resolve the item against what is *currently visible* and derive
 * the Subject and attention basis from that surfaced Work Item — never from client
 * input. The `revision` is an optimistic-concurrency token, NOT trusted data: we
 * recompute the current item's token and record only if it matches, so an action
 * the user took against a card cannot silently apply to a newer revision that
 * arrived in between (a TOCTOU race that would suppress information they never saw).
 *
 * We also verify the item is visible, its Subject is valid, and its basis is
 * nonempty before writing. A forged/stale id, or a stale revision, records nothing
 * (never pollute the immutable log) and returns false; the caller then refreshes to
 * current truth. Duplicate submissions are benign: once acted/snoozed/dismissed the
 * item is no longer visible, so a repeat resolves to nothing.
 *
 * Returns whether an event was recorded.
 */
export async function recordAction(
  workItemId: string,
  action: WorkItemAction,
  revision: string,
): Promise<boolean> {
  const { runtime, context, attention, logger } = await getService();

  const surfaced = buildWorkItems({
    context: context.state,
    attention: attention.state,
    now: new Date().toISOString(),
    logger,
  }).find((item) => item.id === workItemId);

  // Only act on a currently-visible item with a valid Subject and a nonempty basis.
  if (!surfaced || !surfaced.subject?.id || surfaced.attentionBasisEventIds.length === 0) {
    return false;
  }

  // Optimistic concurrency: the card the user acted on must still be the current
  // revision. A mismatch means a newer occurrence arrived; reject and let the view
  // refresh rather than suppress something the user never saw.
  if (surfaced.attentionRevision !== revision) {
    return false;
  }

  const base = {
    workItemId,
    subject: surfaced.subject,
    basisEventIds: surfaced.attentionBasisEventIds,
  } as const;

  switch (action) {
    case "acted":
      await runtime.record(
        makeEvent({ type: EventTypes.WorkItemActedOn, source: "user", payload: base }),
      );
      break;
    case "dismissed":
      await runtime.record(
        makeEvent({ type: EventTypes.WorkItemDismissed, source: "user", payload: base }),
      );
      break;
    case "snoozed": {
      const snoozedUntil = new Date(Date.now() + 24 * 3_600_000).toISOString();
      await runtime.record(
        makeEvent({
          type: EventTypes.WorkItemSnoozed,
          source: "user",
          payload: { ...base, snoozedUntil },
        }),
      );
      break;
    }
  }

  // Only after the record durably succeeds — the trace must not claim an action
  // was recorded if persistence threw.
  logger.event(LogEvents.UserActionRecorded, {
    action,
    workItemId,
    subject: `${surfaced.subject.kind}:${surfaced.subject.id}`,
  });
  return true;
}
