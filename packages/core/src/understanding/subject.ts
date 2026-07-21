/**
 * A Subject is the persistent thing an Opportunity is about — the conversation, the
 * change under review, the assigned unit of work, the failing check. It is distinct
 * from an *occurrence* (a single Event id like `github:review_request:gh-rev-128`):
 * many occurrences over time contribute to one Subject.
 *
 * Subject identity is source-neutral on purpose (Eng #8). It is the load-bearing
 * vocabulary the Understanding layer groups on, so it lives here — not inside
 * Signals or Opportunities — and everything derives its grouping key from
 * `subjectKey` rather than re-interpolating the rule.
 */
export type SubjectKind = "thread" | "review" | "assignment" | "check";

export interface SubjectRef {
  readonly kind: SubjectKind;
  readonly id: string;
}

/** The single canonical grouping key. Do not re-interpolate this rule elsewhere. */
export function subjectKey(subject: SubjectRef): string {
  return `${subject.kind}:${subject.id}`;
}

/**
 * Subject id for a check. A check subject is one named check on one change: keying
 * on `changeId` alone would merge two independent failing checks, while keying on a
 * per-occurrence `checkId` would fork a new subject on every retry. The pair is the
 * persistent thing.
 */
export function checkSubjectId(changeId: string, checkName: string): string {
  return `${changeId}:check:${checkName}`;
}
