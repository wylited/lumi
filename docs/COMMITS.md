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
| P7 | [`phases/P7-onboarding-and-live.md`](./phases/P7-onboarding-and-live.md) | **2 · server** and **3 · desktop + web** |
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
| ☑ | HELI-033 | `feat(desktop): native signals sidecar` (re-check after toggling a permission not yet run) | 030 | **no** | desktop+web |
| ☑ | HELI-034 | `feat(desktop): app and window signal` | 033 | yes | desktop+web |
| ☑ | HELI-035 | `feat(desktop): input and idle signal` | 033 | yes | desktop+web |
| ☑ | HELI-036 | `feat(desktop): screen capture signal` | 033 | yes | desktop+web |
| ☑ | HELI-037 | `feat(desktop): notifications and audio` | 030 | yes | desktop+web |
| ☑ | HELI-038 | `feat(desktop): history and analytics` | 030, 018 | yes | desktop+web |
| ☑ | HELI-039 | `feat(ui): metrics kit` | 007 | yes | desktop+web |
| — | ~~HELI-070~~ | ~~`feat(desktop): devices and pairing`~~ — pairing is gone; the desk panel is 046 | | | |

## P4 · Desk capture and the arm

**Change of plan, recorded here.** There is no Pi. The rig is a Mac with a camera mounted on a
robotic arm, driven over USB from the same machine. Pairing codes, the device socket, the LED ring
and the shutter are all retired; `docs/03-device-contract.md` is superseded by
`docs/03-desk-capture.md`. Registration is now a three-field setup in the app, and "camera control"
means **aiming the arm**. P1/011's pairing routes stay in the tree but nothing calls them.

The rig agent is **`apps/edge`** (Python, headless): it owns the arm, the camera and the speaker, and
can be restarted without touching the UI. The desktop app owns signals **and the setup UI**; the
server owns intake, actions and persistence. Full detail, including the Python interfaces, is in
`phases/P4-desk-capture.md`.

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☑ | HELI-040 | `feat(edge): the rig agent, camera capture and frame upload` | 009 | yes | 4 |
| ☑ | HELI-041 | `feat(server): frame intake and the newest frame` | 040, 014 | **no** | 2 |
| ☐ | HELI-042 | `feat(edge): the arm adapter and aiming` | 040 | yes | 4 |
| ☑ | HELI-043 | `feat(contracts): the desk socket, registration and actions` | 004 | **no** | 2 |
| ☑ | HELI-044 | `feat(server): desks, the desk socket, and actions with acks` | 043, 041 | **no** | 2 |
| ☐ | HELI-045 | `feat(edge): the action client and audio playback` | 042, 044 | yes | 4 |
| ☐ | HELI-046 | `feat(desktop): setup — the goal, the watch, the desk` | 044, 072 | yes | 3 |
| ☑ | HELI-047 | `feat(contracts): the line reaches the desk` | 043 | yes | 4 |
| ☑ | HELI-048 | `feat(server): the observe loop starts` | 020 | **no** | 4 |

`041` landed in `879a5d9` as a draft and was reviewed and finished by owner 2; its `Done when` is
proved with curl uploads, so it does not wait on `040`'s rig agent.

**The pairing routes and the device socket are retired but not deleted.** `044`'s `Done when` asks for
`grep -r "ws/device" apps/` to find nothing but the retired file, and that cannot be true yet: the
**mocks still drive the retired path** — `dev/mock-device.ts` pairs over `POST /v1/devices/pair` and
connects to `/ws/device`, and `dev/mock-desktop.ts` reads `/v1/devices` — and those mocks are the
demo's fallback until `040`'s rig agent exists. Deleting `src/ws/device.ts` and `src/routes/devices.ts`
now would break `pnpm server:mock` for everyone, and neither file is in `044`'s `Touches`. So this is
the phase doc's own alternative branch: marked deleted here, with the reason. The deletion belongs with
`040`, in the commit where the mocks stop being the only thing that talks to a desk. `services/session.ts`
only mentions the device socket in comments, so nothing else depends on it. `043` is the contracts gate: nothing desk-shaped should be
written before it lands.

