import { isAutomatedSender } from "../domain/index.js";
import { latestThreadMessage, type ContextState, type ThreadContext } from "./context.js";
import type { SubjectRef } from "../subject/index.js";

export type SignalKind =
  // Conversation (thread) signals.
  | "AwaitingReply"
  | "DirectQuestion"
  | "FromKnownPerson"
  | "Aging"
  | "LikelyLowValue"
  | "ExplicitRequest"
  | "Invitation"
  // Collaborative-work signals (reviews, assignments, checks).
  | "PendingReview"
  | "Assigned"
  | "CheckFailing"
  // An explicit obligation the user has taken on (assigned/requested).
  | "Commitment";

/**
 * A Signal (ubiquitous language): a meaningful change or relationship detected
 * within Context. Not everything matters; a Signal is what does. Each Signal
 * carries its own deterministic `evidence` and the Events behind it, so the
 * eventual "Why is this here?" can be answered without any AI (ADR-0004).
 */
export interface Signal {
  kind: SignalKind;
  /** The persistent thing this Signal is about (source-neutral). */
  subject: SubjectRef;
  /** 0..1 deterministic magnitude. */
  strength: number;
  /** Human-readable justification, e.g. "Contains a direct question." */
  evidence: string;
  /** The Event ids that gave rise to this Signal. */
  sourceEventIds: string[];
}

const AGING_HOURS = 24;
const QUESTION_PATTERN = /\?|\b(can you|could you|would you|when can|are you able)\b/i;
const COMPLETED_INVITATION_PATTERN = /\b(accepted|declined|canceled|cancelled|confirmed)\b/i;
const EXPLICIT_REQUEST_PATTERN =
  /\b(action required|please review|please approve|need your input|feedback needed|please sign|need you to|could you send|would you send|send me|let me know|any thoughts|thoughts on|following up)\b/i;
const INVITATION_PATTERN =
  /\b(invited you|invitation to|please rsvp|rsvp required|accept or decline|calendar invitation|meeting invitation|schedule a call)\b/i;

function hoursBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000;
}

function threadEventIds(thread: ThreadContext): string[] {
  return thread.messages.map((message) => message.eventId);
}

/**
 * Inbound messages in the active turn (messages since the last outbound message,
 * or all messages if the user hasn't replied yet).
 */
function activeInboundTurnMessages(thread: ThreadContext) {
  let lastOutboundIdx = -1;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    if (thread.messages[i]?.direction === "outbound") {
      lastOutboundIdx = i;
      break;
    }
  }
  return lastOutboundIdx === -1 ? thread.messages : thread.messages.slice(lastOutboundIdx + 1);
}

function stableDedupe(ids: string[]): string[] {
  const result: string[] = [];
  for (const id of ids) {
    if (id && !result.includes(id)) {
      result.push(id);
    }
  }
  return result;
}

/**
 * Derive Signals from Context. Pure and deterministic given `now`, which is
 * passed in (never read from the clock) so replay and tests are reproducible.
 *
 * Signals reflect *reality* only: every thread is considered regardless of the
 * user's disposition toward it. Suppression (handled/snoozed/dismissed) is the
 * Attention projection's job, applied later at the visibility stage (ADR-0012),
 * so understanding never depends on how the user chose to present things.
 */
export function detectSignals(context: ContextState, now: string): Signal[] {
  const signals: Signal[] = [];

  for (const thread of Object.values(context.threads)) {
    const subject: SubjectRef = { kind: "thread", id: thread.threadId };
    const eventIds = threadEventIds(thread);
    const latestMsg = latestThreadMessage(thread);

    if (!latestMsg) {
      continue;
    }

    const isOutbound = latestMsg.direction === "outbound";

    // When the latest occurrence in the thread is outbound, the user sent the last message.
    // Whole-obligation suppression: emit no reply-needed conversational signals
    // (AwaitingReply, DirectQuestion, Aging).
    if (!isOutbound) {
      const lastSender = latestMsg.from.address;
      const automated = isAutomatedSender(lastSender);
      const activeInboundMessages = activeInboundTurnMessages(thread);

      let isInvitation = false;
      let isExplicitRequest = false;

      for (const msg of activeInboundMessages) {
        const msgText = `${msg.subject} ${msg.body}`;
        const directMsgEventId = [msg.eventId];

        if (INVITATION_PATTERN.test(msgText) && !COMPLETED_INVITATION_PATTERN.test(msgText)) {
          if (!isInvitation) {
            isInvitation = true;
            signals.push({
              kind: "Invitation",
              subject,
              strength: 0.9,
              evidence: "The message is an event or meeting invitation.",
              sourceEventIds: directMsgEventId,
            });
          }
        }

        if (EXPLICIT_REQUEST_PATTERN.test(msgText)) {
          if (!isExplicitRequest) {
            isExplicitRequest = true;
            signals.push({
              kind: "ExplicitRequest",
              subject,
              strength: 0.85,
              evidence: "The message requests explicit action or input.",
              sourceEventIds: directMsgEventId,
            });
          }
        }
      }

      if (automated) {
        signals.push({
          kind: "LikelyLowValue",
          subject,
          strength: 0.8,
          evidence: `From an automated sender (${lastSender}).`,
          sourceEventIds: eventIds,
        });
        if (!isInvitation && !isExplicitRequest) {
          continue;
        }
      } else {
        signals.push({
          kind: "AwaitingReply",
          subject,
          strength: 1,
          evidence: "You have not replied to this conversation.",
          sourceEventIds: eventIds,
        });
      }

      // DirectQuestion scans only the latest inbound message, not the whole conversation history
      const latestInboundText = `${latestMsg.subject} ${latestMsg.body}`;
      if (QUESTION_PATTERN.test(latestInboundText)) {
        signals.push({
          kind: "DirectQuestion",
          subject,
          strength: 0.85,
          evidence: "The message asks a direct question.",
          sourceEventIds: eventIds,
        });
      }

      // Aging is calculated from the latest inbound message's occurrence time
      const age = hoursBetween(latestMsg.occurredAt, now);
      if (age >= AGING_HOURS) {
        signals.push({
          kind: "Aging",
          subject,
          strength: Math.min(1, age / (AGING_HOURS * 3)),
          evidence: `Waiting for ${Math.floor(age / 24)} day(s).`,
          sourceEventIds: eventIds,
        });
      }
    }

    // FromKnownPerson relationship evaluation
    const senderAddr = latestMsg.from.address;
    const personAddress = !isOutbound
      ? senderAddr
      : thread.participants.find((addr) => addr !== senderAddr) ?? senderAddr;

    const person = context.people[personAddress];
    if (person) {
      const exchangedCount = Math.min(person.inboundCount ?? 0, person.outboundCount ?? 0);
      if (exchangedCount > 0) {
        const combinedEventIds = stableDedupe([
          ...eventIds,
          ...(person.inboundEventIds ?? []),
          ...(person.outboundEventIds ?? []),
        ]);
        signals.push({
          kind: "FromKnownPerson",
          subject,
          strength: Math.min(1, 0.4 + exchangedCount * 0.15),
          evidence: `You've exchanged messages with ${person.name ?? personAddress}.`,
          sourceEventIds: combinedEventIds,
        });
      }
    }
  }

  return signals;
}
