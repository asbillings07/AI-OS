# AI-OS

Attention is your most valuable resource. This system is designed to protect it.

Mission Control exists so you can spend less time deciding what to do, and more time doing work that matters.

Orion is a personal operating system that serves as the intelligence layer for your digital life. It turns the constant stream of signals from your tools — email, calendar, code, messages, and more — into a small number of clear, explained decisions, and tells you what can safely wait.

> **The purpose of v0.1 is architectural validation, not features.** Every proposed change is measured against a single question: *does it validate the architecture?* If not, it waits. This keeps the first vertical slice ([#18](docs/architecture/vertical-slice.md)) honest — one complete loop that exercises every ADR, rather than a pile of half-connected features.

## Living Documents

Orion's documentation is a product artifact, not an afterthought — it preserves the *reasoning* behind the system as it evolves. These are living documents: they are meant to be **referenced while building**, and to evolve alongside the software.

Start here: **[docs/README.md](./docs/README.md)** — the documentation strategy and full index.

The governing documents (the stable core):

- [Product Vision](./docs/vision/vision.md) — why Orion exists
- [Product Principles](./docs/principles/product.md) — what kind of product Orion should be
- [Design Principles](./docs/principles/design.md) — how interactions should feel
- [Engineering Principles](./docs/principles/engineering.md) — how the software is built
- [The Mission Control Experience](./docs/scenarios/mission-control-experience.md) — the ideal experience, as a narrative
- [MVP Definition](./docs/roadmap/mvp.md) — exactly what v0.1 is (and isn't)

Faster-moving documentation lives in [`/docs/adr`](./docs/adr), [`/docs/domain`](./docs/domain), [`/docs/architecture`](./docs/architecture), [`/docs/roadmap`](./docs/roadmap), and [`/docs/scenarios`](./docs/scenarios), and must stay aligned with the governing documents above.

## Implementation

Orion is a TypeScript monorepo (npm workspaces), structured to grow into `apps` and `packages`:

```
apps/
  mission-control/     # Next.js — the calm attention dashboard
packages/
  core/                # framework-free domain + engine (the permanent part, Eng #8)
    events/            #   the immutable Event envelope (ADR-0002)
    bus/               #   in-process Event Bus: publish / subscribe / replay (ADR-0008)
    store/             #   SQLite append-only log + projections (ADR-0009)
    understanding/     #   Context + Signals — the Understanding Engine (ADR-0005)
    opportunity/       #   Opportunity Detection (#26)
    capacity/          #   Capacity (#10)
    prioritization/    #   ranked, explained Work Items (#29)
    observability/     #   structured, opt-in logging of the decision loop
  ai/                  # AI capability layer: ask for capabilities, not providers (ADR-0011)
  gmail-skill/         # the first Skill (ADR-0010) — email in, domain events out
  fixtures/            # replayable sample data for key-free, deterministic runs ([catalog](packages/fixtures/README.md))
```

### Requirements

- **Node 24 LTS** (pinned in [`.nvmrc`](./.nvmrc); enforced by `engines`). Run `nvm use` to match.

Getting started:

```bash
npm install
npm run typecheck
npm test
npm run slice        # run the whole decision loop in the terminal (no keys, no network)
```

The whole slice runs with no API keys and no network: Gmail is fixtures-first and the default AI is a deterministic stub. See [the vertical-slice walk-through](docs/architecture/vertical-slice.md) for how a message flows all the way to Mission Control and back.

### Operational commands

Local developer ergonomics for the append-only event log (the source of truth, ADR-0009):

| Command | What it does |
| --- | --- |
| `npm run bootstrap` | Create the log if needed and seed Gmail fixtures once (idempotent). |
| `npm run db:rebuild` | Rebuild all projections by replaying the log — proof that state is disposable. |
| `npm run log:inspect` | Print the raw event log in order (read-only). |
| `npm run db:reset` | Wipe the local log; the next boot re-seeds from fixtures. |
| `npm run build:mission-control` | Production build of the Next.js app. |

To run the dashboard: `npm run bootstrap`, then `npm --workspace @orion/mission-control run dev`.

> **Privacy:** `log:inspect` prints event payload previews. With fixtures this is harmless, but against real Gmail those previews may contain message content, names, and addresses. Treat inspector output as private — don't paste it into public issues or logs.

> **Note:** Stop Mission Control before `db:reset` — deleting the SQLite file (and its WAL/SHM sidecars) while the app holds it open can behave unpredictably.

### Environment variables

Everything works with **none** set. All are optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORION_LOG` | _(off)_ | Any truthy value (`1`, `true`, `debug`) emits a structured JSON trace of the decision loop to stderr. `0`/`false`/`off`/empty = off. |
| `ORION_DB_PATH` | `apps/mission-control/.data/orion.db` | Path to the SQLite event log, shared by the app and the CLI tools above. |
| `ORION_AI_API_KEY` | _(unset)_ | If set, routes AI capabilities to an OpenAI-compatible HTTP provider instead of the deterministic stub. |
| `ORION_AI_BASE_URL` | OpenAI API | Base URL for the HTTP AI provider. |
| `ORION_AI_MODEL` | `gpt-4o-mini` | Model name for the HTTP AI provider (never leaks past the AI layer). |

Example: `ORION_LOG=1 npm run slice`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) — contributions are held to the same standard whether written by a human or AI. It includes the recommended reading order, workflow, coding standards, and the PR/issue/ADR templates. The single most useful thing to read first is [The Decision Loop](./docs/domain/mental-model.md).
