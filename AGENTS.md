# Working in this repo

You are one of several agents and humans shipping **Helicopter**. Read this before your first
commit. It is the contract between us; `docs/COMMITS.md` is the ledger and the phase docs are the
work.

---

## The product, in four lines

An **observer** for a person trying to get something done. A camera on a robotic arm watches the
desk — and can be aimed at what the observer is unsure about; the desktop app watches the machine
(apps, windows, browser, input, idle). We aggregate every signal, keep the stats, and **act** — a
nudge, a line spoken out loud, a physical point at the page, or an automatic change — so the goal
you set actually happens.

The theme is **Automate your studies / job / life.** An observer that only watches loses. Every
session must end with something the system *did*, not only something it *saw*.

Full drawings: `docs/00-architecture.md`.

---

## The golden rule

> **One commit owns a file. Two open commits never touch the same path.**

Every commit in `docs/COMMITS.md` lists its `Touches:` paths. Those sets are disjoint within a
phase. If you find yourself needing to edit a file another commit owns:

1. Stop.
2. Do **not** edit it.
3. Add the need to that commit's entry as a comment, or open a new commit that lands after it.

Shared files (`package.json`, `schema.prisma`, `tokens.css`) are owned by exactly one commit and
then frozen. Extending them is its own commit.

---

## How work lands

`docs/COMMITS.md` is the ledger. Every commit has an id (`HELI-###`), a dependency list and a lane.

```
1. Pick a row whose Depends are all done.
2. Do it. Only it — no drive-by fixes.
3. `pnpm lint` and `pnpm typecheck` pass at the root, its `Done when` line is literally true.
4. Commit straight to main and push. Tick the row.
```

No branches, no claim step, no PR. If you are blocked for more than 15 minutes, say so.

---

## Commit format

Conventional commits. The scope is the app or package.

```
feat(server): observation loop and the intervention policy

Reads the latest signals per session, decides an assessment, and only acts when
the evidence and the goal allow it. Silence is the default.

HELI-021
```

Types: `feat` `fix` `refactor` `chore` `docs` `test` `style`.
Scopes: `server` `desktop` `rig` `web` `contracts` `tokens` `ui` `repo` `ledger`.

One commit = one entry in the ledger. Work on main.

---

## Definition of done

- [ ] `pnpm lint` and `pnpm typecheck` pass at the repo root
- [ ] The commit's own `Done when:` line is literally true, and you ran it
- [ ] Nothing outside `Touches:` changed (`git diff --stat` proves it)
- [ ] No secrets, no `.env`, no API keys. Keys live in `apps/server` only
- [ ] No `console.log` left in shipped app code (use the logger)
- [ ] If you added a user-visible surface, it uses design tokens — no raw hex, ever

---

## Hard rules

**Contracts are law.** `packages/contracts` defines every shape crossing a process boundary. If
you need a new field, that is a commit against `contracts` first, merged, then your work. Never
hand-write a type that duplicates one in contracts.

**No model keys outside `apps/server`.** The desktop app and the browser get nothing. The device
gets a short-lived token at most. If you are about to put a provider key in a client, you have
taken a wrong turn.

**No raw colour.** Every colour comes from `@heli/tokens`. A hardcoded `#0FA36B` in a diff is a
request for change, not a nitpick. Same for spacing and radii.

**The model proposes; the policy disposes.** Every observation is a schema-validated
`Observation`. The model never writes free text to a notification, a speaker, or a machine action.
The action only happens when the **policy** — thresholds, goals, rate limits — allows it, and it
is always logged with its outcome.

**Silence is the default.** Most moments produce nothing. Do not add streaks, confetti, praise or
a buzz per distraction. Nagging is the fastest way to get uninstalled.

**The tool acts, and it is reversible.** If an intervention changes the machine (blocked a site,
muted a channel, opened an app, started a break) it must be visible, undoable in one click, and
recorded. A hidden automation is a bug.

**Seeded, single-user.** One user, one goal set, one device, all seeded. No orgs, no billing, no
roles. Anything else is out of scope and will be reverted.

---

## Stack, fixed

| | |
|---|---|
| repo | pnpm workspaces + Turborepo; Node 22 |
| server | Fastify 5, TypeScript, zod, Prisma + Postgres |
| desktop | Tauri 2 (Rust sidecar + webview), React + Vite, `@heli/tokens` |
| rig | `apps/edge` — a headless Python agent on the Mac that owns the camera, the arm and the speaker (see `docs/03-desk-capture.md`) |
| web | Next.js 15 App Router, Tailwind v4, `@heli/tokens`, three.js for the unit — the storefront only |
| models | DeepSeek Flash (vision + text, structured output) primary; Gemini behind the same adapter as escalation |
| voice | speech out through the server bridge; a local adapter so the path works with no keys |
| native | macOS APIs, read-only signals: NSWorkspace, CGWindowList, AXUIElement, CGEventTap counts, ScreenCaptureKit |

Do not introduce a library that is not already in a `package.json` without it being its own
`chore(repo):` commit with a one-line justification.

---

## Where things live

```
apps/desktop    the base app. goal, live state, audio, native signals, and the setup UI
apps/edge       the rig agent (Python, headless). camera, arm, playback
apps/server     the aggregator. the only component that persists or holds a key
apps/web        the storefront: home, desk unit, download, order — marketing only
packages/contracts  zod schemas → TS types + JSON Schema for the Python side
packages/tokens     the design system as code
packages/ui         components
docs/           architecture, contracts, intervention policy, phases, the ledger
```

---

## Asking for a decision

Do not invent product behaviour. If a phase doc does not say what happens, the answer is in
`docs/00-architecture.md` or it is a question for Cedric. Guessing produces work that gets
reverted, which is worse than waiting.
