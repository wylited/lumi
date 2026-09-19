"""The arm, behind one interface: pan and tilt, in degrees.

Both transports - the operator console's HTTP command surface and a bridge process this rig
starts itself - speak armd's command dialect (``state``, ``arm``, ``mode``, ``jog``), so the
control loop lives here once and each driver file carries only its transport. Everything above
this module talks degrees: the five servo angles, the serial bus and the vendor's own API never
leave the arm package.

The loop is not a stepping motor's idea of a move. armd moves a joint only while a *fresh* jog
rate is arriving (it drops one after 250 ms) and the servo settles where armd's goal is, so the
goal - not the arm - is what has to be aimed, and the arm follows.
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

_LOG = logging.getLogger(__name__)

# The aiming loop, in degrees and seconds.
#
# `AIM_V_MAX_DEG_S` is the ceiling on a commanded joint rate, not a target: the rig's pan can do
# ~52 deg/s and its wrist ~20 (motion.json, measured), and a camera on the wrist at 40 deg/s is
# already a snap, so the loop never needs more than this to be fast.
AIM_KP = 2.0                  # deg/s commanded per deg of error; kp*dt = 0.1 keeps the loop
AIM_V_MAX_DEG_S = 40.0        # inside the response it is chasing instead of overshooting it
AIM_HZ = 20.0
AIM_TICK_S = 1.0 / AIM_HZ     # also the jog refresh: armd drops a jog input after 250 ms
# A joint only moves while its goal is far enough ahead of it to make the torque that beats its own
# friction, so a loop that stops its goal *on* the target leaves the arm short of it: measured on
# this rig, driving the goal to a value and holding it leaves the pan 1.5-3.2 deg short of that
# value and the wrist 1.3-1.9, and armd's own park never closes its last 2.5. The goal therefore
# has to be aimed past the target, by as much as the loop sees left standing - which is what this
# integral does, one degree of overshoot per second per degree of error, capped at the one rel-step
# (tracking REL_STEP_DEG = 4.0) that armd itself will let a goal lead the measured pose.
AIM_KI_DEG_PER_S = 1.0        # only above AIM_BIAS_BAND_DEG the approach is aimed past the target
AIM_BIAS_MAX_DEG = 4.0        # one rel-step: as far past the target as the aim point may travel,
#                               and as far as a goal may stand from the arm at a settled exit
AIM_BIAS_BAND_DEG = 2.5       # ...and only once the arm is this close, so the approach does not
#                               sail past a target it could have stopped on
AIM_STILL_DEG = 0.1           # a settled arm is one that has held this still for AIM_STILL_S; the
AIM_STILL_S = 0.25            # exit is a rest, not a tolerance seen mid-flight
AIM_STALL_S = 1.5             # and a joint that has not moved for this long with the target still
#                               out of reach is reported as stopped, not waited out: the bench had
#                               a wrist creep 0.44 deg in 5.5 s with the goal 4 deg ahead of it and
#                               nothing in its flags - a joint against a wall, or in a latch
AIM_FLOOR_DEG_S = 12.0        # the slowest a joint travels under a full-rate command, for laying
#                               out a slew: this rig's wrist is commanded at the 40 deg/s ceiling and
#                               travels at ~15 (measured: 57.75 deg of tilt in ~4 s), so the budget
#                               is drawn at 12 - honest about the floor, not generous about it
# However far the target is, the whole move has to be acked inside the server's ack window:
# `ACK_TIMEOUT_MS = 10_000` in `apps/server/src/services/desk.ts`, whose retry on expiry re-sends
# the same action id - and this rig handles actions one at a time, so a slow move would be performed
# a second time after the server had already recorded it done. Eight seconds leaves the post, the
# parse and the ack room to land, and a move that cannot make it answers `failed` with the pose it
# did reach instead of going quiet past the window.
AIM_BUDGET_MAX_S = 8.0        # < the server's 10 s ack window, and the caller waits no longer
PARK_POLL_HZ = 10.0
PARK_SLEW_DEG_S = 10.0        # armd slews to park at 20 deg/s; budget half, so a loaded joint
NOD_AMPLITUDE_DEG = 3.0       # cannot be waited out of its own park
NOD_SETTLE_S = 0.15
CONSOLE_PROBE_TIMEOUT_S = 1.0
REQUEST_TIMEOUT_S = 2.0       # a console command normally answers in ~15 ms; this bounds a wedge

# The arm's name for the DeskArm caps. armd reports its backend ('lerobot'), the port and the
# servo firmware, but no model name of its own, and the caps want something a person recognises:
# this rig is an SO-101 follower (tracking/README) on the far end of that backend.
ARM_MODEL = 'so-101'


@dataclass(frozen=True)
class ArmPose:
    """Where the camera is pointing, in the degrees armd reports: pan, tilt."""

    pan: float
    tilt: float


class ArmError(RuntimeError):
    """The arm refused, or answered with something unusable. Nothing was pretended."""


class ArmUnavailable(ArmError):
    """There is no arm to talk to: no driver, no bus, the console down, armd not answering."""


class ArmTimeout(ArmError):
    """The move did not settle inside its timeout; the message carries where it did get to."""


class ArmUnreachable(ArmError):
    """The request is outside the joint's own travel: there is no pose there to hold."""


