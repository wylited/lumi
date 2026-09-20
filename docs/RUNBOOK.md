# Runbook

Operations for a four-person team. Read `AGENTS.md` first; the ledger is `docs/COMMITS.md`.
This file is the only place we keep the "why is it broken on my machine" answers.

---

## Prerequisites

| | |
|---|---|
| Node | 22 — `cat .nvmrc` pins `22.13.0` |
| pnpm | 12.4.1 (`packageManager` in the root `package.json`) |
| Docker | for `apps/server/docker-compose.yml` (Postgres + MinIO), or a local Postgres |
| Xcode | for the Tauri desktop (`apps/desktop`) |
| A camera, and maybe an arm | the rig is a Mac with a camera on a robotic arm; see `docs/03-desk-capture.md` |

---

## First run

```bash
./scripts/demo.sh
```

One command, one terminal: Docker, the schema, the bootstrap seed, the API, the storefront and the
desktop, with the URLs printed at the end. It follows the logs; **ctrl-c stops the apps it
started** (Docker keeps running — `--down` stops that too). Safe to re-run: a second run stops the
processes the previous one started and reuses anything it did not start.

```bash
./scripts/demo.sh --detach     # bring it up and hand back the prompt
./scripts/demo.sh --stop       # stop the apps (leaves Postgres and MinIO up)
./scripts/demo.sh --down       # stop the apps, then `docker compose down`
./scripts/demo.sh --no-reset   # boot against the data already in the database
./scripts/demo.sh --help       # every flag
```

Then, to check the checkout before you trust it:

```bash
./scripts/verify.sh            # install, lint, typecheck, tests, routes, both UIs
./scripts/verify.sh --quick    # skip the three gates; the routes and the UIs only
```

It prints one line per check and exits **0** when every check ran and passed, **1** when something
failed, and **3** when nothing failed but some checks could not run. Gate on `0`: on a fresh
bootstrap the session-dependent checks are skipped, because the seed has no session, and `3` is the
honest report of that rather than a green line for requests that were never sent.

### By hand

The same thing, unrolled, for when you want one piece at a time:

```bash
pnpm install
docker compose -f apps/server/docker-compose.yml up -d
cp apps/server/.env.example apps/server/.env
pnpm --filter @heli/server db:reset
```

Then, in two terminals:

```bash
pnpm --filter @heli/server dev   # API on :3001
pnpm --filter @heli/web dev      # the storefront on :3000 (needs no server)
```

`db:reset` applies the Prisma schema and seeds the bootstrap: one user and this machine's device
(`LUMI-ONE`). No goal and no sessions — those come from using the app. The loop needs
`DEEPSEEK_API_KEY`, `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in `apps/server/.env`; without
them the server serves HTTP and logs which key is missing.

The root `pnpm server`, `pnpm web` and `pnpm desktop` are one-line shortcuts for the same filters.

### What `demo.sh` deliberately does not do

Four choices in it are surprising enough to write down, because each one is a bug avoided rather
than a shortcut taken.

- **It does not start any mocks, because there are none.** The mock device, the mock desktop, the
  fixture generator, the canned assessor and `dev:mock` were deleted on purpose (`d5895ae`), and the
  device socket and pairing behind them in `fceb42d`. So a boot produces an API, a storefront and a
  desktop — and **no signals at all** until a rig or the app provides them. The script says whether
  the observe loop started, reading the server's own log rather than assuming, and names the missing
  key when it did not.
- **It only starts Docker when Postgres and MinIO are not already reachable** at the address in
  `apps/server/.env`. Running `compose up -d` unconditionally is quietly destructive: on a machine
  whose running containers differ from the compose file — a database deliberately moved to another
  host port, say — Compose sees config drift and *recreates* them, and the `.env` underneath stops
  matching the container. Reachability is the honest question.
- **It never kills a process it did not start.** A port already serving is reused and reported as
  reused, after checking the app on it really is the one expected. `--stop` stops what it started
  and nothing else, and it identifies its own processes by a marker rather than by trusting a pid,
  because pids get recycled.
- **The desktop runs in a browser by default.** The desktop's own dev task is `tauri dev`, which
  needs Xcode and a Rust toolchain and a first build measured in minutes. The same React UI runs
  under Vite, and since `246a3bd` the app has no fake data at all: `lib/api.ts` defaults to
  `http://localhost:3001` and says plainly when it cannot reach the server. `--tauri` runs the real
  window where the toolchain exists.

Runtime state — pids and one log per process — lives in `$TMPDIR/heli-demo`, never in the repo. Set
`HELI_DEMO_STATE` to move it.

