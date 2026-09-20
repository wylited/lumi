"""HELI-042's arm adapter: the aiming loop, the errors it raises, and a rig with no arm.

The console is stood up as a real HTTP server with a real little arm behind it, because the thing
under test is exactly the conversation between them: a jog buys motion only until armd decides the
input has gone stale, and the goal it integrates is clamped to where the arm actually is. A fake
that moved the arm by itself would prove none of that.
"""

from __future__ import annotations

import json
import logging
import math
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from heli_rig.arm import ConsoleArm, SerialArm, open_arm
from heli_rig.arm.calibration import Calibration
from heli_rig.arm.driver import ArmError, ArmTimeout, ArmUnavailable, ArmUnreachable

PAN = 'shoulder_pan'
TILT = 'wrist_flex'
OTHER_JOINTS = ('shoulder_lift', 'elbow_flex', 'wrist_roll')
PORT = '/dev/tty.usbmodemTEST1'

JOG_STALE_MS = 250.0        # armd's INPUT_STALE_MS
REL_STEP_DEG = 4.0          # armd's REL_STEP_DEG
SERVO_DEG_S = 200.0         # fast on purpose: the servo is never what a test is measuring
PARK_V = 20.0
PARK_TOL = 1.5


def clamp(value: float, low: float, high: float) -> float:
    return low if value < low else high if value > high else value


