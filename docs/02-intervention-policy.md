# The intervention policy

The model assesses. **This decides.** Nothing reaches a notification, a speaker or a machine action
unless this file says it may.

---

## 1. The tiers

| tier | name | channel | default when |
|---|---|---|---|
| 0 | silent | log only | the default, most windows |
| 1 | ambient | tray colour, LED state | drift detected, but no reason to interrupt |
| 2 | nudge | native notification **with an action** | sustained off-goal past `driftSeconds` |
| 3 | speak | one sentence, interruptible | the nudge was unresolved and drift continues — or the desk survey read a cluttered desk |
| 4 | automate | block, redirect, pause, open, break | the goal grants it and the drift is confirmed |
| 5 | summary | end-of-session recap | session close |

Tier 4 is never the first thing that happens, and it is never invisible: every automations is
shown, one-click reversible, and recorded with its outcome.

Tier 3 is usually the drift line. It is also the **desk line**: a periodic sweep of the desk, read
once and kept on the session, can be worth one sentence even to a person who is on task — a desk
with no room left to work on it is its own reason to speak. Both are the same channel and the same
tier, so they share its gap and its outcome machinery.

---

## 2. The rules

An assessment becomes an intervention only when **all** hold:

1. `assessment.confidence ≥ policy.minConfidence` (default **0.7**)
2. the off-goal run is **sustained**: `driftSeconds ≥ policy.driftSeconds` (default **30**) **and**
   `consecutiveOffGoal ≥ policy.consecutiveOffGoal` (default **2**)
3. the channel is inside its gap: `now - lastSpokenAt ≥ policy.minGapMs` (default **90 s**) for
   speech, `now - lastNudgeAt ≥ policy.nudgeGapMs` (default **180 s**) for a nudge
4. `tier ≤ policy.maxTier` (default **2**, raised per goal by the user)
5. at most **one** automate per window, and never while a break the system started is still running

**Voice first.** When the goal permits `speak` (and `maxTier ≥ 3`), the first interruption is the
spoken line: the nudge rung is skipped, and between two lines the policy waits in ambient rather
than falling back to a notification. A goal without `speak` climbs from the nudge as below.

**Escalation is earned.** A nudge does not become a speak because time passed; it becomes a speak
because the nudge was **unresolved** (the user was still off-goal in the next window). A spoken
line that is unresolved earns a change, when one is permitted. If a window resolves itself, the
counters reset and the tier returns to 0.

**Downgrades.** Focus / Do Not Disturb turns a tier 2 into a tier 1 and records why. A break the
user started manually is never interrupted below tier 4. A meeting, inferred from a calendar
signal, suppresses everything except tier 0.

**Silence is a result.** A quiet session is written to `Observation` exactly like a loud one, so
the analytics never flatter the system.

### The clutter rule

The desk survey is the one reading that may interrupt a person who is **on task**, and it is the
only thing that does: whenever the window is off goal, the drift ladder above owns the airtime. It
attaches where the drift rule would otherwise return silence — an on-task window — and it fires
only when **all** hold:

1. `reading.confidence ≥ policy.minConfidence` (default **0.7**) — the same doubt-is-silence rule
2. the reading is **fresh**: written less than 10 minutes ago, because a reading is a picture of a
   desk the person has been moving things on since
3. `reading.score ≥ policy.clutterSpeakScore` (default **0.6**) — a desk in use is not clutter
4. it is **worse** than the last desk line: `score ≥ lastSpokenScore + policy.clutterRiseDelta`
   (default **0.25**), so the line does not repeat itself — and so the reading's own noise cannot
   speak: three frames of an unchanged desk scored 0.32 and 0.45 a minute apart on the bench, and a
   bar inside that spread would let the model's variance be the reason the desk line goes out
5. the goal permits `speak` and `maxTier ≥ 3`
6. the speech channel's adapted gap has passed since the last desk line, **and**
   `policy.clutterGapMs` (default **45 min**) has passed — clutter returns slower than drift
7. the window's `activity` is not `away`: nothing is ever said to an empty desk, however cluttered

