import type { ContextState } from "../understanding/context.js";
import { detectSignals, type Signal } from "../understanding/signals.js";
import { subjectKey, type SubjectRef } from "../understanding/subject.js";

/**
 * An Opportunity (ubiquitous language): a proactively detected situation worth
 * acting on. It answers ONE question — *is there value in acting?* — and nothing
 * about the user's ability to act now (that is Capacity) or how it ranks (that
 * is Prioritization). Kept separate on purpose (#26).
 *
 * The model is a discriminated union so an Opportunity's `kind` and its
 * `subject.kind` are locked together in the type system: a `RiskDetected` is
 * always about a `check`, never a `thread`. Opportunity kinds name the
 * *interpretation* and deliberately never shadow an `EventTypes` fact name — the
 * fact `ReviewRequested` becomes the Opportunity `ReviewNeeded`, and so on.
 */
export interface OpportunityBase<TKind extends string, TSubject extends SubjectRef> {
  readonly kind: TKind;
  readonly subject: TSubject;
  /** Display title for this Opportunity's subject (carried, not looked up later). */
  readonly title: string;
  /** 0..1 — how much value there is in acting. Not a priority. */
  readonly value: number;
  /** The Signals this Opportunity was derived from. */
  readonly signals: readonly Signal[];
  /** Human-readable reasons, carried from the Signals for later Explanation. */
  readonly evidence: readonly string[];
  readonly createdFromEventIds: readonly string[];
}

export type Opportunity =
  | OpportunityBase<"ReplyNeeded", { readonly kind: "thread"; readonly id: string }>
  | OpportunityBase<"ReviewNeeded", { readonly kind: "review"; readonly id: string }>
  | OpportunityBase<"AssignedActionNeeded", { readonly kind: "assignment"; readonly id: string }>
  | OpportunityBase<"RiskDetected", { readonly kind: "check"; readonly id: string }>;

/** The subset the (still email-shaped) decision layer can consume. See prioritize(). */
export type ThreadOpportunity = Extract<Opportunity, { subject: { kind: "thread" } }>;

function groupBySubject(signals: Signal[]): Map<string, Signal[]> {
  const grouped = new Map<string, Signal[]>();
  for (const signal of signals) {
    const key = subjectKey(signal.subject);
    const existing = grouped.get(key) ?? [];
    existing.push(signal);
    grouped.set(key, existing);
  }
  return grouped;
}

/**
 * Derive thread (email) Opportunities from Context. Deterministic given `now`. A
 * thread yields a ReplyNeeded Opportunity only if it is actually awaiting a
 * reply; automated / low-value threads (which carry no AwaitingReply Signal)
 * yield nothing — silence is a valid output.
 *
 * Returns `ThreadOpportunity[]` on purpose: the decision layer is type-gated to
 * thread subjects until #46, so this feeds it directly. GitHub work is derived
 * separately (see understanding/work-opportunities.ts) and cannot flow here.
 */
export function detectOpportunities(context: ContextState, now: string): ThreadOpportunity[] {
  const signals = detectSignals(context, now);
  const bySubject = groupBySubject(signals);
  const opportunities: ThreadOpportunity[] = [];

  for (const threadSignals of bySubject.values()) {
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
    const threadId = awaiting.subject.id;
    const thread = context.threads[threadId];

    opportunities.push({
      kind: "ReplyNeeded",
      subject: { kind: "thread", id: threadId },
      title: thread?.subject || "Conversation",
      value,
      signals: threadSignals,
      evidence: threadSignals.map((signal) => signal.evidence),
      createdFromEventIds: sourceEventIds,
    });
  }

  return opportunities;
}
