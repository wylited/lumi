# Commit ledger

Every unit of work, claimable. Read `AGENTS.md` first — especially **one commit owns a file; two
open commits never touch the same path.**

## Start here

The phase docs are the atomic specification — full `Do`, `Done when`, exact `Touches`, and handoff
notes for every commit below. Read your phase before you claim anything.

| phase | doc | owner |
|---|---|---|
| P0 | [`phases/P0-foundations.md`](./phases/P0-foundations.md) | all four, the night before |
| P1 | [`phases/P1-server-core.md`](./phases/P1-server-core.md) | **2 · server** |
| P2 | [`phases/P2-observer-loop.md`](./phases/P2-observer-loop.md) | **1 · the loop** (critical path) |
| P3 | [`phases/P3-desktop.md`](./phases/P3-desktop.md) | **3 · desktop + web** |
| P4 | [`phases/P4-desk-capture.md`](./phases/P4-desk-capture.md) | **4 · hardware + rig** |
| P5 | [`phases/P5-web.md`](./phases/P5-web.md) | **3 · desktop + web** (storefront only) |
| P6 | [`phases/P6-hackathon-day.md`](./phases/P6-hackathon-day.md) | all four |
| policy | [`02-intervention-policy.md`](./02-intervention-policy.md) | 1 |

**How a person works with agents.** Each owner runs one agent per commit, not per phase. An agent
gets exactly one row: the phase doc entry, its `Touches`, and that entry's `Done when`. It commits
only inside those paths. If two rows in your phase share a file, they are sequential — the ledger
says so — so give them to the same agent in order. You review and merge. You do not let an agent
pick its own scope, and you do not let two agents touch one file.

---

## How to claim

1. Pick a row whose **Depends** are ticked and whose **Owner** is `—`.
2. Put your name in Owner. Commit that one-line edit immediately: `chore(ledger): claim HELI-021`.
3. `git checkout -b heli-021`, do only that commit, PR titled exactly the commit message.
4. Merge, then tick **Done**.

Blocked more than 15 minutes? Drop the claim and say so out loud.

**Critical path:** `001 → 010 → 020 → 021 → 025`. Everything else exists to keep other people out
of that chain.

---

## P0 · Foundations — everything blocks on this

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☑ | HELI-001 | `chore(repo): workspace skeleton` | — | **no** | — |
| ☑ | HELI-002 | `chore(repo): lint and format` | 001 | yes | — |
| ☑ | HELI-003 | `feat(tokens): design system package` | 001 | yes | — |
| ☑ | HELI-004 | `feat(contracts): zod schemas` | 001 | yes | — |
| ☑ | HELI-005 | `feat(server): prisma schema and seed` | 001 | yes | — |
| ☑ | HELI-006 | `chore(repo): env and secrets` | 001 | yes | — |
| ☑ | HELI-007 | `feat(ui): component kit` | 001, 003 | yes | — |
| ☑ | HELI-008 | `docs(repo): readme and runbook` | 001 | yes | — |
| ☑ | HELI-009 | `docs(edge): the device contract` | — | yes | hardware |

## P1 · Server core — no model calls yet

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☑ | HELI-010 | `feat(server): fastify server and plugin layout` | P0 | **no** | 2 · server |
| ☑ | HELI-011 | `feat(server): auth and device pairing` | 010 | yes | 2 · server |
| ☑ | HELI-012 | `feat(server): device websocket and signal intake` | 010, 039 | yes | 2 · server |
| ☑ | HELI-013 | `feat(server): goal and session lifecycle` | 010 | yes | 2 · server |
| ☑ | HELI-014 | `feat(server): media intake and object store` | 010 | yes | 2 · server |
| ☑ | HELI-015 | `feat(server): desktop signal ingestion` | 010 | yes | 2 · server |
| ☑ | HELI-016 | `feat(server): SSE live channel` | 010 | yes | 2 · server |
| ☑ | HELI-017 | `feat(server): mock device and mock desktop` | 012, 015 | yes | 2 · server |
| ☑ | HELI-018 | `feat(server): analytics queries` | — | yes | 2 · server |
| ☑ | HELI-019 | `feat(server): register websocket route files by folder` | 010 | yes | 2 · server |
| ☑ | HELI-027 | `fix(server): make the zod type provider reach route generics` | 010 | **no** | 2 · server |
| ☑ | HELI-028 | `feat(server): the row to contract mappers` | 011 | **no** | 2 · server |
| ☑ | HELI-029 | `feat(contracts): the desktop socket union` | — | **no** | 2 · server |
| ☑ | HELI-039 | `fix(server): a shared module may sit in a route folder` | 019 | **no** | 2 · server |

