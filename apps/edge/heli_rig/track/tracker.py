"""Which person the rig is following, and whether the lock is still good this frame.

`tracking.visiond` answers a bigger question — who everyone is, across long occlusions — with
ByteTrack. The rig needs one person: the body the camera is already pointing at, matched from frame
to frame by overlap, held through a moment of occlusion, and dropped when they are really gone. A
single box and a timestamp do that; a multi-object tracker would add identity this rig never uses.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .detector import Detection

Box = tuple[float, float, float, float]


@dataclass(frozen=True)
class Target:
    """The one body the rig follows, as the error the aim law steers by."""

    id: int | None  # the lock's id, None when nothing is locked
    valid: bool
    x: float  # normalized error from the aim point, -0.5..0.5, +x is right
    y: float  # ...+y is down
    conf: float


class TargetTracker:
    """One lock, held by overlap: the rig's replacement for ByteTrack, and all of it it needs.

    A lock exists only in the frames where it can be matched. That is deliberate: the aim law can
    only turn toward something that is in front of it, so a lock that is out of view has no error
    to report, and after `stale_s` it stops being the same lock at all.
    """

    def __init__(self, log: logging.Logger, *, aim: tuple[float, float] = (0.5, 0.5),
                 deadband: float = 0.05, stale_s: float = 0.3, iou_min: float = 0.3) -> None:
        self.log = log
        self.aim = (float(aim[0]), float(aim[1]))
        self.deadband = deadband
        self.stale_s = stale_s
        self.iou_min = iou_min
        self._id: int | None = None
        self._box: Box | None = None  # the lock's last seen box, None when no lock is held
        self._seen = 0.0              # the `now` of that last sighting
        self._minted = 0              # ids handed out so far

    def lock(self, target_id: int | None) -> None:
        """Hold onto ``target_id``; ``None`` goes back to following whoever is best in frame.

        Detections carry no identity of their own — there is no MOT here — so an id is a label
        this tracker mints when it locks, and the id it is already holding is a no-op. Any other
        id is adopted at the next update by binding it to the best detection that has a chest;
        that is the only way a label can become a person again. An id that never binds to anyone
        is not reported: `Target.id` is None while no person is held.
        """
        if target_id == self._id:
            return
        self._id = target_id
        self._box = None

    def update(self, detections: list[Detection], size: tuple[int, int], now: float) -> Target:
        """The lock after this frame: where the person is now, or that they are not in it.

        ``size`` is ``(width, height)``, the frame the detections came from. ``now`` is a monotonic
        clock in seconds, the same one on every call. ``x``/``y`` are the chest's offset from the
        aim point in frame widths and heights, positive right and down, zeroed inside the deadband
        — a person standing still must not make the rig hunt.
        """
        if self._box is not None:
            hit = self._matching(detections, self._box)
            if hit is not None:
                self._box = hit.bbox
                self._seen = now
                return self._as_target(hit, size)
            if now - self._seen < self.stale_s:
                # Missed for a moment: still the same person, but this frame has no error to
                # steer by, and the aim law must not be handed a stale one dressed as fresh.
                return Target(self._id, False, 0.0, 0.0, 0.0)
            # Gone long enough that whatever comes next is a fresh pick, not "them".
            self.log.info("target %s lost after %.2fs", self._id, now - self._seen)
            self._id = None
            self._box = None
        picked = self._best(detections)
        if picked is None:
            return Target(None, False, 0.0, 0.0, 0.0)
        if self._id is None:
            self._minted += 1
            self._id = self._minted
        self._box = picked.bbox
        self._seen = now
        self.log.info("locked target %s (conf %.2f)", self._id, picked.conf)
        return self._as_target(picked, size)

    def _matching(self, detections: list[Detection], box: Box) -> Detection | None:
        """The detection that overlaps the lock's last box most, when that is at least `iou_min`."""
        best = None
        best_iou = self.iou_min
        for det in detections:
            iou = _iou(box, det.bbox)
            if iou >= best_iou:
                best, best_iou = det, iou
        return best

    def _best(self, detections: list[Detection]) -> Detection | None:
        """The most confident detection that has a chest: a blob must not win the lock.

        A cardboard box scores well as a "person", and with no shoulders or hips its chest is
        None, so it can never be picked — that is the failed afternoon `tracking.visiond` learned
        this on, kept as the acquisition rule here.
        """
        best = None
        for det in detections:
            if det.chest() is None:
                continue
            if best is None or det.conf > best.conf:
                best = det
        return best

    def _as_target(self, det: Detection, size: tuple[int, int]) -> Target:
        """One matched person, as the error the aim law wants."""
        chest = det.chest()
        if chest is None:
            # The body is here, the chest is not: no aim point this frame, so no error. `conf`
            # still says the person is in front of the camera.
            return Target(self._id, False, 0.0, 0.0, det.conf)
        x = chest[0] / float(size[0]) - self.aim[0]
        y = chest[1] / float(size[1]) - self.aim[1]
        return Target(self._id, True, self._dead(x), self._dead(y), det.conf)

    def _dead(self, error: float) -> float:
        """Zero inside the deadband; the band is exclusive, so the edge comes through."""
        return 0.0 if abs(error) < self.deadband else error


def _iou(a: Box, b: Box) -> float:
    """Intersection over union of two (x1, y1, x2, y2) boxes; 0 when they do not touch."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0.0 else 0.0
