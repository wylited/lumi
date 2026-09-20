"""The sweep: walk the camera across the desk and take one frame at each pose.

A survey is the one thing the rig does that moves the arm without being asked to aim
anywhere in particular. The server asks for a sweep, this walks a few poses around where
the camera already points, and every frame it takes is uploaded tagged `survey` so the
server can read those frames apart from the live ones.

Three rules keep the sweep from fighting anything, and each is a device this rig has:

* **The cadence is parked for the whole sweep, not per frame.** The camera is one device:
  a tick that woke up between two poses would take a frame of the rig mid-turn and push
  the survey's own frames out of the server's ring. A tick that was already inside the
  grab when the hold went up is dropped for the same reason - and, because it is dropped
  rather than numbered, the seq this sweep reads back is still its own frame's.
* **The follow loop is frozen for the whole sweep.** `arm.aim` brackets a single move; a
  sweep is several moves in a row, and the loop re-acquiring the person between them is
  the two-writers-one-arm case the arm package refuses.
* **The whole sweep is capped.** A sweep that cannot finish is a truthful partial report
  with the poses it did take, never an action that holds the rig's action loop open.

Nothing here raises at the camera, the arm or the server. A pose whose move is refused,
or whose frame the server would not keep, is skipped and logged: two frames of a desk are
worth more than no sweep at all.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .arm.calibration import MIN_POSES, RECT_KEYS, RIG_FILE, Calibration
from .arm.driver import ArmError, ArmPose

if TYPE_CHECKING:
    from .capture import CaptureLoop, CaptureResult
    from .config import Config

__all__ = ["SurveyPose", "SurveyReport", "SurveyTarget", "Surveyor", "survey_targets"]

SURVEY_SETTLE_S = 0.6  # after a move, before the grab: the servo is still settling
SURVEY_MAX_S = 20.0  # hard cap for the whole sweep, timeout aborts and reports what it got
SURVEY_PAN_STEP_DEG = 12.0  # the fallback sweep: this far left and right of the start pose
SURVEY_TILT_DROP_DEG = 8.0  # and this much lower, so the desk is in frame, not the wall


@dataclass(frozen=True)
class SurveyTarget:
    """One pose of a sweep, in whichever coordinates the rig can actually ask for.

    `point` is desk millimetres through the calibration, which is what makes two rigs
    frame the same desk the same way. `aim` is an absolute pan and tilt, which is all a
    rig with no calibration has - and with no arm at all, pan and tilt are null and the
    frame is simply taken where the camera points.
    """

    kind: str  # 'point' (desk mm, via the calibration) | 'aim' (pan/tilt)
    x: float | None = None
    y: float | None = None
    pan: float | None = None
    tilt: float | None = None


@dataclass(frozen=True)
class SurveyPose:
    """One pose a sweep took, and the frame that landed for it.

    `pose` is the arm's own report of where it ended up, null when the arm would not
    say; `aim` is the desk millimetres the arm was sent to, and null whenever it was not
    sent anywhere - a sweep with no calibration, or one with no arm to move. The seq is
    what the server reads the frame back by, so a pose without one is not a pose this
    reports.
    """

    index: int
    seq: int
    pose: dict | None = None
    aim: dict | None = None


@dataclass(frozen=True)
class SurveyReport:
    """What `desk.survey` acks with. A partial sweep is this shape too, not a failure."""

    reason: str | None
    started_at: str
    duration_ms: int
    poses: list[SurveyPose]
    error: str | None = None  # 'no_frame' | 'survey_timeout' | None


def survey_targets(count: int, start: ArmPose | None, rect: dict | None) -> list[SurveyTarget]:
    """The poses one sweep walks. Pure, so the geometry is tested without an arm.

    A single pose is the start reading: the camera already points at the desk, and moving
    it two minutes after someone sat down is a gesture nobody asked for. With a calibration
    the sweep walks the rectangle's centre line - a desk point means the same view on any
    rig - and without one it pans in steps around the start pose, dropped, so the frames
    show the desk rather than the wall behind it. An out-of-travel pose is **not** clamped:
    the driver refuses it, the pose is skipped, and the report says so.
    """
    if count <= 1:
        pan = start.pan if start is not None else None
        tilt = start.tilt if start is not None else None
        return [SurveyTarget("aim", pan=pan, tilt=tilt)]

    if rect is not None:
        # The centre line: a sweep of the rectangle's width, in the middle of its height.
        # The corners are the desk's edges - what a person looks at is between them.
        y = float(rect["y"]) + float(rect["h"]) / 2
        return [
            SurveyTarget(
                "point",
                x=float(rect["x"]) + float(rect["w"]) * (i + 0.5) / count,
                y=y,
            )
            for i in range(count)
        ]

    if start is None:
        # An arm that would not report a pose has nothing to offset from, so there is no
        # line to walk: one frame where the camera points is the honest sweep, and the
        # alternative - `count` frames of the same view - would tell the model they are
        # left to right across a desk they do not cross.
        return [SurveyTarget("aim")]

    half = (count - 1) / 2
    return [
        SurveyTarget(
            "aim",
            pan=start.pan + (i - half) * SURVEY_PAN_STEP_DEG,
            tilt=start.tilt - SURVEY_TILT_DROP_DEG,
        )
        for i in range(count)
    ]


class Surveyor:
    """One sweep at a time: the poses, the frames, and the report the ack is built from.

    It shares the camera and the arm with everything else in the rig, so it owns neither
    of them: the capture loop parks its cadence, the tracker holds its loop still, and
    both are told when the sweep is over. That is also why there is no queue here - the
    dispatcher handles one action at a time, and a second sweep would fight the first for
    the same arm.
    """

    def __init__(
        self,
        capture: CaptureLoop,
        arm: Any | None,
        cfg: Config,
        log: logging.Logger,
        tracker: Any | None = None,
    ) -> None:
        self._capture = capture
        self._arm = arm
        self._cfg = cfg
        self._log = log
        self._tracker = tracker
        self._surveying = False

    @property
    def surveying(self) -> bool:
        """Whether a sweep is in flight right now. `desk.health` is how the app learns it."""
        return self._surveying

    async def sweep(self, count: int, reason: str | None) -> SurveyReport:
        """Walk up to `count` poses across the desk, uploading one frame at each.

        The whole sweep is one bracket: the cadence is parked and the follow loop frozen
        from the first move to the last frame, because one camera and one arm are being
        shared. Both are let go whatever happened - a sweep that could not finish must not
        leave the rig unable to capture or to follow.
        """
        started_at = _now()
        started = time.monotonic()
        poses: list[SurveyPose] = []
        error: str | None = None
        self._surveying = True
        self._capture.hold()
        tracker = self._tracker
        if tracker is not None:
            tracker.freeze("desk.survey")
        try:
            start = await self._start_pose()
            # No arm, no line: the desk points are only usable by an arm that can be sent to
            # them, and `count` frames of the view the camera happens to have would tell the
            # model they are left to right across a desk they do not cross.
            targets = survey_targets(count, start, None if self._arm is None else self._rect())
            moved = False
            try:
                async with asyncio.timeout(SURVEY_MAX_S):
                    for index, target in enumerate(targets):
                        # Where the arm is until this pose moves it: a one-pose sweep
                        # reports the arm's own pose without ever commanding it.
                        pose = start
                        aim = None
                        try:
                            move = self._move(target, start)
                            if move is not None:
                                pose = await self._aim(move)
                                moved = True
                                # The desk point is reported only when the arm was actually
                                # sent to it: a rig that could not move is looking somewhere
                                # else, and an `aim` here would have the server point at a
                                # pile this frame never showed.
                                if move[0] == "point":
                                    aim = {"x": move[1], "y": move[2]}
                                await asyncio.sleep(SURVEY_SETTLE_S)
                        except ArmError as exc:
                            # The driver's own words: a joint outside its travel, a bus that
                            # stopped answering. One pose is skipped, not the sweep - the
                            # frames already taken are still a reading of the desk.
                            self._log.warning("survey: pose %d skipped: %s", index, exc)
                            continue
                        result = await self._capture.capture_now("survey")
                        if result is None:
                            self._log.warning("survey: pose %d took no frame", index)
                            continue
                        taken = self._taken(index, pose, aim, result)
                        if taken is not None:
                            poses.append(taken)
            except TimeoutError:
                # The cap, not a failure of any one pose: whatever landed is what the
                # sweep has, and the server is told the sweep ran out of time rather than
                # that it finished.
                error = "survey_timeout"
                self._log.warning("survey: stopped after %gs with %d poses", SURVEY_MAX_S, len(poses))
            finally:
                await self._restore(start, moved)
        finally:
            self._surveying = False
            if tracker is not None:
                tracker.thaw("desk.survey")
            self._capture.release()

        if error is None and not poses:
            # Nothing landed at all: the camera or the server refused every frame, and an
            # empty sweep reported as `done` would read to the server as a reading.
            error = "no_frame"
        return SurveyReport(
            reason=reason,
            started_at=started_at,
            duration_ms=_ms_since(started),
            poses=poses,
            error=error,
        )

    async def _start_pose(self) -> ArmPose | None:
        """Where the camera points before the sweep, or None when the arm will not say.

        A refusal here is not fatal: the frames are still worth taking, and a sweep that
        gave up because the arm was quiet would be a survey lost to a diagnostic.
        """
        if self._arm is None:
            return None
        try:
            return await asyncio.to_thread(self._arm.pose)
        except ArmError as exc:
            self._log.warning("survey: the arm would not report its pose (%s); sweeping in place", exc)
            return None

    def _rect(self) -> dict | None:
        """The desk rectangle, or None when this rig has no calibration to sweep through.

        Read per sweep rather than at boot: a person can record a calibration while the rig
        runs, and the next sweep should use it. Every failure is the same answer - no
        calibration - because the file is shared with the desk's own identity and a rig
        that refused to sweep over a broken one would lose the frames to a diagnostic.
        """
        try:
            calibration = Calibration.load(Path(self._cfg.heli_dir) / RIG_FILE)
        except Exception as exc:
            self._log.warning("survey: the calibration could not be read: %s", exc)
            return None
        if len(calibration.poses) < MIN_POSES:
            # Three measured pairs are what make the rectangle a mapping. Below that
            # `point()` refuses, and aiming through a half-fit would move the camera to
            # the wrong place with nothing to show for it.
            return None
        rect = calibration.rect()
        if rect is None or not all(key in rect for key in RECT_KEYS):
            return None
        return rect

    def _move(self, target: SurveyTarget, start: ArmPose | None) -> tuple[str, float, float] | None:
        """The move this pose needs, or None when the camera is already where it points.

        The one-pose sweep is the start reading and commands nothing: the arm is there, and
        a move that is asked for is a move the follow loop has to be frozen around.
        """
        if self._arm is None:
            return None
        if target.kind == "point":
            if target.x is None or target.y is None:
                return None
            return ("point", float(target.x), float(target.y))
        if target.pan is None or target.tilt is None:
            return None
        if start is not None and target.pan == start.pan and target.tilt == start.tilt:
            return None
        return ("aim", float(target.pan), float(target.tilt))

    async def _aim(self, move: tuple[str, float, float]) -> ArmPose:
        """One move, off the event loop: the driver talks over a serial port and a console."""
        kind, first, second = move
        if kind == "point":
            return await asyncio.to_thread(self._arm.point, first, second)
        return await asyncio.to_thread(self._arm.aim, first, second)

    async def _restore(self, start: ArmPose | None, moved: bool) -> None:
        """Put the camera back where the sweep found it.

        Best-effort by design: the follow loop re-acquires the person the moment it is
        thawed, so a rewind that fails is a log line rather than a lost sweep. A sweep that
        never moved is already there and is not commanded at all.
        """
        if not moved or start is None or self._arm is None:
            return
        try:
            await asyncio.to_thread(self._arm.aim, start.pan, start.tilt)
        except ArmError as exc:
            self._log.warning("survey: could not return to the start pose: %s", exc)

    def _taken(self, index: int, pose: ArmPose | None, aim: dict | None, result: CaptureResult) -> SurveyPose | None:
        """The pose a landed frame makes, or None when the server did not keep it.

        The seq is the one `capture_now` returned for *this* frame, so the pose names
        exactly the frame this sweep uploaded: the loop's own counter is the cadence's
        number, and the frame a tick took under the sweep's hold is dropped rather than
        numbered. `aim` is the desk point this frame was taken from, and it is null unless
        the arm was really sent there.
        """
        if not result.outcome.ok:
            self._log.warning(
                "survey: pose %d was refused by the server (%s)",
                index,
                result.outcome.error or f"http_{result.outcome.status}",
            )
            return None
        return SurveyPose(index=index, seq=result.seq, pose=_pose(pose), aim=aim)


def _pose(pose: ArmPose | None) -> dict | None:
    return None if pose is None else {"pan": float(pose.pan), "tilt": float(pose.tilt)}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _ms_since(started: float) -> int:
    return max(0, int(round((time.monotonic() - started) * 1000)))
