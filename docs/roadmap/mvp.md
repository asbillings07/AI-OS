# MVP Definition — Orion v0.1

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issue: #6 MVP Definition

This document defines exactly what **v0.1** is — and, just as importantly, what it is *not*. v0.1 is deliberately tiny. A clear "no" list is as important as the "yes" list (see Engineering Principle #9, *Earn abstraction*, and Product Principle #8).

---

## The one-sentence MVP

> **v0.1 reads my Gmail, understands what matters, and shows me a small, ranked, explained list of what deserves my attention today — in a single dashboard.**

One source (Gmail). One surface (Mission Control). Advisory only. That's it.

## Why this is the MVP

It's the smallest thing that can prove Orion's central bet: that a system can turn a raw stream of signals into *fewer, clearer, explained decisions* and earn the user's trust. Email is the ideal first source — high-volume, high-anxiety, and rich enough to exercise summarization, prioritization, and explanation. If Orion can make *email* feel calm and legible, the pattern generalizes to every other source later.

## What v0.1 actually validates

v0.1 isn't really "Gmail prioritization." Gmail is almost incidental. v0.1 exists to validate three product hypotheses:

1. **Decisions over data** — users prefer being told *what to do* over being given more to look at.
2. **Explainable over opaque** — users trust AI more when it shows *why*, and trust is what drives reliance.
3. **Permission to ignore** — users value *knowing what they can safely ignore* as much as knowing what needs attention.

If these prove true, the same reasoning engine expands to calendar, GitHub, financial alerts, and travel without changing its core promise. If they prove false, adding more sources wouldn't have saved us. That's why validating them on *one* source first is the entire point.

## The v0.1 loop (end to end)

```
Gmail → ingest as events → normalize → summarize → score priority → Mission Control dashboard → (optional) notify
```

Even at v0.1, this loop respects the constitution: email is ingested as **immutable events** (#5 Events are the source of truth), the AI layer is **advisory** and produces summaries/scores, and what the user sees always carries a **"why"** (#3 Explainability). We build the thin slice, but on the right spine.

---

## In scope (the "yes" list)

1. **Email Adapter (Gmail implementation)** — Orion has an *Email Adapter* interface; v0.1 happens to implement Gmail. Authenticate to one Gmail account and ingest messages as normalized events. Read-only. (Reinforces #8: *the domain is permanent, integrations are temporary.*)
2. **AI summary** — for each relevant message/thread, a concise, plain-language summary of what it is and what (if anything) it asks of the user.
3. **Priority scoring** — a ranking that surfaces the few things that matter and pushes the rest down. Deterministic rules combine with AI signals; the *ranking mechanism* is inspectable.
4. **Dashboard (Mission Control)** — a single surface that shows a *deliberately small* ranked list as *decisions with reasons*, plus an at-a-glance summary of the day's shape and a collapsed "handled / can wait" long tail. (See the [Mission Control Experience](../scenarios/mission-control-experience.md).)
5. **Notifications** — rare, earned alerts for genuine escalations only. Off-by-default-ish; never engagement-driven (Product Principle #6).
6. **"Why this?"** — every surfaced item can show the signals/reasoning behind its priority. This is in scope, not a v0.2 nicety — it's the trust mechanism.

## Explicitly out of scope (the "no" list)

These are *deliberate* exclusions for v0.1, not oversights:

| Excluded | Why it waits |
|---|---|
| **Jira** | Second source. Prove the loop on one source first. |
| **GitHub** | Second source. Same reason. |
| **Calendar** | Second source (tempting, but still deferred). |
| **Slack** | Second source. |
| **Mobile** | One surface first; desktop/web only. |
| **Voice** | Interaction complexity we haven't earned. |
| **Agentic behavior** | Orion is *advisory* in v0.1 — it never acts on the user's behalf, sends email, or takes irreversible actions. Advisory-before-agentic (Vision + Engineering #14). |
| **Multi-user / accounts / SaaS** | Built for one user (the author). No auth system beyond the single Gmail connection. |
| **Writing to Gmail** (send/archive/label) | Read-only in v0.1. No side effects on the user's inbox. |

If a shiny idea isn't in the "yes" list, the answer for v0.1 is **no** — and that's a feature.

---

## What "done" looks like (acceptance)

v0.1 is done when, using the author's real Gmail:

- Opening Mission Control shows a **deliberately small ranked list** (single digits, not a full inbox) of what matters, each phrased as a decision with its reason. *Small isn't accidental — it's the product.*
- The author can, within **~10 seconds**, state their email-driven priorities for the day.
- Every surfaced item answers **"why this?"** with real signals.
- Handled/low-priority mail is **out of the way** (collapsed long tail), and the author trusts they're not missing anything important.
- Notifications fire **only** for genuine escalations during a normal day.
- Nothing Orion does can **modify or send** email.
- The author **closes Mission Control with greater confidence than when they opened it** — measurable through interviews even if not perfectly quantitative.

## The MVP has failed if…

Defining "done" isn't enough — founders move goalposts. These are the conditions that mean v0.1 *failed*, regardless of what got built:

- The user still opens Gmail immediately after opening Mission Control "just to check."
- The user cannot explain *why* Orion ranked an item highly.
- The dashboard regularly grows into another inbox to triage.
- Notifications become routine rather than exceptional.
- The product requires configuration before it becomes useful.
- The user closes Mission Control feeling *more* anxious than when they opened it.

If any of these are true, no amount of shipped features counts as success.

## Non-functional guardrails (even for v0.1)

- **Privacy first** (#13): the single Gmail credential is stored securely, never committed; email content leaves the device only as required to reason, with clear purpose.
- **Advisory & reversible** (#14): read-only, no irreversible actions.
- **Explainable** (#3): reasoning captured well enough to display.
- **Event-sourced** (#5): ingested mail is immutable; the dashboard is a projection we can rebuild.

## Deliberately deferred (v0.2+ candidates, not commitments)

Second source (likely Calendar or GitHub), cross-source context ("this email is about Thursday's meeting"), learning from user corrections, richer notifications, and the first *agentic* action behind a deterministic gate. None of these belong in v0.1.

## How v0.1 feeds the bigger vision

v0.1 is small but not throwaway. Because it's built on events, an advisory AI layer, and explainable ranking, every later source and capability plugs into the same spine rather than requiring a rewrite (#8 permanent domain, #10 design for one/architect for many). We ship tiny; we don't ship a dead end.

## Related Documents

- [Product Vision](../vision/vision.md) (#1)
- [Product Principles](../principles/product.md) (#8)
- [The Mission Control Experience](../scenarios/mission-control-experience.md) (#7)
- [Engineering Principles](../principles/engineering.md) (#2)
