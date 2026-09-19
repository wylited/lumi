"""The ported control law: directions, the two leashes, the latches, and the numbers behind them.

Every case drives ``Gimbal.step`` with an explicit clock, so the whole law is exercised with no
arm, no camera and no sleeping: dt is the test's, ``now`` is the test's, and the measured pose is
whatever the case needs (a perfect servo that follows the goals, or an arm that is stuck).
"""

from __future__ import annotations

import json
import logging
from dataclasses import replace

import pytest

from heli_rig.arm.gimbal import (
    ARM_JOINTS,
    DEADBAND,
    DIVERGENCE_HOLD_S,
    JOG_VMAX,
    REL_STEP_DEG,
    REL_STEP_LOADED_DEG,
    STALE_MS,
    TRACK,
    Gimbal,
    Target,
)

PAN, TILT = "shoulder_pan", "wrist_flex"


def pose(**angles: float) -> dict[str, float]:
    """A measured pose: every joint at 0 unless named."""
    return {joint: 0.0 for joint in ARM_JOINTS} | angles


def gimbal(**kwargs) -> Gimbal:
    """A gimbal on a wide window with caps that keep the arithmetic readable.

    pan and tilt: 30 deg/s, 300 deg/s^2, kp 120/80 -> a 0.1 error asks for 12 deg/s on pan, and the
    acceleration ramp adds 3 deg/s a tick at dt = 0.01.
    """
    kwargs.setdefault(
        "window", {PAN: {"min": -60.0, "max": 60.0}, TILT: {"min": -60.0, "max": 60.0}}
    )
    kwargs.setdefault(
        "caps", {"pan_v_max": 30.0, "pan_a_max": 300.0, "tilt_v_max": 30.0, "tilt_a_max": 300.0}
    )
    return Gimbal(logging.getLogger("test"), **kwargs)


def drive(g, ticks, measured, *, dt=0.01, now0=0.0, pad=None, target=None, follow=False):
    """Run `ticks` control ticks and answer the last goals.

    `pad` is re-sent every tick, as the operator's own loop does; `target` is re-stamped every tick
    so it cannot go stale; `follow` turns the measured pose into a perfect servo, tracking the goals
    it was given (updated in place, so the caller can keep reading it).
    """
    goals: dict[str, float] = {}
    now = now0
    for k in range(ticks):
        now = now0 + k * dt
        if pad is not None:
            g.set_input(pad[0], pad[1], now=now)
        if target is not None:
            g.set_target(replace(target, at=now))
        goals = g.step(dt, measured, now=now)
        if follow:
            measured.update(goals)
    return goals


def test_a_track_step_moves_a_positive_error_the_positive_way_at_the_gain_rate():
    g = gimbal()
    g.set_mode("track")
    measured = pose()
    target = Target(valid=True, tid=1, conf=0.9, ex=0.1)
    goals = drive(g, 1, measured, target=target)
    assert goals[PAN] == pytest.approx(0.03)          # a_max * dt = 3 deg/s, one tick
    assert g.rates[PAN] == pytest.approx(3.0)
    goals = drive(g, 19, measured, now0=0.01, target=target)
    # kp * ex = 120 * 0.1 = 12 deg/s is the request; the acceleration ramp is there on tick 4
    assert g.rates[PAN] == pytest.approx(12.0)
    assert goals[PAN] == pytest.approx(2.22)          # 0.03 + 0.06 + 0.09 + 0.12, then 16 * 0.12
    assert g.flags["stale"] is False


def test_a_track_step_moves_a_negative_error_the_other_way():
    g = gimbal()
    g.set_mode("track")
    goals = drive(g, 1, pose(), target=Target(valid=True, tid=1, ex=-0.1))
    assert goals[PAN] == pytest.approx(-0.03)
    assert g.rates[PAN] == pytest.approx(-3.0)


def test_a_flipped_axis_sign_drives_the_goal_the_other_way():
    g = gimbal(signs=(-1, 1))
    g.set_mode("track")
    goals = drive(g, 1, pose(), target=Target(valid=True, tid=1, ex=0.1))
    assert goals[PAN] == pytest.approx(-0.03)         # request +3 deg/s, joint -3 deg/s
    assert g.rates[PAN] == pytest.approx(-3.0)


