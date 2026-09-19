# P4 · Edge and media

**Goal:** the desk is seen and heard, and the system can speak back. The Pi streams camera and
audio to the server, the server fans it out and samples frames into the loop, and audio comes back.

**Depends:** P0; `041` also on P1/014, `043` on P2/022.
**Parallelism:** `040` first (it produces the agent). `041–043` then run in parallel.
**Owner D** takes this phase, with the **hardware person** on `040` and `042`.

> The device holds **no provider key** and stores nothing. Video and audio come to the API as
> tagged binary on the device socket; the API processes them. See `docs/03-device-contract.md`.

---

### HELI-040 · feat(edge): camera and audio agent
**Depends:** P0/009 **Parallel-safe:** yes **Owner:** D + hardware
**Touches:** `apps/edge/**`
**Do:** The Python agent on the Pi (3.11 + uv), built to `docs/03-device-contract.md` (which lands
in P0 as `HELI-009` — do not rewrite it here; if the contract and reality disagree, fix the contract
in its own commit first). Frame-difference at ~5 fps with OpenCV; when ink changes and the scene is
still for `policy.stillMs`, that is a trigger — one JPEG, never a stream. Plus a media mode: on
`media.start`, stream tagged binary to the socket (`0x01` video JPEG at the requested fps, `0x02`
audio PCM S16LE 16 kHz mono) and stop on `media.stop`. Authenticate with
`Sec-WebSocket-Protocol: heli.v1, <pairing-code>`. Report caps on `hello`: camera model, mic count,
speaker, shutter, ptz, transports, resolutions, fps options. Emit telemetry every ~5 s.
**Done when:** the agent connects to the server, opens a session, delivers one frame per trigger,
streams media in media mode, and every line of the §10 acceptance checklist in the device contract
passes.

### HELI-041 · feat(server): media relay and mjpeg
**Depends:** P1/014 **Parallel-safe:** yes **Owner:** D
**Touches:** `apps/server/src/routes/media.ts`, `apps/server/src/media/token.ts`, `apps/server/src/media/audio.ts`
**Do:** `GET /v1/sessions/:id/media-token` mints a short-lived, session-scoped token (about 60 s)
so a browser can open the media socket without a cookie header. `GET /v1/sessions/:id/media`
(WebSocket, `?token=`) sends a JSON control frame per item — `{type:'state'|'frame'|'audio'|'bargein',
…meta}` — then the tagged binary. `GET /v1/sessions/:id/video.mjpg` is the MJPEG fallback for a
plain `img`. `POST /v1/sessions/:id/sample` forces one sample through the real loop and returns the
created observation id, falling back to the mirrored latest frame after the stream stops.
`GET /v1/sessions/:id/media-state` reports `{ state, videoFps, audioLevel, audioPlaying,
speechQueueDepth, lastFrameAt, bytesIn, bytesOut }`.
**Done when:** the MJPEG endpoint returns `multipart/x-mixed-replace`, a media socket receives
video and audio with the right tags and metadata, and a forced sample produces a real observation.

### HELI-042 · feat(edge): led and shutter
**Depends:** 040 **Parallel-safe:** yes **Owner:** hardware
**Touches:** `apps/edge/agent/led.py`, `apps/edge/agent/shutter.py`
**Do:** The LED ring is the only feedback a screenless device has. `idle` off, `watching` a single
dim dot, `flagged` **nothing** — do not telegraph that it noticed before the voice speaks —
`speaking` amplitude-follows-voice, `shutter closed` steady amber. Report every transition with
`state`. The shutter is mechanical: closing it **stops frames within 200 ms** and emits
`shutter_closed`; while closed, no frame and no media leaves the unit. A ring that animates while a
person is concentrating is worse than no ring.
**Done when:** each state is visually distinct on the real unit, closing the shutter stops frames
within 200 ms and is reported, and no state animates while `watching`.

### HELI-043 · feat(edge): barge-in and playback
**Depends:** 040, P2/022 **Parallel-safe:** yes **Owner:** D
**Touches:** `apps/edge/agent/audio.py`, `apps/server/src/media/speech.ts`
**Do:** Receive `audio.out` followed by a tagged `0x02` chunk and play it on the speaker with a
small buffer; report `spoken` with the moment id when playback finishes. Detect the person speaking
over the device and send `bargein` immediately; the server stops the audio and the desktop stops
its playback within one chunk. Never stack two spoken lines: one playing, at most one queued.
**Done when:** a tier-3 line is audible on the device, speaking over it stops playback within a
chunk and is recorded, and two decisions in quick succession do not overlap.

---

## Exit criteria

- A real desk produces frames and audio; the server samples video into the loop and speaks back
- The shutter privacy promise holds: closed means nothing leaves, within 200 ms
- The hardware person can build against `docs/03-device-contract.md` alone