@runtime_checkable
class ArmDriver(Protocol):
    """What the rest of the rig is allowed to assume about an arm."""

    def connect(self) -> None: ...
    def is_connected(self) -> bool: ...
    def pose(self) -> ArmPose: ...
    def aim(self, pan: float, tilt: float) -> ArmPose: ...
    def point(self, x: float, y: float) -> ArmPose: ...
    def nod(self, times: int = 1) -> None: ...
    def home(self) -> ArmPose: ...
    def describe(self) -> dict | None: ...
    def close(self) -> None: ...


def _clamp(value: float, low: float, high: float) -> float:
    return low if value < low else high if value > high else value


def console_answers(console_url: str, timeout_s: float = CONSOLE_PROBE_TIMEOUT_S) -> bool:
    """True while the operator console is running.

    The console owns the arm whenever it is up - it supervises armd, which holds the serial bus -
    so this is the check that keeps the rig from starting a second writer behind it.
    """
    url = f'{console_url.rstrip("/")}/api/streams'
    try:
        with urllib.request.urlopen(url, timeout=timeout_s) as response:
            return 200 <= int(getattr(response, 'status', 200)) < 300
    except urllib.error.HTTPError:
        return True     # it answered, so the console is running, whatever it made of the request
    except (urllib.error.URLError, OSError, ValueError):
        return False


