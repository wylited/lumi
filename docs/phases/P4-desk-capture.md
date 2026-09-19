# P4 · Desk capture and the arm

**Goal:** the Mac rig sees the desk, and the arm can aim the camera at what the server is unsure
about. This replaced the Pi phase: there is no device, no pairing code and no LED. See
`docs/03-desk-capture.md`, which is the contract this phase implements.

**Depends:** P0; `041` also on P1/014, `043` on P2/022 (the speech path it sits beside).
**Parallelism:** `040` and `041` can start together. `042` needs a serial port and the arm's SDK.
**Owner 4 · hardware + rig.** Nobody else touches `apps/desktop/src-tauri/src/arm/**`.

---

### HELI-040 · feat(desktop): camera capture and frame upload
**Depends:** P0/009 **Parallel-safe:** yes **Owner:** 4
**Touches:** `apps/desktop/src/capture/**`, `apps/desktop/src-tauri/src/camera.rs`, `apps/desktop/src/lib/capture.ts`
**Do:** Enumerate cameras, pick one, show a preview, and capture a JPEG on demand or on a cadence.
Downscale to ≤1600 px long edge and q80 **in the app**, never on the server, and crop to the saved
capture rectangle. Upload with `POST /v1/sessions/:id/frames` and the headers in the capture
contract. One frame at a time, and drop rather than queue: if an upload is still in flight, the next
tick is skipped. A capture that fails is reported, not retried in a tight loop.
**Done when:** a live session receives frames, the server's latest frame is the one just captured,
and pulling the camera out mid-session shows a clear error instead of a frozen preview.

### HELI-041 · feat(server): frame intake and the latest frame
**Depends:** 040, P1/014 **Parallel-safe:** no, 040 waits on it for an end-to-end test **Owner:** 4
**Touches:** `apps/server/src/routes/frames.ts`, `apps/server/src/services/frames.ts`, `apps/server/src/lib/frame.ts`
**Do:** `POST /v1/sessions/:id/frames` accepting a raw JPEG body with the capture headers. Validate
with the existing marker walk: JPEG only, ≤2 MB, ≤1600 px. Keep the **newest frame per session** and
mirror it so `frameBytes(ref)` can read it back for the loop — this is the hook
`observe/persistence.ts` already exposes, so the loop is unchanged. Reject the rest with a specific
code (`frame_too_large`, `frame_too_wide`, `frame_not_jpeg`) and store nothing. Also
`GET /v1/sessions/:id/frame.jpg` so the desktop and console can show the frame that was assessed.
**Done when:** a curl-uploaded frame is the one the next assessment uses, an oversized upload is
refused with the right code and no side effect, and only one frame is retained per session.

### HELI-042 · feat(desktop): arm control and aiming
**Depends:** 040 **Parallel-safe:** yes **Owner:** 4 (with the rig owner)
**Touches:** `apps/desktop/src-tauri/src/arm/**`, `apps/desktop/src/arm/**`, `apps/desktop/src/lib/arm.ts`
**Do:** A serial adapter behind one interface: `connect`, `pose()`, `aim({pan,tilt})`,
`point({x,y})`, `nod()`, `home()`. The vendor SDK or G-code dialect stays inside this module; the
rest of the app sees poses, not commands. Calibration is stored by "aim here": the person drags a
rectangle over the desk in the preview, and the module maps desk coordinates to a pose. Every call
has a timeout and reports the achieved pose, and a disconnected arm surfaces as a clear state
rather than a hung promise.
**Done when:** `arm.point` lands within a small tolerance of the rectangle's centre, `home` returns
to the stored pose, and unplugging the arm produces a readable error and no crash.

### HELI-043 · feat(server): desk actions and physical interventions
**Depends:** 041, 042, P2/022 **Parallel-safe:** yes **Owner:** 4
**Touches:** `apps/server/src/routes/desk.ts`, `apps/server/src/services/desk.ts`, `apps/server/src/observe/actions.ts`
**Do:** Deliver the actions in the capture contract over the **existing desktop socket** and track
their lifecycle with the same ack, timeout and retry rules as any command. `POST /v1/desks` to
register, `GET /v1/desks`, `GET /v1/desks/:id/caps`, `POST /v1/desks/:id/actions`. In the loop, a
tier-3 intervention may be **physical**: `arm.point` at the line it is asking about, or `arm.nod`
as the acknowledgement, both gated exactly like speech (the goal's `automate` permission, the same
gap, logged with the outcome) and both reversible via `arm.home`. If no arm is configured the
action is refused and the spoken line still fires — the physical path is an enhancement, never a
dependency.
**Done when:** a tier-3 decision points the arm at the flagged line and acks the pose, the same
decision with no arm still speaks, and `GET /v1/desks/:id/actions` shows the lifecycle of each.

### HELI-044 · chore(desktop): desk setup replaces pairing
**Depends:** 040, 042 **Parallel-safe:** yes **Owner:** 4
**Touches:** `apps/desktop/src/routes/setup.tsx`, `apps/desktop/src/components/setup/**`, `apps/desktop/src/lib/desk.ts`
**Do:** The first-run flow: name the desk, choose the camera with a live preview, optionally attach
an arm (serial port + model), and complete "aim here" calibration. Store it locally, register once
with `POST /v1/desks`, and make the flow idempotent. Remove every trace of pairing from the desktop:
no code entry, no QR, no device token. The server keeps its pairing routes for now but nothing calls
them, and the ledger notes them as retired.
**Done when:** a fresh install gets from first launch to a live preview and a registered desk
without typing a code, and re-running setup updates the same desk instead of creating a second.

---

## Exit criteria

- A frame taken on the Mac is what the next assessment reads
- The arm can be aimed at a point on the desk and reports where it landed
- A tier-3 intervention can be physical, and still speaks when there is no arm
- Nothing in this phase requires a Pi, a pairing code or a QR
