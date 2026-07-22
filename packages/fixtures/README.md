# @orion/fixtures — scenario catalog

Captured, vendor-shaped sample data so Orion runs **offline, key-free, and
deterministically** (ADR-0009). The Gmail fixtures mirror the Gmail API's
`users.messages.get` (full format): headers, base64url bodies, `internalDate` in
epoch ms. This vendor shape lives here and in the Gmail Skill only — it never
reaches the domain (Eng #8).

Fixtures are the ground truth for tests and demos: each scenario exists to
exercise a specific branch of the decision loop, including the branches whose
correct output is **silence**.

## Gmail inbox

The default inbox (`gmailMessages`) is deliberately varied. Interpretations are
computed at a fixed `now` (the slice uses `2026-07-15T17:00:00Z`).

| Thread | From | Subject | What it exercises | Expected interpretation |
| --- | --- | --- | --- | --- |
| `th-dana` | Dana Lee (acme.com) | Can you review the Q3 deck? | Direct question, awaiting reply, aging a couple of days | **Needs attention** — Reply needed |
| `th-priya` | Priya Nair (acme.com) | Board update — need your input today | Explicit same-day ask | Reply needed (value high, recent) |
| `th-sam` | Sam Rivera (partner.io) | Contract draft → Re: Contract draft | Two messages, one thread, a follow-up bump | **Needs attention** — known correspondent + follow-up raises value |
| `th-fyi` | Jordan Blake | Quick idea to share (FYI) | A message with **no ask** ("nothing needed from you") | Low value → **Can wait** |
| `th-news` | The Weekly (`no-reply@…`) | Your Weekly Digest | Automated newsletter | **Silence** — no opportunity |
| `th-gh` | GitHub (`notifications@github.com`) | Pull request merged | Automated notification | **Silence** — no opportunity |
| `th-gh-review-128` | GitHub (`notifications@github.com`) | Review requested: Add retry to the event store | Automated notification that **mirrors** the GitHub `gh-rev-128` fact (same `acme/orion#128`) | **Silence** — the GitHub Skill represents this request; the email must not double it |

Notes:

- **Silence is a valid output.** `th-news`, `th-gh`, and `th-gh-review-128`
  produce no Work Item; proving Orion stays quiet is as important as proving it
  surfaces things.
- **`th-gh-review-128` + `gh-rev-128` are a real correlation pair.** The email
  notification and the GitHub `ReviewRequested` fact describe the *same*
  underlying review on `acme/orion#128`. As of #46 the GitHub side surfaces as a
  Work Item and the email stays silent — but for a *coincidental* reason
  (automated senders raise `LikelyLowValue`, never `ReplyNeeded`), **not** because
  Orion recognizes the two facts as the same occurrence. True cross-source
  de-duplication (collapsing correlated facts into one Work Item even when the
  duplicate is *not* an automated email) remains follow-up; the Subject-keyed,
  revision-scoped Attention seam added in #46 ([ADR-0012](../../docs/adr/0012-attention-is-a-projection-distinct-from-context.md))
  is where that policy will attach.
- The exact bands depend on Capacity (time of day) and the prioritization
  weights; the catalog describes intent, and the tests pin the specifics.

## GitHub activity

`githubActivity` approximates GitHub's REST/timeline resources. Each item carries
a `kind` discriminant and a stable `activityId` identifying **one occurrence**
(not the affected entity), so a request removed and re-added stays two facts. The
fixtures describe what GitHub reported; whether an item is _actionable_ is decided
by the GitHub Skill against the configured `githubIdentity` (`{ login: "me" }`).
That is why each actionable scenario has a non-actionable twin — the adapter must
produce **silence** at the boundary, before any understanding exists (#44).

| activityId | Kind | What it exercises | Expected (for `me`) |
| --- | --- | --- | --- |
| `gh-rev-128` | review_request | Review requested from `me` on `acme/orion#128` | `ReviewRequested` |
| `gh-rev-131` | review_request | Review requested from someone else | **Silence** |
| `gh-assign-204` | assignment | Issue assigned to `me` | `AssignmentReceived` |
| `gh-assign-205` | assignment | Issue assigned to someone else | **Silence** |
| `gh-check-991` | check_run | `verify` failed on `me`'s change | `CheckFailed` |
| `gh-check-992` | check_run | `typecheck` passed | **Silence** |

Notes:

- **The event names are domain-centric.** `ReviewRequested` / `AssignmentReceived`
  / `CheckFailed` never mention pull requests, issues, or workflows — those words
  stop at this file and the Skill (Eng #8).
- **`acme/orion`** is the same project referenced by the Gmail `th-gh`
  notification above; together they remain the fixture for cross-source
  correlation, which #46 set the stage for but deliberately left as follow-up.
- In #44 these land on the same log as Gmail but produce **no Context and no Work
  Items** — the core has no GitHub interpretation yet (that is #45).

## Using them

```ts
import { gmailMessages, githubActivity, githubIdentity } from "@orion/fixtures";
```

The Gmail Skill's `FixtureGmailSource` and the GitHub Skill's `FixtureGitHubSource`
use these by default. See
[`docs/architecture/vertical-slice.md`](../../docs/architecture/vertical-slice.md)
for how the Gmail fixtures flow all the way to Mission Control.
