# Design Principles — Orion / Mission Control

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-19
> Related issue: #8 Product Principles · #12 Documentation Strategy

The [Product Principles](./product.md) say *what kind of product* Orion should be. These **Design Principles** say *how the product should feel to interact with* — the sensory and interaction rules that make Orion recognizably itself. They answer: **"What should the user consistently experience?"**

The north star for all of them: **Mission Control should feel calm.** Where other tools scream, Orion whispers (see [The Mission Control Experience](../scenarios/mission-control-experience.md)). Every design choice either protects that calm or erodes it.

---

## 1. Calm over stimulation

The interface should lower the user's heart rate, not raise it.

- **What it means:** Generous whitespace, restrained color, minimal motion, no unread-count badges, no red dots competing for attention. The first thing the user should notice is *what isn't there.*
- **The test:** If an element exists to *grab* attention rather than *reward* it, remove it. Color and motion are reserved for genuine meaning, never decoration.

## 2. One primary thing per view

Every screen has a single, obvious focus. The user should never have to hunt for where to look first.

- **What it means:** Ruthless visual hierarchy. The day's shape and the few decisions that matter dominate; everything else is visually subordinate or hidden until asked for.
- **Anti-pattern:** Equal-weight grids of cards, dashboards where five things compete for the eye. If everything is emphasized, nothing is.

## 3. Progressive disclosure — decision first, detail on demand

Lead with the decision. Reveal supporting detail only when the user reaches for it.

- **What it means:** The default view is the smallest thing that lets the user act. Depth (the source email, the full reasoning, the long tail) is always *one* interaction away — never zero (overwhelming), never three (buried).
- **The test:** Can the user act on the surface without opening anything? Can they get the full "why" in a single gesture?

## 4. Explanation is always reachable

"Why is this here?" is a permanent, consistent affordance — never a hidden or advanced feature.

- **What it means:** The same "why this?" interaction appears everywhere Orion makes a judgment, and it always answers in plain language with real signals. Explanation is designed *in*, not bolted on.
- **Why it's a design principle:** Reachability and consistency of the explanation are what make transparency *feel* trustworthy, not just technically true.

## 5. Copy is the interface

In a product that surfaces decisions in words, the writing *is* the UI. A sentence does more work than a component.

- **What it means:** Plain, precise, human language. No jargon, no cutesy tone, no alarmist urgency. "Three things need you today" beats any chart. Words are chosen as carefully as pixels. **If removing a sentence improves the interface, remove the sentence.**
- **Forward reference:** Orion's voice (calm, confident, transparent, humble, concise — never alarmist, never robotic, never overly cheerful) deserves its own doc: `tone-and-voice.md`. Until it exists, this principle governs.

## 6. Quiet and empty states are first-class

Silence is a feature, so it must be *designed*, not treated as an absence.

- **What it means:** "Nothing needs you today" is a deliberate, reassuring state — not a blank screen or an error. The quiet day should feel like success, and it should look intentional.
- **The test:** Does the empty/quiet state make the user feel *taken care of*, or *abandoned/broken*?

## 7. Invisible until needed — Orion disappears whenever possible

The interface should stay out of the user's way until it has something meaningful to contribute. This is the natural culmination of calm (#1), progressive disclosure (#3), and quiet states (#6).

- **What it means:** Good design is measured as much by what remains *invisible* as by what is shown. Chrome, controls, and information appear when they earn their place and recede when they don't. Mission Control succeeds by getting out of the user's way — the same way it succeeds by getting the user out of their tools.
- **The test:** Could this element be hidden until the moment it's actually useful? If so, hide it.

## 8. Correction is effortless and visibly respected

Interacting with Orion when it's wrong should feel as good as when it's right.

- **What it means:** Dismissing, reprioritizing, or marking "not important" takes one gesture, no dialogs or ceremony — and the result is *immediately* visible (the item moves/leaves, Orion acknowledges what changed). See recovery in [The Mission Control Experience](../scenarios/mission-control-experience.md).
- **Anti-pattern:** Corrections that require menus, confirmations, or that vanish without acknowledgment. The user must *see* that they were heard.

## 9. Speed is a feeling, not a metric

The ten-second promise is an interaction-design constraint. Perceived speed protects calm.

- **What it means:** Time-to-clarity is designed for: fast loads, no layout shift, information appearing in priority order. Latency and jank read as stress; the product must feel instantly legible.
- **The test:** From open to "I know my day," how many seconds and how much scrolling? Fewer is the whole game.

## 10. Consistency so it feels like one mind

Orion should feel like a single, coherent presence — not a collection of screens built by different people.

- **What it means:** Consistent patterns for surfacing decisions, showing "why," handling corrections, and rendering quiet states — across every source and surface. The same interaction should always mean the same thing.
- **Why it matters:** Consistency is what lets trust *transfer* — trust earned on email carries to calendar, code, and beyond.

## 11. Design for the worst day, not the demo

The interface must hold up for a distracted, overloaded person on a bad day — not just a clean screenshot.

- **What it means:** Test with real, messy volume: hundreds of items, conflicting priorities, ambiguous signals. The overwhelming day should produce *harder ranking and clearer hierarchy*, never a longer, scarier list. (Mirrors Product Principle #10, *Work with human nature.*)

---

## How we evaluate a design

A screen, flow, or component should pass these before it ships:

1. **Calm test** — Does it lower or raise stress? (#1)
2. **Focus test** — Is there one obvious primary thing? (#2)
3. **Act-on-surface test** — Can the user act without digging, and reach "why" in one gesture? (#3, #4)
4. **Copy test** — Is the language plain, precise, and un-alarming? (#5)
5. **Quiet test** — Is the empty/low state designed and reassuring? (#6)
6. **Invisibility test** — Could this stay hidden until it has something meaningful to contribute? (#7)
7. **Correction test** — Is being wrong recoverable in one effortless, acknowledged gesture? (#8)
8. **Speed test** — Time-to-clarity in seconds, no jank? (#9)
9. **Worst-day test** — Does it hold up under real, messy volume? (#11)

## Related Documents

- [Product Vision](../vision/vision.md) (#1)
- [Product Principles](./product.md) (#8)
- [Engineering Principles](./engineering.md) (#2)
- [The Mission Control Experience](../scenarios/mission-control-experience.md) (#7)
- `tone-and-voice.md` — planned (Orion's voice/copy principles)
