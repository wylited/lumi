"""What the rig was told: the environment first, the flags second, one frozen Config.

Everything a person sets per machine lives in the environment (see
`.env.example`); the handful of things they change per run are flags. Both end
up in one immutable `Config`, so no other module has to look at `os.environ` —
or at `sys.argv` — ever again.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Mapping, Sequence
from urllib.parse import urlsplit, urlunsplit

API_URL_DEFAULT = "http://localhost:3001"
#: The pose model the rig tracks people with: YOLO11n-pose as ONNX, run by
#: `cv2.dnn`. In the tree rather than downloaded, because a rig on a desk with no
#: network still has to see the person sitting at it.
MODEL_PATH_DEFAULT = "models/yolo11n-pose.onnx"
#: The tracker's own cadence, and the share of the frame its aim point may be off
#: by before the arm is asked to move. The deadband is what keeps a person who is
#: sitting still from being chased by a camera: without it the arm twitches at
#: every keypoint jitter.
TRACK_FPS_DEFAULT = 10.0
TRACK_DEADBAND_DEFAULT = 0.08
CONSOLE_URL_DEFAULT = "http://127.0.0.1:8643"
HELI_DIR_DEFAULT = "~/.heli"
# Where the arm bridge lives: a project of its own, with a `tracking.bridge` module
# and an interpreter that has lerobot. It is not this repo and it is not installed
# with the rig, so its location is a setting rather than a constant - the previous
# hardcoded path only existed on the machine the rig was written on, and every
# other machine silently got "no arm".
BRIDGE_DIR_DEFAULT = "~/Repos/tracking"
DESK_NAME_DEFAULT = "Desk 1"
FPS_DEFAULT = 2.0
MAX_EDGE_PX_DEFAULT = 1600
JPEG_QUALITY_DEFAULT = 80
CAMERA_INDEX_DEFAULT = 0

# `packages/contracts/src/desk.ts` owns the socket path the server listens on.
DESK_SOCKET_PATH = "/ws/desk"
CAMERA_SOURCES = ("auto", "console", "opencv")
# `serial` is `heli_rig.arm`'s second driver: the tracking bridge, which it only
# opens when the console is not running, so there is still one writer on the bus.
ARM_DRIVERS = ("auto", "console", "serial", "none")
#: Who holds the arm while the rig follows a person. `off` is the observer's rig:
#: it aims when it is told to and does not move on its own.
TRACKING_MODES = ("off", "auto")
LOG_LEVELS = ("debug", "info", "warning", "error", "critical")


class ConfigError(ValueError):
    """A setting the rig cannot make sense of. The message names the variable."""


@dataclass(frozen=True)
class Config:
    """One rig run's settings. Frozen: nothing downstream may rewrite the world."""

    api_url: str
    ws_url: str
    desk_token: str | None
    console_url: str
    camera_source: str
    camera_index: int
    fps: float
    max_edge_px: int
    jpeg_quality: int
    desk_name: str
    arm_driver: str
    #: The arm bridge: the project that owns the serial bus, and the interpreter that runs it.
    bridge_dir: Path
    bridge_python: str
    speaker: bool
    log_level: str
    heli_dir: Path
    once: bool
    calibrate: bool
    doctor: bool
    #: The desk rectangle in millimetres (`x,y,w,h`) that `--calibrate` records.
    rect: str | None
    #: The pose model, resolved against the package's own directory by `model_path`.
    model: Path
    #: `off` | `auto`: whether the rig follows a person on its own.
    tracking: str
    #: The cadence the tracker runs at, which is not the upload cadence: detection
    #: is ~25 fps on CPU, and 10 is enough to keep a person centred.
    track_fps: float
    #: The share of the frame the chest may sit off-centre before the arm moves.
    track_deadband: float


def model_path(cfg: Config) -> Path:
    """The pose model, resolved against the rig's own directory when it is relative.

    `models/yolo11n-pose.onnx` is where the file lives in the tree, and a rig run
    from anywhere else (`uv run heli-rig` from the repo root, a launchd job with
    another cwd) still has to find it, so a relative setting is resolved against
    the package rather than the process's working directory. An absolute setting
    is taken as given, because that is what a person who typed a path meant.
    """
    if cfg.model.is_absolute():
        return cfg.model
    return Path(__file__).resolve().parent.parent / cfg.model


