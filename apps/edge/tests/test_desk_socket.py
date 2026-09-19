"""HELI-045's socket client, proven against a real websocket server.

`FakeDesk` is a server, so the handshake the rig presents and every frame it
sends are observed on the wire; the rig's own collaborators are stubs that record
what they were asked to do. These tests cover what the socket is for: the frames
that announce the desk, one action through the dispatcher and back as an ack, the
spoken line that arrives as a header plus tagged PCM, and the reconnect that keeps
the desk on the server after it goes away.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

import pytest

from heli_rig import AGENT_VERSION
from heli_rig import socket as socket_module
from heli_rig.actions import Dispatcher
from heli_rig.arm.driver import ArmPose
from heli_rig.camera import Frame
from heli_rig.socket import DeskClient
from tests.fake_desk import (
    FakeArm,
    FakeCapture,
    FakeDesk,
    FakeSource,
    FakeSpeaker,
    StubTokens,
    rig_config,
    wait_until,
)

log = logging.getLogger("tests.socket")

CAMERA = {"model": "USB Camera", "maxWidth": 640, "maxHeight": 480, "zoom": False}
ARM = {"model": "SO-100", "dof": 6, "port": "usbmodem5C4C1279531"}
CAPTURED_AT = "2026-09-19T14:02:11.482Z"


def frame() -> Frame:
    return Frame(jpeg=b"\xff\xd8jpeg", width=640, height=480, captured_at=CAPTURED_AT)


def ack(action_id: str, status: str, *, pose=None, seq=None, zoom=None, duration_ms=None, error=None) -> dict:
    """The whole ack, spelled out: the contract's result carries every field."""
    return {
        "t": "action.ack",
        "actionId": action_id,
        "status": status,
        "result": {"pose": pose, "seq": seq, "zoom": zoom, "durationMs": duration_ms},
        "error": error,
    }


class RunningRig:
    """A `DeskClient` running against a fake desk, with a teardown that waits."""

    def __init__(self, cfg, *, capture, arm, speaker, tokens):
        self.cfg = cfg
        self.capture = capture
        self.arm = arm
        self.speaker = speaker
        self.tokens = tokens
        self.dispatcher = Dispatcher(capture, arm, speaker, cfg, log)
        self.client = DeskClient(cfg, self.dispatcher, capture, arm, speaker, tokens, log)
        self.task = asyncio.create_task(self.client.run())

    async def stop(self) -> None:
        self.task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.task


def start_rig(desk: FakeDesk, tmp_path, *, capture=None, arm=None, speaker=None, tokens=None, **env) -> RunningRig:
    """A rig pointed at a fake desk, with every collaborator it needs."""
    cfg = rig_config(tmp_path, api_url=f"http://127.0.0.1:{desk.port}", **env)
    return RunningRig(
        cfg,
        capture=capture if capture is not None else FakeCapture(fps=2.0),
        arm=arm,
        speaker=speaker,
        tokens=tokens if tokens is not None else StubTokens(),
    )


def socket_rig(desk: FakeDesk, tmp_path, *, frames=(), tokens=None, **env) -> RunningRig:
    """The common case: a camera that describes itself, an arm, and a store."""
    capture = FakeCapture(frames, fps=2.0, last_seq=6, frames_sent=11)
    capture.source = FakeSource(dict(CAMERA))
    capture.last_frame_at = CAPTURED_AT
    return start_rig(
        desk,
        tmp_path,
        capture=capture,
        arm=FakeArm(caps=dict(ARM), achieved=ArmPose(pan=8.5, tilt=-2.5)),
        speaker=FakeSpeaker(),
        tokens=tokens if tokens is not None else StubTokens("desk-token", desk_id="heli-0f1e2d3c"),
        **env,
    )