### The URLs it prints

| what | where |
|---|---|
| storefront | `http://localhost:3000` — marketing only, needs no server, shows no live data |
| desk unit | `http://localhost:3000/device` — the storefront page for the physical unit |
| console | `http://localhost:1420` — the desktop's live monitor |
| goal | `http://localhost:1420` — the same window |
| api | `http://localhost:3001` |
| desk status | `http://localhost:3001/v1/desk` (bearer token required) |
| live stream | `http://localhost:3001/v1/live/<sessionId>?token=…` — SSE, once a session exists |

The desktop's four screens are one window with in-app routing, so "the goal URL" and "the console
URL" are the same address: `⌘1`–`⌘4` select Live, Goal, History and Settings **in the Tauri
window**. In a browser those keys switch tabs instead, so click the sidebar. There is no per-screen
URL to print, and inventing one would be a lie. A token for the two bearer routes above:

```bash
curl -X POST http://localhost:3001/v1/auth/dev-login -H 'content-type: application/json' -d '{}'
```

## Root scripts

| script | does |
|---|---|
| `./scripts/demo.sh` | one-command boot — the whole stack, then the URLs |
| `./scripts/verify.sh` | install, lint, typecheck, tests, routes, UIs — one line per check |
| `pnpm dev` | `turbo run dev` — every app that has a dev task |
| `pnpm build` | `turbo run build` |
| `pnpm lint` | `eslint .` at the repo root |
| `pnpm typecheck` | `turbo run typecheck` |
| `pnpm test` | `turbo run test` |
| `pnpm format` | Prettier over the repo |
| `pnpm server` | `pnpm --filter @heli/server dev` |
| `pnpm web` | `pnpm --filter @heli/web dev` |
| `pnpm desktop` | `pnpm --filter @heli/desktop dev` |

---

## macOS consent

The desktop reads the machine through three separate permissions. Each prompts on its own, and a
missed prompt means that signal is missing. Accept all three before a session.

| prompt | System Settings path | used by |
|---|---|---|
| **Accessibility** | Privacy & Security → Accessibility | `NSWorkspace`, `AXUIElement` — frontmost app and focused element |
| **Screen Recording** | Privacy & Security → Screen Recording | `ScreenCaptureKit` — screen frames |
| **Input Monitoring** | Privacy & Security → Input Monitoring | `CGEventTap` — input counts and timing only, never key content |

The desktop Settings route (`HELI-033`) reports each permission as granted or missing, with a deep
link to the right pane, and re-checks on demand.

If a permission was denied by mistake, reset it and let the app prompt again:

```bash
tccutil reset Accessibility <bundle-id>
tccutil reset ScreenCapture <bundle-id>
tccutil reset ListenEvent <bundle-id>
```

A denied permission means **empty signals, not a crash**: a signal whose permission is missing is
simply absent, and the UI names which one.

---

## When the model rate-limits

What to look for in the logs:

- the assess step logs **latency and token usage** on every call
  (`apps/server/src/observe/assess.ts`, `apps/server/src/models/deepseek.ts`);
- provider **429 / rate-limit** errors from the DeepSeek adapter;
- the orchestrator logs `latencyMs` per window and emits silence if the loop exceeds its 12 s budget
  (`DEFAULT_LOOP_CONFIG.budgetMs` in `apps/server/src/observe/index.ts`). It was 6 s and that made
  the cap the decision-maker: DeepSeek Flash answers these two-image windows in 3.4–7.8 s, so
  windows were being thrown away for a policy that had nothing to do with the model.

There is no offline assessor. A window whose assessment fails is recorded as silence, and the loop
tries again on the next one.

---

## Speech

ElevenLabs, and only ElevenLabs. It needs both `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` —
the id, not the name.

**Default voice: Matilda** (`XrExE9yKIg1WjnnlVkGX`, knowledgeable/professional); alternates Alice
(`Xb7hH8MSUJpSbSDYk0k2`) and Sarah (`EXAVITQu4vr4xnSDxMaL`). `GET /v1/voices` lists 21 premade
voices with the key in `.env`; the free plan refuses some ids with `paid_plan_required`, so after
changing the voice, synthesize one line and listen.

Synthesis is a cloud call **after** the assessment, so it does not consume the loop's budget and a
failure is recorded as `delivered: false` rather than spoken. It is not instant: **~5 s per line**
from this network on the free plan, so a tier-3 line lands several seconds after the window it
describes.

