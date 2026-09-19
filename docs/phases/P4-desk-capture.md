# P4 · The rig — camera, arm, and the desk

**Goal:** the Mac rig sees the desk, aims the camera at what the server is unsure about, and plays
what the observer says. This replaced the Pi phase. Read `docs/03-desk-capture.md` first: it is the
contract these commits implement.

**Depends:** P0. `041` also on P1/014 (the frame store), `043` on P0/004 (contracts are law).
**Parallelism:** `040` and `042` can start together; `043` is the contracts gate for everything
desk-shaped, so **land it first or in parallel with `041`**.
**Owners:** `040`, `042`, `045` are **4 · hardware + rig**. `043` and `044` are **2 · server**.
`046` is **3 · desktop + web**.

> **Where the code lives.** The rig agent is **`apps/edge`** — Python 3.11 + uv, package `heli_rig`.
> It owns the arm (serial/SDK), the camera and the speaker, runs headless, and can be restarted
> without touching the UI. The desktop app owns **signals and the interface**; the server owns
> assessment, policy and persistence. The rig never sees a user id or a session id: it posts a
> frame, and the server decides whose night it is.

```
arm + camera ──USB──▶ apps/edge  (heli_rig, Python, headless)
                        │ frames   POST /v1/desk/frames        (raw JPEG, ≤1600 px, ≤2 MB)
                        │ health   WS /ws/desk  desk.health     (every 5 s)
                        │ actions  WS /ws/desk  ◀── capture · stream · zoom · arm.*
                        │ audio    ◀── audio.out + tagged PCM  (plays it, then acks)
                        ▼
                   apps/server  node :3001
                        ▲ signals (app, window, input, idle, screen) · SSE · speech
                   apps/desktop  (Tauri UI: goal, live state, desk panel)
```

---

### HELI-040 · feat(edge): the rig agent, camera capture and frame upload
**Depends:** P0/009 **Parallel-safe:** yes **Owner:** 4
**Touches:** `apps/edge/pyproject.toml`, `apps/edge/heli_rig/__init__.py`, `apps/edge/heli_rig/__main__.py`, `apps/edge/heli_rig/config.py`, `apps/edge/heli_rig/camera.py`, `apps/edge/heli_rig/upload.py`, `apps/edge/.env.example`, `apps/edge/README.md`
**Do:**
- `uv`-managed Python project. One entry point: `uv run heli-rig` (and a `--once` mode that takes a
  single frame and exits, for testing). Config from env with defaults: `HELI_API_URL`
  (default `http://localhost:3001`), `HELI_DESK_TOKEN` (falls back to `HELI_EMAIL` + dev-login until
  `044` issues a desk token), `HELI_CAMERA_INDEX` (default 0), `HELI_FPS` (default 2),
  `HELI_MAX_EDGE_PX` (default 1600), `HELI_JPEG_QUALITY` (default 80).
- **Camera:** OpenCV `cv2.VideoCapture`. Enumerate devices, open the configured one, warm up, and
  report a usable frame or a clear error. Downscale so the long edge is ≤1600 px and encode JPEG q80
  **on the rig** — the server rejects anything larger, and the rig has the pixels.
- **Capture cadence:** at `HELI_FPS`, plus immediately on a `capture` action. One upload in flight at
  a time: if the previous POST has not returned, **skip this tick** rather than queueing.
- **Upload:** `POST /v1/desk/frames`, body is the JPEG bytes, `content-type: image/jpeg`, headers
  `x-heli-captured-at` (ISO) and `x-heli-seq` (monotonic per process). A 409 means no session is
  open: log once, keep trying at a slower cadence, do not spin. A 422 means the server refused the
  bytes: log the code, do not retry the same frame.
- **Never crash on a lost camera.** Unplug → clear error state, retry every 5 s, keep the process up.
**Done when:** `uv run heli-rig --once` uploads one frame and the server returns `201` with
`{ width, height, ref }`; with a live session the server's `GET /v1/desk` reports `hasFrame: true`
and `frames` climbing; unplugging the camera prints a readable error and the process survives.

