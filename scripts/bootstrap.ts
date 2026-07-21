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
import { GitHubSkill } from "@orion/github-skill";
import { resolveDbPath } from "./_shared.js";

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const store = new SqliteEventStore(dbPath);
  try {
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
    const before = store.count();
    // Seed each fixture Skill idempotently: deterministic event ids mean
    // re-ingesting is a no-op on the append-only store, and an existing log (e.g.
    // Gmail-only from an earlier slice) picks up any newly added Source. We do
    // NOT gate on "is the log empty?", so all entry points converge on one log.
    await new GmailSkill().ingest(runtime);
    await new GitHubSkill().ingest(runtime);
    const added = store.count() - before;
    console.log(
      added === 0
        ? `Log already seeded (${before} event(s)); nothing new from fixtures.`
        : `Seeded ${added} new event(s) from fixtures.`,
    );

    const items = buildWorkItems(context.state, new Date().toISOString(), logger);
    console.log(`\nEvent log:  ${dbPath}`);
    console.log(`Events:     ${store.count()}`);
    console.log(`Threads:    ${Object.keys(context.state.threads).length}`);
    console.log(`Work items: ${items.length}`);
    console.log(`\nStart Mission Control with:  npm run dev  (in apps/mission-control)`);
  } finally {
    // Always release the better-sqlite3 handle (and WAL lock), even on error,
    // so the process exits promptly instead of hanging.
    store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
