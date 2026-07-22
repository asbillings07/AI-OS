import type { EventEnvelope } from "../events/index.js";
import type { Projection } from "../projection/index.js";
import {
  EventTypes,
  isCurrentActionPayload,
  originatorKey,
  type OriginatorRef,
  type WorkItemActionPayload,
} from "../domain/index.js";
import type { SubjectRef } from "../subject/index.js";
import { latestThreadMessage, type ContextState } from "../understanding/context.js";

/**
 * Personal Importance (#65): a bounded, ranking-specific behavioral signal learned
 * from the user's recorded dispositions — NOT an authoritative User Preference or
 * an established belief about the user (see ADR-0014). It answers one narrow
 * question at ranking time: "does the user tend to act on, or dismiss, work from
 * this originator?"
 *
 * It is learned against an immutable, source-neutral `OriginatorRef` stamped onto
 * each action Event at record time, so this projection reads a uniform key and
 * never re-opens Context, branches on source, or queries mutable Skill data.
 * Cross-source identity is deliberately NOT assumed: keys stay per-namespace.
 */

/** What the projection knows about one originator's disposition history. */
export interface OriginatorImportance {
  /** Times the user acted on work from this originator. */
  readonly acted: number;
  /** Times the user dismissed work from this originator. */
  readonly dismissed: number;
  /** Times the user snoozed work from this originator (recorded, never scored). */
  readonly snoozed: number;
  /**
   * `occurredAt` of the last qualifying (acted/dismissed) action in authoritative
   * append order. Defined for future decay/recency use; unused by v1 scoring.
   */
  readonly lastActionAt?: string;
  /**
   * The acted/dismissed action-Event ids that moved this score — importance
   * provenance, exposed on the Work Item separately from `attentionBasisEventIds`
   * (which is the presentation revision). Snoozes are excluded: they never score.
   */
  readonly evidenceEventIds: readonly string[];
}

export interface PersonalImportanceState {
  /** Keyed by `originatorKey`. */
  readonly byOriginator: Record<string, OriginatorImportance>;
}

/** Neutral score: no evidence either way. */
export const NEUTRAL_IMPORTANCE = 0.5;

