# P1 · Server core

**Goal:** the server can hold a session with a device **and** a desktop, ingest both signal
streams, persist observations, serve them over SSE, and answer analytics — with **no model call
yet**. When P1 is done, the mock desktop can set a goal, the mock desk can push frames, both flow
into one session, and the web/desktop can watch it live.

**Depends:** all of P0.
**Parallelism:** `010` first (it creates the server). Then `011–018` are disjoint files and run in
parallel. **Owner 2 · server** takes this phase end to end.

---

### HELI-010 · feat(server): fastify server and plugin layout
**Depends:** P0 **Parallel-safe:** no, blocks P1 **Owner:** —
**Touches:** `apps/server/src/index.ts`, `apps/server/src/server.ts`, `apps/server/src/logger.ts`, `apps/server/src/types/fastify.d.ts`, `apps/server/src/plugins/**`, `apps/server/package.json`, `apps/server/tsconfig.json`
**Do:** Fastify 5 with `@fastify/websocket`, `@fastify/cors`, `@fastify/sensible` and pino. A zod
type provider so route schemas come from `@heli/contracts` and a request id is attached to every
log and error. Errors are JSON `{ error, issues? }` — never a stack trace in the response. Health
at `/healthz`. Route files are registered by folder so every later commit adds a file and touches
nothing shared.
**Done when:** `curl localhost:3001/healthz` returns `{"ok":true}` and `pnpm --filter @heli/server dev`
hot-reloads.

### HELI-011 · feat(server): auth and pairing
**Depends:** 010 **Parallel-safe:** yes **Owner:** —
**Touches:** `apps/server/src/routes/auth.ts`, `apps/server/src/routes/devices.ts`, `apps/server/src/lib/jwt.ts`
**Do:** `POST /v1/auth/dev-login` returns a JWT for the seeded user (hackathon auth — a real
provider is out of scope and will be reverted). `POST /v1/devices/pair` takes the device code,
binds it to the user, returns a long-lived device token, and is **idempotent**. `GET /v1/devices`
lists with `lastSeenAt` and caps. `POST /v1/devices/:id/rotate-code` invalidates the old code. A
`requireUser` decorator for the browser routes and a `requireDevice` for the socket.
**Done when:** pairing with `HELI-DEMO` twice returns the same device, an unknown code returns 404,
and a rotated code rejects the old one.

### HELI-012 · feat(server): device websocket and signal intake
**Depends:** 010 **Parallel-safe:** yes **Owner:** —
**Touches:** `apps/server/src/ws/device.ts`, `apps/server/src/ws/registry.ts`
**Do:** `/ws/device`. Validate the pairing token from `Sec-WebSocket-Protocol` (`heli.v1, <token>`).
Parse every text message through the `DeviceToApi` union and reject unknown shapes loudly, replying
`{ t:'error', code }` instead of closing silently. Accept **tagged binary** after a `media.start`:
`0x01` video JPEG, `0x02` audio PCM S16LE. Keep an in-memory registry `deviceId → socket` plus caps
so other modules can push. Heartbeat every 20 s, drop at 60 s, and on close mark the device idle and
**end its media session**.
**Done when:** `wscat` with a valid token gets a `hello` ack; a bad token gets 401 and closes; an
unknown text frame returns an `error` with a code; a binary frame without `media.start` is refused.

### HELI-013 · feat(server): goal and session lifecycle
**Depends:** 010 **Parallel-safe:** yes **Owner:** —
**Touches:** `apps/server/src/routes/goals.ts`, `apps/server/src/routes/sessions.ts`, `apps/server/src/services/goal.ts`, `apps/server/src/services/session.ts`
**Do:** `POST /v1/goals` (objective, success criteria, allowed/blocked apps and sites, time budget,
break policy, permissions), `GET /v1/goals`, `PUT /v1/goals/:id`, `DELETE /v1/goals/:id`. Sessions:
`openSession(goalId, deviceId)` creates the row and returns `session.start` with the goal and the
policy; `closeSession` stamps `endedAt` and computes the roll-up (duration, signals, observations,
interventions, tier histogram). `GET /v1/sessions` and `GET /v1/sessions/:id` with observations and
interventions.
**Done when:** open → close leaves one session with a correct `durationMs`, the roll-up counts match
the rows, and deleting a goal with sessions is refused with a clear error.

