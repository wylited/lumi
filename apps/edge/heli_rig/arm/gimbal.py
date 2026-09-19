"""The control law: two axes, normalized pixel error in, joint goals out.

Ported from ``/Users/wyli/Repos/tracking/tracking/gimbal.py``, the SO-101 camera gimbal's control
law. Aiming the camera is exactly two joints because the camera sits downstream of both: pan comes
from the person's horizontal error, tilt from the vertical one. Everything else is a clamp, a
watchdog, or a flag.

What changed in the port, so the two files can still be read side by side:

* **No config, no disk.** Every value the original took from ``tracking/config.py`` at import, or
  from ``limits.json``/``motion.json`` at runtime, arrives through the constructor
  (``window``/``ready``/``park``/``signs``/``aim``/``caps``). ``from_files`` is the one place that
  reads those two files, for a caller that has them. This module imports no rig config, reads no
  environment and touches no hardware.
* **No clock.** ``now`` is an argument everywhere and nothing here sleeps or calls
  ``time.monotonic``, which is what makes ``step(dt, measured, now)`` a pure function of its
  arguments and its own state.
* **``step`` answers the goals alone.** The flags it computes are kept in ``self.flags`` and the
  per-joint commanded rate in ``self.rates`` (both also in ``snapshot()``). The rate is what a
  rate-driven transport wants - armd's ``jog {joint, rate}``, which is the dialect the rig's arm
  speaks - while the goals remain the law's own answer and what the tests pin.
* **``Target``** keeps the original's names and meaning: ``ex``/``ey`` are the detected point's
  offset from the aim point, normalized to the frame, +x right and +y down - exactly
  ``heli_rig.track.Target.x/y``, already reduced against the tracker's own aim point, so a tracker
  target maps straight onto it. ``vx``/``vy`` are the same units per second and feed the
  feed-forward term; pass 0.0 when no velocity is known.
* Constants measured on this rig keep their provenance (the file the number came from) in the
  comment above them.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

MODES = ("idle", "manual", "track", "pose", "park")

# The arm this law drives, from the tracking project's config.py (ARM_JOINTS/PAN_JOINT/TILT_JOINT).
ARM_JOINTS = ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll")
PAN_JOINT = "shoulder_pan"
TILT_JOINT = "wrist_flex"
HELD_JOINTS = tuple(j for j in ARM_JOINTS if j not in (PAN_JOINT, TILT_JOINT))

LOOP_HZ = 100.0                 # config.py: the rate the dt floor stands in for
REL_STEP_DEG = 4.0              # config.py: per-tick clamp on goal vs measured (anti-windup + damage bound)
REL_STEP_LOADED_DEG = 8.0       # config.py MAX_REL_DEG: the loaded axis's lead, lerobot's per-send bound
LOAD_RATE_FRAC = 0.6            # achieved/commanded rate below which the axis is treated as loaded
DIVERGENCE_HOLD_S = 1.5         # hold still this long after a divergence before trying again
DIVERGENCE_TICKS = 150          # ~1.5 s of saturated request at the loop rate...
DIVERGENCE_GROWTH = 0.15        # ...with the error grown by this much: a runaway, not a fast person
STALE_MS = 300.0                # no fresh vision target -> commanded rate 0
INPUT_STALE_MS = 250.0          # no fresh pad input -> commanded rate 0
LEAD_MS = 60.0                  # aim-point lead from the target's own velocity
# The rig's optical gain, measured on this hardware (config.py, /tmp/verify_signs.py: a pan of
# +1 deg moves the aim point by -0.0309 of the frame width, a wrist of +1 deg by -0.0341 of the
# height). The feed-forward divides by these to turn the target's measured velocity into the joint
# rate that merely keeps up with it; without that term the feedback has to fight a standing lag,
# saturates, and then swings wide. Negative because the joint moves the aim point the other way.
EX_PER_DEG = -0.0309
EY_PER_DEG = -0.0341
# How far track mode may travel from the pose it was engaged from. Engaged while looking at the
# person, this is the whole arc it needs: the camera's half-field is about 30 deg, so a target
# anywhere in the frame is inside it. What it stops is the rig chasing its own error out of the
# room (measured: 68 deg of pan swing in 30 s). A person who walks out of the arc is a re-engage.
TRACK_LEASH_DEG = 25.0
FEEDFORWARD = True              # add the target's own velocity (in joint-rate units) to the request
FF_MAX_FRAC = 0.5               # the feed-forward may supply at most half the axis speed on its own
FF_MIN_VEL = 0.06               # normalized units/s below which the velocity is jitter, not motion
DEADBAND = 0.04                 # normalized pixel error treated as centered; the rig's own
                                # `HELI_TRACK_DEADBAND` default is the same number on purpose
STALL_MS = 400.0                # commanded motion with no travel this long -> give the axis more lead
STALL_DEG = 0.25                # deg of travel that counts as progress
STALL_MIN_RATE = 2.0            # deg/s below which we are not really commanding motion
JOG_VMAX = 10.0                 # deg/s while jogging a joint in pose mode
PARK_VMAX = 20.0                # deg/s while slewing to the park pose
PARK_TOL = 1.5                  # deg; a joint this close to its park target has arrived
PARK_SETTLE_S = 0.8             # no progress for this long -> park is as done as it gets
# Absolute pan envelope, degrees in the measured frame, from config.py: measured on this rig, the
# base assembly goes free to +105 and then stalls hard (that stall latched servo 1 into overload
# protection), so the envelope stops short of it and the ready-relative window is intersected with
# it - which means the ready pose can be captured wherever the person sits without ever re-exposing
# the mechanical stop.
PAN_ENVELOPE = (-90.0, 95.0)
KP = {"pan": 120.0, "tilt": 80.0}   # config.py: deg/s per unit normalized error
# config.py MANUAL: permissive caps for the modes the operator drives by hand (manual/pose/park),
# so they can demonstrate the fastest motion they consider safe; track mode runs on the measured
# caps below, which is the whole point of recording a take.
MANUAL = {"pan_v_max": 250.0, "pan_a_max": 2000.0, "tilt_v_max": 180.0, "tilt_a_max": 1200.0}
# motion.json (take-20260919-180344, analysed 2026-09-19): what this rig's pan and wrist were
# actually measured to do - pan 38.6 deg/s at 221.0 deg/s^2, tilt 88.2 at 300.5. config.py carries a
# TRACK of 180/900 and 120/600 that motion.json exists to replace; a caller with no motion file
# gets these, because they are the ones measured here.
TRACK = {"pan_v_max": 38.6, "pan_a_max": 221.0, "tilt_v_max": 88.2, "tilt_a_max": 300.5}
# limits.json's own records: the aim point the target's error is measured against, and the joint
# signs the law drives with (both 1 on this rig, i.e. a positive error commands positive travel).
AIM = (0.5, 0.5)
SIGNS = (1, 1)


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


@dataclass
class Target:
    """Latest vision target, already reduced to what the gimbal needs.

    ``ex``/``ey`` are the detected point's offset from the aim point in frame-normalized units, +x
    to the right and +y down - the tracking project's own convention, and exactly
    ``heli_rig.track.Target.x/y``. ``vx``/``vy`` are the same units per second (0.0 when no
    velocity is known). ``at`` is the caller's monotonic stamp: the law tells a live target from a
    stale one by comparing it against the ``now`` it is stepped with, and never reads a clock.
    """

    valid: bool = False
    tid: int | None = None
    conf: float = 0.0
    ex: float = 0.0          # normalized horizontal error: target minus aim point
    ey: float = 0.0          # normalized vertical error
    vx: float = 0.0          # normalized units per second
    vy: float = 0.0
    at: float = 0.0          # the caller's monotonic stamp on arrival

    def age_ms(self, now: float) -> float:
        return (now - self.at) * 1e3

    @classmethod
    def from_point(
        cls,
        x: float,
        y: float,
        aim: tuple[float, float],
        *,
        tid: int | None = None,
        conf: float = 0.0,
        vx: float = 0.0,
        vy: float = 0.0,
        now: float = 0.0,
    ) -> Target:
        """A target from a point in the frame, normalized 0..1, reduced against ``aim``.

        The one place the aim point is subtracted, so a caller holding the detector's chest (or
        ``Detection.chest()`` reduced by the frame size) does not also subtract a tracker's aim.
        """
        return cls(
            valid=True,
            tid=tid,
            conf=conf,
            ex=float(x) - float(aim[0]),
            ey=float(y) - float(aim[1]),
            vx=vx,
            vy=vy,
            at=now,
        )


@dataclass
class Axis:
    joint: str
    sign: int
    kp: float
    v_max: float
    a_max: float
    lo: float = -180.0
    hi: float = 180.0
    goal: float | None = None
    rate: float = 0.0
    stall_at: float | None = None      # monotonic stamp when the axis started making no progress
    stall_ref: float = 0.0             # measured value at that stamp
    stall_ref_dir: float = 0.0         # commanded direction when the stall latched
    blocked: bool = False              # latched: stop pushing, hold where we are
    rel_step: float = REL_STEP_DEG     # how far the goal may lead the measured pose (torque budget)
    anchor: float | None = None        # pose track mode was engaged from, for the leash


def _read_json(path: str | Path, log: logging.Logger) -> dict:
    """A JSON object from disk, or an empty one with a line in the log (never a raise)."""
    try:
        with open(path) as fh:
            loaded = json.load(fh)
    except FileNotFoundError:
        log.info("gimbal: no %s yet; using defaults", path)
        return {}
    except (OSError, ValueError) as exc:
        log.warning("gimbal: %s unreadable (%s); using defaults", path, exc)
        return {}
    return loaded if isinstance(loaded, dict) else {}


class Gimbal:
    """The control law, driven by the caller's clock and the arm's last measured pose.

    ``step`` is the whole interface: hand it a tick, the measured joint angles and the time, and it
    answers the goal per joint. Everything the law remembers between ticks (integrator rates, the
    leash anchors, the stall and divergence latches) lives on the instance.
    """

    def __init__(
        self,
        log: logging.Logger | None = None,
        *,
        pan_joint: str = PAN_JOINT,
        tilt_joint: str = TILT_JOINT,
        window: Mapping[str, Mapping[str, float]] | None = None,
        ready: Mapping[str, float] | None = None,
        park: Mapping[str, float] | None = None,
        signs: tuple[int, int] = SIGNS,
        aim: tuple[float, float] = AIM,
        caps: Mapping[str, float] | None = None,
        kp: Mapping[str, float] = KP,
        deadband: float = DEADBAND,
        lead_s: float = LEAD_MS / 1e3,
        jog_v: float = JOG_VMAX,
        park_v: float = PARK_VMAX,
        stale_ms: float = STALE_MS,
        input_stale_ms: float = INPUT_STALE_MS,
        rel_step: float = REL_STEP_DEG,
    ) -> None:
        self.log = log if log is not None else logging.getLogger(__name__)
        self.aim = (float(aim[0]), float(aim[1]))
        self.ready = dict(ready or {})
        self.park = dict(park or {})
        self.window = {str(j): dict(w) for j, w in (window or {}).items()}
        self.held = tuple(j for j in ARM_JOINTS if j not in (pan_joint, tilt_joint))
        self.mode = "idle"
        self.deadband = float(deadband)
        self.lead_s = float(lead_s)
        self.park_v = float(park_v)
        self.jog_v = float(jog_v)
        self.stale_ms = float(stale_ms)
        self.input_stale_ms = float(input_stale_ms)
        self.estopped = False
        limits = dict(caps or TRACK)
        self.pan = Axis(
            joint=pan_joint,
            sign=int(signs[0]),
            kp=float(kp["pan"]),
            v_max=float(limits.get("pan_v_max", TRACK["pan_v_max"])),
            a_max=float(limits.get("pan_a_max", TRACK["pan_a_max"])),
            rel_step=float(rel_step),
        )
        self.tilt = Axis(
            joint=tilt_joint,
            sign=int(signs[1]),
            kp=float(kp["tilt"]),
            v_max=float(limits.get("tilt_v_max", TRACK["tilt_v_max"])),
            a_max=float(limits.get("tilt_a_max", TRACK["tilt_a_max"])),
            rel_step=float(rel_step),
        )
        # The software window, exactly as the source's apply_limits left it: the joint's own window,
        # the pan envelope intersected in, and the window rewritten to match what is enforced - or
        # the operator's UI would show a bound the loop does not honour.
        for ax in (self.pan, self.tilt):
            win = self.window.get(ax.joint)
            if win:
                ax.lo, ax.hi = float(win["min"]), float(win["max"])
        env = PAN_ENVELOPE
        if env:
            self.pan.lo = max(self.pan.lo, float(env[0]))
            self.pan.hi = min(self.pan.hi, float(env[1]))
            self.window[self.pan.joint] = {"min": self.pan.lo, "max": self.pan.hi}
        # Integrator state, from the source's __post_init__.
        self.goals: dict[str, float] = {}
        self.input = [0.0, 0.0]
        self._input_at = 0.0
        self._jog: dict[str, float] = {}
        self._jog_at = 0.0
        self.target: Target | None = None
        self._div_run = 0
        self._div_err0 = 0.0
        self.divergence = False
        self._div_at = 0.0
        self.park_done = False
        self._park_still: dict[str, tuple[float, float]] = {}   # joint -> (pose, since) when parked
        self.flags: dict[str, bool] = {}
        self.rates: dict[str, float] = {j: 0.0 for j in ARM_JOINTS}

    @classmethod
    def from_files(
        cls,
        limits_path: str | Path,
        motion_path: str | Path,
        log: logging.Logger | None = None,
        *,
        caps_key: str = "track",
        **kwargs,
    ) -> Gimbal:
        """A gimbal from the tracking project's own records, for a caller that has the paths.

        ``limits_path`` is ``limits.json`` (window/ready/park/pan_joint/tilt_joint/pan_sign/
        tilt_sign/aim) and ``motion_path`` is ``motion.json`` (its ``track`` caps). A file that is
        missing is logged and its defaults are used, so a rig that has never captured a ready pose
        still runs. Everything the caller passes in ``kwargs`` wins over the files.
        """
        log = log if log is not None else logging.getLogger(__name__)
        limits = _read_json(limits_path, log)
        motion = _read_json(motion_path, log)
        kwargs.setdefault("pan_joint", str(limits.get("pan_joint") or PAN_JOINT))
        kwargs.setdefault("tilt_joint", str(limits.get("tilt_joint") or TILT_JOINT))
        kwargs.setdefault("window", limits.get("window") or {})
        kwargs.setdefault("ready", limits.get("ready") or {})
        kwargs.setdefault("park", limits.get("park") or {})
        kwargs.setdefault(
            "signs",
            (int(limits.get("pan_sign", SIGNS[0])), int(limits.get("tilt_sign", SIGNS[1]))),
        )
        kwargs.setdefault("aim", tuple(limits.get("aim") or AIM))
        kwargs.setdefault("caps", motion.get(caps_key) or None)
        return cls(log, **kwargs)

    # ---------------------------------------------------------------- setup
    def apply_caps(self, caps: Mapping[str, float]) -> None:
        """Runtime caps, as the source's apply_caps: track runs on the measured take, the modes the
        operator drives by hand on the permissive MANUAL set."""
        self.pan.v_max = float(caps.get("pan_v_max", self.pan.v_max))
        self.pan.a_max = float(caps.get("pan_a_max", self.pan.a_max))
        self.tilt.v_max = float(caps.get("tilt_v_max", self.tilt.v_max))
        self.tilt.a_max = float(caps.get("tilt_a_max", self.tilt.a_max))

    def set_kp(self, axis: str, value: float) -> None:
        getattr(self, axis).kp = float(value)

    def flip_sign(self, axis: str) -> int:
        ax = getattr(self, axis)
        ax.sign = -ax.sign
        return ax.sign

    # -------------------------------------------------------------- commands
    def set_mode(self, mode: str) -> None:
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode!r}; expected one of {MODES}")
        if mode == self.mode:
            return
        self.mode = mode
        self.divergence = False
        self._div_run = 0
        self.park_done = False
        for ax in (self.pan, self.tilt):
            ax.blocked = False
            ax.stall_at = None
        if mode != "pose":
            self._jog.clear()
        if mode != "manual":
            self.input = [0.0, 0.0]
        if mode != "park":
            self._park_still.clear()
        if mode == "park" or mode == "idle":
            # entering park/idle: freeze the integrator and drop the leash anchor, so the next
            # engagement anchors to wherever the camera is *then*, not to a goal left over from the
            # last one
            self.pan.rate = self.tilt.rate = 0.0
            for ax in (self.pan, self.tilt):
                ax.anchor = None
        self.log.info("gimbal: mode -> %s", mode)

    def set_input(self, x: float, y: float, now: float) -> None:
        """The manual pad, -1..1 per axis, stamped so the law can tell a stale one from a live one."""
        self.input = [clamp(float(x), -1.0, 1.0), clamp(float(y), -1.0, 1.0)]
        self._input_at = now

    def set_jog(self, joint: str, rate: float, now: float) -> None:
        if joint not in ARM_JOINTS:
            raise ValueError(f"unknown joint {joint!r}")
        self._jog[joint] = clamp(float(rate), -self.jog_v, self.jog_v)
        self._jog_at = now

    def set_target(self, tgt: Target | None) -> None:
        if tgt is not None and self.target is not None and tgt.tid != self.target.tid:
            self.divergence = False
            self._div_run = 0
        self.target = tgt

    def freeze(self, on: bool) -> None:
        """The E-stop: no request reaches the axes while it is on, and nothing is un-leashed."""
        self.estopped = bool(on)
        if on:
            self.pan.rate = self.tilt.rate = 0.0
            for ax in (self.pan, self.tilt):
                ax.blocked = False
                ax.stall_at = None
            self.input = [0.0, 0.0]
            self._jog.clear()
            self.log.warning("gimbal: motion frozen (E-stop)")
        else:
            self.log.info("gimbal: E-stop cleared")

    # ------------------------------------------------------------------ step
    def step(self, dt: float, measured: Mapping[str, float], now: float) -> dict[str, float]:
        """One tick: the goal per joint, in degrees.

        Pure with respect to time - ``now`` is the caller's stamp, ``dt`` its tick, and nothing here
        waits - so a test can drive it at any rate and compare exact numbers. The flags this
        computes are kept in ``self.flags`` (and ``snapshot()``).
        """
        flags = {
            "at_limit": False,
            "held_clamped": False,
            "rel_clamped": False,
            "clamped": False,
            "stale": False,
            "stalled": False,
            "divergence": False,
            "estopped": self.estopped,
            "park_done": False,
        }
        if dt <= 0:
            dt = 1.0 / LOOP_HZ
        if not self.goals:
            self.goals = {j: float(measured.get(j, 0.0)) for j in ARM_JOINTS}
        if self.mode == "track":
            # The leash is anchored to where the camera actually is, taken on the first tick of the
            # engagement. Anchoring it in set_mode would depend on the goals being populated first,
            # and any path that engages track without them (a restart, a scripted run) would leave
            # the axis unanchored, i.e. free to travel the whole window.
            for ax in (self.pan, self.tilt):
                if ax.anchor is None:
                    ax.anchor = float(measured.get(ax.joint, self.goals.get(ax.joint, 0.0)))

        if self.estopped:
            self.pan.rate = self.tilt.rate = 0.0
            self.input = [0.0, 0.0]
            self._jog.clear()
            flags["at_limit"] = False
        elif self.mode == "park":
            self._run_park(dt, measured, flags, now)
        else:
            p_req, t_req, stale = self._active_requests(now)
            if stale:
                flags["stale"] = True
            self._integrate(self.pan, p_req, dt, measured, flags, now)
            self._integrate(self.tilt, t_req, dt, measured, flags, now)
            if self.mode == "pose":
                self._run_jog(dt, measured, flags, now)

        # One pass over every joint: held joints keep their last goal, the two active axes have
        # already been integrated (this call is idempotent for them) and every goal ends up clamped
        # both to its window and to one rel-step from where the arm actually is.
        for joint in ARM_JOINTS:
            ax = (
                self.pan
                if joint == self.pan.joint
                else self.tilt
                if joint == self.tilt.joint
                else None
            )
            self.goals[joint] = self._clamp_goal(
                joint, self.goals.get(joint, measured.get(joint, 0.0)), measured, flags, ax
            )

        flags["divergence"] = self.divergence
        goals = {j: round(float(v), 3) for j, v in self.goals.items()}
        self._sync_goals(goals)
        # The commanded rate per joint, in the joint's own direction: what a rate-driven transport
        # (armd's `jog {joint, rate}`) can send directly. It is the law's own integrator rate, so it
        # is already zero after an at-limit or stall back-off and while frozen, and a pose-mode jog
        # rides on top of it exactly as it rides on the goal. Park slews the goals directly (armd's
        # own `mode park` drives that move), so its rates report 0.0 and the goals are the answer.
        rates = {joint: 0.0 for joint in ARM_JOINTS}
        if not self.estopped:
            for ax in (self.pan, self.tilt):
                rates[ax.joint] = ax.sign * ax.rate
            for joint, rate in self._jog.items():
                rates[joint] = rates.get(joint, 0.0) + rate
        self.rates = rates
        self.flags = flags
        return goals

    # ------------------------------------------------------------- internals
    def _active_requests(self, now: float) -> tuple[float, float, bool]:
        """(pan request, tilt request, stale) in deg/s for this tick's mode."""
        if self.mode == "track":
            tgt = self.target
            if tgt is None or tgt.age_ms(now) > self.stale_ms:
                return 0.0, 0.0, True
            if not tgt.valid:
                # Vision is alive and talking, there is just nobody locked: hold still, do not raise
                # the stale flag (that one means the datagram stream itself went quiet).
                return 0.0, 0.0, False
            ex = tgt.ex + self.lead_s * tgt.vx
            ey = tgt.ey + self.lead_s * tgt.vy
            self._check_divergence(ex, ey, now)
            if self.divergence:
                return 0.0, 0.0, False
            # ex/ey are target-minus-aim, so a positive error is a command for positive joint
            # rotation (measured on this rig: d(ex)/d(pan) < 0 and d(ey)/d(wrist_flex) < 0, hence
            # the negative signs on the optical gains). The minus signs that used to be here made
            # the loop positive-feedback: any error grew, the axis ran to its bound, and the only
            # visible cure was flipping the axis sign - which inverted the operator's own pad
            # instead. The pad maps +1 to +v_max too, so both consumers agree on the sign field.
            p = (
                0.0
                if abs(ex) < self.deadband
                else clamp(self.pan.kp * ex, -self.pan.v_max, self.pan.v_max)
            )
            t = (
                0.0
                if abs(ey) < self.deadband
                else clamp(self.tilt.kp * ey, -self.tilt.v_max, self.tilt.v_max)
            )
            if FEEDFORWARD:
                # A person walking across the room moves the aim point faster than any gain can
                # catch up with: the feedback term ends up permanently saturated, a quarter cycle
                # behind, and the axis swings wide instead of following. Feeding the target's own
                # velocity forward as the joint rate that matches it leaves the feedback term with
                # only the residual to correct. Outside the deadband test on purpose - keeping
                # station on a moving person is not chatter - but gated on the velocity itself,
                # because a detected body part jitters by a pixel or two per frame and at this gain
                # that jitter would be tens of degrees per second of joint rate.
                if abs(tgt.vx) >= FF_MIN_VEL:
                    ff = clamp(
                        -tgt.vx / EX_PER_DEG,
                        -FF_MAX_FRAC * self.pan.v_max,
                        FF_MAX_FRAC * self.pan.v_max,
                    )
                    p = clamp(p + ff, -self.pan.v_max, self.pan.v_max)
                if abs(tgt.vy) >= FF_MIN_VEL:
                    ff = clamp(
                        -tgt.vy / EY_PER_DEG,
                        -FF_MAX_FRAC * self.tilt.v_max,
                        FF_MAX_FRAC * self.tilt.v_max,
                    )
                    t = clamp(t + ff, -self.tilt.v_max, self.tilt.v_max)
            return p, t, False
        if self.mode == "manual":
            if (now - self._input_at) * 1e3 > self.input_stale_ms:
                return 0.0, 0.0, True
            return self.input[0] * self.pan.v_max, self.input[1] * self.tilt.v_max, False
        return 0.0, 0.0, False

    def _check_divergence(self, ex: float, ey: float, now: float) -> None:
        """Latch only a runaway: the error *growing* while the request is saturated.

        Saturation alone is not divergence - a person crossing the room faster than the axis can
        travel is ordinary, and the loop must keep doing its best for as long as it lasts. What
        cannot be recovered from is positive feedback, where the axis chases its own error; there
        the error grows without limit. Requiring real growth over 1.5 s separates the two, and it
        stops the guard from freezing the loop on the very motion it exists to follow.
        """
        if self.divergence:
            # Releasing is the point: a latched divergence used to hold the loop dead until the
            # operator re-armed. Hold still for the timeout, then try again.
            if now - self._div_at >= DIVERGENCE_HOLD_S:
                self.divergence = False
                self._div_run = 0
                self._div_err0 = 0.0
            return
        err = max(abs(ex), abs(ey))
        rate = max(abs(self.pan.rate), abs(self.tilt.rate))
        v_max = max(self.pan.v_max, self.tilt.v_max)
        if rate >= 0.9 * v_max:
            if self._div_run == 0:
                self._div_err0 = err
            self._div_run += 1
        else:
            self._div_run = 0
        if self._div_run > DIVERGENCE_TICKS and err > self._div_err0 + DIVERGENCE_GROWTH:
            self.divergence = True
            self._div_at = now
            self._div_run = 0
            self.pan.rate = self.tilt.rate = 0.0
            self.log.warning(
                "gimbal: divergence latched: error %.3f > %.3f + %.2f with the pan request "
                "saturated at %.1f deg/s",
                err,
                self._div_err0,
                DIVERGENCE_GROWTH,
                self.pan.v_max,
            )

    def _integrate(
        self,
        ax: Axis,
        req: float,
        dt: float,
        measured: Mapping[str, float],
        flags: dict[str, bool],
        now: float,
    ) -> None:
        if self._against_bound(ax, req, measured):
            # The request pushes past a bound this axis is already on, so nothing further is
            # commanded and the goal goes to where the arm actually is. Leaving the goal parked on
            # the bound instead holds a standing position error, and a position servo answers that
            # with standing torque, which is grinding: the window's up end can be past the physical
            # wall the wrist really stops at (measured: holds at -81.93 with the goal at -84.07), so
            # "pinned at the bound" meant pressing into the stop indefinitely. At the measured pose
            # the error is zero, the axis is free, and it moves on the first reversed request. This
            # is deliberately not the `blocked` latch: `at_limit` says the envelope ended the
            # travel, `stalled` says something is in the way, and the operator acts differently on
            # each.
            flags["at_limit"] = True
            ax.rate = 0.0
            ax.goal = measured.get(ax.joint, ax.goal)
            self.goals[ax.joint] = self._clamp_goal(ax.joint, ax.goal, measured, flags, ax)
            return
        if self._stall_gate(ax, req, measured, flags, now):
            # the axis is against something it cannot move: hold the present pose instead of holding
            # torque against the obstruction (that is what latched servo 1 into overload).
            req = 0.0
            ax.goal = measured.get(ax.joint, ax.goal)
            self.goals[ax.joint] = self._clamp_goal(ax.joint, ax.goal, measured, flags, ax)
            return
        rate = ax.rate + clamp(req - ax.rate, -ax.a_max * dt, ax.a_max * dt)
        if req == 0.0 and abs(rate) < 0.05:
            rate = 0.0
        ax.rate = rate
        goal = (ax.goal if ax.goal is not None else measured.get(ax.joint, 0.0)) + ax.sign * rate * dt
        ax.goal = goal
        self.goals[ax.joint] = self._clamp_goal(ax.joint, goal, measured, flags, ax)

    def _stall_gate(
        self,
        ax: Axis,
        req: float,
        measured: Mapping[str, float],
        flags: dict[str, bool],
        now: float,
    ) -> bool:
        """True while this axis is blocked by something: commanded motion that produces no travel.

        A bound of its own envelope is not an obstruction and is handled by the caller before this
        is reached (see ``_integrate``), because latching here is what made "look up" a one-way
        trip: the axis refused every further request in that direction until the operator pushed the
        other way, which is exactly how a camera at its own tilt bound reads as "it cannot tilt up".

        A position servo told to reach an unreachable goal holds full torque against whatever is in
        the way. 400 ms of that is enough to latch STS overload protection (measured: servo 1 went
        deaf after being pinned against a stop for ~1.5 s), so the software backs off to "stay where
        you are" and reports it instead of grinding.
        """
        m = measured.get(ax.joint)
        if m is None:
            return False
        if ax.blocked:
            # release: the request reversed, or it stopped asking, or the axis moved on its own
            if req == 0.0 or (req * ax.stall_ref_dir < 0) or abs(m - ax.stall_ref) > STALL_DEG:
                ax.blocked = False
                ax.stall_at = None
                return False
            flags["stalled"] = True
            return True
        if abs(ax.rate) < STALL_MIN_RATE:
            ax.stall_at = None
            ax.stall_ref = m
            return False
        if ax.goal is not None and abs(ax.goal - m) <= STALL_DEG:
            # The goal is where the arm already is, so the servo has no position error to fight
            # with and cannot be straining - this is what "parked on a software bound" looks like.
            # (The test is against the *measured* pose, not against the bound: a goal on a bound the
            # arm is nowhere near is a command to travel through the stop.)
            ax.stall_at = None
            ax.stall_ref = m
            return False
        if ax.stall_at is None:
            ax.stall_at = now
            ax.stall_ref = m
            return False
        dt = now - ax.stall_at
        if dt * 1e3 < STALL_MS:
            return False
        moved = abs(m - ax.stall_ref)
        want = abs(ax.rate)
        ax.stall_at = now
        ax.stall_ref = m
        if moved > STALL_DEG:
            # It moved, but a position servo's speed comes from its position error and the goal is
            # held ``rel_step`` ahead of the measured pose - so the relative clamp *is* the speed
            # limit under load. Measured with the camera on the wrist: 4 deg of lead lifts the
            # forearm at 6 deg/s while the pad asks for 180, which is what "the tracking is slow and
            # always behind" looks like from the operator's seat. An axis that cannot reach the
            # commanded rate gets the larger lead (lerobot's own per-send bound); one that keeps up
            # drops back.
            got = moved / dt
            if want >= STALL_MIN_RATE and got < LOAD_RATE_FRAC * want:
                ax.rel_step = REL_STEP_LOADED_DEG
            elif ax.rel_step > REL_STEP_DEG:
                ax.rel_step = REL_STEP_DEG
            return False
        if ax.rel_step < REL_STEP_LOADED_DEG:
            # Not a millimetre of travel: give it the full lead before calling it an obstruction.
            ax.rel_step = REL_STEP_LOADED_DEG
            return False
        ax.blocked = True
        ax.stall_ref_dir = 1.0 if ax.rate > 0 else -1.0
        ax.rate = 0.0
        flags["stalled"] = True
        self.log.warning(
            "gimbal: %s stalled: %.0f ms with the goal %.2f deg ahead and no travel",
            ax.joint,
            dt * 1e3,
            abs((ax.goal or m) - m),
        )
        return True

    def _against_bound(self, ax: Axis, req: float, measured: Mapping[str, float]) -> bool:
        """True while the clamped goal sits on the software bound the request is pushing past.

        ``ax.goal`` is the *clamped* goal, so a goal resting exactly on ``lo``/``hi`` means a bound
        ended the travel, not the servo's load or an obstacle. The bounds here are the *effective*
        ones for this tick, which include the track leash - otherwise the leash reads as an
        obstruction: the axis sits on a bound the stall gate does not know about, its load lead
        yields nothing, and 400 ms later the gate latches ``blocked`` and lights ``stalled``, the
        flag that means "something is in the way" (measured live: ``stalled ['shoulder_pan']`` on
        the leash edge, with the person still in frame).
        """
        if ax.goal is None or req == 0.0:
            return False
        lo, hi = self._bounds(ax.joint, ax, measured)
        return (req > 0.0 and ax.goal >= hi - 1e-6) or (req < 0.0 and ax.goal <= lo + 1e-6)

    def _run_park(self, dt: float, measured: Mapping[str, float], flags: dict[str, bool],
                  now: float) -> None:
        done = True
        for joint in ARM_JOINTS:
            tgt = float(self.park.get(joint, measured.get(joint, 0.0)))
            cur = self.goals.get(joint, measured.get(joint, 0.0))
            step = clamp(tgt - cur, -self.park_v * dt, self.park_v * dt)
            nxt = cur + step
            self.goals[joint] = self._clamp_goal(
                joint, nxt, measured, flags, rel=REL_STEP_LOADED_DEG
            )
            m = measured.get(joint, nxt)
            if abs(m - tgt) <= PARK_TOL:
                self._park_still.pop(joint, None)
                continue                           # arrived
            # The joint is not at its target, and asking is not going to change that: the wrist
            # carries the camera and parks ~1.8 deg short of the ready pose, the pan ~2.2, and a
            # held joint that cannot move at all (shoulder_lift under this load) never gets there.
            # Judging completion on the *goal* reaching the target cannot work for those - the
            # relative clamp pins the goal to a lead in front of a stationary joint forever - and
            # judging it on the measured being within PARK_TOL cannot work either, because the
            # loaded steady-state error is larger than any tolerance worth setting. So park is done
            # when the arm stops making progress, the same test the stall guard uses: standing
            # still in the right place counts.
            ref, since = self._park_still.get(joint, (m, now))
            if abs(m - ref) > STALL_DEG:
                ref, since = m, now
            self._park_still[joint] = (ref, since)
            if now - since < PARK_SETTLE_S:
                done = False
        self.park_done = done
        flags["park_done"] = done
        self.pan.rate = self.tilt.rate = 0.0

    def _run_jog(self, dt: float, measured: Mapping[str, float], flags: dict[str, bool],
                 now: float) -> None:
        if (now - self._jog_at) * 1e3 > self.input_stale_ms:
            self._jog.clear()
            return
        for joint, rate in list(self._jog.items()):
            cur = self.goals.get(joint, measured.get(joint, 0.0))
            self.goals[joint] = self._clamp_goal(joint, cur + rate * dt, measured, flags)

    def _clamp_goal(
        self,
        joint: str,
        value: float,
        measured: Mapping[str, float],
        flags: dict[str, bool],
        ax: Axis | None = None,
        rel: float | None = None,
    ) -> float:
        lo, hi = self._bounds(joint, ax, measured)
        # Only the two driven axes report at_limit: a held joint that gets carried to its own
        # software bound would otherwise light the flag the operator reads as "the camera cannot
        # move", which is how a wrist with 20 deg of free travel above it looked "at its limit"
        # while the elbow was the joint actually clamped.
        key = "at_limit" if ax is not None else "held_clamped"
        if value < lo:
            value, flags[key] = lo, True
        elif value > hi:
            value, flags[key] = hi, True
        if joint in measured:
            # the lead is a torque budget, not just an anti-windup guard: a position servo's force
            # comes from the gap between goal and pose, so too small a lead is too little force
            # (measured: park from a folded pose could not lift the camera on a 4 deg lead while the
            # same move on 8 deg does it). Callers with a deliberate move may set it.
            lead = rel if rel is not None else (ax.rel_step if ax is not None else REL_STEP_DEG)
            m = measured[joint]
            if value > m + lead:
                value, flags["rel_clamped"] = m + lead, True
            elif value < m - lead:
                value, flags["rel_clamped"] = m - lead, True
        if ax is not None:
            ax.goal = value
        return value

    def _bounds(
        self, joint: str, ax: Axis | None, measured: Mapping[str, float] | None = None
    ) -> tuple[float, float]:
        """The travel bounds for a joint, widened for this tick to contain where the arm actually is.

        A window that excludes the current pose is a trap: the goal is clamped into the window, then
        back to one rel-step from the measured pose, so an arm outside its window gets pinned to
        where it is with ``at_limit`` lit forever (measured: tilt at -89.5 with a window of [-72.9,
        72.9] never moved again). The arm can legitimately end up outside its window - moved by
        hand, settled under gravity, left there by a previous session - so the *returned* range
        includes it, which lets the goal sit on the measured pose (hold) instead of fighting the
        operator.

        That widening is deliberately not written back to the axis or to ``window``: persisting it
        made the envelope ratchet outward, because every sag past a bound (gravity at the end of
        travel) grew the bound, which allowed a little more travel, which sagged further - measured:
        the tilt walked to -2.1 past its -2.07 limit and the pan to -69.8 past -67.2, so the
        configured envelope stopped meaning anything.
        """
        if ax is not None and ax.joint == joint:
            lo, hi = ax.lo, ax.hi
            if self.mode == "track" and ax.anchor is not None:
                # A tracker on a leash: however the aim point moves (a detection in the far corner,
                # a person walking out of frame, a mis-picked body), the camera may not travel more
                # than this far from the pose it was engaged from. Without it the rig chases its own
                # error (measured: 68 deg of pan swing in 30 s and 7 track ids) and the operator
                # reads it as "the camera is off doing its own thing".
                lo, hi = max(lo, ax.anchor - TRACK_LEASH_DEG), min(hi, ax.anchor + TRACK_LEASH_DEG)
        else:
            win = self.window.get(joint)
            lo, hi = (float(win["min"]), float(win["max"])) if win else (-180.0, 180.0)
        if measured and joint in measured:
            m = float(measured[joint])
            lo, hi = min(lo, m), max(hi, m)
        return lo, hi

    def _sync_goals(self, goals: dict | None = None) -> None:
        if goals:
            self.goals = goals
        for ax in (self.pan, self.tilt):
            if ax.joint in self.goals:
                ax.goal = self.goals[ax.joint]

    # --------------------------------------------------------------- report
    def snapshot(self) -> dict:
        return {
            "mode": self.mode,
            "estopped": self.estopped,
            "divergence": self.divergence,
            "park_done": self.park_done,
            "stalled": [ax.joint for ax in (self.pan, self.tilt) if ax.blocked],
            "input": list(self.input),
            "aim": [self.aim[0], self.aim[1]],
            "flags": dict(self.flags),
            "pan": {
                "joint": self.pan.joint,
                "sign": self.pan.sign,
                "kp": self.pan.kp,
                "v_max": self.pan.v_max,
                "a_max": self.pan.a_max,
                "rate": round(self.pan.rate, 2),
                "goal": None if self.pan.goal is None else round(self.pan.goal, 2),
                "lo": self.pan.lo,
                "hi": self.pan.hi,
                "anchor": self.pan.anchor,
            },
            "tilt": {
                "joint": self.tilt.joint,
                "sign": self.tilt.sign,
                "kp": self.tilt.kp,
                "v_max": self.tilt.v_max,
                "a_max": self.tilt.a_max,
                "rate": round(self.tilt.rate, 2),
                "goal": None if self.tilt.goal is None else round(self.tilt.goal, 2),
                "lo": self.tilt.lo,
                "hi": self.tilt.hi,
                "anchor": self.tilt.anchor,
            },
            "goals": {k: round(v, 2) for k, v in self.goals.items()},
            "rates": {j: round(v, 2) for j, v in self.rates.items()},
            "jog": dict(self._jog),
        }