@pytest.mark.asyncio
async def test_a_connection_announces_the_desk_and_keeps_it_alive(tmp_path):
    desk = FakeDesk()
    await desk.start()
    rig = socket_rig(desk, tmp_path)
    try:
        assert rig.cfg.ws_url == desk.url  # the derived URL is the contract's path

        hello = await desk.wait_for_type("hello")
        assert hello == {
            "t": "hello",
            "deskId": "heli-0f1e2d3c",
            "agentVersion": AGENT_VERSION,
            "camera": CAMERA,
            "arm": ARM,
        }

        health = await desk.wait_for_type("desk.health")
        assert health == {
            "t": "desk.health",
            "fps": 2.0,
            "lastFrameAt": CAPTURED_AT,
            "armPose": {"pan": 8.5, "tilt": -2.5},
            "tempC": None,
            # 11, not the 6 frames the loop has taken: the frame carries what
            # the server accepted, which is the counter it can act on.
            "framesSent": 11,
            # Null, not false: this rig was handed no tracker at all, and the app's
            # Follow me switch has nothing to turn on. `test_the_health_says_whether_...`
            # covers the other two answers.
            "following": None,
        }

        # The token rides in the query string and the protocol is negotiated, so
        # the token is never echoed back as a subprotocol.
        handshake = desk.handshakes[0]
        assert handshake["path"] == "/ws/desk?token=desk-token"
        assert handshake["token"] == "desk-token"
        assert "heli.v1" in handshake["subprotocols"]
    finally:
        await rig.stop()
        await desk.close()


@pytest.mark.asyncio
async def test_the_heartbeat_keeps_coming_and_is_read_at_send_time(tmp_path, monkeypatch):
    monkeypatch.setattr(socket_module, "HEALTH_INTERVAL_S", 0.05)
    desk = FakeDesk()
    await desk.start()
    rig = socket_rig(desk, tmp_path)
    try:
        await wait_until(
            lambda: len(desk.of_type("desk.health")) >= 3, timeout=3.0, what="a third heartbeat"
        )

        # A heartbeat is a claim about now, so the loop changing its cadence has
        # to show up in the next one rather than in the one after a reconnect.
        rig.capture.set_fps(9.0)
        await wait_until(
            lambda: any(health["fps"] == 9.0 for health in desk.of_type("desk.health")),
            timeout=3.0,
            what="a heartbeat carrying the new cadence",
        )
    finally:
        await rig.stop()
        await desk.close()


@pytest.mark.asyncio
async def test_an_action_is_dispatched_and_acked_with_the_id_it_carried(tmp_path):
    desk = FakeDesk()
    await desk.start()
    rig = socket_rig(desk, tmp_path, frames=[frame()])
    try:
        await desk.wait_for_connection()
        await desk.send(
            {
                "t": "action",
                "id": "a-1",
                "issuedAt": CAPTURED_AT,
                "type": "capture",
                "payload": {"reason": "manual"},
            }
        )

        captured = await desk.wait_for(lambda m: m.get("actionId") == "a-1", what="the capture's ack")
        assert captured == ack("a-1", "done", seq=7)

        await desk.send(
            {
                "t": "action",
                "id": "a-2",
                "issuedAt": CAPTURED_AT,
                "type": "stream.start",
                "payload": {"fps": 5},
            }
        )

        started = await desk.wait_for(lambda m: m.get("actionId") == "a-2", what="the stream's ack")
        assert started == ack("a-2", "done")
        assert rig.capture.fps_calls == [5.0]
    finally:
        await rig.stop()
        await desk.close()


@pytest.mark.asyncio
async def test_a_spoken_line_is_played_and_acked_under_its_moment_id(tmp_path):
    desk = FakeDesk()
    await desk.start()
    rig = socket_rig(desk, tmp_path)
    try:
        await desk.wait_for_connection()
        pcm = bytes(range(64))  # 32 frames of mono S16LE, and easily told from the tag
        await desk.send(
            {
                "t": "audio.out",
                "format": "pcm_s16le",
                "sampleRate": 16000,
                "channels": 1,
                "durationMs": 250,
                "momentId": "m-1",
            }
        )
        await desk.send_bytes(bytes([0x02]) + pcm)

        played = await desk.wait_for(lambda m: m.get("actionId") == "m-1", what="the line's ack")
        assert played == ack("m-1", "done", duration_ms=250)
        # The tag byte is the frame's, not the line's: the speaker gets the PCM.
        assert rig.speaker.lines == [
            {"pcm": pcm, "sampleRate": 16000, "channels": 1, "durationMs": 250}
        ]
    finally:
        await rig.stop()
        await desk.close()