def test_an_error_inside_the_deadband_commands_nothing():
    g = gimbal()
    g.set_mode("track")
    assert DEADBAND == 0.04
    goals = drive(g, 5, pose(), target=Target(valid=True, tid=1, ex=0.039, ey=-0.039))
    assert goals[PAN] == 0.0 and goals[TILT] == 0.0
    assert g.rates[PAN] == 0.0 and g.rates[TILT] == 0.0


def test_a_stale_or_unlocked_target_commands_nothing_but_only_the_stream_is_flagged():
    g = gimbal()
    g.set_mode("track")
    drive(g, 1, pose(), target=Target(valid=True, tid=1, ex=0.5))
    goals = drive(g, 1, pose(), now0=STALE_MS / 1e3 + 1.0)   # the stream went quiet
    assert g.flags["stale"] is True
    assert g.rates[PAN] == pytest.approx(0.0)                # the commanded rate is gone
    assert goals[PAN] == pytest.approx(0.03)                 # ...and the goal holds where it was
    g.set_target(Target(valid=False, tid=None, at=99.0))
    drive(g, 1, pose(), now0=99.1)
    assert g.flags["stale"] is False                         # vision is alive, nobody is locked


def test_the_goal_may_not_lead_the_measured_pose_by_more_than_one_rel_step():
    g = gimbal()
    g.set_mode("track")
    target = Target(valid=True, tid=1, ex=0.5)          # kp * ex = 60 deg/s, capped at 30
    measured = pose()
    for k in range(20):
        measured[PAN] = k * 1.0                          # the arm runs at 20 deg/s: slower than asked
        g.set_target(replace(target, at=k * 0.05))
        goals = g.step(0.05, measured, now=k * 0.05)
    assert g.rates[PAN] == pytest.approx(30.0)           # the request stays at the cap
    assert REL_STEP_DEG == 4.0
    assert goals[PAN] - measured[PAN] == pytest.approx(REL_STEP_DEG)
    assert g.flags["rel_clamped"] is True
    assert g.pan.blocked is False                        # it is moving: nothing is obstructed


def test_a_goal_past_the_window_is_clamped_and_handed_back_to_the_measured_pose():
    g = gimbal(window={PAN: {"min": -3.0, "max": 3.0}})
    g.set_mode("manual")
    measured = pose()                                   # the arm never follows: only the goal travels
    goals = drive(g, 3, measured, dt=0.05, pad=(1.0, 0.0))
    assert goals[PAN] == pytest.approx(3.0)             # 0.75 + 1.5 + 1.5 -> clamped at the window
    assert g.flags["at_limit"] is True
    assert g._against_bound(g.pan, 30.0, measured) is True
    goals = drive(g, 1, measured, dt=0.05, now0=0.15, pad=(1.0, 0.0))
    assert goals[PAN] == pytest.approx(0.0)             # the goal goes to where the arm actually is
    assert g.pan.rate == 0.0 and g.rates[PAN] == 0.0
    assert g._against_bound(g.pan, 30.0, measured) is False   # off the bound, on the measured pose
    g.pan.goal = -3.0
    assert g._against_bound(g.pan, -30.0, measured) is True
    assert g._against_bound(g.pan, 0.0, measured) is False    # no request, no bound


def test_the_bounds_widen_to_contain_where_the_arm_actually_is():
    g = gimbal(window={TILT: {"min": -81.9659, "max": -2.0659}})
    measured = pose(**{TILT: -89.5})                    # left outside its own window by hand
    assert g._bounds(TILT, g.tilt, measured) == (-89.5, -2.0659)
    assert g._bounds(TILT, g.tilt, pose(**{TILT: -40.0})) == (-81.9659, -2.0659)
    assert g.tilt.lo == -81.9659                        # the widening is not written back


def test_the_track_leash_holds_the_goal_one_leash_from_the_anchor():
    g = gimbal()
    g.set_mode("track")
    measured = pose()
    goals = drive(g, 60, measured, dt=0.05, follow=True, target=Target(valid=True, tid=1, ex=0.5))
    assert g.pan.anchor == 0.0                          # where track mode was engaged
    assert goals[PAN] == pytest.approx(25.0)            # TRACK_LEASH_DEG, never past it
    assert g.flags["at_limit"] is True
    # The leash is a bound the stall gate knows about, so the axis is not reported as obstructed.
    assert g.pan.blocked is False and g.flags["stalled"] is False