The line is a **template** chosen from the worst hotspot's label — the model returns a reading, never
words — and a reading with no hotspots still gets the plain one. When the goal grants `automate`, the
sweep went through a calibration so the worst hotspot has desk millimetres, and the session has not
already pointed, the line also comes with a physical `arm.point` at that place. That gesture is
recorded as `reversible: false`: it is a gesture, not a change to the machine, and there is nothing
left to undo — the tracker re-acquires the person as soon as the move ends.

**When a sweep happens** is separate from when it speaks, and it is deliberately sparing: for the
first two minutes of a session nothing sweeps unless the person has already left, and the first
reading after that is a single frame from where the camera already points. An away reading is the one
sweep that costs nobody anything — no tracking to interrupt and an unobstructed desk — but it still
walks the arm across the desk (three poses on a rig with an arm, one without). Only the `start`
reading is the single frame, and the rig is asked at most once per `policy.surveyGapMs` (**5 min**),
with at most one model call per sweep, whatever the reason.

---

## 3. What "worked" means

Every intervention records an **outcome**, judged in the next one or two windows:

- **resolved** — the next window is back on goal within `resolveWindowMs` (default 120 s)
- **ignored** — still off goal, and the escalation continues
- **reverted** — a tier-4 action the user undid within `revertWindowMs` (default 60 s)
- **unknown** — no next window (session ended) — never counted as a win

`GET /v1/analytics/tiers` is a `GROUP BY tier, outcome`. That query is the product's self-critique.

A desk line is judged by exactly the same machinery as a drift line: it is a tier-3 row, so the next
window decides whether it was resolved or ignored, and the answer feeds the speech channel's
adaptation and the ladder above. Its own two brakes are not read back from the rows, though: the last
desk line is remembered in the session's own state, with the same lifetime as the reading it spoke
about, because the rule can only compare against a reading it still holds. A survey row itself is
never judged — it carries no assessment, it is a reading, and it is filtered out of every query that
reads windows (the escalation ladder, the recent outcomes).

---

## 4. Adaptation

The policy is personalised, but **explainable and bounded** — not a black box:

- Per user, per distraction kind, keep counts of `(tier, outcome)`. Where a channel has a low
  resolve rate over enough samples, raise that channel's gap (annoy less).
- Where a nudge reliably resolves a kind, prefer tier 2 for that kind and do not escalate to speech
  as readily.
- If a kind escalates through a tier repeatedly with no resolution, step to tier 4 sooner — but
  only within the user's granted permissions.
- Every adapted value has a floor and a ceiling from the goal. Nothing adapts past what the user
  allowed.

Store the counters per user and per kind. Every decision writes the reason string it used
(`kind`, `tier`, `because`) so any choice can be read back in the console.

---

## 5. Safety

- **Allowlist, not blocklist, for automations.** Only these exist: pause notifications, open a
  named app, navigate a browser tab to the goal, mute a named site for the session, start a break,
  and start a timer. Nothing else, ever.
- **Never destructive.** No closing documents, no deleting, no changing a password, no purchase,
  no sending anything on the user's behalf.
- **Reversible in one click**, with the undo surfaced next to the action, and the undo recorded.
- **Visible.** The tray shows an automate is active and what it is.
- **Bounded.** At most one automate per window, and a global cap per session.

---

## 6. Defaults

```ts
export const DEFAULT_POLICY = {
  windowMs: 60_000,
  assessEveryMs: 10_000,
  minConfidence: 0.7,
  driftSeconds: 30,
  consecutiveOffGoal: 2,
  nudgeGapMs: 180_000,
  minGapMs: 90_000,
  maxTier: 2,
  resolveWindowMs: 120_000,
  revertWindowMs: 60_000,
  maxAutomationsPerSession: 6,
  assumeSilentOnDoubt: true,
  surveyFloorMs: 1_200_000,
  surveyGapMs: 300_000,
  clutterSpeakScore: 0.6,
  clutterRiseDelta: 0.25,
  clutterGapMs: 2_700_000,
}
```

The last five are the desk survey's: the **floor** is the slowest it will sweep (20 min), the **gap**
the fastest (5 min), and the three clutter values are the rule in §2 — speak at `clutterSpeakScore`
and above, only when the reading has risen by `clutterRiseDelta`, and no two desk lines within
`clutterGapMs` (45 min).

Every value is per goal, editable, and shown in plain teaching language in the desktop app — never
as a field name.
