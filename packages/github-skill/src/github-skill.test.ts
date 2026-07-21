import { describe, it, expect } from "vitest";
import {
  InProcessEventBus,
  SqliteEventStore,
  OrionRuntime,
  ProjectionHost,
  contextProjection,
  buildWorkItems,
  type ContextState,
} from "@orion/core";
import { githubActivity, githubIdentity, type RawGitHubActivity } from "@orion/fixtures";
import { GmailSkill } from "@orion/gmail-skill";
import { normalizeActivity } from "./normalize.js";
import { GitHubSkill, githubManifest } from "./skill.js";
import { FixtureGitHubSource } from "./source.js";

const NOW = "2026-07-15T17:00:00.000Z";

function newRuntime() {
  const store = new SqliteEventStore(":memory:");
  const bus = new InProcessEventBus();
  const context = new ProjectionHost(contextProjection);
  const runtime = new OrionRuntime({ bus, store, projections: [context as ProjectionHost<unknown>] });
  return { store, runtime, context };
}

const reviewFor = (login: string): RawGitHubActivity => ({
  kind: "review_request",
  activityId: `rev-${login}`,
  occurredAt: "2026-07-15T13:00:00.000Z",
  repo: "acme/orion",
  url: "https://github.com/acme/orion/pull/1",
  pullNumber: 1,
  title: "A change",
  requestedReviewer: login,
  requestedBy: { login: "dana", name: "Dana Lee" },
});

describe("GitHub normalization (Eng #8: the vendor shape stops here)", () => {
  it("emits ReviewRequested for a review addressed to the configured user", () => {
    const raw = githubActivity.find((a) => a.activityId === "gh-rev-128")!;
    const result = normalizeActivity(raw, githubIdentity);
    expect(result?.type).toBe("ReviewRequested");
    expect(result?.id).toBe("github:review_request:gh-rev-128");
    // Domain-generic payload: raw vendor-shaped fields do not leak through.
    // (`url` is an opaque display link and may still contain vendor path words.)
    const keys = Object.keys(result!.payload);
    for (const vendorKey of ["pullNumber", "requestedReviewer", "repo", "kind", "activityId"]) {
      expect(keys).not.toContain(vendorKey);
    }
  });

  it("stays silent for a review addressed to someone else", () => {
    expect(normalizeActivity(reviewFor("casey"), githubIdentity)).toBeNull();
  });

  it("emits AssignmentReceived with a domain-generic payload for the user's item", () => {
    const raw = githubActivity.find((a) => a.activityId === "gh-assign-204")!;
    const result = normalizeActivity(raw, githubIdentity)!;
    expect(result.type).toBe("AssignmentReceived");
    expect(result.id).toBe("github:assignment:gh-assign-204");
    expect(result.payload).toEqual({
      assignmentId: "gh-assign-204",
      itemId: "acme/orion#204",
      title: "Flaky prioritization test on CI",
      assignedBy: { externalId: "priya", displayName: "Priya Nair" },
      location: "acme/orion#204",
      url: "https://github.com/acme/orion/issues/204",
      assignedAt: "2026-07-15T12:00:00.000Z",
    });
  });

  it("stays silent for an assignment to someone else", () => {
    const raw = githubActivity.find((a) => a.activityId === "gh-assign-205")!;
    expect(normalizeActivity(raw, githubIdentity)).toBeNull();
  });

  it("emits CheckFailed with a domain-generic payload for the user's own failure", () => {
    const raw = githubActivity.find((a) => a.activityId === "gh-check-991")!;
    const result = normalizeActivity(raw, githubIdentity)!;
    expect(result.type).toBe("CheckFailed");
    expect(result.id).toBe("github:check_run:gh-check-991");
    expect(result.payload).toEqual({
      checkId: "gh-check-991",
      changeId: "acme/orion#126",
      checkName: "verify",
      title: 'verify failed on "Cross-source prioritization spike"',
      location: "acme/orion#126",
      url: "https://github.com/acme/orion/pull/126/checks",
      failedAt: "2026-07-15T14:20:00.000Z",
    });
  });

  it("stays silent for a passing check, or a failing check on someone else's change", () => {
    const passed = githubActivity.find((a) => a.activityId === "gh-check-992")!;
    expect(normalizeActivity(passed, githubIdentity)).toBeNull();

    // Failure predicate has two halves; this isolates the ownership half.
    const othersFailure: RawGitHubActivity = {
      kind: "check_run",
      activityId: "check-other",
      occurredAt: "2026-07-15T14:00:00.000Z",
      repo: "acme/orion",
      url: "https://github.com/acme/orion/pull/999/checks",
      pullNumber: 999,
      changeTitle: "Someone else's change",
      name: "verify",
      conclusion: "failure",
      owner: "casey",
    };
    expect(normalizeActivity(othersFailure, githubIdentity)).toBeNull();
  });

  it("keeps the payload timestamp equal to the occurrence time", () => {
    const raw = githubActivity.find((a) => a.activityId === "gh-rev-128")!;
    const result = normalizeActivity(raw, githubIdentity)!;
    const payload = result.payload as { requestedAt: string };
    expect(payload.requestedAt).toBe(result.occurredAt);
    expect(result.occurredAt).toBe(raw.occurredAt);
  });
});