`047` is an addendum to `043` (`b7ae2cd`), which carries actions down `/ws/desk` and no audio.
`docs/03-desk-capture.md` says the rig plays the line — "Speech is played on the Mac" — and `045`
is written against that, so the desk socket gains `ApiDeskAudioOut` (an `audio.out` header and then
the tagged `0x02` PCM that follows it, exactly as the device contract had it) and `result.durationMs`
on the ack. Additive: nothing that already read `ApiToDesk` or `DeskActionResult` changes shape.
**`044` owes the send**, on its own row: with the socket connected, an `audio.out` header then the
`0x02`-tagged PCM, one line at a time. The rig half is `045`.

`048` starts the loop, which no commit did: `createLoopRuntime(...)` and `scheduler.start()` were
never called, so nothing was ever assessed outside a test. `outbound.ts` (from `d2c84a7`) builds the
senders from one lookup — session id in, live desk socket out — and **nothing in the tree can answer
it yet**: the desk socket is `044`'s and `ws/desktop.ts` keeps its connections private behind no
session index. Until one of them exposes that lookup the loop records every line as undelivered,
which is what its log says, one line per drop.

`040`, `042`, `045`, `047` and `048` are ticked with the lines that are literally true and the
lines that are not. `040`: `uv run heli-rig --once` answers `201` and `GET /v1/desk` counts the
frames climbing; the camera going away is a logged error and a retry, proved by stopping the
console's vision process under a running rig. `042`: `aim(5, -3)` from pan -5.01/tilt -60.75
settled at pan 4.92/tilt -3.16 on the real arm, `nod` and `home` moved it and acked real poses,
and with armd down the caps report `arm: null` and `arm.*` is refused with `no_arm` -- **its
`Done when` is not met for `point(x, y)`**, which needs the capture rectangle the setup UI (046)
records, and no calibration rect exists on this bench. `045`: every action in `DeskAction` was
executed and acked against a desk server speaking the landed contract, with the real camera and
the real speaker, a 1.2 s line audible and acked `done/durationMs: 1200`; **its `Done when` is not
met end to end**, because "an action from `POST /v1/desks/:id/actions` is executed and acked from
the rig" needs that route, and `044` has not landed -- the rig half is done and validated against
the contract. `047`: `pnpm --filter @heli/contracts build` emits `ApiDeskAudioOut` and
`DeskActionResult.durationMs` into the JSON Schema, and `pnpm typecheck` is clean across the
workspace. `048`: the server boots with the loop, logs its cadence and its open-session count,
answers `/healthz` while it runs, and stops the scheduler before it closes on SIGTERM; **its
`desk` lookup is `() => null`**, so until `044` (or a session index on the desktop socket)
supplies it, every line the loop decides on is recorded as undelivered, which the outbound log
says once per drop.

Three of the rows understated their `Touches:`, so the ledger now carries what was really
touched: `040` also owns `heli_rig/capture.py`, `conftest.py`, `.gitignore` and its five test
modules; `042` also owns `heli_rig/arm/console_arm.py` (the console transport is a driver of its
own) and `tests/test_calibration.py`; `045` also owns `heli_rig/registration.py` (the desk's
credentials) and its four test modules plus `tests/fake_desk.py`. `047` touches
`packages/contracts/src/desk.ts` and `scripts/emit-json-schema.ts`; `048` touches
`apps/server/src/index.ts` and nothing else.

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
| ☑ | HELI-05B | `style(repo): Lumi — the name, the mark, the app` | 05A | yes | desktop+web |

## P6 · Hackathon day

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☐ | HELI-060 | `chore(repo): one-command boot` | P0–P5 | **no** | — |
| ☐ | HELI-061 | `feat(server): demo replay mode` | 060 | yes | — |
| ☐ | HELI-062 | `docs(repo): the run of show` | 060 | yes | — |
| ☐ | HELI-063 | `fix(desktop): projector pass` | P3, 074 | yes | desktop+web |
| ☐ | HELI-064 | `test(repo): end-to-end rehearsal` | all | **no** | — |

## P7 · Onboarding and the live monitor

