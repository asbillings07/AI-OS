/**
 * One-command local setup. Creates the event log if needed, rebuilds
 * understanding from it (ADR-0009), and seeds Gmail fixtures once when the log
 * is empty. Idempotent: run it as often as you like.
 *
 *   npm run bootstrap
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  InProcessEventBus,
  OrionRuntime,
  ProjectionHost,
  SqliteEventStore,
  buildWorkItems,
  contextProjection,
  createLogger,
} from "@orion/core";
import { GmailSkill } from "@orion/gmail-skill";
import { resolveDbPath } from "./_shared.js";

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const store = new SqliteEventStore(dbPath);
  const bus = new InProcessEventBus();
  const context = new ProjectionHost(contextProjection);
  const runtime = new OrionRuntime({
    bus,
    store,
    projections: [context as ProjectionHost<unknown>],
    logger: createLogger(),
  });

  await runtime.rebuild();
  const before = store.count();
  if (before === 0) {
    const ingested = await new GmailSkill().ingest(runtime);
    console.log(`Seeded ${ingested.length} messages from Gmail fixtures.`);
  } else {
    console.log(`Log already has ${before} event(s); left as-is.`);
  }

  const items = buildWorkItems(context.state, new Date().toISOString());
  console.log(`\nEvent log:  ${dbPath}`);
  console.log(`Events:     ${store.count()}`);
  console.log(`Threads:    ${Object.keys(context.state.threads).length}`);
  console.log(`Work items: ${items.length}`);
  console.log(`\nStart Mission Control with:  npm run dev  (in apps/mission-control)`);
  store.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
