import {
  makeEvent,
  type EventEnvelope,
  type OrionRuntime,
  type SkillManifest,
  EventTypes,
} from "@orion/core";
import { githubIdentity, type GitHubIdentity } from "@orion/fixtures";
import { FixtureGitHubSource, type GitHubSource } from "./source.js";
import { normalizeActivity } from "./normalize.js";

/**
 * What the GitHub Skill declares to the platform (ADR-0010): its identity, the
 * `source` label it stamps on Events, and the domain event types it produces.
 * `satisfies` keeps the produced list honest against core's vocabulary.
 */
export const githubManifest = {
  id: "github",
  source: "github-skill",
  produces: [EventTypes.ReviewRequested, EventTypes.AssignmentReceived, EventTypes.CheckFailed],
  consumes: [],
} as const satisfies SkillManifest;

/**
 * Either use the fixture default (identity optional; defaults to the fixture
 * user) or bring your own Source — in which case an explicit identity is
 * REQUIRED. Silently reusing the fixture identity (`{ login: "me" }`) against a
 * real Source would discard nearly everything, so the type forbids it.
 */
export type GitHubSkillOptions =
  | { readonly source?: undefined; readonly identity?: GitHubIdentity }
  | { readonly source: GitHubSource; readonly identity: GitHubIdentity };

/**
 * The GitHub Skill (ADR-0010): a second, structurally different Source that joins
 * Orion purely as a Skill. It fetches activity, normalizes the actionable items
 * into domain events, and records them on the runtime — reaching the rest of
 * Orion only through events, never touching Context or other Skills.
 *
 * Non-actionable activity is dropped at normalization (silence at the boundary).
 * Event ids are occurrence-based, so re-ingesting is idempotent (the append-only
 * store dedupes, ADR-0008) while two distinct occurrences on the same entity stay
 * two distinct events.
 */
export class GitHubSkill {
  readonly manifest: SkillManifest = githubManifest;
  readonly #source: GitHubSource;
  readonly #identity: GitHubIdentity;

  constructor(options: GitHubSkillOptions = {}) {
    this.#source = options.source ?? new FixtureGitHubSource();
    this.#identity = options.identity ?? githubIdentity;
  }

  get sourceName(): string {
    return this.#source.name;
  }

  /**
   * Fetch, normalize, and record all actionable activity as domain events.
   *
   * The returned array is the events normalized and *submitted* during this call
   * — not necessarily events newly appended to the log. Because ids are
   * occurrence-based and the store is idempotent, a duplicate submission is
   * still returned here even though it added nothing. Callers that need the
   * number of *new* facts should compare store counts before/after (as
   * `bootstrap` does), not use `events.length`.
   */
  async ingest(runtime: OrionRuntime): Promise<EventEnvelope[]> {
    const activity = await this.#source.fetchActivity();
    const events: EventEnvelope[] = [];

    for (const raw of activity) {
      const normalized = normalizeActivity(raw, this.#identity);
      if (!normalized) continue;
      const event = makeEvent({
        type: normalized.type,
        source: this.manifest.source,
        payload: normalized.payload,
        id: normalized.id,
        occurredAt: normalized.occurredAt,
      });
      await runtime.record(event);
      events.push(event);
    }

    return events;
  }
}