class FakeArmd:
    """Two joints and the rules of armd a caller can feel: a jog goes stale, the goal is clamped to
    the arm, a motion mode needs arming, park ends when the arm is at the park pose, and a joint
    with a deadband comes to rest short of its goal instead of on it."""

    def __init__(
        self,
        measured: dict[str, float] | None = None,
        *,
        armed: bool = True,
        moves: bool = True,
        refuse: dict | None = None,
        deadband: float = 0.0,
        speed_deg_s: float = SERVO_DEG_S,
    ) -> None:
        self.measured = {joint: 0.0 for joint in (PAN, TILT, *OTHER_JOINTS)}
        self.measured.update(measured or {})
        self.goals = dict(self.measured)
        self.armed = armed
        self.moves = moves
        self.refuse = refuse or {}
        self.deadband = float(deadband)
        self.speed_deg_s = float(speed_deg_s)
        self.mode = 'idle'
        self.park = {joint: 0.0 for joint in (PAN, TILT, *OTHER_JOINTS)}
        self.park_done = False
        self.jogs: dict[str, tuple[float, float]] = {}
        self.trace: list[float] = []        # every tilt the arm has been seen at
        self._at = time.monotonic()

    # ------------------------------------------------------------- dialect
    def cmd(self, method: str, params: dict) -> dict:
        self._advance()
        if self.refuse.get('method') == method:
            return {'ok': False, 'result': {'state': self.state()}, 'error': self.refuse['error']}
        if method == 'arm':
            self.armed = True
        elif method == 'mode':
            mode = str(params.get('mode'))
            if mode in ('manual', 'track', 'pose', 'park') and not self.armed:
                return {
                    'ok': False,
                    'result': {'state': self.state()},
                    'error': 'RuntimeError: arm first (motion modes need armed)',
                }
            self.mode = mode
            self.park_done = False
        elif method == 'jog':
            if self.armed:
                self.jogs[str(params.get('joint'))] = (float(params.get('rate', 0.0)), time.monotonic())
        elif method != 'state':
            return {
                'ok': False,
                'result': {'state': self.state()},
                'error': f'RuntimeError: unknown method {method!r}',
            }
        return {'ok': True, 'result': {'state': self.state()}}

    def state(self) -> dict:
        return {
            'mode': self.mode,
            'armed': self.armed,
            'estopped': False,
            'flags': [] if self.armed else ['disarmed'],
            'hz': 100.0,
            'measured': {joint: round(value, 3) for joint, value in self.measured.items()},
            'goals': {joint: round(value, 3) for joint, value in self.goals.items()},
            'park': dict(self.park),
            'window': {PAN: {'min': -90.0, 'max': 90.0}, TILT: {'min': -60.0, 'max': 60.0}},
            'gimbal': {'mode': self.mode, 'park_done': self.park_done, 'stalled': []},
            'info': {'backend': 'lerobot', 'port': PORT},
        }

    # ---------------------------------------------------------- the arm
    def _drive(self, joint: str, rate: float, dt: float) -> None:
        goal = self.goals.get(joint, self.measured[joint]) + rate * dt
        self.goals[joint] = clamp(
            goal, self.measured[joint] - REL_STEP_DEG, self.measured[joint] + REL_STEP_DEG
        )

    def _advance(self) -> None:
        now = time.monotonic()
        dt = min(max(now - self._at, 0.0), 0.5)
        self._at = now
        if dt <= 0.0:
            return
        if self.mode == 'pose' and self.moves:
            for joint, (rate, at) in list(self.jogs.items()):
                fresh_until = at + JOG_STALE_MS / 1e3
                if now > fresh_until:
                    # A jog stands for JOG_STALE_MS after it arrives. Dropping it
                    # without integrating the part of this gap that was still fresh
                    # makes a driver that abandoned a standing rate look identical to
                    # one that stopped it - which is the bug these tests are for.
                    self._drive(joint, rate, max(0.0, fresh_until - max(self._at, at)))
                    del self.jogs[joint]
                    continue
                self._drive(joint, rate, dt)
        if self.mode == 'park' and self.moves:
            for joint, want in self.park.items():
                self._drive(joint, clamp(want - self.goals.get(joint, 0.0), -PARK_V, PARK_V), dt)
        if self.moves:
            for joint, goal in list(self.goals.items()):
                error = goal - self.measured[joint]
                if abs(error) <= self.deadband:
                    # A real joint comes to rest short of its goal: its friction balances the
                    # servo's own position error, and below the deadband there is no torque left
                    # to move with (measured on this rig: the pan stands 1.5-3.2 deg short of a
                    # goal it has not reached, the wrist 1.3-1.9).
                    continue
                step = clamp(
                    error - math.copysign(self.deadband, error),
                    -self.speed_deg_s * dt,
                    self.speed_deg_s * dt,
                )
                self.measured[joint] += step
                self.goals[joint] = clamp(
                    goal,
                    self.measured[joint] - REL_STEP_DEG,
                    self.measured[joint] + REL_STEP_DEG,
                )
        self.park_done = self.mode == 'park' and all(
            abs(self.measured[joint] - want) <= PARK_TOL for joint, want in self.park.items()
        )
        self.trace.append(self.measured[TILT])


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's own spelling
        if self.path != '/api/cmd':
            self.send_error(404)
            return
        length = int(self.headers.get('content-length') or 0)
        body = json.loads(self.rfile.read(length) or b'{}')
        server = self.server
        if server.status != 200:
            payload = {'id': None, 'ok': False, 'result': {'state': None}, 'error': server.error}
        else:
            with server.lock:
                payload = {'id': 1, **server.bridge.cmd(body.get('method'), body.get('params') or {})}
        self._json(server.status, payload)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != '/api/streams':
            self.send_error(404)
            return
        self._json(200, {'video': '/stream.mjpg', 'frame': {'age_ms': 12}})

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        """Quiet: the tests are about the driver's log, not the server's."""


@contextmanager
def console(bridge: FakeArmd | None = None, *, status: int = 200, error: str | None = None):
    """A live console at a port of its own, with `bridge` behind it."""
    server = ThreadingHTTPServer(('127.0.0.1', 0), _Handler)
    server.daemon_threads = True
    server.bridge = bridge or FakeArmd()
    server.status = status
    server.error = error
    server.lock = threading.Lock()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_address[1]}', server.bridge
    finally:
        server.shutdown()
        server.server_close()


