"""The follow loop: one frame in, rates out, and the rules that keep it from being a runaway.

The detector and the law have their own tests. What is pinned here is the clock between them —
what the loop does with a frame, what it does when there is not one, who wins when an action asks
for the arm, and that a broken camera or a broken arm is a log line rather than a dead task.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

import pytest

from heli_rig.arm.gimbal import Gimbal
from heli_rig.camera import Frame
from heli_rig.follow import Tracker
from heli_rig.config import load

log = logging.getLogger("test.follow")

PAN, TILT = "shoulder_pan", "wrist_flex"
JOINTS = (PAN, "shoulder_lift", "elbow_flex", TILT, "wrist_roll")


def cfg(**env):
    return load(env={"HELI_TRACKING": "auto", **env}, argv=[])


class FakeArm:
    """An arm that records what it was told, and can be told to refuse.

    It speaks the three calls the follow loop makes and nothing else, so a test fails
    on the first call the loop invents.
    """

    def __init__(self, *, fails: str | None = None) -> None:
        self.jogs: list[dict] = []
        self.modes: list[str] = []
        self.measured = {joint: 0.0 for joint in JOINTS}
        self.fails = fails

    def _maybe_fail(self, doing: str) -> None:
        if self.fails == doing:
            raise RuntimeError(f"the arm refused {doing}")

    def mode(self, name: str) -> None:
        self._maybe_fail("mode")
        self.modes.append(name)

    def joints(self) -> dict[str, float]:
        self._maybe_fail("joints")
        return dict(self.measured)

    def limits(self) -> dict:
        return {
            "window": {PAN: {"min": -90.0, "max": 90.0}, TILT: {"min": -90.0, "max": 90.0}},
            "park": {joint: 0.0 for joint in JOINTS},
            "measured": dict(self.measured),
        }

    def jog(self, rates: dict[str, float]) -> None:
        self._maybe_fail("jog")
        self.jogs.append(dict(rates))


def gimbal_for(arm: FakeArm) -> Gimbal:
    limits = arm.limits()
    return Gimbal(log, window=limits["window"], park=limits["park"], aim=(0.5, 0.5))


def frame(seq: int = 1) -> Frame:
    """A real, tiny JPEG: the loop decodes what it is handed, so the bytes must be an image."""
    import cv2
    import numpy as np

    ok, encoded = cv2.imencode(".jpg", np.zeros((H, W, 3), dtype=np.uint8))
    assert ok
    return Frame(jpeg=encoded.tobytes(), width=W, height=H, captured_at=f"2026-09-19T00:00:0{seq}.000Z")


class StubDetector:
    """A detector that reports one person whose chest sits wherever the test says."""

    def __init__(self, x: float, y: float) -> None:
        self.x, self.y = x, y
        self.calls = 0

    def detect(self, bgr):
        self.calls += 1
        return [_detection(self.x, self.y)]


#: The frame every test hands the loop. The detection's pixels are in *these* pixels:
#: a chest placed with another frame's dimensions is the bug this constant prevents.
W, H = 64, 48


def _detection(x: float, y: float):
    """A Detection whose chest is at the given normalized position of the test's frame."""
    import numpy as np

    from heli_rig.track.detector import Detection

    cx, cy = x * W, y * H
    keypoints = np.zeros((17, 3), dtype=np.float32)
    for index in (5, 6, 11, 12):  # the chest: shoulders and hips
        keypoints[index] = (cx, cy, 0.9)
    return Detection(bbox=(cx - 8, cy - 16, cx + 8, cy + 16), conf=0.9, keypoints=keypoints)


async def settle(seconds: float = 0.15) -> None:
    """Let the loop take a few ticks at its 10 Hz cadence."""
    await asyncio.sleep(seconds)


