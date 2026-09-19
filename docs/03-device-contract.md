> **SUPERSEDED.** There is no Pi. The rig is a Mac with a camera on a robotic arm; see
> `docs/03-desk-capture.md`. This file is kept only so the retired design is not lost.

# Device contract

**Audience: whoever is building the Pi agent.** This is the only software document you need.
Nothing in `apps/` is yours, and nothing here depends on how the rest is built.

The unit is a Raspberry Pi 5 in the observer shell: Camera Module 3 Wide on a tilting head, a 4-mic
array, a down-firing speaker, an LED ring, and a mechanical privacy shutter.

---

## Your seven responsibilities

1. **Decide when something happened.** Frame-differencing at ~5 fps in OpenCV. When ink or the
   scene changes and then holds still for `stillMs`, that is a trigger. This runs on the Pi and
   costs nothing — **never stream video to us continuously unless a session asked for it.**
2. **Send one JPEG per trigger.** One frame, not a burst.
3. **Stream media when asked.** On `media.start` you stream tagged video and audio to us; on
   `media.stop` you stop. See §6.
4. **Play what we send.** We synthesise the line; you play the PCM we send back, and report when it
   finished.
5. **Be a state machine.** `idle → armed → watching → flagged → speaking → watching`, plus
   `shutter_closed`. Report every transition.
6. **The light and the shutter.** The ring reflects state (§8). The shutter is mechanical — closed
   means **no frames leave the unit, within 200 ms**, and you say so.
7. **Report caps and telemetry.** What you can do, and that you are alive (§4, §7).

## What you are **not** responsible for

Reading the screen. Deciding anything. Choosing what to say. Storing anything beyond the current
session. Holding any provider key. If you find yourself adding a model call on the Pi, stop and talk
to us.

---

## 1. Connection

```
wss://api.heli.hk/ws/device
Sec-WebSocket-Protocol: heli.v1, <pairing-code>
```

JSON text frames for events. **Everything else is binary and tagged (§6).** The pairing code is
shown as a QR in the app; pairing is idempotent, so reconnecting with the same code is fine.

If you have no code yet, ask the app to pair: it prints the code and the QR.

---

## 2. You send

```jsonc
{ "t":"hello", "deviceId":"heli-0001", "agentVersion":"0.1.0",
  "caps": {
    "camera":"imx708-wide", "mics":4, "speaker":true, "shutter":true,
    "ptz":true, "transports":["ws"], "audio":true,
    "resolutions":[[1280,960],[1600,1200]], "fps":[1,5,8,15]
  } }

{ "t":"session.open", "goalId": null }          // a session began (the app told you, or motion woke you)

{ "t":"frame", "seq":17, "ts":"2026-09-19T14:02:11.482Z", "trigger":"pen_still" }
// → the NEXT websocket message is the JPEG, raw and untagged, ≤ 1600px long edge, q80, ≤ 2 MB

{ "t":"media.start", "video":{ "codec":"jpeg","fps":8,"width":1280,"height":960 },
  "audio":{ "codec":"pcm_s16le","sampleRate":16000,"channels":1 } }
// → then tagged binary, see §6

{ "t":"media.stop", "reason":"idle" }            // shutter | idle | user | error | replaced
{ "t":"media.state", "state":"live" }            // idle | live

{ "t":"state", "state":"watching" }              // every transition
{ "t":"telemetry", "cpu":0.23, "tempC":47.5, "rssi":-52, "uptimeS":375, "fps":8, "bytesSent":60808 }
{ "t":"command.ack", "commandId":"cmd_1", "status":"done", "result":{ "blinked":true } }
{ "t":"stream.info", "transport":"ws", "url":"" }
{ "t":"bargein", "ts":"2026-09-19T14:03:02.001Z" }  // the person spoke over us
{ "t":"session.close", "reason":"idle_timeout" }    // or "shutter_closed", "user"
```

`seq` must be monotonic per process run — it names the stored frame, so a restart that resets it to
zero would overwrite frames.

---

## 3. You receive

```jsonc
{ "t":"session.start", "sessionId":"...", "goal":{…}, "policy":{…} }
{ "t":"audio.out", "format":"pcm_s16le", "sampleRate":16000, "channels":1,
  "durationMs":2980, "momentId":"..." }
// → the NEXT message is tagged 0x02 audio, exactly durationMs of PCM. Play it. (See §6.3.)

{ "t":"command", "id":"cmd_1", "type":"identify", "issuedAt":"...", "payload":{…} }
{ "t":"policy.update", … }        // thresholds changed mid-session
{ "t":"error", "code":"frame_too_large", "message":"…", "ref":"seq:17" }
{ "t":"session.stop", "reason":"..." }
```

**Command types** you may receive: `capture`, `stream.start`, `stream.stop`, `camera.set`,
`camera.ptz`, `led.set`, `shutter.set`, `speak`, `identify`. Ack all of them, including ones you
cannot perform (`status:"failed"` with a reason). A command that is never acked is marked failed by
us after 10 s and retried once if it is idempotent.

Fields from `policy` you must honour: `stillMs` (how long the scene must hold), `fps` caps in a
`camera.set`, and the `maxTier` in the goal is our business, not yours.

---

## 4. Caps