`019`, `027`, `028`, `029` and `039` are additions to this phase, not in the original cut. `019`
extends the folder loader to `src/ws/` so `012` and `015` can register handlers without touching the
shared loader. `027` repairs `src/types/fastify.d.ts`, which `010` froze: the zod provider it
installed never reached a route generic, so `request.body` was `unknown` on every route that declared
a body schema. `028` gives Prisma-row-to-contract mapping one home, because `013` and `016` both need
it while `016` lands first. `029` defines `DesktopToApi` / `ApiToDesktop`, which P0 and `015` both
name and `packages/contracts` never had. `039` repairs the loader `019` wrote, which made a library
module in `src/ws/` impossible and crashed the boot.

**`039` is numbered outside the P1 block on purpose, and the id space is now the constraint to fix
before the next phase.** P1 addenda filled `027`–`029`, the gap between P2's last id and P3's first,
so a fifth P1 repair had nowhere to go that did not collide with a planned P3 row; `039` is the first
free id after P3's range. Adding rows to a phase is now cheaper than repairing one.

## P2 · The observer loop — this is the product

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☑ | HELI-020 | `feat(server): deepseek client and the assess step` | P1 | **no** | 1 · the loop |
| ☑ | HELI-021 | `feat(server): the intervention policy` | 020 | **no** | 1 · the loop |
| ☑ | HELI-022 | `feat(server): speech out and the local adapter` | 012 | yes | 1 · the loop |
| ☑ | HELI-023 | `feat(server): the orchestrator` | 020–022 | **no** | 1 · the loop |
| ☑ | HELI-024 | `feat(server): session summary` | 021 | yes | 1 · the loop |
| ☑ | HELI-025 | `test(server): the loop harness` | 023 | yes | 1 · the loop |
| ☑ | HELI-026 | `feat(server): fixtures and expected assessments` | P1 | yes | 1 · the loop |

P2 is complete: `b08ce33` (providers, `assess`, policy, speech and transport, summary, orchestrator,
fixtures, the harness), `4e297ec` (the Prisma binding and the cadence scheduler) and `81db492` (the
JSON mode DeepSeek actually supports, and the 6 s budget). **19 tests pass** — ten policy rules, six
summary, and the harness over the twelve fixtures plus idempotency, outcome judging and the budget
fallback. Verified against the live model on real frames.

**The last two columns are the integration, not the loop.** `fc75452` adds `observe/runtime.ts`, the
one call the server makes to start it. What is still missing is on the P1 side: `server.ts` must
call `createLoopRuntime(...)` and `scheduler.start()`, and `DeviceSocketLike.send` in `ws/registry.ts`
takes only a string, so tagged audio cannot reach the desk until it accepts a `Buffer`. Until then
the runtime reports audio as undelivered rather than pretending.


## P3 · Desktop — the base app

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☑ | HELI-030 | `feat(desktop): tauri shell and layout` | P0 | **no** | desktop+web |
| ☑ | HELI-031 | `feat(desktop): goal editor` | 030 | yes | desktop+web |
| ☑ | HELI-032 | `feat(desktop): live session view` | 030, 007 | yes | desktop+web |
| ☐ | HELI-033 | `feat(desktop): native signals sidecar` | 030 | **no** | desktop+web |
| ☐ | HELI-034 | `feat(desktop): app and window signal` | 033 | yes | desktop+web |
| ☐ | HELI-035 | `feat(desktop): input and idle signal` | 033 | yes | desktop+web |
| ☐ | HELI-036 | `feat(desktop): screen capture signal` | 033 | yes | desktop+web |
| ☑ | HELI-037 | `feat(desktop): notifications and audio` | 030 | yes | desktop+web |
| ☑ | HELI-038 | `feat(desktop): history and analytics` | 030, 018 | yes | desktop+web |
| ☑ | HELI-039 | `feat(ui): metrics kit` | 007 | yes | desktop+web |
| ☐ | HELI-070 | `feat(desktop): devices and pairing` (from 054) | 033, 011 | yes | desktop+web |