def websocket_url(api_url: str) -> str:
    """The desk socket for an API URL: http is a ws socket, https is a wss one.

    Exported because every part of the rig that opens the socket needs the same
    derivation, and there is only one right answer for a given API URL.
    """
    parts = urlsplit(api_url)
    scheme = {"http": "ws", "https": "wss"}.get(parts.scheme.lower())
    if scheme is None or not parts.netloc:
        raise ConfigError(f"the API URL must be http(s), not {api_url!r}")
    # The HTTP callers append their path to the base, so a deployment behind a
    # prefix (`https://host/lumi`) would post frames to `/lumi/v1/desk/frames`
    # and open its socket at `/ws/desk` - a path that does not exist behind that
    # proxy. Same prefix, same rule for both.
    prefix = parts.path.rstrip("/")
    return urlunsplit((scheme, parts.netloc, f"{prefix}{DESK_SOCKET_PATH}", "", ""))


def load(env: Mapping[str, str] | None = None, argv: Sequence[str] | None = None) -> Config:
    """Read one Config: the defaults, then the environment, then the flags.

    `env` is read exactly as given — never merged with `os.environ` — so a test
    or a launcher can be certain what the rig saw. `argv=None` means
    `sys.argv[1:]`, which is why a test passes `argv=[]`.
    """
    source = os.environ if env is None else env
    api_url = _text(source, "HELI_API_URL", API_URL_DEFAULT).rstrip("/")
    bridge_dir = Path(_text(source, "HELI_BRIDGE_DIR", BRIDGE_DIR_DEFAULT)).expanduser()
    cfg = Config(
        api_url=api_url,
        ws_url=websocket_url(api_url),
        desk_token=_optional(source, "HELI_DESK_TOKEN"),
        console_url=_text(source, "HELI_CONSOLE_URL", CONSOLE_URL_DEFAULT).rstrip("/"),
        camera_source=_choice(source, "HELI_CAMERA_SOURCE", "auto", CAMERA_SOURCES),
        camera_index=_number(source, "HELI_CAMERA_INDEX", CAMERA_INDEX_DEFAULT, int),
        fps=_number(source, "HELI_FPS", FPS_DEFAULT, float),
        max_edge_px=_number(source, "HELI_MAX_EDGE_PX", MAX_EDGE_PX_DEFAULT, int),
        jpeg_quality=_number(source, "HELI_JPEG_QUALITY", JPEG_QUALITY_DEFAULT, int),
        desk_name=_text(source, "HELI_DESK_NAME", DESK_NAME_DEFAULT),
        arm_driver=_choice(source, "HELI_ARM_DRIVER", "auto", ARM_DRIVERS),
        bridge_dir=bridge_dir,
        bridge_python=str(
            Path(_text(source, "HELI_BRIDGE_PYTHON", str(bridge_dir / ".venv" / "bin" / "python"))).expanduser()
        ),
        speaker=_flag(source, "HELI_SPEAKER", True),
        log_level=_choice(source, "HELI_LOG_LEVEL", "info", LOG_LEVELS),
        heli_dir=Path(_text(source, "HELI_DIR", HELI_DIR_DEFAULT)).expanduser(),
        once=False,
        calibrate=False,
        doctor=False,
        rect=_optional(source, "HELI_DESK_RECT"),
        model=Path(_text(source, "HELI_MODEL", MODEL_PATH_DEFAULT)).expanduser(),
        tracking=_choice(source, "HELI_TRACKING", "off", TRACKING_MODES),
        track_fps=_number(source, "HELI_TRACK_FPS", TRACK_FPS_DEFAULT, float),
        track_deadband=_number(source, "HELI_TRACK_DEADBAND", TRACK_DEADBAND_DEFAULT, float),
    )
    checked = _apply_argv(cfg, list(sys.argv[1:] if argv is None else argv))
    _check(checked)
    return checked


