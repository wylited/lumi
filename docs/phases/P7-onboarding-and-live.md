# P7 · Onboarding and the live monitor

**Goal:** the two surfaces that _are_ the demo. Setup turns a sentence into a contract and a rig into
a desk; the monitor shows the desk, the screen, and what the observer is thinking, in one instrument.

**Depends:** P0. `071` on `041`; `072` on `004` and `020`; `074` on `071` and `032`.
**Parallelism:** `071` and `072` can start immediately. `075` needs `046`, `076` needs `046`.
**Owners:** `071`, `072` are **2 · server**. `073` is **1 · the loop**. `075`, `076` are
**3 · desktop + web**; `074` too once
`071` lands. The setup journey is **`046`**, extended in place below its P4 entry. The script is
**`062`** and the projector pass is **`063`**, both extended in P6.

> **The onboarding is the demo.** Every claim on those three screens must be visible on screen at the
> moment it is made: the live app name, the live window title, the live input rate, the last screen
> frame. A judge will ask “is it really watching?” — the answer is the screen itself, not the pitch.
>
> **Storage is cheap here.** Sessions are short and single-user, so frames are kept for the whole
> session: no eviction, no tiering. Say exactly that on the consent screen rather than implying a
> retention policy we do not have.

---

### HELI-071 · fix(server): per-source frames, and the assess step sees both

**Depends:** 041 **Parallel-safe:** no, the monitor waits on it **Owner:** 2 · server
**Touches:** `apps/server/src/routes/desk.ts`, `apps/server/src/services/frames.ts`, `apps/server/src/observe/persistence.ts`, `apps/server/src/observe/prompts/assess.md`
**Do:** The intake ignores `x-heli-source`, so a screen frame and a camera frame collide in “the
newest frame” and the model can be shown a screenshot believing it is the page. Honour
`x-heli-source: camera | screen`, keep **the newest frame per session per source**, and store every
frame for the session. Expose `GET /v1/sessions/:id/frame.jpg?source=screen|camera` (default
`camera`). The loop’s `frames()` returns **both** when both exist, as `AssessFrame[]` with
`kind: 'desk' | 'screen'` — the contract already models this, so nothing in the loop changes but the
reader. Tell the assess prompt which image is which, and ask it to name the frame its evidence came
from.
**Done when:** a camera frame then a screen frame leaves both retrievable and distinct; a forced
assessment carries two frames with the right kinds; the model’s `evidence` names the frame it used.

### HELI-072 · feat(server): drafting the goal from a sentence

**Depends:** 004, 020 **Parallel-safe:** yes **Owner:** 2 · server
**Touches:** `apps/server/src/services/goal-draft.ts`, `apps/server/src/routes/goals.ts`, `packages/contracts/src/goal.ts`, `apps/server/src/observe/prompts/goal.md`, `packages/contracts/scripts/emit-json-schema.ts`
**Do:** `POST /v1/goals/draft { sentence }` returns a structured draft: objective, successCriteria,
timeBudgetMinutes, breakPolicy, allowedApps, blockedApps, allowedSites, blockedSites and a suggested
permissions ladder. One text call on the client we already own, built like the assess step: JSON
mode, the schema in the prompt, zod as the judge. A **local fallback** parses the sentence with plain
rules (a time, a deadline, app names it recognises) so the path never depends on a key, and the
response says which produced it (`source: 'model' | 'local'`). `GoalDraft` and `GoalDraftRequest`
land in contracts and in the emitted JSON Schema, so the desktop and the Python side never hand-write
them.
**Done when:** a sentence becomes a schema-valid draft end to end; with no key the fallback returns a
sensible draft and reports `local`; the draft round-trips into `POST /v1/goals` unchanged.

> **The setup journey itself is `046`**, extended where it lives in `P4-desk-capture.md`: it now owns
> all three screens — the goal, the watch, the desk — and depends on `072` for the drafting call it
> renders. This doc does not re-cut it; read the P4 entry, which is the atomic spec.

### HELI-073 · feat(server): the loop's line reaches the desktop
**Depends:** 044, 048, `a23c676` **Parallel-safe:** no, the loop is deaf without it **Owner:** 1 · the loop
**Touches:** `apps/server/src/ws/live-desktop.ts`, `apps/server/src/ws/desktop.ts`, `apps/server/src/index.ts`, `apps/server/test/live-desktop.test.ts`
**Do:** The loop decides, and every line is recorded as undelivered: `/ws/desktop` builds its `send`
per connection and keeps no index, and `index.ts` passes `desk: () => null`. A registry keyed by
session id — attached when `hello` names a session, moved when a later frame names another, detached
on close — makes the socket answerable. The handle sends JSON through the existing contract check
(`ApiToDesktop`, which already carries `nudge` and `audio.out`) and binary as one tagged frame
(`MEDIA_TAG.audio` + PCM), in that order. `index.ts` replaces the null lookup with the registry.
**Done when:** a desktop client connected with a session receives a `nudge` and an `audio.out` header
followed by one tagged PCM frame, in order; closing the socket makes the next line record as
undelivered; the test proves both without a database.

