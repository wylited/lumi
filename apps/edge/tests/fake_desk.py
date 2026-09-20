"""The desk socket's stand-ins: a real websocket server, and a whole fake rig.

`FakeDesk` is a `websockets` server on a free port rather than a mocked object:
the client under test opens a real connection, the handshake it presents — the
token in the query string, the `heli.v1` subprotocol — is the handshake the fake
sees, and every frame the rig sends is recorded as it arrives. What a test
asserts is therefore what went over the wire.

The rig side is stood in the same way and for the same reason. `FakeCapture`,
`FakeArm`, `FakeSpeaker` and `StubTokens` are the collaborators the frozen
constructors take; they record what they were asked to do so a test can point at
the frame that was taken, the line that reached the speaker, or the token that
was refreshed — never at how the client called them internally.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterable

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from heli_rig.arm.driver import ArmPose
from heli_rig.camera import Frame
from heli_rig.capture import CaptureResult
from heli_rig.config import Config, load
from heli_rig.upload import UploadOutcome

__all__ = [
    "FakeApi",
    "FakeArm",
    "FakeCapture",
    "FakeDesk",
    "FakeSource",
    "FakeSpeaker",
    "StubTokens",
    "rig_config",
    "wait_until",
]

#: The contract's subprotocol name, spelled out here rather than imported from
#: the client: the fake has to agree with the contract, not with the code under
#: test, or it would agree with a bug.
SUBPROTOCOL = "heli.v1"

DESK_PATH = "/ws/desk"

#: What `FakeCapture` answers with when the test did not script a refusal: a frame
#: the server took, so a `capture` action can ack the seq the fake handed back.
ACCEPTED = UploadOutcome(ok=True, status=201, ref="ref", seq=None, width=640, height=480, error=None, rejected=False)

log = logging.getLogger("tests.fake_desk")


async def wait_until(predicate: Callable[[], bool], *, timeout: float = 5.0, what: str = "it") -> None:
    """Poll `predicate` until it holds.

    An idle `sleep` asserts nothing: every wait in these tests is on something
    observable — a frame on the wire, a connection count — and fails with the
    thing it waited for.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"timed out after {timeout:.1f}s waiting for {what}")


class FakeDesk:
    """A websocket server that stands in for `WS /ws/desk`."""

    def __init__(self, *, deny_tokens: Iterable[str] = (), deny_status: int = 401) -> None:
        #: Tokens the handshake refuses, so a test can watch the rig refresh one.
        self._deny = set(deny_tokens)
        self._deny_status = deny_status
        self._server: Server | None = None
        self._ws: ServerConnection | None = None
        self._arrived = asyncio.Event()

        #: What the server saw.
        self.url: str | None = None
        self.port: int | None = None
        self.handshakes: list[dict] = []
        self.messages: list[dict] = []
        self.binary: list[bytes] = []
        self.connections = 0

    # ---- lifecycle ---------------------------------------------------------

    async def start(self) -> str:
        self._server = await serve(
            self._handler,
            "127.0.0.1",
            0,
            subprotocols=[SUBPROTOCOL],
            process_request=self._process_request,
            # The fake is not the subject of the test: its own chatter would be
            # noise in a failing assertion.
            logger=logging.getLogger("tests.fake_desk.server"),
        )
        self.port = self._server.sockets[0].getsockname()[1]
        self.url = f"ws://127.0.0.1:{self.port}{DESK_PATH}"
        return self.url

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    async def drop(self) -> None:
        """Close the client's connection the way a restarting server would."""
        if self._ws is not None:
            await self._ws.close(code=1001, reason="going away")

    def _process_request(self, connection: ServerConnection, request: Any):
        token = urllib.parse.parse_qs(urllib.parse.urlparse(request.path).query).get(
            "token", [None]
        )[0]
        # Negotiation happens after this hook, so the requested protocols are
        # still in the header — which is also where they are on the wire.
        offered = request.headers.get("Sec-WebSocket-Protocol") or ""
        self.handshakes.append(
            {
                "path": request.path,
                "token": token,
                "subprotocols": [name.strip() for name in offered.split(",") if name.strip()],
                # When it arrived, so a test can watch the reconnect backoff
                # without reaching into the client's clock.
                "at": time.monotonic(),
            }
        )
        if token in self._deny:
            return connection.respond(self._deny_status, "refused\n")
        return None

    async def _handler(self, ws: ServerConnection) -> None:
        self._ws = ws
        self.connections += 1
        try:
            async for message in ws:
                if isinstance(message, bytes):
                    self.binary.append(message)
                else:
                    self.messages.append(json.loads(message))
                self._arrived.set()
        except ConnectionClosed:
            pass  # a client that went away is the test's own doing, not a fault

    # ---- what arrived ------------------------------------------------------

    @property
    def acks(self) -> list[dict]:
        return self.of_type("action.ack")

    def of_type(self, kind: str) -> list[dict]:
        return [message for message in self.messages if message.get("t") == kind]

    async def wait_for(
        self, predicate: Callable[[dict], bool], *, timeout: float = 5.0, what: str = "a frame"
    ) -> dict:
        await wait_until(lambda: any(predicate(m) for m in self.messages), timeout=timeout, what=what)
        return next(m for m in self.messages if predicate(m))

    async def wait_for_type(self, kind: str, *, timeout: float = 5.0) -> dict:
        return await self.wait_for(lambda m: m.get("t") == kind, timeout=timeout, what=f"a {kind} frame")

    async def wait_for_connection(self, count: int = 1, *, timeout: float = 5.0) -> None:
        await wait_until(lambda: self.connections >= count, timeout=timeout, what=f"{count} connection(s)")

    async def wait_for_acks(self, count: int = 1, *, timeout: float = 5.0) -> None:
        await wait_until(lambda: len(self.acks) >= count, timeout=timeout, what=f"{count} ack(s)")

    # ---- what the server says ----------------------------------------------

    async def send(self, payload: dict) -> None:
        assert self._ws is not None, "no client is connected"
        await self._ws.send(json.dumps(payload))

    async def send_bytes(self, data: bytes) -> None:
        assert self._ws is not None, "no client is connected"
        await self._ws.send(data)


