# Contracts

Everything that crosses a process boundary is defined once, in `packages/contracts`, as a zod
schema. TypeScript types are inferred from it, and JSON Schema is emitted from it for the Python
edge agent. Nothing hand-written on either side.

If you need a field that is not here, that is a commit against this package, merged first.

---

## 1. The one row that matters

Every screen is a query over `observation`.

```prisma
model Observation {
  id          String   @id @default(cuid())
  sessionId   String
  session     Session  @relation(fields: [sessionId], references: [id])
  ts          DateTime @default(now())

  signals     Json              // the folded window this was assessed from, see SignalWindow
  assessment  Json?             // see Assessment. null when the model was unreachable
  survey      Json?             // see ClutterReading. the desk sweep's reading, or null
  tier        Int               // 0..5, the intervention that fired
  action      Json?             // see Intervention. null for tier 0
  outcome     String?           // resolved | ignored | reverted | unknown
  confidence  Float?
  reason      String?           // machine readable, why this tier

  latencyMs   Int?
  @@index([sessionId, ts])
}
```

`tier == 0` is the common case and is not a failure. Most windows are silent.

A survey row is an observation too, and it says so by its columns: it carries `assessment: null`
and its `survey` reading, so a sweep of the desk is kept without pretending the person was off
task. A drift row is the other way round — `survey: null`.

**It is not a window.** A survey row carries the folded window it was taken on, so any read that
folds observations into per-minute metrics — the analytics aggregates, the phone's timeline, the
history ribbon — must exclude it or it counts that window's seconds twice and, having no
`assessment`, breaks a focus run. In Prisma that is `survey: { equals: Prisma.AnyNull }`: the column
is nullable JSON, where a bare `null` is ambiguous (JSON null or SQL NULL) and Prisma refuses it in a
filter, so `AnyNull` — "this column is empty" — is the only form that says what it means.

---

## 2. Signals

```ts
export const SignalSource = z.enum(['desk', 'screen', 'app', 'window', 'input', 'idle', 'system'])
export const SignalKind = z.string() // open vocabulary: app.focus, window.title, input.rate, idle.start, ...

export const Signal = z.object({
  source: SignalSource,
  kind: SignalKind,
  ts: z.string(),                       // ISO
  confidence: z.number().min(0).max(1).default(1),
  payload: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
})
export const SignalBatch = z.object({
  deviceId: z.string(),
  sessionId: z.string().nullable(),
  signals: z.array(Signal).max(500),
})
```

### The derived window

`SignalWindow` is what the model actually sees. Computed on the server, never sent by a client.

```ts
export const SignalWindow = z.object({
  from: z.string(), to: z.string(), windowMs: z.number().int(),
  focusedSeconds: z.number().nonnegative(),
  offTaskSeconds: z.number().nonnegative(),
  idleSeconds: z.number().nonnegative(),
  contextSwitches: z.number().int().nonnegative(),
  longestFocusRunSeconds: z.number().nonnegative(),
  inputRate: z.number().nonnegative(),        // events per 30 s, no content ever
  onTaskRatio: z.number().min(0).max(1),
  topApps: z.array(z.object({ app: z.string(), seconds: z.number().nonnegative(), onTask: z.boolean() })).max(8),
  topSites: z.array(z.object({ title: z.string(), seconds: z.number().nonnegative(), onTask: z.boolean() })).max(8),
  focusMode: z.boolean(),
  lastFrameRef: z.string().nullable(),
  lastScreenRef: z.string().nullable(),
})
```

---

## 3. Goal

```ts
export const GoalKind = z.enum(['study', 'work', 'life'])
export const Permission = z.enum(['nudge', 'speak', 'automate'])
export const Automation = z.enum([
  'pause_notifications', 'open_app', 'navigate_tab', 'mute_site', 'start_break', 'start_timer',
])

export const Goal = z.object({
  id: z.string(),
  kind: GoalKind,
  objective: z.string().min(1).max(280),      // in the user's own words
  successCriteria: z.string().max(280).nullable(),
  timeBudgetMinutes: z.number().int().positive().nullable(),
  breakPolicy: z.enum(['none', 'pomodoro_25_5', 'pomodoro_50_10', 'custom']).default('none'),
  allowedApps: z.array(z.string()).default([]),
  blockedApps: z.array(z.string()).default([]),
  allowedSites: z.array(z.string()).default([]),
  blockedSites: z.array(z.string()).default([]),
  permissions: z.array(Permission).default(['nudge', 'speak']),
  automations: z.array(Automation).default([]),
  policy: Policy,
  active: z.boolean().default(true),
  createdAt: z.string(),
})
```