## P4 · Desk capture and the arm

**Change of plan, recorded here.** There is no Pi. The rig is a Mac with a camera mounted on a
robotic arm, driven over USB from the same machine. Pairing codes, the device socket, the LED ring
and the shutter are all retired; `docs/03-device-contract.md` is superseded by
`docs/03-desk-capture.md`. Registration is now a three-field setup in the app, and "camera control"
means **aiming the arm**. P1/011's pairing routes stay in the tree but nothing calls them.

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☐ | HELI-040 | `feat(desktop): camera capture and frame upload` | 009 | yes | 4 |
| ☐ | HELI-041 | `feat(server): frame intake and the latest frame` | 040, 014 | **no** | 4 |
| ☐ | HELI-042 | `feat(desktop): arm control and aiming` | 040 | yes | 4 |
| ☐ | HELI-043 | `feat(server): desk actions and physical interventions` | 041, 042, 022 | yes | 4 |
| ☐ | HELI-044 | `chore(desktop): desk setup replaces pairing` | 040, 042 | yes | 4 |

## P5 · Web — the storefront

The web is marketing only: home, the desk unit, the download, reservations, privacy. See the
decision note in `phases/P5-web.md`. Retired rows stay, struck through.

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☑ | HELI-050 | `feat(web): next app shell` | P0 | **no** | desktop+web |
| — | ~~HELI-051~~ | ~~`feat(web): analytics dashboard`~~ — moved to desktop 038 | | | |
| — | ~~HELI-052~~ | ~~`feat(web): session replay`~~ — moved to desktop 038 | | | |
| ☑ | HELI-053 | `feat(web): home page` | 050 | yes | desktop+web |
| — | ~~HELI-054~~ | ~~`feat(web): devices and pairing`~~ — moved to desktop 070 | | | |
| ☑ | HELI-055 | `feat(fixtures): contract-shaped demo data` | 004 | yes | desktop+web |
| ☑ | HELI-056 | `feat(web): the desk unit in 3D` | 050 | yes | desktop+web |
| ☑ | HELI-057 | `feat(web): device page` | 056 | yes | desktop+web |
| ☑ | HELI-058 | `feat(web): download page` | 050 | yes | desktop+web |
| ☑ | HELI-059 | `feat(web): order and reservations` | 056 | yes | desktop+web |
| ☑ | HELI-05A | `feat(web): privacy page` | 050 | yes | desktop+web |

## P6 · Hackathon day

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☐ | HELI-060 | `chore(repo): one-command boot` | P0–P5 | **no** | — |
| ☐ | HELI-061 | `feat(server): demo replay mode` | 060 | yes | — |
| ☐ | HELI-062 | `docs(repo): the run of show` | 060 | yes | — |
| ☐ | HELI-063 | `fix(desktop): projector pass` | P3 | yes | desktop+web |
| ☐ | HELI-064 | `test(repo): end-to-end rehearsal` | all | **no** | — |

---

## Suggested split for four people

Four of you. Five phases. So **desktop and web sit together** — the product and the storefront that sells it,
sharing `@heli/tokens` and `@heli/ui` — and the loop is its own person because it is the critical
path.

| who | phase(s) | claim | notes |
|---|---|---|---|
| **1 · the loop** | P2 | 020, 021, 023, 024, 025, 026 | the critical path. Protect this person from everything else. |
| **2 · server** | P1 (+ media relay) | 010–018, 041 | server core. Start the moment P0 lands. |
| **3 · desktop + web** | P3 + P5 | 030–039, 070, 050–05A, 063 | the product (the desktop app) and the storefront that sells it with the unit. |
| **4 · hardware + rig** | P4 + the contract | 009, 040–044 | owns `docs/03-desk-capture.md` and the arm adapter; nobody else touches `src-tauri/src/arm/**`. |
| **all four** | P0 | 001–008 | 001 alone first, then 002–008 in parallel, the night before. |

`022` (speech out) is the server-side piece the loop needs; it lands inside P2 as written. The old
`041` media relay is retired with the Pi — frame intake is now `041` in the new P4.
