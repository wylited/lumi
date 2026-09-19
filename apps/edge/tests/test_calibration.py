"""HELI-042's calibration: the fit that turns a desk point into a pose, the refusal when there is
not enough of one, and the file it shares with the desk's own id and token."""

from __future__ import annotations

import json

import pytest

from heli_rig.arm.calibration import Calibration
from heli_rig.arm.driver import ArmUnavailable

# A mapping with a known answer: pan and tilt are affine in the desk plane.
PAN = (0.05, 0.02, 1.0)
TILT = (-0.03, 0.04, -2.0)


def look(x_mm: float, y_mm: float) -> tuple[float, float]:
    return (
        PAN[0] * x_mm + PAN[1] * y_mm + PAN[2],
        TILT[0] * x_mm + TILT[1] * y_mm + TILT[2],
    )


def calibrated(path, where=((0.0, 0.0), (400.0, 0.0), (0.0, 300.0))) -> Calibration:
    calibration = Calibration(path)
    for x_mm, y_mm in where:
        calibration.add_pose(x_mm, y_mm, *look(x_mm, y_mm))
    return calibration


def test_three_poses_round_trip_the_mapping_they_were_measured_from(tmp_path):
    calibration = calibrated(tmp_path / 'rig.json')
    for x_mm, y_mm in ((0.0, 0.0), (400.0, 0.0), (0.0, 300.0), (220.0, 140.0)):
        pan, tilt = calibration.point(x_mm, y_mm)
        assert pan == pytest.approx(look(x_mm, y_mm)[0], abs=1e-6)
        assert tilt == pytest.approx(look(x_mm, y_mm)[1], abs=1e-6)


def test_two_poses_are_not_enough_to_point(tmp_path):
    calibration = calibrated(tmp_path / 'rig.json', where=((0.0, 0.0), (400.0, 0.0)))
    with pytest.raises(ArmUnavailable) as caught:
        calibration.point(200.0, 100.0)
    assert 'three poses' in str(caught.value)


def test_poses_on_one_line_are_refused_rather_than_fitted(tmp_path):
    calibration = calibrated(tmp_path / 'rig.json', where=((0.0, 0.0), (200.0, 0.0), (400.0, 0.0)))
    with pytest.raises(ArmUnavailable) as caught:
        calibration.point(200.0, 100.0)
    assert 'span' in str(caught.value)


def test_a_missing_file_is_an_empty_calibration_that_refuses(tmp_path):
    where = tmp_path / 'rig.json'
    calibration = Calibration.load(where)
    assert calibration.rect() is None
    with pytest.raises(ArmUnavailable):
        calibration.point(100.0, 100.0)
    assert not where.exists()        # loading alone never invents a file


def test_an_unreadable_file_reads_as_empty_rather_than_raising(tmp_path):
    where = tmp_path / 'rig.json'
    where.write_text('{ this is not json', encoding='utf-8')
    calibration = Calibration.load(where)
    assert calibration.rect() is None
    with pytest.raises(ArmUnavailable):
        calibration.point(0.0, 0.0)


def test_save_keeps_the_keys_it_does_not_own(tmp_path):
    where = tmp_path / 'rig.json'
    where.write_text(
        json.dumps({'deskId': 'heli-1a2b3c4d', 'deskToken': 'desk-token-123', 'camera': {'index': 1}}),
        encoding='utf-8',
    )
    calibration = calibrated(where)
    calibration.set_rect({'x': -300.0, 'y': 0.0, 'w': 600.0, 'h': 400.0})
    calibration.save()

    stored = json.loads(where.read_text(encoding='utf-8'))
    assert stored['deskId'] == 'heli-1a2b3c4d'
    assert stored['deskToken'] == 'desk-token-123'
    assert stored['camera'] == {'index': 1}

    reloaded = Calibration.load(where)
    assert reloaded.rect() == {'x': -300.0, 'y': 0.0, 'w': 600.0, 'h': 400.0}
    assert reloaded.point(220.0, 140.0) == pytest.approx(look(220.0, 140.0), abs=1e-6)


def test_a_rect_that_is_not_a_rectangle_is_refused(tmp_path):
    calibration = Calibration(tmp_path / 'rig.json')
    with pytest.raises(ValueError):
        calibration.set_rect({'x': 0.0, 'y': 0.0, 'w': 600.0})
