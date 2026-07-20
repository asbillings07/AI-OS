# ADR-0001: Orion is a Situational Awareness System, not a Task Manager

> Status: Accepted
> Date: 2026-07-19 · Deciders: @asbillings07
> Related: #11, [Vision](../vision/vision.md), [Product Principles](../principles/product.md)

## Context

There is a strong gravitational pull for any productivity software to become a task manager — lists, due dates, checkboxes, projects. That model puts the burden back on the user: *they* must capture, organize, and maintain the system. It optimizes for tracking work, not for understanding what matters.

Orion's premise is different: the scarce resource is **attention**, and the user is already drowning in signals across many tools. What they lack is not a place to store tasks — it's *awareness* of what deserves their attention right now and why.

## Why now?

This is the root decision from which every other ADR follows — the event model, work items, prioritization, and UI are all consequences of *what kind of system Orion is*. It must be settled first, before any of those can be designed without risking a contradictory foundation.

## Decision

**Orion is a situational awareness system.** Its core job is to continuously understand the user's world and surface *what matters and why* — not to be a place where the user manually manages tasks.

Concretely: Orion derives understanding from real events, presents decisions with reasons, and takes responsibility for the long tail. It does not require the user to capture, categorize, or groom lists to get value.

## In one sentence

> Orion is a system for understanding what deserves attention, not a place to manage tasks.

## Consequences

- **Positive:** Value with zero user maintenance; the product works even when the user is disorganized (Product Principle #10). It differentiates Orion from every to-do app.
- **Negative / costs:** We forgo the familiar, easily-understood task-manager mental model; we must teach a new one. "Awareness" is harder to build than a list.
- **Follow-ups:** A *Work Item* concept still exists (see ADR-0003), but it emerges from awareness — it is not a user-maintained to-do.

## Principles

- **Supports:** Vision (attention as the resource); Product #1 (protect attention), #2 (surface decisions not data), #5 (permission to ignore).
- **Trade-offs:** Accepts a steeper conceptual onboarding cost vs. the instantly-familiar task-list model, in exchange for a fundamentally more valuable promise.

## Alternatives considered

- **Task/project manager** (Todoist/Motion-like): rejected — puts maintenance burden on the user and optimizes for tracking, not attention.
- **Unified inbox / aggregator**: rejected — still "another place to check," surfaces data not decisions.