class FakeSource:
    """A `FrameSource` whose `describe()` is whatever the test says the camera has."""

    def __init__(self, caps: dict | None = None) -> None:
        self.caps = caps
        self.describes = 0

    def describe(self) -> dict | None:
        self.describes += 1
        return self.caps


class FakeCapture:
    """A capture loop: the frames it was given, and the cadence it was asked for.

    `capture_now` answers the way the real loop does - the frame it took, the seq it
    uploaded it under, and what the server said - so the `capture` action acks the seq
    this fake handed it. `outcome` is what the server said about that frame: None means
    the upload was taken, and a refused one is what the action has to report instead of a
    `done` naming a frame the server never stored. `state()['lastSeq']` counts from
    `last_seq`, which is the cadence's own number and what the heartbeat reports.
    """

    def __init__(
        self,
        frames: Iterable[Frame] | None = None,
        *,
        fps: float = 2.0,
        last_seq: int = 0,
        frames_sent: int = 0,
        outcome: UploadOutcome | None = None,
    ):
        self._frames = list(frames or [])
        self._fps = float(fps)
        self.source: FakeSource | None = None
        self.last_seq = last_seq
        #: What the server accepted, less what it refused. Deliberately separate
        #: from `last_seq`: a health frame that reported frames *taken* would
        #: look right until an upload was refused.
        self.frames_sent = frames_sent
        self.last_frame_at: str | None = None
        self.capture_calls = 0
        self.fps_calls: list[float] = []
        #: None means "the upload was taken"; a refused one is what the action has to
        #: report instead of a `done` naming a frame the server never stored.
        self.outcome = outcome

    async def capture_now(self) -> CaptureResult | None:
        self.capture_calls += 1
        if not self._frames:
            return None
        frame = self._frames.pop(0)
        self.last_seq += 1
        self.frames_sent += 1
        self.last_frame_at = frame.captured_at
        return CaptureResult(frame=frame, seq=self.last_seq, outcome=self.outcome or ACCEPTED)

    def set_fps(self, fps: float) -> None:
        self._fps = float(fps)
        self.fps_calls.append(float(fps))

    def state(self) -> dict:
        return {
            "fps": self._fps,
            "lastFrameAt": self.last_frame_at,
            "lastSeq": self.last_seq,
            "frames": self.last_seq,
            "framesSent": self.frames_sent,
        }


class FakeArm:
    """An arm driver that answers with a pose, or raises what it was told to.

    `achieved` is deliberately the test's own choice: the ack has to carry where
    the arm *went*, which is not where it was asked to go.
    """

    def __init__(
        self,
        *,
        achieved: ArmPose | None = None,
        caps: dict | None = None,
        fails: BaseException | None = None,
        nod_seconds: float = 0.0,
    ) -> None:
        self.achieved = achieved if achieved is not None else ArmPose(pan=12.0, tilt=-4.0)
        self.caps = caps
        self.calls: list[tuple] = []
        self._fails = fails
        #: A nod takes time on a real arm, and the ack is supposed to say how much.
        self.nod_seconds = nod_seconds

    def _record(self, *call: Any) -> None:
        self.calls.append(call)
        if self._fails is not None:
            raise self._fails

    def connect(self) -> None:
        self._record("connect")

    def is_connected(self) -> bool:
        return True

    def pose(self) -> ArmPose:
        self._record("pose")
        return self.achieved

    def aim(self, pan: float, tilt: float) -> ArmPose:
        self._record("aim", pan, tilt)
        return self.achieved

    def point(self, x: float, y: float) -> ArmPose:
        self._record("point", x, y)
        return self.achieved

    def nod(self, times: int = 1) -> None:
        if self.nod_seconds:
            time.sleep(self.nod_seconds)
        self._record("nod", times)

    def home(self) -> ArmPose:
        self._record("home")
        return self.achieved

    def describe(self) -> dict | None:
        return self.caps

    def close(self) -> None:
        self._record("close")