Report what is actually true. We hide controls we cannot use, so a wrong cap means a dead button.
`transports` is the list you will actually serve for `stream.start` (`ws`, `mjpeg`, `webrtc`).
`ptz` must be false unless the head really moves.

---

## 5. Frames

- JPEG only, **≤ 1600 px on the long edge**, quality 80, **≤ 2 MB**. We reject the rest with
  `error.code = frame_too_large | frame_too_wide | frame_not_jpeg`.
- One frame per trigger on the tagged-free path; the raw JPEG follows the `frame` text message
  immediately, with nothing in between.
- Downscale on the Pi, not in the cloud. The Pi has the pixels; we should not.

---

## 6. Media streams

Only while a session wants them. Tagged binary: the **first byte is the tag**, the rest is payload.

| tag | payload | format |
|---|---|---|
| `0x01` | video | one complete JPEG, ≤ 2 MB |
| `0x02` | audio | raw PCM S16LE, interleaved, at the announced rate |
| `0x03` | meta | reserved |

### 6.1 Start

```
{"t":"media.start","video":{"codec":"jpeg","fps":8,"width":1280,"height":960},
 "audio":{"codec":"pcm_s16le","sampleRate":16000,"channels":1}}
```

### 6.2 Video

Send a tagged frame at the requested rate. **8 fps, 1280×960** is the default and is enough for a
desk. A worked send of one frame:

```
byte 0x01, then the full JPEG bytes
```

If you cannot keep up with the rate, **drop a frame** rather than queuing — a stale frame is worse
than a missing one. Never let the socket back up: if the send buffer is full, drop video first.

### 6.3 Audio

**100 ms chunks** at 16 kHz mono S16LE = 1600 samples = **3200 bytes**. Send a tagged chunk every
100 ms while live.

When you receive `audio.out`, the **immediately following** message is tagged `0x02` and is
`durationMs` of PCM. Play it straight away through the speaker at the announced format. When it
finishes, send `state: speaking → watching` and — when we are using the acked path — a `command.ack`
if the line came from a `speak` command. If the person speaks over it, send `bargein` immediately
and stop playback; we will have stopped our side too.

Never queue two lines. One playing, at most one waiting.

### 6.4 Stop

```
{"t":"media.stop","reason":"idle"}
```

Stop sending tagged binary at once. On our side the last frame is kept so a still can still be
served.

---

## 7. Telemetry

Send a `telemetry` message every ~5 s while connected: `cpu` (0..1), `tempC`, `rssi`, `uptimeS`,
`fps` (current media fps, 0 when idle), `bytesSent` (since session start). It is how we know you are
alive and hot. Keep it under a second of CPU.

---

## 8. LED ring and shutter

The ring is the only feedback a screenless unit has. **Keep it boring.**

| state | ring |
|---|---|
| `idle` | off |
| `armed` | one slow breath, then off |
| `watching` | a single dim dot — steady, **not** pulsing |
| `flagged` | nothing. Do not telegraph that it noticed before the voice speaks. |
| `speaking` | amplitude-follows-voice |
| `shutter closed` | two steady amber dots |

A ring that animates while a person is concentrating is worse than no ring.

**Shutter:** closing it mid-session must stop frames and media within **200 ms** and emit
`state: shutter_closed`. While closed, nothing leaves the unit. This is a privacy promise, so it is
a hard requirement, not a nicety.

---

## 9. Local behaviour we care about

- **Backpressure:** if a frame is in flight and a new trigger fires, drop the older one.
- **Offline:** if the socket drops, keep watching and keep a ring buffer of the last 3 triggers.
  Reconnect, send `hello`, then `session.open`, then replay **at most the newest** trigger.
  (A replayed `frame` before `session.open` is dropped.)
- **Idle timeout:** 4 minutes with no change and no speech closes the session locally.
- **Reconnect:** exponential backoff, cap 30 s, and a loud log so a flaky wifi is visible.

---

## 10. Acceptance checklist

Run these against a running server. Ask for the app URL and pairing code.

1. `hello` with a valid code is acked; a bad code closes with 401.
2. Caps reported match reality; `ptz:false` hides the controls in the app.
3. Motion plus stillness produces exactly **one** `frame` and one JPEG.
4. A JPEG over 2 MB is refused with `frame_too_large` (do not fix it silently).
5. `media.start` then tagged `0x01` frames: the app shows live video at the requested fps.
6. Tagged `0x02` audio: the app's audio meter moves.
7. `command` `capture` is acked `done`; `camera.ptz` echoes the new position.
8. `audio.out` plus tagged PCM is audible, and playback completion is reported.
9. Speaking over it stops playback within one chunk and records a barge-in.
10. Closing the shutter stops frames within 200 ms and is reported.
11. Killing wifi and restoring it reconnects and replays at most the newest trigger.
12. `telemetry` arrives every ~5 s.

---

## 11. Errors you may receive

| code | meaning | what to do |
|---|---|---|
| `frame_too_large` | over 2 MB | downscale, do not retry the same bytes |
| `frame_too_wide` | over 1600 px long edge | downscale |
| `frame_not_jpeg` | the binary was not a JPEG | fix the encoder |
| `unknown_event` | a text frame we do not know | fix the agent version; do not spam |
| `frame_without_media` | tagged binary sent before `media.start` | send `media.start` first |
| `auth_failed` | bad or rotated code | re-pair |

We never send you a stack trace, and you never send us one.
