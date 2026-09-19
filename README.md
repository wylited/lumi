# Helicopter

An observer that helps one person finish what they sat down to do. A camera and mic watch the
desk; a desktop app watches the machine; the server keeps the record and **acts** — an ambient
signal, a nudge, a spoken line, or an automatic change — so the goal you set actually happens.

Built for the "Automate your studies / job / life" brief.

## Start here

| | |
|---|---|
| `AGENTS.md` | read first. Rules, the golden rule, commit format, definition of done. |
| `docs/COMMITS.md` | the ledger. Claim a commit here. |
| `docs/00-architecture.md` | the loop, ownership, signals, budgets |
| `docs/03-device-contract.md` | for the hardware build |

## Run it

```bash
pnpm install
docker compose up -d          # postgres + minio
pnpm --filter server db:reset # schema + seed
pnpm dev                      # server :3001 · web :3000
pnpm --filter server dev:mock # a fake desk and a fake desktop
```

## Layout

```
apps/desktop    the base app. goal, live state, audio, native macOS signals
apps/edge       the Pi. camera, mic, speaker, LED
apps/server     the aggregator. the only component that persists or holds a key
apps/web        analytics dashboard + landing
packages/contracts  zod schemas → TS types + JSON Schema for the Python side
packages/tokens     the design system as code
packages/ui         components
```

## The three rules you will be tempted to break

1. **The model proposes; the policy disposes.** No model prose reaches a notification, a speaker or
   a machine action.
2. **Silence is the default.** A quiet window is a result, not a gap.
3. **One commit owns a file.** It is the only reason four people can build this at once.
