import type { Opportunity } from "../opportunity/index.js";
import type { ContextState } from "./context.js";
import type { Signal } from "./signals.js";
import { detectWorkSignals } from "./work-signals.js";
import { subjectKey, type SubjectRef } from "./subject.js";

/**
 * Turn collaborative-work Signals into typed Opportunities. Deterministic given
 * `now`. Each subject yields exactly one Opportunity whose `kind` is locked to its
 * `subject.kind` by the discriminated union: review -> ReviewNeeded, assignment ->
 * AssignedActionNeeded, check -> RiskDetected.
 *
 * This is intentionally NOT called by buildWorkItems: the decision layer is
 * type-gated to thread Opportunities until #46 (see opportunity/index.ts
 * ThreadOpportunity and prioritize()). These Opportunities exist and are proven,
 * but cannot become Work Items yet.
 */

function computeValue(signals: readonly Signal[]): number {
  // The strongest significance sets the base; corroborating signals raise it.
  const base = Math.max(...signals.map((signal) => signal.strength));
  const boost = signals.reduce((sum, signal) => sum + signal.strength * 0.1, 0);
  return Math.min(1, base * 0.7 + boost);
}

function titleFor(context: ContextState, subject: SubjectRef): string {
  switch (subject.kind) {
    case "review":
      return context.reviews[subject.id]?.title ?? "Review requested";
    case "assignment":
      return context.assignments[subject.id]?.title ?? "Assigned work";
    case "check":
      return context.checks[subject.id]?.title ?? "Check failed";
    case "thread":
      return context.threads[subject.id]?.subject ?? "Conversation";
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
    const value = computeValue(group);
    const title = titleFor(context, subject);
    const evidence = group.map((signal) => signal.evidence);
    const createdFromEventIds = [...new Set(group.flatMap((signal) => signal.sourceEventIds))];

    switch (subject.kind) {
      case "review":
        opportunities.push({
          kind: "ReviewNeeded",
          subject: { kind: "review", id: subject.id },
          title,
          value,
          signals: group,
          evidence,
          createdFromEventIds,
        });
        break;
      case "assignment":
        opportunities.push({
          kind: "AssignedActionNeeded",
          subject: { kind: "assignment", id: subject.id },
          title,
          value,
          signals: group,
          evidence,
          createdFromEventIds,
        });
        break;
      case "check":
        opportunities.push({
          kind: "RiskDetected",
          subject: { kind: "check", id: subject.id },
          title,
          value,
          signals: group,
          evidence,
          createdFromEventIds,
        });
        break;
      case "thread":
        // detectWorkSignals never emits thread subjects; ignore defensively.
        break;
    }
  }

  return opportunities;
}
