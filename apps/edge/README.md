# `apps/edge` — the rig

The Mac's half of Helicopter. It takes one frame at a time off the camera and posts it to the
server, and the rest of the rig hangs off the same settings: the arm that aims the camera, and the
speaker that plays the line. Python 3.12+, headless, managed by `uv`.

The rig never sees a user id or a session id: it posts a frame, the server attributes it to the one
open session, and the newest frame wins every time. A frame that is late is worse than a frame that
is missing, so the loop **skips a tick** rather than queueing one, and never crashes at a camera
that went away.

```
camera ──▶ heli_rig.camera ──▶ heli_rig.capture ──▶ heli_rig.upload ──▶ POST /v1/desk/frames
             (console or cv2)      (the cadence)          (one POST in flight)
```

`arm/`, `audio.py`, `socket.py` and `actions.py` are the other direction, and they are wired: one
process runs the capture loop and the desk socket together. Frames go up on `POST /v1/desk/frames`;
`/ws/desk` carries the actions down (`capture`, `arm.aim`, `arm.point`, …) with an ack for each, and
the spoken line as tagged PCM that `audio.py` plays through `afplay`. A rig whose camera has not
answered yet still belongs up — the loop keeps retrying while the socket runs beside it.

The rig half of "aim here" is `--calibrate`, below.

---

## Run it

```bash
cd apps/edge
uv sync
uv run heli-rig --doctor  # what this machine has, and the command that fixes what it has not
uv run heli-rig --once    # one frame, one upload, one JSON line on stdout, exits
uv run heli-rig           # the long-running rig: capture at the configured cadence
```

Settings come from the environment (see `.env.example` for the table, which is also the rig's
defaults). Two ways to set them:

```bash
HELI_FPS=4 uv run heli-rig                  # one-off
uv run --env-file .env heli-rig             # from the file you copied .env.example to
```

`--doctor` is the machine check: it walks every requirement in the order they fail and prints the
command that fixes each wrong line. The setup guide below is the same thing in prose.

## Setting up a machine that has never run this

The whole rig is one directory and one command. What follows is the order that works, and what each
step is actually waiting for.

### 1. The stack (server + database + app)

From the repo root, on the machine that will hold the database:

```bash
./scripts/demo.sh --detach      # Docker, the schema, the seed, the API, the storefront, the desktop
```

It prints the URLs when it is up. If the observe loop reports `OFF — missing: <key>`, that is the
server telling you which provider key it wants; the rig does not need one.

### 2. The rig

```bash
cd apps/edge
uv sync                         # Python 3.12+; uv fetches the interpreter if the machine has none
uv run heli-rig --doctor        # what this machine has, and the command that fixes what it has not
```

`uv sync` is the whole install. It brings the camera, the pose model (`models/yolo11n-pose.onnx`,
committed in the tree), the control law and the desk socket — no torch, no second virtualenv, no
system Python packages.

`--doctor` then walks every requirement in the order they fail, and under each wrong line prints the
command that fixes it. Read it top to bottom; the first `fail` is the thing to fix.

### 3. The two things the repo cannot install for you

Everything above is in the tree. Two things are not, and the doctor names whichever is missing.

**macOS Camera permission.** The process that opens the device needs it: System Settings → Privacy &
Security → Camera, for the terminal (or app) that runs the rig. Without it the camera opens and
returns nothing, which reads as a broken camera.

**An arm.** This is the real dependency, and it is worth being blunt about it. The rig can *aim* an
arm through one of two routes, and both need something outside this repo:

| route | what it needs | how to point the rig at it |
|---|---|---|
| the operator console | the `tracking` project running `bun ui/server.ts` — it owns the serial bus and supervises `armd` | `HELI_CONSOLE_URL` (default `http://127.0.0.1:8643`). `HELI_ARM_DRIVER=auto` prefers it whenever it answers |
| the serial bridge | the same project, plus an interpreter with `lerobot` in it | `HELI_BRIDGE_DIR` (default `~/Repos/tracking`) and `HELI_BRIDGE_PYTHON` if its `.venv` is elsewhere |

That project is **not** in this repo and has no remote, so a machine that has never had it cannot
`git clone` it: it has to be copied across (`scp -r`, a shared drive) along with its two virtualenvs,
and then started with `bun ui/server.ts` from its own directory. The rig's arm half is otherwise
complete and tested — it is the bus, and only the bus, that lives outside.