### HELI-041 · feat(server): frame intake and the newest frame
**Depends:** 040, P1/014 **Parallel-safe:** no **Owner:** 2
**Touches:** `apps/server/src/routes/desk.ts`, `apps/server/src/services/frames.ts`, `apps/server/src/observe/persistence.ts`
**Do:** Already drafted in the tree (`879a5d9`) — review, finish and take it over:
`POST /v1/desk/frames` accepts raw JPEG, attributes it to the single open session, validates with the
existing marker walk (JPEG, ≤2 MB, ≤1600 px), and stores nothing on a rejection. It returns
`201 { ref, seq, width, height, sessionId }` or `422 { error:'frame_rejected', code }` or
`409 no_open_session`. `GET /v1/sessions/:id/frame.jpg` serves the newest frame;
`GET /v1/desk` reports the desk, the open session and the frame count. The loop's reader takes the
newest frame from the frame store, so the model looked at what the rig actually sent.
**Done when:** a curl-uploaded frame is the one the next assessment reads; an oversized upload is
refused with `frame_too_large` and no side effect; only one frame is retained per session.

### HELI-042 · feat(edge): the arm adapter and aiming
**Depends:** 040 **Parallel-safe:** yes **Owner:** 4 (with the rig owner)
**Touches:** `apps/edge/heli_rig/arm/__init__.py`, `apps/edge/heli_rig/arm/driver.py`, `apps/edge/heli_rig/arm/serial_arm.py`, `apps/edge/heli_rig/arm/calibration.py`, `apps/edge/tests/test_arm.py`
**Do:** One interface, several drivers:

```python
class ArmDriver(Protocol):
    def connect(self) -> None: ...
    def is_connected(self) -> bool: ...
    def pose(self) -> ArmPose: ...                                  # pan, tilt (degrees)
    def aim(self, pan: float, tilt: float) -> ArmPose: ...           # absolute, returns achieved
    def point(self, x: float, y: float) -> ArmPose: ...              # desk plane, via calibration
    def nod(self, times: int = 1) -> None: ...
    def home(self) -> ArmPose: ...
```

- `serial_arm.py` speaks the vendor's dialect behind that interface. **The dialect never leaks past
  this file.** Start with whatever the arm on the desk speaks — the rig owner has the SDK; keep the
  first version a straight translation of its move-to-pose call.
- `calibration.py` stores `~/.heli/rig.json`: the capture rectangle in desk millimetres and the two
  or three poses that map it, so `point(x, y)` is a linear fit and does not need new maths.
- Every call has a timeout (default 5 s) and returns the **achieved** pose, not the requested one.
- A missing or unplugged arm raises a typed error; the rest of the agent keeps working.
**Done when:** with the arm attached, `point(x, y)` lands within a small tolerance of the target;
`home()` returns to the stored pose; with no arm, the agent starts and reports `arm: null`; an
unplugged arm mid-run produces a readable error and no crash.

### HELI-043 · feat(contracts): the desk socket, registration and actions
**Depends:** P0/004 **Parallel-safe:** no, everything desk-shaped waits on it **Owner:** 2
**Touches:** `packages/contracts/src/desk.ts` (new), one export line in `packages/contracts/src/index.ts`
**Do:** The shapes the rig and the server agree on, so nobody hand-writes them:
- `DeskRegistration { name, camera: { model, maxWidth, maxHeight }, arm: { model, dof } | null }` and
  `Desk { id, name, hasCamera, arm, registeredAt }`, with `POST /v1/desks` idempotent on the desk's
  locally stored `deskId`.
- `DeskAction` as a discriminated union on `type`: `capture`, `stream.start {fps}`,
  `stream.stop`, `camera.zoom {factor}`, `arm.aim {pan,tilt}`, `arm.point {x,y}`, `arm.nod {times}`,
  `arm.home`. Each carries `id`, `issuedAt`.
- `DeskAck { actionId, status: accepted|done|failed, result?, error? }`, where an arm result carries
  the achieved pose and a capture result carries the frame `seq`.
- `DeskToApi` / `ApiToDesk` unions for `/ws/desk`: `hello`, `desk.caps`, `desk.health {fps,
  lastFrameAt, armPose, tempC}`, `action.ack` up; `action` down.
- `DeskFramesResponse { ref, seq, width, height, sessionId }` and the rejection codes so the rig can
  branch on them.
**Done when:** `pnpm --filter @heli/contracts build` emits the new schemas into
`dist/json-schema.json` (the Python side reads the same file), and `desk` is exported from the index.

