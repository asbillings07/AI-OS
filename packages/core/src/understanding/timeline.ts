import type { EventEnvelope } from "../events/index.js";
import type { Projection } from "../projection/index.js";
import {
  EventTypes,
  isCurrentActionPayload,
  type MessageReceivedPayload,
  type WorkItemActionPayload,
} from "../domain/index.js";
import type { SubjectRef } from "../subject/index.js";

/** One moment on the Timeline — a readable point in Orion's history. */
export interface TimelineEntry {
  at: string;
  eventId: string;
  threadId?: string;
  /** The Subject this moment concerns (source-neutral), when known. */
  subject?: SubjectRef;
  label: string;
}

/** The Subject an action concerned: the current payload's, or a legacy thread. */
function actionSubject(payload: WorkItemActionPayload): SubjectRef {
  return isCurrentActionPayload(payload) ? payload.subject : { kind: "thread", id: payload.threadId };
}

export type TimelineState = TimelineEntry[];

/**
 * Timeline (ubiquitous language): the ordered, temporal view of Events —
 * Orion's history laid out in time. Minimal for v0.1: notable moments only,
 * in recorded order.
 */
export const timelineProjection: Projection<TimelineState> = {
  name: "timeline",
  init: () => [],
  apply: (state, event) => {
    const entry = describe(event);
    return entry ? [...state, entry] : state;
  },
};

function describe(event: EventEnvelope): TimelineEntry | null {
  switch (event.type) {
    case EventTypes.MessageReceived: {
      const payload = event.payload as MessageReceivedPayload;
      return {
        at: payload.receivedAt,
        eventId: event.id,
        threadId: payload.threadId,
        label: `Message from ${payload.from.name ?? payload.from.address}: "${payload.subject}"`,
      };
    }
    case EventTypes.WorkItemActedOn: {
      const subject = actionSubject(event.payload as WorkItemActionPayload);
      return { at: event.occurredAt, eventId: event.id, subject, label: "You handled a Work Item" };
    }
    case EventTypes.WorkItemSnoozed: {
      const subject = actionSubject(event.payload as WorkItemActionPayload);
      return { at: event.occurredAt, eventId: event.id, subject, label: "You snoozed a Work Item" };
    }
    case EventTypes.WorkItemDismissed: {
      const subject = actionSubject(event.payload as WorkItemActionPayload);
      return { at: event.occurredAt, eventId: event.id, subject, label: "You dismissed a Work Item" };
    }
    default:
      return null;
  }
}
