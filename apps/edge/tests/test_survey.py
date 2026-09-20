"""The sweep: the poses it walks, the bracket it runs inside, and what it reports.

The geometry is a pure function, so it is pinned without an arm: a single pose is the
reading the server takes at session start, a calibrated sweep walks the rectangle's centre
line, and an uncalibrated one pans in steps around where the camera already is.

The sweep itself is pinned against three fakes that share one ordered log, because what
matters about a sweep is not any single call but the *bracket*: the cadence parked and the
follow loop frozen before the first move, both released after the last frame, and the
camera put back where it found it.
"""

from __future__ import annotations

import asyncio
import logging
import time

import pytest

from heli_rig import survey as survey_mod
from heli_rig.arm.calibration import Calibration, RIG_FILE
from heli_rig.arm.driver import ArmPose, ArmUnavailable
from heli_rig.camera import Frame
from heli_rig.capture import CaptureLoop, CaptureResult
from heli_rig.survey import SurveyPose, Surveyor, SurveyTarget, survey_targets
from heli_rig.upload import UploadOutcome
from tests.fake_desk import rig_config

log = logging.getLogger("tests.survey")

START = ArmPose(pan=10.0, tilt=-4.0)
RECT = {"x": 0.0, "y": 0.0, "w": 300.0, "h": 200.0}


def frame(seq: int = 0) -> Frame:
    return Frame(jpeg=b"\xff\xd8jpeg", width=640, height=480, captured_at=f"2026-09-20T10:00:{seq:02d}.000Z")


@pytest.fixture(autouse=True)
def no_settle(monkeypatch):
    """The settle is a servo's need, not this test's: nothing here is waiting on hardware."""
    monkeypatch.setattr(survey_mod, "SURVEY_SETTLE_S", 0.0)


@pytest.fixture
def cfg(tmp_path):
    return rig_config(tmp_path, api_url="http://127.0.0.1:3001")


class Recorder:
    """One ordered log of everything the sweep did, shared by the fakes that served it."""

    def __init__(self) -> None:
        self.events: list[str] = []

    def add(self, event: str) -> None:
        self.events.append(event)


class SurveyCapture:
    """A capture loop as the sweep uses it: a hold counter, and a scripted camera.

    `frames` is one entry per `capture_now` call, so a None is a camera that did not
    answer for that pose. What comes back is a `CaptureResult` like the real loop's -
    the seq climbs per frame - and `outcome` is what the server said about the frame it
    took.
    """

    def __init__(
        self,
        rec: Recorder,
        frames=(),
        *,
        outcome: UploadOutcome | None = None,
        seq: int = 7,
        during=None,
    ) -> None:
        self._rec = rec
        self._frames = list(frames)
        self.outcome = outcome
        self.seq = seq
        #: Called at each frame, for a test that has to look at the rig *during* the sweep
        #: rather than at what it left behind.
        self._during = during
        self.holds = 0
        self.sources: list[str] = []

    def hold(self) -> None:
        self.holds += 1
        self._rec.add("hold")

    def release(self) -> None:
        self.holds = max(0, self.holds - 1)
        self._rec.add("release")

    async def capture_now(self, source: str = "camera") -> CaptureResult | None:
        self.sources.append(source)
        self._rec.add(f"capture:{source}")
        if self._during is not None:
            self._during()
        if not self._frames:
            return None
        taken = self._frames.pop(0)
        if taken is None:
            return None
        self.seq += 1
        return CaptureResult(frame=taken, seq=self.seq, outcome=self.outcome or accepted())


class SurveyArm:
    """An arm that says where it is, moves where it is told, and can refuse one move.

    `fails` is keyed by the ordinal of the *move* (the first aim or point is 1), not by the
    call, so a test says "the second pose is out of travel" without counting pose reads.
    """

    def __init__(
        self,
        rec: Recorder,
        *,
        start: ArmPose = START,
        fails: dict[int, BaseException] | None = None,
        slow: float = 0.0,
    ) -> None:
        self._rec = rec
        self.start = start
        self.fails = fails or {}
        self.slow = slow
        self.moves = 0

    def pose(self) -> ArmPose:
        self._rec.add("pose")
        return self.start

    def aim(self, pan: float, tilt: float) -> ArmPose:
        self._rec.add(f"aim({pan:.1f},{tilt:.1f})")
        return self._moved()

    def point(self, x: float, y: float) -> ArmPose:
        self._rec.add(f"point({x:.1f},{y:.1f})")
        return self._moved()

    def _moved(self) -> ArmPose:
        self.moves += 1
        failure = self.fails.get(self.moves)
        if failure is not None:
            raise failure
        if self.slow:
            # A real move takes seconds; the sweep's cap is what this exercises.
            time.sleep(self.slow)
        return self.start


