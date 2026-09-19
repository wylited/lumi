"""`load` is the whole settings surface: the defaults, the derivation, and the refusals."""

from __future__ import annotations

from pathlib import Path

import pytest

from heli_rig.config import ConfigError, load


def test_defaults_are_the_ones_the_contract_names():
    cfg = load(env={}, argv=[])
    assert cfg.api_url == "http://localhost:3001"
    assert cfg.console_url == "http://127.0.0.1:8643"
    assert cfg.camera_source == "auto"
    assert cfg.camera_index == 0
    assert cfg.fps == 2.0
    assert cfg.max_edge_px == 1600
    assert cfg.jpeg_quality == 80
    assert cfg.desk_name == "Desk 1"
    assert cfg.arm_driver == "auto"
    assert cfg.speaker is True
    assert cfg.log_level == "info"
    assert cfg.once is False
    assert cfg.desk_token is None
    assert cfg.email is None
    assert cfg.heli_dir == Path.home() / ".heli"


def test_the_socket_url_follows_the_api_url():
    assert load(env={}, argv=[]).ws_url == "ws://localhost:3001/ws/desk"

    secure = load(env={"HELI_API_URL": "https://heli.example:9443"}, argv=[])
    assert secure.ws_url == "wss://heli.example:9443/ws/desk"


def test_an_api_url_that_is_not_http_is_refused_by_name():
    # A bare `host:port` parses as a scheme, so it has to be caught rather than
    # quietly turned into `ws://` something.
    with pytest.raises(ConfigError, match="API URL"):
        load(env={"HELI_API_URL": "localhost:3001"}, argv=[])


def test_the_flags_beat_the_environment():
    cfg = load(
        env={
            "HELI_FPS": "4",
            "HELI_CAMERA_INDEX": "1",
            "HELI_LOG_LEVEL": "warning",
            "HELI_SPEAKER": "no",
        },
        argv=[
            "--once",
            "--fps",
            "1.5",
            "--camera-index",
            "2",
            "--console",
            "http://127.0.0.1:9999/",
            "--api-url",
            "https://api.heli.test",
            "--log-level",
            "DEBUG",
        ],
    )
    assert cfg.once is True
    assert cfg.fps == 1.5
    assert cfg.camera_index == 2
    assert cfg.console_url == "http://127.0.0.1:9999"
    assert cfg.api_url == "https://api.heli.test"
    assert cfg.ws_url == "wss://api.heli.test/ws/desk"
    assert cfg.log_level == "debug"
    assert cfg.speaker is False


def test_an_empty_variable_means_the_default_not_an_empty_string():
    cfg = load(env={"HELI_DESK_TOKEN": "", "HELI_FPS": "  ", "HELI_DIR": ""}, argv=[])
    assert cfg.desk_token is None
    assert cfg.fps == 2.0
    assert cfg.heli_dir == Path.home() / ".heli"


def test_the_values_the_arm_and_the_camera_drivers_take():
    assert load(env={"HELI_ARM_DRIVER": "serial"}, argv=[]).arm_driver == "serial"
    assert load(env={"HELI_CAMERA_SOURCE": "opencv"}, argv=[]).camera_source == "opencv"
    assert load(env={"HELI_DIR": "/tmp/heli-test"}, argv=[]).heli_dir == Path("/tmp/heli-test")


def test_a_setting_that_could_not_work_is_refused_by_name():
    with pytest.raises(ConfigError, match="HELI_FPS"):
        load(env={"HELI_FPS": "fast"}, argv=[])
    with pytest.raises(ConfigError, match="HELI_CAMERA_SOURCE"):
        load(env={"HELI_CAMERA_SOURCE": "webcam"}, argv=[])
    with pytest.raises(ConfigError, match="HELI_ARM_DRIVER"):
        load(env={"HELI_ARM_DRIVER": "pi"}, argv=[])
    with pytest.raises(ConfigError, match="HELI_SPEAKER"):
        load(env={"HELI_SPEAKER": "maybe"}, argv=[])


def test_a_setting_out_of_range_is_refused_rather_than_clamped():
    # Each of these would otherwise fail deep inside a camera or an encoder,
    # where the message could not name the variable that caused it.
    with pytest.raises(ConfigError, match="fps must be greater than zero"):
        load(env={"HELI_FPS": "0"}, argv=[])
    with pytest.raises(ConfigError, match="max_edge_px"):
        load(env={"HELI_MAX_EDGE_PX": "0"}, argv=[])
    with pytest.raises(ConfigError, match="jpeg_quality"):
        load(env={"HELI_JPEG_QUALITY": "101"}, argv=[])
    with pytest.raises(ConfigError, match="camera_index"):
        load(env={"HELI_CAMERA_INDEX": "-1"}, argv=[])
    with pytest.raises(ConfigError, match="fps must be greater than zero"):
        load(env={}, argv=["--fps", "0"])
