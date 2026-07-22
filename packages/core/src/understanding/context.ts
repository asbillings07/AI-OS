import type { EventEnvelope } from "../events/index.js";
import type { Projection } from "../projection/index.js";
import {
  EventTypes,
  type ActorRef,
  type AssignmentReceivedPayload,
  type CheckFailedPayload,
  type EmailAddress,
  type MessageReceivedPayload,
  type ReviewRequestedPayload,
  type WorkItemActionPayload,
  isCurrentActionPayload,
} from "../domain/index.js";
import { checkSubjectId } from "../subject/index.js";

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
  /**
   * The Event whose occurrence currently supplies the thread's display/attention
   * fields — the NEWEST inbound message by domain timestamp (Event-id tie-break),
   * never simply the last array element. A delayed poll can append an *older*
   * message; that grows `messages` for provenance but must not become the current
   * revision. Mirrors the OccurrenceContext contract used by collaborative work.
   */
  latestMessageEventId: string;
  status: ThreadStatus;
  snoozedUntil?: string;
  /** The Event id of the most recent user action on this thread, if any. */
  lastActionEventId?: string;
}

/**
 * The message that currently supplies a thread's display/attention fields: the
 * occurrence winner named by `latestMessageEventId`, NOT the last array element.
 * The single place "latest thread message" is defined, so Signals, Opportunities,
 * and AI summarization never invent their own (append-order) notion of latest.
 */
