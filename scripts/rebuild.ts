/**
 * Rebuild every projection purely by replaying the log (ADR-0009). This is the
 * operational proof that state is disposable: nothing here reads any cache, only
 * the append-only log. Prints a summary of the reconstructed understanding.
 *
 *   npm run db:rebuild
 */
import { existsSync } from "node:fs";
import {
  InProcessEventBus,
  OrionRuntime,
  ProjectionHost,
  SqliteEventStore,
  buildWorkItems,
  contextProjection,
  createLogger,
} from "@orion/core";
import { resolveDbPath } from "./_shared.js";

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    console.log(`No event log at ${dbPath}. Run: npm run bootstrap`);
    return;
  }

  const store = new SqliteEventStore(dbPath);
  const bus = new InProcessEventBus();
  const context = new ProjectionHost(contextProjection);
  const logger = createLogger();
  const runtime = new OrionRuntime({
    bus,
    store,
    projections: [context as ProjectionHost<unknown>],
    logger,
  });

  await runtime.rebuild();
  const items = buildWorkItems(context.state, new Date().toISOString(), logger);
  console.log(`Replayed ${store.count()} event(s) from ${dbPath}`);
  console.log(`Reconstructed ${Object.keys(context.state.threads).length} thread(s), ${items.length} work item(s).`);
  store.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