def _cfg(**overrides) -> SimpleNamespace:
    """The Config fields `open_arm` reads. Real ones arrive from `heli_rig.config`; nothing here
    touches the file system or a live console unless a test asks for it."""
    values = {
        'arm_driver': 'auto',
        'console_url': 'http://127.0.0.1:9',     # the discard port: nothing answers there
        'heli_dir': '/tmp/heli-rig-does-not-exist',
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _with_poses(path, poses) -> Calibration:
    calibration = Calibration(path)
    for pose in poses:
        calibration.add_pose(*pose)
    return calibration


# A bridge of the rig's own, for the driver that starts one: armd's dialect on stdin/stdout, with
# a joint that follows the jog rate it is handed and one command it can be told to refuse.
BRIDGE_SOURCE = '''
import json
import sys

MEASURED = $MEASURED
PORT = $PORT
REFUSE = $REFUSE


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()


mode = "idle"
measured = dict(MEASURED)
goals = dict(measured)
emit({"ev": "log", "msg": "bridge up"})      # armd logs before it answers anything


def snapshot():
    return {
        "mode": mode,
        "armed": True,
        "flags": [],
        "hz": 100.0,
        "measured": measured,
        "goals": goals,
        "park": {},
        "window": {},
        "gimbal": {"park_done": False},
        "info": {"port": PORT},
    }


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    message = json.loads(line)
    method = message.get("method")
    params = message.get("params") or {}
    if REFUSE and method == REFUSE[0]:
        emit({"id": message.get("id"), "ok": False, "error": REFUSE[1], "result": {"state": snapshot()}})
        continue
    if method == "mode":
        mode = params.get("mode")
    elif method == "jog":
        joint = params["joint"]
        rate = float(params.get("rate", 0.0))
        if mode == "pose":
            goals[joint] = goals[joint] + rate * 0.05   # one tick of that rate
            measured[joint] = goals[joint]
    emit({"ev": "state", "state": {"measured": measured}})   # unsolicited, as armd's 10 Hz state
    emit({"id": message.get("id"), "ok": True, "result": {"state": snapshot()}})
'''


def scripted_bridge(tmp_path, measured: dict[str, float] | None = None, refuse=None) -> str:
    where = tmp_path / 'bridge.py'
    where.write_text(
        BRIDGE_SOURCE.replace('$MEASURED', repr(measured or {PAN: 0.0, TILT: 0.0}))
        .replace('$PORT', repr(PORT))
        .replace('$REFUSE', repr(tuple(refuse) if refuse else None)),
        encoding='utf-8',
    )
    return str(where)


# --------------------------------------------------------------------- aim

def test_aim_moves_the_arm_and_reports_what_it_reached():
    with console(FakeArmd({PAN: 10.0, TILT: -20.0})) as (url, bridge):
        arm = ConsoleArm(url, timeout_s=3.0)
        achieved = arm.aim(16.0, -24.0)
        assert bridge.mode == 'pose'
        assert abs(achieved.pan - 16.0) <= 1.5
        assert abs(achieved.tilt + 24.0) <= 1.5
        assert arm.pose() == achieved


def test_aim_holds_the_pose_it_reached():
    """The last jog must not be left standing: armd keeps applying it for another 250 ms, which
    walks an arm that had already arrived past the target."""
    with console(FakeArmd({PAN: 10.0, TILT: -20.0})) as (url, bridge):
        arm = ConsoleArm(url, timeout_s=3.0)
        achieved = arm.aim(16.0, -24.0)
        # The last jog on each joint is a stop, so the fake applies nothing after the
        # aim returns: a rate left standing here would walk the arm on for 250 ms.
        assert bridge.jogs[PAN][0] == 0.0 and bridge.jogs[TILT][0] == 0.0
        time.sleep(0.4)
        held = arm.pose()
        assert abs(held.pan - achieved.pan) <= 1.5
        assert abs(held.tilt - achieved.tilt) <= 1.5


def test_aim_lands_on_a_joint_that_rests_short_of_its_goal():
    """The rig's joints come to rest 1.5-3.2 deg short of a goal they have not reached - armd's own
    park never closes its last 2.5, measured - so a loop that stops its goal *on* the target leaves
    the camera that far short of it and never reports a pose inside the tolerance."""
    goal_pan, goal_tilt = -20.0, 30.0
    with console(FakeArmd({PAN: 5.0, TILT: 5.0}, deadband=2.5)) as (url, bridge):
        arm = ConsoleArm(url, timeout_s=4.0)
        achieved = arm.aim(goal_pan, goal_tilt)
        assert abs(achieved.pan - goal_pan) <= 1.5
        assert abs(achieved.tilt - goal_tilt) <= 1.5
        assert abs(bridge.measured[PAN] - achieved.pan) <= 0.001    # and that is where it is held


def test_aim_gives_a_slow_slew_the_time_it_actually_needs():
    """`timeout_s` is the *approach* budget, not the slew budget. This rig's wrist is commanded at
    the 40 deg/s ceiling and travels at ~15 (measured: 57.75 deg of tilt in ~4 s), and the same 5 s
    that is a generous approach budget gave up 34 deg short of a target the arm reached in 7. The
    arm here travels at 8 deg/s - slower than the rig, so there is room to be wrong in - and a
    60 deg move still has to settle."""
    with console(FakeArmd({PAN: 0.0, TILT: 0.0}, speed_deg_s=8.0)) as (url, _bridge):
        arm = ConsoleArm(url, timeout_s=5.0)
        achieved = arm.aim(0.0, 60.0)
        assert abs(achieved.tilt - 60.0) <= 1.5


def test_a_target_outside_the_travel_is_refused_with_the_nearest_pose():
    """armd clamps a goal to the joint's window instead of refusing it, so an aim past the travel
    is not an error there: the joint stops at the bound and the caller waits out the whole budget
    for a pose that was never on offer. The nearest pose the joint can hold is the useful answer,
    and it costs no motion to give."""
    with console(FakeArmd({PAN: 5.0, TILT: 5.0})) as (url, bridge):
        arm = ConsoleArm(url, timeout_s=2.0)
        goals_before = dict(bridge.goals)
        with pytest.raises(ArmUnreachable) as caught:
            arm.aim(200.0, 5.0)             # the fake's pan travel is (-90, 90)
        message = str(caught.value)
        assert 'shoulder_pan=200' in message and 'nearest it can hold is 90' in message
        assert bridge.goals == goals_before     # refused without pushing anything
        assert bridge.mode != 'pose'            # and without even asking it to move


def test_an_arm_taken_over_mid_aim_is_named_instead_of_waited_out():
    """A live aim can lose the arm to another client of the same armd: the bench showed eleven
    `mode park` commands at 3.5 Hz landing during a nod, after which the jogs move nothing. A
    driver that only held what it was told would jog out the whole budget at an arm that is no
    longer listening, and report a timeout for a move that was taken away, not missed."""
    with console(FakeArmd({PAN: 0.0, TILT: 0.0}, speed_deg_s=6.0)) as (url, bridge):
        arm = ConsoleArm(url, timeout_s=5.0)

        def park_it():
            time.sleep(0.4)
            bridge.cmd('mode', {'mode': 'park'})     # what the console's park button sends

        taken = threading.Thread(target=park_it, daemon=True)
        taken.start()
        started = time.monotonic()
        with pytest.raises(ArmUnavailable) as caught:
            arm.aim(0.0, 40.0)                      # 6.7 s of travel at this joint's speed
        took = time.monotonic() - started
        taken.join(timeout=2)
        assert took < 3.0                           # it said so instead of jogging out 5 s
        assert 'taken over' in str(caught.value) and 'park' in str(caught.value)


def test_a_target_that_never_arrives_times_out_carrying_the_achieved_pose():
    with console(FakeArmd({PAN: 5.0, TILT: 5.0}, moves=False)) as (url, _bridge):
        arm = ConsoleArm(url, timeout_s=0.4)
        started = time.monotonic()
        with pytest.raises(ArmTimeout) as caught:
            arm.aim(30.0, 30.0)
        assert time.monotonic() - started < 3.0     # it gave up on its own deadline
        message = str(caught.value)
        # The arm never moves at all here, so this is the stop-making-progress report: it says
        # where the arm is, how far out it is, and where its goal was left.
        assert 'stopped making progress' in message
        assert 'pan=5' in message and 'tilt=5' in message and '25 deg out' in message


def test_a_disarmed_arm_is_armed_once_and_the_arm_is_not_moved_by_it():
    with console(FakeArmd({PAN: 3.0, TILT: 3.0}, armed=False)) as (url, bridge):
        arm = ConsoleArm(url, timeout_s=3.0)
        arm.connect()
        assert bridge.armed and bridge.mode == 'idle'
        assert arm.pose().pan == 3.0        # arming moved nothing


def test_nod_leaves_the_pose_where_it_found_it():
    with console(FakeArmd({PAN: 5.0, TILT: 5.0})) as (url, bridge):
        arm = ConsoleArm(url, timeout_s=3.0)
        arm.nod(2)
        assert max(bridge.trace) >= 5.0 + 2.0       # it really tilted up
        assert min(bridge.trace) <= 5.0 - 2.0       # and down
        assert abs(arm.pose().tilt - 5.0) <= 1.5


def test_home_returns_the_stored_park_pose():
    bridge = FakeArmd({PAN: 30.0, TILT: -20.0})
    bridge.park[PAN], bridge.park[TILT] = 12.0, 8.0
    with console(bridge) as (url, _bridge):
        arm = ConsoleArm(url, timeout_s=3.0)
        achieved = arm.home()
        assert abs(achieved.pan - 12.0) <= PARK_TOL
        assert abs(achieved.tilt - 8.0) <= PARK_TOL


# ------------------------------------------------------------------ errors

def test_a_bridge_refusal_is_an_arm_error_not_an_unavailable_arm():
    refused = {
        'method': 'arm',
        'error': 'RuntimeError: limits.json does not match the current calibration; capture ready first',
    }
    with console(FakeArmd(armed=False, refuse=refused)) as (url, _bridge):
        arm = ConsoleArm(url)
        with pytest.raises(ArmError) as caught:
            arm.connect()
        assert not isinstance(caught.value, ArmUnavailable)
        assert 'limits.json does not match' in str(caught.value)


def test_a_console_with_armd_down_is_unavailable_with_the_console_words():
    with console(status=503, error='armd is not running (failed to open the arm)') as (url, _bridge):
        arm = ConsoleArm(url)
        with pytest.raises(ArmUnavailable) as caught:
            arm.pose()
        assert 'armd is not running' in str(caught.value)
        # `ArmUnavailable`'s sibling is the transport that said nothing at all; the
        # console answered here, and that is the difference worth pinning.
        assert not isinstance(caught.value, ArmUnreachable)


def test_armd_not_answering_is_unavailable_with_the_console_words():
    with console(status=504, error='no reply within 30 s') as (url, _bridge):
        arm = ConsoleArm(url)
        with pytest.raises(ArmUnavailable) as caught:
            arm.connect()
        assert 'no reply within 30 s' in str(caught.value)


def test_a_console_that_is_not_there_is_unavailable_and_describe_is_none():
    arm = ConsoleArm('http://127.0.0.1:9')
    with pytest.raises(ArmUnavailable):
        arm.pose()
    assert arm.describe() is None


# ------------------------------------------------------------------- caps

def test_describe_reports_the_caps_the_server_validates():
    with console(FakeArmd({PAN: 1.0, TILT: 2.0})) as (url, _bridge):
        arm = ConsoleArm(url)
        caps = arm.describe()
    assert set(caps) == {'model', 'dof', 'port'}
    assert caps['dof'] == 5                 # the five joints the arm itself reports
    assert caps['port'] == PORT
    assert caps['model']


# ---------------------------------------------------------------- opening

def test_open_arm_with_none_has_no_arm():
    log = logging.getLogger('heli_rig.arm')
    assert open_arm(_cfg(arm_driver='none'), log) is None


def test_open_arm_with_console_hands_back_a_driver_that_names_its_reason():
    log = logging.getLogger('heli_rig.arm')
    arm = open_arm(_cfg(arm_driver='console', console_url='http://127.0.0.1:9'), log)
    assert arm is not None
    with pytest.raises(ArmUnavailable):
        arm.aim(0.0, 0.0)


def test_a_rig_with_nothing_attached_gets_no_arm_and_one_line_of_log(caplog, monkeypatch):
    class Nowhere(SerialArm):
        def connect(self) -> None:
            raise ArmUnavailable(f'could not start the bridge ({self.python}): No such file')

    monkeypatch.setattr('heli_rig.arm.SerialArm', Nowhere)
    log = logging.getLogger('heli_rig.arm')
    with caplog.at_level(logging.WARNING, logger='heli_rig.arm'):
        assert open_arm(_cfg(arm_driver='auto'), log) is None
    warnings = [record for record in caplog.records if record.name == 'heli_rig.arm' and record.levelno >= logging.WARNING]
    assert len(warnings) == 1
    assert 'no arm' in warnings[0].getMessage()


def test_auto_takes_the_console_when_it_answers():
    log = logging.getLogger('heli_rig.arm')
    with console(FakeArmd({PAN: 7.0, TILT: -7.0})) as (url, _bridge):
        arm = open_arm(_cfg(arm_driver='auto', console_url=url), log)
        assert arm is not None
        assert arm.pose().pan == 7.0        # the console's arm, not a bridge of our own


def test_a_console_without_its_arm_daemon_is_no_arm_at_all(caplog):
    """The console process being up is not the arm being there. With armd down every command comes
    back carrying armd's own refusal, so a rig that handed out a driver would advertise an arm that
    cannot move - and the caps it registers with are read from the armd that is not answering."""
    refusal = 'armd is not running (code 2); retrying every 10 s'
    log = logging.getLogger('heli_rig.arm')
    with console(FakeArmd(refuse={'method': 'state', 'error': refusal})) as (url, _bridge):
        with caplog.at_level(logging.WARNING, logger='heli_rig.arm'):
            assert open_arm(_cfg(arm_driver='auto', console_url=url), log) is None
    warnings = [record.getMessage() for record in caplog.records if record.levelno >= logging.WARNING]
    assert any('arm daemon is not answering' in message and refusal in message for message in warnings)


def test_serial_refuses_while_the_console_holds_the_arm():
    with console() as (url, _bridge):
        arm = SerialArm(url)
        with pytest.raises(ArmUnavailable) as caught:
            arm.connect()
        assert 'console holds the arm' in str(caught.value)


# ------------------------------------------------------------------ point

def test_point_aims_through_the_stored_calibration(tmp_path):
    calibration = _with_poses(
        tmp_path / 'rig.json',
        [(0.0, 0.0, 0.0, 0.0), (200.0, 0.0, 20.0, 0.0), (0.0, 200.0, 0.0, 20.0)],
    )
    with console(FakeArmd({PAN: 0.0, TILT: 0.0})) as (url, _bridge):
        arm = ConsoleArm(url, timeout_s=3.0, calibration=calibration)
        achieved = arm.point(150.0, 100.0)
        assert abs(achieved.pan - 15.0) <= 1.5
        assert abs(achieved.tilt - 10.0) <= 1.5


def test_point_without_a_calibration_invents_nothing():
    with console() as (url, bridge):
        arm = ConsoleArm(url)
        with pytest.raises(ArmUnavailable) as caught:
            arm.point(100.0, 100.0)
        assert 'no calibration' in str(caught.value)
        assert bridge.mode == 'idle'        # nothing was moved on the way to the refusal


# ----------------------------------------------------------------- serial

def _serial(script: str, tmp_path, **overrides) -> SerialArm:
    """A SerialArm with its own bridge: the real transport, a scripted interpreter behind it, and
    the console somewhere nothing answers so it does not refuse to start."""
    return SerialArm(
        'http://127.0.0.1:9',
        python=sys.executable,
        args=(script,),
        cwd=str(tmp_path),
        timeout_s=3.0,
        **overrides,
    )


def test_serial_aims_through_a_bridge_of_its_own(tmp_path):
    measured = {PAN: 10.0, TILT: -10.0, **{joint: 0.0 for joint in OTHER_JOINTS}}
    arm = _serial(scripted_bridge(tmp_path, measured), tmp_path)
    try:
        achieved = arm.aim(16.0, -16.0)
        assert abs(achieved.pan - 16.0) <= 1.5
        assert abs(achieved.tilt + 16.0) <= 1.5
        assert arm.describe()['port'] == PORT
    finally:
        arm.close()
    assert not arm.is_connected()


def test_serial_reports_a_refusal_from_the_bridge(tmp_path):
    script = scripted_bridge(
        tmp_path,
        refuse=('mode', 'RuntimeError: arm first (motion modes need armed)'),
    )
    arm = _serial(script, tmp_path)
    try:
        with pytest.raises(ArmError) as caught:
            arm.aim(5.0, 5.0)
        assert not isinstance(caught.value, ArmUnavailable)
        assert 'arm first' in str(caught.value)
    finally:
        arm.close()


def test_serial_reports_a_bridge_that_will_not_start(tmp_path):
    arm = SerialArm(
        'http://127.0.0.1:9',
        python=str(tmp_path / 'no-such-interpreter'),
        args=(scripted_bridge(tmp_path),),
        cwd=str(tmp_path),
    )
    with pytest.raises(ArmUnavailable) as caught:
        arm.connect()
    assert 'no-such-interpreter' in str(caught.value)


def test_serial_reports_a_bridge_that_died(tmp_path):
    where = tmp_path / 'bridge.py'
    where.write_text(
        'import json, sys\n'
        'line = sys.stdin.readline()\n'          # answer once, then go away
        'sys.stdout.write(json.dumps({"id": json.loads(line)["id"], "ok": True, "result":'
        ' {"state": {"armed": True, "measured": {"shoulder_pan": 1.0, "wrist_flex": 2.0}, "info": {}}}})'
        ' + "\\n")\n'
        'sys.stdout.flush()\n'
        'sys.exit(3)\n',
        encoding='utf-8',
    )
    arm = _serial(str(where), tmp_path)
    arm.connect()
    with pytest.raises(ArmUnavailable) as caught:
        arm.pose()
    assert 'bridge is gone' in str(caught.value)
    assert 'exit 3' in str(caught.value)


# A bridge that dies once and then stays up: the marker file is what tells the two runs of
# the same script apart, so the rig's second attempt is a bridge that answers for good.
BRIDGE_THAT_DIES_ONCE = '''
import json
import pathlib
import sys

MARKER = $MARKER
dying = not pathlib.Path(MARKER).exists()
pathlib.Path(MARKER).write_text("died", encoding="utf-8")

measured = {"shoulder_pan": 1.0, "wrist_flex": 2.0}
state = {
    "mode": "pose", "armed": True, "flags": [], "hz": 100.0,
    "measured": measured, "goals": dict(measured), "park": {}, "window": {},
    "gimbal": {"park_done": False}, "info": {"backend": "lerobot", "port": $PORT},
}


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    message = json.loads(line)
    emit({"id": message.get("id"), "ok": True, "result": {"state": state}})
    if dying:
        sys.exit(7)
'''

# A bridge that dies every time it is started, without answering anything: the shape of a bus
# that is gone for good (the console took the serial port, the arm is unplugged), and the case
# the rig must stop restarting rather than retry for the rest of the afternoon.
BRIDGE_THAT_ALWAYS_DIES = '''
import sys

for line in sys.stdin:
    sys.exit(7)      # a command arrives, the process goes: no reply, ever
'''


def _write_bridge(tmp_path, source: str, name: str = 'bridge.py') -> str:
    where = tmp_path / name
    where.write_text(
        source.replace('$MARKER', repr(str(tmp_path / 'died-once.marker'))).replace('$PORT', repr(PORT)),
        encoding='utf-8',
    )
    return str(where)


def test_the_rig_starts_a_bridge_that_died_again_by_itself(tmp_path, caplog, monkeypatch):
    """A bridge that died used to stay dead: every call after the death raised "the bridge is
    gone" and nothing started it again, so a thirteen-minute outage ended only when a person
    restarted the rig. The rig supervises its own bridge — after a bounded wait, by itself.
    """
    monkeypatch.setattr('heli_rig.arm.serial_arm.BRIDGE_RESTART_DELAYS_S', (0.05, 0.1, 0.2))
    arm = _serial(_write_bridge(tmp_path, BRIDGE_THAT_DIES_ONCE), tmp_path)
    try:
        arm.connect()                       # the first bridge answers, then exits 7

        with pytest.raises(ArmUnavailable) as caught:
            arm.pose()
        assert 'bridge is gone' in str(caught.value)
        assert 'exit 7' in str(caught.value)
        assert 'starting it again in 0.05 s' in str(caught.value), 'the caller is told what is being done'

        time.sleep(0.08)                    # the backoff, waited out — the rig's own clock
        with caplog.at_level(logging.INFO, logger='heli_rig.arm'):
            pose = arm.pose()               # ...and the rig started it again without being asked

        assert pose.pan == 1.0
        assert 'the bridge is answering again' in caplog.text
    finally:
        arm.close()


def test_a_bridge_that_keeps_dying_is_given_up_on_with_one_line(tmp_path, caplog, monkeypatch):
    """The reasons a bridge cannot open the bus do not go away between attempts, so the rig
    gives up — after a bounded number of tries, in one line, and without ever going quiet
    about it. Retrying forever is how a rig ends up spawning a process a second all night.
    """
    monkeypatch.setattr('heli_rig.arm.serial_arm.BRIDGE_RESTART_DELAYS_S', (0.01, 0.01, 0.01))
    arm = _serial(_write_bridge(tmp_path, BRIDGE_THAT_ALWAYS_DIES), tmp_path)
    try:
        with caplog.at_level(logging.WARNING, logger='heli_rig.arm'):
            with pytest.raises(ArmUnavailable):
                arm.connect()
            for _ in range(4):              # each attempt: wait out the backoff, ask again
                time.sleep(0.02)
                with pytest.raises(ArmUnavailable) as caught:
                    arm.pose()

            gave_up = str(caught.value)
            assert 'died 3 times in a row' in gave_up and 'will not be started again' in gave_up

            before = len(caplog.records)
            for _ in range(5):              # and a caller that keeps asking gets the same words
                with pytest.raises(ArmUnavailable) as again:
                    arm.pose()
                assert str(again.value) == gave_up
            assert len(caplog.records) == before, 'a rig that has given up does not keep logging'

        deaths = [record for record in caplog.records if 'the bridge died' in record.getMessage()]
        assert len(deaths) == 3, f'one line per death, not one per call: {len(deaths)}'
        assert sum('not starting it again' in record.getMessage() for record in caplog.records) == 1
    finally:
        arm.close()
