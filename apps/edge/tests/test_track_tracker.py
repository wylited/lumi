"""The lock: who the rig follows, what a gap in the detections does, and which way the error points.

The x/y signs decide which way the camera turns, so they are pinned with arithmetic, not with a
comment. Everything here is synthetic and offline: what the model says is the detector's business,
and its tests live next door.
"""

from __future__ import annotations

import logging

import numpy as np
import pytest

from heli_rig.track.detector import Detection
from heli_rig.track.tracker import TargetTracker

FRAME = (640, 480)  # width, height: the rig's own UVC size
CENTER = (320.0, 240.0)


def log() -> logging.Logger:
    return logging.getLogger("test.track.tracker")


def body(x1: float, y1: float, x2: float, y2: float, conf: float = 0.9,
         chest: tuple[float, float] | None = CENTER) -> Detection:
    """A detection of one person, with either a chest at that pixel or no keypoints at all."""
    keypoints = np.zeros((17, 3), np.float32)
    if chest is not None:
        for index in (5, 6, 11, 12):  # shoulders and hips, all four, all visible
            keypoints[index] = (chest[0], chest[1], 0.9)
    return Detection(bbox=(x1, y1, x2, y2), conf=conf, keypoints=keypoints)


@pytest.fixture
def tracker() -> TargetTracker:
    return TargetTracker(log())


# ------------------------------------------------------------------ which way is which

def test_a_person_left_of_the_aim_point_gives_negative_x(tracker):
    # 160 px in a 640-wide frame is 0.25 of a width left of the middle: 160/640 - 0.5 = -0.25.
    target = tracker.update([body(0.0, 0.0, 200.0, 400.0, chest=(160.0, 120.0))], FRAME, now=0.0)
    assert (target.x, target.y) == (-0.25, -0.25)
    assert target.valid is True
    assert target.id is not None


def test_a_person_right_of_the_aim_point_gives_positive_x(tracker):
    # 480/640 - 0.5 = +0.25, and 360/480 - 0.5 = +0.25: down the frame is +y.
    target = tracker.update([body(440.0, 100.0, 640.0, 500.0, chest=(480.0, 360.0))], FRAME, now=0.0)
    assert (target.x, target.y) == (0.25, 0.25)


def test_the_aim_point_is_where_the_tracker_was_told_it_is():
    tracker = TargetTracker(log(), aim=(0.25, 0.5))
    target = tracker.update([body(0.0, 0.0, 400.0, 480.0, chest=(288.0, 240.0))], FRAME, now=0.0)
    assert target.x == pytest.approx(288.0 / 640.0 - 0.25)  # 0.2, not measured from 0.5
    assert target.y == 0.0


def test_a_person_inside_the_deadband_is_reported_as_centred(tracker):
    # 0.03125 of a width off centre: inside the 0.05 band, so the rig must not chase it.
    inside = tracker.update([body(0.0, 0.0, 400.0, 480.0, chest=(340.0, 232.0))], FRAME, now=0.0)
    assert inside.valid is True
    assert (inside.x, inside.y) == (0.0, 0.0)
    # 0.0625 of a width: outside the band, and it comes through untouched.
    outside = tracker.update([body(0.0, 0.0, 400.0, 480.0, chest=(360.0, 240.0))], FRAME, now=0.1)
    assert outside.x == pytest.approx(360.0 / 640.0 - 0.5)


# ------------------------------------------------------------------ holding the lock

def test_the_lock_survives_a_frame_with_nobody_in_it(tracker):
    him = body(200.0, 100.0, 440.0, 460.0, chest=(320.0, 280.0))
    locked = tracker.update([him], FRAME, now=0.0)
    assert locked.valid is True
    missed = tracker.update([], FRAME, now=0.1)
    assert missed.valid is False, "no detection means no error to steer by"
    assert missed.id == locked.id, "a moment out of view is not a different person"
    assert (missed.x, missed.y, missed.conf) == (0.0, 0.0, 0.0)
    back = tracker.update([him], FRAME, now=0.2)
    assert (back.valid, back.id) == (True, locked.id)


def test_a_lock_gone_past_stale_gives_way_to_a_fresh_pick(tracker):
    him = body(200.0, 100.0, 440.0, 460.0, chest=(320.0, 280.0))
    locked = tracker.update([him], FRAME, now=0.0)
    other = body(0.0, 0.0, 120.0, 300.0, conf=0.7, chest=(60.0, 150.0))
    # In the same frame: 0.31 s since the last sighting is past the 0.3 s stale window.
    fresh = tracker.update([other], FRAME, now=0.31)
    assert fresh.id != locked.id
    assert fresh.valid is True
    assert fresh.x == pytest.approx(60.0 / 640.0 - 0.5)
    # And once even that fresh lock has been out of view past the window, nothing is locked.
    gone = tracker.update([], FRAME, now=0.7)
    assert (gone.id, gone.valid) == (None, False)


