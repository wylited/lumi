# Runbook

Operations for a four-person team. Read `AGENTS.md` first, claim from `docs/COMMITS.md`.
This file is the only place we keep the "why is it broken on my machine" answers.

---

## Prerequisites

| | |
|---|---|
| Node | 22 — `cat .nvmrc` pins `22.13.0` |
| pnpm | 12.4.1 (`packageManager` in the root `package.json`) |
| Docker | for `apps/server/docker-compose.yml` (Postgres + MinIO), or a local Postgres |
| Xcode | for the Tauri desktop (`apps/desktop`) |
| Python 3.11 + uv | for the edge agent (`apps/edge`), see `docs/03-device-contract.md` |

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

`db:reset` applies the Prisma schema and seeds one user, one device (`HELI-DEMO`), one goal and
one finished session. On a fresh machine this is the whole setup.

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
| `pnpm server:mock` | `pnpm --filter @heli/server dev:mock` — fake desk + fake desktop |
| `pnpm web` | `pnpm --filter @heli/web dev` |
| `pnpm desktop` | `pnpm --filter @heli/desktop dev` |

---

## Mocks

`pnpm --filter @heli/server dev:mock` (or `pnpm server:mock`) runs both fakes together. This is how
desktop and web develop with no hardware and no macOS permissions.

- **Fake desk** (`apps/server/src/dev/mock-device.ts`) — connects as a device, opens a session and
  streams four real notebook frames plus a spoken line.
- **Fake desktop** (`apps/server/src/dev/mock-desktop.ts`) — replays a plausible work pattern as
  real signals at real timings: 6 minutes in the editor, then a tab switch to a distracting site for
  40 s, then back.

Pick a scenario with `--scenario`:

| scenario | emits | expected |
|---|---|---|
| `focused` | desk at work in the editor | `onTrack:true` → silence |
| `drifting` | the 40 s off-task tab switch | `onTrack:false`, `driftSeconds>30` → nudge, then a spoken line |
| `phone` | phone in hand at the desk | non-empty `activity` |

A session fills with signals, a window, observations and one intervention with no hardware attached.

---

## macOS consent

The desktop reads the machine through three separate permissions. Each prompts on its own, and a
missed prompt on the demo machine can kill the demo. Accept all three before you rehearse.

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
- the orchestrator logs `latencyMs` per window and emits silence if the loop exceeds its 4 s budget.

Fall back to the keyless stub by setting, in `apps/server/.env`:

```bash
VISION_PROVIDER=local
```

`local` is deterministic and needs no key, so the whole loop still runs. Restart the server after
changing it. The recorded replay used by the demo lives in `apps/server/src/dev/replay.ts`.

---

## Demo fallback

`DEMO_MODE=replay` plays a recorded session — real signals, assessments, interventions and timings —
through the **identical** bus and SSE path the live loop uses. Flip one env var and the demo still
runs if the Pi dies, the wifi dies or the model rate-limits.

Once `HELI-060` lands, the one-command boot is:

```bash
./scripts/demo.sh
```

It brings up Postgres and MinIO, the server, the desktop and the web, seeds the DB, starts the mock
device and mock desktop, and prints the pairing code, the goal URL and the console URL. It is
idempotent and safe to re-run. `./scripts/verify.sh` runs install check, lint, typecheck, tests and
a handful of route curls, printing a pass or fail per check. Until then, use **First run** above.

---

## Device

**Pair.** The seed ships one device with code `HELI-DEMO`. The desktop's Settings shows the code and a QR (`HELI-070`).
`POST /v1/devices/pair` is idempotent, so reconnecting with the same code returns the same device.
The Pi connects to `wss://<api>/ws/device` with the header:

```
Sec-WebSocket-Protocol: heli.v1, <pairing-code>
```

An unknown code returns 404 and a bad token closes with 401.

**Rotate a code.** `POST /v1/devices/:id/rotate-code` issues a fresh code and immediately
invalidates the old one. The device must re-pair; a rotated code rejects the old one.

**Point the Pi at a laptop.** Run the server locally and give the agent the laptop's LAN address as
its API base, e.g. `ws://<laptop-ip>:3001/ws/device`, keeping the same `heli.v1, <code>`
subprotocol. The Pi and the laptop must be on the same network, and a local run does not need TLS.

---

## Troubleshooting

| symptom | fix |
|---|---|
| **Port in use** — `:3001` or `:3000` already bound | `lsof -i :3001` then kill the PID. Only one server and one web process at a time. |
| **Prisma client stale** — generated types lag the schema after an edit | `pnpm --filter @heli/server db:generate`, or `pnpm --filter @heli/server db:reset` for a full reset and reseed. |
| **pnpm build-script approval** — a dependency's postinstall was skipped | run `pnpm approve-builds`, or add it to `allowBuilds` in `pnpm-workspace.yaml` (Prisma and esbuild are already listed). |
| **Stuck `.next` cache** — web serves a stale bundle | stop the dev server, delete `apps/web/.next`, start again. **Never run `next build` while `next dev` is running** — they fight over the same `.next` directory. Stop `pnpm dev` / `pnpm web` before `pnpm build`. |
