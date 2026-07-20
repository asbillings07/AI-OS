import type { EventEnvelope } from "../events/index.js";
import type { Projection } from "../projection/index.js";
import {
  EventTypes,
  type EmailAddress,
  type MessageReceivedPayload,
  type WorkItemActionPayload,
  type WorkItemSnoozePayload,
} from "../domain/index.js";

/** A message as remembered inside Context, with a link back to its Event. */
export interface ObservedMessage {
  messageId: string;
  from: EmailAddress;
  subject: string;
  snippet: string;
  body: string;
  receivedAt: string;
  /** The Event this fact came from — the root of any Explanation (ADR-0005). */
  eventId: string;
}

export type ThreadStatus = "open" | "handled" | "snoozed" | "dismissed";

/** Orion's understanding of one conversation. */
export interface ThreadContext {
  threadId: string;
  subject: string;
  participants: string[];
  messages: ObservedMessage[];
  firstReceivedAt: string;
  lastReceivedAt: string;
  status: ThreadStatus;
  snoozedUntil?: string;
  /** The Event id of the most recent user action on this thread, if any. */
  lastActionEventId?: string;
}

/** Orion's understanding of one Person — the basis of Relationship strength. */
export interface PersonContext {
  address: string;
  name?: string;
  /** How many messages seen from this person; a proxy for relationship depth. */
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Context (ADR-0005): Orion's continuously-evolving understanding of the user's
 * situation, derived purely from Events. It is a projection, never a source of
 * truth — rebuild it from the log at any time.
 */
export interface ContextState {
  threads: Record<string, ThreadContext>;
  people: Record<string, PersonContext>;
}

function emptyContext(): ContextState {
  return { threads: {}, people: {} };
}

function applyMessageReceived(state: ContextState, event: EventEnvelope): ContextState {
  const payload = event.payload as MessageReceivedPayload;
  const existing = state.threads[payload.threadId];

  const message: ObservedMessage = {
    messageId: payload.messageId,
    from: payload.from,
    subject: payload.subject,
    snippet: payload.snippet,
    body: payload.body,
    receivedAt: payload.receivedAt,
    eventId: event.id,
  };

  const participants = new Set(existing?.participants ?? []);
  participants.add(payload.from.address);
  for (const recipient of payload.to) {
    participants.add(recipient.address);
  }

  const thread: ThreadContext = existing
    ? {
        ...existing,
        subject: existing.subject || payload.subject,
        participants: [...participants],
        messages: [...existing.messages, message],
        lastReceivedAt: payload.receivedAt,
        // A newer inbound message reopens a thread the user had put down.
        status: existing.status === "dismissed" ? "dismissed" : "open",
      }
    : {
        threadId: payload.threadId,
        subject: payload.subject,
        participants: [...participants],
        messages: [message],
        firstReceivedAt: payload.receivedAt,
        lastReceivedAt: payload.receivedAt,
        status: "open",
      };

  const person = state.people[payload.from.address];
  const updatedPerson: PersonContext = person
    ? {
        ...person,
        name: person.name ?? payload.from.name,
        messageCount: person.messageCount + 1,
        lastSeenAt: payload.receivedAt,
      }
    : {
        address: payload.from.address,
        name: payload.from.name,
        messageCount: 1,
        firstSeenAt: payload.receivedAt,
        lastSeenAt: payload.receivedAt,
      };

  return {
    threads: { ...state.threads, [payload.threadId]: thread },
    people: { ...state.people, [payload.from.address]: updatedPerson },
  };
}

function applyThreadStatus(
  state: ContextState,
  event: EventEnvelope,
  status: ThreadStatus,
): ContextState {
  const payload = event.payload as WorkItemActionPayload;
  const existing = state.threads[payload.threadId];
  if (!existing) {
    return state;
  }
  const snoozedUntil =
    status === "snoozed" ? (payload as WorkItemSnoozePayload).snoozedUntil : existing.snoozedUntil;
  return {
    ...state,
    threads: {
      ...state.threads,
      [payload.threadId]: {
        ...existing,
        status,
        snoozedUntil,
        lastActionEventId: event.id,
      },
    },
  };
}

export const contextProjection: Projection<ContextState> = {
  name: "context",
  init: emptyContext,
  apply: (state, event) => {
    switch (event.type) {
      case EventTypes.MessageReceived:
        return applyMessageReceived(state, event);
      case EventTypes.WorkItemActedOn:
        return applyThreadStatus(state, event, "handled");
      case EventTypes.WorkItemSnoozed:
        return applyThreadStatus(state, event, "snoozed");
      case EventTypes.WorkItemDismissed:
        return applyThreadStatus(state, event, "dismissed");
      default:
        return state;
    }
  },
};
