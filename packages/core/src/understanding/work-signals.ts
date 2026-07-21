import type { ContextState } from "./context.js";
import type { Signal } from "./signals.js";
import { checkSubjectId, type SubjectRef } from "./subject.js";

/**
 * Signals for collaborative work (reviews, assignments, failed checks). These are
 * the GitHub-origin counterparts to the conversation Signals in signals.ts, but
 * nothing here knows about GitHub — they read only domain Context (Eng #8).
 *
 * Like all Signals they are deterministic given `now` and carry their own
 * evidence + source Event ids so "why is this here?" is answerable without AI.
 */

/** Age at which a pending item is considered maximally overdue. */
const AGING_CAP_HOURS = 72;

function elapsedHours(fromIso: string, now: string): number {
  return (new Date(now).getTime() - new Date(fromIso).getTime()) / 3_600_000;
}

/**
 * Deterministic Aging: linear from 0 at creation to 1 at AGING_CAP_HOURS. Negative
 * elapsed time (a future-dated fact) clamps to 0; strength clamps to [0,1]. Yields
 * no Signal until at least an hour has passed, so a just-arrived fact isn't "aging".
 */
function agingSignal(
  subject: SubjectRef,
  startedAt: string,
  now: string,
  sourceEventIds: string[],
): Signal | null {
  const elapsed = elapsedHours(startedAt, now);
  // Defend the pure detector against a malformed durable timestamp: NaN survives
  // Math.max/Math.min and would otherwise yield a "Waiting for NaN hour(s)" Signal.
  if (!Number.isFinite(elapsed)) return null;
  const ageHours = Math.max(0, elapsed);
  const strength = Math.min(1, ageHours / AGING_CAP_HOURS);
  if (ageHours < 1) return null;
  const days = Math.floor(ageHours / 24);
  const evidence =
    days >= 1 ? `Waiting for ${days} day(s).` : `Waiting for ${Math.floor(ageHours)} hour(s).`;
  return { kind: "Aging", subject, strength, evidence, sourceEventIds };
}

function actorName(actor: { externalId: string; displayName?: string } | undefined): string | null {
  if (!actor) return null;
  return actor.displayName ?? actor.externalId;
}

/**
 * Derive collaborative-work Signals from Context. Pure and deterministic given
 * `now`. Reviews and assignments carry an explicit Commitment (an obligation the
 * user has taken on); a failed check is a risk, not an obligation, so it carries
 * no Commitment.
 */
export function detectWorkSignals(context: ContextState, now: string): Signal[] {
  const signals: Signal[] = [];

  for (const review of Object.values(context.reviews)) {
    const subject: SubjectRef = { kind: "review", id: review.changeId };
    const eventIds = review.eventIds;
    signals.push({
      kind: "PendingReview",
      subject,
      strength: 0.9,
      evidence: `A review was requested from you on ${review.location}.`,
      sourceEventIds: eventIds,
    });
    const who = actorName(review.requestedBy);
    signals.push({
      kind: "Commitment",
      subject,
      strength: 0.8,
      evidence: who ? `${who} is waiting on your review.` : "Someone is waiting on your review.",
      sourceEventIds: eventIds,
    });
    const aging = agingSignal(subject, review.requestedAt, now, eventIds);
    if (aging) signals.push(aging);
  }

  for (const assignment of Object.values(context.assignments)) {
    const subject: SubjectRef = { kind: "assignment", id: assignment.itemId };
    const eventIds = assignment.eventIds;
    signals.push({
      kind: "Assigned",
      subject,
      strength: 0.9,
      evidence: `You were assigned ${assignment.location}.`,
      sourceEventIds: eventIds,
    });
    const who = actorName(assignment.assignedBy);
    signals.push({
      kind: "Commitment",
      subject,
      strength: 0.9,
      evidence: who ? `${who} made this your responsibility.` : "This is your responsibility.",
      sourceEventIds: eventIds,
    });
    const aging = agingSignal(subject, assignment.assignedAt, now, eventIds);
    if (aging) signals.push(aging);
  }

  for (const check of Object.values(context.checks)) {
    const subject: SubjectRef = {
      kind: "check",
      id: checkSubjectId(check.changeId, check.checkName),
    };
    const eventIds = check.eventIds;
    signals.push({
      kind: "CheckFailing",
      subject,
      strength: 0.95,
      evidence: `${check.checkName} failed on ${check.location}.`,
      sourceEventIds: eventIds,
    });
    const aging = agingSignal(subject, check.failedAt, now, eventIds);
    if (aging) signals.push(aging);
  }

  return signals;
}
