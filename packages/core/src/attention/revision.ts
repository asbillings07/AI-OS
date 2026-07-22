import { subjectKey, type SubjectRef } from "../subject/index.js";

/**
 * A deterministic optimistic-concurrency token for a Work Item's *current
 * presentation revision*. It captures exactly what an action is allowed to apply
 * to: the Subject plus the attention basis the user was shown.
 *
 * The application renders this token into the action form. On submit, the server
 * recomputes the token from the *currently visible* Work Item and records the
 * action only if the two match — so an action taken against a card the user saw
 * cannot silently apply to a newer revision that arrived in between (a
 * time-of-check/time-of-use race). The client value is never trusted for Subject
 * or basis; it is only compared for equality.
 *
 * Basis ids are order-normalized so the token depends on the *set* of occurrences,
 * not the incidental order detection produced them in.
 */
export function attentionRevision(subject: SubjectRef, basisEventIds: readonly string[]): string {
  return JSON.stringify([subjectKey(subject), [...basisEventIds].sort()]);
}
