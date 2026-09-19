"""The rig's own person detector: YOLO11n-pose straight through `cv2.dnn`, with no torch.

`tracking.visiond` runs these same weights under ultralytics in its own virtualenv; the rig cannot
afford a second venv or a torch install for one model, so the export is loaded as ONNX and decoded
here. The measured agreement is what made that acceptable (zidane.jpg: 0.894 against ultralytics'
0.89, left shoulder (631.5, 426.7) against (630.9, 426.7)).

Everything a caller sees is in frame pixels: the model looks at a letterboxed square, and the
decode maps both boxes and keypoints back through the same scale and pad, so the letterbox is
invisible from the outside.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

# COCO keypoint indices: the shoulders and the hips. They are the body parts the camera can aim at,
# and they are also the test for "this is a person": a box with none of them is a blob.
CHEST_KEYPOINTS = (5, 6, 11, 12)
# A keypoint below this is not a body part, it is noise. Deliberately looser than the 0.30
# `tracking.visiond` uses: that rig refuses to lock onto anything less certain, this one only needs
# a direction to point.
CHEST_KCONF = 0.2
# The export's layout: 4 box columns (cx, cy, w, h), 1 class score (person), then 17 keypoints of
# (x, y, conf). Everything here assumes one class, which is what this model is.
CLASS_COLUMN = 4
N_KEYPOINTS = 17
# Ultralytics letterboxes with 114 grey; the same value has to come back out as it goes in.
PAD_VALUE = 114


@dataclass(frozen=True)
class Detection:
    """One person in one frame, box and keypoints already in the frame's own pixels."""

    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2
    conf: float
    keypoints: np.ndarray  # (17, 3) x, y, conf

    def chest(self) -> tuple[float, float, float] | None:
        """The aim point: the mean of the visible shoulders and hips, and their mean confidence.

        The mean is over whichever of the four the model could see, so a person sitting behind a
        table still yields a chest from their shoulders. `None` when none of them is visible — a
        detection without a chest is not something to aim at, and the caller must not pretend the
        box centre is a body.
        """
        visible = [i for i in CHEST_KEYPOINTS if float(self.keypoints[i, 2]) > CHEST_KCONF]
        if not visible:
            return None
        points = self.keypoints[visible]
        return (float(points[:, 0].mean()), float(points[:, 1].mean()),
                float(points[:, 2].mean()))


class PoseDetector:
    """YOLO11n-pose over `cv2.dnn`: one BGR frame in, the people in it out, on this CPU."""

    def __init__(self, model_path: Path, log: logging.Logger, *, conf: float = 0.25,
                 iou: float = 0.45, imgsz: int = 640) -> None:
        # The doctor and the rig both need to name the file, not a cv2 stack trace: a missing
        # export is a setup mistake, and this message is the setup instruction.
        if not model_path.is_file():
            raise FileNotFoundError(
                f"pose model not found: {model_path} (the rig reads a yolo11n-pose ONNX export "
                "of the same imgsz it was traced with; see apps/edge/models/)")
        self.log = log
        self.conf = conf
        self.iou = iou
        self.imgsz = imgsz
        self.net = cv2.dnn.readNetFromONNX(str(model_path))
        # This Mac has no GPU OpenCV can use, and the new graph engine refuses the target setting
        # with a warning that is safe to ignore: the net runs on the CPU either way.
        self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        log.info("model %s loaded", model_path.name)

    def detect(self, frame: np.ndarray) -> list[Detection]:
        """Every person in a BGR frame, boxes and keypoints in that frame's pixels."""
        padded, scale, pad = _letterbox(frame, self.imgsz)
        # swapRB because the frame is BGR and the model was trained on RGB; no mean subtraction,
        # ultralytics normalises with a plain 1/255.
        blob = cv2.dnn.blobFromImage(padded, 1 / 255.0, (self.imgsz, self.imgsz),
                                     swapRB=True, crop=False)
        self.net.setInput(blob)
        out = self.net.forward()
        columns = CLASS_COLUMN + 1 + N_KEYPOINTS * 3
        if out.ndim != 3 or out.shape[0] != 1 or out.shape[1] != columns:
            raise RuntimeError(
                f"pose model output {out.shape} is not (1, {columns}, anchors): export "
                "yolo11n-pose with its pose head and imgsz 640")
        rows = out[0].T  # anchors as rows, so each row is one candidate
        scores = rows[:, CLASS_COLUMN]
        keep = np.flatnonzero(scores > self.conf)
        if keep.size == 0:
            return []
        rows, scores = rows[keep], scores[keep]
        centres = rows[:, :CLASS_COLUMN]
        boxes = np.empty_like(centres)
        boxes[:, 0] = centres[:, 0] - centres[:, 2] / 2.0  # x1
        boxes[:, 1] = centres[:, 1] - centres[:, 3] / 2.0  # y1
        boxes[:, 2] = centres[:, 0] + centres[:, 2] / 2.0  # x2
        boxes[:, 3] = centres[:, 1] + centres[:, 3] / 2.0  # y2
        # One person scores on many anchors; NMSBoxes wants (x, y, w, h), so w and h come back
        # from the corners, and it returns the indices of the ones left.
        xywh = boxes.copy()
        xywh[:, 2:4] -= xywh[:, 0:2]
        picked = np.asarray(
            cv2.dnn.NMSBoxes(xywh, scores, self.conf, self.iou)).reshape(-1)
        keys = rows[picked, CLASS_COLUMN + 1:].reshape(-1, N_KEYPOINTS, 3)
        keys[:, :, 0] = (keys[:, :, 0] - pad[0]) / scale
        keys[:, :, 1] = (keys[:, :, 1] - pad[1]) / scale
        height, width = frame.shape[:2]
        keys[:, :, 0] = np.clip(keys[:, :, 0], 0.0, width - 1.0)
        keys[:, :, 1] = np.clip(keys[:, :, 1], 0.0, height - 1.0)
        detections = []
        for i, index in enumerate(picked):
            x1, y1, x2, y2 = boxes[index]
            detections.append(Detection(
                bbox=(float((x1 - pad[0]) / scale), float((y1 - pad[1]) / scale),
                      float((x2 - pad[0]) / scale), float((y2 - pad[1]) / scale)),
                conf=float(scores[index]),
                keypoints=keys[i],
            ))
        return detections


def _letterbox(frame: np.ndarray, imgsz: int) -> tuple[np.ndarray, float, tuple[float, float]]:
    """Ultralytics' letterbox: scale to fit, then pad the short side with 114 grey.

    A plain resize to square stretches a 4:3 frame, and the model stops recognising the person in
    it (measured: the top confidence fell to 0.14 against 0.894 with this padding). The pad is
    split as ultralytics splits it — the extra pixel of an odd remainder goes to the right/bottom —
    because the decode has to undo exactly this shift.
    """
    height, width = frame.shape[:2]
    scale = min(imgsz / width, imgsz / height)
    new = (int(round(width * scale)), int(round(height * scale)))
    if new != (width, height):
        frame = cv2.resize(frame, new, interpolation=cv2.INTER_LINEAR)
    dw, dh = (imgsz - new[0]) / 2.0, (imgsz - new[1]) / 2.0
    top, bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
    left, right = int(round(dw - 0.1)), int(round(dw + 0.1))
    padded = cv2.copyMakeBorder(frame, top, bottom, left, right, cv2.BORDER_CONSTANT,
                                value=(PAD_VALUE, PAD_VALUE, PAD_VALUE))
    return padded, scale, (float(left), float(top))
