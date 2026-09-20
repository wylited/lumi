# P9 · The desk survey

**Goal:** every once in a while the rig sweeps the desk around the person, the vision model reads the
clutter, and the policy decides whether to say it. The rig takes a bounded sweep of the desk (up to
four poses, the arm moves bracketed so the follow loop is never fought), uploads those frames tagged
as a new frame source, and acks the sweep with the poses and frame numbers. The server decides *when*
(away, session start, a floor, or a person pressing the button), makes **one** vision call for the
whole sweep, validates a `ClutterReading`, writes it on the observation row, and lets the **existing
policy** decide whether that reading becomes a spoken line — and, when the desk has a calibration and
the goal grants it, a physical point at the pile. The desktop shows the reading on the live view and
offers a sweep on demand.

**Depends:** P8 is done. `090` is the phase doc you are reading. `091` is contracts law — every
desk-shaped row below waits on it. `092`, `093`, `094` and `096` are four disjoint lanes that start
together once `091` lands; `095` consumes `093`'s source and `094`'s provider.
**Parallelism:** `090` → `091` → `092`, `093`, `094` and `096` in parallel → `095` → the gates.
`092` is Python, `096` is the app, `093` and `094` are disjoint server files: four agents can hold
those four lanes at once. `095` is the only row that touches `observe/index.ts`, so nothing races on
the loop. `093`, `094` and `095` are three rows but **one commit**: they share `observe/types.ts` and
`observe/persistence.ts` as seams, so any split leaves a middle commit that cannot typecheck.
**Owners:** `091` and `093` are **2 · server**; `092` is **4 · hardware + rig**; `094` and `095` are
**1 · the loop**; `096` is **3 · desktop + web**.
**Touches (`090`):** `docs/phases/P9-desk-survey.md` (new), `docs/COMMITS.md`,
`docs/00-architecture.md` — the phase doc you are reading, its ledger rows, and the one signal line
the architecture drawing gains.

> **The camera is the scarce thing.** One survey is one desk action, up to four frames and **one**
> model call. The sweep blocks the rig's action loop for its duration (the dispatcher handles one
> action at a time), which is why it is capped at 20 s, why the server waits
> `SURVEY_ACK_TIMEOUT_MS` for this one type, and why `desk.survey` is never retried — a retried sweep
> moves the arm again and takes more frames.

| | |
|---|---|
| one survey = | 1 desk action + up to 4 frames + **1** model call (~1.3k prompt tokens at 3 images) |
| typical sweep | 3 poses ≈ 5 s of arm time, ≤ 20 s hard cap |
| model calls per hour | ≤ 3 from the floor (20 min); typically 1–2 (start + away) |
| minimum gap between sweeps | 5 min (`policy.surveyGapMs`), enforced in the loop, not the rig |
| tracking interrupted | only during a sweep, and only if the person is there — the away trigger costs nothing |

---

