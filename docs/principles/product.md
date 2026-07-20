# Product Principles — Orion / Mission Control

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issue: #8 Product Principles

Where the [Product Vision](../vision/vision.md) says *why Orion exists* and the [Engineering Principles](./engineering.md) say *how we build it*, this document says **how the product should behave toward the user**. These are the rules we use to decide what to build, what to cut, and how any feature should feel. (See also [Design Principles](./design.md) for how interactions should *feel*.)

> Mission Control exists to protect attention.
>
> Every feature must answer one question: **"Does this help the user spend their attention better?"** If the answer is no, it doesn't belong — no matter how impressive, how requested, or how easy to build.

That question is the single filter every product decision passes through. Everything below is a more specific expression of it.

---

## 1. Protect attention above all

Attention — not time, not features, not data — is the resource Orion protects. Every screen, notification, and word competes for it, so every one must earn it.

- **What it means for the product:** The measure of a good feature is how much *thinking* it removes, not how much *capability* it adds. A feature that saves five clicks but adds a new thing to monitor may be a net loss.
- **The test:** *"Does this help the user spend their attention better?"* If we can't answer yes with a straight face, we don't ship it.

## 2. Surface decisions, not data

Orion's job is to tell the user *what to do about their world*, not to give them another place to go look at it.

- **What it means for the product:** The output is "here's what matters and why," not a feed, an inbox, or a dashboard to triage. **If the user still has to determine what matters next, the feature isn't finished.**
- **Anti-pattern to avoid:** Building "views" of data. Every time we're tempted to add a dashboard, ask whether we could instead surface the *decision* the dashboard would have led the user to.

## 3. Clarity over completeness

A short, correct, confident answer beats an exhaustive one. Orion would rather show three things that matter than thirty things that might.

- **What it means for the product:** Aggressively omit. Ranking and filtering are features, not compromises. We optimize for the *right* information, never the *most*.
- **The test:** If showing more would make the user's next decision *harder*, show less.

## 4. Explain why — always

Every time Orion says something matters, the user must be able to see *why*. Recommendations without reasons are just noise with confidence.

- **What it means for the product:** "Why is this here?" is a first-class, always-available answer — which signals, which context, which relationships led to this. Explanation isn't an advanced feature; it's the baseline.
- **Why it's a product principle, not just engineering:** Transparency is what turns a suggestion into something the user can *act on with confidence*. It is the product's moat (see Vision).

## 5. Give permission to ignore

Reducing anxiety isn't only about surfacing what's important — it's about credibly telling the user what can safely wait.

- **What it means for the product:** "What can wait" is as much a deliverable as "what matters now." Orion should make it *safe* to not look at the rest. Silence from Orion should mean "nothing needs you," and the user should be able to trust that.
- **The emotional target:** the user stops wondering whether they've forgotten something important.

## 6. Calm by default — never optimize for engagement

Orion succeeds when the user spends *less* time in it, not more. We will never use attention-farming tactics against a product whose entire purpose is to protect attention.

- **What it means for the product:** No engagement metrics as goals. No dark patterns, no artificial urgency, no notifications designed to pull the user back. Notifications are rare, earned, and always about *the user's* priorities — never ours.
- **The test:** If a feature's success would be measured by "time in app" or "sessions per day," it's the wrong feature.

## 7. Confidence is the outcome

The mechanics are attention, prioritization, and explanation. The *feeling* we're designing for is confidence — the quiet assurance that nothing important is slipping through.

- **What it means for the product:** Design for the moment *after* the user closes Mission Control. Did we leave them calmer and clearer, or more aware of how much they have to do?
- **The test:** Would this feature make the user trust Orion more, or make them double-check it?

## 8. Every feature must earn its place; a great "no" list is a feature

Restraint is a product value. What we refuse to build protects the experience as much as what we build.

- **What it means for the product:** Default to *no*. New capabilities must displace complexity, not accumulate it. We'd rather do a few things so well the user relies on them than many things they have to manage.
- **In practice:** Maintain an explicit "not now / not ever" list (see Vision Non-Goals and the MVP definition, #6). Saying no to a good idea to protect a great experience is a win, not a loss.

## 9. Meet the user where they already are

Orion is the intelligence layer *above* the user's tools, not a replacement they have to migrate to. It should reduce, not add, the number of places the user must tend.

- **What it means for the product:** Value on day one, without asking the user to change their habits, reorganize their life, or abandon tools they trust. Orion earns its place by making the existing mess legible — not by demanding a clean slate.

## 10. Work with human nature, not against it

Humans forget, get distracted, switch contexts, worry, and second-guess themselves. Orion's job is to **reduce the cost of being human** — to compensate for those limits, not to demand the user overcome them. The product adapts to people; people should not have to adapt to the product.

- **What it means for the product:** Never require the user to become a better organizer, planner, or memory system as a precondition for value. If a feature only works when the user is disciplined, it's designed wrong.
- **The test:** Does this assume an idealized, tireless user — or does it hold up for a distracted, forgetful, overloaded person on their worst day? Design for the worst day.

---

## How we decide what to build

A proposed feature should pass all of these before it's considered:

1. **Attention test** — Does it help the user spend their attention better? (If no, stop here.)
2. **Decision test** — Does it end in a clearer decision, or just more data? (#2)
3. **Clarity test** — Does it make the next choice easier, not harder? (#3)
4. **Explainability test** — Can Orion say *why*? (#4)
5. **Calm test** — Would success be measured by the user needing Orion *less*, not more? (#6)
6. **Restraint test** — Is this worth the complexity it adds, or is the honest answer "no"? (#8)

If a feature is compelling but fails a test, that's usually a sign it belongs to a *different* product — not to Orion.

## What Orion refuses to be (product-level)

Distinct from the Vision's scope non-goals, these are behavioral refusals that hold at *any* size:

- **No engagement-maximizing mechanics** — streaks, badges, manufactured urgency, or notifications designed to pull the user back.
- **No unexplained recommendations** — Orion never asks to be trusted blindly.
- **No infinite feeds or triage queues** — we surface decisions, not backlogs.
- **No vanity metrics shown to the user** — counts and dashboards that don't change a decision are noise.
- **No feature that only exists because a competitor has it.**

## Related Documents

- [Product Vision](../vision/vision.md) (#1)
- [Engineering Principles](./engineering.md) (#2)
- [Design Principles](./design.md)
- [The Mission Control Experience](../scenarios/mission-control-experience.md) (#7)
- [MVP Definition](../roadmap/mvp.md) (#6)