class SurveyTracker:
    """The follow loop, as the sweep sees it: a counted freeze and nothing else."""

    def __init__(self, rec: Recorder) -> None:
        self._rec = rec
        self.freezes: list[str] = []
        self.thaws: list[str] = []

    def freeze(self, doing: str) -> None:
        self.freezes.append(doing)
        self._rec.add("freeze")

    def thaw(self, doing: str) -> None:
        self.thaws.append(doing)
        self._rec.add("thaw")


def refused() -> UploadOutcome:
    return UploadOutcome(False, 409, None, None, None, None, "no_open_session", False)


def accepted() -> UploadOutcome:
    return UploadOutcome(True, 201, "ref", None, 640, 480, None, False)


def calibrate(cfg, rect: dict = RECT, poses: int = 3) -> None:
    """Record a rectangle the way `--calibrate` does, plus the pairs that make it usable."""
    calibration = Calibration.load(cfg.heli_dir / RIG_FILE)
    calibration.set_rect(rect)
    for i in range(poses):
        calibration.add_pose(10.0 * i, 20.0 * i, 1.0 * i, -2.0 * i)
    calibration.save()


# ---- the poses a sweep walks ------------------------------------------------


def test_a_single_pose_sweep_is_the_pose_the_arm_is_already_in():
    """The start reading: the camera already points at the desk, so nothing moves."""
    assert survey_targets(1, START, None) == [SurveyTarget("aim", pan=START.pan, tilt=START.tilt)]


def test_a_single_pose_sweep_with_no_arm_takes_the_frame_where_the_camera_points():
    """No arm, or an arm that will not report a pose: the frame is still worth taking."""
    assert survey_targets(1, None, None) == [SurveyTarget("aim")]


def test_a_calibrated_sweep_walks_the_rectangle_centre_line():
    targets = survey_targets(3, START, RECT)

    # Inside the rectangle, evenly spaced, on its horizontal centre line: 50, 150, 250 mm
    # of a 300 mm desk, all at 100 mm down.
    assert targets == [
        SurveyTarget("point", x=50.0, y=100.0),
        SurveyTarget("point", x=150.0, y=100.0),
        SurveyTarget("point", x=250.0, y=100.0),
    ]


def test_a_calibrated_sweep_needs_no_start_pose():
    """The rectangle is the whole mapping: where the arm happens to be is irrelevant."""
    assert [target.kind for target in survey_targets(2, None, RECT)] == ["point", "point"]


def test_an_uncalibrated_sweep_pans_in_steps_around_the_start_pose():
    targets = survey_targets(3, START, None)

    # Twelve degrees apart around the start, dropped eight: the desk, not the wall.
    assert targets == [
        SurveyTarget("aim", pan=-2.0, tilt=-12.0),
        SurveyTarget("aim", pan=10.0, tilt=-12.0),
        SurveyTarget("aim", pan=22.0, tilt=-12.0),
    ]


def test_a_sweep_with_no_pose_to_offset_from_is_one_frame():
    """An arm that would not say where it is has no line to walk; `count` frames of the
    same view would tell the model they are left to right across a desk they do not cross."""
    assert survey_targets(3, None, None) == [SurveyTarget("aim")]


# ---- the sweep --------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_sweep_holds_the_cadence_and_freezes_the_follow_loop_for_all_of_it(cfg):
    """The bracket, in order: one hold, one freeze, every frame inside them, and the arm
    put back where it was found before either is let go."""
    rec = Recorder()
    capture = SurveyCapture(rec, [frame(), frame(), frame()])
    tracker = SurveyTracker(rec)
    surveyor = Surveyor(capture, SurveyArm(rec), cfg, log, tracker=tracker)

    report = await surveyor.sweep(3, "manual")

    assert rec.events == [
        "hold",
        "freeze",
        "pose",
        "aim(-2.0,-12.0)",
        "capture:survey",
        "aim(10.0,-12.0)",
        "capture:survey",
        "aim(22.0,-12.0)",
        "capture:survey",
        "aim(10.0,-4.0)",  # back to the start pose the sweep found
        "thaw",
        "release",
    ]
    assert tracker.freezes == ["desk.survey"] and tracker.thaws == ["desk.survey"]
    assert capture.holds == 0, "the cadence is never left parked"
    assert [pose.index for pose in report.poses] == [0, 1, 2]
    assert capture.sources == ["survey", "survey", "survey"]


@pytest.mark.asyncio
async def test_a_sweep_reports_the_frames_that_landed(cfg):
    rec = Recorder()
    capture = SurveyCapture(rec, [frame()], seq=6)
    tracker = SurveyTracker(rec)
    surveyor = Surveyor(capture, SurveyArm(rec), cfg, log, tracker=tracker)

    # One pose, so the pose the report carries is the arm's own - it was never commanded.
    report = await surveyor.sweep(1, "survey:start")

    assert report.reason == "survey:start"
    assert report.error is None
    assert report.duration_ms >= 0
    assert report.started_at.endswith("Z")
    assert report.poses == [SurveyPose(index=0, seq=7, pose={"pan": 10.0, "tilt": -4.0}, aim=None)]
    assert rec.events == ["hold", "freeze", "pose", "capture:survey", "thaw", "release"], (
        "a one-pose sweep commands no move and rewinds nothing"
    )


