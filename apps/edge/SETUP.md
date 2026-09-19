# Setting up a machine that has never run the rig

For whoever — human or agent — is putting lumi on a laptop that has never had it. Follow it in
order. Every command is one you can paste, every claim is one you can check, and each step ends with
something observable rather than "it should work now".

**The rig is a program you start, not a service the app finds.** The desktop app has no camera code
at all: it polls `GET /v1/sessions/:id/frame.jpg` and draws what comes back. Those frames exist only
while `heli-rig` is running and connected to the server. So "the camera does not work in the app" is
almost always "the rig is not running", and this guide is mostly about proving that, in order, with
the rig's own tooling.

```
camera ─▶ heli-rig (this directory) ─▶ server ─▶ desktop app
          ↑ must be running            ↑          ↑ displays only
          ↑ registers the desk         ↑ keeps the newest frame
```

---

## 0 · Before anything: install after you pull

```bash
git pull
pnpm install
```

**This step is not optional and it is the most common way a working setup breaks.** `pnpm install`
must run after a pull that changed any `package.json`. `./scripts/demo.sh` only installs when
`node_modules` is *absent*, so a pull that adds a dependency slips straight past it and the desktop
dies with a Vite overlay reading `Failed to resolve import`.

If you have already seen that overlay: `pnpm install`, then **restart the dev server** — Vite caches
its module graph at startup and will keep serving the stale resolution until it is restarted.

Check:

```bash
ls node_modules/.pnpm | wc -l      # not 0
```

---

## 1 · The stack

From the repo root, on the machine that holds the database:

```bash
./scripts/demo.sh --detach
```

Docker (Postgres + MinIO), the schema, the bootstrap seed, the API, the storefront and the desktop.
It prints the URLs when it is up.

