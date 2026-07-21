import type { ContextState } from "../understanding/context.js";
import { detectOpportunities } from "../opportunity/index.js";
import type { Opportunity } from "../opportunity/index.js";
import { detectWorkOpportunities } from "../understanding/work-opportunities.js";
import { estimateCapacity, type Capacity } from "../capacity/index.js";
import type { Signal } from "../understanding/signals.js";
import { subjectKey, type SubjectRef } from "../subject/index.js";
import { isVisible, type AttentionState } from "../attention/index.js";
import { LogEvents, nullLogger, type Logger } from "../observability/index.js";

export type WorkItemBand = "needs_attention" | "can_wait";

/**
 * A Work Item (ADR-0003): the canonical unit of "this matters," now source-neutral.
 * It is about a `subject` (a conversation, a review, an assignment, a check), not a
 * vendor. Its Explanation is *structured* — `reason` + `evidence` +
 * `createdFromEventIds` let Mission Control answer "Why is this here?" entirely from
 * deterministic reasoning (no AI). `summary` is the only AI-derived, advisory field.
 */
export interface WorkItem {
  id: string;
  subject: SubjectRef;
  kind: Opportunity["kind"];
  title: string;
  /** Optional human-readable location for display, e.g. "acme/orion#128". */
  location?: string;
  /** Optional canonical link for display. */
  url?: string;
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
  /** The Events this Work Item ultimately traces back to (full provenance). */
  createdFromEventIds: string[];
  /** The current presentation revision the user is being shown (for actions). */
  attentionBasisEventIds: string[];
  /** Advisory AI summary (optional; explanation never depends on it). */
  summary?: string;
  summaryConfidence?: number;
}

/** Canonical Work Item id. Thread ids keep their historical `wi-<threadId>` form. */
export function workItemId(subject: SubjectRef): string {
  return subject.kind === "thread" ? `wi-${subject.id}` : `wi-${subjectKey(subject)}`;
}

function signalStrength(signals: readonly Signal[], kind: Signal["kind"]): number {
  return signals.find((signal) => signal.kind === kind)?.strength ?? 0;
}

/** Source-neutral lead line for each Opportunity kind. */
const LEAD_LINE: Record<Opportunity["kind"], string> = {
  ReplyNeeded: "You have not replied to this conversation.",
  ReviewNeeded: "A review is waiting on you.",
  AssignedActionNeeded: "You have been asked to take this on.",
  RiskDetected: "A check is failing on your work.",
};

/**
 * A deterministic, source-neutral one-line reason: the kind's lead line plus any
 * corroborating Signals that happen to be present. It consults Signal *kinds*, not
 * sources, so an email and a review are explained through the same vocabulary.
 */
function buildReason(kind: Opportunity["kind"], signals: readonly Signal[]): string {
  const parts = [LEAD_LINE[kind]];
  if (signalStrength(signals, "DirectQuestion") > 0) parts.push("It asks a direct question.");
  if (signalStrength(signals, "FromKnownPerson") > 0) parts.push("It's from someone you correspond with.");
  if (signalStrength(signals, "Commitment") > 0) parts.push("You've taken this on.");
  if (signalStrength(signals, "Aging") > 0) parts.push("It has been waiting a while.");
  return parts.join(" ");
}

/**
 * A deterministic, source-neutral ordering. Primary is priority; ties fall through
 * to the independent reasoning dimensions and finally to `subjectKey`, so the order
 * the detectors happened to run in can NEVER decide a tie (no email-first bias).
 */
export function compareWorkItems(a: WorkItem, b: WorkItem): number {
  return (
    b.priority - a.priority ||
    b.urgency - a.urgency ||
    b.commitment - a.commitment ||
    b.opportunity - a.opportunity ||
    subjectKey(a.subject).localeCompare(subjectKey(b.subject))
  );
}