@pytest.mark.asyncio
async def test_a_calibrated_sweep_reports_the_desk_points_it_aimed_at(cfg):
    calibrate(cfg)
    rec = Recorder()
    capture = SurveyCapture(rec, [frame(), frame()])
    surveyor = Surveyor(capture, SurveyArm(rec), cfg, log)

    report = await surveyor.sweep(2, "manual")

    assert rec.events == [
        "hold",
        "pose",
        "point(75.0,100.0)",
        "capture:survey",
        "point(225.0,100.0)",
        "capture:survey",
        "aim(10.0,-4.0)",  # a `point` moves the arm too, so it is rewound like any other
        "release",
    ]
    assert [pose.aim for pose in report.poses] == [{"x": 75.0, "y": 100.0}, {"x": 225.0, "y": 100.0}]


@pytest.mark.asyncio
async def test_a_pose_whose_move_is_refused_is_skipped_and_the_sweep_continues(cfg):
    """One joint outside its travel is one pose lost, not a sweep lost: the frames the
    other poses took are still a reading of the desk."""
    rec = Recorder()
    capture = SurveyCapture(rec, [frame(), frame(), frame()])
    surveyor = Surveyor(capture, SurveyArm(rec, fails={2: ArmUnavailable("outside travel")}), cfg, log)

    report = await surveyor.sweep(3, "manual")

    assert [pose.index for pose in report.poses] == [0, 2], "the middle pose is the one that failed"
    assert report.error is None
    assert rec.events.count("capture:survey") == 2, "the refused pose takes no frame"
    assert capture.holds == 0


@pytest.mark.asyncio
async def test_a_sweep_that_took_no_frame_reports_no_frame(cfg):
    rec = Recorder()
    capture = SurveyCapture(rec, [])
    surveyor = Surveyor(capture, SurveyArm(rec), cfg, log)

    report = await surveyor.sweep(3, "manual")

    assert report.poses == []
    assert report.error == "no_frame"
    assert capture.holds == 0


@pytest.mark.asyncio
async def test_a_partial_sweep_is_done_with_the_poses_it_took(cfg):
    rec = Recorder()
    capture = SurveyCapture(rec, [frame(), None, frame()])
    surveyor = Surveyor(capture, SurveyArm(rec), cfg, log)

    report = await surveyor.sweep(3, "manual")

    assert [pose.index for pose in report.poses] == [0, 2]
    assert report.error is None, "a partial sweep is a truthful report, not a failure"


@pytest.mark.asyncio
async def test_a_frame_the_server_refused_is_not_a_pose(cfg):
    """A pose names the frame the server kept; one it refused has no seq to name."""
    rec = Recorder()
    capture = SurveyCapture(rec, [frame(), frame(), frame()], outcome=refused())
    surveyor = Surveyor(capture, SurveyArm(rec), cfg, log)

    report = await surveyor.sweep(3, "manual")

    assert report.poses == []
    assert report.error == "no_frame"


@pytest.mark.asyncio
async def test_a_rig_with_no_arm_takes_one_frame_and_commands_nothing(cfg):
    """The server only asks a rig with no arm for a single pose, and this is what it gets
    if it ever asks for three: the frame where the camera points."""
    rec = Recorder()
    capture = SurveyCapture(rec, [frame()])
    surveyor = Surveyor(capture, None, cfg, log)

    report = await surveyor.sweep(3, "manual")

    assert rec.events == ["hold", "capture:survey", "release"]
    assert report.poses == [SurveyPose(index=0, seq=8, pose=None, aim=None)]


@pytest.mark.asyncio
async def test_a_rig_with_no_arm_never_claims_a_desk_point(cfg):
    """A calibration on disk does not make an arm: without one the frame was not taken from
    the desk point, and an `aim` here would have the server point at a pile this frame
    never showed."""
    calibrate(cfg)
    rec = Recorder()
    capture = SurveyCapture(rec, [frame(), frame(), frame()])
    surveyor = Surveyor(capture, None, cfg, log)

    report = await surveyor.sweep(3, "manual")

    assert rec.events == ["hold", "capture:survey", "release"]
    assert [pose.aim for pose in report.poses] == [None]


