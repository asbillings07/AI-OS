import { createHash } from "node:crypto";
import { makeEvent, type EventEnvelope } from "../events/index.js";
import { EventTypes } from "../domain/index.js";
import { subjectKey, type SubjectRef } from "../subject/index.js";
import type { Logger } from "../observability/index.js";
import type { ContextState } from "../understanding/index.js";
import type { AttentionState } from "../attention/index.js";
import { buildWorkItems } from "../prioritization/index.js";
import { originatorFor, type PersonalImportanceState } from "../importance/index.js";

/**
 * Turning a user's decision on a surfaced Work Item into a recorded Event.
 *
 * This sits *above* both Attention and Prioritization on purpose: it reads the
 * ranked Work Items (prioritization) and the current disposition (attention) to
 * decide what to record. Placing it inside `attention/` would create the cycle
 * `attention -> prioritization -> attention`.
 *
 * The result is a pure decision (`buildActionEvent` is synchronous and
 * side-effect-free), so it can be handed to `OrionRuntime.recordExclusive` and
 * evaluated *inside* the serialized append critical section — closing the
 * time-of-check/time-of-use race between "is this still the revision the user
 * saw?" and the append (#61).
 */
export const WORK_ITEM_ACTIONS = ["acted", "snoozed", "dismissed"] as const;
export type WorkItemAction = (typeof WORK_ITEM_ACTIONS)[number];

const ACTION_EVENT_TYPE: Record<WorkItemAction, string> = {
  acted: EventTypes.WorkItemActedOn,
  snoozed: EventTypes.WorkItemSnoozed,
  dismissed: EventTypes.WorkItemDismissed,
};

const SNOOZE_DURATION_MS = 24 * 3_600_000;

export interface ActionEventIdInput {
  readonly action: WorkItemAction;
  readonly subject: SubjectRef;
  readonly basisEventIds: readonly string[];
  /** The id of the action Event that produced the Subject's current disposition. */
  readonly previousActionEventId?: string;
}

/**
 * A deterministic id for an action Event, so an exact-duplicate submit (a
 * double-click, two tabs, a retried request, or a second writer) dedupes on the
 * store's `UNIQUE(id)` constraint — the idempotency guarantee that survives
 * replay and outlives the in-process serialization queue.
 *
 * The identity is `{ action, subject, sorted basis, previousActionEventId }`:
 *  - `action` stays in the identity so an Event id names a particular *fact*
 *    (acting is not snoozing), never collapsing distinct decisions.
 *  - `previousActionEventId` chains the id to the disposition it supersedes, so
 *    there is exactly one deterministic id *per action cycle*. Without it, a
 *    snooze that resurfaces after expiry with the same basis would recompute the
 *    same id and be permanently deduped — the item could never be snoozed again.
 *  - `snoozedUntil` is deliberately absent: two snooze clicks on the same
 *    revision should dedupe to one Event (first-wins), not diverge on a deadline.
 */
export function actionEventId(input: ActionEventIdInput): string {
  const material = JSON.stringify([
    input.action,
    subjectKey(input.subject),
    [...input.basisEventIds].sort(),
    input.previousActionEventId ?? null,
  ]);
  return `act-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

export interface BuildActionEventInput {
  readonly context: ContextState;
  readonly attention: AttentionState;
  /** Passed through to the re-resolve `buildWorkItems` call below (#65). */
  readonly importance?: PersonalImportanceState;
  readonly now: string;
  readonly workItemId: string;
  readonly action: WorkItemAction;
  /** Optimistic-concurrency token the client rendered; compared, never trusted. */
  readonly revision: string;
  readonly logger?: Logger;
}

/**
 * Decide the Event to record for a user's action, or `null` to record nothing.
 *
 * The trust boundary: the client supplies `workItemId` + `action` + `revision`.
 * We re-resolve the item against what is *currently visible*, derive Subject and
 * basis from that surfaced Work Item (never from client input), and record only
 * if the recomputed revision token still matches — so an action taken against a
 * card cannot silently apply to a newer revision that arrived in between. A
 * forged/stale id, or a stale revision, yields `null` (never pollute the log).
 *
 * Pure and synchronous: given the same state and `now`, it always decides the
 * same way, which is what lets `recordExclusive` run it inside the append
 * critical section.
 */
export function buildActionEvent(input: BuildActionEventInput): EventEnvelope | null {
  const { context, attention, importance, now, workItemId, action, revision } = input;

  // Trust boundary: this is exported, so guard the action at runtime rather than
  // relying on the caller's compile-time type. An unsupported action records
  // nothing (never an Event with `type: undefined`).
  if (!(WORK_ITEM_ACTIONS as readonly string[]).includes(action)) {
    return null;
  }

  const surfaced = buildWorkItems({ context, attention, importance, now, logger: input.logger }).find(
    (item) => item.id === workItemId,
  );

  // Only act on a currently-visible item with a valid Subject and a nonempty basis.
  if (!surfaced || !surfaced.subject?.id || surfaced.attentionBasisEventIds.length === 0) {
    return null;
  }
  // Optimistic concurrency: the card the user acted on must still be the current revision.
  if (surfaced.attentionRevision !== revision) {
    return null;
  }

  const subject = surfaced.subject;
  const basisEventIds = surfaced.attentionBasisEventIds;
  const previousActionEventId = attention.dispositions[subjectKey(subject)]?.actionEventId;
  const id = actionEventId({ action, subject, basisEventIds, previousActionEventId });
  // Stamp who the work is from (source-neutral, immutable) so Personal Importance
  // (#65) learns against a uniform key without ever re-opening Context. Omitted
  // when there is no resolvable originator (e.g. a failing check) -> stays neutral.
  const originator = originatorFor(subject, context);
  const base = {
    workItemId,
    subject,
    basisEventIds,
    ...(originator ? { originator } : {}),
  } as const;

  if (action === "snoozed") {
    const snoozedUntil = new Date(new Date(now).getTime() + SNOOZE_DURATION_MS).toISOString();
    return makeEvent({
      id,
      type: ACTION_EVENT_TYPE.snoozed,
      source: "user",
      occurredAt: now,
      payload: { ...base, snoozedUntil },
    });
  }

  return makeEvent({
    id,
    type: ACTION_EVENT_TYPE[action],
    source: "user",
    occurredAt: now,
    payload: base,
  });
}
