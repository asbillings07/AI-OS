import type { Opportunity } from "../opportunity/index.js";
import type { ContextState } from "./context.js";
import type { Signal } from "./signals.js";
import { detectWorkSignals } from "./work-signals.js";
import { subjectKey, type SubjectRef } from "../subject/index.js";

/**
 * Turn collaborative-work Signals into typed Opportunities. Deterministic given
 * `now`. Each subject yields exactly one Opportunity whose `kind` is locked to its
 * `subject.kind` by the discriminated union: review -> ReviewNeeded, assignment ->
 * AssignedActionNeeded, check -> RiskDetected.
 *
 * buildWorkItems() composes these with the conversation detector
 * (opportunity/index.ts) into one source-neutral ranked list (#46): a review,
 * assignment, or check becomes a Work Item through exactly the same path as a
 * conversation.
 */

function strength(signals: readonly Signal[], kind: Signal["kind"]): number {
  return signals.find((signal) => signal.kind === kind)?.strength ?? 0;
}

/**
 * Opportunity value answers only "is there value in acting?". It is derived
 * SOLELY from the subject-defining significance Signal. Commitment and Aging stay
 * attached to the Opportunity (for explanation and prioritization) but must NOT
 * inflate value — otherwise the Prioritization Engine would double-count them as
 * responsibility and urgency when it ranks these Opportunities.
 */
function opportunityValue(signals: readonly Signal[]): number {
  return Math.max(
    strength(signals, "PendingReview"),
    strength(signals, "Assigned"),
    strength(signals, "CheckFailing"),
  );
}

interface Presentation {
  readonly title: string;
  readonly location?: string;
  readonly url?: string;
  /** The occurrence that currently supplies display fields — the attention revision. */
  readonly latestEventId?: string;
}

/**
 * Self-contained presentation for a subject, resolved from Context here (during
 * detection) so ranking never has to reopen Context. `latestEventId` is the
 * subject's current display occurrence and becomes the Opportunity's attention
 * revision.
 */
function presentationFor(context: ContextState, subject: SubjectRef): Presentation {
  switch (subject.kind) {
    case "review": {
      const c = context.reviews[subject.id];
      return { title: c?.title ?? "Review requested", location: c?.location, url: c?.url, latestEventId: c?.latestEventId };
    }
    case "assignment": {
      const c = context.assignments[subject.id];
      return { title: c?.title ?? "Assigned work", location: c?.location, url: c?.url, latestEventId: c?.latestEventId };
    }
    case "check": {
      const c = context.checks[subject.id];
      return { title: c?.title ?? "Check failed", location: c?.location, url: c?.url, latestEventId: c?.latestEventId };
    }
    case "thread": {
      const c = context.threads[subject.id];
      return { title: c?.subject ?? "Conversation" };
    }
  }
}

export function detectWorkOpportunities(context: ContextState, now: string): Opportunity[] {
  const signals = detectWorkSignals(context, now);

  const bySubject = new Map<string, Signal[]>();
  for (const signal of signals) {
    const key = subjectKey(signal.subject);
    const existing = bySubject.get(key) ?? [];
    existing.push(signal);
    bySubject.set(key, existing);
  }

  const opportunities: Opportunity[] = [];
  for (const group of bySubject.values()) {
    const subject = group[0]!.subject;
    const value = opportunityValue(group);
    const { title, location, url, latestEventId } = presentationFor(context, subject);
    const evidence = group.map((signal) => signal.evidence);
    const createdFromEventIds = [...new Set(group.flatMap((signal) => signal.sourceEventIds))];
    // The attention revision is the subject's current display occurrence; fall
    // back to full provenance only if Context somehow lacks it.
    const attentionBasisEventIds = latestEventId ? [latestEventId] : createdFromEventIds;
    const common = { title, location, url, value, signals: group, evidence, createdFromEventIds, attentionBasisEventIds };

    switch (subject.kind) {
      case "review":
        opportunities.push({ kind: "ReviewNeeded", subject: { kind: "review", id: subject.id }, ...common });
        break;
      case "assignment":
        opportunities.push({ kind: "AssignedActionNeeded", subject: { kind: "assignment", id: subject.id }, ...common });
        break;
      case "check":
        opportunities.push({ kind: "RiskDetected", subject: { kind: "check", id: subject.id }, ...common });
        break;
      case "thread":
        // detectWorkSignals never emits thread subjects; ignore defensively.
        break;
    }
  }

  return opportunities;
}
