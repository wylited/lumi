"""HELI-045's dispatcher: every action answered, and answered truthfully.

The stubs are the frozen collaborators, so what these tests point at is the ack
the server would store — the seq of the frame that was taken, the pose the arm
actually achieved, and the refusal by name for the things this desk cannot do.
A refusal is a result here, not a gap: the loop decides what to do about it.
"""

from __future__ import annotations

import logging

import pytest

from heli_rig.actions import Dispatcher
from heli_rig.arm.driver import ArmPose, ArmUnavailable
from heli_rig.camera import Frame
from tests.fake_desk import FakeArm, FakeCapture, FakeSource, rig_config

log = logging.getLogger("tests.actions")

CAMERA = {"model": "USB Camera", "maxWidth": 640, "maxHeight": 480, "zoom": False}


def frame() -> Frame:
    return Frame(jpeg=b"\xff\xd8jpeg", width=640, height=480, captured_at="2026-09-19T14:02:11.482Z")


def ack(action_id: str, status: str, *, pose=None, seq=None, zoom=None, duration_ms=None, error=None) -> dict:
    """The whole ack, spelled out: the contract's result carries every field."""
    return {
        "t": "action.ack",
        "actionId": action_id,
        "status": status,
        "result": {"pose": pose, "seq": seq, "zoom": zoom, "durationMs": duration_ms},
        "error": error,
    }


def action(action_id: str, kind: str, **payload) -> dict:
    return {"t": "action", "id": action_id, "issuedAt": "2026-09-19T14:02:11.482Z", "type": kind, "payload": payload}


def desk(cfg, *, frames=(), arm=None, caps: dict | None = None):
    """A dispatcher with a camera, an arm and an idle cadence of their own."""
    capture = FakeCapture(frames, last_seq=6)
    capture.source = FakeSource(dict(CAMERA) if caps is None else caps)
    return Dispatcher(capture, arm, None, cfg, log), capture


def config(tmp_path):
    return rig_config(tmp_path, api_url="http://127.0.0.1:3001", HELI_FPS="3")


@pytest.mark.asyncio
async def test_capture_acks_the_seq_of_the_frame_it_took(tmp_path):
    dispatcher, capture = desk(config(tmp_path), frames=[frame()])

    answer = await dispatcher.handle(action("a-1", "capture", reason="assess"))

    # lastSeq counted 6 frames before this one, so the frame just taken is 7.
    assert answer == ack("a-1", "done", seq=7)
    assert capture.capture_calls == 1  # exactly one frame, never a second


@pytest.mark.asyncio
async def test_a_capture_with_no_frame_is_refused_by_name(tmp_path):
    dispatcher, _ = desk(config(tmp_path))  # the camera is down: nothing to hand out

    answer = await dispatcher.handle(action("a-1", "capture", reason=None))

    assert answer == ack("a-1", "failed", error="no_frame")


@pytest.mark.asyncio
async def test_no_arm_refuses_every_arm_action_and_leaves_the_rest_working(tmp_path):
    dispatcher, _ = desk(config(tmp_path), frames=[frame()], arm=None)

    arm_actions = [
        action("a-1", "arm.aim", pan=10.0, tilt=-3.0),
        action("a-2", "arm.point", x=120.0, y=-40.0),
        action("a-3", "arm.nod", times=2),
        action("a-4", "arm.home"),
    ]
    for asked in arm_actions:
        assert await dispatcher.handle(asked) == ack(asked["id"], "failed", error="no_arm")

    # An absent arm is not a broken desk.
    assert (await dispatcher.handle(action("a-5", "capture", reason=None)))["status"] == "done"


@pytest.mark.asyncio
async def test_a_camera_without_zoom_is_refused_by_name(tmp_path):
    dispatcher, _ = desk(config(tmp_path))

    answer = await dispatcher.handle(action("a-1", "camera.zoom", factor=2.0))

    assert answer == ack("a-1", "failed", error="no_zoom")


@pytest.mark.asyncio
async def test_a_camera_that_reports_zoom_still_cannot_be_zoomed_and_says_so(tmp_path):
    # The frozen `FrameSource` reports what the device takes but exposes no
    # setter, so the supported branch is still a failure — named so a reader can
    # tell it from a camera that has no zoom at all.
    dispatcher, _ = desk(config(tmp_path), caps={**CAMERA, "zoom": True})

    answer = await dispatcher.handle(action("a-1", "camera.zoom", factor=2.0))

    assert answer == ack("a-1", "failed", error="zoom_unimplemented")


