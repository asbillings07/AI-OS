/**
 * Runs the entire vertical slice in the terminal, with no UI, no network, and
 * no API key. Deterministic: a fixed `now` so the output never drifts.
 *
 *   npm run slice
 */
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

const NOW = "2026-07-15T17:00:00.000Z";

// Off by default; run `ORION_LOG=1 npm run slice` to trace the loop.
const logger: Logger = createLogger();

function printItem(item: WorkItem): void {
  console.log(`  • ${item.title}  [priority ${item.priority.toFixed(2)}]`);
  console.log(`    why: ${item.reason}`);
  console.log(
    `    o=${item.opportunity.toFixed(2)} u=${item.urgency.toFixed(2)} c=${item.commitment.toFixed(2)} cap=${item.capacity.toFixed(2)} · traces to ${item.createdFromEventIds.length} event(s)`,
  );
}

function render(context: ContextState, label: string): WorkItem[] {
  const items = buildWorkItems(context, NOW, logger);
  const needs = items.filter((i) => i.band === "needs_attention");
  const wait = items.filter((i) => i.band === "can_wait");
  console.log(`\n=== ${label} ===`);
  console.log(`\nNeeds attention (${needs.length}):`);
  needs.forEach(printItem);
  console.log(`\nCan wait (${wait.length}):`);
  wait.forEach(printItem);
  return items;
}

async function main(): Promise<void> {
  const store = new SqliteEventStore(":memory:");
  try {
    const bus = new InProcessEventBus();
    const context = new ProjectionHost(contextProjection);
    const runtime = new OrionRuntime({
      bus,
      store,
      projections: [context as ProjectionHost<unknown>],
      logger,
    });

    await runtime.rebuild();
    const ingested = await new GmailSkill().ingest(runtime);
    console.log(`Ingested ${ingested.length} messages -> ${store.count()} events on the log.`);

    const before = render(context.state, "Mission Control");

    // Close the loop: the user handles the top item.
    const top = before.find((item) => item.band === "needs_attention");
    if (top) {
      console.log(`\n>> You handle "${top.title}". Recording the decision as a new Event...`);
      await runtime.record(
        makeEvent({
          type: EventTypes.WorkItemActedOn,
          source: "user",
          payload: { workItemId: top.id, threadId: top.threadId },
        }),
      );
      // Trace the action only after it's durably recorded.
      logger.event(LogEvents.UserActionRecorded, {
        action: "acted",
        workItemId: top.id,
        threadId: top.threadId,
      });
      render(context.state, "Mission Control (after your action)");
    }

    console.log("\nDone. Every ranking above was decided deterministically; no AI was required.");
  } finally {
    // Always release the better-sqlite3 handle, even on error, so the process
    // exits promptly.
    store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