/**
 * Rank Opportunities into Work Items. The four inputs are weighed as a
 * transparent weighted blend (NOT the product `o×c×m×u`, which would overclaim
 * precision, per #29). Capacity is deliberately kept OUT of the intrinsic score
 * and instead raises the attention bar: when the user cannot act well, fewer
 * items earn "needs attention", and they resurface when Capacity improves.
 *
 * Source-neutral: it consumes any Opportunity kind and never reopens Context (the
 * Opportunity already carries its own presentation fields).
 */
export function prioritize(opportunities: readonly Opportunity[], capacity: Capacity): WorkItem[] {
  const attentionThreshold = 0.35 + (1 - capacity.level) * 0.35;

  const items = opportunities.map((opportunity): WorkItem => {
    const signals = opportunity.signals;
    // The `commitment` input blends explicit obligation (a Commitment Signal, e.g.
    // an assignment or requested review) with relationship-derived expectation
    // (FromKnownPerson). They are not the same thing — one is a duty, the other is
    // social weight — and may split into separate dimensions later; for now the
    // stronger of the two carries.
    const responsibilityStrength = Math.max(
      signalStrength(signals, "Commitment"),
      signalStrength(signals, "FromKnownPerson"),
    );
    const urgency = Math.max(
      signalStrength(signals, "Aging"),
      signalStrength(signals, "DirectQuestion") > 0 ? 0.4 : 0.2,
    );
    const priority = Math.max(
      0,
      Math.min(1, 0.45 * opportunity.value + 0.25 * urgency + 0.3 * responsibilityStrength),
    );

    return {
      id: workItemId(opportunity.subject),
      subject: opportunity.subject,
      kind: opportunity.kind,
      title: opportunity.title,
      location: opportunity.location,
      url: opportunity.url,
      band: priority >= attentionThreshold ? "needs_attention" : "can_wait",
      priority,
      opportunity: opportunity.value,
      capacity: capacity.level,
      commitment: responsibilityStrength,
      urgency,
      reason: buildReason(opportunity.kind, signals),
      evidence: [...opportunity.evidence],
      createdFromEventIds: [...opportunity.createdFromEventIds],
      attentionBasisEventIds: [...opportunity.attentionBasisEventIds],
    };
  });

  return items.sort(compareWorkItems);
}

export interface BuildWorkItemsOptions {
  context: ContextState;
  attention: AttentionState;
  now: string;
  logger?: Logger;
}

/**
 * The full deterministic prioritization pipeline: reality + the user's attention
 * in, ranked Work Items out. Pure and reproducible given `now` — no AI, no clock.
 *
 * Reality-derived Opportunities from every detector are combined, then the
 * Attention projection decides which are *visible* (the sole suppression stage).
 * Capacity is estimated from the current attention demand (visible count), so
 * dismissed/snoozed work stops weighing on the user while hidden.
 *
 * The optional logger only observes; it never changes the result and defaults to a
 * no-op. Trace names are computation-oriented (`opportunity.evaluated`/
 * `workitem.ranked`) because this runs on every read/rebuild, not on a recorded
 * state transition.
 */
export function buildWorkItems(options: BuildWorkItemsOptions): WorkItem[] {
  const { context, attention, now } = options;
  const logger = options.logger ?? nullLogger;
  const tracing = logger !== nullLogger;

  const opportunities = [...detectOpportunities(context, now), ...detectWorkOpportunities(context, now)];
  const visible = opportunities.filter((opportunity) => isVisible(opportunity, attention, now));

  if (tracing) {
    for (const opportunity of visible) {
      logger.event(LogEvents.OpportunityEvaluated, {
        kind: opportunity.kind,
        subject: subjectKey(opportunity.subject),
        value: opportunity.value,
      });
    }
  }

  const capacity = estimateCapacity(now, { activeWorkCount: visible.length });
  const items = prioritize(visible, capacity);

  if (tracing) {
    for (const item of items) {
      logger.event(LogEvents.WorkItemRanked, {
        id: item.id,
        band: item.band,
        priority: item.priority,
      });
    }
  }

  return items;
}