describe("GitHub Skill ingestion (ADR-0010)", () => {
  it("records only actionable activity, all under the manifest source/types", async () => {
    const { runtime, store } = newRuntime();
    const events = await new GitHubSkill().ingest(runtime);

    // Three actionable fixtures; the three non-actionable twins are silent.
    expect(events).toHaveLength(3);
    expect(store.count()).toBe(3);
    expect(events.every((e) => e.source === githubManifest.source)).toBe(true);
    // Exact coverage: the fixtures exercise every declared producer type, and
    // nothing undeclared is emitted.
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(githubManifest.produces));
  });

  it("is idempotent: the same occurrence fetched twice yields one event", async () => {
    const { runtime, store } = newRuntime();
    const skill = new GitHubSkill();
    await skill.ingest(runtime);
    await skill.ingest(runtime);
    expect(store.count()).toBe(3);
  });

  it("keeps two distinct occurrences on the same entity as two events", async () => {
    // Same repo + PR + reviewer, but two different occurrence ids: e.g. a review
    // requested, removed, then requested again. Entity-based ids would collapse
    // these; occurrence-based ids must not.
    const base = reviewFor("me");
    const first: RawGitHubActivity = { ...base, activityId: "occ-1" };
    const second: RawGitHubActivity = { ...base, activityId: "occ-2" };
    const { runtime, store } = newRuntime();
    await new GitHubSkill({
      source: new FixtureGitHubSource([first, second]),
      identity: githubIdentity,
    }).ingest(runtime);
    expect(store.count()).toBe(2);
  });
});

describe("GitHub facts enter understanding but not the decision layer (#45 boundary)", () => {
  it("adds facts to the log and Context, but surfaces no Work Items", async () => {
    const { runtime, store, context } = newRuntime();
    const before = context.state as ContextState;
    const emailBefore = { threads: before.threads, people: before.people };

    const emitted = await new GitHubSkill().ingest(runtime);

    // Facts are on the log...
    expect(store.count()).toBe(emitted.length);
    expect(emitted.length).toBeGreaterThan(0);

    const after = context.state as ContextState;
    // ...core now UNDERSTANDS them: they enter Context as domain subjects (#45).
    // Subjects are persistent things; the log holds occurrences, and several
    // occurrences can map to one subject (requested/removed/requested again), so
    // assert every emitted occurrence is traceable via accumulated eventIds
    // rather than counting subjects == events.
    const subjects = [
      ...Object.values(after.reviews),
      ...Object.values(after.assignments),
      ...Object.values(after.checks),
    ];
    expect(subjects.length).toBeGreaterThan(0);
    const recordedEventIds = new Set(subjects.flatMap((subject) => subject.eventIds));
    expect(emitted.every((event) => recordedEventIds.has(event.id))).toBe(true);
    // ...the email side of Context is untouched...
    expect({ threads: after.threads, people: after.people }).toEqual(emailBefore);
    // ...and the decision layer stays thread-gated, so nothing surfaces yet (#46).
    expect(buildWorkItems(after, NOW)).toEqual([]);
  });

  it("does not let GitHub facts alter Gmail-derived Work Items", async () => {
    const { runtime, context } = newRuntime();
    await new GmailSkill().ingest(runtime);
    const gmailOnly = buildWorkItems(context.state as ContextState, NOW);

    const github = await new GitHubSkill().ingest(runtime);
    const githubIds = new Set(github.map((e) => e.id));
    const afterGithub = buildWorkItems(context.state as ContextState, NOW);

    // Identical rankings, and no work item traces to a GitHub event.
    expect(afterGithub).toEqual(gmailOnly);
    expect(
      afterGithub.some((item) => item.createdFromEventIds.some((id) => githubIds.has(id))),
    ).toBe(false);
  });
});

describe("seed evolution (composition upgrades an existing log)", () => {
  it("a Gmail-only log acquires GitHub facts, then stabilizes", async () => {
    const { runtime, store } = newRuntime();
    await new GmailSkill().ingest(runtime);
    const gmailCount = store.count();

    // Running both Skills adds the GitHub facts to the existing log...
    await new GmailSkill().ingest(runtime);
    await new GitHubSkill().ingest(runtime);
    const afterBoth = store.count();
    expect(afterBoth).toBeGreaterThan(gmailCount);

    // ...and running again is a no-op (deterministic ids dedupe).
    await new GmailSkill().ingest(runtime);
    await new GitHubSkill().ingest(runtime);
    expect(store.count()).toBe(afterBoth);
  });
});
