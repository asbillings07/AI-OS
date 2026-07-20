# The Mission Control Experience

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issue: #7 Define the Mission Control Experience

This is **not a wireframe**. It's a narrative. It describes the ideal experience from the user's perspective — the feeling, the sequence, the moments that matter — so that everything we build can be measured against it. Layout, components, and visuals come later and serve this story; they do not define it.

---

## The core promise

> I open Mission Control, and within ten seconds I know what deserves my attention today — and what can safely wait.

Everything in this document is in service of that one sentence.

---

## The morning ritual

I wake up. Before Orion, my morning meant opening five tabs and reconstructing my own priorities from scratch — scanning email, skimming the calendar, checking what broke overnight, half-remembering the thing I promised someone on Friday. I *was* the integration layer, and it cost me my first sharp hour of the day.

Now I open Mission Control.

The first thing I notice is what *isn't* there. No unread badge screaming a number. No infinite list. No feed. Just a calm surface that looks like it has already done the thinking.

At the top, in plain language, it tells me the shape of my day:

> "Three things need you today. Two can wait until this afternoon. Everything else is handled or quiet."

I exhale.

That single sentence already did the most valuable thing — it told me the world is smaller than my anxiety assumed.

## The ten seconds

Below that, three items. Not thirty. Three.

Each one is a *decision*, not a pile of data:

- **"Reply to Dana before 11am — she's blocked on your answer and the deadline is today."**
- **"The contract from Acme changed a clause about payment terms. Review before you sign."**
- **"Your flight Thursday moved 90 minutes earlier. Your morning meeting now conflicts."**

I don't have to open anything to understand *why* these are here. Each item leads with the reason it matters. In ten seconds I know: someone is blocked, a decision has real stakes, and a plan just broke. That's my day's spine.

## The "why" is always one glance away

Under Dana's item, there's a quiet line: *"Why this?"*

I tap it. Orion shows its work: the thread where she asked, the fact that she said "blocked on you," the deadline it pulled from the project, and that two days have passed without a reply. Nothing magic. Just reasoning I can check.

This is the moment I started trusting it. Not because it was clever — because it was *transparent*. When it's right, I move faster. When it's wrong, I can see exactly where it went wrong and correct it, and it gets better.

## Permission to ignore

The best part isn't the three things. It's everything Orion is quietly telling me *not* to worry about.

There's a small, collapsed section: *"37 other things happened. None need you now."* I can expand it if I'm curious, but the point is I don't have to. Orion has taken responsibility for the long tail so I don't have to hold it in my head.

That's the feeling I couldn't get from any inbox: **permission to let the rest go.** The fear of "did I miss something?" is gone, because I trust the thing that's watching.

## Through the day

I close Mission Control and do actual work. This is the part that matters: Orion succeeds by getting *out of my way*.

It doesn't pull me back. No streaks, no "you haven't checked in," no manufactured urgency. The only time it reaches out is when something genuinely changes the answer to "what deserves your attention" — a real escalation, a new conflict, a deadline that just got closer than it looks.

When I check back mid-afternoon, the surface has updated. The two "can wait" items have surfaced now that it's their time. Dana's item is gone — Orion noticed I replied and quietly retired it. The day recomposed itself without me having to re-triage anything.

## The evening close

At the end of the day I glance one more time.

> "Nothing needs you tonight. Tomorrow morning: the Acme contract and a 9am with the design team. Rest."

That's it. I close it feeling *finished* rather than behind — not because I did everything, but because I trust that what mattered got my attention, and what didn't, didn't get to steal it.

---

## When Orion is wrong (recovery)

Orion *will* be wrong. The measure of trust isn't that Orion never makes mistakes — it's that mistakes are **understandable, correctable, and never hidden.**

One morning Orion ranks a newsletter above a quiet but important note from my accountant. It got it wrong. Here's what makes that moment survivable rather than trust-destroying: I can see *why* it misjudged ("flagged as high-volume sender you usually read promptly"), I can correct it in a couple of seconds ("not important" / "this sender matters"), and I can *see the correction land* — the item drops, and Orion acknowledges what it learned. Next time, that accountant's note is where it should be.

The recovery is part of the product, not an error state bolted onto the side. When Orion misjudges something, the user should be able to:

- **understand why** it happened (the same "why this?" reasoning, applied to the miss),
- **correct it in seconds**, with no ceremony,
- **see that correction respected** immediately, and
- **gain confidence that Orion learned something** from it.

Trust grows as much from graceful recovery as from perfect prediction. A product that is occasionally wrong but always correctable earns more trust than one that hides its reasoning and is usually right.

## The moments that define the experience

If we get nothing else right, we must get these right:

1. **The first sentence.** The at-a-glance summary of the day's *shape* ("three need you, two can wait, the rest is quiet"). This is where the ten-second promise lives.
2. **Decisions, not data.** Every surfaced item is phrased as something to *do* or *decide*, with the stakes and the deadline inline.
3. **"Why this?"** Reasoning is always one glance away, always inspectable, always in plain language.
4. **The quiet long tail.** What Orion is handling / deprioritizing is visible-on-demand but never in the way — this is what grants permission to ignore.
5. **Graceful retirement.** Items disappear when they're handled or no longer matter, without the user managing them. Orion cleans up after itself.
6. **Silence as a feature.** No news genuinely means no news. The user can trust quiet.
7. **Graceful recovery.** When Orion is wrong, the miss is understandable, correctable in seconds, and visibly respected — recovery is part of the experience, not an error screen.

## Edge cases that reveal our values

- **The quiet day.** When nothing is urgent, Mission Control says so plainly — *"Nothing needs you today"* — and doesn't invent work to look busy. A calm empty state is a feature, not a failure.
- **The overwhelming day.** When everything seems urgent, Orion's job is *harder ranking, not longer lists*. It still shows a small number and is explicit about what it deprioritized and why.
- **Orion is unsure.** When confidence is low, it says so ("I think this matters, but I'm not certain — here's why") rather than feigning authority. Honesty about uncertainty protects trust.
- **Orion was wrong.** When the user corrects it (dismisses, reprioritizes, marks "not important"), that correction is visibly respected and shapes future behavior. Being correctable is part of the experience.

## First run (earning trust from zero)

The very first time, Orion has no history and hasn't earned trust yet. So the first experience is honest about that: it explains what it's watching, shows its reasoning generously, and asks for light confirmation early ("Did I get this right?") — then gradually recedes as it earns the right to be quiet. Trust is the onboarding metric, not feature adoption.

## How we'll know it's working

- The user can state their day's priorities within ~10 seconds of opening it.
- The user stops opening the underlying tools "just to check."
- The user trusts silence — they don't compulsively re-open Mission Control.
- When asked "why is this here?", the answer is always available and usually right.
- Closing Mission Control produces relief, not dread.

## Related Documents

- [Product Vision](../vision/vision.md) (#1)
- [Product Principles](../principles/product.md) (#8)
- [Design Principles](../principles/design.md)
- [MVP Definition](../roadmap/mvp.md) (#6)
- [Understanding Engine](../architecture/understanding-engine.md) (#25) — the machinery that makes this experience possible