class FakeSpeaker:
    """A speaker that records the line instead of playing it.

    Its `state()` follows the real `Speaker`: `plays` counts only the lines that
    played, and a failure leaves `lastError` set — which is what the socket
    branches on to ack a line.
    """

    def __init__(self, *, fail_with: str | None = None) -> None:
        self._fail_with = fail_with
        self._plays = 0
        self._interrupted = 0
        self._last_duration_ms = 0.0
        self.lines: list[dict] = []

    def play(self, pcm: bytes, sample_rate: int, channels: int, duration_ms: int | None = None) -> float:
        self.lines.append(
            {"pcm": pcm, "sampleRate": sample_rate, "channels": channels, "durationMs": duration_ms}
        )
        played = (
            float(duration_ms)
            if duration_ms is not None
            else len(pcm) / (2 * max(channels, 1)) / sample_rate * 1000.0
        )
        self._last_duration_ms = played
        if self._fail_with is None:
            self._plays += 1
        return played

    @property
    def busy(self) -> bool:
        return False

    def stop(self) -> None:
        self._interrupted += 1

    def state(self) -> dict:
        return {
            "playing": False,
            "lastDurationMs": self._last_duration_ms,
            "lastError": self._fail_with,
            "plays": self._plays,
            "interrupted": self._interrupted,
            "lastWav": None,
        }


class StubTokens:
    """The desk's token store as the socket uses it: a token, an id, and refreshes."""

    def __init__(
        self,
        token: str = "desk-token",
        *,
        refresh_token: str | None = None,
        desk_id: str = "heli-0f1e2d3c",
    ) -> None:
        self._token = token
        self._refresh_token = token if refresh_token is None else refresh_token
        self._desk_id = desk_id
        self.refreshes = 0
        self.asked: list[bool] = []

    def token(self, refresh: bool = False) -> str | None:
        self.asked.append(refresh)
        if refresh:
            self.refreshes += 1
            self._token = self._refresh_token
        return self._token

    def desk_id(self) -> str:
        return self._desk_id


class FakeApi:
    """A real HTTP server for the two routes registration talks to.

    It answers the way the server does — dev-login first, then a desk token — and
    keeps the requests, so a test can assert the `Bearer` the desk presented and
    that a re-run sent the same `deskId` rather than a new one.
    """

    def __init__(self, *, user_token: str = "user-token", desk_token: str = "desk-token") -> None:
        self.user_token = user_token
        self.desk_token = desk_token
        #: Set to refuse dev-login, e.g. 503 for a database with no seeded user.
        self.login_status = 200
        self.requests: list[dict] = []
        #: deskId -> the registration body, so a second run is visible as an update.
        self.desks: dict[str, dict] = {}

        api = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 — the stdlib's name
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length) if length else b""
                api.requests.append(
                    {
                        "path": self.path,
                        "authorization": self.headers.get("authorization"),
                        "body": body,
                    }
                )

                if self.path == "/v1/auth/dev-login":
                    if api.login_status != 200:
                        api.reply(self, api.login_status, {"error": "no_user"})
                    else:
                        api.reply(
                            self,
                            200,
                            {
                                "token": api.user_token,
                                "user": {
                                    "id": "u1",
                                    "email": "me@heli.local",
                                    "name": "Ari",
                                    "createdAt": "2026-09-19T00:00:00.000Z",
                                },
                            },
                        )
                    return

                if self.path == "/v1/desks":
                    if self.headers.get("authorization") != f"Bearer {api.user_token}":
                        api.reply(self, 401, {"error": "unauthorized"})
                        return
                    registered = json.loads(body)
                    api.desks[registered["deskId"]] = registered
                    api.reply(
                        self,
                        200,
                        {
                            # `DeskRegisterResponse`: the desk and the token the
                            # rig keeps, and nothing else.
                            "desk": {
                                "id": registered["deskId"],
                                "name": registered["name"],
                                "camera": registered["camera"],
                                "arm": registered["arm"],
                                "registeredAt": "2026-09-19T00:00:00.000Z",
                                "lastSeenAt": None,
                            },
                            "deskToken": api.desk_token,
                        },
                    )
                    return

                api.reply(self, 404, {"error": "not_found"})

            def log_message(self, *args: Any) -> None:
                pass  # the fake's chatter would be noise in a failing assertion

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def reply(self, handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        handler.send_response(status)
        handler.send_header("content-type", "application/json")
        handler.send_header("content-length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)

    def of_path(self, path: str) -> list[dict]:
        return [request for request in self.requests if request["path"] == path]


def rig_config(tmp_path: Path, *, api_url: str, **env: str) -> Config:
    """A `Config` for a desk whose `~/.heli` is the test's own directory.

    Built through `config.load` with the mapping and not `os.environ`, so a
    developer's real `HELI_*` variables cannot reach into a test, and with an
    empty `argv` — `load` reads `sys.argv` otherwise and would find pytest's own
    flags.
    """
    values = {"HELI_API_URL": api_url, "HELI_DIR": str(tmp_path / "heli")}
    values.update(env)
    return load(env=values, argv=[])