### HELI-044 · feat(server): desks, the desk socket, and actions with acks
**Depends:** 043, 041 **Parallel-safe:** no **Owner:** 2
**Touches:** `apps/server/src/routes/desk.ts` (extend), `apps/server/src/ws/desk.ts` (new), `apps/server/src/services/desk.ts` (new), `apps/server/prisma/schema.prisma` (a `Desk` model or reuse `Device`), `apps/server/src/plugins/routes.ts` only if a `.ws` folder is needed
**Do:** `POST /v1/desks` registers or updates the single desk and returns a **desk token** so the rig
never holds the user's credentials. `GET /v1/desks` lists it (there is one). `WS /ws/desk?token=`
validates the desk token, accepts `desk.caps`/`desk.health`, and **sends actions** with the same
lifecycle rules as any command: persisted state, a 10 s ack timeout, one retry for idempotent
actions, `desk_offline` / `ack_timeout` reasons. `POST /v1/desks/:id/actions` for a manual action and
`GET /v1/desks/:id/actions` for the log. Retire the pairing routes and the device socket in the same
commit, or mark them deleted in the ledger — nothing calls them now.
**Done when:** the rig connects, `desk.health` appears in `GET /v1/desk`, `capture` round-trips to
`done`, a missing rig times out to `failed/desk_offline`, and `grep -r "ws/device" apps/` finds
nothing but the retired file.

### HELI-045 · feat(edge): the action client and audio playback
**Depends:** 042, 044 **Parallel-safe:** yes **Owner:** 4
**Touches:** `apps/edge/heli_rig/socket.py`, `apps/edge/heli_rig/actions.py`, `apps/edge/heli_rig/audio.py`
**Do:** Connect to `/ws/desk` with the desk token, announce `desk.caps`, send `desk.health` every 5 s
(capture fps, last frame time, arm pose, temperature if the machine exposes it), and handle every
action in `DeskAction`: `capture` → one frame now; `stream.start/stop` → change the capture cadence;
`camera.zoom` → the camera's zoom or a refusal; `arm.*` → the adapter, then **ack with the achieved
pose**. Reconnect with exponential backoff (cap 30 s) and say so in the log.
Audio: on `audio.out` the next tagged `0x02` chunk is PCM S16LE; write it to a temp WAV and play it
with `afplay` (no audio dependency), then ack the spoken line with its duration. If a `bargein` is
detected — the mic level rises while playing — stop playback and report it. Never queue two lines.
**Done when:** an action from `POST /v1/desks/:id/actions` is executed and acked from the rig, a
spoken line is audible on the Mac's speakers, and a second line never overlaps the first.

### HELI-046 · feat(desktop): setup — the goal, the watch, the desk
**Depends:** 044, 072 **Parallel-safe:** yes **Owner:** 3 · desktop + web
**Touches:** `apps/desktop/src/routes/setup.tsx`, `apps/desktop/src/components/setup/**`, `apps/desktop/src/components/desk/**`, `apps/desktop/src/lib/desk.ts`, `apps/desktop/src/lib/setup.ts`, `apps/desktop/src/routes/settings.tsx`
**Do:** First-run setup, replacing pairing for good, and **the onboarding is the demo**: three screens
and one button, every claim proved live on screen.
1. **The goal.** The field is pre-filled and editable with the demo sentence, seeded chips (Study ·
   Work · Life) beside it. On submit: a reading state, then the draft from `072` revealed as editable
   chips — objective, done-when, minutes, breaks, on-goal apps, off-goal apps and sites — with the
   permission ladder shown as the escalation it is (`nudge → speak → point at the page`). A keyless
   or failed draft reveals the local one and says so.
2. **The watch.** Three live rows, not promises: the camera preview with its fps; the machine — the
   **actual** frontmost app, window title, input rate and idle, updating live, with a mono ticker of
   the last signals; and the screen — the last frame as a thumbnail with its timestamp and the line
   “one frame every 10 s, only while a session is live, kept for the session”. The OS grants as rows
   with real state and a deep link, plus **Continue anyway**, which degrades honestly and names what
   will be missing.
3. **The desk.** **desk name**, **camera** (chosen from what the rig reports, with a live preview),
   **arm** (present or not, and its model), then **"aim here"** — drag a rectangle over the desk in
   the preview and the desktop posts it to the rig through `POST /v1/desks/:id/actions` with
   `arm.point` at its centre to confirm. Store the desk id locally; `POST /v1/desks` is idempotent.
   Then **Start watching**.
Then the panel in Settings: desk name and state, camera preview, arm connection and pose, capture fps
and last frame time, a re-aim action, and honest disconnected states.
**Done when:** a fresh install gets from first launch to a live session without typing a code, with
the goal drafted, the watch proved live and the desk aimed; re-aiming updates the stored rectangle;
an unplugged rig reads as disconnected.
---

## Exit criteria

- A frame taken on the Mac is the one the next assessment reads, and the arm can be aimed at a point
  on the desk and reports where it landed
- An intervention can be physical — the arm points at the page — and still speaks when the arm is
  absent
- Nothing in the rig needs a Pi, a pairing code, a QR or a user id