def test_a_joint_that_stops_making_progress_is_released_and_clears_when_commanded_back():
    g = gimbal()
    g.set_mode("manual")
    measured = pose()                                   # stuck: something is in the way
    dt = 0.01
    goals = drive(g, 50, measured, dt=dt, pad=(1.0, 0.0))
    assert g.pan.blocked is False
    assert g.pan.rel_step == pytest.approx(REL_STEP_LOADED_DEG)   # the loaded lead comes first
    assert REL_STEP_LOADED_DEG == 8.0
    drive(g, 30, measured, dt=dt, now0=50 * dt, pad=(1.0, 0.0))
    assert g.pan.blocked is False                       # 0.8 s of no travel is the latch point
    goals = drive(g, 10, measured, dt=dt, now0=80 * dt, pad=(1.0, 0.0))
    assert g.pan.blocked is True and g.flags["stalled"] is True
    assert goals[PAN] == pytest.approx(0.0)             # released: the goal holds the measured pose
    assert g.rates[PAN] == 0.0                          # and the transport is told to stop pushing
    g.set_input(-1.0, 0.0, now=0.90)
    goals = g.step(dt, measured, now=0.90)
    assert g.pan.blocked is False and g.flags["stalled"] is False
    assert goals[PAN] < 0.0 and g.rates[PAN] < 0.0      # commanded the other way, it moves


def test_park_slews_to_the_park_pose_and_says_when_it_is_there():
    g = gimbal(park={PAN: 10.0})
    g.set_mode("park")
    measured = pose()
    goals = drive(g, 9, measured, dt=0.05, follow=True)
    assert goals[PAN] == pytest.approx(9.0)             # PARK_VMAX 20 deg/s * 0.05 s a tick
    assert g.flags["park_done"] is False
    goals = drive(g, 1, measured, dt=0.05, now0=9 * 0.05, follow=True)
    assert goals[PAN] == pytest.approx(10.0)
    assert measured[PAN] == pytest.approx(10.0)
    assert g.park_done is True and g.flags["park_done"] is True
    assert g.rates[PAN] == 0.0                          # park slews the goals, not a jog rate


def test_park_calls_a_joint_that_cannot_reach_its_pose_done_once_it_stops():
    g = gimbal(park={PAN: 10.0})
    g.set_mode("park")
    measured = pose(**{PAN: 4.0})                       # stuck 6 deg short of its park pose
    drive(g, 16, measured, dt=0.05)                     # 0.75 s: still asking
    assert g.park_done is False
    goals = drive(g, 1, measured, dt=0.05, now0=16 * 0.05)
    assert g.park_done is True                          # PARK_SETTLE_S 0.8 s of no progress
    # It still asks for the park pose - as far as one rel-step past a stuck joint reaches; the
    # joint does not move, and park is done once it stops trying.
    assert goals[PAN] == pytest.approx(4.0 + REL_STEP_DEG)
    assert measured[PAN] == 4.0


def test_jog_moves_at_the_commanded_rate_and_holds_still_at_zero():
    g = gimbal()
    g.set_mode("pose")
    measured = pose()
    goals = {}
    for k in range(4):
        g.set_jog(PAN, 5.0, now=k * 0.05)               # the operator's loop refreshes a jog
        goals = g.step(0.05, measured, now=k * 0.05)
    assert goals[PAN] == pytest.approx(1.0)             # 5 deg/s * 0.05 s * 4
    assert g.rates[PAN] == pytest.approx(5.0)
    g.set_jog(PAN, 0.0, now=0.20)
    goals = g.step(0.05, measured, now=0.20)
    assert goals[PAN] == pytest.approx(1.0)             # a zero jog holds where it is
    goals = g.step(0.05, measured, now=0.50)            # 300 ms since the last word: stale
    assert g._jog == {} and goals[PAN] == pytest.approx(1.0)
    g.set_jog(PAN, 50.0, now=0.50)
    assert g._jog[PAN] == pytest.approx(JOG_VMAX)       # 10 deg/s


