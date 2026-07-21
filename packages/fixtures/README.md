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
| `th-gh` | GitHub (`notifications@github.com`) | Pull request merged | Automated notification (and a future cross-source correlation case) | **Silence** — no opportunity |

Notes:

- **Silence is a valid output.** `th-news` and `th-gh` produce no Work Item;
  proving Orion stays quiet is as important as proving it surfaces things.
- **`th-gh`** foreshadows cross-source correlation (milestone _Architecture
  Proven Twice_): the same GitHub fact may later arrive directly from a GitHub
  Skill, and Orion must not present both as separate work.
- The exact bands depend on Capacity (time of day) and the prioritization
  weights; the catalog describes intent, and the tests pin the specifics.

## Using them

```ts
import { gmailMessages } from "@orion/fixtures";
```

The Gmail Skill's `FixtureGmailSource` uses these by default. See
[`docs/architecture/vertical-slice.md`](../../docs/architecture/vertical-slice.md)
for how they flow all the way to Mission Control.
