"""What the rig does with each action, and what it answers.

The server holds an ack window and retries an idempotent action once, so every
action has to come back with an ack and the ack has to be true: an action this
rig cannot perform answers `failed` with the reason rather than a `done` that
pretends. `handle` therefore catches everything — an unexpected exception is a
bug in the rig, and a bug is still an answer the server has to have, because an
action that never acks reads to the server as a desk that went offline.

The arm is the only thing here that blocks. Every call into it goes through
`asyncio.to_thread`, since the driver talks over a serial port and would
otherwise stop the capture loop for as long as the arm takes to move.

An ack's `result` is sent whole — `pose`, `seq`, `zoom`, `durationMs` and the sweep's own
`survey`, null where they mean nothing. The contract makes every field nullable, so a
reader never has to guess whether a missing key is a missing value or a version skew.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Any

from .arm.driver import ArmError

if TYPE_CHECKING:
    # The collaborators are the frozen protocols. Only the arm's error type is
    # needed at runtime, and importing cv2 and httpx just for a signature would
    # make every user of this module pay for them.
    from .arm.driver import ArmDriver
    from .audio import Speaker
    from .camera import FrameSource
    from .capture import CaptureLoop
    from .config import Config
    from .survey import SurveyReport, Surveyor

__all__ = ["Dispatcher"]

_ARM_ACTIONS = frozenset({"arm.aim", "arm.point", "arm.nod", "arm.home"})
#: The actions that move the arm by themselves, and therefore have to be alone on
#: it: the follow loop is frozen for the whole of each one. `arm.track` is not in
#: this set - it is the loop's own switch, not a move.
_MOVING_ACTIONS = frozenset({"arm.aim", "arm.point", "arm.nod", "arm.home"})


class Dispatcher:
    """One `DeskAction` in, one `DeskAck` out.

    `speaker` is carried and not used: a spoken line arrives on the socket as
    `audio.out` and its PCM, never as an action, but the frozen wiring hands the
    dispatcher one — dropping it here would mean a second constructor to keep in
    step with this one.
    """

    def __init__(
        self,
        capture: CaptureLoop,
        arm: ArmDriver | None,
        speaker: Speaker | None,
        cfg: Config,
        log: logging.Logger,
        tracker: Any | None = None,
        surveyor: Surveyor | None = None,
    ) -> None:
        self._tracker = tracker
        self._capture = capture
        self._arm = arm
        self._speaker = speaker
        self._cfg = cfg
        self._log = log
        #: The sweep, or None on a rig built without one. Held rather than reached for
        #: through the capture loop: the sweep is a collaborator with its own state, the
        #: way the tracker is, and a rig that cannot sweep says so by name.
        self._surveyor = surveyor

    @property
    def tracker(self) -> Any | None:
        """The follow loop, or None when this rig has none.

        Read by the desk socket, whose `desk.health` reports whether the rig is following: the
        dispatcher is where the tracker was handed at wiring time, so the socket reads it here
        rather than being given the same object a second time and the two drifting apart.
        """
        return self._tracker

    @property
    def surveying(self) -> bool:
        """Whether a sweep is in flight right now (`desk.health.surveying`).

        The sweep's own flag lives on the surveyor that is running it, and the socket holds
        the dispatcher, so this is the one hop between them. A rig with no surveyor answers
        `false` rather than `null`: `surveying` is a claim about now, and a rig that cannot
        sweep is not mid-sweep.
        """
        surveyor = self._surveyor
        if surveyor is None:
            return False
        try:
            return bool(surveyor.surveying)
        except Exception:
            # A heartbeat is a claim about now and must never be the thing that stops the
            # heartbeats: a surveyor that cannot answer is reported as not sweeping.
            return False

    async def handle(self, action: dict) -> dict:
        """Dispatch one action and return the ack the server will read."""
        action_id = action.get("id")
        if not isinstance(action_id, str) or not action_id:
            # An ack names the id the server issued, so an action without one
            # cannot be answered at all. Say so where a person will see it.
            self._log.error("an action arrived with no id, so it cannot be acked: %r", action)
            return _ack("", "failed", error="bad_action")

        try:
            return await self._dispatch(action_id, action)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._log.exception("action %s (%r) blew up", action_id, action.get("type"))
            return _ack(action_id, "failed", error=f"{type(exc).__name__}: {exc}")

    async def _dispatch(self, action_id: str, action: dict) -> dict:
        kind = action.get("type")
        payload = action.get("payload")
        if not isinstance(payload, dict):
            payload = {}

        if kind == "capture":
            return await self._capture_once(action_id, payload)

        if kind == "stream.start":
            self._capture.set_fps(float(payload["fps"]))
            return _ack(action_id, "done")

        if kind == "stream.stop":
            # Zero stops the cadence without stopping the rig: no frames until
            # something starts it again, and a `capture` action still works. That
            # is what `stream.stop` means - handing back the configured idle rate
            # would ack a stop the rig never performed.
            self._capture.set_fps(0.0)
            return _ack(action_id, "done")

        if kind == "camera.zoom":
            return self._zoom(action_id)

        if kind == "arm.track":
            return await self._track(action_id, payload)

        if kind == "desk.survey":
            # Before the arm branch and deliberately not in `_ARM_ACTIONS`: a sweep is
            # several moves, and it brackets the follow loop itself rather than being
            # bracketed per move the way a single `arm.aim` is.
            return await self._survey(action_id, payload)

        if kind in _ARM_ACTIONS:
            return await self._arm_action(action_id, action, payload)

        return _ack(action_id, "failed", error="unknown_action")

    # ---- the sweep ---------------------------------------------------------

    async def _survey(self, action_id: str, payload: dict) -> dict:
        """`desk.survey`: sweep the desk, and ack the poses and frames it took.

        The report is acked whatever it holds — a sweep that took two poses of three is a
        sweep that happened — and `done` is decided by whether any frame landed, not by
        whether the sweep finished: an ack of `done` with no poses would tell the server a
        reading exists when the camera never answered.
        """
        surveyor = self._surveyor
        if surveyor is None:
            return _ack(action_id, "failed", error="survey_unavailable")

        self._log.info("desk.survey: reason=%s poses=%s", payload.get("reason"), payload.get("poses"))
        report = await surveyor.sweep(int(payload.get("poses") or 3), payload.get("reason"))
        if not report.poses:
            self._log.warning("desk.survey took no frames (%s)", report.error)
        return _ack(
            action_id,
            "done" if report.poses else "failed",
            survey=_survey_dict(report),
            error=report.error,
        )

    # ---- following a person ------------------------------------------------

    async def _track(self, action_id: str, payload: dict) -> dict:
        """`arm.track`: follow the person at the desk, or stop following them.

        Two refusals, both of them honest rather than convenient. No tracker at all
        means this rig was never given the pieces (`heli_rig.follow` missing, no arm,
        no control law) and saying `done` would claim a loop that does not exist. A
        tracker that exists but was configured `HELI_TRACKING=off` refuses too: a rig
        that starts moving a camera because a socket said so is exactly what the `off`
        default is for, and the server can tell the two apart by the error.
        """
        tracker = self._tracker
        if tracker is None:
            return _ack(action_id, "failed", error="tracking_unavailable")
        on = bool(payload.get("on"))
        if on and self._cfg.tracking != "auto":
            return _ack(action_id, "failed", error="tracking_disabled")
        try:
            # Off the event loop: `set_on` puts armd into `pose`, which is a console
            # round trip, and this handler runs on the loop the capture and the socket
            # share.
            await asyncio.to_thread(tracker.set_on, on)
        except Exception as exc:
            # The tracker's own words: a missing arm, a model that will not load.
            self._log.warning("arm.track(%s) failed: %s", on, exc)
            return _ack(action_id, "failed", error=str(exc))
        return _ack(action_id, "done")

    # ---- capture -----------------------------------------------------------

    async def _capture_once(self, action_id: str, payload: dict) -> dict:
        """One frame now, and the seq the frame was uploaded under.

        `capture_now` takes the frame, numbers it and hands it to the uploader
        before it returns, and what it returns is this caller's own frame: the
        seq it went up as and the server's answer to it. Neither is read back
        from the loop, because the loop's counter belongs to the cadence - a tick
        already inside `_take()` when this frame's hold went up is dropped, and
        the last upload to finish is not necessarily this one.
        """
        self._log.info("capture: reason=%s", payload.get("reason"))

        result = await self._capture.capture_now()
        if result is None:
            return _ack(action_id, "failed", error="no_frame")

        if not result.outcome.ok:
            # The frame exists and the server refused it: no session open (409), a
            # frame it would not take (422), a transport error. Acking `done` with
            # this frame's seq would name a stored frame that does not exist, which
            # is the one thing this module promises not to do.
            return _ack(action_id, "failed", error=result.outcome.error or f"http_{result.outcome.status}")

        return _ack(action_id, "done", seq=result.seq)

    # ---- camera controls ---------------------------------------------------

    def _zoom(self, action_id: str) -> dict:
        """Refuse a zoom the desk cannot perform.

        `describe()` is the authority on what the camera takes, so a camera that
        reports no zoom is refused with `no_zoom`. A camera that *does* report it
        still cannot be zoomed by this build — the frozen `FrameSource` reports
        capabilities but exposes no setter — and that is a failure too, named so
        a reader can tell the two apart: telling the server `done` would claim
        the picture changed when it did not.
        """
        source = _source_of(self._capture)
        caps = _describe(source, self._log)
        if not caps.get("zoom"):
            return _ack(action_id, "failed", error="no_zoom")
        return _ack(action_id, "failed", error="zoom_unimplemented")

    # ---- the arm -----------------------------------------------------------

    async def _arm_action(self, action_id: str, action: dict, payload: dict) -> dict:
        arm = self._arm
        if arm is None:
            return _ack(action_id, "failed", error="no_arm")

        kind = action["type"]
        # One arm, one driver: the follow loop is held for the whole of a move that
        # was asked for, and released whatever the move did. Counted, so a `nod`
        # that ends inside a `home` does not release the `home`'s freeze.
        tracker = self._tracker if kind in _MOVING_ACTIONS else None
        if tracker is not None:
            tracker.freeze(kind)
        try:
            if kind == "arm.aim":
                pose = await asyncio.to_thread(
                    arm.aim, float(payload["pan"]), float(payload["tilt"])
                )
                return _ack(action_id, "done", pose=_pose(pose))

            if kind == "arm.point":
                pose = await asyncio.to_thread(arm.point, float(payload["x"]), float(payload["y"]))
                return _ack(action_id, "done", pose=_pose(pose))

            if kind == "arm.home":
                pose = await asyncio.to_thread(arm.home)
                return _ack(action_id, "done", pose=_pose(pose))

            return await self._nod(action_id, arm, payload)
        except ArmError as exc:
            # The driver's own text: `ArmUnavailable` and `ArmTimeout` say what
            # is wrong with the bus, and a paraphrase would lose the detail.
            self._log.warning("%s failed: %s", kind, exc)
            return _ack(action_id, "failed", error=str(exc))
        finally:
            if tracker is not None:
                tracker.thaw(kind)

    async def _nod(self, action_id: str, arm: ArmDriver, payload: dict) -> dict:
        """A nod, how long it took, and — when the arm will say — where it ended up."""
        started = time.monotonic()
        await asyncio.to_thread(arm.nod, int(payload["times"]))

        pose = await self._pose_or_none(arm)
        return _ack(
            action_id, "done", pose=pose, duration_ms=_ms_since(started)
        )

    async def _pose_or_none(self, arm: ArmDriver) -> dict | None:
        """Where the arm is, for an action whose call does not return a pose.

        A nod that happened is not a failed nod because the arm would not talk
        about it afterwards: the ack reports what is known and leaves the rest
        null.
        """
        try:
            return _pose(await asyncio.to_thread(arm.pose))
        except ArmError as exc:
            self._log.warning("the arm nodded but would not report its pose: %s", exc)
            return None


def _source_of(capture: Any) -> FrameSource | None:
    """The `FrameSource` behind the capture loop.

    The frozen `Dispatcher` constructor is handed the loop and not the source,
    and the camera caps come from the source; this is the one join between them.
    """
    return getattr(capture, "source", None)


def _describe(source: Any, log: logging.Logger) -> dict:
    if source is None:
        return {}
    try:
        caps = source.describe()
    except Exception as exc:
        log.warning("the camera would not describe itself: %s", exc)
        return {}
    return caps if isinstance(caps, dict) else {}


def _pose(pose: Any) -> dict:
    return {"pan": float(pose.pan), "tilt": float(pose.tilt)}


def _ms_since(started: float) -> int:
    return max(0, int(round((time.monotonic() - started) * 1000)))


def _survey_dict(report: SurveyReport) -> dict:
    """The sweep's report, in the ack's own field names."""
    return {
        "reason": report.reason,
        "startedAt": report.started_at,
        "durationMs": report.duration_ms,
        "poses": [
            {"index": pose.index, "seq": pose.seq, "pose": pose.pose, "aim": pose.aim}
            for pose in report.poses
        ],
    }


def _ack(
    action_id: str,
    status: str,
    *,
    pose: dict | None = None,
    seq: int | None = None,
    zoom: float | None = None,
    duration_ms: int | None = None,
    survey: dict | None = None,
    error: str | None = None,
) -> dict:
    """The whole ack: the result carries every field the contract names."""
    return {
        "t": "action.ack",
        "actionId": action_id,
        "status": status,
        "result": {
            "pose": pose,
            "seq": seq,
            "zoom": zoom,
            "durationMs": duration_ms,
            "survey": survey,
        },
        "error": error,
    }