class Running:
    """The loop, actually running, as an async context manager.

    Every test below needs the real task: the whole point of this module is the clock
    between a frame and a jog, and a test that only called `_tick()` by hand would not
    see the cadence, the pause, or the failure handling.
    """

    def __init__(self, tracker: Tracker) -> None:
        self.tracker = tracker
        self._task: asyncio.Task | None = None

    async def __aenter__(self) -> Tracker:
        self._task = asyncio.create_task(self.tracker.run(), name="test-follow")
        return self.tracker

    async def __aexit__(self, *exc) -> None:
        assert self._task is not None
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task


# ------------------------------------------------------------------ the modes

@pytest.mark.asyncio
async def test_the_first_tick_puts_the_law_in_track_and_the_arm_in_pose():
    """Two programs, two modes: the law steers only in `track`, and armd applies a jog
    only in `pose`. A loop that set one and not the other computes rates nobody applies.

    It happens on the first tick rather than in the constructor: building a `Tracker` must
    not talk to the arm, or the boot waits on a console round trip.
    """
    arm = FakeArm()
    tracker = Tracker(cfg(HELI_TRACK_FPS="50"), arm, gimbal_for(arm), log)

    assert arm.modes == [], "the constructor talked to the arm"
    async with Running(tracker):
        await settle(0.15)

    assert arm.modes == ["pose"], f"the loop never put the arm in pose: {arm.modes}"


def test_a_rig_configured_off_refuses_to_be_turned_on():
    """`HELI_TRACKING=off` is a decision about this machine, and a socket does not get to
    overrule it: the tracker refuses whoever asks, not only the action handler."""
    arm = FakeArm()
    tracker = Tracker(load(env={"HELI_TRACKING": "off"}, argv=[]), arm, gimbal_for(arm), log)

    assert tracker.on is False
    with pytest.raises(RuntimeError, match="HELI_TRACKING=off"):
        tracker.set_on(True)
    assert arm.modes == []          # nothing was engaged, so nothing was put in a mode


def test_a_failed_engage_does_not_claim_the_rig_is_following():
    """The one pair of claims that must never disagree: the ack and the heartbeat.

    `arm.track { on: true }` on a rig whose armd is not answering acked `failed`, and the very next
    `desk.health` said `following: true` — because `_on` was set before `_engage` talked to the arm.
    A person reading the app would see a Follow me switch on, an error on the action, and an arm
    that is not moving. The state is claimed only once the engage has actually happened.
    """
    arm = FakeArm()
    tracker = Tracker(cfg(), arm, gimbal_for(arm), log)   # `auto`, so it starts following

    # The sequence that found this: turn it off, then ask for it back with an arm that will not
    # take a mode — the live case is a console that has gone away, leaving armd unreachable.
    tracker.set_on(False)
    assert tracker.on is False
    arm.fails = "mode"
    with pytest.raises(RuntimeError, match="refused mode"):
        tracker.set_on(True)
    assert tracker.on is False, "the tracker claims to be following after a failed engage"
    assert tracker.state()["on"] is False

    # And it can still be turned on once the arm answers, so the failure is a state that was not
    # entered rather than a tracker that is now stuck.
    arm.fails = None
    tracker.set_on(True)
    assert tracker.on is True
    assert arm.modes == ["pose"]


def test_tracking_with_no_control_law_refuses_by_name():
    """No arm means no law, and no law means no loop: the refusal names what is missing."""
    tracker = Tracker(cfg(), FakeArm(), None, log)

    with pytest.raises(RuntimeError, match="needs the arm"):
        tracker.set_on(True)


# ------------------------------------------------------------------ the loop

@pytest.mark.asyncio
async def test_a_frame_with_a_person_jogs_the_arm_toward_them():
    """The whole loop: a chest left of centre drives the pan negative, and the arm is told."""
    arm = FakeArm()
    tracker = Tracker(cfg(HELI_TRACK_FPS="50"), arm, gimbal_for(arm), log)
    tracker._detector = StubDetector(0.2, 0.5)   # a person well left of centre
    tracker.set_on(True)

    async with Running(tracker):
        tracker.observe(frame())
        await settle(0.2)

    assert tracker.state()["targets"] == 1
    pan_rates = [jog[PAN] for jog in arm.jogs if PAN in jog]
    assert pan_rates, "the loop never jogged the pan"
    assert min(pan_rates) < 0, f"a person on the left must pull the pan negative: {pan_rates}"


