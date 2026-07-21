import { githubActivity, type RawGitHubActivity } from "@orion/fixtures";

/**
 * Where raw GitHub activity comes from. The Skill depends on this seam, not on
 * GitHub itself, so fixtures and a future live client are interchangeable
 * (ADR-0010: a Skill owns its adapters). Fixtures-first keeps runs offline and
 * replayable (ADR-0009).
 *
 * Note: a concrete `LiveGitHubSource` is intentionally NOT shipped in #44. A
 * faithful one is a real integration project — authenticated-user identity,
 * repo/org scope, pagination, review/assignment/check discovery, rate limits,
 * and (critically) *occurrence-stable* ids from timeline/event resources rather
 * than current-state snapshots. Gmail already proved the live seam; this Skill
 * proves the contract with fixtures and defers the live client to its own issue
 * (#49).
 */
export interface GitHubSource {
  readonly name: string;
  fetchActivity(): Promise<RawGitHubActivity[]>;
}

/** The default, offline source: captured fixtures. No network, no keys. */
export class FixtureGitHubSource implements GitHubSource {
  readonly name = "github-fixtures";
  readonly #activity: RawGitHubActivity[];

  constructor(activity: RawGitHubActivity[] = githubActivity) {
    this.#activity = activity;
  }

  async fetchActivity(): Promise<RawGitHubActivity[]> {
    return this.#activity;
  }
}
