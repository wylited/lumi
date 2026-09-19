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

    async def open(self) -> None:
        self.opens += 1
        self.opened = True

    async def is_open(self) -> bool:
        return self.opened

    def describe(self) -> dict:
        return {"model": "Fake camera", "maxWidth": 640, "maxHeight": 480, "zoom": False}

    async def grab(self) -> Frame:
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

    assert "frame_too_wide" in caplog.text
    sent = [frame for frame, _ in uploader.uploaded]
    assert len(sent) == 2, "each tick takes its own frame"
    assert len({id(frame) for frame in sent}) == len(sent), "the refused frame is not sent again"
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
