import { isAutomatedSender } from "../domain/index.js";
import type { ContextState, ThreadContext } from "./context.js";
import type { SubjectRef } from "./subject.js";

export type SignalKind =
  // Conversation (thread) signals.
  | "AwaitingReply"
  | "DirectQuestion"
  | "FromKnownPerson"
  | "Aging"
  | "LikelyLowValue"
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
const KNOWN_PERSON_THRESHOLD = 2;
const QUESTION_PATTERN = /\?|\b(can you|could you|would you|please|let me know|thoughts|when can|are you able)\b/i;

function hoursBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000;
}

function threadEventIds(thread: ThreadContext): string[] {
  return thread.messages.map((message) => message.eventId);
}

/**
 * Whether a thread is currently actionable. Open threads always are. A snoozed
 * thread resurfaces on its own once its snooze window has passed; a new inbound
 * message reopens it sooner by flipping it back to "open" (see context.ts
 * applyMessageReceived) — fresh activity overrides a defer, the way an email
 * client un-snoozes a thread when a reply arrives. A handled thread likewise
 * reopens on new inbound. Dismissed is a durable mute: it stays silent even if
 * the conversation continues.
 */
function isActionable(thread: ThreadContext, now: string): boolean {
  switch (thread.status) {
    case "open":
      return true;
    case "snoozed":
      return (
        thread.snoozedUntil !== undefined &&
        new Date(thread.snoozedUntil).getTime() <= new Date(now).getTime()
      );
    case "handled":
    case "dismissed":
      return false;
  }
}

/**
 * Derive Signals from Context. Pure and deterministic given `now`, which is
 * passed in (never read from the clock) so replay and tests are reproducible.
 */
export function detectSignals(context: ContextState, now: string): Signal[] {
  const signals: Signal[] = [];

  for (const thread of Object.values(context.threads)) {
    if (!isActionable(thread, now)) {
      continue;
    }

    const subject: SubjectRef = { kind: "thread", id: thread.threadId };
    const eventIds = threadEventIds(thread);
    const lastSender = thread.messages[thread.messages.length - 1]?.from.address ?? "";
    const automated = isAutomatedSender(lastSender);

    if (automated) {
      signals.push({
        kind: "LikelyLowValue",
        subject,
        strength: 0.8,
        evidence: `From an automated sender (${lastSender}).`,
        sourceEventIds: eventIds,
      });
      continue;
    }

    signals.push({
      kind: "AwaitingReply",
      subject,
      strength: 1,
      evidence: "You have not replied to this conversation.",
      sourceEventIds: eventIds,
    });

    const text = thread.messages.map((m) => `${m.subject} ${m.body}`).join("\n");
    if (QUESTION_PATTERN.test(text)) {
      signals.push({
        kind: "DirectQuestion",
        subject,
        strength: 0.85,
        evidence: "The message asks a direct question.",
        sourceEventIds: eventIds,
      });
    }

    const person = context.people[lastSender];
    if (person && person.messageCount >= KNOWN_PERSON_THRESHOLD) {
      signals.push({
        kind: "FromKnownPerson",
        subject,
        strength: Math.min(1, 0.4 + person.messageCount * 0.15),
        evidence: `From ${person.name ?? lastSender}, someone you correspond with (${person.messageCount} messages).`,
        sourceEventIds: eventIds,
      });
    }

    const age = hoursBetween(thread.lastReceivedAt, now);
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

  return signals;
}
