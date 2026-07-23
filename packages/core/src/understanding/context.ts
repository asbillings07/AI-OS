import type { EventEnvelope } from "../events/index.js";
import type { Projection } from "../projection/index.js";
import {
  EventTypes,
  type ActorRef,
  type AssignmentReceivedPayload,
  type CheckFailedPayload,
  type EmailAddress,
  type MessageReceivedPayload,
  type MessageSentPayload,
  type ReviewRequestedPayload,
  type WorkItemActionPayload,
  isCurrentActionPayload,
} from "../domain/index.js";
import { checkSubjectId } from "../subject/index.js";

/** A message as remembered inside Context, with a link back to its Event. */
export interface ObservedMessage {
  messageId: string;
  direction: "inbound" | "outbound";
  from: EmailAddress;
  subject: string;
  snippet: string;
  body: string;
  occurredAt: string;
  /** The Event this fact came from — the root of any Explanation (ADR-0005). */
  eventId: string;
  /**
   * The immutable `source` label of the Event this message came from (e.g.
   * `gmail-skill`). Preserved so a source-neutral originator namespace can be
   * derived from the winning occurrence without inferring it from `Subject.kind`
   * (a thread is not always Gmail).
   */
  source: string;
}

export type ThreadStatus = "open" | "handled" | "snoozed" | "dismissed";

/** Orion's understanding of one conversation. */
export interface ThreadContext {
  threadId: string;
  subject: string;
  participants: string[];
  messages: ObservedMessage[];
  firstMessageAt: string;
  lastMessageAt: string;
  /**
   * The Event whose occurrence currently supplies the thread's display/attention
   * fields — the NEWEST message by domain timestamp (Event-id tie-break),
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
  inboundCount: number;
  outboundCount: number;
  inboundEventIds: string[];
  outboundEventIds: string[];
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
  /**
   * The immutable `source` label of the winning occurrence (`latestEventId`).
   * Preserved so an originator namespace can be derived from the actual Source,
   * not inferred from `Subject.kind` (an assignment is not always GitHub).
   */
  latestSource: string;
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
        latestSource: event.source,
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
        latestSource: event.source,
      }
    : { ...existing, eventIds };
  return { ...state, assignments: { ...state.assignments, [key]: assignment } };
}

function updateTimestampBounds(
  currentFirst: string | undefined,
  currentLast: string | undefined,
  incomingAt: string,
): { firstSeenAt: string; lastSeenAt: string } {
  if (!currentFirst || !currentLast) {
    return { firstSeenAt: incomingAt, lastSeenAt: incomingAt };
  }
  const incomingTime = new Date(incomingAt).getTime();
  const firstTime = new Date(currentFirst).getTime();
  const lastTime = new Date(currentLast).getTime();

  const firstSeenAt =
    Number.isFinite(incomingTime) && Number.isFinite(firstTime) && incomingTime < firstTime
      ? incomingAt
      : currentFirst;

  const lastSeenAt =
    Number.isFinite(incomingTime) && Number.isFinite(lastTime) && incomingTime > lastTime
      ? incomingAt
      : currentLast;

  return { firstSeenAt, lastSeenAt };
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
        latestSource: event.source,
      }
    : { ...existing, eventIds };
  return { ...state, checks: { ...state.checks, [key]: check } };
}

function applyMessageReceived(state: ContextState, event: EventEnvelope): ContextState {
  const payload = event.payload as MessageReceivedPayload;
  const existing = state.threads[payload.threadId];

  const message: ObservedMessage = {
    messageId: payload.messageId,
    direction: "inbound",
    from: payload.from,
    subject: payload.subject,
    snippet: payload.snippet,
    body: payload.body,
    occurredAt: payload.receivedAt,
    eventId: event.id,
    source: event.source,
  };

  const participants = new Set(existing?.participants ?? []);
  participants.add(payload.from.address);
  for (const recipient of payload.to) {
    participants.add(recipient.address);
  }

  const currentLastAt = existing?.lastMessageAt;
  const currentFirstAt = existing?.firstMessageAt;

  const incomingWins =
    !existing ||
    occurrenceWins(payload.receivedAt, event.id, currentLastAt!, existing.latestMessageEventId);

  const firstMessageAt = !existing
    ? payload.receivedAt
    : occurrenceWins(currentFirstAt!, "", payload.receivedAt, "")
      ? payload.receivedAt
      : currentFirstAt!;

  const thread: ThreadContext = existing
    ? {
        ...existing,
        subject: existing.subject || payload.subject,
        participants: [...participants],
        messages: [...existing.messages, message],
        firstMessageAt,
        lastMessageAt: incomingWins ? payload.receivedAt : currentLastAt!,
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
        firstMessageAt: payload.receivedAt,
        lastMessageAt: payload.receivedAt,
        latestMessageEventId: event.id,
        status: "open",
      };

  const person = state.people[payload.from.address];
  const bounds = updateTimestampBounds(person?.firstSeenAt, person?.lastSeenAt, payload.receivedAt);
  const updatedPerson: PersonContext = person
    ? {
        ...person,
        name: person.name ?? payload.from.name,
        inboundCount: (person.inboundCount ?? 0) + 1,
        outboundCount: person.outboundCount ?? 0,
        inboundEventIds: withEventId(person.inboundEventIds, event.id),
        outboundEventIds: person.outboundEventIds ?? [],
        firstSeenAt: bounds.firstSeenAt,
        lastSeenAt: bounds.lastSeenAt,
      }
    : {
        address: payload.from.address,
        name: payload.from.name,
        inboundCount: 1,
        outboundCount: 0,
        inboundEventIds: [event.id],
        outboundEventIds: [],
        firstSeenAt: bounds.firstSeenAt,
        lastSeenAt: bounds.lastSeenAt,
      };

  return {
    ...state,
    threads: { ...state.threads, [payload.threadId]: thread },
    people: { ...state.people, [payload.from.address]: updatedPerson },
  };
}

