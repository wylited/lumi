# P3 · Desktop — the base app

**Goal:** the app a person actually opens. It holds the goal, shows the live session, plays the
audio, sends notifications, and reads the machine through macOS. This is the base experience; the
web and the phone review it afterwards.

**Depends:** P0 (and P1/018 for history). Builds against `dev:mock` — no hardware, no permissions
needed for the UI.
**Parallelism:** `030` first. Then `031–038` are separate route/component folders and signal
modules; all parallel. **Owner C** takes this phase.

> **Consent is the risk.** Accessibility, Screen Recording and Input Monitoring each prompt
> separately, and a prompt missed on the demo machine kills the demo. `033` ships a preflight screen
> that reports each permission's state with the exact place to grant it.

---

### HELI-030 · feat(desktop): tauri shell and layout
**Depends:** P0 **Parallel-safe:** no, blocks P3 **Owner:** C
**Touches:** `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/vite.config.ts`, `apps/desktop/index.html`, `apps/desktop/src/main.tsx`, `apps/desktop/src/app.tsx`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/build.rs`, `apps/desktop/src-tauri/src/main.rs`
**Do:** Tauri 2 with a React + Vite webview. Tailwind v4 using `@heli/tokens`. A single-column
shell with a left rail: **Goal · Live · History · Settings**. A menubar/tray item whose icon colour
reflects state (idle, watching, off-task, speaking). The window is a real app: no browser chrome,
system light and dark, and a global shortcut to raise it. Register the sidecar command surface in
`main.rs` so `033` adds modules rather than rewriting it.
**Done when:** `pnpm --filter @heli/desktop dev` opens a window that renders the shell, the tray
icon appears, and `pnpm --filter @heli/desktop tauri build` produces an app bundle.

### HELI-031 · feat(desktop): goal editor
**Depends:** 030 **Parallel-safe:** yes **Owner:** C
**Touches:** `apps/desktop/src/routes/goal.tsx`, `apps/desktop/src/components/goal/**`, `apps/desktop/src/lib/goals.ts`
**Do:** Create and edit a goal: a free-text objective, the success criteria, a time budget, the
break policy, the **allowed and blocked apps and sites**, and the permissions the goal grants the
policy (may it nudge, may it speak, may it automate). The "intelligent" part: an assistant field
that turns a sentence ("finish the algorithms problem set by 9") into a structured goal the user
can edit before saving — suggest, never silently overwrite. Show what the goal will let the system
do, in plain words.
**Done when:** a typed sentence becomes a structured goal, the user can edit every field, saving
persists through `POST/PUT /v1/goals`, and reloading shows the saved goal.

### HELI-032 · feat(desktop): live session view
**Depends:** 030, 007 **Parallel-safe:** yes **Owner:** C
**Touches:** `apps/desktop/src/routes/live.tsx`, `apps/desktop/src/components/session/**`, `apps/desktop/src/lib/live.ts`
**Do:** The screen the user leaves open: the goal and the time budget at the top, the current
assessment in one line, the derived metrics (focused minutes, off-task, context switches, longest
focus), a live sparkline of on-task percentage, the signal window, and a timeline of interventions
with their tier badges. Subscribes to SSE. Shows silence as a positive state, not an empty panel.
**Done when:** with `dev:mock` drifting, the view updates live, the sparkline moves, and an
intervention appears with its tier and outcome — with no hardware connected.

### HELI-033 · feat(desktop): native signals sidecar
**Depends:** 030 **Parallel-safe:** no, blocks 034–036 **Owner:** C
**Touches:** `apps/desktop/src-tauri/src/signals/mod.rs`, `apps/desktop/src-tauri/src/signals/permissions.rs`, `apps/desktop/src/lib/native.ts`, `apps/desktop/src/routes/settings.tsx`
**Do:** The sidecar skeleton: a sampling loop that emits a `SignalBatch` on a channel, a
`permissions()` command that reports the real state of Accessibility, Screen Recording, Input
Monitoring and Focus access with the deep link to each settings pane, and a settings route that
shows them and re-checks on demand. All sampling is **read-only** and consent-gated: a signal whose
permission is missing is simply absent, and the UI says which one.
**Done when:** each permission shows granted or missing, toggling it in System Settings and hitting
re-check updates the state, and the app runs with every permission denied (signals just empty).

### HELI-034 · feat(desktop): app and window signal
**Depends:** 033 **Parallel-safe:** yes **Owner:** C
**Touches:** `apps/desktop/src-tauri/src/signals/apps.rs`
**Do:** `NSWorkspace.frontmostApplication` for the active app (bundle id, name, pid) and
`CGWindowListCopyWindowInfo` for the frontmost window title and owner. Emit on change, never on a
timer alone, and additionally emit a low-rate heartbeat so a long single-app stretch is still
visible. For browsers, parse the window title to a best-effort site (`"GitHub — Chrome"`), and mark
it as low confidence — a title is not a URL.
**Done when:** switching apps emits a signal within a second with the right bundle id and title,
and the mock desktop's distracting app shows up as off-task.

### HELI-035 · feat(desktop): input and idle signal
**Depends:** 033 **Parallel-safe:** yes **Owner:** C
**Touches:** `apps/desktop/src-tauri/src/signals/input.rs`
**Do:** `CGEventSourceSecondsSinceLastEventType` for idle, and a `CGEventTap` that counts and times
keystrokes and clicks **without recording any key codes or content** — emit a rate (events per 30 s)
and a burst flag only. Detect active typing, a burst, a pause, and a long idle. This is the signal
that separates "reading a page" from "gone for coffee".
**Done when:** typing raises the rate within one window, 30 s of stillness lowers it, and a code
review of the module shows no key code, character or text is captured anywhere.

### HELI-036 · feat(desktop): screen capture signal
**Depends:** 033 **Parallel-safe:** yes **Owner** C
**Touches:** `apps/desktop/src-tauri/src/signals/screen.rs`
**Do:** `ScreenCaptureKit` at most one frame per 10 s, only when the frontmost app **changed** or
the on-screen content changed beyond a threshold, downscaled to 1280 px long edge and JPEG q80
before it leaves the process. Never capture when the permission is missing and never capture a
known password manager or banking app — an allow/deny list the user can edit. Upload through the
same tagged binary path the desk uses, or `POST /v1/signals/screen`.
**Done when:** a static screen produces far fewer frames than a changing one, a denied permission
produces zero frames with no error spam, and an app on the deny list is never captured.

### HELI-037 · feat(desktop): notifications and audio
**Depends:** 030 **Parallel-safe:** yes **Owner:** C
**Touches:** `apps/desktop/src/lib/notify.ts`, `apps/desktop/src/lib/audio.ts`, `apps/desktop/src/components/notification/**`
**Do:** Tier-2 nudges as a native notification **with an action** ("Back to the goal" and "Snooze
10m"), never a bare toast. Tier-3 speech as audio playback with a mute and a **stop** that reports
barge-in to the server. Respect Focus / Do Not Disturb: at tier 1 log and turn the tray amber
instead of notifying, and never fire a nudge while the user is in a focus run they started. Play
audio through the same `PcmPlayer` shape the web uses, resumed on first gesture.
**Done when:** a nudge appears with both actions, snooze suppresses the next nudge for the window,
speech plays and can be stopped, and DND downgrades tier 2 to tier 1 in the log.

### HELI-038 · feat(desktop): history and analytics
**Depends:** 030, P1/018 **Parallel-safe:** yes **Owner:** C
**Touches:** `apps/desktop/src/routes/history.tsx`, `apps/desktop/src/components/history/**`, `apps/desktop/src/lib/analytics.ts`
**Do:** Per-session and per-day review drawn from `/v1/analytics/*`: focused vs off-task over time,
what actually got the user back on task (`tier + outcome`), the top distractions, and a heatmap of
focus by hour. A session detail that replays the observation timeline with the assessment and the
tier. Present the numbers honestly — no praise, no streaks, no confetti.
**Done when:** the seeded history renders non-zero charts, a session detail lists its interventions
with outcomes, and the tier table names the intervention that worked most.

---

## Exit criteria

- The app sets a goal, runs a session live against the mock, nudges, speaks, and summarises
- Every native signal is absent rather than broken when its permission is denied
- The history answers "what actually gets me back on task" from real data
- The tray is the ambient tier and it never nags