function emptyImportance(): PersonalImportanceState {
  return { byOriginator: {} };
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The v1 Personal Importance score in `[0,1]`, `0.5` = neutral.
 *
 * A minimum of two *decisive* actions (acted or dismissed) is required before the
 * score moves off neutral, so a single click can't swing ranking and new/sparse
 * originators keep today's behavior (no cold-start penalty). Movement is gradual
 * and symmetric — two acts -> 0.75, two dismissals -> 0.25, balanced -> 0.5 —
 * approaching but never reaching the extremes. Snoozes are intentionally excluded:
 * "relevant, but not now" is not negative feedback.
 *
 * Pure function of integer counts, so the whole signal rebuilds deterministically
 * from the log (ADR-0009).
 */
export function importanceScore(counts: { readonly acted: number; readonly dismissed: number }): number {
  const decisive = counts.acted + counts.dismissed;
  if (decisive < 2) return NEUTRAL_IMPORTANCE;
  return clamp(0, 1, NEUTRAL_IMPORTANCE + (counts.acted - counts.dismissed) / (2 * (decisive + 2)));
}

/** The score for one originator, neutral when unknown/absent. */
export function importanceFor(
  state: PersonalImportanceState,
  originator: OriginatorRef | null | undefined,
): number {
  if (!originator) return NEUTRAL_IMPORTANCE;
  const entry = state.byOriginator[originatorKey(originator)];
  return entry ? importanceScore(entry) : NEUTRAL_IMPORTANCE;
}

interface ResolvedOriginator {
  readonly originator: OriginatorRef;
  /** Human-readable name for explanation only; never part of the identity key. */
  readonly displayName: string;
}

/**
 * Resolve who a Subject's current revision is *from* — the shared lookup behind
 * both `originatorFor` (identity) and `importanceContributionFor` (identity +
 * score + display name), so the Subject-kind switch exists in exactly one place.
 *
 * The namespace always comes from the winning occurrence's stored `source`, never
 * from `Subject.kind`: a thread is not always Gmail, an assignment not always
 * GitHub. For a thread the originator is the newest inbound message by occurrence
 * time (`latestThreadMessage`), so a late-arriving older message never restamps a
 * thread's originator, while a genuinely new sender does for the new revision.
 */
function resolveOriginator(subject: SubjectRef, context: ContextState): ResolvedOriginator | null {
  switch (subject.kind) {
    case "thread": {
      const thread = context.threads[subject.id];
      const message = thread ? latestThreadMessage(thread) : undefined;
      if (!message) return null;
      return {
        originator: { namespace: message.source, id: message.from.address },
        displayName: message.from.name ?? message.from.address,
      };
    }
    case "review": {
      const review = context.reviews[subject.id];
      if (!review?.requestedBy) return null;
      return {
        originator: { namespace: review.latestSource, id: review.requestedBy.externalId },
        displayName: review.requestedBy.displayName ?? review.requestedBy.externalId,
      };
    }
    case "assignment": {
      const assignment = context.assignments[subject.id];
      if (!assignment?.assignedBy) return null;
      return {
        originator: { namespace: assignment.latestSource, id: assignment.assignedBy.externalId },
        displayName: assignment.assignedBy.displayName ?? assignment.assignedBy.externalId,
      };
    }
    case "check":
      // An automated check has no originating person; importance stays neutral.
      return null;
    default:
      return null;
  }
}

/**
 * Resolve who a Subject's current revision is *from*, as a source-neutral
 * `OriginatorRef`, or `null` when there is no meaningful originator (a failing
 * check has no person; an unknown subject resolves to nothing -> neutral).
 */
export function originatorFor(subject: SubjectRef, context: ContextState): OriginatorRef | null {
  return resolveOriginator(subject, context)?.originator ?? null;
}

/** The Context-independent input `prioritize()` receives for one Work Item. */
export interface ImportanceContribution {
  /** The learned score in `[0,1]`; `0.5` = neutral. */
  readonly score: number;
  /** The acted/dismissed action-Event ids backing this score (empty if neutral). */
  readonly evidenceEventIds: readonly string[];
  /** Human-readable originator name, for explanation only. */
  readonly originatorName: string;
}

/**
 * The numeric Personal Importance contribution for one Subject's *current*
 * revision — the score, its evidence provenance, and a display name for
 * explanation — or `null` when there is no meaningful originator (ranking then
 * simply omits the term, equivalent to neutral).
 *
 * This is the ONLY function that touches both Context and `PersonalImportanceState`;
 * its result is plain, serializable data, which is what lets `prioritize()` stay
 * independent of Context (#65) — it receives this contribution, never Context or
 * the importance state itself.
 */
export function importanceContributionFor(
  subject: SubjectRef,
  context: ContextState,
  state: PersonalImportanceState,
): ImportanceContribution | null {
  const resolved = resolveOriginator(subject, context);
  if (!resolved) return null;
  const entry = state.byOriginator[originatorKey(resolved.originator)];
  return {
    score: entry ? importanceScore(entry) : NEUTRAL_IMPORTANCE,
    evidenceEventIds: entry ? entry.evidenceEventIds : [],
    originatorName: resolved.displayName,
  };
}

const CATEGORY_FOR_TYPE: Record<string, "acted" | "dismissed" | "snoozed"> = {
  [EventTypes.WorkItemActedOn]: "acted",
  [EventTypes.WorkItemSnoozed]: "snoozed",
  [EventTypes.WorkItemDismissed]: "dismissed",
};

function applyDisposition(
  state: PersonalImportanceState,
  event: EventEnvelope,
  category: "acted" | "dismissed" | "snoozed",
): PersonalImportanceState {
  const payload = event.payload as WorkItemActionPayload;
  // Only current (#46) payloads carry an originator. Legacy thread-only actions,
  // and any action with no resolvable originator, contribute nothing -> neutral.
  if (!isCurrentActionPayload(payload) || !payload.originator) return state;

  const key = originatorKey(payload.originator);
  const existing =
    state.byOriginator[key] ?? { acted: 0, dismissed: 0, snoozed: 0, evidenceEventIds: [] };

  const isDecisive = category !== "snoozed";
  const updated: OriginatorImportance = {
    acted: existing.acted + (category === "acted" ? 1 : 0),
    dismissed: existing.dismissed + (category === "dismissed" ? 1 : 0),
    snoozed: existing.snoozed + (category === "snoozed" ? 1 : 0),
    lastActionAt: isDecisive ? event.occurredAt : existing.lastActionAt,
    evidenceEventIds: isDecisive
      ? [...existing.evidenceEventIds, event.id]
      : existing.evidenceEventIds,
  };

  return { byOriginator: { ...state.byOriginator, [key]: updated } };
}

/**
 * The Personal Importance projection (#65, ADR-0014): folds recorded dispositions
 * into per-originator counts. Source-neutral by construction — it reads only the
 * stamped `OriginatorRef`, so a Gmail sender and a GitHub actor with identical
 * histories yield identical scores. Rebuildable from the log at any time.
 */
export const personalImportanceProjection: Projection<PersonalImportanceState> = {
  name: "personal-importance",
  init: emptyImportance,
  apply: (state, event) => {
    const category = CATEGORY_FOR_TYPE[event.type];
    return category ? applyDisposition(state, event, category) : state;
  },
};
