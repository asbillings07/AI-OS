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

export interface GitHubSkillOptions {
  /** Defaults to captured fixtures (offline, key-free). */
  source?: GitHubSource;
  /** Who "the user" is, for deciding which activity is actionable. */
  identity?: GitHubIdentity;
}

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

  /** Fetch, normalize, and record all actionable activity as domain events. */
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
