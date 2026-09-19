"""Where the desk is, and which arm pose puts the camera on a point of it.

`~/.heli/rig.json` holds this and the desk's own identity: the registration side stores `deskId`
and `deskToken` in the same file, so every write here is a read-modify-write and the file is
replaced atomically. Losing a desk token to a calibration save would cost a re-registration.

Two or three measured poses are enough. Over the area of a desk, pan and tilt are affine in the
desk plane, so `point()` is a least-squares fit and needs no camera model and no new maths.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .driver import ArmUnavailable

RIG_FILE = 'rig.json'
CALIBRATION_KEY = 'calibration'
RECT_KEYS = ('x', 'y', 'w', 'h')
POSE_KEYS = ('x_mm', 'y_mm', 'pan', 'tilt')
MIN_POSES = 3

_LOG = logging.getLogger(__name__)


@dataclass
class Calibration:
    """The rectangle being watched and the poses that frame it. `path` is the file it came from
    and the one :meth:`save` writes back, keys it does not own left alone."""

    path: Path
    rect_mm: dict[str, float] | None = None
    poses: list[dict[str, float]] = field(default_factory=list)

    @classmethod
    def load(cls, path: str | Path) -> 'Calibration':
        """The calibration in that file - empty when the rig has never been calibrated, and empty
        rather than raising when the file is unreadable: a broken file must not stop the agent."""
        stored = _read(path).get(CALIBRATION_KEY)
        stored = stored if isinstance(stored, dict) else {}
        rect = stored.get('rect_mm')
        poses = [
            pose
            for pose in (stored.get('poses') or [])
            if isinstance(pose, dict) and all(key in pose for key in POSE_KEYS)
        ]
        return cls(Path(path), dict(rect) if isinstance(rect, dict) else None, poses)

    def save(self) -> None:
        """Write the file back, keeping every other key in it."""
        data = _read(self.path)
        data[CALIBRATION_KEY] = {
            'rect_mm': self.rect_mm,
            'poses': self.poses,
            'updatedAt': _now(),
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # A reader (or a crash) must never see half a file, so the whole object lands at once, and
        # the temp name is unique because two rig processes can share one home directory.
        scratch = self.path.with_name(f'{self.path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp')
        scratch.write_text(json.dumps(data, indent=2, sort_keys=True) + '\n', encoding='utf-8')
        # The desk token lives in this file; a calibration save must not widen who can read it.
        os.chmod(scratch, 0o600)
        os.replace(scratch, self.path)

    def set_rect(self, rect_mm: dict[str, float]) -> None:
        """The rectangle on the desk the rig watches, in millimetres from the desk's own origin."""
        missing = [key for key in RECT_KEYS if not isinstance(rect_mm, dict) or key not in rect_mm]
        if missing:
            raise ValueError(f'rect_mm needs {RECT_KEYS}; it is missing {missing}')
        self.rect_mm = {key: float(rect_mm[key]) for key in RECT_KEYS}

    def rect(self) -> dict[str, float] | None:
        return dict(self.rect_mm) if self.rect_mm else None

    def add_pose(self, x_mm: float, y_mm: float, pan: float, tilt: float) -> None:
        """Record one measured pair: the arm was at (pan, tilt) looking at (x_mm, y_mm)."""
        self.poses.append(
            {'x_mm': float(x_mm), 'y_mm': float(y_mm), 'pan': float(pan), 'tilt': float(tilt)}
        )

    def point(self, x_mm: float, y_mm: float) -> tuple[float, float]:
        """The pan and tilt that put the camera on that desk point."""
        if len(self.poses) < MIN_POSES:
            raise ArmUnavailable('calibration needs three poses')
        try:
            design = np.array([[pose[key] for key in POSE_KEYS[:2]] + [1.0] for pose in self.poses], dtype=float)
            targets = np.array([[pose['pan'], pose['tilt']] for pose in self.poses], dtype=float)
            coefficients, *_ = np.linalg.lstsq(design, targets, rcond=None)
            pan, tilt = np.array([float(x_mm), float(y_mm), 1.0]) @ coefficients
        except (TypeError, ValueError) as exc:
            raise ArmUnavailable(f'the stored calibration is not readable: {exc}') from exc
        if np.linalg.matrix_rank(design) < MIN_POSES:
            # Poses on one line fit *something*, but not the desk plane; aiming through that
            # mapping would move the camera to the wrong place with nothing to show for it.
            raise ArmUnavailable('the stored calibration poses do not span the desk plane')
        return float(pan), float(tilt)


def _read(path: str | Path) -> dict:
    """Everything in the file, or an empty object: a rig that was never set up has no file, and one
    that has a corrupt file needs a log line rather than an exception on the way to a capture."""
    target = Path(path)
    try:
        data = json.loads(target.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}
    except OSError as exc:
        _LOG.warning('could not read %s (%s); the calibration is treated as empty', target, exc)
        return {}
    except ValueError as exc:
        _LOG.warning('%s is not JSON (%s); the calibration is treated as empty', target, exc)
        return {}
    return data if isinstance(data, dict) else {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