@pytest.mark.asyncio
async def test_a_sweep_that_runs_out_of_time_reports_what_it_got(cfg, monkeypatch, caplog):
    monkeypatch.setattr(survey_mod, "SURVEY_MAX_S", 0.05)
    rec = Recorder()
    capture = SurveyCapture(rec, [frame(), frame(), frame()])
    surveyor = Surveyor(capture, SurveyArm(rec, slow=0.2), cfg, log)

    with caplog.at_level(logging.WARNING, logger="tests.survey"):
        report = await surveyor.sweep(3, "manual")

    assert report.error == "survey_timeout", "the cap is told apart from a camera that never answered"
    assert report.poses == []
    assert capture.holds == 0, "the cap does not leave the cadence parked"


@pytest.mark.asyncio
async def test_the_sweep_says_it_is_sweeping_while_it_runs(cfg):
    """`desk.health.surveying` is a claim about now: true inside the sweep, false after it."""
    rec = Recorder()
    seen: list[bool] = []
    capture = SurveyCapture(rec, [frame()], during=lambda: seen.append(surveyor.surveying))
    surveyor = Surveyor(capture, SurveyArm(rec), cfg, log)

    assert surveyor.surveying is False
    await surveyor.sweep(1, None)

    assert seen == [True], "the heartbeat during a sweep says so"
    assert surveyor.surveying is False, "and it is over when the sweep returns"


# ---- the tick a hold cannot stop ---------------------------------------------


class ParkedSource:
    """A camera whose first `grab()` parks until the test lets it go.

    That park is the one window a hold cannot close: `hold()` stops ticks that have not
    started, and this one is already inside `_take()` when the sweep's hold goes up.
    """

    def __init__(self) -> None:
        self.gate = asyncio.Event()
        self.parked = asyncio.Event()
        self.taken = 0
        self._parks = 0

    async def open(self) -> None:
        pass

    async def is_open(self) -> bool:
        return True

    def describe(self) -> dict:
        return {"model": "Parked camera", "maxWidth": 640, "maxHeight": 480, "zoom": False}

    async def grab(self) -> Frame:
        if self._parks == 0:
            self._parks = 1
            self.parked.set()
            await self.gate.wait()
        self.taken += 1
        return frame(self.taken)

    async def close(self) -> None:
        pass


class FeedingUploader:
    """An uploader that lets the parked tick go while a sweep's frame is in flight.

    Setting the gate inside the upload is what makes the race deterministic: the tick
    resumes between the sweep numbering its frame and the sweep naming it, which is
    exactly the window the sweep used to lose its own number in.
    """

    def __init__(self, parked: ParkedSource) -> None:
        self.uploads: list[tuple[str, int]] = []
        self._parked = parked
        self._fed = False

    async def upload(self, frame: Frame, seq: int, source: str = "camera") -> UploadOutcome:
        self.uploads.append((source, seq))
        if source == "survey" and not self._fed:
            self._fed = True
            self._parked.gate.set()
            await asyncio.sleep(0)  # the parked tick runs before this upload returns
        return accepted()

    async def aclose(self) -> None:
        """Nothing to close: the test's own uploader holds no connections."""


async def parked_sweep(cfg, count: int, arm=None):
    """A real `CaptureLoop` swept while its own tick is parked inside the grab."""
    source = ParkedSource()
    uploader = FeedingUploader(source)
    loop = CaptureLoop(source, uploader, cfg, log)
    surveyor = Surveyor(loop, arm, cfg, log)

    tick = asyncio.create_task(loop.tick())
    await source.parked.wait()  # the tick is inside `_take()`, past the hold guard
    report = await surveyor.sweep(count, "manual")
    dropped = await tick

    return report, uploader, source, dropped


@pytest.mark.asyncio
async def test_a_sweep_names_its_own_frame_when_a_tick_was_parked_under_the_hold(cfg):
    """The session-start reading, which is the case a dropped seq broke outright: one
    pose, one frame, and an ack naming a seq the survey ring does not have."""
    report, uploader, source, dropped = await parked_sweep(cfg, 1)

    assert dropped is None, "a frame taken under the hold is dropped, not numbered"
    assert source.taken == 2, "the tick really did take a frame; it did not send it"
    assert uploader.uploads == [("survey", 1)], "the sweep's frame is the only one uploaded"
    assert [pose.seq for pose in report.poses] == [1], "and the pose names the seq it went up under"
    assert report.error is None


@pytest.mark.asyncio
async def test_a_sweep_of_three_poses_keeps_its_positions_when_a_tick_was_parked(cfg):
    """With three poses the same dropped seq also shifted pose -> frame alignment, which is
    what the physical point is read from."""
    rec = Recorder()
    report, uploader, source, dropped = await parked_sweep(cfg, 3, arm=SurveyArm(rec))

    assert dropped is None
    assert source.taken == 4, "three sweep frames and the one the tick took and dropped"
    assert uploader.uploads == [("survey", 1), ("survey", 2), ("survey", 3)]
    assert [pose.seq for pose in report.poses] == [1, 2, 3]
    assert report.error is None
