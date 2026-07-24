import type { EventEnvelope } from "../events/index.js";
import type { SubjectRef } from "../subject/index.js";

/**
 * Domain event vocabulary. These names are domain-centric on purpose: nothing
 * here (or in any payload) knows that Gmail exists. Adapters normalize vendor
 * shapes into these facts and then disappear (Eng #8, ADR-0010).
 */
export const EventTypes = {
  /** A message arrived for the user, from any communication Source. */
  MessageReceived: "MessageReceived",
  /** A message was sent by the user, from any communication Source. */
  MessageSent: "MessageSent",
  /** Someone asked the user to review a change (e.g. a proposed code change). */
  ReviewRequested: "ReviewRequested",
  /** The user was made responsible for a unit of work. */
  AssignmentReceived: "AssignmentReceived",
  /** An automated verification on the user's work reported failure. */
  CheckFailed: "CheckFailed",
  /** The user acted on a Work Item (e.g. handled/replied). */
  WorkItemActedOn: "WorkItemActedOn",
  /** The user chose to deal with a Work Item later. */
  WorkItemSnoozed: "WorkItemSnoozed",
  /** The user dismissed a Work Item as not needing attention. */
  WorkItemDismissed: "WorkItemDismissed",
  /** The user explicitly suppressed all future work from an originator. */
  OriginatorSuppressed: "OriginatorSuppressed",
  /** The user revoked a prior suppression for an originator. */
  OriginatorUnsuppressed: "OriginatorUnsuppressed",
  /** Orion's own Observation that a situation is worth acting on (Source: orion). */
  OpportunityDetected: "OpportunityDetected",
  /** First-run natural-language onboarding session started (#70). */
  UserOnboardingStarted: "UserOnboardingStarted",
  /** Orion asked an onboarding question (opening or follow-up) (#70). */
  UserOnboardingQuestionAsked: "UserOnboardingQuestionAsked",
  /** User responded to an onboarding question with raw text (#70). */
  UserStatementRecorded: "UserStatementRecorded",
  /** Statement belief extraction processing completed (#70). */
  UserStatementProcessed: "UserStatementProcessed",
  /** Orion proposed a candidate belief from user understanding (#70, ADR-0016). */
  UserBeliefProposed: "UserBeliefProposed",
  /** User explicitly confirmed a proposed candidate belief (#70). */
  UserBeliefConfirmed: "UserBeliefConfirmed",
  /** User corrected a proposed belief, creating an immediate confirmed replacement (#70). */
  UserBeliefCorrected: "UserBeliefCorrected",
  /** User explicitly rejected a proposed belief (#70). */
  UserBeliefRejected: "UserBeliefRejected",
  /** User confirmed baseline summary, committing onboarding understanding (#70). */
  UserUnderstandingBaselineEstablished: "UserUnderstandingBaselineEstablished",
  /** User paused/skipped an incomplete onboarding session (#70). */
  UserOnboardingSkipped: "UserOnboardingSkipped",
  /** User resumed a previously skipped onboarding session (#70). */
  UserOnboardingResumed: "UserOnboardingResumed",
  /** User restarted onboarding, abandoning old session (#70). */
  UserOnboardingRestarted: "UserOnboardingRestarted",
  /** User reset conversational progress within session (#70). */
  UserOnboardingReset: "UserOnboardingReset",
  /** User deleted established onboarding baseline (#70). */
  UserUnderstandingBaselineDeleted: "UserUnderstandingBaselineDeleted",
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

/**
 * A communication message sent by the user, normalized to domain shape. "Sent" = outbound from
 * the user; the Understanding Engine derives relationship and response status from this fact.
 */
export interface MessageSentPayload {
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
  /** When the message was sent, ISO 8601 UTC. */
  sentAt: string;
}

/**
 * A collaborator, identified only within the emitting Source's namespace. The
 * `externalId` is opaque and source-scoped: a GitHub login, a calendar attendee,
 * an issue tracker account. It deliberately does NOT imply cross-source
 * equivalence — resolving that two ActorRefs are the same person is later
 * identity/correlation work, not something the domain assumes here.
 */
export interface ActorRef {
  readonly externalId: string;
  readonly displayName?: string;
}

/**
 * Who a piece of work is *from*, as an immutable, source-neutral evidence key.
 *
 * This is the identity Personal Importance is learned against (#65). It is a
 * foundational domain type on purpose: it lives here so both action payloads and
 * the Importance module can depend *downward* on it, never the other way around.
 *
 * `namespace` is the emitting Source's immutable label (e.g. `gmail-skill`,
 * `github-skill`), carried verbatim from the winning Event's `source` — never
 * inferred from a Subject kind (a thread is not always Gmail; an assignment is
 * not always GitHub). `id` is a canonical source-native identifier the *adapter*
 * is responsible for canonicalizing (Gmail lowercases addresses; GitHub emits a
 * stable login); core treats it as opaque and never rewrites it.
 *
 * Like `ActorRef`, this deliberately does NOT assert cross-source equivalence:
 * the same person in two namespaces stays two originators until identity
 * resolution exists.
 */
export interface OriginatorRef {
  readonly namespace: string;
  readonly id: string;
}

/**
 * The single canonical key for an originator. Uses a JSON-encoded tuple rather
 * than `${namespace}:${id}` so it cannot collide when either component contains
 * the separator (an email address or opaque id may contain `:`).
 */
export function originatorKey(originator: OriginatorRef): string {
  return JSON.stringify([originator.namespace, originator.id]);
}

/**
 * A review was requested from the user on some change (e.g. a proposed code
 * change). Domain-centric: nothing here knows what a "pull request" is.
 *
 * `requestedAt` is the same source-reported instant as the Event envelope's
 * `occurredAt`; both are kept for domain consistency (mirroring
 * MessageReceivedPayload.receivedAt) and are asserted equal by the adapter.
 */
export interface ReviewRequestedPayload {
  /** Stable domain id for this occurrence of the request. */
  reviewRequestId: string;
  /** The change under review this request concerns. */
  changeId: string;
  title: string;
  /** Who asked for the review, if known. */
  requestedBy?: ActorRef;
  /** Human-readable location for display only, e.g. "acme/orion#128". */
  location: string;
  /** Canonical link for display only. */
  url: string;
  /** When the request occurred, ISO 8601 UTC (== envelope occurredAt). */
  requestedAt: string;
}

/**
 * The user was made responsible for a unit of work. Domain-centric: nothing
 * here knows what a GitHub "issue" is.
 */
export interface AssignmentReceivedPayload {
  /** Stable domain id for this occurrence of the assignment. */
  assignmentId: string;
  /** The work item the user was assigned. */
  itemId: string;
  title: string;
  /** Who assigned it, if known. */
  assignedBy?: ActorRef;
  /** Human-readable location for display only. */
  location: string;
  /** Canonical link for display only. */
  url: string;
  /** When the assignment occurred, ISO 8601 UTC (== envelope occurredAt). */
  assignedAt: string;
}

/**
 * An automated verification on the user's work reported failure. Domain-centric:
 * nothing here knows what a "workflow" or "CI" is; it could equally describe a
 * deployment gate, a compliance check, or a data validation.
 */
export interface CheckFailedPayload {
  /** Stable domain id for this occurrence of the failure. */
  checkId: string;
  /** The change the check ran against. */
  changeId: string;
  /** Name of the check that failed. */
  checkName: string;
  title: string;
  /** Human-readable location for display only. */
  location: string;
  /** Canonical link for display only. */
  url: string;
  /** When the failure occurred, ISO 8601 UTC (== envelope occurredAt). */
  failedAt: string;
}

/**
 * A user's decision on a Work Item. Modeled as a union so both the current
 * Subject-based shape and the pre-#46 thread-only shape are representable and
 * type-safe on the same append-only log:
 *
 *  - Current: the action targets a source-neutral Subject and records exactly the
 *    revision the user saw (`basisEventIds`), so a genuinely new occurrence can
 *    resurface the item while a late-arriving older fact stays quiet. The server
 *    derives `basisEventIds` from the surfaced Work Item, so it is always nonempty.
 *  - Legacy: pre-#46 events carried only `threadId` and no basis. Kept so old logs
 *    replay faithfully (see attention/projection.ts for the compatibility rules).
 */
export interface CurrentWorkItemActionPayload {
  readonly workItemId: string;
  readonly subject: SubjectRef;
  /** The occurrence Event ids the surfaced Work Item was based on (nonempty). */
  readonly basisEventIds: readonly string[];
  /**
   * Who the work was from at action time, stamped from Context so Personal
   * Importance (#65) can learn against a uniform, immutable key without ever
   * re-opening Context or branching on source. Optional and additive: events
   * recorded before #65 (and any action with no resolvable originator, e.g. a
   * failing check) carry none and stay neutral.
   */
  readonly originator?: OriginatorRef;
  readonly note?: string;
}

/** Pre-#46 action payload: thread-only, no Subject, no basis. */
export interface LegacyThreadActionPayload {
  readonly workItemId: string;
  readonly threadId: string;
  readonly note?: string;
}

export type WorkItemActionPayload = CurrentWorkItemActionPayload | LegacyThreadActionPayload;

export type WorkItemSnoozePayload =
  | (CurrentWorkItemActionPayload & { readonly snoozedUntil: string })
  | (LegacyThreadActionPayload & { readonly snoozedUntil: string });

/** Narrows an action payload to the current Subject-based shape. */
export function isCurrentActionPayload(
  payload: WorkItemActionPayload,
): payload is CurrentWorkItemActionPayload {
  return "subject" in payload;
}

export type MessageReceivedEvent = EventEnvelope<"MessageReceived", MessageReceivedPayload>;
export type MessageSentEvent = EventEnvelope<"MessageSent", MessageSentPayload>;
export type ReviewRequestedEvent = EventEnvelope<"ReviewRequested", ReviewRequestedPayload>;
export type AssignmentReceivedEvent = EventEnvelope<"AssignmentReceived", AssignmentReceivedPayload>;
export type CheckFailedEvent = EventEnvelope<"CheckFailed", CheckFailedPayload>;
export type WorkItemActedOnEvent = EventEnvelope<"WorkItemActedOn", WorkItemActionPayload>;
export type WorkItemSnoozedEvent = EventEnvelope<"WorkItemSnoozed", WorkItemSnoozePayload>;
export type WorkItemDismissedEvent = EventEnvelope<"WorkItemDismissed", WorkItemActionPayload>;

/**
/ * Payload for suppressing future work from an originator. Hard, durable suppression.
 */
export interface OriginatorSuppressedPayload {
  readonly originator: OriginatorRef;
  readonly reason?: string;
}

/**
 * Payload for unsuppressing an originator.
 */
export interface OriginatorUnsuppressedPayload {
  readonly originator: OriginatorRef;
  /**
   * The ID of the OriginatorSuppressed event being unsuppressed. Acts as a causal
   * concurrency token so an unsuppress call targets a specific suppression rule.
   */
  readonly suppressionEventId: string;
  readonly reason?: string;
}

export type OriginatorSuppressedEvent = EventEnvelope<
  "OriginatorSuppressed",
  OriginatorSuppressedPayload
>;
export type OriginatorUnsuppressedEvent = EventEnvelope<
  "OriginatorUnsuppressed",
  OriginatorUnsuppressedPayload
>;

export type BeliefCategory =
  | "values"
  | "roles_and_relationships"
  | "goals"
  | "priorities"
  | "constraints"
  | "routines";

export type BeliefTemporalScope = "durable" | "current" | "bounded" | "unknown";

export interface CandidateBeliefProposal {
  readonly subject: string;
  readonly claim: string;
  readonly category: BeliefCategory;
  readonly temporalScope: BeliefTemporalScope;
  readonly evidenceText: string;
  readonly supportingEvidence?: readonly {
    readonly statementEnvelopeId: string;
    readonly evidenceText: string;
  }[];
  readonly confidence: number;
}

export interface UserOnboardingStartedPayload {
  readonly sessionId: string;
  readonly startedAt: string;
}

export interface UserOnboardingQuestionAskedPayload {
  readonly questionId: string;
  readonly sessionId: string;
  readonly kind: "opening" | "follow_up";
  readonly text: string;
  readonly ordinal: number;
  readonly mechanismVersion: string;
  readonly askedAt: string;
}

export interface UserStatementRecordedPayload {
  readonly statementId: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly rawText: string;
  readonly recordedAt: string;
}

export interface UserStatementProcessedPayload {
  readonly statementId: string;
  readonly statementEnvelopeId: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly extractionResult: readonly CandidateBeliefProposal[];
  readonly proposedBeliefIds: readonly string[];
  readonly processedAt: string;
}

export interface UserBeliefProposedPayload {
  readonly beliefId: string;
  readonly sessionId: string;
  readonly statementEnvelopeId: string;
  readonly subject: string;
  readonly claim: string;
  readonly category: BeliefCategory;
  readonly temporalScope: BeliefTemporalScope;
  readonly evidenceText: string;
  readonly origin: "user_statement";
  readonly derivation: "ai_assisted_inference";
  readonly verification: "unconfirmed";
  readonly sourceEventIds: readonly string[];
  readonly confidence: number;
  readonly categoryPolicy: "allowed" | "confirmation_required";
  readonly inferenceMechanism: string;
  readonly promptSchemaVersion: string;
  readonly validFrom: string;
  readonly expiresAt?: string;
  readonly proposedAt: string;
}

export interface UserBeliefConfirmedPayload {
  readonly beliefId: string;
  readonly sessionId: string;
  readonly confirmedAt: string;
}

export interface UserBeliefCorrectedPayload {
  readonly oldBeliefId: string;
  readonly newBeliefId: string;
  readonly sessionId: string;
  readonly rawCorrectionText: string;
  readonly correctedClaim: string;
  readonly correctedSubject: string;
  readonly correctedCategory: BeliefCategory;
  readonly correctedTemporalScope: BeliefTemporalScope;
  readonly categoryPolicy: "allowed" | "confirmation_required";
  readonly correctedAt: string;
}

export interface UserBeliefRejectedPayload {
  readonly beliefId: string;
  readonly sessionId: string;
  readonly reason?: string;
  readonly rejectedAt: string;
}

export interface UserUnderstandingBaselineEstablishedPayload {
  readonly sessionId: string;
  readonly confirmedBeliefIds: readonly string[];
  readonly summary: readonly string[];
  readonly establishedAt: string;
}

export interface UserOnboardingSkippedPayload {
  readonly sessionId: string;
  readonly skippedAt: string;
}

export interface UserOnboardingResumedPayload {
  readonly sessionId: string;
  readonly resumedAt: string;
}

export interface UserOnboardingRestartedPayload {
  readonly oldSessionId: string;
  readonly newSessionId: string;
  readonly restartedAt: string;
}

export interface UserOnboardingResetPayload {
  readonly sessionId: string;
  readonly resetAt: string;
}

export interface UserUnderstandingBaselineDeletedPayload {
  readonly sessionId: string;
  readonly reason?: string;
  readonly deletedAt: string;
}

export type UserOnboardingStartedEvent = EventEnvelope<
  "UserOnboardingStarted",
  UserOnboardingStartedPayload
>;
export type UserOnboardingQuestionAskedEvent = EventEnvelope<
  "UserOnboardingQuestionAsked",
  UserOnboardingQuestionAskedPayload
>;
export type UserStatementRecordedEvent = EventEnvelope<
  "UserStatementRecorded",
  UserStatementRecordedPayload
>;
export type UserStatementProcessedEvent = EventEnvelope<
  "UserStatementProcessed",
  UserStatementProcessedPayload
>;
export type UserBeliefProposedEvent = EventEnvelope<
  "UserBeliefProposed",
  UserBeliefProposedPayload
>;
export type UserBeliefConfirmedEvent = EventEnvelope<
  "UserBeliefConfirmed",
  UserBeliefConfirmedPayload
>;
export type UserBeliefCorrectedEvent = EventEnvelope<
  "UserBeliefCorrected",
  UserBeliefCorrectedPayload
>;
export type UserBeliefRejectedEvent = EventEnvelope<
  "UserBeliefRejected",
  UserBeliefRejectedPayload
>;
export type UserUnderstandingBaselineEstablishedEvent = EventEnvelope<
  "UserUnderstandingBaselineEstablished",
  UserUnderstandingBaselineEstablishedPayload
>;
export type UserOnboardingSkippedEvent = EventEnvelope<
  "UserOnboardingSkipped",
  UserOnboardingSkippedPayload
>;
export type UserOnboardingResumedEvent = EventEnvelope<
  "UserOnboardingResumed",
  UserOnboardingResumedPayload
>;
export type UserOnboardingRestartedEvent = EventEnvelope<
  "UserOnboardingRestarted",
  UserOnboardingRestartedPayload
>;
export type UserOnboardingResetEvent = EventEnvelope<
  "UserOnboardingReset",
  UserOnboardingResetPayload
>;
export type UserUnderstandingBaselineDeletedEvent = EventEnvelope<
  "UserUnderstandingBaselineDeleted",
  UserUnderstandingBaselineDeletedPayload
>;

/** True for automated/no-reply senders — messages that rarely warrant a reply. */
export function isAutomatedSender(address: string): boolean {
  return /(^|[.\-_])(no-?reply|noreply|do-?not-?reply|newsletter|newsletters|notifications?|mailer|updates?|alerts?|bounce|postmaster)([.\-_@]|$)/i.test(
    address,
  );
}