---

## 4. Assessment (the model's outputs)

```ts
export const ActivityKind = z.string() // open vocabulary: working, reading, phone, away, talking, ...

export const Assessment = z.object({
  onTask: z.boolean(),
  activity: ActivityKind,
  kind: z.string().nullable(),                // the distraction kind, e.g. social, video, game
  driftSeconds: z.number().int().nonnegative(),
  evidence: z.array(z.string().max(140)).max(5), // the signal facts it used, for the console
  confidence: z.number().min(0).max(1),
  because: z.string().max(200),               // one tutor-facing line, NEVER spoken
})
```

`because` is for the console. It is never spoken and never shown as an action. The policy writes
what is shown.

### The survey reading — the model's second output

The assessment answers "is this person on task?" every window. A **survey** answers "how cluttered is
the desk?" rarely, once per sweep of the desk, from two to four frames taken one after another across
it. Same rules: a schema, a console line that is never spoken, and no free text for the person.

```ts
export const ClutterLabel = z.enum([
  'papers', 'cups', 'dishes', 'food', 'cables', 'clothes', 'tools', 'boxes', 'bottles', 'other',
])

export const ClutterReading = z.object({
  score: z.number().min(0).max(1),              // 0 is a clear surface with room to work
  hotspots: z.array(z.object({
    poseIndex: z.number().int().nonnegative(),  // which frame of the sweep saw it
    label: ClutterLabel,
    severity: z.number().min(0).max(1),
    at: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
  }).strict()).max(3),
  evidence: z.array(z.string().max(140)).max(5),
  confidence: z.number().min(0).max(1),
  because: z.string().max(200),                 // one tutor-facing line, NEVER spoken
})
```

It rides on the observation row (`survey`), and the policy — not the model — decides whether it
becomes a line, exactly as it does for a drift assessment.

---

## 5. Policy and intervention

```ts
export const DEFAULT_POLICY = z.object({
  windowMs: z.number().int().default(60_000),
  assessEveryMs: z.number().int().default(10_000),
  minConfidence: z.number().min(0).max(1).default(0.7),
  driftSeconds: z.number().int().default(30),
  consecutiveOffGoal: z.number().int().default(2),
  nudgeGapMs: z.number().int().default(180_000),
  minGapMs: z.number().int().default(90_000),
  maxTier: z.number().int().min(0).max(5).default(2),
  resolveWindowMs: z.number().int().default(120_000),
  revertWindowMs: z.number().int().default(60_000),
  maxAutomationsPerSession: z.number().int().default(6),
  surveyFloorMs: z.number().int().default(1_200_000),        // how often a sweep is worth taking
  surveyGapMs: z.number().int().default(300_000),            // and how close two sweeps may be
  clutterSpeakScore: z.number().min(0).max(1).default(0.6),  // above this, a desk line is earned
  clutterRiseDelta: z.number().min(0).max(1).default(0.25),  // and only when it got worse
  clutterGapMs: z.number().int().default(2_700_000),         // at most one desk line per 45 min
})

export const Tier = z.number().int().min(0).max(5)
export const Outcome = z.enum(['resolved', 'ignored', 'reverted', 'unknown'])

export const Intervention = z.object({
  tier: Tier,
  channel: z.enum(['log', 'ambient', 'notification', 'speech', 'automation', 'summary']),
  message: z.string().max(220).nullable(),      // what is shown or spoken, from the policy
  action: Automation.nullable(),
  reversible: z.boolean(),
  reason: z.string(),                           // machine readable, mirrors Observation.reason
  point: z.object({ x: z.number(), y: z.number() }).strict().nullable().optional(),
  // desk millimetres to point at when the line comes with a gesture (`arm.point`), absent on every
  // line that has none: a clutter line on a calibrated desk points at the pile it is talking about
})
```

---

## 6. Device socket — RETIRED

> There is no Pi. Desk capture and arm control live in `docs/03-desk-capture.md`, and the actions
> travel over the **desktop** socket (`ApiToDesktop`). This section is kept only so the retired
> shapes are not lost.