def armd_answers(console_url: str, timeout_s: float = CONSOLE_PROBE_TIMEOUT_S) -> tuple[bool, str]:
    """Whether the console's armd answers, and when it does not, armd's own words.

    A console process can be up with no arm daemon behind it: it serves the page, the camera and
    the arm's command socket, and every command comes straight back `ok: false` carrying armd's
    reason. Asking only whether the *console* is up would advertise an arm that cannot move, so
    this is the question to ask before handing out a driver.
    """
    url = f'{console_url.rstrip("/")}/api/cmd'
    body = json.dumps({'method': 'state', 'params': {}}).encode('utf-8')
    request = urllib.request.Request(
        url, data=body, headers={'content-type': 'application/json'}, method='POST'
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            reply = json.loads(response.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as exc:
        return False, f'the console answered {exc.code}'
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return False, f'the console did not answer ({exc})'
    if isinstance(reply, dict) and reply.get('ok') is True:
        return True, ''
    reason = str(reply.get('error') or '') if isinstance(reply, dict) else ''
    return False, reason or 'the console did not say why'


class BridgeArm:
    """armd's command dialect over a transport that carries it.

    Subclasses implement :meth:`_send` (one command out, one reply object back, typed
    ``ArmUnavailable`` when the transport cannot answer) and get the whole driver: the read-back
    pose, the aiming loop, park, nod and the caps. ``_cmd`` is the only place a refusal becomes an
    error, and the reason is always the bridge's own words.
    """

    def __init__(
        self,
        pan_joint: str,
        tilt_joint: str,
        *,
        tol_deg: float,
        timeout_s: float,
        calibration: Any = None,
        log: logging.Logger | None = None,
        kp: float = AIM_KP,
        v_max_deg_s: float = AIM_V_MAX_DEG_S,
    ) -> None:
        self.pan_joint = pan_joint
        self.tilt_joint = tilt_joint
        self.tol_deg = float(tol_deg)
        self.timeout_s = float(timeout_s)
        self.kp = float(kp)
        self.v_max_deg_s = float(v_max_deg_s)
        self.log = log or _LOG
        # The calibration is a Calibration; typed loosely because it imports this module.
        self._calibration = calibration
        # One operation at a time: two threads aiming one arm is how a nod and an aim end up
        # fighting for the same joint. RLock because nod is expressed in terms of aim.
        self._lock = threading.RLock()
        self._connected = False
        self._closed = False

    # ------------------------------------------------------------ transport
    def _send(self, method: str, params: dict | None = None, timeout_s: float | None = None) -> dict:
        """One command to the bridge; the reply object, or ArmUnavailable with the reason."""
        raise NotImplementedError

    def _cmd(self, method: str, params: dict | None = None, timeout_s: float | None = None) -> dict:
        """Send one command and answer with the reply, having turned a refusal into an ArmError."""
        with self._lock:
            reply = self._send(method, params, timeout_s)
        if not isinstance(reply, dict):
            raise ArmError(f'{method}: the bridge reply was not an object')
        if not reply.get('ok'):
            raise ArmError(f'{method}: {reply.get("error") or "the bridge refused it"}')
        return reply

    def _state_of(self, reply: dict) -> dict:
        state = (reply.get('result') or {}).get('state')
        if not isinstance(state, dict):
            raise ArmError('the bridge reply carried no state')
        return state

    def _state(self) -> dict:
        return self._state_of(self._cmd('state'))

    # ------------------------------------------------------------ lifecycle
    def connect(self) -> None:
        """Probe the arm, and make sure it will take a motion mode.

        Arming moves nothing - it only unlocks `manual`/`pose`/`park`, which armd refuses while the
        arm is disarmed - so a driver that finds the arm disarmed arms it and says so.
        """
        with self._lock:
            state = self._state()
            self._connected = True
            if not state.get('armed'):
                self._cmd('arm')
                self.log.info(
                    'arm was disarmed; armed it (arming holds the pose, it only unlocks motion modes)'
                )

    def is_connected(self) -> bool:
        return self._connected and not self._closed

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._connected = False

    def _ensure(self) -> None:
        if self._closed:
            raise ArmUnavailable('the arm driver is closed')
        if not self._connected:
            self.connect()

    # ---------------------------------------------------------------- reads
    def _joints(self, state: dict) -> dict:
        measured = state.get('measured')
        return measured if isinstance(measured, dict) else {}

    def _pose_from(self, state: dict) -> ArmPose:
        measured = self._joints(state)
        try:
            return ArmPose(float(measured[self.pan_joint]), float(measured[self.tilt_joint]))
        except (KeyError, TypeError, ValueError) as exc:
            raise ArmError(
                f'the bridge state has no {self.pan_joint}/{self.tilt_joint} reading: {exc}'
            ) from exc

    def _goal_from(self, state: dict, fallback: ArmPose) -> ArmPose:
        goals = state.get('goals')
        if not isinstance(goals, dict):
            return fallback
        try:
            return ArmPose(float(goals[self.pan_joint]), float(goals[self.tilt_joint]))
        except (KeyError, TypeError, ValueError):
            return fallback

    def pose(self) -> ArmPose:
        with self._lock:
            self._ensure()
            return self._pose_from(self._state())

    # ---------------------------------------------------------------- moves
    def aim(self, pan: float, tilt: float) -> ArmPose:
        """Drive both axes to an absolute pose and answer where the arm actually got to.

        armd is told the *rate* each joint should run at and the servo follows the goal armd
        integrates from it, so this is a P-controller on the measured error whose output is a rate,
        re-sent every tick to keep the jog fresh. The goal it drives is the target plus the bias
        below, and the run ends with a read-back of the pose the arm is holding - the caller acks a
        pose, not a target.
        """
        target = ArmPose(float(pan), float(tilt))
        with self._lock:
            self._ensure()
            state = self._state()
            self._reachable(state, target)
            if state.get('mode') != 'pose':
                state = self._state_of(self._cmd('mode', {'mode': 'pose'}))
            rest = self._pose_from(state)
            travel = max(abs(target.pan - rest.pan), abs(target.tilt - rest.tilt))
            # `timeout_s` is the *approach* budget; the slew to get there is not approach time.
            # This rig's wrist is commanded at the 40 deg/s ceiling and travels at ~15 (measured:
            # 57.75 deg of tilt in ~4 s), and the same 5 s that is a generous approach budget gave
            # up 34 deg short of a target the arm reached in 7.
            budget = min(self.timeout_s + travel / AIM_FLOOR_DEG_S, AIM_BUDGET_MAX_S)
            deadline = time.monotonic() + budget
            bias = (0.0, 0.0)
            rest_at = time.monotonic()
            while True:
                now = time.monotonic()
                self._mode_held(state, 'pose', 'aim')
                measured = self._pose_from(state)
                # Stillness is measured against the pose the rest started from, not against the
                # previous tick: the loop ends its own approach in a slow creep, and a joint that
                # has moved 0.05 deg in the last tick is not one that has arrived.
                moved = max(abs(measured.pan - rest.pan), abs(measured.tilt - rest.tilt))
                if moved > AIM_STILL_DEG:
                    rest, rest_at = measured, now
                goals = self._goal_from(state, measured)
                errors = (target.pan - measured.pan, target.tilt - measured.tilt)
                # The aim point may lead the target, never the joint's own travel: a goal past the
                # window is clamped by armd anyway, and asking for it keeps the loop pushing
                # against a bound it cannot pass.
                aimed = ArmPose(
                    self._in_window(state, self.pan_joint, target.pan + bias[0]),
                    self._in_window(state, self.tilt_joint, target.tilt + bias[1]),
                )
                if self._settled(errors, measured, goals, now - rest_at):
                    # Hold with a fresh *zero* rate: leaving the last jog standing lets armd keep
                    # advancing the goal for up to 250 ms, which drifts an arm that had arrived.
                    self._jog(0.0, 0.0)
                    break
                worst = max(abs(error) for error in errors)
                if now - rest_at >= AIM_STALL_S and worst > self.tol_deg:
                    # It is not creeping toward the target, it is standing still with the target
                    # still out of reach. Waiting out the budget here buys nothing: say where it
                    # stopped and what armd says about the joint that stopped.
                    stalled = ','.join(sorted(self._stalled(state)))
                    raise ArmTimeout(
                        f'aim(pan={target.pan:g}, tilt={target.tilt:g}) stopped making progress: '
                        f'{now - rest_at:.1f} s at pan={measured.pan:g} tilt={measured.tilt:g}, '
                        f'{worst:g} deg out, goals pan={goals.pan:g} tilt={goals.tilt:g}'
                        + (f', armd reports stalled: {stalled}' if stalled else '')
                    )
                if now >= deadline:
                    raise ArmTimeout(
                        f'aim(pan={target.pan:g}, tilt={target.tilt:g}) did not settle within '
                        f'{budget:.1f} s; achieved pan={measured.pan:g} '
                        f'tilt={measured.tilt:g}, {worst:g} deg out'
                    )
                started = time.monotonic()
                rates = self._rates(errors, aimed, goals)
                self.log.debug(
                    'aim err=(%.2f, %.2f) bias=(%.2f, %.2f) rate=(%.2f, %.2f)',
                    errors[0], errors[1], bias[0], bias[1], rates[0], rates[1],
                )
                self._jog(*rates)
                time.sleep(max(0.0, AIM_TICK_S - (time.monotonic() - started)))
                state = self._state()
                bias = self._bias_from(bias, errors)
            # Read the pose back rather than reporting the target: the caller acks the pose the arm
            # reached, and those are not the same number.
            return self._pose_from(self._state())

    @staticmethod
    def _stalled(state: dict) -> set[str]:
        """The joints armd itself is holding because commanded motion stopped producing travel."""
        gimbal = state.get('gimbal') if isinstance(state.get('gimbal'), dict) else {}
        stalled = gimbal.get('stalled')
        return {str(joint) for joint in stalled} if isinstance(stalled, (list, tuple, set)) else set()

    def _mode_held(self, state: dict, wanted: str, doing: str) -> None:
        """Fail clearly when something else takes the arm mid-action.

        The operator console is a client of the same armd, and its park button - or a page key
        repeat; the bench showed a burst of eleven `mode park` commands at 3.5 Hz during a nod -
        lands between two ticks of this loop. After that the jogs move nothing and the caller would
        only find out by waiting out the whole budget. The operator wins: this does not fight for
        the mode back, it says who took it.
        """
        mode = str(state.get('mode') or '')
        if mode == wanted:
            return
        self.log.warning(
            'the arm left %s mode mid-%s (now %s): something else is driving it', wanted, doing, mode
        )
        raise ArmUnavailable(f'the arm was taken over mid-{doing} (mode {mode})')

    def _reachable(self, state: dict, target: ArmPose) -> None:
        """Refuse a target outside a joint's travel, naming the nearest pose it can hold.

        armd clamps a goal to the window rather than refusing it, so an out-of-travel target is not
        an error *there*: the joint stops at the bound and the caller waits out the whole budget for
        a pose that was never on offer. Naming the bound is the useful answer, and it costs no
        motion to give.
        """
        window = state.get('window') if isinstance(state.get('window'), dict) else {}
        for joint, want in ((self.pan_joint, target.pan), (self.tilt_joint, target.tilt)):
            travel = window.get(joint) if isinstance(window.get(joint), dict) else {}
            low, high = travel.get('min'), travel.get('max')
            if low is None or high is None:
                continue
            low, high = float(low), float(high)
            if want < low or want > high:
                raise ArmUnreachable(
                    f'{joint}={want:g} is outside its travel ({low:g}, {high:g}); the nearest it '
                    f'can hold is {_clamp(want, low, high):g}'
                )

    def _settled(self, errors: tuple[float, float], measured: ArmPose, goals: ArmPose, rest_s: float) -> bool:
        """Settled means the arm is *holding* the target: inside the tolerance, at rest, and with
        its goal no further from it than the rig lets any goal lead the arm it drives.

        The lead is the point of the last test. A joint comes to rest *short* of its goal, so the
        goal standing a degree or two ahead of the arm is the normal resting state - it is what
        puts the arm on the target in the first place. But a goal left out beyond one rel-step
        (the 4 deg armd itself clamps a goal to) is a standing pull, and this call must not report
        a pose the arm is still being dragged out of.
        """
        if any(abs(error) > self.tol_deg for error in errors):
            return False
        if rest_s < AIM_STILL_S:
            return False
        return max(abs(goals.pan - measured.pan), abs(goals.tilt - measured.tilt)) <= AIM_BIAS_MAX_DEG

    def _rates(self, errors: tuple[float, float], aimed: ArmPose, goals: ArmPose) -> tuple[float, float]:
        """The jog rate per axis for this tick: the P term decides the speed, and the room left to
        the aim point caps it so the goal stops there instead of being carried past it."""
        rates = []
        for error, want, goal in (
            (errors[0], aimed.pan, goals.pan),
            (errors[1], aimed.tilt, goals.tilt),
        ):
            rate = _clamp(self.kp * error, -self.v_max_deg_s, self.v_max_deg_s)
            room = want - goal
            rates.append(0.0 if room == 0.0 else math.copysign(min(abs(rate), abs(room) / AIM_TICK_S), room))
        return rates[0], rates[1]

    def _bias_from(self, bias: tuple[float, float], errors: tuple[float, float]) -> tuple[float, float]:
        """How far past the target to aim the goal, from the error the arm leaves standing.

        See AIM_KI_DEG_PER_S: the joint rests where its goal is minus its own friction, so the loop
        carries that shortfall into the aim point instead of fighting it. Gated on the arm being
        close, so a long approach is not aimed past where it is going, and it unwinds by itself if
        the arm ends up overshooting - the integral is of the sign of the error either way.
        """
        grown = []
        for value, error in zip(bias, errors):
            if abs(error) <= AIM_BIAS_BAND_DEG:
                value += AIM_KI_DEG_PER_S * error * AIM_TICK_S
            grown.append(_clamp(value, -AIM_BIAS_MAX_DEG, AIM_BIAS_MAX_DEG))
        return grown[0], grown[1]

    def _jog(self, pan_rate: float, tilt_rate: float) -> None:
        self._cmd('jog', {'joint': self.pan_joint, 'rate': pan_rate})
        self._cmd('jog', {'joint': self.tilt_joint, 'rate': tilt_rate})

    def home(self) -> ArmPose:
        """Slew to the stored park pose and answer where the arm stopped.

        The wait ends on armd's own `park_done`, or when the arm has stopped moving. It needs both:
        this rig's joints come to rest short of their goal (measured: the pan stands 2.5 deg short
        of park and stays there, so armd's own park never reports done), and a `home` that waited
        on the flag alone would time out on an arm that is already home. Where it stopped is what
        this returns either way - the caller acks a pose.
        """
        with self._lock:
            self._ensure()
            state = self._state_of(self._cmd('mode', {'mode': 'park'}))
            measured = self._joints(state)
            park = state.get('park') if isinstance(state.get('park'), dict) else {}
            travel = max(
                (abs(float(park[joint]) - float(measured[joint])) for joint in park if joint in measured),
                default=0.0,
            )
            # Capped like `aim`: armd's park slew is 20 deg/s against a 10 deg/s budget here, so a
            # full-window park would run to 17 s and be re-sent by a server that gave up at 10.
            budget = min(self.timeout_s + travel / PARK_SLEW_DEG_S, AIM_BUDGET_MAX_S)
            deadline = time.monotonic() + budget
            rest = self._pose_from(state)
            rest_at = time.monotonic()
            while True:
                self._mode_held(state, 'park', 'home')
                if bool((state.get('gimbal') or {}).get('park_done')):
                    return self._pose_from(state)
                if time.monotonic() - rest_at >= AIM_STILL_S:
                    return self._pose_from(state)
                if time.monotonic() >= deadline:
                    achieved = self._pose_from(state)
                    raise ArmTimeout(
                        f'home did not reach the park pose within {budget:.1f} s; achieved '
                        f'pan={achieved.pan:g} tilt={achieved.tilt:g}'
                    )
                time.sleep(1.0 / PARK_POLL_HZ)
                state = self._state()
                here = self._pose_from(state)
                if max(abs(here.pan - rest.pan), abs(here.tilt - rest.tilt)) > AIM_STILL_DEG:
                    rest, rest_at = here, time.monotonic()

    def nod(self, times: int = 1) -> None:
        """`times` small tilt excursions, ending where it started.

        This is a gesture, not a measurement: the excursions are kept inside the joint's own
        window, so a nod asked for at the edge of travel leans as far as it can instead of failing.
        """
        count = int(times)
        if count <= 0:
            return
        with self._lock:
            self._ensure()
            state = self._state()
            start = self._pose_from(state)
            up = self._in_window(state, self.tilt_joint, start.tilt + NOD_AMPLITUDE_DEG)
            down = self._in_window(state, self.tilt_joint, start.tilt - NOD_AMPLITUDE_DEG)
            for _ in range(count):
                self.aim(start.pan, up)
                time.sleep(NOD_SETTLE_S)
                self.aim(start.pan, down)
                time.sleep(NOD_SETTLE_S)
            self.aim(start.pan, start.tilt)

    @staticmethod
    def _in_window(state: dict, joint: str, value: float) -> float:
        window = ((state.get('window') or {}).get(joint) or {}) if isinstance(state.get('window'), dict) else {}
        low, high = window.get('min'), window.get('max')
        if low is None or high is None:
            return value
        return _clamp(value, float(low), float(high))

    def point(self, x: float, y: float) -> ArmPose:
        """Aim at a point on the desk plane, through the stored calibration.

        With no calibration there is no pose to aim at and none is invented: the caller gets an
        ArmUnavailable and the camera stays where it is.
        """
        if self._calibration is None:
            raise ArmUnavailable('no calibration')
        pan, tilt = self._calibration.point(float(x), float(y))
        self.log.debug('desk point (%.0f, %.0f) mm -> pan=%.2f tilt=%.2f', x, y, pan, tilt)
        return self.aim(pan, tilt)

    # ----------------------------------------------------------------- caps
    def describe(self) -> dict | None:
        """The DeskArm caps, or None when there is no arm to ask.

        Never raises: a rig with an unplugged arm still registers itself, and the server reads a
        missing `arm` as "aim actions are never sent here".
        """
        try:
            with self._lock:
                self._ensure()
                state = self._state()
        except ArmError as exc:
            self.log.debug('no arm caps: %s', exc)
            return None
        joints = self._joints(state)
        if not joints:
            return None
        info = state.get('info') if isinstance(state.get('info'), dict) else {}
        port = info.get('port')
        return {
            'model': ARM_MODEL,
            'dof': len(joints),
            # DeskArm wants the device it was opened on, for the log and the panel - and null when
            # the bridge did not say, which is a legal answer there and better than a made-up path.
            'port': str(port) if port else None,
        }


def reply_text(body: bytes) -> str | None:
    """The error string out of a console reply body, or None when there is nothing readable."""
    try:
        payload = json.loads(body.decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        return None
    error = payload.get('error') if isinstance(payload, dict) else None
    return str(error) if error else None