`lerobot` is what knows this arm's Feetech STS3215 chain, its homing offsets and its EEPROM travel
limits. It is not vendored here on purpose: it drags in torch and pins `numpy<2.3`, which would slow
the detector down for every rig that has no arm. It is declared as an optional extra
(`uv sync --extra arm`) for the slice that owns the bus directly; today the rig reaches the arm
through the console or a bridge process, both of which are the tracking project.

**Without either route the rig is still a rig.** `HELI_ARM_DRIVER=none` (or nothing answering)
registers `arm: null`, the server sends it no `arm.*` action, and the camera, the frames, the upload
and the spoken line all keep working. What does not work is aiming, pointing and following.

### 4. Watch something

The seed is the bootstrap — one person, one machine — and no session. A session is what frames attach
to, so open one from the app: **the desktop's setup flow opens it when you press Start watching**
(`apps/desktop/src/routes/setup.tsx`). Until then every frame is answered `409 no_open_session` and
the rig slows to a fifth of its cadence rather than stopping.

### 5. The camera

`HELI_CAMERA_SOURCE` decides, and the answer for lumi is **`opencv`**:

- **`opencv`** opens the UVC device itself (`HELI_CAMERA_INDEX`, `0` on this Mac) and uploads clean
  footage. **Use this one.**
- `console` takes the frame the tracking console serves at `http://127.0.0.1:8643/api/frame.jpg`,
  which has the tracker's green bounding box, magenta chest crosshair and its `id … fps … ms` text
  **drawn into the pixels**. The rig uploads exactly the bytes it is handed, so an observer's frame
  from the console arrives with another program's annotations on it (verified on this bench: same
  desk, overlay visible; `opencv` gives the same desk clean).
- `auto` (the default) prefers the console's frame when one is less than 5 s old and falls back to
  the device, and says which it took:

```
camera: the console's frame, 640x480 camera: USB Camera
camera: no console frame (no console at http://127.0.0.1:8643: ...); opening AVFoundation index 0 instead
```

Any camera the console is not holding can be opened directly — `[1] FaceTime HD` is free on this Mac,
so it works with the console still running:

```bash
HELI_CAMERA_SOURCE=opencv HELI_CAMERA_INDEX=1 uv run heli-rig
```

```
camera: AVFoundation index 1, 1920x1080 camera: AVFoundation camera 1
```

The device delivers 1920×1080; the rig downscales by a whole factor (2) and uploads 960×540, because
the server refuses anything over `HELI_MAX_EDGE_PX` (1600 by default) or 2 MB.

OpenCV does not report a device name through AVFoundation, so a directly-opened camera is named by
its index. That is thin, but it is true — the console's frames come with the device's real name.

**When the camera goes away** — unplug it, or stop the console — the rig logs the reason once and
keeps running, retrying every 5 s:

```
WARNING heli_rig.capture: camera USB Camera: the console did not answer /api/frame.jpg: ...; retrying every 5s
INFO    heli_rig.capture: camera is back: 640x480 camera: USB Camera
```

It never exits on a camera. It reopens the source on every retry, so a console restart or a
re-plugged device is picked up without restarting the rig.

---

## Settings

| variable | default | what it does |
|---|---|---|
| `HELI_API_URL` | `http://localhost:3001` | the server. The desk socket is derived: http → ws, https → wss, path `/ws/desk` |
| `HELI_CONSOLE_URL` | `http://127.0.0.1:8643` | the tracking console's HTTP API |
| `HELI_CAMERA_SOURCE` | `auto` | `auto` \| `console` \| `opencv` |
| `HELI_CAMERA_INDEX` | `0` | AVFoundation index, for `opencv` |
| `HELI_FPS` | `2` | frames per second while a session is live; `stream.stop` sets it to zero |
| `HELI_MAX_EDGE_PX` | `1600` | the long edge the rig downscales to before encoding |
| `HELI_JPEG_QUALITY` | `80` | the encoder's quality |
| `HELI_DESK_NAME` | `Desk 1` | the name the desk registers under |
| `HELI_ARM_DRIVER` | `auto` | `auto` \| `console` \| `serial` \| `none` |
| `HELI_BRIDGE_DIR` | `~/Repos/tracking` | the project the `serial` fallback starts a bridge from: it holds `tracking/bridge.py` and a `lerobot` install. Not part of this repo — the doctor names it when the arm is unreachable |
| `HELI_BRIDGE_PYTHON` | `<HELI_BRIDGE_DIR>/.venv/bin/python` | the interpreter that bridge runs under, when it is not the project's own `.venv` |
| `HELI_SPEAKER` | `true` | play the spoken line on this Mac; `false` acknowledges it `no_speaker` instead of pretending |
| `HELI_TRACKING` | `off` | `off` \| `auto`: follow the person at the desk without being asked |
| `HELI_MODEL` | `models/yolo11n-pose.onnx` | the pose model; a relative path resolves against `apps/edge`, so it is found whatever the working directory is |
| `HELI_TRACK_FPS` | `10` | the tracker's own cadence (detection is ~15 fps on this Mac's CPU — 51–69 ms a frame) |
| `HELI_TRACK_DEADBAND` | `0.04` | the share of the frame the chest may sit off the aim point before the arm moves |
| `HELI_LOG_LEVEL` | `info` | `debug` \| `info` \| `warning` \| `error` \| `critical` |
| `HELI_DIR` | `~/.heli` | where the desk id, token and arm calibration are kept |
| `HELI_DESK_RECT` | — | the desk rectangle in millimetres (`x,y,w,h`) that `--calibrate` records |
| `HELI_DESK_TOKEN` | — | a desk token handed to this rig; otherwise it registers one |