def test_divergence_latches_when_the_error_keeps_growing_under_a_saturated_request():
    # Small caps keep 1.5 s of saturated travel (7.5 deg) well inside the 25 deg track leash, and a
    # following arm keeps the stall gate out of it - the guard is the only thing that can stop this.
    g = gimbal(caps={"pan_v_max": 5.0, "pan_a_max": 50.0, "tilt_v_max": 5.0, "tilt_a_max": 50.0})
    g.set_mode("track")
    measured = pose()
    target = Target(valid=True, tid=1, conf=0.9)

    def run(start: int, stop: int) -> dict[str, float]:
        goals: dict[str, float] = {}
        for k in range(start, stop):
            g.set_target(replace(target, ex=0.25 + 0.002 * k, at=k * 0.01))
            goals = g.step(0.01, measured, now=k * 0.01)
            measured.update(goals)
        return goals

    assert DIVERGENCE_HOLD_S == 1.5
    run(0, 100)
    assert g.divergence is False                        # 1.0 s of growth: inside the window
    run(100, 200)
    assert g.divergence is True and g.flags["divergence"] is True
    assert g.pan.rate == 0.0 and g.rates[PAN] == 0.0    # the axis is stopped while it holds
    held = run(200, 300)[PAN]
    assert g.divergence is True                         # still latched, and not chasing
    assert g.goals[PAN] == pytest.approx(held)
    run(300, 320)
    assert g.divergence is False                        # it let go by itself after the hold
    assert g.rates[PAN] > 0.0                           # and the axis is driving again


def test_a_saturated_request_on_a_steady_error_is_not_a_divergence():
    # The same saturation with the error standing still is a person crossing the room faster than
    # the axis travels: the guard must not freeze the loop on the motion it exists to follow.
    g = gimbal(caps={"pan_v_max": 5.0, "pan_a_max": 50.0, "tilt_v_max": 5.0, "tilt_a_max": 50.0})
    g.set_mode("track")
    measured = pose()
    target = Target(valid=True, tid=1, conf=0.9, ex=0.5)
    for k in range(300):                                # 3.0 s: twice the divergence window
        g.set_target(replace(target, at=k * 0.01))
        goals = g.step(0.01, measured, now=k * 0.01)
        measured.update(goals)
    assert g.divergence is False and g.flags["divergence"] is False
    assert g.rates[PAN] == pytest.approx(5.0)           # still driving at the cap
    assert goals[PAN] > 10.0                            # and the goal travelled with it


def test_freeze_holds_the_goals_where_they_are_and_releases():
    g = gimbal()
    g.set_mode("track")
    measured = pose()
    target = Target(valid=True, tid=1, ex=0.5)
    goals = drive(g, 5, measured, target=target)
    moving = goals[PAN]
    assert moving > 0.0
    g.freeze(True)
    goals = drive(g, 20, measured, now0=0.05, target=target)
    assert goals[PAN] == pytest.approx(moving)          # frozen: the goal stays where it was
    assert g.flags["estopped"] is True and g.rates[PAN] == 0.0
    g.freeze(False)
    goals = drive(g, 1, measured, now0=0.25, target=target)
    assert goals[PAN] > moving


def test_set_mode_clears_the_latches_and_the_inputs_of_the_mode_it_leaves():
    g = gimbal()
    g.set_input(0.7, -0.7, now=0.0)
    g.set_jog(PAN, 5.0, now=0.0)
    g.pan.blocked = True
    g.pan.stall_at = 0.5
    g.pan.anchor = 3.0
    g.divergence = True
    g.set_mode("park")
    assert g.mode == "park"
    assert g.input == [0.0, 0.0]                        # the pad is dropped with the mode reading it
    assert g._jog == {}
    assert (g.pan.blocked, g.pan.stall_at, g.pan.anchor) == (False, None, None)
    assert g.divergence is False
    g.pan.blocked = True
    g.set_mode("park")                                  # the console re-sends the mode it is in
    assert g.pan.blocked is True                        # ...and that is not a reset
    with pytest.raises(ValueError):
        g.set_mode("spin")


def test_a_point_in_the_frame_is_reduced_against_the_aim_point():
    t = Target.from_point(0.6, 0.55, (0.5, 0.5), tid=7, conf=0.9, vx=0.1, vy=-0.2, now=1.5)
    assert (t.ex, t.ey) == pytest.approx((0.1, 0.05))
    assert t.valid is True and t.tid == 7 and t.conf == 0.9
    assert (t.vx, t.vy) == pytest.approx((0.1, -0.2))
    assert t.age_ms(1.8) == pytest.approx(300.0)


