# `apps/edge` — the rig

The Mac's half of Helicopter. It takes one frame at a time off the camera and posts it to the
server, and the rest of the rig hangs off the same settings: the arm that aims the camera, and the
speaker that plays the line. Python 3.11, headless, managed by `uv`.

The rig never sees a user id or a session id: it posts a frame, the server attributes it to the one
open session, and the newest frame wins every time. A frame that is late is worse than a frame that
is missing, so the loop **skips a tick** rather than queueing one, and never crashes at a camera
that went away.

```
camera ──▶ heli_rig.camera ──▶ heli_rig.capture ──▶ heli_rig.upload ──▶ POST /v1/desk/frames
             (console or cv2)      (the cadence)          (one POST in flight)
```

`arm/`, `audio.py`, `socket.py` and `actions.py` are the other direction (actions and speech down
the desk socket). `heli_rig/__main__.py` carries a clearly marked block where the integrator wires
the socket client into the same event loop as the capture loop; until then `heli-rig` captures and
uploads, which is the whole of the capture path.

---

## Run it

```bash
cd apps/edge
uv sync
uv run heli-rig --once    # one frame, one upload, one JSON line on stdout, exits
uv run heli-rig           # the long-running rig: capture at the configured cadence
```

Settings come from the environment (see `.env.example` for the table, which is also the rig's
defaults). Two ways to set them:

```bash
HELI_FPS=4 uv run heli-rig                  # one-off
uv run --env-file .env heli-rig             # from the file you copied .env.example to
```

### The camera the tracking console already holds (the usual case)

On this Mac the wrist UVC camera (`[0] USB Camera`, 640×480) is held by `tracking.visiond`, and its
console serves the newest frame at `http://127.0.0.1:8643/api/frame.jpg`. The default
`HELI_CAMERA_SOURCE=auto` prefers that frame whenever the console reports one less than 5 s old, and
says so in the log:

```
camera: the console's frame, 640x480 camera: USB Camera
```

`auto` falls back to opening the device itself when the console is not there or has stopped
writing frames, and logs the reason:

```
camera: no console frame (no console at http://127.0.0.1:8643: ...); opening AVFoundation index 0 instead
```

Frames from the console are already inside the server's limits, so the rig uploads them **untouched**
— it does not decode and re-encode 45 kB twice a second for no reason.

### A free UVC device (no console in the way)

Any camera the console is not holding can be opened directly. On this Mac `[1] FaceTime HD` is free,
so it works with the console still running:

```bash
HELI_CAMERA_SOURCE=opencv HELI_CAMERA_INDEX=1 uv run heli-rig
```

```
camera: AVFoundation index 1, 1920x1080 camera: AVFoundation camera 1
```

The device delivers 1920×1080; the rig downscales by a whole factor (2) and uploads 960×540, because
the server refuses anything over `HELI_MAX_EDGE_PX` (1600 by default) or 2 MB. `HELI_CAMERA_SOURCE=opencv`
is also what to use when the console is stopped and you want the wrist camera itself.

OpenCV does not report a device name through AVFoundation, so a directly-opened camera is named by
its index. That is thin, but it is true — the console's frames come with the device's real name.

### When the camera goes away

Unplug it, or stop the console. The rig logs the reason once and keeps running, retrying every 5 s:

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
| `HELI_FPS` | `2` | frames per second while a session is live |
| `HELI_MAX_EDGE_PX` | `1600` | the long edge the rig downscales to before encoding |
| `HELI_JPEG_QUALITY` | `80` | the encoder's quality |
| `HELI_DESK_NAME` | `Desk 1` | the name the desk registers under |
| `HELI_ARM_DRIVER` | `auto` | `auto` \| `console` \| `serial` \| `none` |
| `HELI_SPEAKER` | `true` | play the spoken line on this Mac |
| `HELI_LOG_LEVEL` | `info` | `debug` \| `info` \| `warning` \| `error` \| `critical` |
| `HELI_DIR` | `~/.heli` | where the desk id, token and arm calibration are kept |
| `HELI_DESK_TOKEN` | — | a desk token handed to this rig; otherwise it registers one |
| `HELI_EMAIL` | — | the seeded user's address, for the dev-login bootstrap |

Flags: `--once`, `--camera-index`, `--console`, `--fps`, `--log-level`, `--api-url`. A flag beats the
environment.

`uv run heli-rig --help` prints them.

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
  Reading it directly (`HELI_CAMERA_SOURCE=opencv`) is for a bench where the console is stopped, and
  the console's frames are the tracker's view — annotated when it has a target.
- **Frames are resized, never cropped.** The capture rectangle in `~/.heli/rig.json` is the arm's
  calibration; the rig downscales the whole frame rather than cropping to it.

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
