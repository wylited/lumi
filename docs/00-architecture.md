# Architecture

## What it is

**Lumi** — the product; **Lumi One** is the desk unit it sells. (Helicopter is the repository's
working name.) An observer that helps one person finish what they sat down to do. It watches the desk with a
camera and a microphone, watches the machine through the desktop app, keeps the record, and — only
when the evidence and the goal allow — **acts**: an ambient signal, a nudge, a spoken line, or an
automatic change to the machine.

```
 desk: camera + mic ─┐
                     ├─▶ server: aggregate ─▶ assess ─▶ policy ─▶ act ─▶ record
 machine: apps, tabs,┤        (signals)     (model)   (rules)   (notify, speak, block)
 input, idle ────────┘
```

---

## The loop

```
signal  →  aggregate  →  assess  →  policy  →  act  →  outcome
 (raw)      (per session) (model)   (ours)     (tiered)  (recorded)
```

- **signal** — a cheap raw event: a frame, a screen capture, the frontmost app, a window title,
  an idle transition, an input burst. Signals are noisy and individually meaningless.
- **aggregate** — fold signals into a short window per session so the model sees context, not a
  single twitch.
- **assess** — one structured `Assessment`: what is happening, is it on the goal, how sure are we.
  This is the only place a model runs.
- **policy** — ours. Turns an assessment into an intervention tier, or into silence, using the
  goal, the thresholds, the rate limits and what worked before.
- **act** — the tier that fired: log, ambient, nudge, speak, automate, or the session summary.
- **outcome** — recorded either way. That record is how the policy adapts.

Most windows end at **silence**. That is the intended default, not a gap.

---

## Who owns what

| | what it does | what it must never do |
|---|---|---|
| **desktop** (Tauri) | the base app. goal, live state, audio, the native macOS signals, camera capture and arm aiming | hold a model key, or act on the machine without logging it |
| **server** | aggregate, assess, policy, persist, push, speech and vision adapters | invent pedagogy or a goal |
| **web** | the storefront: what it is, the desk unit, the download, reservations | read or write a session, or hold anything about a user beyond a reservation |

### desktop (Tauri 2)
A Rust sidecar reads read-only signals, a webview renders the goal and the live state.

Native signals, all requiring consent:
`NSWorkspace.frontmostApplication` (which app), `CGWindowListCopyWindowInfo` (window title),
`AXUIElement` (focused element), `CGEventTap` (**counts and timing only — never key content**),
`CGEventSourceSecondsSinceLastEventType` (idle), the Focus / Do Not Disturb state, and
`ScreenCaptureKit` for a periodic screen frame.

The desktop app owns the interruption surfaces: menu-bar state, notifications with an action, and
audio playback.

### rig (`apps/edge`, headless)
The camera is mounted on a robotic arm on USB. A small Python agent on the same Mac captures
frames, uploads the newest one, plays the spoken line, and can **aim** the camera when the server is
unsure what it is looking at. It runs without the UI, holds no user id and no session id, and never
sees a provider key. See `docs/03-desk-capture.md`.

### server (Fastify)
Everything that persists; the only holder of a key. Goals and sessions, the observation row, the
policy, provider adapters, the media relay, analytics and SSE.

### web (Next.js)
The storefront, and nothing else. **The product is the desktop app and the desk unit**; the web
explains them, sells the unit and hands out the app:

| page | job |
|---|---|
| `/` | what it does, shown: the unit in 3D, the app's real screens, one session as a ribbon, the escalation ladder |
| `/device` | the desk unit: its states (try the ring and the shutter), parts, what it never does, specs, buy |
| `/download` | the desktop app: download, the three permissions and what each never reads, setup in three steps |
| `/order` | reserve a unit — no payment exists in this build; a reservation is a line on the web server |
| `/privacy` | the privacy promise in plain words |

Review of your own sessions (history, what brings you back, replay) and desk setup live in the
desktop app. The web never talks to the server.

---

## The one row that matters

```
observation(session_id, ts, source, signals, assessment, tier, action, outcome, confidence)
```

Analytics are a `GROUP BY` over it. "What actually gets me back on task" is a `GROUP BY tier,
outcome`. Get this row right and every screen is a query.

---

## Signals we read (v1)

**Desk** — presence, away, posture, phone in hand, on-screen vs notebook, hand activity, ambient
noise, speech activity.

**Machine** — frontmost app, window title, browser tab title and (with an extension) URL, idle
time, input cadence and bursts, context switches per minute, session length, break compliance,
Focus / DND state, power and thermal.

Each signal carries a source, a timestamp and a confidence. Nothing content-bearing is stored:
we keep counts and titles, never keystrokes, never page bodies.

---

## Provider adapters

One interface each, so a provider can be swapped without touching the loop:

- **vision + assessment** — `deepseek-flash` is primary (images in, strict JSON out, ~384 tokens
  per image, so watching a desk is cheap). Dense screenshots are tiled into overlapping crops.
  Gemini sits behind the same interface as escalation. There is no offline stub: no key, no loop,
  and the server log says which key.
- **speech out** — ElevenLabs.

Keys live in `apps/server` and nowhere else.

---

## Budgets

| | target |
|---|---|
| signal to assessment | ≤ 4 s, then silence |
| desktop signals | ≤ 1 read per second, aggregated into windows |
| screen frames | ≤ 1 per 10 s, on change |
| speaking | at most once per `minGapMs` (default 90 s) |
| nudges | at most one per 3 minutes |
| machine actions | logged, visible, one-click reversible |

---

## Privacy, said plainly

It watches one consenting person's desk and machine, keeps counts and titles, never keystrokes or
page bodies, and everything it does to the machine is logged and undoable. The shutter is
mechanical: closed means no frames leave the unit.