def test_from_files_reads_the_rigs_own_records(tmp_path):
    limits = {
        "ready": {PAN: -7.5604, TILT: -62.0659},
        "park": {PAN: -7.5604, TILT: -62.0659},
        "window": {
            PAN: {"min": -67.17582417582418, "max": 52.4396},
            TILT: {"min": -81.9659, "max": -2.0659},
        },
        "pan_joint": PAN,
        "tilt_joint": TILT,
        "pan_sign": 1,
        "tilt_sign": -1,
        "aim": [0.4, 0.6],
    }
    motion = {
        "track": {"pan_v_max": 38.6, "pan_a_max": 221.0, "tilt_v_max": 88.2, "tilt_a_max": 300.5}
    }
    (tmp_path / "limits.json").write_text(json.dumps(limits))
    (tmp_path / "motion.json").write_text(json.dumps(motion))
    g = Gimbal.from_files(tmp_path / "limits.json", tmp_path / "motion.json")
    assert (g.pan.joint, g.tilt.joint) == (PAN, TILT)
    assert (g.pan.sign, g.tilt.sign) == (1, -1)
    assert g.aim == (0.4, 0.6)
    assert g.ready[PAN] == -7.5604 and g.park[TILT] == -62.0659
    assert g.pan.v_max == 38.6 and g.pan.a_max == 221.0
    assert g.tilt.v_max == 88.2 and g.tilt.a_max == 300.5
    assert (g.pan.lo, g.pan.hi) == (-67.17582417582418, 52.4396)   # envelope intersected in
    assert g.window[PAN] == {"min": g.pan.lo, "max": g.pan.hi}     # and reported as enforced
    assert (g.tilt.lo, g.tilt.hi) == (-81.9659, -2.0659)


def test_from_files_falls_back_when_the_records_are_not_there_yet(tmp_path):
    g = Gimbal.from_files(tmp_path / "limits.json", tmp_path / "motion.json")
    assert g.pan.v_max == pytest.approx(TRACK["pan_v_max"])       # the measured defaults
    assert g.tilt.a_max == pytest.approx(TRACK["tilt_a_max"])
    assert (g.pan.lo, g.pan.hi) == (-90.0, 95.0)                  # the pan envelope alone
    assert g.aim == (0.5, 0.5)


def test_snapshot_reports_where_the_law_thinks_it_is():
    g = gimbal(park={PAN: 3.0})
    g.set_mode("park")
    measured = pose()
    drive(g, 3, measured, dt=0.05, follow=True)
    snap = g.snapshot()
    assert snap["mode"] == "park"
    assert snap["goals"][PAN] == pytest.approx(3.0)
    assert snap["pan"]["joint"] == PAN and snap["pan"]["sign"] == 1
    assert snap["aim"] == [0.5, 0.5]
    assert snap["rates"][PAN] == 0.0
    assert snap["stalled"] == []
    assert snap["flags"]["park_done"] is True


def test_rates_are_the_commanded_joint_rate_for_every_joint():
    g = gimbal()
    g.set_mode("track")
    measured = pose()
    drive(g, 5, measured, target=Target(valid=True, tid=1, ex=0.1))
    assert g.rates == pytest.approx({joint: 0.0 for joint in ARM_JOINTS} | {PAN: 12.0})
    flipped = gimbal(signs=(-1, 1))
    flipped.set_mode("manual")
    drive(flipped, 2, pose(), pad=(1.0, 0.0))                     # request 30 deg/s, sign -1
    assert flipped.rates[PAN] == pytest.approx(-6.0)              # the joint travels the other way
    posed = gimbal()
    posed.set_mode("pose")
    posed.set_jog(PAN, 5.0, now=0.0)
    posed.step(0.05, pose(), now=0.0)
    assert posed.rates[PAN] == pytest.approx(5.0)                 # a jog is a rate, sent as it was
    assert posed.rates[TILT] == 0.0
    g.freeze(True)
    drive(g, 1, measured, now0=0.05, target=Target(valid=True, tid=1, ex=0.1))
    assert g.rates == pytest.approx({joint: 0.0 for joint in ARM_JOINTS})