def test_another_person_does_not_steal_a_held_lock(tracker):
    him = body(200.0, 100.0, 440.0, 460.0, conf=0.6, chest=(320.0, 280.0))
    locked = tracker.update([him], FRAME, now=0.0)
    moved = body(210.0, 110.0, 450.0, 470.0, conf=0.5, chest=(400.0, 290.0))
    louder = body(0.0, 0.0, 200.0, 400.0, conf=0.99, chest=(100.0, 200.0))
    target = tracker.update([louder, moved], FRAME, now=0.1)
    assert target.id == locked.id, "the lock is a person, not the top confidence of the frame"
    assert target.valid is True
    assert target.conf == 0.5
    assert target.x == pytest.approx(400.0 / 640.0 - 0.5)


def test_a_detection_that_only_clips_the_lock_is_not_the_locked_person(tracker):
    him = body(0.0, 0.0, 100.0, 100.0, chest=(50.0, 50.0))
    locked = tracker.update([him], FRAME, now=0.0)
    # 20 px of overlap out of 19600: IoU 0.02, far below the 0.3 floor.
    corner = body(80.0, 80.0, 180.0, 180.0, conf=0.95, chest=(130.0, 130.0))
    target = tracker.update([corner], FRAME, now=0.1)
    assert (target.valid, target.id) == (False, locked.id)
    assert (target.x, target.y) == (0.0, 0.0)


def test_a_blob_with_no_shoulders_or_hips_is_never_picked(tracker):
    blob = body(100.0, 100.0, 400.0, 400.0, conf=0.95, chest=None)
    empty = tracker.update([blob], FRAME, now=0.0)
    assert (empty.id, empty.valid) == (None, False), "a box is not a person to lock onto"
    assert (empty.x, empty.y, empty.conf) == (0.0, 0.0, 0.0)


def test_a_locked_person_without_a_chest_holds_the_lock_without_an_error(tracker):
    him = body(200.0, 100.0, 440.0, 460.0, conf=0.8, chest=(320.0, 280.0))
    locked = tracker.update([him], FRAME, now=0.0)
    turned = body(205.0, 105.0, 445.0, 465.0, conf=0.7, chest=None)
    blind = tracker.update([turned], FRAME, now=0.1)
    assert blind.valid is False, "matched, but with no chest there is no error to give"
    assert blind.id == locked.id
    assert blind.conf == 0.7, "the body is still in front of the camera, and conf says so"
    seen = tracker.update([body(210.0, 110.0, 450.0, 470.0, conf=0.7, chest=(330.0, 290.0))],
                          FRAME, now=0.2)
    assert (seen.valid, seen.id) == (True, locked.id)


# ------------------------------------------------------------------ locking on purpose

def test_lock_none_goes_back_to_the_best_person_in_frame(tracker):
    him = body(200.0, 100.0, 440.0, 460.0, conf=0.5, chest=(320.0, 280.0))
    locked = tracker.update([him], FRAME, now=0.0)
    better = body(0.0, 0.0, 200.0, 400.0, conf=0.9, chest=(100.0, 200.0))
    held = tracker.update([him, better], FRAME, now=0.1)
    assert held.id == locked.id, "still the same person, even with a louder one around"
    tracker.lock(None)
    picked = tracker.update([him, better], FRAME, now=0.2)
    assert picked.id != locked.id
    assert picked.conf == 0.9
    assert picked.x == pytest.approx(100.0 / 640.0 - 0.5)


def test_locking_an_id_binds_it_to_the_next_person_that_is_seen(tracker):
    him = body(200.0, 100.0, 440.0, 460.0, conf=0.6, chest=(320.0, 280.0))
    tracker.update([him], FRAME, now=0.0)
    tracker.lock(41)
    seen = tracker.update([him], FRAME, now=0.1)
    assert (seen.valid, seen.id) == (True, 41)
    # An id that was never bound to anybody is not reported as a lock.
    tracker.lock(42)
    nobody = tracker.update([], FRAME, now=0.2)
    assert (nobody.id, nobody.valid) == (None, False)


def test_locking_the_id_already_held_keeps_the_lock_and_its_box(tracker):
    him = body(200.0, 100.0, 440.0, 460.0, conf=0.6, chest=(320.0, 280.0))
    locked = tracker.update([him], FRAME, now=0.0)
    tracker.lock(locked.id)
    still = tracker.update([him], FRAME, now=0.1)
    assert (still.valid, still.id) == (True, locked.id)
