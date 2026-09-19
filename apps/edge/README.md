# `apps/edge` — the rig

> **Setting this up on a machine that has never run it? Read [`SETUP.md`](./SETUP.md) instead of
> this file.** It is the ordered guide — install, permissions, starting the rig, opening a session,
> and what the desktop app should look like at each step — with the command that fixes each failure.
> This file is the reference: what the rig is, every setting, and what it cannot do.

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
command that fixes each wrong line. [`SETUP.md`](./SETUP.md) is the same thing in prose, in order.

## Setting up a machine that has never run this

See **[`SETUP.md`](./SETUP.md)** — the ordered guide, with the check and the fix for each step. The
short version, for a machine whose stack is already up:

```bash
cd apps/edge
uv sync                       # the camera, the pose model, the control law, the desk socket
uv run heli-rig --doctor      # read it top to bottom; the first `fail` is the thing to fix
HELI_CAMERA_SOURCE=opencv uv run heli-rig
```

Three things about that are not obvious, and each is a step in `SETUP.md`:

- **The rig is a program you start.** The desktop app has no camera code; it polls
  `GET /v1/sessions/:id/frame.jpg` and draws what comes back. Nothing starts the rig for you —
  not `demo.sh`, not the app — so an empty desk pane is nearly always "the rig is not running".
- **`HELI_CAMERA_SOURCE=opencv`, not the default `auto`.** `auto` prefers the tracking console's
  frame, which has another program's bounding box, crosshair and text drawn into the pixels.
- **An arm needs the `tracking` project**, which is not in this repo and has no remote. Without it
  the rig is still complete — it registers `arm: null` and frames, uploads and speech all work.

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
