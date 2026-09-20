"""Following the person at the desk: the rig's own closed loop.

This is the third thing the rig runs, beside capture and the desk socket, and it is the only one
that moves something without being asked. It exists because the rig has a camera on an arm and a
person in front of it, and "keep them in frame" is a loop — detection, a control law, and the arm's
own jog transport — not a request the server can compute.

The pieces come from the tracking project, which is not installable on anyone else's machine: its
detector needed a second virtualenv (ultralytics pins numpy the other way round from lerobot) and
its control law lived in a 100 Hz process of its own. Here the detector is `cv2.dnn` on an ONNX
export in the rig's venv, the law is a pure function (`arm/gimbal.py`), and this module is only the
clock between them.

**It never takes a frame of its own.** The capture loop already owns the camera, and a second
reader would halve both loops and race a `VideoCapture`. So the capture loop hands every frame it
takes to `observe`, which keeps the newest one in a single slot — the same shape as `visiond`'s
mailbox, and for the same reason: an old frame is worth nothing and a queue of them is worse. The
loop wakes at `track_fps`, detects only when that slot holds something new, and jogs the arm on
every tick, because the law's own stale gate is what decides whether a target that stopped arriving
still deserves motion.

Three rules keep it honest, and each is a bug the tracking project paid for:

* **A stale target commands zero.** The law holds the arm still rather than chasing a detection that
  stopped arriving (`STALE_MS`), because a camera that keeps turning on old news walks off the desk.
* **A requested move wins.** `arm.aim`, `arm.point` and `arm.home` freeze this loop for their
  duration. Two things driving one arm is what the whole arm package refuses, and it applies inside
  the rig as much as between the rig and the console.
* **Nothing here raises into the caller.** A camera that went away, a model that will not load, an
  arm that stopped answering: each is a log line, never a dead task — the capture loop and the desk
  socket must outlive all of them.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .track.tracker import TargetTracker

if TYPE_CHECKING:
    import numpy as np

    from .arm.driver import ArmDriver
    from .arm.gimbal import Gimbal, Target as GimbalTarget
    from .camera import Frame
    from .config import Config

#: How often the arm is told to hold while nothing is being followed. The law
#: zeroes the rates by itself; this is what stops a jog left on the transport
#: (armd drops one after 250 ms, and the last thing it heard must be a zero).
IDLE_HZ = 4.0


class _Failures:
    """One log line per failure, per source, and one when that source answers again.

    The loop's failures used to share a single slot, and two of them alternating — an arm
    that will not report its joints and an arm that will not take a jog, every tick —
    overwrote each other, so the rig logged at its tick rate. The live rig wrote those two
    lines twenty times a second for thirteen minutes, and the wall of them is what hid the
    stalled camera beside them. A failure is news once; its repetition is not.
    """

    def __init__(self, log: logging.Logger) -> None:
        self._log = log
        self._seen: dict[str, str] = {}

    def note(self, source: str, message: str) -> None:
        """Report a failure, unless this source is already failing exactly like this."""
        if self._seen.get(source) == message:
            return
        self._seen[source] = message
        self._log.warning("%s", message)

    def recovered(self, source: str, message: str) -> None:
        """The same source answered: one line, and its failure is news again next time."""
        if self._seen.pop(source, None) is not None:
            self._log.info("%s", message)

    def failed(self, *sources: str) -> bool:
        return any(source in self._seen for source in sources)

    @property
    def error(self) -> str | None:
        """The most recent failure, for `state()` and the doctor."""
        return next(reversed(self._seen.values()), None) if self._seen else None


@dataclass(frozen=True)
class _Slot:
    """The newest frame the capture loop handed over, and what it is."""

    jpeg: bytes
    width: int
    height: int
    at: float


class Tracker:
    """The follow loop. `run()` until cancelled; `set_on()` to start and stop it."""

    def __init__(
        self,
        cfg: Config,
        arm: ArmDriver | None,
        gimbal: Gimbal | None,
        log: logging.Logger,
    ) -> None:
        self._cfg = cfg
        self._arm = arm
        self._gimbal = gimbal
        self._log = log

        self._on = cfg.tracking == "auto"
        self._frozen = 0
        # Engaging is deferred to the first tick: the constructor must not talk to the arm
        # (a `Tracker` is built before the loop starts, and a console round trip there would
        # block the boot), and a rig whose arm was not there yet gets its mode set when the
        # loop actually runs.
        self._engaged = False

        self._detector: object | None = None
        self._tracker = TargetTracker(log, aim=(0.5, 0.5), deadband=cfg.track_deadband)
        self._slot: _Slot | None = None
        self._seen: bytes | None = None
        self._previous: tuple[float, float] | None = None
        self._previous_at = 0.0
        self._failures = _Failures(log)
        self._fps = 0.0
        self._ticks = 0
        self._rate_at = 0.0
        self._targets = 0

    # ---- what the rest of the rig asks it ----------------------------------

    @property
    def on(self) -> bool:
        """Whether the loop is following. Read by `arm.track` and by the doctor."""
        return self._on

    def set_on(self, on: bool) -> None:
        """`arm.track`: follow, or stop following and leave the arm where it is.

        A rig that was configured `HELI_TRACKING=off` refuses to be turned on by the
        server, and the caller reports that rather than acking a loop that never ran:
        an observer that starts moving a camera because a socket said so is the thing
        the `off` default exists to prevent.
        """
        # What is missing comes first: "the arm is not there" is the more actionable
        # answer for a rig whose law was never built, and the configuration check below
        # would otherwise hide it behind a setting that is already correct.
        if on and (self._gimbal is None or self._arm is None):
            raise RuntimeError("tracking needs the arm, and none answered")
        if on and self._on:
            # Already following: nothing to engage, and nothing to say.
            return
        if on and self._cfg.tracking != "auto":
            # The tracker is the authority on this, not the caller: a rig configured
            # `off` must not start moving a camera because something asked it to, and a
            # guard only in the action handler would leave the same hole open to any
            # other caller.
            raise RuntimeError(
                "this rig was configured HELI_TRACKING=off: set it to auto to follow a person"
            )
        if on == self._on:
            return
        # Engage before claiming: `_engage` talks to the arm and the law, and it is the
        # call that fails when there is no console behind armd. Setting `_on` first left a
        # tracker that reported `following` while nothing was engaged — an `arm.track`
        # acked `failed` beside a heartbeat claiming the rig was following, which is the
        # one pair of claims that must never disagree.
        if on:
            self._engage()
            self._engaged = True
        self._on = on
        self._log.info("tracking %s", "on" if on else "off")
        if not on:
            self._engaged = False
            self._hold()

    def _engage(self) -> None:
        """Put both halves into the mode that moves: the law in `track`, armd in `pose`.

        Two modes, because they are two programs. Our control law only steers on a
        target in its own `track` mode (`idle` commands nothing however good the target
        is); armd only applies a jog in `pose` — that is the mode its rate transport
        belongs to, and the same one `arm.aim` uses, so the two never disagree about
        who is driving the arm.

        Failures are the caller's to report: a rig whose arm will not take a mode has
        no follow loop, and `arm.track` says so rather than acking a loop that would
        sit still.
        """
        self._gimbal.set_mode("track")  # type: ignore[union-attr]
        self._arm.mode("pose")  # type: ignore[union-attr]

    def freeze(self, doing: str) -> None:
        """Hold the loop still while something else moves the arm.

        Counted rather than a flag: a `home` asked for during a `nod` must not unfreeze
        the `nod` when it ends, and the arm would then be driven by two things at once —
        the exact failure this exists to prevent. `doing` names the action so the log
        says who paused it.
        """
        self._frozen += 1
        if self._frozen == 1:
            self._log.debug("tracking paused for %s", doing)

    def thaw(self, doing: str) -> None:
        self._frozen = max(0, self._frozen - 1)
        if self._frozen == 0:
            self._log.debug("tracking resumed after %s", doing)

    def state(self) -> dict:
        """What the doctor and a debugging session report about the loop."""
        return {
            "on": self._on,
            # Whether the modes are actually set. `on` is what was asked for; this is what
            # happened. A rig that booted with `HELI_TRACKING=auto` and an arm that never
            # answered has `on` true and this false, and only the pair tells the truth —
            # the loop retries the engage every tick, so this turns true on its own the
            # moment the arm comes back.
            "engaged": self._engaged,
            "frozen": self._frozen > 0,
            "fps": round(self._fps, 1),
            "targets": self._targets,
            "error": self._failures.error,
            # Whether the arm is still the arm: a bridge that died leaves the loop ticking
            # and the law holding, and the rig says so rather than reporting a follow that
            # is not happening.
            "arm": self.arm_answering,
        }

    @property
    def arm_answering(self) -> bool:
        """Whether the arm took the last joints read and jog it was given.

        A bridge that dies mid-session leaves this false: the law holds the arm where it is,
        the loop keeps ticking and the camera keeps running, and `desk.health.following` says
        the rig is not following — which is true, and is the difference between a switch that
        is on and an arm that is moving.
        """
        return not self._failures.failed("joints", "jog")

    @property
    def following(self) -> bool:
        """Whether this rig is following a person *now*: engaged, not merely asked to.

        This is what `desk.health.following` carries. Intent is not enough: an `arm.track`
        that acked `failed` and a heartbeat that says `true` are two claims about one rig,
        and a person reading the app sees a switch that is on over an arm that is not
        moving. Frozen does not count against it — a `nod` pausing the loop for a second is
        still a rig that is following. Neither does an arm that stopped answering: a rig
        whose arm is gone is a rig that is not following anyone.
        """
        return self._on and self._engaged and self.arm_answering

    # ---- the frame the capture loop hands over -----------------------------

    def observe(self, frame: Frame) -> None:
        """Keep the newest frame. Called by the capture loop, on its own thread of control.

        Cheap on purpose: this runs inside the capture loop's tick, so it must not
        decode, detect or block. One assignment, and the newest frame wins.
        """
        self._slot = _Slot(frame.jpeg, frame.width, frame.height, time.monotonic())

    # ---- the loop ----------------------------------------------------------

    async def run(self) -> None:
        """Detect when there is news, jog every tick — until cancelled. Never raises."""
        interval = 1.0 / self._cfg.track_fps
        idle = 1.0 / IDLE_HZ
        loop = asyncio.get_running_loop()
        due = loop.time()
        while True:
            following = self._on and self._frozen == 0
            try:
                if following:
                    if not self._engaged:
                        # Deferred to here rather than done in the constructor: this is the
                        # first moment the arm is worth talking to, and a mode that failed to
                        # set is retried on the next tick instead of ending the boot.
                        await asyncio.to_thread(self._engage)
                        self._engaged = True
                    await self._tick()
                elif self._on:
                    # Paused for an action: the arm must not keep the last jog it was
                    # given, or the two of us move it at once.
                    self._hold()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # a loop that dies takes the arm with it
                self._fail(exc)

            now = loop.time()
            due += interval if following else idle
            if due < now - interval:
                due = now
            await asyncio.sleep(max(0.0, due - now))

    async def _tick(self) -> None:
        """One tick: detect if the frame is new, then jog at the rates the law answers."""
        slot = self._slot
        if slot is not None and slot.jpeg is not self._seen:
            self._seen = slot.jpeg
            await self._detect(slot)

        if self._gimbal is None or self._arm is None:
            return
        # All the arm IO in one thread hop: a console round trip is ~15 ms and there
        # are three of them per tick (a state read and a jog per steered joint), which
        # is most of a 10 Hz tick if it blocks the event loop the capture loop and the
        # socket share.
        await asyncio.to_thread(self._drive)
        self._count()

    def _drive(self) -> None:
        """Read the arm, step the law, jog the rates. Runs off the event loop."""
        gimbal, arm = self._gimbal, self._arm
        assert gimbal is not None and arm is not None
        now = time.monotonic()
        # Stepped on every tick, not only on a new frame: the law's stale gate is what
        # turns "the target stopped arriving" into zero rates, and it can only do that
        # if it is asked.
        gimbal.step(1.0 / self._cfg.track_fps, self._measured(arm), now)
        if self._frozen > 0 or not self._on:
            # Something took the arm while this tick was in flight — an `arm.aim`, a
            # `home`, or the loop being switched off. The decision at the top of `run()`
            # was made before that, and the joints read above is where the tick spent its
            # time, so the check has to be made again here: the last thing the transport
            # hears must be a zero, or the rig drives the arm underneath the action that
            # asked for it — armd keeps applying a jog for a further 250 ms.
            self._hold()
            return
        self._jog(arm, dict(gimbal.rates))

    async def _detect(self, slot: _Slot) -> None:
        """Decode the newest frame, find the person, and give the law a target."""
        detector = self._detector or self._load_detector()
        if detector is None:
            return
        # ~25 fps of CPU work on a 640x480 frame: off the event loop, or the capture
        # loop's cadence and the socket's acks wait behind it.
        bgr = await asyncio.to_thread(_decode, slot.jpeg)
        if bgr is None:
            self._failures.note("frames", "the camera's frames are not decodable; is it a JPEG?")
            return
        detections = await asyncio.to_thread(detector.detect, bgr)  # type: ignore[attr-defined]
        target = self._tracker.update(detections, (slot.width, slot.height), slot.at)
        self._targets = len(detections)
        self._failures.recovered("frames", "the camera's frames are decoding again")
        if not target.valid:
            # No lock this frame. The law is handed nothing and lets the target age out,
            # which is what holds the arm instead of steering on a memory.
            return
        vx, vy = self._velocity(target.x, target.y, slot.at)
        self._gimbal.set_target(_as_gimbal_target(target, vx, vy, slot.at))  # type: ignore[union-attr]

    def _load_detector(self) -> object | None:
        """The pose detector, loaded once. A model that will not load is one line."""
        from .config import model_path

        path = model_path(self._cfg)
        try:
            from .track.detector import PoseDetector

            self._detector = PoseDetector(path, self._log)
        except Exception as exc:
            self._failures.note("model", f"tracking cannot load its model ({path}): {exc}")
            return None
        return self._detector

    def _measured(self, arm: ArmDriver) -> dict[str, float]:
        """The joints the law steers by, or an empty mapping when the arm will not say.

        Read per tick rather than cached: the law moves the goal relative to where the
        arm *is*, and a stale measurement is how a loop integrates its way into a bound.
        An empty mapping makes the law hold, which is the safe answer to a bus that
        stopped answering.
        """
        try:
            joints = dict(arm.joints())
        except Exception as exc:
            self._failures.note("joints", f"the arm would not report its joints: {exc}")
            return {}
        self._failures.recovered("joints", "the arm is reporting its joints again")
        return joints

    def _jog(self, arm: ArmDriver, rates: dict[str, float]) -> None:
        """Tell the arm the rate of each joint. A refusal is logged once, not per tick."""
        try:
            arm.jog(rates)
        except Exception as exc:
            self._failures.note("jog", f"the arm would not take a jog: {exc}")
            return
        self._failures.recovered("jog", "the arm is taking a jog again")

    def _hold(self) -> None:
        """Ask the arm for zero on both steered joints, so no jog is left standing."""
        arm = self._arm
        if arm is None:
            return
        try:
            arm.jog({"shoulder_pan": 0.0, "wrist_flex": 0.0})
        except Exception as exc:
            self._log.debug("could not stop the arm's jog: %s", exc)

    def _velocity(self, x: float, y: float, at: float) -> tuple[float, float]:
        """The target's own speed, in frame-widths per second, from the previous sample.

        The feed-forward term is what keeps the camera moving at a person's pace rather
        than lagging by however long the P term takes to notice. One sample of history is
        enough for that, and a first sample reports no velocity rather than a guess.
        """
        previous, previous_at = self._previous, self._previous_at
        self._previous, self._previous_at = (x, y), at
        if previous is None:
            return 0.0, 0.0
        dt = at - previous_at
        if dt <= 0.0 or dt > 1.0:
            # Zero, or a gap so long it is two positions rather than a velocity.
            return 0.0, 0.0
        return (x - previous[0]) / dt, (y - previous[1]) / dt

    def _count(self) -> None:
        """The loop's own rate, measured over a window rather than assumed."""
        self._ticks += 1
        now = time.monotonic()
        if self._rate_at == 0.0:
            self._rate_at = now
            return
        elapsed = now - self._rate_at
        if elapsed >= 1.0:
            self._fps = self._ticks / elapsed
            self._ticks = 0
            self._rate_at = now

    def _fail(self, exc: Exception) -> None:
        self._failures.note("tick", f"tracking stopped this tick: {exc}")


def _decode(jpeg: bytes) -> np.ndarray | None:
    """A JPEG as BGR, or None when OpenCV will not read it."""
    import cv2
    import numpy as np

    return cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)


def _as_gimbal_target(target: object, vx: float, vy: float, at: float) -> GimbalTarget:
    """The tracker's `Target` as the law's own: the same fields under the law's names."""
    from .arm.gimbal import Target as GimbalTarget

    return GimbalTarget(
        valid=True,
        tid=getattr(target, "id", None),
        conf=float(getattr(target, "conf", 0.0)),
        ex=float(target.x),  # type: ignore[attr-defined]
        ey=float(target.y),  # type: ignore[attr-defined]
        vx=vx,
        vy=vy,
        at=at,
    )