**On demand.** The loop is not the only trigger. `POST /v1/sessions/:id/speak` says a line now,
for a rehearsal or a demo beat that has to land on cue:

```bash
curl -X POST http://localhost:3001/v1/sessions/<sessionId>/speak \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Back to the problem set. Twelve problems, working written up."}'
```

It answers `{ accepted, reason, intervention }`; `accepted: false` carries the reason — no speech
provider configured, or nothing attached that could carry it. The line is recorded as an
`Intervention` with `reason: manual`.

**Who plays it.** Speech follows the person: away from the desk it goes to the phone, otherwise the
desktop app, and if the app is not attached **the rig plays it through the Mac's own speakers** —
the same `afplay` path as its self-check. Nudges are the exception: the rig has no surface to show
one, so a nudge is only ever the phone or the app. Both paths report back, which is how you tell a
line was heard from a line that was merely sent: the server logs `the app started a spoken line`
when the app says it began the audio, and the rig logs `played <momentId> for <ms> ms`.

The rig warms the audio device at boot with 60 ms of silence. The first playback in a fresh process
pays CoreAudio's start-up, and un-warmed that cost lands on whichever line is first — on the demo Mac
the first line of a run was killed by its own timeout while the next one played fine. A player that
still has not exited 3 s after the line's own length is written off with `player_timeout` in the
log, and that line is lost.

**How fast it goes.** No interruption can come before a full window of signals exists, so the pace
control on the Goal screen is what decides the floor: **Calm** is the defaults (30 s of drift, two
60 s windows), **Eager** is the demo setting (5 s of drift, one 30 s window) — about 40 s from
pressing Start to the first spoken sentence instead of two and a half minutes. The policy is
per-goal, so a rehearsal goal can be Eager while the real one stays Calm.

---

## Desk

**Setup replaces pairing.** There is no code and no QR. First run in the desktop app asks for a desk
name, a camera (with a live preview) and optionally an arm (serial port + model), then one
**"aim here"** calibration: drag a rectangle over the desk area to watch, and the app stores the
pose that frames it. Re-running setup updates the same desk (`POST /v1/desks` is idempotent).

**Frames.** The app uploads the newest frame to `POST /v1/sessions/:id/frames` with
`content-type: image/jpeg`. To test by hand:

```bash
curl -X POST http://localhost:3001/v1/sessions/<sessionId>/frames \
  -H "authorization: Bearer $TOKEN" -H 'content-type: image/jpeg' \
  --data-binary @frame.jpg
```

An oversized (>2 MB), too wide (>1600 px) or non-JPEG upload is refused with a specific code and
stores nothing. Only the newest frame per session is kept.

**The arm.** `arm.point { x, y }` aims at a point on the desk plane using the saved calibration;
`arm.home` returns. If no arm is configured the aim actions are refused and everything else works.
The adapter lives in `apps/desktop/src-tauri/src/arm/**` and is the only place that knows the
vendor's dialect.

---

## Troubleshooting

| symptom | fix |
|---|---|
| **Port in use** — `:3001` or `:3000` already bound | `lsof -i :3001` then kill the PID. Only one server and one web process at a time. `./scripts/demo.sh --stop` clears anything the boot script started. |
| **Prisma client stale** — generated types lag the schema after an edit | `pnpm --filter @heli/server db:generate`, or `pnpm --filter @heli/server db:reset` for a full reset and reseed. |
| **`EROFS: read-only file system, utime '~/.cache/prisma/…'`** — `db:reset`/`db push` cannot touch Prisma's engine cache | Point the cache somewhere writable: `XDG_CACHE_HOME=<writable dir> pnpm --filter @heli/server db:reset`. **Also keep `COREPACK_HOME`** (`COREPACK_HOME=~/.cache/node/corepack`) or pnpm itself stops resolving — it looks for its own install under `XDG_CACHE_HOME`. |
| **Boot says the observe loop did not start** | Expected without keys. Set `DEEPSEEK_API_KEY`, `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in `apps/server/.env`; the log line names the one that is missing. There is no offline stand-in any more (`d5895ae`). |
| **pnpm build-script approval** — a dependency's postinstall was skipped | run `pnpm approve-builds`, or add it to `allowBuilds` in `pnpm-workspace.yaml` (Prisma and esbuild are already listed). |
| **Stuck `.next` cache** — web serves a stale bundle | stop the dev server, delete `apps/web/.next`, start again. **Never run `next build` while `next dev` is running** — they fight over the same `.next` directory. Stop `pnpm dev` / `pnpm web` before `pnpm build`. |