Flags: `--doctor`, `--once`, `--calibrate`, `--rect`, `--camera-index`, `--console`, `--fps`,
`--log-level`, `--api-url`, `--bridge-dir`, `--bridge-python`. A flag beats the environment.

`uv run heli-rig --help` prints them.

---

## Calibrating the desk

`arm.point(x, y)` is a least-squares fit over measured pairs — the arm holding a pose, and a person
saying which point on the desk the camera is looking at. No amount of looking at the camera invents
those pairs, so the rig records them once:

```
uv run heli-rig --calibrate --rect 0,0,300,220    # millimetres: x,y,w,h, the area you watch
```

It walks the rectangle's four corners and its centre. For each one, aim the camera at that point —
with the console, or whatever is holding the arm; this process only reads the pose back — then press
Enter. `s` skips a point, `q` stops. Three pairs are the minimum and five are the default, and they
are written to `~/.heli/rig.json` beside the desk id and token, so a later run adds to them rather
than starting over.

Until that file has three pairs, `arm.point` refuses with `calibration needs three poses` and
`arm.aim` still works: aiming at an absolute pan and tilt needs no calibration, and only the
desk-plane mapping does. This is the rig's half of the app's "aim here" step.

---

## `--once`, and what it exits with

`--once` is the bench check: open the camera, take one frame, upload it, print **one JSON line** on
stdout, exit. Everything else goes to the log, so a script can read the last line of stdout:

```json
{"ok": true, "status": 201, "seq": 241, "width": 640, "height": 480, "error": null}
```

`seq` is the server's own when it answered 201, and the rig's counter for the frame it tried to send
otherwise.

| exit | what happened | `error` |
|---|---|---|
| `0` | the frame landed — `201` | `null` |
| `3` | nothing is being watched — `409 no_open_session` | `no_open_session` |
| `4` | the server refused the bytes — `422` | `frame_rejected:<code>` |
| `1` | anything else: no camera, no token, the server is down | `camera_unavailable`, `unauthorized`, `transport` |

The long-running rig does not exit for any of those. A `409` slows the cadence to `HELI_FPS / 5` —
nobody is watching, but a session can open at any moment — and logs it once per streak; a `422` logs
the code and never resends that frame; a transport failure is logged once per streak and the next
frame is new anyway.

---

## What this rig cannot do

Honest list, so nobody goes looking for these in the code:

- **No zoom.** The UVC module's `CAP_PROP_ZOOM` refuses the write and the console's `/api/cmd` has no
  zoom method, so `DeskCamera.zoom` is `false` and a `camera.zoom` action is refused with `no_zoom`.
- **No exposure.** AVFoundation answers `-1.0` — its unsupported sentinel, a finite number — for
  every property the UVC module does not implement, and refuses the write. There is no exposure field
  in the desk contract, and the rig does not pretend otherwise.
- **No mechanical shutter, no LED ring, no pairing code.** This replaced the Pi unit: the desk
  registers itself and holds a desk token instead.
- **`tempC` is null.** macOS exposes no thermal sensor to a userspace process, and the rig does not
  invent a number to fill the field.
- **No microphone, so no barge-in.** The tracking console owns the mic on this Mac. `HELI_SPEAKER=true`
  means the rig *plays* the line; it cannot hear you start talking over one.
