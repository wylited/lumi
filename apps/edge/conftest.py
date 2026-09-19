"""Shared fixtures: the settings a test starts from, and a real stub on loopback.

Nothing here patches the rig. The camera tests and the upload tests run the real
`ConsoleSource`, `Uploader` and `CaptureLoop` against a real HTTP server on a
loopback port, because the things worth asserting — the bytes that went out, the
status an outcome carries, a frame the source refuses to hand over — only exist
on the wire.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

import pytest

from heli_rig.config import Config, load


@dataclass(frozen=True)
class Request:
    """One request the stub saw, exactly as it arrived."""

    method: str
    path: str
    headers: dict[str, str]
    body: bytes


Responder = Callable[[Request], "tuple[int, str, bytes]"]


class StubServer:
    """A real HTTP server on a loopback port that answers whatever the test says.

    Deliberately dumb: a test is about what the rig does with an answer, so this
    only carries the answer, and the requests it saw.
    """

    def __init__(self, respond: Responder) -> None:
        self.requests: list[Request] = []
        self._respond = respond
        stub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:  # noqa: N802 — the name http.server calls
                self._handle("POST")

            def do_GET(self) -> None:  # noqa: N802
                self._handle("GET")

            def _handle(self, method: str) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length) if length else b""
                request = Request(
                    method=method,
                    path=self.path,
                    headers={key.lower(): value for key, value in self.headers.items()},
                    body=body,
                )
                stub.requests.append(request)
                status, content_type, payload = stub._respond(request)
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args: object) -> None:
                """Silence: the stub's own chatter is never the test's subject."""

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def answer(self, status: int, payload: bytes = b"", content_type: str = "application/json") -> None:
        """Answer every request with the same thing."""
        self._respond = lambda _request: (status, content_type, payload)

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


class ConsoleStub:
    """A stand-in for `tracking.visiond`'s console, with knobs for its state.

    `/api/streams` reports the frame age and what the vision process thinks its
    camera is; `/api/frame.jpg` serves the bytes. A test changes one attribute to
    make the console stale, unnamed or frame-less.
    """

    def __init__(self, jpeg: bytes, size: tuple[int, int] = (640, 480)) -> None:
        self.age_ms: float | None = 120.0
        self.camera_name: str | None = "USB Camera"
        self.size = size
        self.jpeg = jpeg
        self.running = True
        self.server = StubServer(self._respond)

    @property
    def url(self) -> str:
        return self.server.url

    @property
    def requests(self) -> list[Request]:
        return self.server.requests

    def stop(self) -> None:
        self.server.stop()

    def _respond(self, request: Request) -> tuple[int, str, bytes]:
        if request.path == "/api/streams":
            frame = {"path": "/tmp/frame.jpg", "bytes": len(self.jpeg), "age_ms": self.age_ms}
            snapshot = {"camera_name": self.camera_name, "size": list(self.size), "camera": 0}
            return 200, "application/json", json.dumps(
                {"frame": frame, "vision": {"running": self.running, "snapshot": snapshot}}
            ).encode()
        if request.path == "/api/frame.jpg":
            if not self.jpeg:
                return 404, "application/json", b'{"error":"no frame yet"}'
            return 200, "image/jpeg", self.jpeg
        return 404, "application/json", b'{"error":"no route"}'


@pytest.fixture
def config() -> Config:
    """The rig with every default and nothing at all from the environment."""
    return load(env={}, argv=[])


@pytest.fixture
def stub():
    """A factory for stub servers, every one of them stopped when the test ends."""
    made: list[StubServer] = []

    def make(respond: Responder) -> StubServer:
        server = StubServer(respond)
        made.append(server)
        return server

    yield make
    for server in made:
        server.stop()


@pytest.fixture
def console() -> ConsoleStub:
    """A stub console, stopped when the test ends."""
    stub = ConsoleStub(jpeg=b"")
    yield stub
    stub.stop()