@pytest.mark.asyncio
async def test_a_line_that_cannot_play_is_acked_as_a_failure(tmp_path):
    desk = FakeDesk()
    await desk.start()
    rig = start_rig(
        desk,
        tmp_path,
        speaker=FakeSpeaker(fail_with="no_player: afplay"),
        tokens=StubTokens("desk-token"),
    )
    try:
        await desk.wait_for_connection()
        await desk.send(
            {
                "t": "audio.out",
                "format": "pcm_s16le",
                "sampleRate": 16000,
                "channels": 1,
                "durationMs": 250,
                "momentId": "m-1",
            }
        )
        await desk.send_bytes(bytes([0x02]) + bytes(64))

        failed = await desk.wait_for(lambda m: m.get("actionId") == "m-1", what="the line's ack")
        assert failed == ack("m-1", "failed", error="no_player: afplay")
    finally:
        await rig.stop()
        await desk.close()


@pytest.mark.asyncio
async def test_a_binary_frame_with_no_header_is_dropped_and_the_desk_keeps_working(tmp_path):
    desk = FakeDesk()
    await desk.start()
    rig = socket_rig(desk, tmp_path, frames=[frame()])
    try:
        await desk.wait_for_connection()
        await desk.send_bytes(bytes([0x02]) + bytes(64))

        # A real action first, then the negative checks: the receive loop is
        # sequential, so once this ack is on the wire the stray frame has been
        # handled — a `sleep` would pass whatever the rig did with it.
        await desk.send(
            {
                "t": "action",
                "id": "a-1",
                "issuedAt": CAPTURED_AT,
                "type": "capture",
                "payload": {"reason": None},
            }
        )
        assert await desk.wait_for(lambda m: m.get("actionId") == "a-1", what="the capture's ack") == ack(
            "a-1", "done", seq=7
        )
        assert rig.speaker.lines == []
        assert [m for m in desk.acks if m.get("actionId") != "a-1"] == []
    finally:
        await rig.stop()
        await desk.close()


@pytest.mark.asyncio
async def test_the_rig_comes_back_after_the_server_goes_away(tmp_path, monkeypatch):
    monkeypatch.setattr(socket_module, "BACKOFF_INITIAL_S", 0.01)
    desk = FakeDesk()
    await desk.start()
    rig = socket_rig(desk, tmp_path)
    try:
        await desk.wait_for_connection()
        await desk.drop()

        await desk.wait_for_connection(2, timeout=3.0)
        # It announces itself again: a reconnect that stayed silent would be a
        # socket the server has and a desk it cannot name.
        await wait_until(lambda: len(desk.of_type("hello")) >= 2, what="the second hello")
        assert [hello["deskId"] for hello in desk.of_type("hello")[:2]] == [
            "heli-0f1e2d3c",
            "heli-0f1e2d3c",
        ]
    finally:
        await rig.stop()
        await desk.close()


@pytest.mark.asyncio
async def test_a_refused_token_is_refreshed_once_and_the_desk_comes_back(tmp_path, monkeypatch):
    monkeypatch.setattr(socket_module, "BACKOFF_INITIAL_S", 0.01)
    # Both tokens are refused, so a rig that re-registered on every 401 would keep
    # minting and keep trying: the guard is the only thing that ends this, and the
    # test fails on the count rather than passing because only one refusal happened.
    desk = FakeDesk(deny_tokens={"stale", "fresh"})
    await desk.start()
    rig = socket_rig(desk, tmp_path, tokens=StubTokens("stale", refresh_token="fresh"))
    try:
        await wait_until(
            lambda: len(desk.handshakes) >= 3,
            timeout=3.0,
            what="a handshake with the freshened token, refused, and another attempt",
        )
        assert rig.tokens.refreshes == 1
    finally:
        await rig.stop()
        await desk.close()


