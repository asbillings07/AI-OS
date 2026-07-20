import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  InProcessEventBus,
  SqliteEventStore,
  OrionRuntime,
  ProjectionHost,
  contextProjection,
  buildWorkItems,
  makeEvent,
  EventTypes,
  type ContextState,
  type WorkItem,
} from "@orion/core";
import { GmailSkill } from "@orion/gmail-skill";
import { createAi, type AiCapabilities } from "@orion/ai";

interface OrionService {
  runtime: OrionRuntime;
  context: ProjectionHost<ContextState>;
  ai: AiCapabilities;
}

// Cache the service on globalThis so it survives Next's dev HMR and is shared
// across requests in the same server process.
const globalForOrion = globalThis as unknown as { __orion?: Promise<OrionService> };

async function boot(): Promise<OrionService> {
  const dataDir = path.join(process.cwd(), ".data");
  mkdirSync(dataDir, { recursive: true });

  const store = new SqliteEventStore(path.join(dataDir, "orion.db"));
  const bus = new InProcessEventBus();
  const context = new ProjectionHost(contextProjection);
  const runtime = new OrionRuntime({
    bus,
    store,
    projections: [context as ProjectionHost<unknown>],
  });

  // Rebuild understanding from the log (ADR-0009). If the log is empty, seed it
  // from Gmail fixtures once — thereafter the log is the source of truth.
  await runtime.rebuild();
  if (store.count() === 0) {
    await new GmailSkill().ingest(runtime);
  }

  return { runtime, context, ai: createAi() };
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
  const { context, ai } = await getService();
  const now = new Date().toISOString();
  const items = buildWorkItems(context.state, now);

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

export type WorkItemAction = "acted" | "snoozed" | "dismissed";

/**
 * Record a user's decision as a new Event. This closes the loop: the event
 * updates Context, which changes prioritization on the next read (ADR-0002,
 * ADR-0005, ADR-0007, ADR-0008, ADR-0009 all at once).
 */
export async function recordAction(
  workItemId: string,
  threadId: string,
  action: WorkItemAction,
): Promise<void> {
  const { runtime } = await getService();

  if (action === "snoozed") {
    const snoozedUntil = new Date(Date.now() + 24 * 3_600_000).toISOString();
    await runtime.record(
      makeEvent({
        type: EventTypes.WorkItemSnoozed,
        source: "user",
        payload: { workItemId, threadId, snoozedUntil },
      }),
    );
    return;
  }

  await runtime.record(
    makeEvent({
      type: action === "acted" ? EventTypes.WorkItemActedOn : EventTypes.WorkItemDismissed,
      source: "user",
      payload: { workItemId, threadId },
    }),
  );
}