### HELI-074 · feat(desktop): the live monitor, split

**Depends:** 071, 032 **Parallel-safe:** yes **Owner:** 3 · desktop + web
**Touches:** `apps/desktop/src/routes/live.tsx`, `apps/desktop/src/components/session/**` (`Viewport.tsx`, `Thinking.tsx`, `Attention.tsx`, `Signals.tsx`)
**Do:** The instrument.

- **Top, split 50/50: the desk camera and the screen**, both live, each labelled with its source and
  its timestamp. The camera pane carries the flagged-region overlay when the reading has a bbox. A
  missing screen grant leaves a labelled empty pane, never a stale image.
- **What it is thinking:** the newest assessment — on/off goal, activity, two or three evidence lines,
  a thin confidence meter, and the tier with its reason in one sentence (“quiet — nothing to
  interrupt”, “nudged — 40 s off”, “spoke — the nudge was ignored”). Under it:
  `watched 12:04 · 3 frames read · 1 interruption`.
- **The ribbon:** every observation a tick, tiers as marks, break marks, hover for the reason.
- **Where the time went:** a stacked bar of the session by app, each segment flagged on or off the
  goal with blocked apps hatched, beside ranked top apps and sites with seconds, and context switches
  per minute as a sparkline.
- **Interruptions:** the cards with their outcome — nudged · resolved · ignored · spoke · pointed.
- **Signals**, collapsed: the last 20 raw signals in mono, one click for the sceptic.
- SSE-driven, 1 s clock, and the only pulsing thing remains `LiveDot`. If the emitted `observation`
  lacks a field the thinking card needs (evidence, confidence, tier), that is a contracts commit first
  — never a hand-written duplicate on the desktop.
  **Done when:** with a live session both panes update, the thinking card matches the newest observation,
  the bar reflects the window, and every element is legible from three metres.

### HELI-075 · feat(desktop): the focused element, and a consent screen that matches reality

**Depends:** 033, 046 **Parallel-safe:** yes, after 046 **Owner:** 3 · desktop + web
**Touches:** `apps/desktop/src-tauri/src/signals/ax.rs`, `apps/desktop/src-tauri/src/signals/mod.rs`, `apps/desktop/src/lib/native.ts`, `apps/desktop/src/components/setup/**` (the consent rows only)
**Do:** Accessibility is on the consent list but nothing uses it. Use it. Add `focus.element` as a
signal: the focused element’s **role and accessible title** from `AXUIElement` (“text field, Search”,
“button, Post”). Never the element’s value or content — no text field contents, ever. Then make the
consent screen one-to-one with the code: every row on that screen is a signal a module actually
emits, with its live value, and nothing else is listed.
**Done when:** focusing a text field emits `focus.element` with role and title and no content; a code
review of `ax.rs` shows no value read; the consent rows and the signal modules match one for one.

### HELI-076 · chore(desktop): preflight and demo reset

**Depends:** 046 **Parallel-safe:** yes, after 046 **Owner:** 3 · desktop + web
**Touches:** `apps/desktop/src/lib/preflight.ts`, `apps/desktop/src/routes/settings.tsx`, `apps/desktop/src/app.tsx` (the `heli://` handler)
**Do:** **Preflight**, a checklist that is green before the room: the server answers, the database is
seeded, the desk is registered, the rig’s camera and arm answer, the model is warm, and the grants
are held. It reports each as a line with the command that fixes it, and it is the night-before run
order. **Reset demo** returns the app to a startable state in one click: clear the local desk and
goal, close the open session, re-arm the mock scenario. **`heli://demo?scenario=drifting`** starts a
scenario for a shortcut.
**Done when:** a fresh machine reaches an all-green preflight from the checklist alone; reset returns
to a startable state in one click; the deep link starts the scenario it names.

---

## What P6 now carries

`062` (the run of show) is extended to the new beats — the sentence drafted, the watch proved live,
the aim, the drift, the nudge, the ignored nudge, the spoken line, the arm pointing at the page, the
recovery, the summary — with a fallback line for each. `063` (projector pass) gains **presentation
mode**: a density for the live monitor that is legible from three metres, landing after `074`.

`073` is the delivery row: until it lands, everything the loop decides is recorded as undelivered.
`047` and `048` belong to P4 and are on `main` now; this phase starts at `071`.