@pytest.mark.asyncio
async def test_the_retired_exposure_action_is_refused_rather_than_crashing(tmp_path):
    # The landed union has no `camera.exposure`: the server cannot send one, and
    # a rig that knew the old device contract can, so it is an unknown action.
    dispatcher, _ = desk(config(tmp_path))

    answer = await dispatcher.handle(action("a-1", "camera.exposure", value=0.5))

    assert answer == ack("a-1", "failed", error="unknown_action")


@pytest.mark.asyncio
async def test_stream_start_sets_the_asked_rate_and_stop_returns_to_the_idle_cadence(tmp_path):
    cfg = config(tmp_path)
    assert cfg.fps == 3.0  # the cadence `stream.stop` has to come back to
    dispatcher, capture = desk(cfg)

    started = await dispatcher.handle(action("a-1", "stream.start", fps=7))
    stopped = await dispatcher.handle(action("a-2", "stream.stop"))

    assert started == ack("a-1", "done")
    assert stopped == ack("a-2", "done")
    assert capture.fps_calls == [7.0, 3.0]
    assert capture.state()["fps"] == 3.0


@pytest.mark.asyncio
async def test_aim_point_and_home_ack_the_pose_the_arm_achieved(tmp_path):
    arm = FakeArm(achieved=ArmPose(pan=11.5, tilt=-3.25))
    dispatcher, _ = desk(config(tmp_path), arm=arm)
    achieved = {"pan": 11.5, "tilt": -3.25}

    aimed = await dispatcher.handle(action("a-1", "arm.aim", pan=10.0, tilt=-3.0))
    pointed = await dispatcher.handle(action("a-2", "arm.point", x=120.0, y=-40.0))
    homed = await dispatcher.handle(action("a-3", "arm.home"))

    assert aimed == ack("a-1", "done", pose=achieved)
    assert pointed == ack("a-2", "done", pose=achieved)
    assert homed == ack("a-3", "done", pose=achieved)
    # The request reached the driver unchanged; only the answer is the achieved one.
    assert arm.calls == [("aim", 10.0, -3.0), ("point", 120.0, -40.0), ("home",)]


@pytest.mark.asyncio
async def test_a_nod_acks_how_long_it_took_and_where_it_ended_up(tmp_path):
    arm = FakeArm(achieved=ArmPose(pan=4.0, tilt=1.0))
    dispatcher, _ = desk(config(tmp_path), arm=arm)

    answer = await dispatcher.handle(action("a-1", "arm.nod", times=2))

    assert answer["status"] == "done" and answer["error"] is None
    assert answer["result"]["pose"] == {"pan": 4.0, "tilt": 1.0}
    assert answer["result"]["durationMs"] >= 0
    assert arm.calls == [("nod", 2), ("pose",)]


@pytest.mark.asyncio
async def test_an_arm_error_is_acked_in_the_drivers_own_words(tmp_path):
    arm = FakeArm(fails=ArmUnavailable("armd is not answering on 127.0.0.1:8643"))
    dispatcher, _ = desk(config(tmp_path), arm=arm)

    answer = await dispatcher.handle(action("a-1", "arm.aim", pan=0.0, tilt=0.0))

    assert answer == ack("a-1", "failed", error="armd is not answering on 127.0.0.1:8643")


@pytest.mark.asyncio
async def test_an_unexpected_exception_is_still_an_ack(tmp_path):
    arm = FakeArm(fails=RuntimeError("boom"))
    dispatcher, _ = desk(config(tmp_path), arm=arm)

    answer = await dispatcher.handle(action("a-1", "arm.home"))

    assert answer == ack("a-1", "failed", error="RuntimeError: boom")


@pytest.mark.asyncio
async def test_an_action_with_no_id_is_answered_rather_than_raised(tmp_path):
    dispatcher, _ = desk(config(tmp_path), frames=[frame()])

    answer = await dispatcher.handle({"t": "action", "type": "capture", "payload": {"reason": None}})

    # Nothing to name, so nothing can be acked on the wire; the caller sees a
    # refusal and the log says why.
    assert answer == ack("", "failed", error="bad_action")
