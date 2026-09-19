# P2 · The observer loop

**Goal:** a window of signals goes in, and something happens — a log line, a nudge, a spoken
sentence, or an automatic change — and it only happened because the **policy** allowed it. This
phase is the product. Everything else is scaffolding.

**Depends:** P1.
**Parallelism:** `020` and `021` are the critical path and go to **1 · the loop**. `022–026` run
alongside.

> **Read before starting.** The model never decides what to do. It returns a structured
> `Assessment` — what is happening, is it on the goal, how sure — and our **policy** turns that into
> an intervention or into silence. No model prose reaches a notification, a speaker or a machine
> action. Silence is the default. See `docs/00-architecture.md` and `docs/02-intervention-policy.md`.

---

### HELI-020 · feat(server): deepseek client and the assess step
**Depends:** P1 **Parallel-safe:** no, 021 waits on it **Owner:** 1
**Touches:** `apps/server/src/models/deepseek.ts`, `apps/server/src/models/provider.ts`, `apps/server/src/observe/assess.ts`, `apps/server/src/observe/prompts/assess.md`
**Do:** A provider interface `assessVision(request) → Assessment` with two adapters: `deepseek`
(primary, OpenAI-compatible, `response_format: json_schema`, images in a **user** message, `detail:
high`) and `local` (a deterministic stub so the loop runs keyless). `assess.ts` builds the request
from the session's **latest signal window**: the newest desk frame (and a screen frame when
available) plus derived machine metrics, and returns an `Assessment` validated by zod, retrying once
on a parse failure. Dense images are tiled into a 2×2 overlapping crop before sending; note the trap
in a comment — DeepSeek normalises toward 800×800, so a 1600 px page loses small text. Never send an
image in a system or assistant turn (it 400s). Log latency and token usage.
**Done when:** with the mock scenarios, `focused` returns `onTrack:true`, `drifting` returns
`onTrack:false` with `driftSeconds>30`, and `phone` returns a non-empty `activity` — all schema
valid, and each in under 4 s. With no key, the `local` adapter returns a schema-valid assessment and
the loop still runs.

### HELI-021 · feat(server): the intervention policy
**Depends:** 020 **Parallel-safe:** no **Owner:** 1
**Touches:** `apps/server/src/observe/policy.ts`
**Do:** Turn an `Assessment` into `{ tier, channel, message, action, reversible }` or into silence.
Tiers: `0 silent`, `1 ambient`, `2 nudge`, `3 speak`, `4 automate`, `5 summary`. The rules:
escalate only on **sustained** evidence (a minimum drift window, a minimum confidence, a minimum
number of consecutive off-goal assessments), never on one noisy signal; respect `minGapMs` between
speaking and `nudgeGapMs` between nudges; never exceed `policy.maxTier`; and at most one `automate`
per window. An unresolved nudge is what earns the next tier — not a timer alone. Write the reason as
a short machine-readable string so the console can explain every decision, and record the *expected*
outcome so the outcome can later be judged.
**Done when:** an off-goal window that resolves itself yields `0`; a sustained one yields `2` then
`3` on the next window; two off-goal windows 5 s apart produce exactly one nudge; and
`maxTier:2` never produces a speak.

### HELI-022 · feat(server): speech out and the local adapter
**Depends:** 012 **Parallel-safe:** yes **Owner:** 1
**Touches:** `apps/server/src/voice/speech.ts`, `apps/server/src/voice/push.ts`, `apps/server/src/voice/token.ts`
**Do:** A `SpeechProvider` with `local` (generates real PCM with no credentials so the path always
works) and `elevenlabs` (key-gated, clear error when the key is missing). On a tier-3 intervention,
deliver the line to the **desktop** first (it has the speaker and is where the user is) and to the
device when one is present: an `audio.out` header then a tagged `0x02` PCM chunk. Record the
duration, the moment it was delivered and whether it played. A manual
`POST /v1/sessions/:id/speak` lets the user or a demo operator fire one line, still passing the
policy. Keep the provider key inside this module.
**Done when:** a tier-3 intervention produces audible PCM on the desktop, the delivery is recorded,
and `grep -r ELEVENLABS apps/desktop apps/web apps/edge` returns nothing.

### HELI-023 · feat(server): the orchestrator
**Depends:** 020, 021, 022 **Parallel-safe:** no **Owner:** 1
**Touches:** `apps/server/src/observe/index.ts`
**Do:** Wire it: on a cadence (default every 10 s) and on a strong signal, take the session's window
→ `assess` → `policy` → act → persist an `Observation` with the assessment, tier, action and
confidence → publish on the bus. Persist **every** window, including silence, so analytics are
honest. Hard budget: if the loop exceeds 4 s, emit silence and log. Record `latencyMs` end to end.
Idempotent per window: never assess the same window twice.
**Done when:** `dev:mock` with the `drifting` scenario produces a full observation trail in under
4 s per window, visible on SSE, with at least one non-silent tier.

### HELI-024 · feat(server): session summary
**Depends:** 021 **Parallel-safe:** yes **Owner:** 1
**Touches:** `apps/server/src/observe/summary.ts`
**Do:** On session close, build the tier-5 summary: focused minutes, off-task minutes, the longest
focus run, the top distraction, the interventions that actually worked (tier + outcome), and one
sentence in the user's own framing of their goal. Store it on the session and push it to the
desktop. This is the artifact the user reads at the end of the night, so it must be specific, not
encouraging.
**Done when:** closing a seeded session writes a summary whose numbers match the analytics
endpoints, and the desktop receives it.

### HELI-025 · test(server): the loop harness
**Depends:** 023 **Parallel-safe:** yes **Owner:** 1
**Touches:** `apps/server/test/policy.test.ts`, `apps/server/test/loop.test.ts`
**Do:** `policy.test.ts` covers the rules: silence on a self-resolving window, escalation on a
sustained one, the nudge gap, the speak gap, `maxTier`, one automate per window, and the
outcome-driven adjustment. `loop.test.ts` runs the `focused`, `drifting` and `phone` scenarios
through the real orchestrator against `fixtures/expected.json` and prints a pass table with median
latency. Add a `test` script so `pnpm test` runs it.
**Done when:** the table prints, every policy rule has a test, and CI fails if fewer than the
expected assessments match.

### HELI-026 · feat(server): fixtures and expected assessments
**Depends:** P1 **Parallel-safe:** yes **Owner:** 1
**Touches:** `apps/server/fixtures/**`, `apps/server/fixtures/expected.json`
**Do:** Photograph or synthesise at least 12 real windows: focused at the desk, phone in hand, away
from the desk, head down reading, a second person, a dark room, a distracting tab open in the
signals, a long focus run, a blurry frame, an empty desk, a screen full of tabs, and a recovery
after a nudge. Record the expected `onTrack`, `kind` and `tier` for each.
**Done when:** `pnpm --filter @heli/server test` runs every fixture and prints the pass table.

---

## Exit criteria

- A drifting window produces a nudge, then a spoken line, then an automatic action — each earned,
  each logged with its outcome
- A focused window produces silence, and the silence is recorded and tested, not assumed
- The live stream carries the assessment and the reason for every decision, verbatim
- `tiers` analytics shows which interventions actually worked