- **One camera at a time.** The wrist UVC device belongs to `tracking.visiond` while the console runs.
  Reading it directly (`HELI_CAMERA_SOURCE=opencv`) is for a bench where the console is stopped.
  **Take `opencv` when lumi is the one watching**: the console's frame has the tracker's green
  bounding box, magenta chest crosshair and its `id … fps … ms` text burned into the pixels, and lumi
  uploads exactly the bytes it is handed — so an observer's frame from the console arrives with
  another program's annotations drawn on it. `HELI_CAMERA_SOURCE=opencv HELI_CAMERA_INDEX=0` opens the
  device itself and uploads clean footage (verified: the same desk, no overlay).
- **Frames are resized, never cropped.** The capture rectangle in `~/.heli/rig.json` is the arm's
  calibration; the rig downscales the whole frame rather than cropping to it.

---

## What the desktop needs

Written for whoever owns the app, because the rig cannot change what the app draws. Numbers here are
measured on this bench, not estimates.

**The pane rate is the app's to choose, and the rig will feed it.** `GET /v1/sessions/:id/frame.jpg`
answers `cache-control: private, max-age=5` today, so a browser reuses the body between polls and a
10 Hz pane shows one picture every five seconds. The rig is publishing 12 distinct frames a second
(12 of 12 fetches 120 ms apart returned a different JPEG), so the header — not the rig — is what
caps a fast pane. `no-store` (or a `?t=` cache-buster on the app's side) is the one-line fix, and it
is the server's file: the rig cannot make it.

The rig publishes at `HELI_FPS` (12 on this bench); below that, the pane's poll interval decides
what you see, and a pane polling at 1 Hz shows a 1 fps desk no matter what the rig does.

**Nothing needs a new endpoint to track a person.** The overlay the app draws is its own: the rig's
aim point is `(0.5, 0.5)` of the frame (the tracking project's `aim`, and what `arm.point` maps
through the desk rectangle), so a chest at `(x, y)` normalized in the frame is drawn at
`(x, y) * 100%` of the image box. When the rig is following someone, the person it is following is
the one whose chest is nearest that aim point.

**What the app can already ask for:** `capture`, `stream.start { fps }`, `stream.stop`, `arm.aim
{ pan, tilt }`, `arm.point { x, y }` (desk-plane millimetres, needs a calibration),
`arm.nod { times }`, `arm.home`. `arm.track { on }` is the new one (below).

**Frames are resized, never cropped.** The setup rectangle is the arm's calibration and the app's
overlay; the rig uploads the whole frame downscaled, so the overlay's rectangle and the picture share
one coordinate space — no crop offset to apply.

---

## Following a person

`HELI_TRACKING=auto` (or `--tracking auto`) makes the rig follow the person at the desk: the pose
model finds them, the control law turns that into pan and tilt, and the arm keeps their chest at the
aim point. It is off by default — an observer that moves on its own is a decision, not a default.

- **What it needs:** the pose model (`HELI_MODEL`, default `models/yolo11n-pose.onnx`, in the tree),
  a camera, and an arm. No calibration: following a person is closed on the pixels, so it needs no
  desk rectangle (`arm.point` still does).
- **Who holds the arm.** `arm.aim`, `arm.point` and `arm.home` pause the tracker for their duration
  and it resumes after — a move that is asked for is never fought by the loop. Tracking while the
  operator console is in `track` mode is refused at `hello`: two things driving one arm is the one
  thing this rig will not do.
- **`arm.track { on }`** is the server's control over it: `on: true` starts following (the rig's
  `HELI_TRACKING=auto` must be set — a rig configured `off` refuses with `tracking_disabled` rather
  than turning on a camera and an arm nobody asked for), `on: false` stops and leaves the arm where
  it is. Acked with `pose` (where the arm ended up) like the other arm actions.
- **The rig reports it in `desk.health.following`**, every heartbeat: `true` while it is following,
  `false` when it has a tracker and is not, `null` when it has none at all (no arm, no model,
  `HELI_TRACKING=off` at wiring time). `null` and `false` are different claims — a desk that cannot
  follow is not a desk that is not following — and the app's Follow me switch reads it that way.
- **Silence is the default here too.** Inside `HELI_TRACK_DEADBAND` (4% of the frame — the tracking
  project's own hand-tuned value) the arm does not move: a person sitting still is not chased by a
  camera twitching at keypoint jitter. It is deliberately tight, because a person sitting at the
  desk measures 0.01–0.03 off the aim point and a coarser band would silently mean "never move".

---

## Tests

```bash
cd apps/edge
uv run pytest
```

No camera, no console and no server are needed: the camera and upload tests run the real sources and
the real uploader against a stub on a loopback port, and the capture tests drive the loop with a fake
source and a fake uploader to pin the rules that matter — one upload in flight, a 409 that slows the
cadence instead of stopping it, and a 422 that is never resent.