@pytest.mark.asyncio
async def test_a_refusal_that_is_not_401_waits_longer_instead_of_refreshing(tmp_path, monkeypatch):
    monkeypatch.setattr(socket_module, "BACKOFF_INITIAL_S", 0.05)
    desk = FakeDesk(deny_tokens={"stale"}, deny_status=403)
    await desk.start()
    rig = socket_rig(desk, tmp_path, tokens=StubTokens("stale", refresh_token="fresh"))
    try:
        await wait_until(lambda: len(desk.handshakes) >= 3, timeout=5.0, what="three attempts")

        # A token would not fix a 403, so the rig does not trade one for a
        # second desk; what it does instead is wait longer between attempts.
        assert rig.tokens.refreshes == 0
        first, second, third = (handshake["at"] for handshake in desk.handshakes[:3])
        assert second - first >= 0.04
        assert third - second >= 0.08
    finally:
        await rig.stop()
        await desk.close()


@pytest.mark.asyncio
async def test_the_health_says_whether_the_rig_is_following(tmp_path, monkeypatch):
    """`following` is three answers, not two: null, false, true — and the app's switch needs them.

    A rig with no tracker cannot follow at all, which is a different claim from a rig that has one
    and is not following it: `null` is "this desk has no such thing", `false` is "it does, and it is
    off". Collapsing them would light up a Follow me switch on a rig that can never follow.

    The tracker is the real one, so this also pins that the socket reads its state rather than
    inventing an answer: `set_on` is what turns it on, and the very next heartbeat has to say so.
    """
    from heli_rig.config import load
    from heli_rig.follow import Tracker

    from tests.test_follow import FakeArm, gimbal_for

    # The heartbeat is every 5 s in the rig; a test that waited for the next one would wait longer
    # than it takes to read this.
    monkeypatch.setattr(socket_module, "HEALTH_INTERVAL_S", 0.05)

    desk = FakeDesk()
    await desk.start()

    # No tracker at all: the wiring this rig runs with when it has no arm.
    plain = socket_rig(desk, tmp_path)
    try:
        health = await desk.wait_for_type("desk.health")
        assert health["following"] is None
    finally:
        await plain.stop()
        await desk.close()

    # A tracker that exists: `auto` starts following, and stopping is what makes the next
    # heartbeat say so — a report about now, not a value cached when the socket opened.
    desk = FakeDesk()
    await desk.start()
    arm = FakeArm()
    tracker = Tracker(load(env={"HELI_TRACKING": "auto"}, argv=[]), arm, gimbal_for(arm), log)
    rig = socket_rig(desk, tmp_path)
    rig.dispatcher._tracker = tracker
    try:
        # `auto` with a working arm: following, and it says so. `set_on(False)` first because a
        # freshly built `auto` tracker has the intent (`on`) without the modes yet — its loop
        # engages on the first tick — and this test does not run that loop.
        await asyncio.to_thread(tracker.set_on, False)
        await asyncio.to_thread(tracker.set_on, True)
        await wait_until(
            lambda: any(h["following"] is True for h in desk.of_type("desk.health")),
            timeout=3.0,
            what="a heartbeat saying the rig is following",
        )

        await asyncio.to_thread(tracker.set_on, False)
        await wait_until(
            lambda: any(h["following"] is False for h in desk.of_type("desk.health")),
            timeout=3.0,
            what="a heartbeat saying the rig stopped following",
        )

        # And the case that made this field load-bearing: asked to follow, with an arm that will
        # not take the mode. The heartbeat must not claim it is following — the app would show a
        # switch that is on over an arm that is not moving.
        arm.fails = "mode"
        with pytest.raises(RuntimeError):
            await asyncio.to_thread(tracker.set_on, True)
        assert tracker.following is False
        # The *latest* heartbeat, not every one ever sent: the earlier `true` ones are the
        # record of the rig having followed, which is correct. What must not happen is a
        # heartbeat after the failure that still claims it.
        before = len(desk.of_type("desk.health"))
        await wait_until(
            lambda: len(desk.of_type("desk.health")) > before,
            timeout=3.0,
            what="a heartbeat after the failed engage",
        )
        assert desk.of_type("desk.health")[-1]["following"] is False
    finally:
        await rig.stop()
        await desk.close()
