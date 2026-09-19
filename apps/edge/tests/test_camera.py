"""The camera path: what the rig sends, what it does with bytes it cannot use, and what it refuses."""

from __future__ import annotations

import logging
from dataclasses import replace

import cv2
import numpy as np
import pytest

from heli_rig.camera import (
    MAX_JPEG_BYTES,
    CameraUnavailable,
    ConsoleSource,
    OpenCvSource,
    encode_jpeg,
    open_source,
)


def jpeg(width: int, height: int, quality: int = 80) -> bytes:
    """A real JPEG of that size: the sources have to read its marker, not a mock."""
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    frame[:, : width // 2] = 200  # a little structure, so the bytes are not degenerate
    ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    assert ok
    return buffer.tobytes()


def size_of(data: bytes) -> tuple[int, int]:
    """The size of the JPEG bytes themselves, which is what the server will read."""
    frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert frame is not None
    height, width = frame.shape[:2]
    return width, height


def test_encode_jpeg_downscales_the_long_edge_by_a_whole_factor(config):
    _, width, height = encode_jpeg(np.zeros((1200, 2400, 3), dtype=np.uint8), 1600, 80)
    # 2400 needs two factors of two to fit in 1600, and two is what the rig uses:
    # a fractional resize would invent pixels the sensor never delivered.
    assert (width, height) == (1200, 600)


def test_encode_jpeg_passes_a_frame_inside_the_limit_through_unchanged(config):
    _, width, height = encode_jpeg(np.zeros((480, 640, 3), dtype=np.uint8), 1600, 80)
    assert (width, height) == (640, 480)


def test_encode_jpeg_honours_the_quality_it_was_given(config):
    noise = np.random.default_rng(0).integers(0, 256, (480, 640, 3), dtype=np.uint8)
    small, *_ = encode_jpeg(noise, 1600, 30)
    large, *_ = encode_jpeg(noise, 1600, 90)
    assert small[:2] == b"\xff\xd8"  # a JPEG, not just bytes
    assert len(small) < len(large)


@pytest.mark.asyncio
async def test_the_console_source_describes_the_camera_it_reads(config, console):
    console.jpeg = jpeg(640, 480)
    source = ConsoleSource(replace(config, console_url=console.url), logging.getLogger("test"))

    await source.open()

    assert source.describe() == {
        "model": "USB Camera",
        "maxWidth": 640,
        "maxHeight": 480,
        "zoom": False,
    }
    assert "/api/streams" in [request.path for request in console.requests]


@pytest.mark.asyncio
async def test_the_console_source_hands_on_bytes_that_are_already_legal(config, console):
    served = jpeg(640, 480)
    console.jpeg = served
    source = ConsoleSource(replace(config, console_url=console.url), logging.getLogger("test"))

    await source.open()
    frame = await source.grab()

    assert frame.jpeg == served, "a frame inside the limit is not re-encoded"
    assert (frame.width, frame.height) == (640, 480)
    assert frame.captured_at.endswith("Z") and len(frame.captured_at) == 24


@pytest.mark.asyncio
async def test_the_console_source_re_encodes_a_frame_over_the_limit(config, console):
    console.jpeg = jpeg(2400, 1200)
    console.size = (2400, 1200)
    source = ConsoleSource(replace(config, console_url=console.url), logging.getLogger("test"))

    await source.open()
    frame = await source.grab()

    assert frame.jpeg != console.jpeg, "bytes over the limit are the rig's own"
    assert max(size_of(frame.jpeg)) <= config.max_edge_px
    assert (frame.width, frame.height) == size_of(frame.jpeg)
    assert (frame.width, frame.height) == (1200, 600)
    assert len(frame.jpeg) < MAX_JPEG_BYTES


@pytest.mark.asyncio
async def test_open_refuses_a_console_whose_frame_is_stale(config, console):
    console.jpeg = jpeg(640, 480)
    console.age_ms = 9000.0
    source = ConsoleSource(replace(config, console_url=console.url), logging.getLogger("test"))

    with pytest.raises(CameraUnavailable, match="9000 ms old"):
        await source.open()


@pytest.mark.asyncio
async def test_open_refuses_a_console_that_is_not_capturing(config, console):
    console.age_ms = None
    source = ConsoleSource(replace(config, console_url=console.url), logging.getLogger("test"))

    with pytest.raises(CameraUnavailable, match="not capturing"):
        await source.open()


@pytest.mark.asyncio
async def test_open_refuses_a_console_that_is_not_there(config, stub):
    gone = stub(lambda _request: (200, "application/json", b"{}"))
    url = gone.url
    gone.stop()
    source = ConsoleSource(replace(config, console_url=url), logging.getLogger("test"))

    with pytest.raises(CameraUnavailable, match="no console at"):
        await source.open()


@pytest.mark.asyncio
async def test_a_grab_from_a_console_whose_frame_went_away_is_a_named_failure(config, console):
    console.jpeg = jpeg(640, 480)
    source = ConsoleSource(replace(config, console_url=console.url), logging.getLogger("test"))
    await source.open()

    console.jpeg = b""  # vision stopped writing: the console is up, the frame is gone
    with pytest.raises(CameraUnavailable, match="did not answer"):
        await source.grab()
    assert await source.is_open() is False, "the next tick reopens, which re-probes for staleness"


@pytest.mark.asyncio
async def test_auto_prefers_the_console_over_a_device_that_would_not_open(config, console, caplog):
    console.jpeg = jpeg(640, 480)
    # Index 99 is not a camera: if `auto` opened the device first, this would
    # raise, so a returned console source is proof of the order.
    cfg = replace(config, console_url=console.url, camera_index=99)

    with caplog.at_level(logging.INFO, logger="heli_rig.camera"):
        source = await open_source(cfg, logging.getLogger("heli_rig.camera"))

    assert isinstance(source, ConsoleSource)
    assert "the console's frame" in caplog.text
    await source.close()


@pytest.mark.asyncio
async def test_auto_falls_back_to_the_device_when_the_console_has_no_fresh_frame(
    config, console, caplog
):
    console.jpeg = jpeg(640, 480)
    console.age_ms = 60_000.0
    cfg = replace(config, console_url=console.url, camera_index=99)

    with caplog.at_level(logging.INFO, logger="heli_rig.camera"):
        with pytest.raises(CameraUnavailable, match="99"):
            await open_source(cfg, logging.getLogger("heli_rig.camera"))

    assert "no console frame" in caplog.text
    assert "60000 ms old" in caplog.text


@pytest.mark.asyncio
async def test_the_opencv_source_refuses_a_device_that_is_not_there(config):
    source = OpenCvSource(replace(config, camera_index=99), logging.getLogger("test"))

    with pytest.raises(CameraUnavailable, match="99"):
        await source.open()
    assert source.describe() is None
    assert await source.is_open() is False
    with pytest.raises(CameraUnavailable, match="not open"):
        await source.grab()