@pytest.mark.asyncio
async def test_the_same_frame_is_detected_once():
    """A frame is work; the same bytes arriving again is not. The capture loop hands over
    every frame it takes, and the follow loop's cadence is its own."""
    arm = FakeArm()
    tracker = Tracker(cfg(HELI_TRACK_FPS="50"), arm, gimbal_for(arm), log)
    detector = StubDetector(0.5, 0.5)
    tracker._detector = detector
    tracker.set_on(True)

    async with Running(tracker):
        shot = frame()
        tracker.observe(shot)
        await settle(0.2)
        after_first = detector.calls
        assert after_first >= 1, "the first frame was never detected"

        tracker.observe(shot)      # the very same object
        await settle(0.15)
        assert detector.calls == after_first, "the same frame was detected twice"

        tracker.observe(frame(seq=2))
        await settle(0.15)
        assert detector.calls > after_first, "a new frame was not detected"


@pytest.mark.asyncio
async def test_a_frozen_loop_stops_jogging_and_holds_the_arm():
    """An action that moves the arm wins: the loop must not keep driving it underneath."""
    arm = FakeArm()
    tracker = Tracker(cfg(HELI_TRACK_FPS="50"), arm, gimbal_for(arm), log)
    tracker._detector = StubDetector(0.2, 0.5)
    tracker.set_on(True)

    async with Running(tracker):
        tracker.observe(frame())
        await settle(0.25)
        assert any(jog.get(PAN, 0.0) != 0.0 for jog in arm.jogs), "the loop never steered"

        tracker.freeze("arm.aim")
        arm.jogs.clear()
        await settle(0.25)
        assert arm.jogs, "a paused loop stopped commanding at all"
        assert all(jog[PAN] == 0.0 and jog[TILT] == 0.0 for jog in arm.jogs if jog), (
            f"a frozen loop must command zero, not keep steering: {arm.jogs}"
        )

        tracker.thaw("arm.aim")
        arm.jogs.clear()
        tracker.observe(frame(seq=2))
        await settle(0.25)
        assert any(jog.get(PAN, 0.0) != 0.0 for jog in arm.jogs), "the loop did not resume"


@pytest.mark.asyncio
async def test_the_freeze_is_counted_so_a_nested_action_does_not_release_it():
    """`arm.home` inside an `arm.nod`: the inner one finishing must not unfreeze the outer."""
    arm = FakeArm()
    tracker = Tracker(cfg(HELI_TRACK_FPS="50"), arm, gimbal_for(arm), log)
    tracker._detector = StubDetector(0.2, 0.5)
    tracker.set_on(True)

    tracker.set_on(True)

    async with Running(tracker):
        tracker.freeze("arm.nod")
        tracker.freeze("arm.home")
        tracker.thaw("arm.home")

        tracker.observe(frame())
        await settle(0.25)
        assert arm.jogs, "the paused loop stopped commanding at all"
        assert all(jog[PAN] == 0.0 for jog in arm.jogs if jog), "the outer freeze was released early"

        tracker.thaw("arm.nod")
        arm.jogs.clear()
        tracker.observe(frame(seq=2))
        await settle(0.25)
        assert any(jog.get(PAN, 0.0) != 0.0 for jog in arm.jogs)


@pytest.mark.asyncio
async def test_turning_tracking_off_holds_the_arm_and_stops_detecting():
    arm = FakeArm()
    tracker = Tracker(cfg(HELI_TRACK_FPS="50"), arm, gimbal_for(arm), log)
    detector = StubDetector(0.2, 0.5)
    tracker._detector = detector
    tracker.set_on(True)

    async with Running(tracker):
        tracker.observe(frame())
        await settle(0.25)

        tracker.set_on(False)
        arm.jogs.clear()
        detector.calls = 0
        tracker.observe(frame(seq=2))
        await settle(0.25)

        assert tracker.on is False
        assert all(jog[PAN] == 0.0 and jog[TILT] == 0.0 for jog in arm.jogs if jog)
        assert detector.calls == 0, "a stopped loop is still spending CPU on detection"


