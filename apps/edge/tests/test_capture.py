"""The capture cadence: one upload in flight, a slow cadence rather than a spin, and no crash."""

from __future__ import annotations

import asyncio
import logging

import pytest

from heli_rig import capture
from heli_rig.camera import CameraUnavailable, Frame
from heli_rig.capture import CaptureLoop
from heli_rig.upload import UploadOutcome

LOG = logging.getLogger("test.capture")


def ok(ref: str = "ref") -> UploadOutcome:
    return UploadOutcome(True, 201, ref, 1, 640, 480, None, False)


def refused(status: int, error: str, rejected: bool = False) -> UploadOutcome:
    return UploadOutcome(False, status, None, None, None, None, error, rejected)


class FakeSource:
    """A camera that hands out frames on demand, and can be taken away mid-run."""

    def __init__(self) -> None:
        self.taken = 0
        self.opens = 0
        self.opened = True
        self.unplugged = False
        self.stalled = False

    async def open(self) -> None:
        self.opens += 1
        self.opened = True

    async def is_open(self) -> bool:
        return self.opened

    def describe(self) -> dict:
        return {"model": "Fake camera", "maxWidth": 640, "maxHeight": 480, "zoom": False}

    async def grab(self) -> Frame:
        if self.stalled:
            # What `cv2.VideoCapture.read` does when the device stopped answering: it never
            # returns. Not an exception, not a slow frame — the call the tick is waiting on.
            await asyncio.sleep(3600)
        if self.unplugged:
            raise CameraUnavailable("the camera is not plugged in")
        self.taken += 1
        return Frame(
            jpeg=b"\xff\xd8frame",
            width=640,
            height=480,
            captured_at=f"2026-09-19T10:00:{self.taken:02d}.000Z",
        )

    async def close(self) -> None:
        self.opened = False


class FakeUploader:
    """An uploader whose answer — and whose patience — the test decides."""

    def __init__(self, outcome: UploadOutcome | None = None, gate: asyncio.Event | None = None) -> None:
        self.uploaded: list[tuple[Frame, int]] = []
        self.outcome = outcome or ok()
        self.gate = gate

    async def upload(self, frame: Frame, seq: int) -> UploadOutcome:
        self.uploaded.append((frame, seq))
        if self.gate is not None:
            await self.gate.wait()
        return self.outcome

    async def aclose(self) -> None:
        """Nothing to close: the test's own uploader holds no connections."""


async def settle() -> None:
    """Let the loop's background upload task finish; its uploads are tasks, not awaits."""
    for _ in range(5):
        await asyncio.sleep(0)


def test_state_is_what_desk_health_reports(config):
    loop = CaptureLoop(FakeSource(), FakeUploader(), config, LOG)

    # `lastFrameAt` is null until a frame has been taken, and the counters start at zero.
    assert loop.state() == {"fps": 2.0, "lastFrameAt": None, "lastSeq": 0, "frames": 0, "framesSent": 0}


@pytest.mark.asyncio
async def test_a_tick_whose_upload_has_not_returned_takes_and_uploads_nothing(config):
    gate = asyncio.Event()
    source = FakeSource()
    uploader = FakeUploader(gate=gate)  # the first upload never returns
    loop = CaptureLoop(source, uploader, config, LOG)

    first = await loop.tick()
    await settle()  # the upload task is now running and blocked on the gate
    second = await loop.tick()

    assert first is not None
    assert second is None, "a tick with an upload in flight reports nothing"
    assert len(uploader.uploaded) == 1, "and uploads nothing"
    assert source.taken == 1, "and does not spend a frame on it"

    gate.set()
    await settle()


@pytest.mark.asyncio
async def test_a_409_slows_the_cadence_and_a_201_brings_it_back(config, caplog):
    source = FakeSource()
    uploader = FakeUploader(refused(409, "no_open_session"))
    loop = CaptureLoop(source, uploader, config, LOG)

    with caplog.at_level(logging.WARNING, logger="test.capture"):
        await loop.tick()
        await settle()
        assert loop.state()["fps"] == config.fps / 5, "nobody is watching: a fifth of the cadence, not silence"
        await loop.tick()
        await settle()

    assert caplog.text.count("no session is open") == 1, "one line per streak, not one per tick"
    assert len(uploader.uploaded) == 2, "a slowed cadence still captures"

    uploader.outcome = ok()
    await loop.tick()
    await settle()
    assert loop.state()["fps"] == config.fps


@pytest.mark.asyncio
async def test_a_rejected_frame_is_named_and_never_sent_twice(config, caplog):
    source = FakeSource()
    uploader = FakeUploader(refused(422, "frame_rejected:frame_too_wide", rejected=True))
    loop = CaptureLoop(source, uploader, config, LOG)

    with caplog.at_level(logging.WARNING, logger="test.capture"):
        await loop.tick()
        await settle()
        await loop.tick()
        await settle()

    # Once, not once per tick: the streak is what keeps a rejected frame from
    # filling the log with the same line.
    assert caplog.text.count("not resending it") == 1
    sent = [frame for frame, _ in uploader.uploaded]
    assert len(sent) == 2, "each tick takes its own frame"
    assert [seq for _, seq in uploader.uploaded] == [1, 2]
    assert loop.state()["framesSent"] == 0, "health never reports more rejections than frames (it is nonnegative)"


