"""The camera side of the rig: one JPEG at a time, from whichever process holds the device.

Two sources, one interface. `ConsoleSource` reads the frame the tracking console
already took — on this Mac the UVC device is held by `tracking.visiond`, and
opening it behind the console's back is a fight neither side wins.
`OpenCvSource` opens the device itself, for a bench where the console is not
running.
"""

from __future__ import annotations

import asyncio
import logging
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

import cv2
import httpx
import numpy as np

from .config import Config

# The server's ceiling, from `apps/server/src/services/frames.ts`: `MAX_FRAME_BYTES`.
MAX_JPEG_BYTES = 2 * 1024 * 1024
# The console writes one frame at 30 fps when it is healthy; a frame older than
# this means vision stopped, and a stale frame is worse than a missing one.
STALE_FRAME_MS = 5000
CONSOLE_TIMEOUT_S = 5.0
# AVFoundation hands back a few black or half-exposed frames before it settles.
WARMUP_FRAMES = 10
# The quality the encoder falls back to when the bytes are past the limit.
QUALITY_FLOOR = 30
QUALITY_STEP = 20

CONSOLE_STREAMS_PATH = "/api/streams"
CONSOLE_FRAME_PATH = "/api/frame.jpg"


@dataclass(frozen=True)
class Frame:
    """One JPEG the rig can upload: the bytes, the size they really are, and when."""

    jpeg: bytes
    width: int
    height: int
    captured_at: str  # ISO-8601 UTC, milliseconds, trailing 'Z'


class CameraUnavailable(RuntimeError):
    """There is no frame to be had right now — no device, no console, no fresh frame."""


class FrameSource(Protocol):
    """What the capture loop needs from a camera. Two implementations, one shape."""

    async def open(self) -> None: ...

    async def is_open(self) -> bool: ...

    def describe(self) -> dict | None: ...

    async def grab(self) -> Frame: ...

    async def close(self) -> None: ...


