# P6 · Hackathon day

**Goal:** the thing works on stage, once, in a room with bad wifi and a projector that washes out
your greys.

This phase is not feature work. Every commit here is about the demo surviving contact with a real
room. Claim these early in the day, not at hour 34.

---

### HELI-060 · chore(repo): one-command boot
**Depends:** P0–P5 **Parallel-safe:** no **Owner:** —
**Touches:** `scripts/demo.sh`, `docs/RUNBOOK.md`
**Do:** `./scripts/demo.sh` brings up Postgres and MinIO, the server, the desktop app and the web,
seeds the DB, starts the mock desk and the mock desktop, and prints the desk URL and the goal
URL and the console URL. One terminal, one command, no ordering to remember. Idempotent and safe to
re-run. Add `./scripts/verify.sh` that runs install check, lint, typecheck, tests and a handful of
route curls, printing a pass or fail line per check.
**Done when:** someone who has not touched the repo runs it from a clean clone and gets a working
live session in under three minutes.

### HELI-061 · feat(server): demo replay mode
**Depends:** 060 **Parallel-safe:** yes **Owner:** —
**Touches:** `apps/server/src/dev/replay.ts`
**Do:** `DEMO_MODE=replay` plays a recorded session — real signals, real assessments, real
interventions, real timings — through the **identical** bus and SSE path the live loop uses. Not a
mock UI: the same code path, fed from disk. If the camera dies, the wifi dies, or the model rate-limits
at the worst moment, you flip one env var and the demo still runs.
**Done when:** with the network off and the device stopped, the console plays a full session
indistinguishable from live.

### HELI-062 · docs(repo): the run of show
**Depends:** 060, 061 **Parallel-safe:** yes **Owner:** —
**Touches:** `docs/DEMO.md`
**Do:** Ninety seconds, written as beats with the exact words. Who sits down, what the goal is, when
the distraction is introduced, when the first nudge fires, what the device says, when to cut to the
desktop's History, when to show that the policy blocked the site, and the closing line about the model
proposing and the policy disposing. Include the **fallback line for every beat** if it fails.
**Done when:** someone else on the team can run the demo from this document without the author.

### HELI-063 · fix(desktop): projector pass
**Depends:** P3 **Parallel-safe:** yes **Owner:** —
**Touches:** `apps/desktop/src/**` (styling only)
**Do:** Look at every demo surface on an actual projector. Bump the smallest type, raise the
contrast of muted text on the dark surface, thicken rails and hairlines. Projectors crush dark
greys — what reads beautifully on a laptop disappears on the wall. Verify the tray icon colour is
distinguishable from three metres.
**Done when:** every element of the desktop's Live and History is legible from three metres on a real
projector.

### HELI-064 · test(repo): end-to-end rehearsal
**Depends:** all **Parallel-safe:** no **Owner:** —
**Touches:** — (no code)
**Do:** Run the full demo three times, on the venue wifi, with the projector, with a person who has
not rehearsed. Write down every stumble. Fix only the top three.
**Done when:** three consecutive clean runs.

---

## The two rules for the day

**Freeze at T-4 hours.** No new features after that, only fixes to things that break the run of
show. The urge to add one more thing at hour 40 is how demos die.

**Someone owns the fallback.** One person's entire job at T-1 hour is that `DEMO_MODE=replay` works,
the permissions are granted, and the projector is set. Not the person presenting.