@pytest.mark.asyncio
async def test_capture_now_works_while_the_cadence_is_stopped(config):
    source = FakeSource()
    uploader = FakeUploader()
    loop = CaptureLoop(source, uploader, config, LOG)
    loop.set_fps(0)

    assert await loop.tick() is None, "a stopped cadence takes no frames on its own"
    frame = await loop.capture_now()

    assert frame is not None
    assert len(uploader.uploaded) == 1, "the capture action uploads its own frame before it returns"
    assert loop.state()["lastSeq"] == 1
    assert loop.state()["fps"] == 0.0


@pytest.mark.asyncio
async def test_a_camera_that_stops_answering_does_not_take_the_loop_with_it(config, caplog, monkeypatch):
    """The live incident: a `read` that never returns, and a capture loop that went quiet with it.

    The console opened the same UVC camera underneath the rig, `cv2` stopped returning,
    and because the tick awaits that call the rig delivered no frame for thirteen minutes —
    while `desk.health` went on reporting the configured cadence. A bounded grab turns that
    into the camera failure the loop already survives: one line, the retry pace, and a
    reopen that releases the stuck handle.
    """
    monkeypatch.setattr(capture, "CAMERA_GRAB_TIMEOUT_S", 0.05)
    monkeypatch.setattr(capture, "CAMERA_RETRY_S", 0.05)
    source = FakeSource()
    uploader = FakeUploader()
    loop = CaptureLoop(source, uploader, config, LOG)

    with caplog.at_level(logging.WARNING, logger="test.capture"):
        first = await loop.tick()
        assert first is not None, "the loop was fine until the camera stopped answering"
        await settle()  # its upload is a task: the next tick must not be a skipped one

        source.stalled = True
        assert await loop.tick() is None, "a stalled grab must end the tick, not the loop"
        assert caplog.text.count("did not answer within") == 1, "one line for the stall, not one per tick"

        # And the rig is still a rig: the tick after the stall is an ordinary tick, so the
        # camera coming back ends the outage without anyone restarting anything.
        source.stalled = False
        second = await loop.tick()

    assert second is not None, "the loop never took another frame"
    assert second.captured_at != first.captured_at


@pytest.mark.asyncio
async def test_health_stops_claiming_a_rate_the_camera_is_not_delivering(config, monkeypatch):
    """`desk.health.fps` is read as the rate the rig is delivering ("capture fps"), so it
    must not keep quoting the cadence once frames have stopped. The desk panel showing
    "10 fps" over a frozen picture is the lie this field exists to be able to avoid."""
    monkeypatch.setattr(capture, "FRAME_STALL_FLOOR_S", 0.05)
    # Both halves of the rule, so the test measures the rule rather than the constants: at
    # this cadence three intervals would be a second and a half, and waiting that long for
    # an assertion is how a suite stops being run.
    monkeypatch.setattr(capture, "FRAME_STALL_INTERVALS", 0.0)
    source = FakeSource()
    uploader = FakeUploader()
    loop = CaptureLoop(source, uploader, config, LOG)

    assert loop.state()["fps"] == config.fps, "a rig that has taken its first frame reports its cadence"
    await loop.tick()
    assert loop.state()["fps"] == config.fps, "and keeps reporting it while frames are arriving"

    await asyncio.sleep(0.08)
    assert loop.state()["fps"] == 0.0, "no frames for a while is zero frames a second, not two"

    await loop.tick()
    assert loop.state()["fps"] == config.fps, "one frame later it is delivering again"


@pytest.mark.asyncio
async def test_a_cadence_that_makes_no_sense_is_ignored(config):
    loop = CaptureLoop(FakeSource(), FakeUploader(), config, LOG)

    loop.set_fps(-1)
    loop.set_fps(float("nan"))

    assert loop.state()["fps"] == config.fps, "a bad number never becomes the loop's sleep"


@pytest.mark.asyncio
async def test_a_camera_that_goes_away_keeps_the_rig_up(config, caplog, monkeypatch):
    monkeypatch.setattr(capture, "CAMERA_RETRY_S", 0.05)
    source = FakeSource()
    source.unplugged = True
    uploader = FakeUploader()
    loop = CaptureLoop(source, uploader, config, LOG)

    with caplog.at_level(logging.INFO, logger="test.capture"):
        running = asyncio.create_task(loop.run())
        await asyncio.sleep(0.2)  # several retry intervals with no camera
        assert running.done() is False, "the loop is still running"
        source.unplugged = False
        await asyncio.sleep(0.3)  # it comes back
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running

    assert uploader.uploaded, "the rig uploaded again once the camera returned"
    assert caplog.text.count("retrying every") == 1, "one line for the outage, not one per retry"
    assert "camera is back" in caplog.text
    assert 2 <= source.opens <= 10, "it retried on a delay rather than spinning"


@pytest.mark.asyncio
async def test_the_frame_callback_sees_every_frame_it_takes(config):
    seen: list[Frame] = []
    loop = CaptureLoop(FakeSource(), FakeUploader(), config, LOG, on_frame=seen.append)

    taken = await loop.tick()
    await settle()

    assert seen == [taken]
