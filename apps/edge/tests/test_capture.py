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


class ParkedSource(FakeSource):
    """A camera whose first `grab()` parks until the test lets it go.

    That park is the window the hold guard alone cannot close: `hold()` stops ticks that
    have not started, and this tick is already inside `_take()` when the hold goes up.
    """

    def __init__(self) -> None:
        super().__init__()
        self.gate = asyncio.Event()
        self.parked = asyncio.Event()
        self._parks = 0

    async def grab(self) -> Frame:
        if self._parks == 0:
            self._parks = 1
            self.parked.set()
            await self.gate.wait()
        return await super().grab()


class FakeUploader:
    """An uploader whose answer — and whose patience — the test decides."""

    def __init__(self, outcome: UploadOutcome | None = None, gate: asyncio.Event | None = None) -> None:
        self.uploaded: list[tuple[Frame, int]] = []
        #: The tag each frame travelled under, in order: the cadence's own frames are
        #: `camera`, a sweep's are `survey`, and the two are what the server keeps apart.
        self.sources: list[str] = []
        self.outcome = outcome or ok()
        self.gate = gate

    async def upload(self, frame: Frame, seq: int, source: str = "camera") -> UploadOutcome:
        self.uploaded.append((frame, seq))
        self.sources.append(source)
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
    result = await loop.capture_now()

    assert result is not None
    assert len(uploader.uploaded) == 1, "the capture action uploads its own frame before it returns"
    assert result.seq == 1, "and hands the caller the seq it uploaded it under"
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
async def test_a_hold_parks_the_cadence_and_capture_now_nests_inside_it(config, caplog):
    """A hold is what a sweep takes for its whole run: the cadence stops for the duration,
    and a `capture` action inside it takes its own frame without handing the cadence back."""
    source = FakeSource()
    uploader = FakeUploader()
    loop = CaptureLoop(source, uploader, config, LOG)

    loop.hold()
    with caplog.at_level(logging.DEBUG, logger="test.capture"):
        assert await loop.tick() is None, "a held cadence takes no frames"
    assert source.taken == 0
    assert "skipped_for_capture" in caplog.text

    result = await loop.capture_now()
    assert result is not None, "a capture inside a hold still takes its frame"
    assert len(uploader.uploaded) == 1

    assert await loop.tick() is None, "and the cadence is still parked afterwards"
    assert source.taken == 1

    loop.release()
    assert await loop.tick() is not None, "the cadence comes back when the holder lets go"


@pytest.mark.asyncio
async def test_a_tick_parked_in_the_take_is_dropped_when_a_hold_goes_up(config):
    """The window the hold guard alone cannot close: `hold()` stops ticks that have not
    started, not one already inside `_take()`. That tick's frame is the holder's window,
    and numbering it would move `state()['lastSeq']` - which the holder's own frame is
    named by - out from under it, so it is dropped instead."""
    source = ParkedSource()
    uploader = FakeUploader()
    loop = CaptureLoop(source, uploader, config, LOG)

    tick = asyncio.create_task(loop.tick())
    await source.parked.wait()  # the tick is inside `grab()`, past the hold guard

    loop.hold()
    result = await loop.capture_now("survey")
    source.gate.set()  # let the parked tick finish, still under the hold
    dropped = await tick

    assert result is not None
    assert dropped is None, "a frame taken under a hold is dropped, not numbered"
    assert source.taken == 2, "the tick really did take a frame; it did not send it"
    assert uploader.sources == ["survey"], "the tick's frame is not uploaded at all"
    assert uploader.uploaded == [(result.frame, result.seq)], "and the holder's frame is"
    assert result.seq == 1, "the holder's frame is the only one numbered"
    assert loop.state()["lastSeq"] == result.seq, "the dropped tick never moved the cadence's number"

    loop.release()


@pytest.mark.asyncio
async def test_a_release_that_was_never_held_does_not_free_the_cadence(config):
    source = FakeSource()
    loop = CaptureLoop(source, FakeUploader(), config, LOG)

    loop.release()  # an unmatched release is a bug, not a licence to capture unwatched
    loop.hold()

    assert await loop.tick() is None


@pytest.mark.asyncio
async def test_a_frame_taken_off_the_cadence_carries_its_own_source(config):
    """The tag is what the server files the frame under: a sweep's frames must not land in
    the ring the per-tick assessment reads."""
    uploader = FakeUploader()
    loop = CaptureLoop(FakeSource(), uploader, config, LOG)

    await loop.tick()
    await settle()
    await loop.capture_now("survey")

    assert uploader.sources == ["camera", "survey"]


@pytest.mark.asyncio
async def test_the_frame_callback_sees_every_frame_it_takes(config):
    seen: list[Frame] = []
    loop = CaptureLoop(FakeSource(), FakeUploader(), config, LOG, on_frame=seen.append)

    taken = await loop.tick()
    await settle()

    assert seen == [taken]
