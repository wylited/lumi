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

## Root scripts

| script | does |
|---|---|
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
- the orchestrator logs `latencyMs` per window and emits silence if the loop exceeds its 6 s budget.

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
| **Port in use** — `:3001` or `:3000` already bound | `lsof -i :3001` then kill the PID. Only one server and one web process at a time. |
| **Prisma client stale** — generated types lag the schema after an edit | `pnpm --filter @heli/server db:generate`, or `pnpm --filter @heli/server db:reset` for a full reset and reseed. |
| **pnpm build-script approval** — a dependency's postinstall was skipped | run `pnpm approve-builds`, or add it to `allowBuilds` in `pnpm-workspace.yaml` (Prisma and esbuild are already listed). |
| **Stuck `.next` cache** — web serves a stale bundle | stop the dev server, delete `apps/web/.next`, start again. **Never run `next build` while `next dev` is running** — they fight over the same `.next` directory. Stop `pnpm dev` / `pnpm web` before `pnpm build`. |
