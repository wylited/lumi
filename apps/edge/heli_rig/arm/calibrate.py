"""Recording the desk plane: the rectangle the rig watches, and the poses that frame it.

`arm.point(x, y)` is a least-squares fit over measured pairs, and no amount of looking at the
camera invents those pairs: the arm has to be holding a pose, and a person has to say which point
on the desk the camera is looking at. This is that recording, and it is the rig's half of the
desktop's "aim here" step -- the app drags a rectangle over the desk and posts `arm.point` at its
centre, and that call can only land if the plane was measured first.

Five samples, the corners and the centre. Two parameters per axis, so five pairs leave the fit
something to outvote: one bad corner moves the answer a little rather than off the desk.
"""

from __future__ import annotations

import logging
import sys
from typing import Callable, Sequence

from .calibration import Calibration, MIN_POSES
from .driver import ArmDriver, ArmError

#: The sample points, as labels, in the order a person walks them.
SAMPLE_LABELS = ("top left", "top right", "bottom left", "bottom right")

PROMPT = "    {label} ({x:.0f}, {y:.0f}) mm: aim the camera there, then Enter (s skips, q stops) "


def sample_points(rect: dict[str, float]) -> list[tuple[float, float, str]]:
    """The rectangle's four corners and its centre, in millimetres."""
    x, y, w, h = (float(rect[key]) for key in ("x", "y", "w", "h"))
    corners = ((x, y), (x + w, y), (x, y + h), (x + w, y + h))
    return [(px, py, label) for (px, py), label in zip(corners, SAMPLE_LABELS)] + [
        (x + w / 2, y + h / 2, "the centre")
    ]


def parse_rect(raw: str) -> dict[str, float]:
    """`x,y,w,h` in millimetres, the way the flag and the environment carry it."""
    parts = [piece.strip() for piece in raw.replace(" ", ",").split(",") if piece.strip()]
    if len(parts) != 4:
        raise ValueError(f"a rectangle is x,y,w,h -- four numbers, not {raw!r}")
    try:
        x, y, w, h = (float(piece) for piece in parts)
    except ValueError as exc:
        raise ValueError(f"a rectangle is x,y,w,h in millimetres, not {raw!r}") from exc
    if w <= 0 or h <= 0:
        raise ValueError(f"a rectangle needs a positive width and height, not {raw!r}")
    return {"x": x, "y": y, "w": w, "h": h}


def _say(text: str = "") -> None:
    """Stdout, flushed. This mode is reached through pipes as often as through a terminal."""
    print(text, flush=True)


class Calibrator:
    """One prompt, one pose, one pair. The arm is aimed by whoever is at the desk.

    The reading is `arm.pose()`, so what is recorded is where the arm *is*, not where someone
    meant to put it -- the same rule as an action's ack.
    """

    def __init__(
        self,
        arm: ArmDriver,
        calibration: Calibration,
        *,
        log: logging.Logger,
        ask: Callable[[], str] = input,
        say: Callable[[str], None] = _say,
    ) -> None:
        self._arm = arm
        self._calibration = calibration
        self._log = log
        self._ask = ask
        self._say = say
        self._recorded: list[dict[str, float]] = []

    def run(self, rect: dict[str, float], points: Sequence[tuple[float, float, str]] | None = None) -> int:
        """Record the pairs, then write the file. Returns how many this run recorded."""
        self._calibration.set_rect(rect)
        self._say(
            f"  four corners and the centre of {rect['w']:.0f}x{rect['h']:.0f} mm at "
            f"({rect['x']:.0f}, {rect['y']:.0f})"
        )
        for x_mm, y_mm, label in sample_points(rect) if points is None else points:
            answer = self._prompt(label, x_mm, y_mm)
            if answer == "q":
                self._log.info("calibration: stopping at %s", label)
                break
            if answer == "s":
                self._log.info("calibration: skipped %s", label)
                continue
            if not self._read(label, x_mm, y_mm):
                break
        self._calibration.save()
        total = len(self._calibration.poses)
        if total < MIN_POSES:
            self._log.error(
                "calibration: %d pose(s) stored, and `arm.point` needs %d spanning the desk plane",
                total,
                MIN_POSES,
            )
        else:
            self._log.info("calibration: %d pose(s) stored in %s", total, self._calibration.path)
        return len(self._recorded)

    @staticmethod
    def _write(text: str) -> None:
        """The question, on the screen before the answer is waited for.

        `input(prompt)` looks like the obvious way to do this, and it is not: its prompt ends with
        no newline, so a line-buffered stdout holds it in the buffer while whoever is at the desk
        waits for the question to appear. Written and flushed here, it appears.
        """
        sys.stdout.write(text)
        sys.stdout.flush()

    def _prompt(self, label: str, x_mm: float, y_mm: float) -> str:
        self._write(PROMPT.format(label=label, x=x_mm, y=y_mm))
        try:
            return self._ask().strip().lower()
        except EOFError:
            # No terminal behind the run: treat it as a stop rather than a traceback.
            self._say("")
            self._log.info("calibration: no more input, stopping")
            return "q"

    def _read(self, label: str, x_mm: float, y_mm: float) -> bool:
        try:
            pose = self._arm.pose()
        except ArmError as exc:
            self._log.error("calibration: the arm did not answer: %s", exc)
            return False
        self._calibration.add_pose(x_mm, y_mm, pose.pan, pose.tilt)
        self._recorded.append({"label": label, "x_mm": x_mm, "y_mm": y_mm, "pan": pose.pan, "tilt": pose.tilt})
        self._say(f"      recorded pan={pose.pan:.2f} tilt={pose.tilt:.2f}")
        return True
