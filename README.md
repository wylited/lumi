# Lumi

<!--
  TODO(hero): one wide image, ~1600×900 — the unit on a desk with the desktop app behind it and
  the phone beside it. Save it as docs/media/hero.png and the line below starts rendering.

  Real material already in the tree, if it is useful to compose from:
    apps/web/public/unit/       the unit itself (three.js stills, .webp)
    apps/web/public/shots/      2080×1360 screenshots of the desktop app: goal, live, live-nudge, history
  There is no phone screenshot yet.
-->

![Lumi: the desk unit, the desktop app and the phone](docs/media/hero.png)

**Lumi** sits on your desk and watches one person try to finish one thing.

A camera on a small robotic arm looks at the desk. A desktop app reads the machine. A phone follows
you out of the room. One server keeps the record and decides what to do about it — a colour, a
nudge, a sentence spoken out loud, an arm turning to point at the page.

The model proposes. The policy disposes. Silence is the default.

Built for the *Automate your studies / job / life* brief. The repository and the `@heli/*` packages
keep the working name, Helicopter.

## The three surfaces

**On the desk** — `apps/edge`, a headless Python rig. It holds the camera, the arm and the speaker,
uploads frames and executes the actions the server sends back. With tracking on it follows the
person: a pose model closed on the pixels drives pan and tilt, so the camera keeps you in frame
without a calibration step — and inside a four-percent deadband it does not move at all, because a
person sitting still should not be chased by a twitching camera.

**On the machine** — `apps/desktop`, Tauri 2. The frontmost app, window titles, how often you type,
whether you are idle. Counts and titles, never keystrokes or page contents. The goal lives here, the
live monitor fills in one minute at a time, and it can block what the goal lists — visibly, and only
when the goal says so.

**In your pocket** — `apps/mobile`, Expo. What the desktop cannot see once you leave the room: app
time and unlocks on Android, motion on both. It takes the same nudge and the same spoken line, and
it acts too — an app the goal blocks gets sent Home, with an Undo on the notification. On iOS it
says what it cannot see instead of pretending.

## The parts worth reading

| | |
|---|---|
| **Contracts are law** | `packages/contracts` is zod, compiled twice: to TypeScript, and to `dist/json-schema.json`, which is what the Python rig validates against. A drift between the two is a failing test, not a mystery in a socket. |
| **The model proposes, the policy disposes** | The model returns a schema-validated `Observation` and nothing else. It never writes the notification, the sentence or the machine action — thresholds, the goal and rate limits do. Six tiers, and each step up happens only because the one below it did not work. |
| **Every action is reversible** | Anything that changes the machine is shown, undone in one click, and recorded with its outcome. `GET /v1/analytics/tiers` is the product's own self-critique: which channel actually brought you back. |
| **One arm, one owner** | `arm.aim`, `arm.point` and `arm.home` pause the tracker for their duration, and tracking while the operator console drives the arm is refused at `hello`. Two things moving one arm is the one thing the rig will not do. |
| **No stand-ins** | There is no canned demo mode and no offline mock. With no model key the server still serves HTTP, and the log names the key it is missing. |

## How it fits

| | what it owns | stack |
|---|---|---|
| `apps/edge` | the camera, the arm, the speaker | Python · OpenCV · ONNX pose · `lerobot` |
| `apps/server` | the record, the keys, the policy | Fastify 5 · Prisma · Postgres · MinIO |
| `apps/desktop` | the machine it runs on | Tauri 2 · Rust + React |
| `apps/mobile` | the person, away from the desk | Expo 54 · React Native |
| `apps/web` | the storefront | Next.js 15 · three.js |

Everything crossing a process boundary is typed once in `packages/contracts`, and `packages/tokens`
is the design system as code — which is why the app, the phone and the storefront look like one
product instead of three.

## Run it

```bash
./scripts/demo.sh
```

Postgres and MinIO, the schema and the seed, the API, the storefront and the desktop, in one
terminal, with the URLs printed at the end. Safe to re-run. `./scripts/verify.sh` runs the gates
plus a set of route and UI checks.

The observe loop needs `DEEPSEEK_API_KEY` and the ElevenLabs pair in `apps/server/.env`. Without
them the server serves HTTP and says which key is missing.

## Working in this repo

`AGENTS.md` first — one commit owns a file, and no two open commits touch the same path.
`docs/00-architecture.md` has the drawings, `docs/COMMITS.md` is the ledger, and `docs/RUNBOOK.md`
is where the "why is it broken on my machine" answers live.
