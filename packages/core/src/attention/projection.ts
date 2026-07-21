import type { EventEnvelope } from "../events/index.js";
import type { Projection } from "../projection/index.js";
import {
  EventTypes,
  isCurrentActionPayload,
  type MessageReceivedPayload,
  type WorkItemActionPayload,
  type WorkItemSnoozePayload,
} from "../domain/index.js";
import { subjectKey, type SubjectRef } from "../subject/index.js";

/**
 * Attention (ADR-0012): the user's relationship to Orion's *presentation* of a
 * situation, kept strictly separate from Context (which is reality). This is the
 * single suppression authority — nothing in Context decides visibility anymore.
 *
 * A disposition is discriminated by coverage so legacy events replay honestly:
 *  - "evidence": a #46 action scoped to the exact revision the user saw
 *    (`basisEventIds`). A newer occurrence (a basis id the action didn't cover)
 *    resurfaces the item; a late-arriving older fact does not.
 *  - "legacy-subject": a pre-#46 thread action with no basis. It keeps the old
 *    semantics: `dismissed` is a durable mute; `acted`/`snoozed` are reopened by a
 *    later inbound message on that thread (`reopenedByEventId`). This is the ONLY
 *    reason the projection consumes MessageReceived, and it goes away when legacy
 *    action events are retired.
 */
export type AttentionAction = "acted" | "dismissed" | "snoozed";

export type AttentionDisposition =
  | {
      readonly coverage: "evidence";
      readonly subject: SubjectRef;
      readonly action: AttentionAction;
      readonly basisEventIds: readonly string[];
      readonly actionEventId: string;
      readonly snoozedUntil?: string;
    }
  | {
      readonly coverage: "legacy-subject";
      readonly subject: { readonly kind: "thread"; readonly id: string };
      readonly action: AttentionAction;
      readonly actionEventId: string;
      readonly snoozedUntil?: string;
      /** Set when a later MessageReceived reopened a legacy acted/snoozed thread. */
      readonly reopenedByEventId?: string;
    };

export interface AttentionState {
  /** Keyed by subjectKey. Latest action wins by append order (v0.1 contract). */
  readonly dispositions: Record<string, AttentionDisposition>;
}

function emptyAttention(): AttentionState {
  return { dispositions: {} };
}

const ACTION_FOR_TYPE: Record<string, AttentionAction> = {
  [EventTypes.WorkItemActedOn]: "acted",
  [EventTypes.WorkItemSnoozed]: "snoozed",
  [EventTypes.WorkItemDismissed]: "dismissed",
};

function applyAction(state: AttentionState, event: EventEnvelope, action: AttentionAction): AttentionState {
  const payload = event.payload as WorkItemActionPayload;
  const snoozedUntil =
    action === "snoozed" ? (payload as WorkItemSnoozePayload).snoozedUntil : undefined;

  const disposition: AttentionDisposition = isCurrentActionPayload(payload)
    ? {
        coverage: "evidence",
        subject: payload.subject,
        action,
        basisEventIds: [...payload.basisEventIds],
        actionEventId: event.id,
        snoozedUntil,
      }
    : {
        coverage: "legacy-subject",
        subject: { kind: "thread", id: payload.threadId },
        action,
        actionEventId: event.id,
        snoozedUntil,
      };

  // Append order is authoritative for user intent (single-process v0.1): the most
  // recent action on a subject wins, so we simply overwrite.
  return { dispositions: { ...state.dispositions, [subjectKey(disposition.subject)]: disposition } };
}

/**
 * Legacy migration only: a later inbound message reopens a legacy acted/snoozed
 * thread, mirroring the pre-#46 reopen-on-reply behavior. Legacy dismissed is a
 * durable mute and ignores inbound. Current (evidence) dispositions are untouched
 * — their resurfacing is handled by basis coverage, not by this event.
 */
function applyLegacyReopen(state: AttentionState, event: EventEnvelope): AttentionState {
  const payload = event.payload as MessageReceivedPayload;
  const key = subjectKey({ kind: "thread", id: payload.threadId });
  const existing = state.dispositions[key];
  if (!existing || existing.coverage !== "legacy-subject") return state;
  if (existing.action === "dismissed") return state;
  if (existing.reopenedByEventId) return state;
  return {
    dispositions: { ...state.dispositions, [key]: { ...existing, reopenedByEventId: event.id } },
  };
}

export const attentionProjection: Projection<AttentionState> = {
  name: "attention",
  init: emptyAttention,
  apply: (state, event) => {
    const action = ACTION_FOR_TYPE[event.type];
    if (action) return applyAction(state, event, action);
    if (event.type === EventTypes.MessageReceived) return applyLegacyReopen(state, event);
    return state;
  },
};
