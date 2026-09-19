# P8 · The phone

**Goal:** the surface the person takes with them. The desk watches where they sit; the phone
watches what they carry, and — the point of it — the loop can follow them off the desk with the same
nudge and the same spoken line the desktop and the rig already carry.

**The honest platform split** (this is the specification, not a limitation to fix later):

| | Android | iOS |
|---|---|---|
| our own app state, screen on/off | yes | yes |
| motion: still / walking | yes | yes |
| **other apps' time, unlocks** | **yes** (usage access) | **no** — Screen Time is entitlement-gated |
| nudge + spoken line + response | yes | yes |

An iPhone is therefore a surface and a motion sensor, never a screen-time sensor, and the app says
so on its own screen. The server's `PhoneSnapshot` carries what actually arrived, so a gap is never
read as a quiet person.

**Pairing is desktop → phone.** The Mac shows a six-digit code; the phone redeems it for a
long-lived `typ: mobile` token. The code is single-use, five minutes, in memory only. Re-pairing
rotates the token; there is no account.

**Where a line goes** is a routing question, not a policy one: the policy still decides the tier.
Speech follows the person — the phone's motion is the only evidence that the desk was left — and a
nudge prefers the phone because it is with them either way. An away phone that cannot carry audio
refuses rather than speaking to an empty chair.

---

### HELI-080 · feat(contracts): the phone
**Depends:** 004 **Parallel-safe:** yes **Owner:** 1 · the loop
**Touches:** `packages/contracts/src/mobile.ts`, `packages/contracts/src/signal.ts`, `packages/contracts/src/index.ts`, `packages/contracts/scripts/emit-json-schema.ts`
**Do:** Pairing (`MobilePairCodeResponse`, `MobilePairRequest`, `MobilePairResponse`), the socket
(`MobileToApi`, `ApiToMobile` — the same `nudge` and `audio.out` members the desktop receives), the
signal vocabulary (`PHONE_SIGNAL`: app, usage, unlock, motion, state, nudge response) and
`PhoneSnapshot`. `SignalSource` gains `phone`. Schemas emit to `dist/json-schema.json`.
**Done when:** the contracts build and the mobile schemas emit.

### HELI-081 · feat(server): the phone pairs, connects and is watched
**Depends:** 080, 044 **Parallel-safe:** no **Owner:** 1 · the loop
**Touches:** `apps/server/src/services/mobile.ts`, `apps/server/src/ws/mobile.ts`, `apps/server/src/ws/live-mobile.ts`, `apps/server/src/routes/mobile.ts`, `apps/server/src/lib/jwt.ts`, `apps/server/src/index.ts`
**Do:** `POST /v1/mobile/pair/code` (user token) issues a six-digit code; `POST /v1/mobile/pair`
redeems it for a `typ: mobile` token. `/ws/mobile` authenticates with it, accepts `hello`,
`signals` and `playback`, answers `ack`, and refuses binary. `POST /v1/mobile/signals` is the same
batch over HTTP for a socket that was down. The registry is keyed by session, mirroring
`live-desktop.ts`, and the phone is never told which session to trust — the server resolves the
open one, exactly as it does for the rig's frames.
**Done when:** pair → socket → signals lands, and `GET /v1/mobile/phones` shows the snapshot.

### HELI-082 · feat(server): speech follows the person
**Depends:** 081 **Parallel-safe:** no **Owner:** 1 · the loop
**Touches:** `apps/server/src/observe/outbound.ts`, `apps/server/src/observe/runtime.ts`, `apps/server/src/index.ts`
**Do:** `createDeskSenders` takes a phone lookup and an `away` predicate. Speech routes to the phone
when away, otherwise the desk first; a nudge prefers the phone; both fall back. `away` is
`phoneAway(sessionId)` — fresh motion that says walking, never a stale unknown.
**Done when:** the routing tests pass and an away phone that cannot carry audio refuses.

### HELI-083 · feat(mobile): the Android app
**Depends:** 080–082 **Parallel-safe:** yes **Owner:** 1 · the loop, verified by 4
**Touches:** `apps/mobile/**`
**Do:** Expo SDK 54, expo-router, styles straight from `@heli/tokens` (no nativewind). Pairing screen
with the server URL and the code; a live screen that says what is being reported, shows the last
nudge with its actions, and reports playback. Signals: app state, accelerometer motion, and — on
Android, through the local `modules/usage-stats` Kotlin module — foreground app, per-app seconds and
unlock counts. Nudges arrive as a native notification; the spoken line is `audio.out` + tagged PCM
written to a WAV in the cache and played, then acknowledged with a `playback` frame so barge-in is
visible to the server.
**Done when:** the app typechecks and a development build on the Android phone pairs, reports usage,
and speaks.

### HELI-084 · feat(desktop): the pairing code in setup
**Depends:** 046, 081 **Parallel-safe:** yes **Owner:** 3 · desktop + web
**Touches:** `apps/desktop/src/routes/setup.tsx`, `apps/desktop/src/components/setup/**`, `apps/desktop/src/lib/api.ts`
**Do:** The setup journey gains the phone step: ask for a code, show it large, and list paired
phones (`GET /v1/mobile/phones`) with their last-seen and what each reports. This is the other half
of HELI-081; until it lands the code is fetched by hand.
**Done when:** a person pairs a phone from the desktop's setup screen without a terminal.

### HELI-085 · test(mobile): the device pass
**Depends:** 083, 084 **Parallel-safe:** no **Owner:** 4 · hardware + rig
**Touches:** — (no code)
**Do:** Build a development client on the Android phone (`pnpm --filter @heli/mobile exec expo run:android`),
grant usage access, and walk the loop: pair, see app time and unlocks arrive, walk away with the
phone, hear the line from the phone, press a nudge action, and see the response signal land.
**Done when:** one full pass, on the phone, with the server's logs as the receipt.
