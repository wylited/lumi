# P0 · Foundations

**Goal:** a repo that installs, lints, types and runs on a fresh machine in under five minutes,
with contracts and the design system already real. Nothing product-facing ships here.

**Blocks everything.** Do it the night before, not on the day.
**Parallelism:** `001` first and alone. Then `002–008` all run in parallel.
**Owner:** all four share P0. After `001` merges, take one each.

---

### HELI-001 · chore(repo): workspace skeleton
**Depends:** — **Parallel-safe:** no, blocks all **Owner:** —
**Touches:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.npmrc`, `.nvmrc`
**Do:** pnpm workspaces over `apps/*` and `packages/*`. Turbo pipeline with `build`, `dev`, `lint`,
`typecheck`, `test`. Node 22 pinned in `.nvmrc` and `engines`. Root scripts proxy to turbo. Name is
`helicopter`. Pin `minimumReleaseAge: 0` and `allowBuilds` for prisma/esbuild in
`pnpm-workspace.yaml` (hackathon; note it in the runbook). No apps yet beyond the empty folders.
**Done when:** `pnpm install && pnpm typecheck` exits 0 on a clean clone.
**Notes:** the root config is **already bootstrapped** (apps/packages folders, workspace yaml, turbo,
tsconfig, eslint, prettier, `.nvmrc`, the `@heli/*` scope, and `@heli/tokens`/`@heli/ui` ported).
This commit is **verify and fix**, not from scratch: check the turbo task names are `build/dev/lint/
typecheck/test`, that `turbo run` sees zero tasks without erroring, and that `@heli/tokens` and
`@heli/ui` resolve from a scratch file. Do not rewrite what works.

### HELI-002 · chore(repo): lint and format
**Depends:** 001 **Parallel-safe:** yes **Owner:** —
**Touches:** `eslint.config.mjs`, `.prettierrc`, `.editorconfig`
**Do:** ESLint flat config, TypeScript + import ordering, Prettier 100 cols single quotes. One rule
that matters: **ban raw hex colour literals** via `no-restricted-syntax` in `apps/web`,
`apps/desktop` and `packages/ui`. Ban `console.log` in `apps/server` and `apps/desktop` (logger
only).
**Done when:** `pnpm lint` exits 0, and a file containing `color: '#0FA36B'` in `apps/web` fails it.

### HELI-003 · feat(tokens): design system package
**Depends:** 001 **Parallel-safe:** yes **Owner:** —
**Touches:** `packages/tokens/**`
**Do:** Ship `src/index.ts`, `src/tokens.css` and `src/tailwind.css` (the Tailwind v4 `@theme
inline` mapping). `package.json` exports `.`, `./tokens.css` and `./tailwind.css` under
`@heli/tokens`. Include the role tokens, the type scale, radius, shadow, motion, and the `device`
colour group. The CSS must resolve roles at runtime so a pinned dark surface works.
**Done when:** `import { theme, palette } from '@heli/tokens'` type-checks from a scratch file in
`apps/`, and `pnpm --filter @heli/tokens typecheck` passes.
**Notes:** ported already — this commit is verification plus any fix.

### HELI-004 · feat(contracts): zod schemas
**Depends:** 001 **Parallel-safe:** yes **Owner:** —
**Touches:** `packages/contracts/**`
**Do:** Every shape that crosses a boundary, as zod, exported as inferred types:
`Signal` (source, ts, kind, payload, confidence), `SignalBatch`, `Goal` (objective, success
criteria, allowed/blocked apps and sites, time budget, break policy, permissions),
`Session` (goalId, startedAt, endedAt, roll-ups), `Observation` (sessionId, ts, source, signals,
assessment, confidence), `Assessment` (onTrack, activity, kind, driftSeconds, evidence, confidence),
`Intervention` (tier, channel, message, action, reversible), `Policy` (thresholds, minGapMs,
nudgeGapMs, maxTier, permissions), `Device`, `DeviceCaps`, and the socket unions `DeviceToApi` /
`ApiToDevice` / `DesktopToApi` / `ApiToDesktop` at `heli.v1`. Media tags `0x01` video `0x02` audio.
Provider enums `deepseek | gemini | local` and `local | elevenlabs`.
**Done when:** `pnpm --filter @heli/contracts build` emits `.d.ts` **and** `dist/json-schema.json`.

### HELI-005 · feat(server): prisma schema and seed
**Depends:** 001 **Parallel-safe:** yes **Owner:** —
**Touches:** `apps/server/prisma/schema.prisma`, `apps/server/prisma/seed.ts`, `apps/server/docker-compose.yml`
**Do:** Postgres in compose. Models: `User`, `Device`, `Goal`, `Session`, `Observation`,
`Intervention`, plus `DeviceCommand` and `DeviceTelemetry` for the edge. Seed one user, one device
with code `HELI-DEMO`, one goal, one finished session with ~20 observations and 2 interventions,
so every screen has real data on day one.
**Done when:** `docker compose -f apps/server/docker-compose.yml up -d && pnpm --filter @heli/server db:reset`
leaves a queryable DB, and `SELECT count(*) FROM "Observation" > 0`.

### HELI-006 · chore(repo): env and secrets
**Depends:** 001 **Parallel-safe:** yes **Owner:** —
**Touches:** `.env.example`, `apps/server/src/env.ts`
**Do:** A zod-validated env loader that throws at boot with a readable message naming the missing
key. Keys: `DATABASE_URL`, `JWT_SECRET`, `DEEPSEEK_API_KEY`, `VISION_PROVIDER`, `DEEPSEEK_MODEL`,
`GEMINI_PROJECT`, `GEMINI_LOCATION`, `ELEVENLABS_API_KEY`, `SPEECH_PROVIDER`, `MEDIA_ENABLED`,
`S3_*`. `.env.example` documents each with a comment and a safe default. Nothing is required except
`DATABASE_URL` and `JWT_SECRET`; the model and speech paths must boot keyless.
**Done when:** removing `JWT_SECRET` makes `pnpm --filter @heli/server dev` exit 1 naming it, and a
keyless boot starts with `VISION_PROVIDER=local`.

### HELI-007 · feat(ui): component kit
**Depends:** 001, 003 **Parallel-safe:** yes **Owner:** —
**Touches:** `packages/ui/**`
**Do:** Port the kit and add what this product needs: `Button`, `Input`, `Select`, `Card`, `Pill`,
`Table`, `Stat`, `Sparkline` (inline SVG, no chart library), `Timeline`, `CodeBlock`, `Sheet`,
`Toast`, `EmptyState`, `LiveDot`, `KeyValue`, `TierBadge` (the intervention tiers 0–5 with their
colours). Every one keyboard-accessible with a visible focus ring, both themes, tokens only.
**Done when:** a `/kitchen-sink` route renders every component in every state, light and dark, and
tabbing through shifts nothing.

### HELI-008 · docs(repo): readme and runbook
**Depends:** 001 **Parallel-safe:** yes **Owner:** —
**Touches:** `README.md`, `docs/RUNBOOK.md`
**Do:** Five-minute setup. Every `pnpm` script explained in one line. Runbook: reset the DB, point
the Pi at a laptop, the macOS consent checklist (Accessibility, Screen Recording, Input
Monitoring) with where each prompt appears, what to do when the model rate-limits, where replay
mode lives, and how to rotate a device code.
**Done when:** someone who has never seen the repo gets `pnpm dev` running from the README alone.

### HELI-009 · docs(edge): the device contract
**Depends:** — **Parallel-safe:** yes **Owner:** 4 · hardware
**Touches:** `docs/03-device-contract.md`
**Do:** The single document the hardware person needs, written independently of the rest of the
build: responsibilities, the `heli.v1` handshake and pairing, the full device→api and api→device
message tables with JSON examples, caps, the frame budget, tagged media framing with a worked byte
example, telemetry, the state machine and LED table, the 200 ms shutter promise, backpressure and
offline behaviour, the error codes, and a twelve-point acceptance checklist.
**Done when:** someone can build the Pi agent from this file alone, and the checklist passes against
a running server.
**Notes:** land this **before P4** so the hardware person can start on day one. `040` then
implements against it rather than writing it.

---

## Exit criteria

- `pnpm install && pnpm lint && pnpm typecheck && pnpm build` green from a clean clone
- `@heli/tokens`, `@heli/ui` and `@heli/contracts` importable from anywhere in the workspace
- A seeded Postgres with one user, one device, one goal, one session, observations and interventions
