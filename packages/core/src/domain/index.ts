import type { EventEnvelope } from "../events/index.js";

/**
 * Domain event vocabulary. These names are domain-centric on purpose: nothing
 * here (or in any payload) knows that Gmail exists. Adapters normalize vendor
 * shapes into these facts and then disappear (Eng #8, ADR-0010).
 */
export const EventTypes = {
  /** A message arrived for the user, from any communication Source. */
  MessageReceived: "MessageReceived",
  /** The user acted on a Work Item (e.g. handled/replied). */
  WorkItemActedOn: "WorkItemActedOn",
  /** The user chose to deal with a Work Item later. */
  WorkItemSnoozed: "WorkItemSnoozed",
  /** The user dismissed a Work Item as not needing attention. */
  WorkItemDismissed: "WorkItemDismissed",
  /** Orion's own Observation that a situation is worth acting on (Source: orion). */
  OpportunityDetected: "OpportunityDetected",
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

export interface EmailAddress {
  name?: string;
  address: string;
}

/**
 * A communication message, normalized to domain shape. "Received" = inbound to
 * the user; the Understanding Engine derives all meaning from this fact.
 */
export interface MessageReceivedPayload {
  /** Stable domain id for this message. */
  messageId: string;
  /** Conversation this message belongs to. */
  threadId: string;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  /** Short preview for display. */
  snippet: string;
  /** Plain-text body, for deterministic classification and AI summarization. */
  body: string;
  /** When the message arrived, ISO 8601 UTC. */
  receivedAt: string;
}

export interface WorkItemActionPayload {
  workItemId: string;
  /** The conversation the Work Item was about, so Context can react. */
  threadId: string;
  note?: string;
}

export interface WorkItemSnoozePayload extends WorkItemActionPayload {
  snoozedUntil: string;
}

export type MessageReceivedEvent = EventEnvelope<"MessageReceived", MessageReceivedPayload>;
export type WorkItemActedOnEvent = EventEnvelope<"WorkItemActedOn", WorkItemActionPayload>;
export type WorkItemSnoozedEvent = EventEnvelope<"WorkItemSnoozed", WorkItemSnoozePayload>;
export type WorkItemDismissedEvent = EventEnvelope<"WorkItemDismissed", WorkItemActionPayload>;

/** True for automated/no-reply senders — messages that rarely warrant a reply. */
export function isAutomatedSender(address: string): boolean {
  return /(^|[.\-_])(no-?reply|noreply|do-?not-?reply|newsletter|newsletters|notifications?|mailer|updates?|alerts?|bounce|postmaster)([.\-_@]|$)/i.test(
    address,
  );
}