export function latestThreadMessage(thread: ThreadContext): ObservedMessage | undefined {
  return (
    thread.messages.find((message) => message.eventId === thread.latestMessageEventId) ??
    thread.messages[thread.messages.length - 1]
  );
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
 * Fields common to every collaborative-work subject Context remembers. Occurrence
 * ids accumulate (every contributing Event), while display fields reflect the
 * NEWEST source occurrence by domain timestamp — never by append order (a delayed
 * poll can deliver an older occurrence last). `latestEventId` names the winner and
 * is the deterministic tie-breaker for equal timestamps.
 */
interface OccurrenceContext {
  /** Every Event that has contributed to this subject, in arrival order. */
  eventIds: string[];
  /** The Event whose occurrence currently supplies the display fields. */
  latestEventId: string;
}

/** A change awaiting the user's review. Subject id = changeId. */
export interface ReviewContext extends OccurrenceContext {
  changeId: string;
  title: string;
  requestedBy?: ActorRef;
  location: string;
  url: string;
  requestedAt: string;
}

/** A unit of work the user was made responsible for. Subject id = itemId. */
export interface AssignmentContext extends OccurrenceContext {
  itemId: string;
  title: string;
  assignedBy?: ActorRef;
  location: string;
  url: string;
  assignedAt: string;
}

/** A failed check on the user's work. Subject id = changeId:check:checkName. */
export interface CheckContext extends OccurrenceContext {
  changeId: string;
  checkName: string;
  title: string;
  location: string;
  url: string;
  failedAt: string;
}

/**
 * Context (ADR-0005): Orion's continuously-evolving understanding of the user's
 * situation, derived purely from Events. It is a projection, never a source of
 * truth — rebuild it from the log at any time.
 *
 * Note (lifecycle): the vocabulary records obligation *appearing* (review
 * requested, assignment received, check failed) but not yet *disappearing*. So
 * `reviews`/`assignments`/`checks` are currently MONOTONIC — a subject, once
 * present, is not cleared by any source fact until resolution events exist.
 */
export interface ContextState {
  threads: Record<string, ThreadContext>;
  people: Record<string, PersonContext>;
  reviews: Record<string, ReviewContext>;
  assignments: Record<string, AssignmentContext>;
  checks: Record<string, CheckContext>;
}

function emptyContext(): ContextState {
  return { threads: {}, people: {}, reviews: {}, assignments: {}, checks: {} };
}

/**
 * Whether an incoming occurrence should supply display fields, comparing domain
 * timestamps (not append order) with a deterministic event-id tie-break.
 */
function occurrenceWins(
  incomingAt: string,
  incomingEventId: string,
  currentAt: string,
  currentEventId: string,
): boolean {
  const incoming = new Date(incomingAt).getTime();
  const current = new Date(currentAt).getTime();
  const incomingValid = Number.isFinite(incoming);
  const currentValid = Number.isFinite(current);
  // A valid timestamp always beats a malformed one, so a corrupt fact can never
  // pin stale display fields in place. Fall through to the id tie-break only when
  // both sides are comparable (both valid and equal, or both invalid).
  if (incomingValid !== currentValid) {
    return incomingValid;
  }
  if (incomingValid && incoming !== current) {
    return incoming > current;
  }
  return incomingEventId > currentEventId;
}

/** Append an event id once (occurrences are already deduped on the log by id). */
function withEventId(eventIds: string[] | undefined, eventId: string): string[] {
  if (!eventIds) return [eventId];
  return eventIds.includes(eventId) ? eventIds : [...eventIds, eventId];
}

function applyReviewRequested(state: ContextState, event: EventEnvelope): ContextState {
  const payload = event.payload as ReviewRequestedPayload;
  const key = payload.changeId;
  const existing = state.reviews[key];
  const eventIds = withEventId(existing?.eventIds, event.id);
  const wins =
    !existing ||
    occurrenceWins(payload.requestedAt, event.id, existing.requestedAt, existing.latestEventId);
  const review: ReviewContext = wins
    ? {
        changeId: payload.changeId,
        title: payload.title,
        requestedBy: payload.requestedBy,
        location: payload.location,
        url: payload.url,
        requestedAt: payload.requestedAt,
        eventIds,
        latestEventId: event.id,
      }
    : { ...existing, eventIds };
  return { ...state, reviews: { ...state.reviews, [key]: review } };
}

function applyAssignmentReceived(state: ContextState, event: EventEnvelope): ContextState {
  const payload = event.payload as AssignmentReceivedPayload;
  const key = payload.itemId;
  const existing = state.assignments[key];
  const eventIds = withEventId(existing?.eventIds, event.id);
  const wins =
    !existing ||
    occurrenceWins(payload.assignedAt, event.id, existing.assignedAt, existing.latestEventId);
  const assignment: AssignmentContext = wins
    ? {
        itemId: payload.itemId,
        title: payload.title,
        assignedBy: payload.assignedBy,
        location: payload.location,
        url: payload.url,
        assignedAt: payload.assignedAt,
        eventIds,
        latestEventId: event.id,
      }
    : { ...existing, eventIds };
  return { ...state, assignments: { ...state.assignments, [key]: assignment } };
}

function applyCheckFailed(state: ContextState, event: EventEnvelope): ContextState {
  const payload = event.payload as CheckFailedPayload;
  const key = checkSubjectId(payload.changeId, payload.checkName);
  const existing = state.checks[key];
  const eventIds = withEventId(existing?.eventIds, event.id);
  const wins =
    !existing || occurrenceWins(payload.failedAt, event.id, existing.failedAt, existing.latestEventId);
  const check: CheckContext = wins
    ? {
        changeId: payload.changeId,
        checkName: payload.checkName,
        title: payload.title,
        location: payload.location,
        url: payload.url,
        failedAt: payload.failedAt,
        eventIds,
        latestEventId: event.id,
      }
    : { ...existing, eventIds };
  return { ...state, checks: { ...state.checks, [key]: check } };
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

  // The incoming message becomes the current revision only if its occurrence wins
  // by domain time (Event-id tie-break) — so a backfilled older message is kept for
  // provenance but does not change the display fields or the attention basis.
  const incomingWins =
    !existing ||
    occurrenceWins(payload.receivedAt, event.id, existing.lastReceivedAt, existing.latestMessageEventId);

  const thread: ThreadContext = existing
    ? {
        ...existing,
        subject: existing.subject || payload.subject,
        participants: [...participants],
        messages: [...existing.messages, message],
        lastReceivedAt: incomingWins ? payload.receivedAt : existing.lastReceivedAt,
        latestMessageEventId: incomingWins ? event.id : existing.latestMessageEventId,
        // A new inbound message reopens a handled or snoozed thread the user had
        // put down. Dismissed is a durable mute — the user said this isn't worth
        // their attention — so it stays silent even if the conversation continues.
        status: existing.status === "dismissed" ? "dismissed" : "open",
        // snoozedUntil is metadata for the snoozed status only; reopening clears it.
        snoozedUntil: undefined,
      }
    : {
        threadId: payload.threadId,
        subject: payload.subject,
        participants: [...participants],
        messages: [message],
        firstReceivedAt: payload.receivedAt,
        lastReceivedAt: payload.receivedAt,
        latestMessageEventId: event.id,
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
    ...state,
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
  // Suppression authority moved to the Attention projection in #46. Context no
  // longer reacts to Subject-based (current) actions at all; it only replays the
  // legacy thread `status` field so old logs reconstruct byte-identically. Nothing
  // in ranking reads this field anymore, and this branch is removed once legacy
  // action events are retired.
  if (isCurrentActionPayload(payload)) {
    return state;
  }
  const existing = state.threads[payload.threadId];
  if (!existing) {
    return state;
  }
  // snoozedUntil is metadata for the snoozed status only. Clear it on any other
  // transition so a stale snooze window never lingers on a handled/dismissed thread.
  const snoozedUntil =
    status === "snoozed" ? (payload as { snoozedUntil?: string }).snoozedUntil : undefined;
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
      case EventTypes.ReviewRequested:
        return applyReviewRequested(state, event);
      case EventTypes.AssignmentReceived:
        return applyAssignmentReceived(state, event);
      case EventTypes.CheckFailed:
        return applyCheckFailed(state, event);
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