def _apply_argv(cfg: Config, argv: list[str]) -> Config:
    """The flags a person changes per run. Everything else is the environment."""
    parser = argparse.ArgumentParser(
        prog="heli-rig",
        description="The desk rig: frames up, actions and speech down.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="take one frame, upload it, print the outcome as one JSON line and exit",
    )
    parser.add_argument(
        "--calibrate",
        action="store_true",
        help="record the desk plane: five prompts, five arm poses, one file, then exit",
    )
    parser.add_argument(
        "--doctor",
        action="store_true",
        help="check what this machine has (server, camera, arm, calibration, speaker) and exit",
    )
    parser.add_argument("--bridge-dir", metavar="DIR", help="the arm bridge project (or HELI_BRIDGE_DIR)")
    parser.add_argument("--bridge-python", metavar="PATH", help="its interpreter (or HELI_BRIDGE_PYTHON)")
    parser.add_argument(
        "--rect",
        metavar="X,Y,W,H",
        help="the desk rectangle in millimetres that --calibrate records (or HELI_DESK_RECT)",
    )
    parser.add_argument("--camera-index", type=int, help="the AVFoundation device index to open")
    parser.add_argument("--console", metavar="URL", help="the tracking console that holds the camera")
    parser.add_argument("--fps", type=float, help="frames per second while a session is live")
    parser.add_argument(
        "--log-level",
        type=str.lower,
        metavar="LEVEL",
        help="debug | info | warning | error | critical",
    )
    parser.add_argument("--api-url", metavar="URL", help="the server")
    parser.add_argument(
        "--tracking",
        choices=TRACKING_MODES,
        help="off | auto: follow the person at the desk (or HELI_TRACKING)",
    )
    parser.add_argument("--model", metavar="PATH", help="the pose model (or HELI_MODEL)")
    args = parser.parse_args(argv)
    if args.log_level is not None and args.log_level not in LOG_LEVELS:
        parser.error(f"argument --log-level: must be one of {', '.join(LOG_LEVELS)}")

    changes: dict[str, object] = {}
    if args.once:
        changes["once"] = True
    if args.calibrate:
        changes["calibrate"] = True
    if args.doctor:
        changes["doctor"] = True
    if args.bridge_dir:
        changes["bridge_dir"] = Path(args.bridge_dir).expanduser()
    if args.bridge_python:
        changes["bridge_python"] = str(Path(args.bridge_python).expanduser())
    if args.rect:
        changes["rect"] = args.rect
    if args.camera_index is not None:
        changes["camera_index"] = args.camera_index
    if args.console:
        changes["console_url"] = args.console.rstrip("/")
    if args.fps is not None:
        changes["fps"] = args.fps
    if args.log_level is not None:
        changes["log_level"] = args.log_level
    if args.tracking:
        changes["tracking"] = args.tracking
    if args.model:
        changes["model"] = Path(args.model).expanduser()
    if args.api_url:
        api_url = args.api_url.rstrip("/")
        changes["api_url"] = api_url
        # Derived, never given: a URL that runs the API over ws would be a bug.
        changes["ws_url"] = websocket_url(api_url)
    return replace(cfg, **changes)


def _check(cfg: Config) -> None:
    """Refuse a setting that would only fail later, in a place that cannot explain it."""
    # Finite as well as positive: `HELI_FPS=inf` (or `1e400`, which `float()` reads
    # as inf) makes the loop's `1.0 / fps` a `sleep(0)`, and config is the only
    # place that can refuse it with a sentence instead of a pinned core.
    if not math.isfinite(cfg.fps) or cfg.fps <= 0:
        raise ConfigError(f"fps must be a finite number greater than zero, not {cfg.fps!r}")
    if cfg.max_edge_px < 1:
        raise ConfigError(f"max_edge_px must be at least 1 px, not {cfg.max_edge_px!r}")
    if not 1 <= cfg.jpeg_quality <= 100:
        raise ConfigError(f"jpeg_quality must be 1..100, not {cfg.jpeg_quality!r}")
    if cfg.camera_index < 0:
        raise ConfigError(f"camera_index cannot be negative ({cfg.camera_index})")
    if not math.isfinite(cfg.track_fps) or cfg.track_fps <= 0:
        raise ConfigError(f"track_fps must be a finite number greater than zero, not {cfg.track_fps!r}")
    if not 0 <= cfg.track_deadband < 0.5:
        # Half the frame is the whole frame: a deadband that wide means the tracker
        # never moves, which is a setting that silently disables a feature.
        raise ConfigError(f"track_deadband must be in [0, 0.5), not {cfg.track_deadband!r}")


def _text(env: Mapping[str, str], key: str, default: str) -> str:
    # An empty string is how a shell says nothing at all, so it means the default.
    value = str(env.get(key, "")).strip()
    return value or default


def _optional(env: Mapping[str, str], key: str) -> str | None:
    value = str(env.get(key, "")).strip()
    return value or None


def _number(env: Mapping[str, str], key: str, default: float | int, cast: Callable[[str], float | int]) -> float | int:
    raw = str(env.get(key, "")).strip()
    if not raw:
        return cast(default)
    try:
        return cast(raw)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{key} is not a number: {raw!r}") from exc


def _choice(env: Mapping[str, str], key: str, default: str, allowed: Sequence[str]) -> str:
    value = _text(env, key, default).lower()
    if value not in allowed:
        raise ConfigError(f"{key} must be one of {' | '.join(allowed)}, not {value!r}")
    return value


def _flag(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = str(env.get(key, "")).strip().lower()
    if not raw:
        return default
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"{key} is a yes/no flag, not {raw!r}")
