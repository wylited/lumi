"""The upload path: what goes on the wire, and what every answer the server gives becomes."""

from __future__ import annotations

import json
import logging
from dataclasses import replace

import pytest

from heli_rig.camera import Frame
from heli_rig.upload import Uploader

LOG = logging.getLogger("test.upload")

UPLOADED = json.dumps(
    {"sessionId": "sess_1", "ref": "sessions/sess_1/frames/1.jpg", "seq": 7, "width": 640, "height": 480}
).encode()


def frame() -> Frame:
    return Frame(jpeg=b"\xff\xd8jpeg-bytes", width=640, height=480, captured_at="2026-09-19T10:00:00.000Z")


class Tokens:
    """A token store a test can dictate: each call takes the next value, the last one repeats."""

    def __init__(self, *values: str | None) -> None:
        self._values = list(values) or [None]
        self.asked: list[bool] = []

    def token(self, refresh: bool = False) -> str | None:
        self.asked.append(refresh)
        return self._values.pop(0) if len(self._values) > 1 else self._values[0]


class BrokenTokens:
    """A store that fails the way registration does when it cannot mint a desk token."""

    def token(self, refresh: bool = False) -> str | None:
        raise RuntimeError("POST /v1/desks answered 404")


def answering(status: int, payload: bytes = b"{}", token: str | None = None):
    """A stub answer that only some tokens get."""

    def respond(request):
        if token is not None and request.headers.get("authorization") != f"Bearer {token}":
            return 401, "application/json", b'{"error":"unauthorized"}'
        return status, "application/json", payload

    return respond


@pytest.mark.asyncio
async def test_a_201_carries_the_frames_identity_and_the_headers_the_server_reads(config, stub):
    server = stub(lambda _request: (201, "application/json", UPLOADED))
    uploader = Uploader(replace(config, api_url=server.url), Tokens("desk-token"), LOG)

    outcome = await uploader.upload(frame(), 3)
    await uploader.aclose()

    assert (outcome.ok, outcome.status) == (True, 201)
    assert (outcome.ref, outcome.seq, outcome.width, outcome.height) == (
        "sessions/sess_1/frames/1.jpg",
        7,
        640,
        480,
    )
    assert outcome.error is None and outcome.rejected is False

    sent, = server.requests
    assert (sent.method, sent.path) == ("POST", "/v1/desk/frames")
    assert sent.body == frame().jpeg, "the bytes on the wire are the frame's own"
    assert sent.headers["content-type"] == "image/jpeg"
    assert sent.headers["authorization"] == "Bearer desk-token"
    assert sent.headers["x-heli-seq"] == "3"
    assert sent.headers["x-heli-captured-at"] == "2026-09-19T10:00:00.000Z"


@pytest.mark.asyncio
async def test_the_source_header_is_camera_unless_a_sweep_asks_for_survey(config, stub):
    """The header is how the server keeps a desk reading out of the live frames' ring."""
    server = stub(lambda _request: (201, "application/json", UPLOADED))
    uploader = Uploader(replace(config, api_url=server.url), Tokens("t"), LOG)

    await uploader.upload(frame(), 1)
    await uploader.upload(frame(), 2, "survey")
    await uploader.aclose()

    assert [request.headers["x-heli-source"] for request in server.requests] == ["camera", "survey"]


@pytest.mark.asyncio
async def test_a_409_is_a_closed_session_not_a_failure_to_report(config, stub):
    server = stub(lambda _request: (409, "application/json", b'{"error":"no_open_session"}'))
    uploader = Uploader(replace(config, api_url=server.url), Tokens("t"), LOG)

    outcome = await uploader.upload(frame(), 1)
    await uploader.aclose()

    assert (outcome.ok, outcome.status, outcome.error, outcome.rejected) == (
        False,
        409,
        "no_open_session",
        False,
    )


@pytest.mark.asyncio
async def test_a_422_names_the_code_and_is_never_sent_again(config, stub):
    server = stub(
        lambda _request: (
            422,
            "application/json",
            json.dumps({"error": "frame_rejected", "code": "frame_too_wide", "message": "too wide"}).encode(),
        )
    )
    uploader = Uploader(replace(config, api_url=server.url), Tokens("t"), LOG)

    outcome = await uploader.upload(frame(), 1)
    await uploader.aclose()

    assert (outcome.ok, outcome.status, outcome.error, outcome.rejected) == (
        False,
        422,
        "frame_rejected:frame_too_wide",
        True,
    )
    assert len(server.requests) == 1, "a refused frame is not resent"


@pytest.mark.asyncio
async def test_a_401_buys_one_refreshed_token_and_one_retry(config, stub):
    server = stub(answering(201, UPLOADED, token="fresh"))
    tokens = Tokens("stale", "fresh")
    uploader = Uploader(replace(config, api_url=server.url), tokens, LOG)

    outcome = await uploader.upload(frame(), 1)
    await uploader.aclose()

    assert outcome.ok is True
    assert tokens.asked == [False, True]
    assert [request.headers["authorization"] for request in server.requests] == [
        "Bearer stale",
        "Bearer fresh",
    ]


@pytest.mark.asyncio
async def test_a_401_that_survives_the_refresh_is_unauthorized_and_stops(config, stub):
    server = stub(lambda _request: (401, "application/json", b'{"error":"unauthorized"}'))
    uploader = Uploader(replace(config, api_url=server.url), Tokens("t"), LOG)

    outcome = await uploader.upload(frame(), 1)
    await uploader.aclose()

    assert (outcome.ok, outcome.status, outcome.error) == (False, 401, "unauthorized")
    assert len(server.requests) == 2, "one retry, then the rig believes it"


@pytest.mark.asyncio
async def test_a_server_that_is_not_there_is_a_value_not_an_exception(config, stub):
    gone = stub(lambda _request: (201, "application/json", UPLOADED))
    url = gone.url
    gone.stop()
    uploader = Uploader(replace(config, api_url=url), Tokens("t"), LOG)

    outcome = await uploader.upload(frame(), 1)
    await uploader.aclose()

    assert (outcome.ok, outcome.status, outcome.error) == (False, 0, "transport")


@pytest.mark.asyncio
async def test_without_a_token_the_rig_does_not_make_the_request(config, stub):
    server = stub(lambda _request: (201, "application/json", UPLOADED))
    uploader = Uploader(replace(config, api_url=server.url), Tokens(None), LOG)

    outcome = await uploader.upload(frame(), 1)
    await uploader.aclose()

    assert (outcome.status, outcome.error) == (0, "unauthorized")
    assert server.requests == []


@pytest.mark.asyncio
async def test_a_token_store_that_raises_is_still_no_token(config, stub):
    server = stub(lambda _request: (201, "application/json", UPLOADED))
    uploader = Uploader(replace(config, api_url=server.url), BrokenTokens(), LOG)

    outcome = await uploader.upload(frame(), 1)
    await uploader.aclose()

    assert (outcome.status, outcome.error) == (0, "unauthorized")
    assert server.requests == []