Two surfaces, and they are the demo. The onboarding is `046`, extended in place: it now owns all
three screens — the goal drafted from a sentence, the watch proved live, the desk aimed — and that is
the specification. `071` and `072` unblock it. Full `Do` and `Done when` in
`phases/P7-onboarding-and-live.md`.

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☐ | HELI-071 | `fix(server): per-source frames, and the assess step sees both` | 041 | **no** | 2 · server |
| ☐ | HELI-072 | `feat(server): drafting the goal from a sentence` | 004, 020 | yes | 2 · server |
| ☐ | HELI-074 | `feat(desktop): the live monitor, split` | 071, 032 | yes | 3 · desktop + web |
| ☐ | HELI-075 | `feat(desktop): the focused element, and a consent screen that matches reality` | 033, 046 | yes, after 046 | 3 · desktop + web |
| ☐ | HELI-076 | `chore(desktop): preflight and demo reset` | 046 | yes, after 046 | 3 · desktop + web |

`047` and `048` belong to P4 and are done; P7 starts at `071`, and `073` is deliberately unassigned
for the next addendum. **`071` is the gap worth knowing about**: the drafted frame intake ignored
`x-heli-source`, so a screen frame and a camera frame collide in “the newest frame” and the model can
be shown a screenshot believing it is the page. The assess step will read both once `071` lands — the
contracts already model `kind: 'desk' | 'screen'`.

**Storage: keep everything.** Sessions are short and single-user, so `071` stores every frame for the
session and there is no retention row. The consent screen says exactly that. `075` makes
Accessibility real — `focus.element` as role and accessible title, never a value — so every consent
row is a signal a module actually emits.

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
| **4 · hardware + rig** | P4 + the contract | 009, 040, 042, 045 | owns `docs/03-desk-capture.md` and everything under `apps/edge/`; nobody else touches `heli_rig/arm/**`. |
| **all four** | P0 | 001–008 | 001 alone first, then 002–008 in parallel, the night before. |

## Who does what next

Reading order for each person. Everything above is either ticked or listed here.

| who | next | why |
|---|---|---|
| **1 · the loop** | P2 is done. Take **`061`** (replay mode) — the demo fallback drives the same bus the loop already publishes on — then **`062`** (the run of show). | The critical path is clear; the demo fallback is the highest-value unclaimed work. |
| **2 · server** | **`071`** (per-source frames), then **`072`** (goal drafting) — both start immediately. Then **`060`** (one-command boot). | `071` is the bug that would show a screenshot as the page; `072` is what `046` renders. |
| **3 · desktop + web** | **`046`** (the three screens, after `072`), then **`074`** (the monitor, after `071`), then **`075`** and **`076`**, then **`063`**. | The onboarding and the monitor are the demo; everything else in this lane is done. |
| **4 · hardware + rig** | **`042`** (record the calibration rect, then `point(x, y)`), then **`045`** end-to-end: `044` has landed, so a real action can arrive from this server. | Both rows are unclaimed because their `Done when` lines are not met; the remaining distance is one bench session. |
| **all four** | P6: `060` one-command boot, `061` replay, `062` run of show, `063` projector, `064` rehearsal. Claim these early. | They are what make the demo survive the room. |

`022` (speech out) is the server-side piece the loop needs; it lands inside P2 as written. The old
`041` media relay is retired with the Pi — frame intake is now `041` in the new P4.

## Unclaimed, and what is left

`042` and `045` are back to **unclaimed** on the row's own owner slot, because their `Done when`
lines are not met and whoever takes them next should not have to argue with a tick:

- **`042`** — the arm adapter, the aiming, and now the calibration recording all landed and are
  verified on the real arm (`aim(5, -3)` settles inside 1.5 deg in 7.0 s; `nod`, `home`, the stall
  report and the `no_arm` refusals all exercised live). What is missing is the one line that needs
  a person at the desk: `point(x, y)` landing within tolerance, which needs a recorded rectangle
  (`heli-rig calibrate --rect x,y,w,h`, in `apps/edge/README.md`) that this bench has never had.
- **`045`** — the socket, the dispatcher, the audio and their 33-odd tests landed; every action in
  `DeskAction` was executed and acked against a desk server speaking the landed contract, with the
  real camera and the real speaker. `044` has since landed (`0e20258`), so `POST /v1/desks`,
  `WS /ws/desk` and the action route exist: what is missing is the end-to-end run against *this*
  server, and `048`’s `desk` lookup is now the only thing that could still drop the line.

`040`, `047` and `048` stay ticked: each one's evidence is a command that was run.
