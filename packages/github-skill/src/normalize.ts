import {
  EventTypes,
  type AssignmentReceivedPayload,
  type CheckFailedPayload,
  type ReviewRequestedPayload,
} from "@orion/core";
import type { GitHubIdentity, RawGitHubActivity } from "@orion/fixtures";

/**
 * A normalized GitHub fact ready to become an Event. The discriminated union
 * keeps each `type` bound to its payload, so the Skill needs no casts and the
 * `switch` below is provably exhaustive. `id` is occurrence-based (from the raw
 * `activityId`) and `occurredAt` mirrors the payload timestamp.
 */
export type NormalizedGitHubEvent =
  | { type: typeof EventTypes.ReviewRequested; payload: ReviewRequestedPayload; id: string; occurredAt: string }
  | { type: typeof EventTypes.AssignmentReceived; payload: AssignmentReceivedPayload; id: string; occurredAt: string }
  | { type: typeof EventTypes.CheckFailed; payload: CheckFailedPayload; id: string; occurredAt: string };

/** Occurrence-based event id: identifies one happening, not the entity it touched. */
function eventId(raw: RawGitHubActivity): string {
  return `github:${raw.kind}:${raw.activityId}`;
}

/**
 * Turn one raw GitHub activity into a domain fact, or `null` when it is not
 * actionable for the configured user. Silence at the boundary is deliberate:
 * a review/assignment addressed to someone else, or a passing check, produces no
 * Event at all — before any Opportunity or understanding exists (#44).
 *
 * Vendor fields (pull/issue numbers, "workflow", logins) are translated into
 * domain-generic shapes here and go no further.
 */
export function normalizeActivity(
  raw: RawGitHubActivity,
  identity: GitHubIdentity,
): NormalizedGitHubEvent | null {
  switch (raw.kind) {
    case "review_request": {
      if (raw.requestedReviewer !== identity.login) return null;
      const payload: ReviewRequestedPayload = {
        reviewRequestId: raw.activityId,
        changeId: `${raw.repo}#${raw.pullNumber}`,
        title: raw.title,
        requestedBy: { externalId: raw.requestedBy.login, displayName: raw.requestedBy.name },
        location: `${raw.repo}#${raw.pullNumber}`,
        url: raw.url,
        requestedAt: raw.occurredAt,
      };
      return { type: EventTypes.ReviewRequested, payload, id: eventId(raw), occurredAt: raw.occurredAt };
    }
    case "assignment": {
      if (raw.assignee !== identity.login) return null;
      const payload: AssignmentReceivedPayload = {
        assignmentId: raw.activityId,
        itemId: `${raw.repo}#${raw.issueNumber}`,
        title: raw.title,
        assignedBy: { externalId: raw.assignedBy.login, displayName: raw.assignedBy.name },
        location: `${raw.repo}#${raw.issueNumber}`,
        url: raw.url,
        assignedAt: raw.occurredAt,
      };
      return { type: EventTypes.AssignmentReceived, payload, id: eventId(raw), occurredAt: raw.occurredAt };
    }
    case "check_run": {
      // Only the user's own failing checks are their concern.
      if (raw.conclusion !== "failure" || raw.owner !== identity.login) return null;
      const payload: CheckFailedPayload = {
        checkId: raw.activityId,
        changeId: `${raw.repo}#${raw.pullNumber}`,
        checkName: raw.name,
        title: `${raw.name} failed on "${raw.changeTitle}"`,
        location: `${raw.repo}#${raw.pullNumber}`,
        url: raw.url,
        failedAt: raw.occurredAt,
      };
      return { type: EventTypes.CheckFailed, payload, id: eventId(raw), occurredAt: raw.occurredAt };
    }
    default: {
      // Exhaustiveness: a new raw kind must be handled explicitly above.
      const _exhaustive: never = raw;
      return _exhaustive;
    }
  }
}