Check: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/healthz` answers `200`.

If it reports `observe loop OFF — missing: <key>`, that is the **server** wanting a provider key
(`DEEPSEEK_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`). **The camera path does not need
any of them** — frames, uploads and the desk socket work without a single key. Ignore it and carry
on.

---

## 2 · The rig's own install

```bash
cd apps/edge
uv sync
```

That is the whole install: the camera (`opencv`), the pose model (`models/yolo11n-pose.onnx`,
committed in the tree), the control law and the desk socket. No torch, no second virtualenv, no
system Python packages.

`uv` fetches Python 3.12+ itself if the machine has none. The project declares `requires-python =
">=3.12"` because the optional `arm` extra (`uv sync --extra arm`) carries `lerobot`, which declares
3.12 and up — a project allowing 3.11 made `uv sync` itself unresolvable, extra and plain install
alike.

Check: `./.venv/bin/heli-rig --help` prints usage.

---

## 3 · The doctor — read it top to bottom

```bash
uv run heli-rig --doctor
```

It walks every requirement in the order they fail and prints one line each, with the command that
fixes each wrong line. **The first `fail` is the thing to fix**; `warn` lines are things that are
allowed to be missing. Exit code: **0** ready, **1** runs but degraded, **2** blocked.

A rig that is ready for the camera half looks like this — this is the real output from the bench:

```
ok   this rig     server http://127.0.0.1:3001 (socket ws://127.0.0.1:3001/ws/desk), camera opencv, arm none, state ~/.heli, 2 fps
ok   server       http://127.0.0.1:3001/healthz answered 200
ok   user token   the dev-login bootstrap handed over a user token for the uploads
ok   watch        a session is open (…), and the desk row is heli-…
ok   desk         registered as heli-…; its token is the one the socket presents
ok   desk socket  ws://127.0.0.1:3001/ws/desk took the desk token and accepted hello
ok   camera       AVFoundation camera 0 at 960x540, 63 KiB per frame
ok   upload       63 KiB accepted as sessions/…/camera/latest.jpg (seq 1)
ok   tracking     the model at yolo11n-pose.onnx loaded; 640x480 through the model: …
ok   speaker      the line plays through /usr/bin/afplay
```

The four lines that must be `ok` for the app to show a picture are **`desk socket`**, **`camera`**,
**`upload`** and **`watch`**. Everything else is the arm or the voice.

---

## 4 · macOS Camera permission

The process that opens the device needs it: **System Settings → Privacy & Security → Camera**, for
the terminal (or app) that runs the rig.

Without it the camera opens and returns nothing, which reads exactly like a broken camera. If you
denied it by mistake:

```bash
tccutil reset Camera
```

and let it prompt again on the next run.

---

## 5 · Start the rig — this is what makes the app show a picture

```bash
HELI_CAMERA_SOURCE=opencv uv run heli-rig
```

**`opencv`, not the default `auto`.** `auto` prefers the frame the tracking console serves, and that
frame has the tracker's green bounding box, magenta chest crosshair and `id … fps … ms` text **drawn
into the pixels**. The rig uploads the bytes it is handed, so an observer's frame arrives with
another program's annotations on it. `opencv` opens the UVC device itself and uploads clean footage
(verified on the bench: the same desk, no overlay).

The rig registers the desk on this first run and writes its id and token to `~/.heli/rig.json`.
**Nothing else registers a desk** — the desktop's `registerDesk` call exists but is not used — so
until the rig has run once the app says **"Not set up"**.

Check, in another terminal:

```bash
T=$(curl -s -X POST http://localhost:3001/v1/auth/dev-login -H 'content-type: application/json' -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -s -H "authorization: Bearer $T" http://localhost:3001/v1/desk | python3 -c 'import json,sys;d=json.load(sys.stdin);print("connected:",d["connected"],"| fps:",(d["health"] or {}).get("fps"))'
```

`connected: True` and a non-zero `fps` is the whole camera path working. That is the rig publishing
frames right now.

---

## 6 · Open a session, from the app

The seed is the bootstrap — one person, one machine — and **no session**. A session is what frames
attach to. Open one from the desktop app: **its setup flow opens one when you press Start watching**
(`apps/desktop/src/routes/setup.tsx`).

Until one is open every frame is answered `409 no_open_session`, and the rig slows to a fifth of its
cadence rather than stopping — so a missing session looks like a *slow* desk, not a broken one.

---

## What the app should look like

| the app shows | what it means | do |
|---|---|---|
| **"Not set up"** | the rig has never registered a desk | step 5 |
| **"Not connected"** | the rig ran before but is not running now | step 5 |
| **"Connected"**, pane labelled `now` | working | — |
| A frame, then the pane goes blank | the rig stopped — `FramePane` marks a frame stale past `max(10 s, 5 × interval)` and never shows a stale image | step 5 |

---

## Troubleshooting

| symptom | cause | fix |
|---|---|---|
| Vite overlay: `Failed to resolve import "…"` | a stale install after a pull | `pnpm install`, then **restart the dev server** (step 0) |
| Desk pane empty, app says "Not connected" | `heli-rig` is not running | step 5 |
| Frames `409 no_open_session` | no session open | step 6 |
| Camera opens but no frames arrive | macOS Camera permission | step 4 |
| The console's box and crosshair in the frame | `HELI_CAMERA_SOURCE=auto` took the console's frame | set `opencv` (step 5) |
| `fail desk socket … HTTP 401` | `rig.json` holds a token for a desk row the server no longer has (a `db:reset` leaves this) | re-run; the rig refreshes the token once and reconnects, and the doctor does the same |
| `warn desk … reports heli-<other>` | a second rig registered first; `GET /v1/desk` answers with the *first* row ever registered | stop the other rig, or give this one its own server (`HELI_API_URL`) |
| `fail camera … no frame` | the device is held by another process, or the index is wrong | `HELI_CAMERA_INDEX=1` for the built-in camera, or stop the holder |

---

## The arm — the one thing this repo cannot install

Aiming, pointing and following need **the `tracking` project**, which is not in this repo and has no
git remote. Two routes, both needing it:

| route | what it needs | how to point the rig at it |
|---|---|---|
| the operator console | the project running `bun ui/server.ts` — it owns the serial bus and supervises `armd` | `HELI_CONSOLE_URL` (default `http://127.0.0.1:8643`); `HELI_ARM_DRIVER=auto` prefers it whenever it answers |
| the serial bridge | the same project, plus an interpreter with `lerobot` in it | `HELI_BRIDGE_DIR` (default `~/Repos/tracking`) and `HELI_BRIDGE_PYTHON` if its `.venv` is elsewhere |

Because there is no remote, a new machine gets it by **copying** it (`scp -r`, a shared drive) along
with its two virtualenvs — `git clone` cannot fetch it.

`lerobot` is deliberately not vendored here: it drags in torch and pins `numpy<2.3`, which slows the
detector down for every rig that has no arm. It is declared as an optional extra
(`uv sync --extra arm`) for the slice that owns the bus directly.

**A rig with no arm is a complete rig.** `HELI_ARM_DRIVER=none` (or nothing answering) registers
`arm: null`, the server sends it no `arm.*` action, and frames, uploads and speech all work. What
you lose is aiming, pointing and following — not the camera.

---

## Following a person (optional)

```bash
HELI_TRACKING=auto HELI_CAMERA_SOURCE=opencv uv run heli-rig
```

Off by default: an observer that moves a camera on its own is a decision, not a default. It needs the
model (in the tree), a camera, and **an arm** — no calibration, because following is closed on the
pixels.

The app's **Follow me** switch drives it over `arm.track { on }`, and the rig reports the truth in
`desk.health.following`, which has three answers: `true` following, `false` has a tracker and is not
following, `null` cannot follow at all. The rig only claims `true` once the arm has actually taken
the mode, so a switch that reads on is a camera that is really moving.

---

## Verify the whole thing in one line

```bash
cd apps/edge && uv run heli-rig --doctor
```

`ok` on `desk socket`, `camera` and `upload` is the camera path proven end to end — the app is then
only a viewer of what the doctor already confirmed. Add `--once` for the one-shot bench check:

```bash
uv run heli-rig --once      # one frame, one upload, one JSON line, exit
```

Exit `0` means the frame landed (`201`); `3` nothing is being watched (`409`); `4` the server refused
the bytes (`422`); `1` anything else, with the reason in the `error` field.

---

## Settings worth knowing

Every value is also the default, so an empty environment is a working bench. The full table is in
`README.md` and `.env.example`; these are the ones that change behaviour on a new machine:

| variable | default | set it to |
|---|---|---|
| `HELI_CAMERA_SOURCE` | `auto` | **`opencv`** — see step 5 |
| `HELI_CAMERA_INDEX` | `0` | `1` for a built-in camera when the wrist UVC is index 0 |
| `HELI_API_URL` | `http://localhost:3001` | wherever the server is |
| `HELI_ARM_DRIVER` | `auto` | `none` on a rig with no arm, so nothing waits on one |
| `HELI_TRACKING` | `off` | `auto` to follow the person at the desk |
| `HELI_DIR` | `~/.heli` | where the desk id, token and calibration live |
