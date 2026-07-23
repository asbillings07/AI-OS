/**
 * Analyze the live event log against the Issue #79 dogfood evidence checklist.
 * Safe and read-only: opens the SQLite log, rebuilds projections in memory,
 * and prints an anonymized Markdown report suitable for updating GitHub issue #79.
 *
 *   npm run dogfood:check
 */
import { existsSync } from "node:fs";
import {
  InProcessEventBus,
  OrionRuntime,
  ProjectionHost,
  SqliteEventStore,
  buildWorkItems,
  contextProjection,
  attentionProjection,
  personalImportanceProjection,
  importanceScore,
  NEUTRAL_IMPORTANCE,
  createLogger,
  type WorkItem,
} from "@orion/core";
import { resolveDbPath } from "./_shared.js";

/** Redact email address or handle for safe public issue logging. */
function anonymizeOriginator(raw: string): string {
  const [namespace, id] = raw.split(":", 2);
  if (!id) return raw;
  if (id.includes("@")) {
    const [user, domain] = id.split("@", 2);
    const safeUser = user && user.length > 2 ? `${user[0]}***${user[user.length - 1]}` : "user";
    return `${namespace}:${safeUser}@${domain}`;
  }
  const safeId = id.length > 3 ? `${id.slice(0, 2)}***` : "id";
  return `${namespace}:${safeId}`;
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    console.log(`No event log found at ${dbPath}. Boot Mission Control or sync first.`);
    return;
  }

  const store = new SqliteEventStore(dbPath);
  try {
    const bus = new InProcessEventBus();
    const context = new ProjectionHost(contextProjection);
    const attention = new ProjectionHost(attentionProjection);
    const importance = new ProjectionHost(personalImportanceProjection);
    const logger = createLogger();

    const runtime = new OrionRuntime({
      bus,
      store,
      projections: [
        context as ProjectionHost<unknown>,
        attention as ProjectionHost<unknown>,
        importance as ProjectionHost<unknown>,
      ],
      logger,
    });

    await runtime.rebuild();

    const now = new Date().toISOString();
    const items = buildWorkItems({
      context: context.state,
      attention: attention.state,
      importance: importance.state,
      now,
    });
    const neutralItems = buildWorkItems({
      context: context.state,
      attention: attention.state,
      now, // Default importance = neutral everywhere
    });

    // --- Checklist evaluations ---

    // 1. Originators past cold-start threshold (>= 2 decisive actions)
    const originatorEntries = Object.entries(importance.state.byOriginator).map(([key, entry]) => ({
      rawKey: key,
      anonKey: anonymizeOriginator(key),
      acted: entry.acted,
      dismissed: entry.dismissed,
      snoozed: entry.snoozed,
      decisive: entry.acted + entry.dismissed,
      score: importanceScore(entry),
      lastActionAt: entry.lastActionAt,
    }));

    const pastColdStart = originatorEntries.filter((o) => o.decisive >= 2);
    const c1 = pastColdStart.length >= 2;

    // 2. New work arrived from at least one originator AFTER evidence was learned
    const postLearningOriginators: string[] = [];
    for (const o of pastColdStart) {
      const [namespace, id] = o.rawKey.split(":", 2);
      let foundNew = false;
      for (const thread of Object.values(context.state.threads)) {
        for (const message of thread.messages) {
          if (
            message.source === namespace &&
            message.from.address === id &&
            o.lastActionAt &&
            message.receivedAt > o.lastActionAt
          ) {
            foundNew = true;
            break;
          }
        }
        if (foundNew) break;
      }
      if (foundNew) postLearningOriginators.push(o.anonKey);
    }
    const c2 = postLearningOriginators.length > 0;

    // 3. Positive importance adjustment (score > 0.5)
    const positiveOriginators = originatorEntries.filter((o) => o.score > NEUTRAL_IMPORTANCE);
    const c3 = positiveOriginators.length > 0;

    // 4. Negative importance adjustment (score < 0.5)
    const negativeOriginators = originatorEntries.filter((o) => o.score < NEUTRAL_IMPORTANCE);
    const c4 = negativeOriginators.length > 0;

    // 5. Close ranking decision changed by importance
    const neutralPriorityMap = new Map(neutralItems.map((i) => [i.id, i.priority]));
    const closeOrderFlips: string[] = [];
    for (const item of items) {
      const neutralP = neutralPriorityMap.get(item.id);
      if (neutralP !== undefined && Math.abs(item.priority - neutralP) > 0.01) {
        if (item.importance !== NEUTRAL_IMPORTANCE) {
          closeOrderFlips.push(
            `${item.id} (priority ${neutralP.toFixed(2)} -> ${item.priority.toFixed(2)}, importance ${item.importance.toFixed(2)})`,
          );
        }
      }
    }
    const c5 = closeOrderFlips.length > 0;

    // 6. Urgent-but-less-important outranks important-but-less-urgent
    let urgentOutranksImportant = false;
    let urgentEvidenceStr = "";
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const higher = items[i]!;
        const lower = items[j]!;
        if (
          higher.importance <= NEUTRAL_IMPORTANCE &&
          lower.importance > NEUTRAL_IMPORTANCE &&
          higher.urgency > lower.urgency &&
          higher.priority > lower.priority
        ) {
          urgentOutranksImportant = true;
          urgentEvidenceStr = `${higher.id} (urgency ${higher.urgency.toFixed(2)}, neutral) outranks ${lower.id} (urgency ${lower.urgency.toFixed(2)}, importance ${lower.importance.toFixed(2)})`;
          break;
        }
      }
      if (urgentOutranksImportant) break;
    }
    const c6 = urgentOutranksImportant;

    // 7. Evidence-specific explanation text
    const explanationMatches = items
      .filter((i) => i.reason.includes("You've acted on more work") || i.reason.includes("You've dismissed more work"))
      .map((i) => i.reason);
    const c7 = explanationMatches.length > 0;

    // 8. Rebuild parity verification
    const bus2 = new InProcessEventBus();
    const context2 = new ProjectionHost(contextProjection);
    const attention2 = new ProjectionHost(attentionProjection);
    const importance2 = new ProjectionHost(personalImportanceProjection);
    const runtime2 = new OrionRuntime({
      bus: bus2,
      store,
      projections: [
        context2 as ProjectionHost<unknown>,
        attention2 as ProjectionHost<unknown>,
        importance2 as ProjectionHost<unknown>,
      ],
      logger,
    });
    await runtime2.rebuild();
    const itemsRebuilt = buildWorkItems({
      context: context2.state,
      attention: attention2.state,
      importance: importance2.state,
      now,
    });
    const c8 =
      items.length === itemsRebuilt.length &&
      items.every((it, idx) => {
        const reb = itemsRebuilt[idx];
        return reb && reb.id === it.id && Math.abs(reb.priority - it.priority) < 0.0001;
      });

    // --- Report Output ---

    console.log("## Personal Importance Dogfood Audit (#79)\n");
    console.log(`**Log stats**: ${store.count()} events | ${Object.keys(context.state.threads).length} threads | ${items.length} active Work Items\n`);

    console.log("### Evidence Checklist\n");
    console.log(`- [${c1 ? "x" : " "}] Decisive actions threshold: ${pastColdStart.length} originator(s) past cold-start (>= 2 Done/Dismiss).`);
    if (pastColdStart.length > 0) {
      for (const o of pastColdStart) {
        console.log(`  - ${o.anonKey}: acted=${o.acted}, dismissed=${o.dismissed}, score=${o.score.toFixed(3)}`);
      }
    }
    console.log(`- [${c2 ? "x" : " "}] Post-learning work: ${postLearningOriginators.length} originator(s) received new mail after initial disposition.`);
    if (postLearningOriginators.length > 0) {
      console.log(`  - New work from: ${postLearningOriginators.join(", ")}`);
    }
    console.log(`- [${c3 ? "x" : " "}] Positive importance adjustment: ${positiveOriginators.length} originator(s) scored > 0.5.`);
    if (positiveOriginators.length > 0) {
      for (const o of positiveOriginators) {
        console.log(`  - ${o.anonKey}: score=${o.score.toFixed(3)}`);
      }
    }
    console.log(`- [${c4 ? "x" : " "}] Negative importance adjustment: ${negativeOriginators.length} originator(s) scored < 0.5.`);
    if (negativeOriginators.length > 0) {
      for (const o of negativeOriginators) {
        console.log(`  - ${o.anonKey}: score=${o.score.toFixed(3)}`);
      }
    }
    console.log(`- [${c5 ? "x" : " "}] Close ranking decision changed: ${closeOrderFlips.length} item(s) shifted by Personal Importance.`);
    if (closeOrderFlips.length > 0) {
      for (const f of closeOrderFlips) {
        console.log(`  - ${f}`);
      }
    }
    console.log(`- [${c6 ? "x" : " "}] Bounded weight safety: urgent item outranks lower-urgency personally important item.`);
    if (urgentOutranksImportant) {
      console.log(`  - Evidence: ${urgentEvidenceStr}`);
    }
    console.log(`- [${c7 ? "x" : " "}] Explanation text: ${explanationMatches.length} item(s) showing learned disposition reason.`);
    if (explanationMatches.length > 0) {
      console.log(`  - Sample reason: "${explanationMatches[0]}"`);
    }
    console.log(`- [${c8 ? "x" : " "}] Rebuild parity: Projections reconstruct identically from event log alone (ADR-0009).`);

    console.log("\n---\n*Generated by `npm run dogfood:check` (privacy-safe, read-only)*");
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
