"""The cadence: one frame at a time, one upload at a time, for as long as the rig runs.

Nothing here raises at a camera or a server. A frame that is late is worse than
a frame that is missing — the server keeps only the newest one per session — so
the loop drops a tick rather than queueing frames, slows down rather than
spinning, and keeps the process up when the camera goes away.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time

from .camera import CameraUnavailable, Frame, FrameSource
from .config import Config
from .upload import UploadOutcome, Uploader

CAMERA_RETRY_S = 5.0  # an unplugged camera is a state to retry, not an exit
PAUSED_POLL_S = 0.2  # how often a stopped cadence checks on an upload already in flight
SESSION_BACKOFF = 5  # a 409 means nobody is watching: a fifth of the cadence, not silence
#: How long one `open`/`grab` may take before the camera is called stalled.
#:
#: `cv2.VideoCapture.read` blocks until the device answers, and a device that has been taken
#: away underneath it — another process opened the same UVC camera, which is exactly what the
#: vision console does — can stop answering without ever failing. The tick awaits that call,
#: so a read that never returns is a capture loop that never returns: thirteen minutes with
#: no frame while the health line went on quoting the configured rate. The arm is *not* the
#: cause of that — a probe of the real rig with its bridge killed keeps delivering frames,
#: which is how this was narrowed to the device — and a bound turns a device that will not
#: answer into the camera failure the loop already rides out: a line, the retry pace, and a
#: reopen that releases the stuck handle.
CAMERA_GRAB_TIMEOUT_S = 5.0
#: A rig that has not delivered a frame for this many cadence intervals reports 0 fps.
#:
#: `desk.health.fps` is read as the rate the rig is *delivering* ("capture fps · last frame
#: …" in the desk panel), so a stalled loop must not keep quoting the cadence it was asked
#: for. Three intervals is long enough that an ordinary late frame does not read as a stall,
#: and the floor covers a fast cadence whose stall would otherwise be under a second.
FRAME_STALL_INTERVALS = 3.0
FRAME_STALL_FLOOR_S = 1.5


class CaptureLoop:
    """Take frames at the cadence, upload them, and never let either block the other."""

    def __init__(
        self,
        source: FrameSource,
        uploader: Uploader,
        cfg: Config,
        log: logging.Logger,
        on_frame=None,
    ) -> None:
        self._source = source
        self._uploader = uploader
        self._cfg = cfg
        self._log = log
        self._on_frame = on_frame
        self._fps = float(cfg.fps)
        self._seq = 0
        self._frames = 0
        self._accepted = 0
        self._rejected = 0
        self._last_frame_at: str | None = None
        self._pending: asyncio.Task[UploadOutcome] | None = None
        #: True while `capture_now` holds the camera and the uploader. The cadence
        #: consults it for the same reason it consults `_settle()`: one frame at a
        #: time, so a `capture` action and a tick cannot post two frames for one.
        self._capturing = False
        self._last_outcome: UploadOutcome | None = None
        self._camera_down = False
        self._no_session = False
        self._streak: str | None = None
        #: When the last frame arrived, on the monotonic clock. `state()['fps']` is measured
        #: against this rather than against the cadence the loop was handed: a rig whose
        #: frames have stopped must not keep quoting the rate it is not delivering.
        self._delivered_at: float | None = None

    @property
    def source(self) -> FrameSource:
        """The camera this loop reads. The dispatcher asks it what it can do."""
        return self._source

    async def tick(self) -> Frame | None:
        """One capture at the cadence, and the upload it starts.

        Returns the frame that was taken, or None when there is nothing to
        report: an upload still in flight, a camera that is not there, a server
        that refused the last frame. None of those is an exception — the loop is
        expected to keep going.
        """
        if self._capturing:
            # A `capture` action is taking its frame right now. Let it own the
            # camera and the uploader; this tick is one the cadence does not need.
            self._log.debug("skipped_for_capture")
            return None
        if self._settle():
            # The previous upload has not returned. Skip this tick rather than
            # queue a second frame behind it: the newest frame is the only one
            # the server keeps, so a queue only makes the rig send old news.
            self._log.debug("skipped_inflight")
            return None
        if self._effective_fps() <= 0:
            # `stream.stop`: the cadence is off, and `capture_now` is the only way
            # back in until something starts it again.
            return None
        frame = await self._take()
        if frame is None:
            return None
        self._seq += 1
        self._start(frame, self._seq)
        return frame

    async def capture_now(self) -> Frame | None:
        """The `capture` action: one frame now, off the cadence, uploaded before it returns.

        Waits for an upload already in flight, and claims the slot while it takes
        its own — the server attributes one frame at a time, and two POSTs would
        land two frames for one request. The claim covers the *take* as well as the
        POST, because every `await` in `_take()` is a yield the cadence could wake
        up on. When this returns, `state()['lastSeq']` is the seq of the frame just
        taken and `last_outcome` is what the server said about it.
        """
        self._capturing = True
        try:
            await self._drain()
            frame = await self._take()
            if frame is None:
                return None
            self._seq += 1
            await self._upload(frame, self._seq)
            return frame
        finally:
            self._capturing = False

    @property
    def last_outcome(self) -> UploadOutcome | None:
        """What the server said about the last frame this loop sent.

        The `capture` action reads this to ack the truth: a frame the server
        refused (409 with no session, 422, a transport error) must not be acked
        `done` with a seq the server never stored.
        """
        return self._last_outcome

    async def run(self) -> None:
        """Capture at the cadence until the rig is stopped.

        A camera that is not there, or a server that refuses, changes the pace —
        never the exit.
        """
        loop = asyncio.get_running_loop()
        # Measured from a deadline rather than from the end of the tick: sleeping a
        # full interval *after* the grab, the encode and the POST makes `HELI_FPS` a
        # ceiling (a 1080p device does real work per tick) and makes the fps the
        # health frame reports a number the loop never reached.
        due = loop.time()
        while True:
            fps = self._effective_fps()
            if fps <= 0:
                # `stream.stop`: no cadence at all. A `capture` action still works,
                # and a frame already taken still has an upload to account for.
                self._settle()
                await asyncio.sleep(PAUSED_POLL_S)
                due = loop.time()
                continue
            await self.tick()
            interval = CAMERA_RETRY_S if self._camera_down else 1.0 / fps
            now = loop.time()
            due += interval
            if due < now - interval:
                # A tick that took several intervals (a stalled camera, a slow
                # upload) must not be paid back as a burst of ticks: skip the
                # missed slots instead.
                due = now
            await asyncio.sleep(max(0.0, due - now))

    def set_fps(self, fps: float) -> None:
        """`stream.start` / `stream.stop`: the cadence is the server's to set.

        Zero stops the cadence without stopping the rig, which is exactly what
        `stream.stop` means: no frames until something asks for one.
        """
        value = float(fps)
        if not math.isfinite(value) or value < 0:
            self._log.warning("ignoring a cadence of %s fps", fps)
            return
        if value != self._fps:
            self._log.info("capture cadence %g -> %g fps", self._fps, value)
        self._fps = value

    def state(self) -> dict:
        """What `desk.health` reports: the cadence, the last frame, and its seq.

        `frames` counts frames taken and `framesSent` the frames the server
        accepted minus the ones it refused, which is the health field of the
        same name: the difference between them is the rig's own failure count.

        `fps` is the cadence *while it is being delivered*, and zero once it is
        not: a rig whose camera stopped answering reported ten frames a second for
        the thirteen minutes it delivered none, and the panel that reads this field
        prints it as "capture fps". A rig that has not taken its first frame yet is
        the one case that reports the cadence it was asked for — there is no
        delivery to measure against, and the doctor reads this field to tell "the
        camera answers" from "the camera is gone".
        """
        return {
            "fps": 0.0 if self._stalled() else self._effective_fps(),
            "lastFrameAt": self._last_frame_at,
            "lastSeq": self._seq,
            "frames": self._frames,
            # `desk.health` declares this nonnegative, so a rig that has had more
            # rejections than acceptances reports zero rather than a value the
            # server's schema would refuse.
            "framesSent": max(0, self._accepted - self._rejected),
        }

    def _stalled(self) -> bool:
        """Whether the cadence has stopped delivering, so health can say so.

        Three cadence intervals, and never less than `FRAME_STALL_FLOOR_S`: a slow cadence
        whose interval is seconds would otherwise call every ordinary frame late.
        """
        if self._delivered_at is None:
            return False
        quiet_for = time.monotonic() - self._delivered_at
        fps = self._effective_fps()
        intervals = FRAME_STALL_INTERVALS / fps if fps > 0 else float("inf")
        return quiet_for > max(FRAME_STALL_FLOOR_S, intervals)

    async def _take(self) -> Frame | None:
        """One frame, reopening the source if the camera went away.

        Reopening is how the rig comes back after an unplug and after a console
        restart. A failure is a state, logged once, and `run()` paces the retry.

        Both halves are bounded: a device whose `read` has stopped returning is
        the failure this loop cannot see any other way. The abandoned call keeps
        its thread until the handle is released, which the next attempt does
        (`open()` closes first), and the loop is paced at `CAMERA_RETRY_S` while
        the camera is down rather than spending a thread per tick.
        """
        was_down = self._camera_down
        try:
            if was_down or not await self._source.is_open():
                await asyncio.wait_for(self._source.open(), CAMERA_GRAB_TIMEOUT_S)
            frame = await asyncio.wait_for(self._source.grab(), CAMERA_GRAB_TIMEOUT_S)
        except TimeoutError:
            self._camera_failure(
                CameraUnavailable(f"the camera did not answer within {CAMERA_GRAB_TIMEOUT_S:g} s"),
                was_down,
            )
            return None
        except Exception as exc:
            # A source may also fail in ways it did not name — a console URL the
            # URL parser rejects, a JPEG OpenCV will not decode — and all of them
            # mean the same thing to the loop: no frame this tick.
            self._camera_failure(exc, was_down)
            return None
        if was_down:
            self._log.info("camera is back: %s", self._camera_label())
        self._camera_down = False
        self._frames += 1
        self._delivered_at = time.monotonic()
        self._last_frame_at = frame.captured_at
        if self._on_frame is not None:
            try:
                self._on_frame(frame)
            except Exception:
                self._log.exception("the on_frame callback raised")
        return frame

    def _start(self, frame: Frame, seq: int) -> None:
        self._pending = asyncio.create_task(self._upload(frame, seq), name=f"heli-rig-upload-{seq}")

    def _camera_failure(self, exc: Exception, was_down: bool) -> None:
        """One log line per outage: the first failure is news, its repeats are not."""
        self._camera_down = True
        if was_down:
            return
        if isinstance(exc, CameraUnavailable):
            self._log.warning("%s: %s; retrying every %gs", self._camera_label(), exc, CAMERA_RETRY_S)
        else:
            # Not a frame the rig could not get but a bug in the camera path: say
            # so with the traceback, and keep the loop alive anyway.
            self._log.exception("the camera path failed: %s", exc)

    async def _upload(self, frame: Frame, seq: int) -> UploadOutcome:
        """Upload one frame and fold the outcome into the cadence. Never raises."""
        try:
            outcome = await self._uploader.upload(frame, seq)
        except asyncio.CancelledError:
            raise
        except Exception:
            # `Uploader.upload` promises not to raise. If a bug slips through, the
            # loop still has to be alive for the next frame.
            self._log.exception("the upload raised")
            outcome = UploadOutcome(ok=False, status=0, ref=None, seq=None, width=None, height=None, error="transport", rejected=False)
        self._record(outcome)
        # Kept for the `capture` action, which acks what the server said about the
        # frame it asked for: one field, written by whichever upload finished.
        self._last_outcome = outcome
        return outcome

    def _settle(self) -> bool:
        """Record a finished upload. True while one is still in flight."""
        pending = self._pending
        if pending is None:
            return False
        if not pending.done():
            return True
        self._pending = None
        if not pending.cancelled():
            pending.exception()  # `_upload` recorded it; an unread exception is a lie in the log
        return False

    async def _drain(self) -> None:
        """Wait for the in-flight upload, if there is one. `_upload` records it itself."""
        pending = self._pending
        if pending is None:
            return
        self._pending = None
        await pending

    def _record(self, outcome: UploadOutcome) -> None:
        """Fold one outcome into the cadence, logging once per streak.

        A failure that repeats every tick is one problem, not two hundred lines:
        the first is logged, and the next log comes when the news changes.
        """
        if outcome.ok:
            self._accepted += 1
            if self._streak is not None:
                self._streak = None
                self._log.info("the server is taking frames again")
            if self._no_session:
                self._no_session = False
                self._log.info("a session is open again; capture back to %g fps", self._fps)
            return
        if outcome.rejected:
            self._rejected += 1
        key = outcome.error or f"http_{outcome.status}"
        if outcome.status == 409 and not self._no_session:
            self._no_session = True
            self._streak = key
            self._log.warning("no session is open; capture slowed to %g fps", self._effective_fps())
            return
        if key == self._streak:
            return
        self._streak = key
        if outcome.rejected:
            # A 422 means the server refused these bytes. The rig never resends a
            # frame: this one is waste, and the next one is new.
            self._log.warning("the server rejected the frame (%s); not resending it", outcome.error)
            return
        self._log.warning("upload failed (%s), status %d", outcome.error, outcome.status)

    def _effective_fps(self) -> float:
        """What the loop is actually doing: a 409 cadence is a fifth, not a stop."""
        return self._fps / SESSION_BACKOFF if self._no_session else self._fps

    def _camera_label(self) -> str:
        camera = self._source.describe()
        return f"camera {camera['model']}" if camera else "camera"
