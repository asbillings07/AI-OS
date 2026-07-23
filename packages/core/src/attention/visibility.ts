import type { Opportunity } from "../opportunity/index.js";
import { subjectKey } from "../subject/index.js";
import { originatorKey } from "../domain/index.js";
import type { ContextState } from "../understanding/context.js";
import { originatorFor } from "../importance/index.js";
import type { AttentionDisposition, AttentionState } from "./projection.js";

/**
 * Whether a snooze window has passed (so the item is visible again). Fails OPEN:
 * a missing or malformed `snoozedUntil` yields visibility, because a corrupt event
 * must never permanently hide work.
 */
function snoozeElapsed(snoozedUntil: string | undefined, now: string): boolean {
  if (!snoozedUntil) return true;
  const until = new Date(snoozedUntil).getTime();
  if (!Number.isFinite(until)) return true;
  return until <= new Date(now).getTime();
}

/**
 * Whether the disposition's basis covers the Opportunity's *current* revision. If
 * every attention-basis id the user is being shown was part of the action, the
 * situation hasn't meaningfully changed and stays suppressed. A new revision (a
 * basis id the action didn't cover) is not covered, so the item resurfaces.
 */
function basisCovers(opportunity: Opportunity, basisEventIds: readonly string[]): boolean {
  return opportunity.attentionBasisEventIds.every((id) => basisEventIds.includes(id));
}

function isVisibleUnder(
  opportunity: Opportunity,
  disposition: AttentionDisposition,
  now: string,
): boolean {
  if (disposition.coverage === "evidence") {
    if (disposition.action === "snoozed") return snoozeElapsed(disposition.snoozedUntil, now);
    // acted / dismissed: hidden only while the current revision is fully covered.
    return !basisCovers(opportunity, disposition.basisEventIds);
  }
  // legacy-subject: a later inbound message reopens acted/snoozed threads.
  if (disposition.reopenedByEventId) return true;
  if (disposition.action === "dismissed") return false; // durable mute
  if (disposition.action === "snoozed") return snoozeElapsed(disposition.snoozedUntil, now);
  return false; // acted, not yet reopened
}

/**
 * The single presentation-suppression decision. Given reality-derived
 * Opportunities and the Attention projection, decide which ones the user should
 * see now. Pure and deterministic given `now`; it never changes understanding,
 * only presentation (the same Context under different AttentionState yields the
 * same raw Opportunities but different visible ones).
 */
export function isVisible(
  opportunity: Opportunity,
  attention: AttentionState,
  now: string,
  context: ContextState,
): boolean {
  if (attention.suppressedOriginators && Object.keys(attention.suppressedOriginators).length > 0) {
    const originator = originatorFor(opportunity.subject, context);
    if (originator) {
      const key = originatorKey(originator);
      if (attention.suppressedOriginators[key]) {
        return false;
      }
    }
  }

  const disposition = attention.dispositions[subjectKey(opportunity.subject)];
  if (!disposition) return true;
  return isVisibleUnder(opportunity, disposition, now);
}