### (retired) `wss://api/ws/device`, protocol `heli.v1`

Binary frames are **tagged** (`0x01` video JPEG, `0x02` audio PCM S16LE, `0x03` reserved).
Everything else is JSON. The device authenticates with a pairing code in
`Sec-WebSocket-Protocol: heli.v1, <code>`.

### device → api
`hello` `{ deviceId, agentVersion, caps }` · `session.open` `{ goalId? }` ·
`frame` `{ seq, ts, trigger }` then the raw JPEG · `media.start` `{ video, audio }` ·
`media.stop` `{ reason }` · `media.state` `{ state }` · `state` `{ state }` ·
`telemetry` `{ cpu, tempC, rssi, uptimeS, fps, bytesSent }` ·
`command.ack` `{ commandId, status, result? }` · `bargein` `{ ts }` · `session.close` `{ reason }`

### api → device
`session.start` `{ sessionId, goal, policy }` · `audio.out` `{ format, sampleRate, channels,
durationMs, momentId }` then tagged audio · `command` `{ id, type, issuedAt, payload }` ·
`policy.update` `Policy` · `error` `{ code, message, ref? }` · `session.stop` `{ reason }`

Command types: `capture`, `stream.start`, `stream.stop`, `camera.set`, `camera.ptz`, `led.set`,
`shutter.set`, `speak`, `identify`. See `docs/03-device-contract.md`.

---

## 7. REST + SSE

Base `/v1`, bearer JWT.

| method | path | returns |
|---|---|---|
| `POST` | `/auth/dev-login` | `{ token, user }` — seeded user only |
| `POST` | `/devices/pair` | `{ device, deviceToken }` — idempotent |
| `GET` | `/devices` | `Device[]` with `lastSeenAt`, `caps` |
| `POST` | `/devices/:id/rotate-code` | a fresh pairing code |
| `POST` | `/signals` | `SignalBatch` accepted |
| `GET` | `/sessions/:id/window` | the latest `SignalWindow` |
| `POST` | `/goals` · `GET` · `PUT` · `DELETE` | `Goal` |
| `GET` | `/sessions` · `/sessions/:id` | summary · session with observations and interventions |
| `POST` | `/sessions/:id/session`? | — |
| `GET` | `/analytics/summary` · `/tiers` · `/apps` · `/heatmap` | see below |
| `GET` | `/live/:sessionId` | **SSE**: `observation`, `intervention`, `signal.window`, `state` |
| `POST` | `/sessions/:id/speak` | a manual line, still passing the policy |
| `GET` | `/sessions/:id/media-token` · `/video.mjpg` · `/media-state` | the media path |
| `POST` | `/sessions/:id/sample` | force one sample through the loop |
| `POST` | `/desks/:id/survey` | a sweep of the desk now: `DeskSurveyResponse`. The rest of the desk routes are in `docs/03-desk-capture.md` |

Analytics shapes: `summary { focusedMinutes, offTaskMinutes, interventions, longestFocusRunSeconds,
tierHistogram }` · `tiers { tier, outcome, count }[]` · `apps { app, seconds, onTask }[]` ·
`heatmap { hour, onTaskRatio }[]`.

---

## 8. What a desktop client may write

Signals, and its own playback state. It never writes an assessment or an intervention; those are
the server's. A mutating endpoint that changes the goal or the policy is the user's, from the
desktop, and is the only other write.

### The desktop socket — `wss://api/ws/desktop`, protocol `heli.v1`

The same signals travel over two transports, because the desktop is sometimes offline and sometimes
online: `POST /v1/signals` for a batch, and this socket for live ones. That is why the socket's
signal message is `SignalBatch` verbatim rather than a shape of its own — one payload, one code path
on the server, and the two cannot drift.

`DesktopToApi` — what the desktop sends:

```
hello     { appVersion, deviceId, sessionId }   // deviceId/sessionId nullable; binds the socket
signals   SignalBatch                           // identical to the POST /v1/signals body
playback  { playing, momentId }                 // its own playback state, nothing else
```

`ApiToDesktop` — what the server sends back:

```
ack       { accepted }                          // how many signals of the batch landed
error     { code, message, ref? }                // same shape the device gets
```

Anything else the desktop needs to *see* — observations, interventions, windows — arrives on the
SSE channel (`GET /v1/live/:sessionId`), not here. This socket is a way in, not a way out.