function applyMessageSent(state: ContextState, event: EventEnvelope): ContextState {
  const payload = event.payload as MessageSentPayload;
  const existing = state.threads[payload.threadId];

  const message: ObservedMessage = {
    messageId: payload.messageId,
    direction: "outbound",
    from: payload.from,
    subject: payload.subject,
    snippet: payload.snippet,
    body: payload.body,
    occurredAt: payload.sentAt,
    eventId: event.id,
    source: event.source,
  };

  const participants = new Set(existing?.participants ?? []);
  participants.add(payload.from.address);
  for (const recipient of payload.to) {
    participants.add(recipient.address);
  }

  const currentLastAt = existing?.lastMessageAt;
  const currentFirstAt = existing?.firstMessageAt;

  const incomingWins =
    !existing ||
    occurrenceWins(payload.sentAt, event.id, currentLastAt!, existing.latestMessageEventId);

  const firstMessageAt = !existing
    ? payload.sentAt
    : occurrenceWins(currentFirstAt!, "", payload.sentAt, "")
      ? payload.sentAt
      : currentFirstAt!;

  const thread: ThreadContext = existing
    ? {
        ...existing,
        subject: existing.subject || payload.subject,
        participants: [...participants],
        messages: [...existing.messages, message],
        firstMessageAt,
        lastMessageAt: incomingWins ? payload.sentAt : currentLastAt!,
        latestMessageEventId: incomingWins ? event.id : existing.latestMessageEventId,
        status: existing.status,
        snoozedUntil: existing.snoozedUntil,
      }
    : {
        threadId: payload.threadId,
        subject: payload.subject,
        participants: [...participants],
        messages: [message],
        firstMessageAt: payload.sentAt,
        lastMessageAt: payload.sentAt,
        latestMessageEventId: event.id,
        status: "open",
      };

  const senderAddress = payload.from.address.trim().toLowerCase();
  const recipientMap = new Map<string, EmailAddress>();
  for (const recipient of payload.to) {
    const addr = recipient.address.trim().toLowerCase();
    if (addr.length > 0 && addr !== senderAddress && !recipientMap.has(addr)) {
      recipientMap.set(addr, { ...recipient, address: addr });
    }
  }

  const updatedPeople = { ...state.people };
  for (const [address, recipient] of recipientMap) {
    const person = updatedPeople[address];
    const bounds = updateTimestampBounds(person?.firstSeenAt, person?.lastSeenAt, payload.sentAt);
    updatedPeople[address] = person
      ? {
          ...person,
          name: person.name ?? recipient.name,
          inboundCount: person.inboundCount ?? 0,
          outboundCount: (person.outboundCount ?? 0) + 1,
          inboundEventIds: person.inboundEventIds ?? [],
          outboundEventIds: withEventId(person.outboundEventIds, event.id),
          firstSeenAt: bounds.firstSeenAt,
          lastSeenAt: bounds.lastSeenAt,
        }
      : {
          address,
          name: recipient.name,
          inboundCount: 0,
          outboundCount: 1,
          inboundEventIds: [],
          outboundEventIds: [event.id],
          firstSeenAt: bounds.firstSeenAt,
          lastSeenAt: bounds.lastSeenAt,
        };
  }

  return {
    ...state,
    threads: { ...state.threads, [payload.threadId]: thread },
    people: updatedPeople,
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
      case EventTypes.MessageSent:
        return applyMessageSent(state, event);
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