### HELI-091 · feat(contracts): the clutter reading, the survey action and its frames
**Depends:** 090 **Parallel-safe:** no **Owner:** 2 · server
**Touches:** `packages/contracts/src/clutter.ts` (new), `packages/contracts/src/desk.ts`, `packages/contracts/src/observation.ts`, `packages/contracts/src/policy.ts`, `packages/contracts/src/intervention.ts`, `packages/contracts/src/index.ts`, `packages/contracts/scripts/emit-json-schema.ts`, `docs/01-contracts.md`, `apps/server/src/lib/rows.ts`
**Note on `rows.ts`:** this row owns the file outright and lands the real parse — `survey:
optionalField(ClutterReading, row.survey, { rowId, field: 'survey' })`, not a `null` placeholder. The
parse is what the new field demands of the only output-typed `Observation` literal in the tree, it
needs nothing but this row's own contracts, and owning it here is what keeps this commit green on its
own. `095` does not touch the file.
**Note on the review's corrections:** §1's consumer invariant ("any read that folds observations must
exclude survey rows"), §4's heading (the model has two outputs now) and the `DeskSurveyResponse`
refusal vocabulary are all statements *about* the contract, so this row carries them.
**Do:**
1. **New file `clutter.ts`** — the model's second output, and the only shape a survey verdict travels
   in. `.strict()` everywhere, same style as `assessment.ts`:

```ts
export const ClutterLabel = z.enum([
  'papers', 'cups', 'dishes', 'food', 'cables', 'clothes', 'tools', 'boxes', 'bottles', 'other',
])

export const ClutterHotspot = z.object({
  poseIndex: z.number().int().nonnegative(),
  label: ClutterLabel,
  severity: z.number().min(0).max(1),
  at: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
}).strict()

export const ClutterReading = z.object({
  score: z.number().min(0).max(1),
  hotspots: z.array(ClutterHotspot).max(3),
  evidence: z.array(z.string().max(140)).max(5),
  confidence: z.number().min(0).max(1),
  because: z.string().max(200),
}).strict()
```

2. **`desk.ts`** — four additive changes, in the style of the existing members:
   - `DeskAction` gains one member: `z.object({ ...ActionBase, id: z.string(), type:
     z.literal('desk.survey'), payload: z.object({ reason: z.string().nullable(), poses:
     z.number().int().min(1).max(4).default(3) }).strict() }).strict()`.
   - New `DeskSurveyPose` (`index`, `seq`, `pose: ArmPose.nullable()`, `aim: z.object({ x:
     z.number(), y: z.number() }).strict().nullable()`) and `DeskSurveyResult` (`reason`,
     `startedAt`, `durationMs`, `poses: z.array(DeskSurveyPose).max(4)`), both `.strict()`.
   - `DeskActionResult` gains `survey: DeskSurveyResult.nullable().default(null)`;
     `DeskHealth` gains `surveying: z.boolean().default(false)`.
   - New `DeskSurveyResponse = z.object({ reading: ClutterReading.nullable(), poses:
     z.number().int().nonnegative(), reason: z.string().nullable() }).strict()` — what
     `POST /v1/desks/:id/survey` answers: the reading it took, or null with the reason it did not
     (`gap`, `busy`, `no_desk`, `no_frames`, `assess_failed`, plus the rig's own word for a sweep it
     refused: `survey_unavailable`, `survey_timeout`, `no_frame`, `desk_offline`, `ack_timeout`).
3. **`observation.ts`** — `ObservationRow` gains `survey: ClutterReading.nullable().default(null)`.
   A survey row carries `assessment: null`; a drift row carries `survey: null`.
4. **`policy.ts`** — five fields, each with a default, so `DEFAULT_POLICY` and every existing goal
   keep working: `surveyFloorMs: 1_200_000`, `surveyGapMs: 300_000`,
   `clutterSpeakScore: z.number().min(0).max(1).default(0.6)`, `clutterRiseDelta:
   z.number().min(0).max(1).default(0.25)` (raised from 0.15 on the bench: an unchanged desk read
   0.32 and 0.45 a minute apart, so the rise bar has to clear the model's own spread), `clutterGapMs: 2_700_000`.
5. **`intervention.ts`** — `Intervention` gains `point: z.object({ x: z.number(), y: z.number()
   }).strict().nullable().optional()`. Absent on every existing line; set only when a physical point
   accompanies the line. **Optional, not `default(null)`** — `Intervention` is the one contract whose
   output type has TS object literals (`observe/policy.ts` and `lib/rows.ts`, both `095`'s files), and
   a default would turn each of them into a type error in this row, which would break this commit's
   own Definition of Done. `095` reads it as `intervention.point ?? null`.
6. **`index.ts`** — `export * from './clutter.js'` (alphabetical position, after `./control.js`).
7. **`scripts/emit-json-schema.ts`** — add `ClutterReading: contracts.ClutterReading` and
   `DeskSurveyResult: contracts.DeskSurveyResult` to `topLevel`.
8. **`docs/01-contracts.md`** — §1 add `survey` to the observation row; §4 add the clutter reading
   as the model's second, rarer output; §5 add the five policy defaults; §7 add
   `POST /v1/desks/:id/survey`.

**Done when:** `pnpm --filter @heli/contracts build` exits 0 and
`dist/json-schema.json` contains `ClutterReading` and `DeskSurveyResult`; `pnpm typecheck` is clean at
the root; `pnpm --filter @heli/server test` still passes.

### HELI-092 · feat(edge): the desk sweep, and the source on the wire
**Depends:** 091 **Parallel-safe:** yes (with 093, 094, 096) **Owner:** 4 · hardware + rig
**Touches:** `apps/edge/heli_rig/survey.py` (new), `apps/edge/heli_rig/capture.py`, `apps/edge/heli_rig/upload.py`, `apps/edge/heli_rig/actions.py`, `apps/edge/heli_rig/socket.py`, `apps/edge/heli_rig/config.py`, `apps/edge/heli_rig/__main__.py`, `apps/edge/tests/test_survey.py` (new), `apps/edge/tests/test_upload.py`, `apps/edge/tests/test_capture.py`, `apps/edge/tests/test_actions.py`, `apps/edge/tests/test_desk_socket.py`, `apps/edge/tests/fake_desk.py`, `apps/edge/README.md`, `apps/edge/.env.example`, `docs/03-desk-capture.md`
**Note on `fake_desk.py`:** the fake capture loop has to answer with the seq it took and the outcome the server gave it, because the sweep acks the seq of each pose's frame — without that the rig's own tests could not tell a landed pose from a refused one.
**Do:**
1. **`upload.py`** — `Uploader.upload(self, frame, seq, source: str = 'camera')`; `_post` gains
   `"x-heli-source": source` in its headers. The rig's live frames keep the default, so nothing else
   changes; only the sweep passes `'survey'`.
2. **`capture.py`** — replace the `_capturing: bool` claim with a counter so the sweep can park the
   cadence for its whole duration, not per frame:
   - `self._holds = 0`; `def hold(self) -> None: self._holds += 1`; `def release(self) -> None:
     self._holds = max(0, self._holds - 1)`.
   - `tick()`'s first guard becomes `if self._holds > 0:` (same log line, `skipped_for_capture`).
   - `capture_now(self, source: str = 'camera')` wraps its body in `self.hold()` / `self.release()`
     and passes `source` to `self._upload(frame, seq, source)`; `_upload` and `_start` take the same
     optional `source` (default `'camera'`).
   - Replace the `_capturing` comment with one that says what the counter is: a hold parks the
     cadence, counted so a sweep and a `capture` action nest.
3. **New `survey.py`** — the sweep, no dispatcher, no socket, unit-testable:

```python
SURVEY_SETTLE_S = 0.6        # after a move, before the grab: the servo is still settling
SURVEY_MAX_S = 20.0          # hard cap for the whole sweep, timeout aborts and reports what it got
SURVEY_PAN_STEP_DEG = 12.0   # the fallback sweep: this far left and right of the start pose
SURVEY_TILT_DROP_DEG = 8.0   # and this much lower, so the desk is in frame, not the wall

@dataclass(frozen=True)
class SurveyTarget:
    kind: str                     # 'point' (desk mm, via the calibration) | 'aim' (pan/tilt)
    x: float | None = None
    y: float | None = None
    pan: float | None = None
    tilt: float | None = None

def survey_targets(count: int, start: ArmPose | None, rect: dict | None) -> list[SurveyTarget]:
    """The poses one sweep walks. Pure, so the geometry is tested without an arm."""
```

   `survey_targets` rules, exactly:
   - `count <= 1` → one target at the pose the arm is already in, `SurveyTarget('aim', pan=start.pan,
     tilt=start.tilt)`: one frame, no move. With no arm (or a pose the arm would not report) the same
     single target is returned with `pan`/`tilt` `None`, meaning "take the frame where the camera
     points"; the sweep still takes it and the ack's pose fields are null.
   - `rect` present (from `Calibration.load(...).rect()`, which needs `MIN_POSES` stored poses) and
     `count > 1` → `count` `'point'` targets on the rectangle's horizontal centre line:
     `x_i = rect['x'] + rect['w'] * (i + 0.5) / count`, `y = rect['y'] + rect['h'] / 2`.
   - otherwise → `count` `'aim'` targets: `pan_i = start.pan + (i - (count - 1) / 2) *
     SURVEY_PAN_STEP_DEG`, `tilt_i = start.tilt - SURVEY_TILT_DROP_DEG`. Out-of-travel targets are
     **not** clamped: the driver refuses them, the pose is skipped, and the report says so.

```python
class Surveyor:
    def __init__(self, capture, arm, cfg, log, tracker=None) -> None: ...
    @property
    def surveying(self) -> bool: ...
    async def sweep(self, count: int, reason: str | None) -> SurveyReport: ...
```

   and the two report shapes, which the ack is built from:

```python
@dataclass(frozen=True)
class SurveyPose:
    index: int
    seq: int
    pose: dict | None = None    # {'pan': float, 'tilt': float}, None when the arm would not say
    aim: dict | None = None     # {'x': float, 'y': float} desk mm, only for a 'point' target

@dataclass(frozen=True)
class SurveyReport:
    reason: str | None
    started_at: str
    duration_ms: int
    poses: list[SurveyPose]
    error: str | None = None    # 'no_frame' | 'survey_timeout' | None
```

   `sweep` order, exactly:
   1. `capture.hold()`; `tracker.freeze('desk.survey')` when a tracker exists; both released in
      `finally`.
   2. `start = await asyncio.to_thread(arm.pose)` when there is an arm (a failure here is not fatal:
      log it, sweep with `start = None` → one pose).
   3. `rect = Calibration.load(Path(cfg.heli_dir) / RIG_FILE).rect()` inside a `try` — a missing or
      broken file is no calibration, never an error. Loaded per sweep so a re-calibration is picked
      up.
   4. For each target, inside `asyncio.timeout(SURVEY_MAX_S)` around the whole loop: move
      (`to_thread(arm.point, x, y)` or `to_thread(arm.aim, pan, tilt)`), `await
      asyncio.sleep(SURVEY_SETTLE_S)`, `frame = await capture.capture_now('survey')`, then
      `seq = capture.state()['lastSeq']` and the upload outcome from `capture.last_outcome`. A move
      that raises `ArmError` or a frame the server refused skips that pose with the reason logged;
      the sweep continues.
   5. Restore: `to_thread(arm.aim, start.pan, start.tilt)` best-effort, logged on failure (the
      tracker re-acquires anyway once thawed).
   6. Report: `SurveyReport(reason, started_at, duration_ms, poses: list[SurveyPose], error)`, where
      `error` is `None`, `'no_frame'` (nothing landed) or `'survey_timeout'`. A partial sweep is a
      truthful report, not a failure: `poses` lists what was taken.
4. **`actions.py`** — `Dispatcher.__init__` gains `surveyor: Surveyor | None = None`;
   `_dispatch` gains `if kind == "desk.survey": return await self._survey(action_id, payload)` before
   the `_ARM_ACTIONS` branch; `desk.survey` is **not** added to `_ARM_ACTIONS` or `_MOVING_ACTIONS`
   (it manages its own freeze).
   - `self._surveying = False`; `@property def surveying(self) -> bool`.
   - `_survey`: no surveyor → `_ack(action_id, 'failed', error='survey_unavailable')`; else
     `count = int(payload.get('poses') or 3)`, `report = await self._surveyor.sweep(count,
     payload.get('reason'))`, and `_ack(action_id, 'done' if report.poses else 'failed',
     survey=_survey_dict(report), error=report.error)`. `_ack` gains a `survey: dict | None = None`
     keyword and puts `"survey": survey` in its result dict beside `pose`/`seq`/`zoom`/`durationMs`,
     so every ack keeps the same shape.
5. **`socket.py`** — `_health()` gains `"surveying": bool(getattr(self._dispatcher, "surveying",
   False))` beside `following`, with a one-line docstring in the same voice as `_following`.
6. **`config.py`** — no new settings: the four `SURVEY_*` constants live in `survey.py` where the
   geometry is, and the rig's own knobs (fps, tracking, calibration) already exist. Add nothing.
7. **`__main__.py`** — build the surveyor beside the tracker (`Surveyor(capture, arm, cfg, log,
   tracker=tracker)`, `tracker=None` when there is no arm) and pass `surveyor=surveyor` to
   `Dispatcher(...)`. No new boot line: the dispatcher logs each sweep.
8. **`README.md`** — a `## Sweeping the desk` section: what `desk.survey` does, up to four poses,
   the freeze, the `x-heli-source: survey` tag, the cap, and the honest list additions (`no
   calibration → pan/tilt offsets, and no physical point`). **`.env.example`** unchanged (no new
   keys).
9. **`docs/03-desk-capture.md`** — the desk-actions table gains `desk.survey | { reason, poses }`;
   the frames section gains the third source `survey` and its rule (the newest **set** of the last
   survey is what the survey path reads, by seq); the caps/health JSON gains `surveying`.
10. **Tests** — `tests/test_survey.py`: the three `survey_targets` cases (single pose, rect, offsets),
    a sweep that freezes and thaws exactly once, holds the cadence for the whole sweep, skips a pose
    whose move raises, reports `no_frame` when nothing landed and a partial list when one did, and
    restores the start pose. `test_upload.py`: the header is `camera` by default and `survey` when
    asked. `test_actions.py`: `desk.survey` acks `done` with the pose list, `failed` with
    `survey_unavailable` when there is no surveyor, and an unknown type still falls through to
    `unknown_action`. `test_capture.py`: a hold parks the cadence and `capture_now` nests inside it.

**Done when:** `cd apps/edge && uv run pytest` passes; with the server and a session live,
`uv run heli-rig` logs a sweep when asked and the server's `GET /v1/desk` shows the frame count
climbing; on a rig with no arm, `desk.survey` still returns one pose and one frame.

### HELI-093 · feat(server): the survey frame source and its frames
**Depends:** 091 **Parallel-safe:** yes (with 092, 094, 096) **Owner:** 2 · server
**Touches:** `apps/server/src/services/frames.ts`, `apps/server/test/frames.test.ts` (new), `apps/server/src/observe/persistence.ts` (one loop only)
**Note on `persistence.ts`:** `createPrismaReader.frames()` iterates `FRAME_SOURCES` and indexes `KIND_OF_SOURCE`, so adding `survey` to that list makes the old loop a type error *and* would feed sweep frames to the per-tick assessment. This row changes exactly that loop to `ASSESS_SOURCES` and nothing else in the file; `095` owns everything else it does there, and the two rows are sequential.
**Do:**
1. `FRAME_SOURCES = ['camera', 'screen', 'survey'] as const` — the store's key set and the accepted
   `x-heli-source` / `?source=` vocabulary. `isFrameSource` follows automatically.
2. New `ASSESS_SOURCES = ['camera', 'screen'] as const` with the docstring that says why: the
   per-tick assessment gets the two lenses of the moment, and a survey frame is a deliberate,
   separate reading. `KIND_OF_SOURCE` is retyped over `(typeof ASSESS_SOURCES)[number]` and keeps
   `camera → 'desk'`, `screen → 'screen'`.
3. `VideoFrameInput.source`'s comment: the rig now sends `x-heli-source: survey` for sweep frames;
   the default stays `camera`.
4. Nothing else in this file changes: `latestFrames`, `resolveLatestFrameRef`, `listFrames` and the
   archive keys are already per-source, so `survey` gets its own anchor
   (`sessions/<id>/survey/latest.jpg`) and its own ring.
5. New `apps/server/test/frames.test.ts`: a `survey` frame is accepted, lands in
   `listFrames(sessionId, 'survey')` with its `ref`, `seq` and dimensions, and is **not** returned by
   a `camera` read; an unknown source is still refused. Follow the existing test style
   (`node:test` + `tsx`, in-memory store, no server).

**Note on `frames.test.ts`:** the three cases here pin the store split and are green with this row
alone. The case that pins the *assess read* — the behaviour `095`'s `persistence.ts` loop provides —
lands with `097`, because the file and that loop cannot both be green in this commit.
**Note on `persistence.ts`:** this row's one-loop change to the reader lands with `095`, which owns
the file for its survey-frames read; `095`'s commit is the first in which the loop is observable.
**Note on the review's correction:** the `FRAME_SOURCES` docstring's claim that the rig sends no
header is this row's own premise (`092` landed the header), so its correction lands here.

**Done when:** `pnpm --filter @heli/server test` passes, and with the server up a curl
`POST /v1/desk/frames` carrying `x-heli-source: survey` answers 201 while
`GET /v1/sessions/:id/frame.jpg?source=camera` still serves the live frame — no route change is
needed for this, the source vocabulary is the only gate.

### HELI-094 · feat(server): the clutter prompt and the provider's second reading
**Depends:** 091 **Parallel-safe:** yes (with 092, 093, 096) **Owner:** 1 · the loop
**Touches:** `apps/server/src/observe/types.ts`, `apps/server/src/models/deepseek.ts`, `apps/server/src/observe/prompts/clutter.md` (new), `apps/server/test/deepseek.test.ts` (new)
**Do:**
1. **`observe/types.ts`** — the seam the pass is built against, so `index.ts` and the tests never
   need a network:
   - `export interface SurveyInput { goal: Goal; window: SignalWindow; frames: AssessFrame[] }`
   - `VisionProvider` gains `survey(input: SurveyInput): Promise<ClutterReading>`.
2. **New `observe/prompts/clutter.md`** — exactly this text:

```md
# Desk survey

You are the eyes of an observer that helps one person finish what they sat down to do. Once in a
while the camera is aimed across their desk and you are asked one question: how cluttered is this
desk?

You do not decide what happens next. You do not write a message for the person. You return one
structured reading and nothing else.

## What you receive

- The goal, in the person's own words, and the machine metrics for the window. They are context,
  not the question.
- **Two to four images of the desk, taken one after another across it, in order**: the first is the
  left of the desk, the last is the right, and any in between are the steps between them. Some
  frames may have something drawn on them by another program — a box, a crosshair, a line of text.
  Ignore anything drawn on the picture and judge the desk itself.

## Rules

- `score` is how cluttered the desk is, 0 to 1: 0 is a clear surface with room to work, 0.5 is a
  surface in use with things on it, 0.8 and above is a surface with no clear space left. Judge the
  surface, not the room: a shelf, a wall or a chair is not the desk, and a desk mid-task with one
  open notebook and a pen is not clutter.
- `hotspots` are the one to three places that make it cluttered, worst first, each with a
  `poseIndex` (0 for the first image, 1 for the second, and so on), a `label` from this list only —
  papers, cups, dishes, food, cables, clothes, tools, boxes, bottles, other — a `severity` from 0 to
  1, and `at` as the place in that image: x and y from 0 to 1, with (0, 0) at its top-left.
- `evidence` is two to five short facts you actually saw, each under 140 characters. Facts, not
  opinions.
- `confidence` is your genuine certainty, 0 to 1. Be conservative: a desk you cannot see well is a
  low confidence, not a guess.
- `because` is one short factual line for the operator's console. It is never spoken.
- Never invent an object the images do not show. A desk with nothing on it is a low `score`, an
  empty `hotspots`, and that is the whole answer.

Return only JSON matching the ClutterReading schema.
```

3. **`models/deepseek.ts`**:
   - `CLUTTER_JSON_SCHEMA`, hand-written to mirror `ClutterReading` exactly (the same reason
     `ASSESSMENT_JSON_SCHEMA` is hand-written: no `zod-to-json-schema` in the server).
   - Extract the existing image-part loop in `buildMessages` into a private `imageParts(frames)`
     used by both builders; **the survey path never tiles** (a desk frame is not text-dense), it
     appends each frame whole.
   - `buildSurveyMessages(input: SurveyInput): BuiltRequest` with its own user text: the goal and
     the window one-liner (reuse the same formatting), then `N images follow, left to right across
     the desk. Return one clutter reading.`
   - `readClutterPrompt()` + `FALLBACK_CLUTTER_PROMPT`, cached like `readPrompt()`.
   - `export function parseClutterContent(content: unknown): ClutterReading | null` — the same
     defensive parse as `parseAssessmentContent` (fences stripped, `ClutterReading.safeParse`).
   - `createDeepSeekVisionProvider(...)` returns `{ name, assess, survey }`; `survey` posts
     `response_format: { type: 'json_object' }` with the clutter system prompt + schema in the text,
     `temperature: 0`, the same 15 s timeout and one retry, and logs
     `vision.survey` with `{ model, imageCount, latencyMs, score, hotspots, confidence }`.
   - A response that will not parse throws, exactly as `assess` does, so the caller records silence.
4. **New `apps/server/test/deepseek.test.ts`**: `buildSurveyMessages` puts the text part first and one
   image part per frame with bytes, in order, and counts them; `parseClutterContent` accepts a fenced
   object, rejects a score above 1, an unknown label, a missing `hotspots`, and prose.

**Done when:** `pnpm --filter @heli/server test` passes, and a one-off live call with three desk
frames returns a parsed reading (the check is in Verification).

### HELI-095 · feat(server): the survey pass, the clutter rule and the point
**Depends:** 093, 094 **Parallel-safe:** no **Owner:** 1 · the loop
**Touches:** `apps/server/src/observe/survey.ts` (new), `apps/server/src/observe/live.ts` (new), `apps/server/src/observe/index.ts`, `apps/server/src/observe/policy.ts`, `apps/server/src/observe/persistence.ts`, `apps/server/src/observe/runtime.ts`, `apps/server/src/observe/scheduler.ts`, `apps/server/src/observe/types.ts`, `apps/server/src/lib/rows.ts`, `apps/server/src/services/desk.ts`, `apps/server/src/routes/desk.ts`, `apps/server/src/index.ts`, `apps/server/prisma/schema.prisma`, `apps/server/test/survey.test.ts` (new), `apps/server/test/policy.test.ts`, `apps/server/test/loop.test.ts`, `docs/02-intervention-policy.md`
**Do:**
1. **`types.ts`** — the seams (094 owns the file; this row extends it, so run 095 after 094):
   - `SessionReader` gains `surveyFrames(sessionId: string, seqs: number[]): Promise<AssessFrame[]>`.
   - `ObservationWriter.write`'s input gains `survey?: ClutterReading | null`. **No writer member for
     the last desk line**: an earlier draft of this row asked for `lastClutterSpeech(sessionId)` — the
     newest row with `survey != null` and `tier >= 3` — and the review proved no such row can exist
     (the reading row is written at `tier: 0`; the line's own row is a window row with `survey: null`),
     so the two brakes it fed read `null` forever and the desk line repeated every adapted speech gap
     for as long as a reading stayed fresh. The memory lives in `SessionState.clutterSpoken` instead,
     with the lifetime of the reading it guards (item 5).
   - New `export interface DeskIssuer { theDesk(): Promise<{ id: string; connected: boolean;
     hasArm: boolean } | null>; issue(deskId: string, request: { type: string; payload:
     Record<string, unknown> }): Promise<DeskActionRecord> }` and `LoopDeps.desk?: DeskIssuer`.
2. **`services/desk.ts`** — `issueAction` waits longer for the one action that is a sweep:
   `export const SURVEY_ACK_TIMEOUT_MS = 25_000`, and `issueAction` uses it when
   `action.type === 'desk.survey'` (`const timeoutMs = action.type === 'desk.survey' ?
   SURVEY_ACK_TIMEOUT_MS : ACK_TIMEOUT_MS`). `desk.survey` stays **out** of `RETRYABLE` — a retried
   sweep moves the arm again and takes more frames, the same reason `capture` is out.
3. **New `observe/survey.ts`** — the pass, thin like `assess.ts`, all seams injected:

```ts
export interface SurveyPassInput {
  sessionId: string; trigger: SurveyTrigger; goal: Goal; window: SignalWindow
  desk: DeskIssuer; reader: SessionReader; writer: ObservationWriter
  vision: VisionProvider; bus: Bus; clock: Clock; logger: LoopDeps['logger']
  poses: number
}
export const SURVEY_BUDGET_MS = 20_000
export interface SurveyOutcome { reading: ClutterReading; poses: DeskSurveyPose[]; observation: Observation }
export async function surveyDesk(input: SurveyPassInput): Promise<SurveyOutcome | null>
```

   Order: `theDesk()` (null → log `survey.skip: no desk`, return null) → `issue(desk.id, { type:
   'desk.survey', payload: { reason: `survey:${trigger}`, poses } })` → a status that is not `done`
   or a null `result.survey` → log `survey.failed` with `record.error` and return null →
   `reader.surveyFrames(sessionId, poses.map(p => p.seq))` (empty → log `survey.skip: no frames`) →
   `vision.survey({ goal, window, frames })` inside `withBudget(..., SURVEY_BUDGET_MS)`, held to
   `ClutterReading.safeParse` (a throw or an invalid shape → log `survey.assess_failed`, return null)
   → `writer.write({ sessionId, window, assessment: null, tier: 0, action: null, outcome: null,
   confidence: reading.confidence, reason: `survey:clutter:${reading.score.toFixed(2)}`, latencyMs,
   survey: reading })` → `bus.publish(sessionId, { event: 'observation', data: observation })` → log
   `survey.sweep` with `{ trigger, poses: poses.length, withAim: poses.filter(p => p.aim !== null).length,
   durationMs }` (`withAim` is how the log says a physical point is possible at all — a sweep with no
   calibration has none) → return the outcome.
4. **`policy.ts`** — two pure additions, no I/O:
   - `export const SURVEY = { startDelayMs: 120_000, awayIdleSeconds: 120 } as const` and

```ts
export type SurveyTrigger = 'start' | 'away' | 'floor'
export interface SurveyDueInput {
  now: number; idleSeconds: number; sessionStartedAt: number
  lastSurveyAt: number | null; lastSurveyAway: boolean; deskConnected: boolean; policy: Policy
}
export function surveyDue(input: SurveyDueInput): SurveyTrigger | null
```

     exactly: `!deskConnected → null`; `lastSurveyAt !== null && now - lastSurveyAt <
     policy.surveyGapMs → null`; then `lastSurveyAt === null` → `now - sessionStartedAt <
     SURVEY.startDelayMs ? (idleSeconds >= SURVEY.awayIdleSeconds ? 'away' : null) : 'start'`;
     else `idleSeconds >= SURVEY.awayIdleSeconds && !lastSurveyAway → 'away'`;
     else `now - lastSurveyAt >= policy.surveyFloorMs → 'floor'`; else `null`.
   - `PolicyInput` gains `clutter?: { reading: ClutterReading; at: number; poses: { aim: { x: number;
     y: number } | null }[]; lastSpokenAt: number | null; lastSpokenScore: number | null;
     pointedThisSession: boolean } | null`.
   - `decide` replaces `if (assessment.onTask) return null` with: on task, `return input.clutter ?
     clutterDecision(...) : null`. The `activity === 'away'` silence stays **above** it, so nothing is
     ever said to an empty desk; the drift ladder keeps the airtime whenever the person is off goal.
   - `clutterDecision`, in order: confidence below `policy.minConfidence` → null; `now - at >
     CLUTTER_FRESH_MS` (module const, 600_000) → null; `reading.score < policy.clutterSpeakScore` →
     null; `lastSpokenScore !== null && reading.score < lastSpokenScore + policy.clutterRiseDelta` →
     null; no `speak` permission or `maxTier < 3` → null; the adapted speech gap from
     `lastSpokenAt` → null; `lastSpokenScore !== null && now - clutterLastSpokenAt <
     policy.clutterGapMs` → null. Then one tier-3 intervention:

```ts
const worst = reading.hotspots[0] ?? null
const aim = worst ? (poses[worst.poseIndex]?.aim ?? null) : null
const point = goal.permissions.includes('automate') && aim !== null && !pointedThisSession ? aim : null
return {
  tier: SPEECH_TIER, channel: 'speech', message: clutterMessage(reading),
  action: null, reversible: false, point, reason: `tier${SPEECH_TIER}:speak:clutter${worst ? `:${worst.label}` : ''}`,
}
```

     `reversible: false` because a point is a gesture, not a change to the machine: nothing is left
     to undo, and the tracker re-acquires the person as soon as the move ends.
   - `CLUTTER_LINES: Record<ClutterLabel, string>`, copied verbatim, picked by the worst hotspot's
     label and falling back to `other`:

```ts
papers:  'Paper has taken over the desk. Clear the pile and get back to it.'
cups:    'The cups have piled up. Take them out and settle back in.'
dishes:  'Yesterday’s dishes are still on the desk. Clear them and get back to it.'
food:    'There is food on the desk. Clear it away and get back to it.'
cables:  'The cables have become a nest. Tidy them and get back to it.'
clothes: 'Clothes have landed on the desk. Clear them and get back to it.'
tools:   'Tools are spread across the desk. Put them away and get back to it.'
boxes:   'Boxes are crowding the desk. Clear them and get back to it.'
bottles: 'Bottles have collected on the desk. Take them out and get back to it.'
other:   'The desk has filled up. Clear it and get back to it.'
```

5. **`index.ts`** (the loop) — `SessionState` gains `surveyInFlight: boolean`, `lastSurveyAt: number
   | null`, `lastSurveyAway: boolean`, `clutterSpoken: { at: number; score: number } | null`,
   `pointedThisSession: boolean`, `deskId: string | null` (set by
   a successful desk lookup in `runSurvey`, so the point has an address without a second query) and
   `clutter: { reading: ClutterReading; at: number; poses: DeskSurveyPose[] } | null`. The `Loop`
   interface gains `runSurvey(sessionId: string, trigger?: SurveyTrigger | 'manual'):
   Promise<SurveyAttempt>` — it never rejects, so both the scheduler and a route can call it, and it
   answers with *why* when it took no reading, because the manual route has to say so honestly:

```ts
export type SurveyAttempt =
  | { ok: true; reading: ClutterReading; poses: DeskSurveyPose[]; observation: Observation }
  | { ok: false; reason: string }
```
   The refusal `reason` is a `string`, not the closed union an earlier draft had: the loop's own codes
   (`gap`, `busy`, `no_desk`, `no_frames`, `assess_failed`) and the rig's word for a sweep it refused
   (`survey_unavailable`, `no_frame`, `survey_timeout`, `desk_offline`, `ack_timeout`) both have to
   reach the panel, which keys its copy on them.
   - The tick clears the away latch while the window is in hand: `if (window.idleSeconds <
     SURVEY.awayIdleSeconds) current.lastSurveyAway = false` — an absence earns one sweep, so the
     latch has to clear when the person is back, or the *second* absence in a session never gets one,
     which is the ordinary shape of a study session (leave, get read, return, leave again).
   - `runWindow`'s `decide(...)` call gains `clutter: state.clutter ? { reading, at, poses:
     poses.map(p => ({ aim: p.aim })), lastSpokenAt, lastSpokenScore, pointedThisSession } : null`,
     where the two speech values come from `state.clutterSpoken` (`{ at, score } | null`, `null` in
     `freshState()`): the session's own memory of the last desk **line**, stamped after `act()` when
     the intervention that went out was the desk one — its reason starts with `tier3:speak:clutter`,
     which is the line's identity, because the drift ladder can also speak at tier 3.
   - After `act()` writes the row: when `finalIntervention?.point` is set, `state.pointedThisSession =
     true` and issue the point **detached** (`void deps.desk?.issue(deskId, { type: 'arm.point',
     payload: intervention.point }).then(r => log).catch(err => log)`) — the line has already been
     delivered and the row written, so a failed point is a log line, never a lost intervention. The
     desk id comes from the `theDesk()` lookup cached in `SessionState` at survey time.
   - `runSurvey(sessionId, requested?)`: guard `surveyInFlight`; read `deps.reader.window` (null →
     return null); `desk = await deps.desk?.theDesk()` (no desk or `!desk.connected` → log
     `survey.skip: no desk`, return null); resolve the trigger: when `requested` is given it wins
     (`'manual'`), otherwise `surveyDue({ now, idleSeconds: window.idleSeconds, sessionStartedAt:
     await deps.reader.sessionStartedAt(sessionId) ?? now, lastSurveyAt, lastSurveyAway,
     deskConnected: desk.connected, policy: await deps.reader.policyFor(sessionId) })` — null means
     nothing is due, and a null session start means skip. **The gap rule applies to `'manual'` too**:
     `lastSurveyAt !== null && now - lastSurveyAt < policy.surveyGapMs` → log `survey.skip: gap` and
     return null, whatever asked.
   - `SessionReader` gains `sessionStartedAt(sessionId): Promise<number | null>` (one Prisma
     `session.findUnique` select of `startedAt`), used only here.
   - On a trigger: `poses = trigger === 'start' ? 1 : desk.hasArm ? 3 : 1` — the start reading is a
     single frame from where the camera already is, because moving the arm across the desk two
     minutes after someone sat down is a gesture nobody asked for; the away, floor and manual
     readings are the sweep. Then `attempt = await surveyDesk({...})`; **the gap binds attempts, not
     successes** — `state.lastSurveyAt = now` is set on a refusal too, because keyed on a reading a
     rig that refuses every sweep leaves it untouched and `surveyDue` asks for a `start` sweep on
     every window: 20 s of arm time and a model call per tick, forever. On success set `state.clutter
     = { reading, at: deps.clock.now(), poses }`, `state.lastSurveyAway = trigger === 'away'` (one
     sweep per absence means one that *happened*), and log `observe.survey` with `{ sessionId,
     trigger, poses: poses.length, score, hotspots: reading.hotspots.length, confidence, latencyMs }`.
     Return the attempt, which is what the manual route answers with.
6. **`persistence.ts`** — `createPrismaReader` gains `surveyFrames(sessionId, seqs)` (the
   `listFrames(sessionId, 'survey')` ring filtered to `seqs`, bytes via the injected `frameBytes` else
   `getFrame`, `kind: 'desk'`, dimensions from the meta) and `sessionStartedAt(sessionId)`;
   `createPrismaWriter.write` writes `survey: input.survey ?? null` and `Observation.parse` carries
   `survey` (replacing the `survey: null` line `091` left in `toApiObservation`); **`recentOutcomes` adds `survey: null` to its `where`** so a clutter row can
   never be mistaken for a drift escalation of the same `kind`; **`consecutiveOffGoal` continues past
   a row whose assessment does not parse instead of breaking** — today a `budget_exceeded` row
   already resets the drift ladder by accident, and survey rows would do it on purpose.
   `createPrismaLoop` passes `desk` through to `LoopDeps`.
7. **`runtime.ts`** — `LoopRuntimeInput` gains `deskIssuer?: DeskIssuer` (tests) and the default is
   built inline from `services/desk.js`: `{ theDesk: async () => { const d = await getTheDesk();
   return d ? { id: d.id, connected: isDeskConnected(d.id), hasArm: d.arm !== null } : null },
   issue: (id, request) => issueAction(id, buildAction(request)) }`. `createPrismaLoop` receives it.
8. **`scheduler.ts`** — in the per-session loop, after `await deps.loop.runWindow(sessionId)`, call
   `void deps.loop.runSurvey(sessionId)` **without awaiting** (a sweep must not stretch the tick or
   delay the next session), and note in the docstring that `runSurvey` never rejects and guards its
   own overlap.
9. **New `observe/live.ts` + the manual route + `src/index.ts`** — the loop is built outside
   fastify, so a route reaches it the way the sockets do, through a module-level handle:
   - `observe/live.ts`: `let loop: Loop | null = null`; `export const attachLoop = (l: Loop | null):
     void => { loop = l }`; `export const theLoop = (): Loop | null => loop`. One owner, one writer,
     same shape as `ws/live-desktop.ts`'s socket index.
   - `src/index.ts`: after the runtime is built, `attachLoop(runtime?.loop ?? null)`; in `shutdown`,
     `attachLoop(null)` before `scheduler.stop()`. Nothing else in the boot changes.
   - `routes/desk.ts`: new `POST /v1/desks/:id/survey` (preHandler `requireUser`), answering
     `DeskSurveyResponse`. Order: `deskRowExists(id)` false → 404; the open session with the same
     `prisma.session.findFirst({ where: { endedAt: null }, orderBy: { startedAt: 'desc' }, select: {
     id: true } })` the frame route already uses → none → 409 `{ error: 'no_open_session' }`;
     `theLoop()` null (no key, no loop) → 503 `{ error: 'loop_unavailable' }`; otherwise
     `const attempt = await theLoop().runSurvey(session.id, 'manual')` and answer
     `{ reading: attempt.ok ? attempt.reading : null, poses: attempt.ok ? attempt.poses.length : 0,
     reason: attempt.ok ? null : attempt.reason }`. It is honest about the gap: a refused sweep answers
     `reading: null`, `poses: 0` with the reason — never a reading it did not take.
10. **`lib/rows.ts`** — `toApiObservation` gains `survey: optionalField(ClutterReading, row.survey,
    { rowId: row.id, field: 'survey' })`, so the SSE replay, `GET /v1/sessions/:id` and the app all
    see the reading.
11. **`prisma/schema.prisma`** — `Observation` gains `survey Json?` under `assessment`. Apply with
    `pnpm --filter @heli/server exec prisma db push` (additive; **not** `db:reset`, which would wipe
    the seed).
12. **`docs/02-intervention-policy.md`** — §1 note that tier 3 can be a desk line; §2 the clutter
    rule as written above (fresh reading, present and on task, above `clutterSpeakScore`, worse than
    the last line, inside both gaps); §6 the five new defaults; §3 note that a clutter line is judged
    by the same outcome machinery (its next window).
13. **Tests** — `test/policy.test.ts`: `surveyDue` for every branch (disconnected, gap, young session,
    start, away once per absence, floor), and `clutterDecision` (doubt, stale, low score, not risen,
    no speak, speech gap, clutter gap, and the point only with `automate` + an aim + not already
    pointed). `test/survey.test.ts` with fakes (a `DeskIssuer` returning a scripted ack, a
    `VisionProvider` returning a fixed reading, an in-memory writer/reader): a `done` ack with three
    poses → the three frames read by seq → one row with `survey` and tier 0 → the reading stashed; a
    `failed` ack → no model call and no row; a fresh reading plus an on-task assessment in
    `runWindow` → a tier-3 intervention with the label line and the point; the point issued once; and
    a manual `runSurvey` inside `surveyGapMs` → `null`, no desk action issued.
    `test/loop.test.ts`: existing fakes gain the new optional seams; add one case that a survey row in
    the history does not break `consecutiveOffGoal`.

**Done when:** `pnpm --filter @heli/server test` passes; with a live session
`POST /v1/desks/:id/survey` answers a reading and the log shows `observe.survey`; a second call
inside the gap answers `reading: null` with no new `vision.survey` line; and after a cluttered
reading the next window's `loop.window` line shows `tier: 3`.

### HELI-096 · feat(desktop): the desk reading on the live view, and a sweep on demand
**Depends:** 091 **Parallel-safe:** yes (with 092, 093, 094) **Owner:** 3 · desktop + web
**Touches:** `apps/desktop/src/lib/live.ts`, `apps/desktop/src/lib/api.ts`, `apps/desktop/src/components/session/Thinking.tsx`, `apps/desktop/src/components/session/Ribbon.tsx`, `apps/desktop/src/routes/live.tsx`, `apps/desktop/src/routes/goal.tsx`, `apps/desktop/src/components/desk/DeskPanel.tsx`
**Do:**
1. **`lib/live.ts`** — a survey row is an observation, not a window, and every counter in `derive()`
   must know that:
   - `windows: Observation[]` (new) = `s.observations.filter(o => o.survey === null)`;
     `latestSurvey: Observation | null` (new) = the last row with `survey !== null`.
   - `minutes`, the focused/off/switch folds and the `quietFor` scan iterate `windows`, not
     `s.observations`.
   - `latest` becomes the newest row **with an assessment** (`windows.at(-1) ?? null`), so a survey
     row can never clear the tray's `off_task` state or blank the Thinking panel.
2. **`routes/live.tsx`** — pass `d.windows` to `Ribbon` and `d.latestSurvey` to `Thinking`; nothing
   else on the route changes.
3. **`Thinking.tsx`** — `decision(o)` gains, before the tier switch, `if (o.survey) return \`read the
   desk — ${word(o.survey.score)}\`` where `word` maps `< 0.3` → `clear`, `< 0.6` → `busy`, else
   `cluttered`. The panel gains a desk block rendered when `latestSurvey?.survey` is present, above
   the footer: the word and the score (`0.72`), the worst hotspot's label, the reading's `evidence`
   lines, and how long ago the sweep was — all from tokens (`text-body`, `text-text-muted`,
   `border-border`), no raw colour, no field names in the copy.
4. **`Ribbon.tsx`** — its per-cell title falls back to `o.survey?.because` when there is no
   assessment, so a survey cell still says something true.
5. **`routes/goal.tsx`** — in the "It may" group, one row beside the existing ones, in teaching
   language: `label="Look at the desk"`, `detail={\`It checks how cluttered the desk is, at most once
   every ${Math.round(p.surveyFloorMs / 60000)} min, and only mentions it when it is worth it.\`}`,
   `Switch` bound to nothing new (the survey is not a permission) — render it as a `Row` with a
   muted detail and no control, exactly like a value that has no switch today.
6. **`lib/api.ts`** — one helper beside `deskAction`: `surveyDesk: (deskId: string) =>
   call('POST', \`/desks/${encodeURIComponent(deskId)}/survey\`, DeskSurveyResponse.nullable(), () =>
   null, undefined, 30_000)` — the sweep plus the model call take seconds, so this one gets its own
   longer timeout the way `draftGoal` does.
7. **`DeskPanel.tsx`** — a "Check the desk now" row in the desk group, following the existing
   `follow()` pattern: `api.surveyDesk(d.id)`, a `sweeping` state while it is in flight, and a
   `sweepNote` of `the desk is cluttered (0.72)` / `the desk is clear` / `it looked a moment ago —
   not again yet` / the mapped refusal, from a `SURVEY_ERRORS` map beside `TRACK_ERRORS`
   (`survey_unavailable: 'This rig has no camera to sweep with.'`, `no_frame: 'The camera did not
   answer.'`, `survey_timeout: 'The sweep took too long; it stopped where it was.'`, `desk_offline:
   'Lumi One is not connected.'`, `loop_unavailable: 'The server is not watching this session.'`).
   The row's label reads `Sweeping…` while `sweeping` or `h?.surveying` is true, and its detail is
   `sweepNote` when there is one. The reading also arrives on the live view over SSE; the panel shows
   what its own call answered.

**Done when:** with a live session, pressing "Check the desk now" sweeps the desk and the row reports
the reading it took; the live view's "What it is thinking" panel shows the desk reading with its
label; and a survey row does not change the session's minute count or the interruption ribbon's cells.

---

### HELI-097 · fix(server): keep survey rows out of the window folds
**Depends:** 095 **Parallel-safe:** yes (with 096) **Owner:** 2 · server
**Touches:** `apps/server/src/services/analytics.ts`, `apps/server/src/services/mobile.ts`, `apps/server/src/services/session.ts`
**Why:** a survey row carries the same `signals` window the pass just assessed, so any reader that
folds observations into per-minute metrics counts that window twice. The review found four: the
analytics summary (the window's focused and off-task seconds again, a phantom `tierHistogram['0']`,
its app seconds again, a second heatmap sample of the same `onTaskRatio`, and — worst — a truncated
`longestFocusRunSeconds`, because a row with no assessment is not a focus run), the phone's poll (the
newest observation for a window after every sweep *was* the sweep, so the headline fell to
"Watching", `judgedAt` named the sweep and the ring gained a phantom cell), the session detail (the
history ribbon and the session sheet shifted a cell per sweep), and the assess frame read (which must
never take a survey frame). This is a row of its own rather than a repair inside `095` because it
lands after `095`, and because the invariant it enforces outlives the feature.
**Do:**
1. **`services/analytics.ts`** — `observationWhere` returns `{ ...(ts ? { ts } : {}), survey: { equals:
   Prisma.AnyNull } }`. `Prisma.AnyNull`, not `null`: `Observation.survey` is a nullable **Json**
   column, so a bare `null` is the JSON null and does not match the SQL NULL the writer stores — and
   TS rejects it (`JsonNullableFilter` has no `null`).
2. **`services/mobile.ts`** — the nested observations select in `phoneSession` gains the same `where`.
3. **`services/session.ts`** — `childrenOf`'s `findMany` gains it, which fixes `GET /v1/sessions` and
   `getSessionDetail` in one place; `observationCount` is derived from the mapped children, so it
   stays consistent by construction.
The case that pins the assess read — that a `survey` frame never reaches the model — is `093`'s test
file and lands in the server commit (`093`/`094`/`095`), which is the first commit where the reader
loop and the case can be green together. The rest of the review's findings are corrections to the
rows that own them and land there: the `FRAME_SOURCES` docstring in `093`, and the
`DeskSurveyResponse` refusal vocabulary plus §1's consumer invariant in `091` — both are statements
*about* the contract, so the contracts row carries them.

**Done when:** the three reads leave survey rows out, the new frames case goes red on a revert of
`095`'s reader line and green with it, and the root typecheck and lint are green.

---

## Exit criteria

- A sweep is **one desk action and one model call** — never one call per frame, and never a second
  sweep inside `policy.surveyGapMs`.
- **The tracking loop is never fought**: the sweep's arm moves sit inside its own freeze, the cadence
  is parked for the whole sweep, and the start pose is restored at the end.
- **The reading is on the observation row** (`survey`), not in a log line — and a survey row is an
  observation, not a window: it never moves a counter, a minute or a ribbon cell.
- **The line only happens when the policy allows it**: present and on task, reading fresh and above
  `clutterSpeakScore`, worse than the last line it spoke, inside both gaps — and the physical point
  only with the goal's `automate` permission, an `aim` from the calibration, and a session that has
  not already pointed.
