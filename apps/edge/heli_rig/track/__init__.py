"""Seeing the person the rig follows: the detector, and the small lock tracker behind the aim.

`PoseDetector` turns one BGR frame into bodies on `cv2.dnn` — the same YOLO11n-pose weights
`tracking.visiond` runs under ultralytics, without the torch that would come with it. `TargetTracker`
answers the only two questions the aim law asks: which person, and is the lock still good.
"""

from __future__ import annotations

from .detector import CHEST_KEYPOINTS, Detection, PoseDetector
from .tracker import Target, TargetTracker

__all__ = ['CHEST_KEYPOINTS', 'Detection', 'PoseDetector', 'Target', 'TargetTracker']