@pytest.mark.asyncio
async def test_no_frame_is_not_a_crash():
    """A camera that has not delivered yet: the loop ticks, jogs zero, and says nothing."""
    arm = FakeArm()
    tracker = Tracker(cfg(HELI_TRACK_FPS="50"), arm, gimbal_for(arm), log)
    tracker.set_on(True)

    async with Running(tracker):
        await settle(0.2)
        assert tracker.state()["error"] is None
        assert tracker.state()["targets"] == 0


# ------------------------------------------------------------------ failures

@pytest.mark.asyncio
async def test_an_arm_that_refuses_a_jog_is_one_log_line_and_the_loop_survives(caplog):
    """A bus that stopped answering must not end the task: the capture loop and the socket
    outlive it, and the rig keeps uploading frames while the arm is broken."""
    arm = FakeArm(fails="jog")
    tracker = Tracker(cfg(HELI_TRACK_FPS="50"), arm, gimbal_for(arm), log)
    tracker._detector = StubDetector(0.2, 0.5)
    tracker.set_on(True)

    async with Running(tracker):
        with caplog.at_level(logging.WARNING):
            tracker.observe(frame())
            await settle(0.4)

        assert tracker.state()["error"] is not None
        assert caplog.text.count("would not take a jog") == 1, "a broken arm logged once per tick"


@pytest.mark.asyncio
async def test_a_model_that_will_not_load_is_reported_and_not_retried(caplog, tmp_path):
    """A missing model is a configuration problem, not a transient one: one line, no loop of
    failures, and the rig carries on."""
    arm = FakeArm()
    tracker = Tracker(
        cfg(HELI_TRACKING="auto", HELI_MODEL=str(tmp_path / "not-a-model.onnx"), HELI_TRACK_FPS="50"),
        arm,
        gimbal_for(arm),
        log,
    )
    tracker.set_on(True)

    async with Running(tracker):
        with caplog.at_level(logging.WARNING):
            tracker.observe(frame())
            await settle(0.4)

        assert tracker.state()["error"] is not None
        assert "cannot load its model" in caplog.text


@pytest.mark.asyncio
async def test_frames_that_are_not_jpegs_are_reported_once(caplog):
    arm = FakeArm()
    tracker = Tracker(cfg(HELI_TRACK_FPS="50"), arm, gimbal_for(arm), log)
    tracker._detector = StubDetector(0.5, 0.5)
    tracker.set_on(True)

    async with Running(tracker):
        with caplog.at_level(logging.WARNING):
            tracker.observe(Frame(jpeg=b"not an image", width=64, height=48, captured_at="now"))
            await settle(0.25)
            tracker.observe(Frame(jpeg=b"still not one", width=64, height=48, captured_at="now"))
            await settle(0.25)

        assert "not decodable" in caplog.text
        assert caplog.text.count("not decodable") == 1


def test_the_velocity_is_zero_for_a_first_sample_and_a_long_gap():
    """The feed-forward term must not invent a speed: a first sample and a stall both report
    none, because a wrong velocity is a joint commanded to move on its own."""
    arm = FakeArm()
    tracker = Tracker(cfg(), arm, gimbal_for(arm), log)

    assert tracker._velocity(0.1, 0.2, 100.0) == (0.0, 0.0)          # nothing to compare
    assert tracker._velocity(0.2, 0.2, 100.1) == (pytest.approx(1.0), pytest.approx(0.0))
    assert tracker._velocity(0.3, 0.2, 103.0) == (0.0, 0.0)          # a 3 s gap is not a velocity