def encode_jpeg(bgr: np.ndarray, max_edge_px: int, quality: int) -> tuple[bytes, int, int]:
    """Downscale to the long edge and encode. Returns `(jpeg, width, height)`.

    The reduction is by an integer factor because that is a resize the rig can
    do without inventing pixels the sensor never delivered, and `INTER_AREA` is
    the filter for a reduction. A frame already inside the limit is encoded as
    it stands.

    `max_edge_px` is a pixel count, so it is positive: `Config` refuses anything
    else before a frame is ever taken.
    """
    height, width = bgr.shape[:2]
    factor = max(1, math.ceil(max(width, height) / max_edge_px))
    if factor > 1:
        width, height = max(1, width // factor), max(1, height // factor)
        bgr = cv2.resize(bgr, (width, height), interpolation=cv2.INTER_AREA)
    ok, buffer = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        raise CameraUnavailable("OpenCV could not encode the frame as JPEG")
    return buffer.tobytes(), width, height


def _encode_within_limit(bgr: np.ndarray, cfg: Config) -> tuple[bytes, int, int]:
    """Encode a frame the server will take, stepping the quality down if it must.

    A 1600 px JPEG at q80 is a few hundred kB, so the second pass is for the
    pathological source: the rig must never upload bytes the server is going to
    refuse for being over its 2 MB ceiling.
    """
    jpeg, width, height = encode_jpeg(bgr, cfg.max_edge_px, cfg.jpeg_quality)
    quality = cfg.jpeg_quality
    while len(jpeg) > MAX_JPEG_BYTES and quality > QUALITY_FLOOR:
        quality = max(QUALITY_FLOOR, quality - QUALITY_STEP)
        jpeg, width, height = encode_jpeg(bgr, cfg.max_edge_px, quality)
    return jpeg, width, height


def _reencode(data: bytes, cfg: Config) -> tuple[bytes, int, int]:
    """Put the console's JPEG through the rig's own encoder: decode, downscale, encode."""
    bgr = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if bgr is None:
        raise CameraUnavailable("the console returned a JPEG that OpenCV cannot decode")
    return _encode_within_limit(bgr, cfg)


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    """The frame's size from its SOF marker, without decoding the pixels.

    The rig needs two integers to know whether the console's bytes are already
    inside the limit, and it asks twice a second: decoding 640x480 to learn them
    would be work for nothing. The walk mirrors the server's own marker walk in
    `apps/server/src/services/frames.ts`.
    """
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        return None
    end = len(data)
    i = 2
    while i + 3 < end:
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        if marker == 0xDA:  # the scan begins: an SOF would have come before it
            return None
        if i + 9 > end:
            return None
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height = int.from_bytes(data[i + 5 : i + 7], "big")
            width = int.from_bytes(data[i + 7 : i + 9], "big")
            if width <= 0 or height <= 0:
                return None
            return width, height
        i += 2 + int.from_bytes(data[i + 2 : i + 4], "big")
    return None


def _snapshot_size(snapshot: dict | None) -> tuple[int, int] | None:
    """`vision.snapshot.size` as (width, height): what the camera itself delivers."""
    if not snapshot:
        return None
    size = snapshot.get("size")
    if not isinstance(size, (list, tuple)) or len(size) != 2:
        return None
    if not all(_positive(v) for v in size):
        return None
    return int(size[0]), int(size[1])


def _positive(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def _dig(payload: dict, *path: str) -> object:
    """Walk into a JSON object, returning None rather than raising on a missing limb."""
    node: object = payload
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def _iso_now() -> str:
    """ISO-8601 UTC, milliseconds, trailing `Z` — the shape the upload header wants."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class ConsoleSource:
    """The rig's usual eyes: the newest frame from the tracking console.

    The console holds the UVC device and publishes both the frame and its own
    vision snapshot, so the rig can describe the camera without opening it.
    """

    def __init__(self, cfg: Config, log: logging.Logger) -> None:
        self._cfg = cfg
        self._log = log
        self._client: httpx.AsyncClient | None = None
        self._snapshot: dict | None = None
        self._size: tuple[int, int] | None = None
        self._open = False

    def _http(self) -> httpx.AsyncClient:
        # One client for the probe and for the frames: the console is on
        # loopback, and a fresh connection per frame would be most of the cost.
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=CONSOLE_TIMEOUT_S)
        return self._client

    async def open(self) -> None:
        """Take the console on, if it is capturing and its frame is fresh."""
        payload = await self._streams()
        age = _dig(payload, "frame", "age_ms")
        if not isinstance(age, (int, float)) or isinstance(age, bool):
            raise CameraUnavailable("the console is not capturing a frame yet")
        if age > STALE_FRAME_MS:
            raise CameraUnavailable(
                f"the console's frame is {age:.0f} ms old, past the {STALE_FRAME_MS} ms ceiling"
            )
        vision = payload.get("vision")
        snapshot = _dig(vision, "snapshot") if isinstance(vision, dict) else None
        self._snapshot = snapshot if isinstance(snapshot, dict) else None
        self._open = True

    async def is_open(self) -> bool:
        return self._open

    def describe(self) -> dict | None:
        """The `DeskCamera` shape for the caps.

        `zoom` is false and stays false: the console's `/api/cmd` has no such
        method, so claiming it would have the server send an action the rig must
        then refuse.
        """
        size = _snapshot_size(self._snapshot) or self._size
        model = self._model()
        if size is None or model is None:
            return None
        return {
            "model": model,
            "maxWidth": size[0],
            "maxHeight": size[1],
            "zoom": False,
        }

    async def grab(self) -> Frame:
        """The console's newest frame: its bytes when they are already legal, else re-encoded."""
        if not self._open:
            raise CameraUnavailable("the console source is not open")
        try:
            response = await self._http().get(f"{self._cfg.console_url}{CONSOLE_FRAME_PATH}")
            response.raise_for_status()
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            # Reopening re-probes `/api/streams`, which is how a restarted console
            # — or a vision process that stopped writing frames — is noticed.
            self._open = False
            raise CameraUnavailable(f"the console did not answer {CONSOLE_FRAME_PATH}: {exc}") from exc

        data = response.content
        if not data:
            raise CameraUnavailable("the console answered with an empty frame")
        size = _jpeg_size(data)
        if size is None:
            raise CameraUnavailable("the console answered with something that is not a JPEG")
        self._size = size
        if max(size) <= self._cfg.max_edge_px and len(data) <= MAX_JPEG_BYTES:
            # Already inside the server's limits: the console's encoder is as good
            # as ours, and re-encoding 45 kB twice a second buys nothing.
            jpeg, width, height = data, size[0], size[1]
        else:
            jpeg, width, height = await asyncio.to_thread(_reencode, data, self._cfg)
        return Frame(jpeg=jpeg, width=width, height=height, captured_at=_iso_now())

    async def close(self) -> None:
        client, self._client = self._client, None
        self._open = False
        if client is not None:
            await client.aclose()

    async def _streams(self) -> dict:
        try:
            response = await self._http().get(f"{self._cfg.console_url}{CONSOLE_STREAMS_PATH}")
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise CameraUnavailable(f"no console at {self._cfg.console_url}: {exc}") from exc
        except ValueError as exc:
            raise CameraUnavailable(f"the console's {CONSOLE_STREAMS_PATH} is not JSON: {exc}") from exc
        if not isinstance(payload, dict):
            raise CameraUnavailable(f"the console's {CONSOLE_STREAMS_PATH} is not an object")
        return payload

    def _model(self) -> str | None:
        snapshot = self._snapshot or {}
        name = str(snapshot.get("camera_name") or "").strip()
        if name:
            return name
        # A console that will not name the device still knows which one it opened;
        # an index is thin, but it is true.
        index = snapshot.get("camera")
        if isinstance(index, int) and not isinstance(index, bool):
            return f"console camera {index}"
        return None


class OpenCvSource:
    """The device opened here, for a bench where nothing else holds it.

    Every `cv2` call blocks while AVFoundation starts or the sensor answers, so
    `open()` and `grab()` run theirs in a thread: the event loop keeps serving
    the socket while the camera takes its time.
    """

    def __init__(self, cfg: Config, log: logging.Logger) -> None:
        self._cfg = cfg
        self._log = log
        self._cap: cv2.VideoCapture | None = None
        self._size: tuple[int, int] | None = None

    async def open(self) -> None:
        """Open the device, let it settle, and learn what it really delivers."""
        await self.close()  # a previous handle goes first: AVFoundation will not open one camera twice
        index = self._cfg.camera_index
        cap = await asyncio.to_thread(cv2.VideoCapture, index, cv2.CAP_AVFOUNDATION)
        if not cap.isOpened():
            cap.release()
            raise CameraUnavailable(
                f"no camera on AVFoundation index {index} (another process may be holding it)"
            )
        frame = await asyncio.to_thread(_warm_up, cap, WARMUP_FRAMES)
        if frame is None:
            cap.release()
            raise CameraUnavailable(f"camera {index} opened but delivered no frame")
        self._cap = cap
        height, width = frame.shape[:2]
        self._size = (int(width), int(height))
        self._log.debug("AVFoundation index %d delivers %dx%d", index, self._size[0], self._size[1])

    async def is_open(self) -> bool:
        return self._cap is not None and self._cap.isOpened()

    def describe(self) -> dict | None:
        """The `DeskCamera` shape for the caps, with the device's own size.

        `zoom` is false: AVFoundation's `CAP_PROP_ZOOM` reads back its
        unsupported sentinel here and refuses the write, and an advertised
        action the rig cannot honour is worse than a refusal.
        """
        if self._cap is None or self._size is None:
            return None
        return {
            "model": self._model(),
            "maxWidth": self._size[0],
            "maxHeight": self._size[1],
            "zoom": False,
        }

    async def grab(self) -> Frame:
        """One frame from the device, downscaled to the server's limit on this side."""
        cap = self._cap
        if cap is None:
            raise CameraUnavailable("the OpenCV source is not open")
        ok, bgr = await asyncio.to_thread(cap.read)
        if not ok or bgr is None:
            raise CameraUnavailable(f"camera {self._cfg.camera_index} returned no frame")
        jpeg, width, height = await asyncio.to_thread(_encode_within_limit, bgr, self._cfg)
        return Frame(jpeg=jpeg, width=width, height=height, captured_at=_iso_now())

    async def close(self) -> None:
        cap, self._cap = self._cap, None
        if cap is not None:
            await asyncio.to_thread(cap.release)

    def _model(self) -> str:
        # OpenCV does not report a device name through AVFoundation. The index is
        # what the rig actually knows; a name assembled from guesswork would read
        # like a fact on the app's setup screen.
        return f"AVFoundation camera {self._cfg.camera_index}"


def _warm_up(cap: cv2.VideoCapture, count: int) -> np.ndarray | None:
    """Discard the frames a camera delivers before it has settled, and keep the next."""
    for _ in range(count):
        cap.read()
    ok, frame = cap.read()
    return frame if ok else None


def _describe_source(source: FrameSource) -> str:
    """One line for the log: what the source says it is, without asking it twice."""
    camera = source.describe()
    if camera is None:
        return "camera: not described yet"
    return f"{camera['maxWidth']}x{camera['maxHeight']} camera: {camera['model']}"


async def open_source(cfg: Config, log: logging.Logger) -> FrameSource:
    """The source the config asks for. `auto` prefers the console, and says why.

    The console wins when it holds a fresh frame because it already has the UVC
    device open: a second opener would either fail outright or halve the rate at
    which tracking sees the desk.
    """
    if cfg.camera_source == "console":
        source = ConsoleSource(cfg, log)
        await source.open()
        log.info("camera: the console's frame, %s", _describe_source(source))
        return source
    if cfg.camera_source == "opencv":
        source = OpenCvSource(cfg, log)
        await source.open()
        log.info("camera: AVFoundation index %d, %s", cfg.camera_index, _describe_source(source))
        return source

    console = ConsoleSource(cfg, log)
    try:
        await console.open()
    except CameraUnavailable as exc:
        log.info(
            "camera: no console frame (%s); opening AVFoundation index %d instead",
            exc,
            cfg.camera_index,
        )
        await console.close()
    else:
        log.info("camera: the console's frame, %s", _describe_source(console))
        return console

    device = OpenCvSource(cfg, log)
    await device.open()
    log.info("camera: AVFoundation index %d, %s", cfg.camera_index, _describe_source(device))
    return device


class DeferredSource:
    """A camera that has not opened yet: each `open()` re-runs the whole `auto` chain.

    `open_source` picks one source and pins it. A rig that booted with the console
    down *and* nothing plugged in would then re-probe the console forever, never
    reaching the device that appears five minutes later — while a rig that opened
    the device because the console was stale at boot would keep holding the UVC
    device after the console came back, which is the case `auto` exists to avoid.
    Deferring the choice to each `open()` keeps one rule true for the whole run:
    the console when it has a fresh frame, the device otherwise.
    """

    def __init__(self, cfg: Config, log: logging.Logger) -> None:
        self._cfg = cfg
        self._log = log
        self._inner: FrameSource | None = None

    async def open(self) -> None:
        # The chain owns its own failures: `open_source` closes the console before
        # falling through to the device, and each source releases itself when its
        # own open fails, so nothing is left holding the bus.
        await self.close()
        self._inner = await open_source(self._cfg, self._log)

    async def is_open(self) -> bool:
        inner = self._inner
        return inner is not None and await inner.is_open()

    async def grab(self) -> Frame:
        inner = self._inner
        if inner is None:
            raise CameraUnavailable("the camera has not opened yet")
        return await inner.grab()

    async def close(self) -> None:
        inner, self._inner = self._inner, None
        if inner is not None:
            await inner.close()

    def describe(self) -> dict | None:
        """Nothing until a source is open: the caps the rig registers are the real device's."""
        inner = self._inner
        return inner.describe() if inner is not None else None
