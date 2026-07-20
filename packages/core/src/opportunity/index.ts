import type { ContextState } from "../understanding/context.js";
import { detectSignals, type Signal } from "../understanding/signals.js";

/**
 * An Opportunity (ubiquitous language): a proactively detected situation worth
 * acting on. It answers ONE question — *is there value in acting?* — and nothing
 * about the user's ability to act now (that is Capacity) or how it ranks (that
 * is Prioritization). Kept separate on purpose (#26).
 */
export interface Opportunity {
  id: string;
  threadId: string;
  kind: "ReplyNeeded";
  /** 0..1 — how much value there is in acting. Not a priority. */
  value: number;
  /** The Signals this Opportunity was derived from. */
  signals: Signal[];
  /** Human-readable reasons, carried from the Signals for later Explanation. */
  evidence: string[];
  createdFromEventIds: string[];
}

function groupByThread(signals: Signal[]): Map<string, Signal[]> {
  const grouped = new Map<string, Signal[]>();
  for (const signal of signals) {
    const existing = grouped.get(signal.threadId) ?? [];
    existing.push(signal);
    grouped.set(signal.threadId, existing);
  }
  return grouped;
}

/**
 * Derive Opportunities from Context. Deterministic given `now`. A thread yields
 * a ReplyNeeded Opportunity only if it is actually awaiting a reply; automated /
 * low-value threads (which carry no AwaitingReply Signal) yield nothing —
 * silence is a valid output.
 */
export function detectOpportunities(context: ContextState, now: string): Opportunity[] {
  const signals = detectSignals(context, now);
  const byThread = groupByThread(signals);
  const opportunities: Opportunity[] = [];

  for (const [threadId, threadSignals] of byThread) {
    const awaiting = threadSignals.find((signal) => signal.kind === "AwaitingReply");
    if (!awaiting) {
      continue; // e.g. LikelyLowValue only — no value in acting.
    }

    // Value builds from the awaiting-reply base and is raised by corroborating
    // signals. Capped at 1. This measures VALUE, not priority.
    const boost = threadSignals
      .filter((signal) => signal.kind !== "AwaitingReply")
      .reduce((sum, signal) => sum + signal.strength * 0.25, 0);
    const value = Math.min(1, awaiting.strength * 0.6 + boost);

    const sourceEventIds = [...new Set(threadSignals.flatMap((signal) => signal.sourceEventIds))];

    opportunities.push({
      id: `opp-${threadId}`,
      threadId,
      kind: "ReplyNeeded",
      value,
      signals: threadSignals,
      evidence: threadSignals.map((signal) => signal.evidence),
      createdFromEventIds: sourceEventIds,
    });
  }

  return opportunities;
}
