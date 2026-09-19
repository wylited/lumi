# Desk capture and control

**Audience: whoever wires the Mac rig and whoever builds the rig agent.** This supersedes
`docs/03-device-contract.md`, which described a Raspberry Pi unit we are not building. There is no
Pi, no pairing code, no QR, no LED ring and no shutter. There is a Mac, a camera, and an arm that can
point it.

**Two processes on that Mac.** The **rig agent** (`apps/edge`, Python, headless) owns the arm, the
camera and the speaker. The **desktop app** (Tauri) owns the machine signals and the interface. The
server owns assessment, policy and persistence. The rig never sees a user id or a session id.

---

## The rig

A desktop Mac runs the app. A camera is mounted on the end of a robotic arm; the arm is on USB and
driven from the same Mac. The app captures frames, reads the machine's own signals, and can **aim
the camera** — which is what "camera control" means here.

```
apps/edge (rig) ──frames (JPEG)────────▶ server ──assess──▶ policy ──▶ act
      ▲                                    │                            │
      └── actions: capture · stream · arm ─┘        latest frame ──▶ loop │
                                                                         ▼
apps/desktop ──signals (app, window, input, idle, screen)──────────▶ server
             ◀── SSE: state, observation, intervention ─────────────┘
```

## What the rig agent (`apps/edge`) is responsible for

1. **Capturing frames.** One JPEG at a time, downscaled to ≤1600 px long edge, ≤2 MB, q80. About
   2 fps while a session is live, plus one on demand whenever the server asks for a capture.
2. **Aiming.** Turning an aim request (`pan`, `tilt`, `point(x,y)` on the desk plane, `home`,
   `zoom`) into arm motion, and reporting where it ended up.
3. **Signals.** The machine signals it already sends (frontmost app, window title, input cadence,
   idle, screen) — unchanged.
4. **Playing the line.** Speech is played on the Mac. There is no device speaker to reach.
5. **Reporting caps and health.** Camera model and max resolution, arm model and degrees of
   freedom, and a heartbeat with capture fps and the last frame time.

## What the desktop app is responsible for

The machine signals it already sends (frontmost app, window title, input cadence, idle,
screen), the goal and the live state, and **the setup UI** — the three fields and the aim-here
rectangle, which it posts to the server and which the server forwards to the rig. It does not
capture frames and it does not move the arm.

## What the server is responsible for

Reading the frames into an `Assessment`, deciding the tier, persisting observations, and sending
desk actions back. It never talks to the camera or the arm directly.

---

## Registration replaces pairing

There is no code to exchange. On first run the app asks for three things and stores them locally:

1. **A desk name** — "Desk 1", "Study room".
2. **The camera** — chosen from the enumerated devices, with a live preview.
3. **The arm, if there is one** — the serial port and the model. If there is no arm, aim actions
   are hidden and the camera is fixed; everything else still works.

Then one **"aim here"** step: the app shows the camera view, the person drags a rectangle over the
desk area they want watched, and the app stores the arm pose that frames it. That rectangle is the
capture region; frames are cropped to it before upload.

`POST /v1/desks` registers the desk with the server once and returns a **desk token**. It is
idempotent and keyed by the local desk id, so re-running setup updates rather than duplicates. The
rig uses the desk token for its socket and its uploads, so it never holds the user's credentials. The
setup fields are typed in the desktop app; the rectangle is stored by the rig in `~/.heli/rig.json`.

---

## Frames

```
POST /v1/sessions/:id/frames
content-type: image/jpeg
x-heli-captured-at: 2026-09-19T14:02:11.482Z
x-heli-source: camera | screen
x-heli-seq: 17

<the JPEG bytes>
```

The rig uploads with `x-heli-captured-at` and `x-heli-seq`; it sends one frame at a time and
**skips a tick** if the previous upload has not returned. Server rules: JPEG only, ≤2 MB, ≤1600 px on
the long edge, and it keeps **the newest frame per session**. Older frames are dropped, never queued —
a stale frame is worse than a missing one. A rejection is `422 { error, code }` with one of
`frame_not_jpeg`, `frame_too_large`, `frame_too_wide`; `409 no_open_session` means nothing is being
watched, so the rig backs off instead of spinning.

The loop reads the newest frame through the `frameBytes` reader in
`apps/server/src/observe/persistence.ts`, so nothing in the loop changes.

---

## Desk actions

Delivered over the **existing desktop socket** (`ApiToDesktop`), acked by the app. Same ack,
timeout and retry rules as any command.

| action | payload | what the rig does |
|---|---|---|
| `capture` | `{ reason }` | take one frame now and upload it |
| `stream.start` | `{ fps }` | begin capturing at that rate |
| `stream.stop` | — | stop capturing |
| `camera.zoom` | `{ factor }` | optical or digital zoom, if the camera has it |
| `camera.exposure` | `{ value }` | only if the camera exposes it |
| `arm.aim` | `{ pan, tilt }` | move to an absolute pose, then report it |
| `arm.point` | `{ x, y }` | aim at a point on the desk plane, using the calibration |
| `arm.nod` | `{ times }` | a small physical acknowledgement — a tier-3 action |
| `arm.home` | — | return to the stored home pose |

Every action acks with `{ status, result? }`; `result` for `arm.*` includes the achieved pose, and
for `capture` the frame's `seq`. An action that cannot be performed — no arm, no zoom, serial
error — acks `failed` with a reason. **Nothing is pretended.**

### Physical interventions

`arm.point` and `arm.nod` let a tier-3 intervention be physical: the arm can point at the line it
is asking about instead of only speaking. This is gated the same way as speech: it needs the goal's
`automate` permission, it is rate-limited by the same gap, it is logged with its outcome, and it is
reversible (the next action, or `arm.home`, undoes it).

---

## Caps and health

```jsonc
{ "t":"desk.caps", "camera": { "model":"...", "maxWidth":1920, "maxHeight":1080, "zoom":false },
  "arm": { "model":"...", "dof":6, "serial":"usbmodem14201" } | null,
  "transport": ["ws"] }

{ "t":"desk.health", "fps":2, "lastFrameAt":"...", "armPose":{ "pan":0,"tilt":-12 }, "tempC":48 }
```

A missing `arm` means aim actions are never sent. That is the whole capability negotiation.

---

## Acceptance checklist

1. Setup registers a desk with a name, a camera and (optionally) an arm; re-running updates it.
2. A frame upload appears as the session's latest frame and the loop's next assessment uses it.
3. An oversized or non-JPEG upload is rejected with a clear error and nothing is stored.
4. `capture` produces exactly one new frame.
5. `stream.start { fps: 2 }` produces about two frames a second; `stream.stop` ends it.
6. `arm.point { x, y }` aims at that point on the desk plane and acks the achieved pose.
7. `arm.home` returns to the stored pose.
8. With no arm configured, aim actions are refused and the rest still works.
9. Killing the app and restarting it keeps its desk registration and its calibration.
10. `desk.health` arrives with the capture fps and the last frame time.
