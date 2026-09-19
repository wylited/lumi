# Commit ledger

Every unit of work, claimable. Read `AGENTS.md` first — especially **one commit owns a file; two
open commits never touch the same path.**

## How to claim

1. Pick a row whose **Depends** are ticked and whose **Owner** is `—`.
2. Put your name in Owner. Commit that one-line edit immediately: `chore(ledger): claim HELI-021`.
3. `git checkout -b heli-021`, do only that commit, PR titled exactly the commit message.
4. Merge, then tick **Done**.

Blocked more than 15 minutes? Drop the claim and say so out loud.

**Critical path:** `001 → 010 → 020 → 021 → 025`. Everything else exists to keep other people out
of that chain.

---

## P0 · Foundations — everything blocks on this

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☐ | HELI-001 | `chore(repo): workspace skeleton` | — | **no** | — |
| ☐ | HELI-002 | `chore(repo): lint and format` | 001 | yes | — |
| ☐ | HELI-003 | `feat(tokens): design system package` | 001 | yes | — |
| ☐ | HELI-004 | `feat(contracts): zod schemas` | 001 | yes | — |
| ☐ | HELI-005 | `feat(server): prisma schema and seed` | 001 | yes | — |
| ☐ | HELI-006 | `chore(repo): env and secrets` | 001 | yes | — |
| ☐ | HELI-007 | `feat(ui): component kit` | 001, 003 | yes | — |
| ☐ | HELI-008 | `docs(repo): readme and runbook` | 001 | yes | — |

## P1 · Server core — no model calls yet

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☐ | HELI-010 | `feat(server): fastify server and plugin layout` | P0 | **no** | — |
| ☐ | HELI-011 | `feat(server): auth and device pairing` | 010 | yes | — |
| ☐ | HELI-012 | `feat(server): device websocket and signal intake` | 010 | yes | — |
| ☐ | HELI-013 | `feat(server): goal and session lifecycle` | 010 | yes | — |
| ☐ | HELI-014 | `feat(server): media intake and object store` | 010 | yes | — |
| ☐ | HELI-015 | `feat(server): desktop signal ingestion` | 010 | yes | — |
| ☐ | HELI-016 | `feat(server): SSE live channel` | 010 | yes | — |
| ☐ | HELI-017 | `feat(server): mock device and mock desktop` | 012, 015 | yes | — |
| ☐ | HELI-018 | `feat(server): analytics queries` | 013 | yes | — |

## P2 · The observer loop — this is the product

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☐ | HELI-020 | `feat(server): deepseek client and the assess step` | P1 | **no** | — |
| ☐ | HELI-021 | `feat(server): the intervention policy` | 020 | **no** | — |
| ☐ | HELI-022 | `feat(server): speech out and the local adapter` | 012 | yes | — |
| ☐ | HELI-023 | `feat(server): the orchestrator` | 020–022 | **no** | — |
| ☐ | HELI-024 | `feat(server): session summary` | 021 | yes | — |
| ☐ | HELI-025 | `test(server): the loop harness` | 023 | yes | — |
| ☐ | HELI-026 | `feat(server): fixtures and expected assessments` | P1 | yes | — |

## P3 · Desktop — the base app

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☐ | HELI-030 | `feat(desktop): tauri shell and layout` | P0 | **no** | — |
| ☐ | HELI-031 | `feat(desktop): goal editor` | 030 | yes | — |
| ☐ | HELI-032 | `feat(desktop): live session view` | 030, 007 | yes | — |
| ☐ | HELI-033 | `feat(desktop): native signals sidecar` | 030 | **no** | — |
| ☐ | HELI-034 | `feat(desktop): app and window signal` | 033 | yes | — |
| ☐ | HELI-035 | `feat(desktop): input and idle signal` | 033 | yes | — |
| ☐ | HELI-036 | `feat(desktop): screen capture signal` | 033 | yes | — |
| ☐ | HELI-037 | `feat(desktop): notifications and audio` | 030 | yes | — |
| ☐ | HELI-038 | `feat(desktop): history and analytics` | 030, 018 | yes | — |

## P4 · Edge and media

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☐ | HELI-040 | `feat(edge): camera and audio agent` | — | yes | — |
| ☐ | HELI-041 | `feat(server): media relay and mjpeg` | 014 | yes | — |
| ☐ | HELI-042 | `feat(edge): led and shutter` | 040 | yes | — |
| ☐ | HELI-043 | `feat(edge): barge-in and playback` | 040, 022 | yes | — |

## P5 · Web

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☐ | HELI-050 | `feat(web): next app shell` | P0 | **no** | — |
| ☐ | HELI-051 | `feat(web): analytics dashboard` | 050, 018 | yes | — |
| ☐ | HELI-052 | `feat(web): session replay` | 050 | yes | — |
| ☐ | HELI-053 | `feat(web): landing page` | 050 | yes | — |
| ☐ | HELI-054 | `feat(web): devices and pairing` | 050, 011 | yes | — |

## P6 · Hackathon day

| ✓ | id | commit | depends | ∥ | owner |
|---|----|--------|---------|---|-------|
| ☐ | HELI-060 | `chore(repo): one-command boot` | P0–P5 | **no** | — |
| ☐ | HELI-061 | `feat(server): demo replay mode` | 060 | yes | — |
| ☐ | HELI-062 | `docs(repo): the run of show` | 060 | yes | — |
| ☐ | HELI-063 | `fix(web): projector pass` | P5 | yes | — |
| ☐ | HELI-064 | `test(repo): end-to-end rehearsal` | all | **no** | — |

---

## Suggested split for four people

| who | claim | notes |
|---|---|---|
| **A** (critical path) | 020, 021, 023, 024, 025 | the loop and the policy. Protect this person. |
| **B** | 010–018 | server core. Start the moment P0 lands. |
| **C** | 030–038 | the desktop app and the native signals. The base experience. |
| **D** | 040–043, 050–054 | edge, media, and web. The demo surfaces. |
| **hardware** | `docs/03-device-contract.md`, 040, 042 | never touches `apps/` |
| **shared** | 001–008 | do P0 together, the night before. |

P0 is eight commits; after 001 lands, 002–008 run in parallel. Do it before the day, not on it.
