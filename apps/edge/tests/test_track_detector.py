"""The detector against the real ONNX export and a real photograph: the numbers the rig aims by.

The person image is not part of this repo, so the tests that need one download it into `tmp_path`
and skip when there is no network; the frames the rig actually gets are covered offline, by a
gradient that must not raise and must not find anybody.
"""

from __future__ import annotations

import logging
import urllib.request
from pathlib import Path

import cv2
import numpy as np
import pytest

from heli_rig.track.detector import Detection, PoseDetector

MODEL = Path(__file__).resolve().parents[1] / "models" / "yolo11n-pose.onnx"
ZIDANE_URL = "https://raw.githubusercontent.com/ultralytics/assets/main/im/zidane.jpg"
FRAME = (640, 480)


@pytest.fixture(scope="module")
def detector() -> PoseDetector:
    """The real model: the whole point of this module is that the export is the model."""
    return PoseDetector(MODEL, logging.getLogger("test.track.detector"))


@pytest.fixture(scope="module")
def zidane(tmp_path_factory) -> np.ndarray:
    """The reference photograph (two people), downloaded once per run."""
    path = tmp_path_factory.mktemp("person") / "zidane.jpg"
    try:
        with urllib.request.urlopen(ZIDANE_URL, timeout=20) as response:
            path.write_bytes(response.read())
    except Exception as exc:  # no network, no DNS, a blocked host: the offline tests still run
        pytest.skip(f"could not download the person image: {exc!r}")
    frame = cv2.imread(str(path))
    if frame is None:
        pytest.skip("the downloaded image did not decode")
    return frame


def test_the_reference_photograph_holds_two_people(detector, zidane):
    detections = detector.detect(zidane)
    assert len(detections) == 2
    # Ultralytics scores these two at 0.89 and 0.841 on the same picture; the ONNX path has to
    # land in the same place or the port is not the port.
    assert [d.conf for d in detections] == pytest.approx([0.894, 0.847], abs=0.02)
    for det in detections:
        assert 0.8 < det.conf <= 1.0
        x1, y1, x2, y2 = det.bbox
        assert 0.0 <= x1 < x2 <= zidane.shape[1]
        assert 0.0 <= y1 < y2 <= zidane.shape[0]


def test_the_chest_is_inside_the_box_it_belongs_to(detector, zidane):
    best = max(detector.detect(zidane), key=lambda d: d.conf)
    assert best.conf > 0.8
    chest = best.chest()
    assert chest is not None
    x1, y1, x2, y2 = best.bbox
    assert x1 <= chest[0] <= x2, f"chest {chest} is outside the box {best.bbox}"
    assert y1 <= chest[1] <= y2
    assert chest[2] > 0.5, "the chest of a person this clear comes from a strong keypoint"


def test_keypoints_come_back_in_frame_pixels_and_clipped(detector, zidane):
    height, width = zidane.shape[:2]
    for det in detector.detect(zidane):
        assert det.keypoints.shape == (17, 3)
        xs, ys = det.keypoints[:, 0], det.keypoints[:, 1]
        assert 0.0 <= float(xs.min()) and float(xs.max()) <= width - 1
        assert 0.0 <= float(ys.min()) and float(ys.max()) <= height - 1


def test_the_letterbox_pad_is_undone_not_absorbed_into_the_coordinates(detector, zidane):
    """The same body on a taller canvas has to come back at the same frame pixels.

    The frame letterboxes to a square, so the top pad shrinks from 140 to 60 letterbox pixels
    (scale 0.5) when a band is added below the picture. A decode that forgot to subtract the pad
    would report the body 160 frame pixels lower; the model itself moves the chest only a few
    pixels, because a black band does not change what a person is.
    """
    height, width = zidane.shape[:2]
    taller = np.zeros((height + 320, width, 3), np.uint8)
    taller[:height] = zidane
    on_frame = max(detector.detect(zidane), key=lambda d: d.conf).chest()
    on_canvas = max(detector.detect(taller), key=lambda d: d.conf).chest()
    assert abs(on_canvas[0] - on_frame[0]) < 30.0, f"{on_frame} against {on_canvas}"
    assert abs(on_canvas[1] - on_frame[1]) < 30.0, f"{on_frame} against {on_canvas}"


def test_a_gradient_is_not_a_person(detector):
    """The offline path: the rig asks about frames it cannot download, and gets an answer."""
    gradient = np.tile(np.arange(FRAME[0], dtype=np.uint8), (FRAME[1], 1))[:, :, None]
    gradient = gradient.repeat(3, axis=2)
    assert gradient.shape == (FRAME[1], FRAME[0], 3)
    detections = detector.detect(gradient)
    assert isinstance(detections, list)
    assert detections == []


def test_a_missing_model_names_the_file(tmp_path):
    missing = tmp_path / "not-exported.onnx"
    with pytest.raises(FileNotFoundError) as raised:
        PoseDetector(missing, logging.getLogger("test.track.detector"))
    assert str(missing) in str(raised.value)


def test_the_chest_is_the_mean_of_the_visible_shoulders_and_hips():
    """The aim point rule, on keypoints a camera would see: which of the four count, and why."""
    keypoints = np.zeros((17, 3), np.float32)
    keypoints[5] = (100.0, 200.0, 0.9)   # left shoulder, seen
    keypoints[6] = (140.0, 200.0, 0.7)   # right shoulder, seen
    keypoints[11] = (999.0, 999.0, 0.05)  # left hip, below the visibility floor
    keypoints[12] = (998.0, 998.0, 0.0)   # right hip, not seen at all
    det = Detection(bbox=(0.0, 0.0, 200.0, 400.0), conf=0.9, keypoints=keypoints)
    assert det.chest() == pytest.approx((120.0, 200.0, 0.8))
    # Only the hips visible is still a chest: a person behind a desk is worth pointing at.
    keypoints[5] = keypoints[6] = (0.0, 0.0, 0.0)
    keypoints[11] = (60.0, 300.0, 0.6)
    keypoints[12] = (80.0, 300.0, 0.8)
    assert det.chest() == pytest.approx((70.0, 300.0, 0.7))
    # None of the four: no aim point, and the caller has to know that.
    assert Detection(bbox=(0.0, 0.0, 1.0, 1.0), conf=0.9,
                     keypoints=np.zeros((17, 3), np.float32)).chest() is None
