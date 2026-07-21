/**
 * Captured, GitHub-shaped sample activity for fixtures-first, key-free runs
 * (ADR-0009). These approximate what GitHub's REST/timeline resources report,
 * plus a `kind` discriminant the Skill uses to route normalization and a stable
 * `activityId` identifying one *occurrence* (not merely the affected entity), so
 * a review requested -> removed -> re-requested stays two distinct facts.
 *
 * This vendor shape lives here and in the GitHub Skill only — it never reaches
 * the domain (Eng #8). Crucially, the fixtures describe what GitHub reported;
 * they do NOT pre-declare whether an activity is actionable. Deciding relevance
 * (against the configured identity) is the adapter's job — that's what #44
 * proves — so silence is producible at the boundary.
 */

/** Who "the user" is, in GitHub's namespace. Normalization decides relevance against this. */
export interface GitHubIdentity {
  readonly login: string;
}

interface RawActivityBase {
  /** Stable id for this occurrence (not the entity). Drives event identity. */
  readonly activityId: string;
  /** When the occurrence happened, ISO 8601 UTC. */
  readonly occurredAt: string;
  /** Owning repository, e.g. "acme/orion". Display + location only. */
  readonly repo: string;
  /** Canonical link, display only. */
  readonly url: string;
}

export interface RawReviewRequestActivity extends RawActivityBase {
  readonly kind: "review_request";
  readonly pullNumber: number;
  readonly title: string;
  /** The login being asked to review. */
  readonly requestedReviewer: string;
  readonly requestedBy: { readonly login: string; readonly name?: string };
}

export interface RawAssignmentActivity extends RawActivityBase {
  readonly kind: "assignment";
  readonly issueNumber: number;
  readonly title: string;
  /** The login being made responsible. */
  readonly assignee: string;
  readonly assignedBy: { readonly login: string; readonly name?: string };
}

export interface RawCheckRunActivity extends RawActivityBase {
  readonly kind: "check_run";
  readonly pullNumber: number;
  readonly changeTitle: string;
  readonly name: string;
  readonly conclusion: "success" | "failure" | "cancelled" | "timed_out" | "neutral";
  /** The login who owns the change the check ran against. */
  readonly owner: string;
}

export type RawGitHubActivity =
  | RawReviewRequestActivity
  | RawAssignmentActivity
  | RawCheckRunActivity;

/** The configured user for the default fixtures. */
export const githubIdentity: GitHubIdentity = { login: "me" };

const OTHER = "casey"; // a different collaborator, for the "not addressed to me" cases

/**
 * A deliberately varied GitHub feed: actionable facts for the configured user
 * (review requested, item assigned, check failed on their change) plus their
 * non-actionable twins (addressed to someone else / a passing check) so the
 * adapter can be shown to correctly produce silence. `acme/orion` is the same
 * project referenced by the Gmail `th-gh` notification fixture, foreshadowing
 * the cross-source correlation work in #46.
 */
export const githubActivity = [
  {
    kind: "review_request",
    activityId: "gh-rev-128",
    occurredAt: "2026-07-15T13:00:00.000Z",
    repo: "acme/orion",
    url: "https://github.com/acme/orion/pull/128",
    pullNumber: 128,
    title: "Add retry to the event store",
    requestedReviewer: "me",
    requestedBy: { login: "dana", name: "Dana Lee" },
  },
  {
    // Review requested from someone else -> silence.
    kind: "review_request",
    activityId: "gh-rev-131",
    occurredAt: "2026-07-15T13:30:00.000Z",
    repo: "acme/orion",
    url: "https://github.com/acme/orion/pull/131",
    pullNumber: 131,
    title: "Tidy up logging",
    requestedReviewer: OTHER,
    requestedBy: { login: "dana", name: "Dana Lee" },
  },
  {
    kind: "assignment",
    activityId: "gh-assign-204",
    occurredAt: "2026-07-15T12:00:00.000Z",
    repo: "acme/orion",
    url: "https://github.com/acme/orion/issues/204",
    issueNumber: 204,
    title: "Flaky prioritization test on CI",
    assignee: "me",
    assignedBy: { login: "priya", name: "Priya Nair" },
  },
  {
    // Assigned to someone else -> silence.
    kind: "assignment",
    activityId: "gh-assign-205",
    occurredAt: "2026-07-15T12:15:00.000Z",
    repo: "acme/orion",
    url: "https://github.com/acme/orion/issues/205",
    issueNumber: 205,
    title: "Update README badges",
    assignee: OTHER,
    assignedBy: { login: "priya", name: "Priya Nair" },
  },
  {
    kind: "check_run",
    activityId: "gh-check-991",
    occurredAt: "2026-07-15T14:20:00.000Z",
    repo: "acme/orion",
    url: "https://github.com/acme/orion/pull/126/checks",
    pullNumber: 126,
    changeTitle: "Cross-source prioritization spike",
    name: "verify",
    conclusion: "failure",
    owner: "me",
  },
  {
    // Passing check -> silence.
    kind: "check_run",
    activityId: "gh-check-992",
    occurredAt: "2026-07-15T14:25:00.000Z",
    repo: "acme/orion",
    url: "https://github.com/acme/orion/pull/126/checks",
    pullNumber: 126,
    changeTitle: "Cross-source prioritization spike",
    name: "typecheck",
    conclusion: "success",
    owner: "me",
  },
] as const satisfies readonly RawGitHubActivity[];