### HELI-014 · feat(server): media intake and object store
**Depends:** 010 **Parallel-safe:** yes **Owner:** —
**Touches:** `apps/server/src/services/frames.ts`, `apps/server/src/lib/storage.ts`, `apps/server/src/media/hub.ts`
**Do:** Validate incoming JPEG frames with a real marker walk (bounds and pixel size), cap at 2 MB
and 1600 px, write to S3-compatible storage (MinIO in compose) or an in-memory store when no bucket
is set, and mirror the **latest frame** so a still is always resolvable. A small in-process hub fans
video frames and audio chunks out to subscribers keyed by session with **bounded buffers** (drop the
oldest video for a slow subscriber, never block the device). Audio chunks: compute duration and RMS,
keep only a bounded ring, never persist raw audio.
**Done when:** pushing 3 frames creates 3 stored frames, the latest is retrievable, and a slow
subscriber does not stall the sender.

### HELI-015 · feat(server): desktop signal ingestion
**Depends:** 010 **Parallel-safe:** yes **Owner:** —
**Touches:** `apps/server/src/routes/signals.ts`, `apps/server/src/ws/desktop.ts`, `apps/server/src/services/signals.ts`
**Do:** Both transports for the desktop, because the desktop may be offline or online:
`POST /v1/signals` for batched signals and `/ws/desktop` for live ones. Validate through the
`DesktopToApi` union. Fold signals into a **per-session rolling window** (default 60 s) with derived
metrics: time per app, context switches per minute, off-task seconds, idle seconds, longest focus
run, top distracting app, break compliance. Store raw signals bounded (keep counts and titles, drop
bodies) and expose the derived window at `GET /v1/sessions/:id/window`.
**Done when:** posting a batch produces a window with non-zero derived metrics, and a live socket
signal updates the same window within a second.

### HELI-016 · feat(server): SSE live channel
**Depends:** 010 **Parallel-safe:** yes **Owner:** —
**Touches:** `apps/server/src/routes/live.ts`, `apps/server/src/lib/bus.ts`
**Do:** An in-process event bus. `GET /v1/live/:sessionId` streams `observation`, `intervention`,
`signal.window` and `state` events. A comment heartbeat every 15 s so proxies do not kill it, and
replay of the last 20 observations on connect so a late-joining window is not empty.
**Done when:** two clients on the same session both receive an event published from a test route,
and a client opened after 5 observations immediately shows all 5.

### HELI-017 · feat(server): mock device and mock desktop
**Depends:** 012, 015 **Parallel-safe:** yes **Owner:** —
**Touches:** `apps/server/src/dev/mock-device.ts`, `apps/server/src/dev/mock-desktop.ts`, `apps/server/fixtures/**`
**Do:** `pnpm --filter @heli/server dev:mock` runs both fakes. The mock device connects, opens a
session and streams four real notebook frames plus a spoken line. The mock desktop replays a
plausible work pattern — 6 minutes in the editor, then a tab switch to a distracting site for 40 s,
then back — as real signals at real timings. This is how desktop and web develop with no hardware
and no permissions, and how the demo survives a dead rig.
**Done when:** with no hardware and no macOS permissions, a session fills with signals, a window,
observations and one intervention.
**Notes:** export a `--scenario` flag (`focused`, `drifting`, `phone`) so the demo can be scripted.

### HELI-018 · feat(server): analytics queries
**Depends:** 013 **Parallel-safe:** yes **Owner:** —
**Touches:** `apps/server/src/routes/analytics.ts`, `apps/server/src/services/analytics.ts`
**Do:** `GET /v1/analytics/summary?from=&to=` (focused minutes, off-task minutes, interventions,
tier histogram, longest focus run), `GET /v1/analytics/tiers` (`GROUP BY tier, outcome` — what
actually gets the person back on task), `GET /v1/analytics/apps` (time per app, ranked),
`GET /v1/analytics/heatmap` (focus by hour of day). Every query is over `Observation` and
`Intervention`.
**Done when:** with the seeded session the summary returns non-zero values in the right order, and
`tiers` returns a row per fired tier with an outcome count.

---

## Exit criteria

- The mock desktop sets a goal; the mock desk and the mock desktop both flow into one session
- Every signal becomes part of a rolling window with derived metrics
- A live SSE subscriber sees observations, interventions and window updates arrive
- **No model provider has been called yet** — that is P2
