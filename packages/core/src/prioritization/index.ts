import type { ContextState } from "../understanding/context.js";
import { detectOpportunities, type Opportunity } from "../opportunity/index.js";
import { estimateCapacity, type Capacity } from "../capacity/index.js";
import type { Signal } from "../understanding/signals.js";
import { LogEvents, nullLogger, type Logger } from "../observability/index.js";

export type WorkItemBand = "needs_attention" | "can_wait";

/**
 * A Work Item (ADR-0003): the canonical unit of "this matters." Its Explanation
 * is *structured*, not a string — `reason` + `evidence` + `createdFromEventIds`
 * let Mission Control answer "Why is this here?" entirely from deterministic
 * reasoning (no AI required). `summary` is the only AI-derived, advisory field.
 */
export interface WorkItem {
  id: string;
  threadId: string;
  title: string;
  band: WorkItemBand;
  /** Final rank score, 0..1. */
  priority: number;
  // The four independent reasoning inputs, kept separate (never a product).
  opportunity: number;
  capacity: number;
  commitment: number;
  urgency: number;
  /** One-line deterministic explanation of why this is here. */
  reason: string;
  /** The full deterministic justification chain. */
  evidence: string[];
  /** The Events this Work Item ultimately traces back to. */
  createdFromEventIds: string[];
  /** Advisory AI summary (optional; explanation never depends on it). */
  summary?: string;
  summaryConfidence?: number;
}

function signalStrength(signals: Signal[], kind: Signal["kind"]): number {
  return signals.find((signal) => signal.kind === kind)?.strength ?? 0;
}

function buildReason(signals: Signal[]): string {
  const parts = ["You have not replied to this conversation."];
  if (signalStrength(signals, "DirectQuestion") > 0) {
    parts.push("It asks a direct question.");
  }
  if (signalStrength(signals, "FromKnownPerson") > 0) {
    parts.push("It's from someone you correspond with.");
  }
  if (signalStrength(signals, "Aging") > 0) {
    parts.push("It has been waiting a while.");
  }
  return parts.join(" ");
}

/**
 * Rank Opportunities into Work Items. The four inputs are weighed as a
 * transparent weighted blend (NOT the product `o×c×m×u`, which would overclaim
 * precision, per #29). Capacity is deliberately kept OUT of the intrinsic score
 * and instead raises the attention bar: when the user cannot act well, fewer
 * items earn "needs attention", and they resurface when Capacity improves.
 */
export function prioritize(
  opportunities: Opportunity[],
  capacity: Capacity,
  context: ContextState,
): WorkItem[] {
  // Capacity sets the bar for attention (not the intrinsic score): plenty of
  // capacity -> a lower bar; little capacity -> a high bar, so only the most
  // valuable items interrupt and the rest wait for a better window.
  const attentionThreshold = 0.35 + (1 - capacity.level) * 0.35;

  const items = opportunities.map((opportunity): WorkItem => {
    const signals = opportunity.signals;
    const commitment = signalStrength(signals, "FromKnownPerson");
    const urgency = Math.max(
      signalStrength(signals, "Aging"),
      signalStrength(signals, "DirectQuestion") > 0 ? 0.4 : 0.2,
    );
    const priority = Math.max(
      0,
      Math.min(1, 0.45 * opportunity.value + 0.25 * urgency + 0.3 * commitment),
    );
    const thread = context.threads[opportunity.threadId];

    return {
      id: `wi-${opportunity.threadId}`,
      threadId: opportunity.threadId,
      title: thread?.subject ?? "Conversation",
      band: priority >= attentionThreshold ? "needs_attention" : "can_wait",
      priority,
      opportunity: opportunity.value,
      capacity: capacity.level,
      commitment,
      urgency,
      reason: buildReason(signals),
      evidence: opportunity.evidence,
      createdFromEventIds: opportunity.createdFromEventIds,
    };
  });

  return items.sort((a, b) => b.priority - a.priority);
}

/**
 * The full deterministic prioritization pipeline: Context in, ranked Work Items
 * out. No AI, no clock — pure and reproducible given `now`. AI summaries are
 * layered on afterward by the application, never here.
 *
 * The optional logger only observes; it never changes the result. It defaults to
 * a no-op so the pipeline stays pure and quiet unless a caller opts in.
 */
export function buildWorkItems(
  context: ContextState,
  now: string,
  logger: Logger = nullLogger,
): WorkItem[] {
  const opportunities = detectOpportunities(context, now);
  for (const opportunity of opportunities) {
    logger.event(LogEvents.OpportunityDetected, {
      kind: opportunity.kind,
      threadId: opportunity.threadId,
      value: opportunity.value,
    });
  }
  const capacity = estimateCapacity(now, context);
  const items = prioritize(opportunities, capacity, context);
  for (const item of items) {
    logger.event(LogEvents.WorkItemSurfaced, {
      id: item.id,
      band: item.band,
      priority: item.priority,
    });
  }
  return items;
}
