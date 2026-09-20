"""The rig's one write path: a JPEG in, a 201 or a reason out.

`upload` never raises. The capture loop runs for hours, and a server that is
down, slow or refusing is a state it has to survive rather than an exception it
has to handle: every answer the loop branches on is a value in `UploadOutcome`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

import httpx

from .camera import Frame
from .config import Config

FRAMES_PATH = "/v1/desk/frames"
UPLOAD_TIMEOUT_S = 10.0


class TokenSource(Protocol):
    """Where the bearer token comes from. `heli_rig.registration` is the real one.

    Synchronous by contract: it is called from the upload path, and the rig would
    rather block for one loopback request than grow a second async path for a
    token that is almost always already in hand.
    """

    def token(self, refresh: bool = False) -> str | None: ...


@dataclass(frozen=True)
class UploadOutcome:
    """What the server said, in the terms the loop acts on."""

    ok: bool
    status: int  # 0 when the request never left
    ref: str | None
    seq: int | None
    width: int | None
    height: int | None
    error: str | None  # 'no_open_session' | 'frame_rejected:<code>' | 'unauthorized' | 'transport'
    rejected: bool  # 422: never resend this frame


class Uploader:
    """`POST /v1/desk/frames`, once per frame, with one retry for an expired token."""

    def __init__(self, cfg: Config, tokens: TokenSource, log: logging.Logger) -> None:
        self._cfg = cfg
        self._tokens = tokens
        self._log = log
        self._client: httpx.AsyncClient | None = None

    async def upload(self, frame: Frame, seq: int, source: str = "camera") -> UploadOutcome:
        """Post one frame. The token is the only thing worth retrying.

        `source` is the tag the server stores the frame under: the cadence's own frames
        are `camera`, and a sweep's are `survey`, which is what keeps a deliberate reading
        of the desk out of the per-tick assessment.
        """
        token = self._token()
        if token is None:
            # No credentials at all. A request would be a guaranteed 401, so the
            # rig does not make one; the log says where the token should have
            # come from.
            self._log.debug("no desk token: the frame was not sent")
            return self._refused(0, "unauthorized")

        response = await self._post(frame, seq, token, source)
        if response is not None and response.status_code == 401:
            # The desk token is short-lived by design, so an expired one is the
            # expected failure. A second 401 is a configuration answer, not a
            # transient one, and is not retried again.
            refreshed = self._token(refresh=True)
            if refreshed is not None:
                response = await self._post(frame, seq, refreshed, source)
        if response is None:
            return self._refused(0, "transport")
        return self._read(response)

    def _token(self, refresh: bool = False) -> str | None:
        """Ask the store for a token.

        A store is allowed to raise while it registers — `heli_rig.registration`
        does — and `upload` is not allowed to raise at all, so the failure turns
        into "no token" here and the loop reports it once, where a person can see
        which desk is unauthenticated.
        """
        try:
            return self._tokens.token(refresh=refresh)
        except Exception as exc:
            self._log.debug("the token store did not answer: %s", exc)
            return None

    async def aclose(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    def _http(self) -> httpx.AsyncClient:
        # 10 s: a frame that takes longer than that is stale by the time it lands,
        # and the loop is already skipping ticks while this one is in flight.
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=UPLOAD_TIMEOUT_S)
        return self._client

    async def _post(self, frame: Frame, seq: int, token: str, source: str) -> httpx.Response | None:
        try:
            return await self._http().post(
                f"{self._cfg.api_url}{FRAMES_PATH}",
                content=frame.jpeg,
                headers={
                    "content-type": "image/jpeg",
                    "authorization": f"Bearer {token}",
                    "x-heli-captured-at": frame.captured_at,
                    # Which lens this frame came from, in the contract's vocabulary. A
                    # survey frame is not a live one: the server keeps the sources apart
                    # rather than letting a desk reading overwrite the frame the loop is
                    # assessing.
                    "x-heli-source": source,
                    "x-heli-seq": str(seq),
                },
            )
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            # A POST that never got an answer may still have landed, so the rig
            # does not retry it: the next frame supersedes it either way.
            self._log.debug("upload did not complete: %s", exc)
            return None

    def _read(self, response: httpx.Response) -> UploadOutcome:
        status = response.status_code
        if status == 201:
            body = _json_object(response)
            if body is None:
                # The frame landed — the status says so — but the rig cannot name
                # its ref. Better to say that than to invent one.
                self._log.warning("201 without a readable body: the frame landed, its ref is unknown")
                return UploadOutcome(True, 201, None, None, None, None, None, False)
            ref = body.get("ref")
            return UploadOutcome(
                ok=True,
                status=201,
                ref=ref if isinstance(ref, str) else None,
                seq=_int_or_none(body.get("seq")),
                width=_int_or_none(body.get("width")),
                height=_int_or_none(body.get("height")),
                error=None,
                rejected=False,
            )
        if status == 409:
            return self._refused(409, "no_open_session")
        if status == 422:
            code = _dig(response, "code")
            return self._refused(422, f"frame_rejected:{code if isinstance(code, str) else 'unknown'}", rejected=True)
        if status == 401:
            return self._refused(401, "unauthorized")
        return self._refused(status, f"http_{status}")

    @staticmethod
    def _refused(status: int, error: str, rejected: bool = False) -> UploadOutcome:
        return UploadOutcome(False, status, None, None, None, None, error, rejected)


def _json_object(response: httpx.Response) -> dict | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def _dig(response: httpx.Response, key: str) -> object:
    payload = _json_object(response)
    return None if payload is None else payload.get(key)


def _int_or_none(value: object) -> int | None:
    # `isinstance(True, int)` is true, and a boolean is not a sequence number.
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value
