"""The rig's end of `WS /ws/desk` — the whole conversation with the server.

The socket is the only long-lived thing in the rig, and it is the only part that
has to survive everything: the server restarting, the token going stale, a frame
arriving that belongs to no line. So `run()` returns only when it is cancelled —
a rig that gave up on the socket would be a desk that went quiet for the rest of
the night — and each failure ends a connection, never the loop.

The order on the wire is the contract's: `hello` on open — the desk's caps ride
in it, there is no separate caps frame — then `desk.health` every five seconds,
actions in and `action.ack` out, and a spoken line as an `audio.out` header
followed immediately by its tagged `0x02` PCM.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import urllib.parse
from typing import TYPE_CHECKING, Any, Protocol

import websockets
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from . import AGENT_VERSION
from .registration import RegistrationError

if TYPE_CHECKING:
    # The frozen collaborators, for signatures only: importing cv2, httpx and
    # the arm driver just to name them would be paid by every user of this file.
    from .actions import Dispatcher
    from .arm.driver import ArmDriver
    from .audio import Speaker
    from .capture import CaptureLoop
    from .config import Config

__all__ = ["DeskClient", "DeskTokens"]


class DeskTokens(Protocol):
    """What the socket needs from a desk token store, and no more.

    The id is the extra over `upload.TokenSource`: `hello` has to name the desk
    it is, and inventing that name would be a desk the server cannot match to the
    token it just accepted. `DeskTokenStore` has both.
    """

    def token(self, refresh: bool = False) -> str | None: ...

    def desk_id(self) -> str: ...

#: The contract's subprotocol. The desk token rides in the query string, so the
#: negotiated protocol is only ever this.
SUBPROTOCOL = "heli.v1"

#: The heartbeat cadence the contract names.
HEALTH_INTERVAL_S = 5.0

#: The media tag that marks a binary frame as a line's PCM.
AUDIO_TAG = 0x02

#: Reconnect backoff: double from a second, capped at half a minute.
BACKOFF_INITIAL_S = 1.0
BACKOFF_MAX_S = 30.0
#: A connection that lasted this long counts as healthy, so the next outage
#: starts over from the floor instead of from wherever the last one left off.
STABLE_AFTER_S = 30.0

#: A line is PCM, not video: a thirty-second stereo line at 44.1 kHz is over
#: 5 MB, which the 1 MiB websocket default would refuse as a 1009 close in the
#: middle of the line.
MAX_FRAME_BYTES = 8 * 1024 * 1024

_NO_TOKEN = (
    "no desk token to connect with: set HELI_DESK_TOKEN for a desk that already has one, or make "
    "the server reachable so the rig can register its own"
)


def hello_frame(desk_id: str, camera: dict | None, arm: dict | None) -> dict:
    """The caps go in `hello`; there is no separate caps frame.

    A null camera or arm is the whole capability negotiation: the server sends no
    action for what is not there. Exported because `--doctor` sends the same frame
    to find out whether the server and this rig still agree on it.
    """
    return {
        "t": "hello",
        "deskId": desk_id,
        "agentVersion": AGENT_VERSION,
        "camera": camera,
        "arm": arm,
    }


class DeskClient:
    """Serves the desk's half of the socket until it is cancelled."""

    def __init__(
        self,
        cfg: Config,
        dispatcher: Dispatcher,
        capture: CaptureLoop,
        arm: ArmDriver | None,
        speaker: Speaker | None,
        tokens: DeskTokens,
        log: logging.Logger,
    ) -> None:
        self._cfg = cfg
        self._dispatcher = dispatcher
        self._capture = capture
        self._arm = arm
        self._speaker = speaker
        # The store, not merely a `TokenSource`: `hello` needs `desk_id()` too.
        self._tokens = tokens
        self._log = log
        self._ws: Any | None = None
        self._pending_audio: dict | None = None
        self._refreshed = False
        # The last arm pose failure, so a broken arm is one log line and not one
        # every five seconds.
        self._pose_error: str | None = None
        # The same, for a tracker that will not report its state.
        self._follow_error: str | None = None

    # ---- the loop ----------------------------------------------------------

    async def run(self) -> None:
        """Connect, serve, reconnect. Returns only when it is cancelled."""
        delay = BACKOFF_INITIAL_S
        while True:
            started = time.monotonic()
            try:
                await self._connected()
                self._log.warning("the desk socket closed without an error")
            except asyncio.CancelledError:
                raise
            except InvalidStatus as exc:
                self._log.warning(
                    "the server refused the desk socket: HTTP %d %s",
                    exc.response.status_code,
                    exc.response.reason_phrase,
                )
                # 401 is the one refusal the rig can fix by itself. Anything
                # else — a 404 on the path, a proxy in the way — is the server's
                # business and refreshing a token would not help.
                if exc.response.status_code == 401:
                    self._refresh_token_once()
            except InvalidHandshake as exc:
                self._log.warning("the desk socket handshake failed: %s", exc)
            except ConnectionClosed as exc:
                self._log.warning("the desk socket closed: %s", exc)
            except OSError as exc:
                # Connection refused, DNS, and the open timeout: all of them are
                # the network, and all of them are worth another try.
                self._log.warning("could not reach %s: %s", self._cfg.ws_url, exc)
            except RegistrationError as exc:
                # A server that has no desk route yet, or a rig that cannot reach
                # one: expected while the desk half is being built, and a
                # traceback every retry would bury the frames' own log lines.
                self._log.warning("the desk is not registered: %s", exc)
            except Exception:
                self._log.exception("the desk socket blew up")

            if time.monotonic() - started >= STABLE_AFTER_S:
                delay = BACKOFF_INITIAL_S
            self._log.info("reconnecting to %s in %.1fs", self._cfg.ws_url, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, BACKOFF_MAX_S)

    async def _connected(self) -> None:
        """One connection: hello, health, and the receive loop."""
        token = self._tokens.token()
        if not token:
            raise RegistrationError(_NO_TOKEN)
        url = f"{self._cfg.ws_url}?token={urllib.parse.quote(token, safe='')}"
        self._log.info("connecting to %s", self._cfg.ws_url)

        async with websockets.connect(
            url, subprotocols=[SUBPROTOCOL], max_size=MAX_FRAME_BYTES
        ) as ws:
            # A connection that opened is a token the server took, so the next
            # outage gets its own one refresh.
            self._refreshed = False
            self._ws = ws
            try:
                await ws.send(json.dumps(self._hello()))
                self._log.info("the desk socket is open as %s", self._desk_id())

                health = asyncio.create_task(self._health_loop(ws))
                try:
                    await self._receive(ws)
                finally:
                    health.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await health
            finally:
                self._ws = None
                # A line whose PCM never came must not outlive its connection.
                self._pending_audio = None

    def _refresh_token_once(self) -> None:
        """Ask for a fresh desk token, once per outage.

        Registering again is the only fix the rig owns for a token the server
        will not take. If that fails too — the API is down, the seeded user is
        gone — the error is logged and the reconnect keeps its backoff, because
        exiting here would be a desk that never comes back.
        """
        if self._refreshed:
            self._log.warning(
                "the freshened desk token was refused as well; check HELI_DESK_TOKEN "
                "(if it is set) and the desk's row on the server"
            )
            return
        self._refreshed = True
        self._log.info("asking for a fresh desk token")
        try:
            token = self._tokens.token(refresh=True)
        except Exception as exc:
            self._log.error("could not refresh the desk token: %s", exc)
            return
        if token:
            self._log.info("the desk token was refreshed")
        else:
            self._log.error("%s", _NO_TOKEN)

    # ---- what the desk says ------------------------------------------------

    def _hello(self) -> dict:
        """The caps go in `hello`; there is no separate caps frame.

        A null camera or arm is the whole capability negotiation: the server
        sends no action for what is not there. It goes out whatever the devices
        say about themselves — a rig whose camera will not describe itself still
        has a socket and a speaker.
        """
        return hello_frame(self._desk_id(), self._describe("camera"), self._describe("arm"))

    def _desk_id(self) -> str:
        """The id `hello` announces.

        The socket holds a `TokenSource`, which knows the token but not the id,
        while the store behind it knows both. The server keys the connection on
        the token and only warns when the two disagree, but a wiring mistake here
        should be loud rather than sent as an invented name.
        """
        getter = getattr(self._tokens, "desk_id", None)
        if not callable(getter):
            raise RegistrationError(
                "the desk socket needs a token store that can name its desk "
                f"(DeskTokenStore.desk_id); {type(self._tokens).__name__} cannot"
            )
        return str(getter())

    def _describe(self, which: str) -> dict | None:
        """`describe()` from whichever half of the rig `which` names."""
        device = self._capture_source() if which == "camera" else self._arm
        if device is None:
            return None
        try:
            caps = device.describe()
        except Exception as exc:
            self._log.warning("the %s would not describe itself: %s", which, exc)
            return None
        return caps if isinstance(caps, dict) else None

    def _capture_source(self) -> Any | None:
        """The `FrameSource` behind the capture loop: the camera caps live there."""
        return getattr(self._capture, "source", None)

    async def _health_loop(self, ws: Any) -> None:
        """`desk.health`, immediately and then every five seconds.

        The first one goes out as soon as the socket opens, so the server has a
        live desk from the moment it accepts the connection rather than five
        seconds later. Every field is read at send time: a heartbeat is a claim
        about now, and a cached one would be a claim about a while ago.
        """
        while True:
            try:
                await ws.send(json.dumps(await self._health()))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # The socket is gone. The receive loop is what notices that and
                # reconnects, so this task just ends and stays quiet about it.
                self._log.debug("stopped sending desk.health: %s", exc)
                return
            await asyncio.sleep(HEALTH_INTERVAL_S)

    async def _health(self) -> dict:
        try:
            state = self._capture.state() or {}
        except Exception as exc:
            self._log.warning("the capture loop would not report its state: %s", exc)
            state = {}

        fps = state.get("fps")
        last_frame_at = state.get("lastFrameAt")
        frames_sent = state.get("framesSent")
        return {
            "t": "desk.health",
            "fps": float(fps) if isinstance(fps, (int, float)) else 0.0,
            "lastFrameAt": last_frame_at if isinstance(last_frame_at, str) else None,
            "armPose": await self._arm_pose(),
            # macOS exposes no chip temperature to a process. The contract's
            # `tempC` is nullable, and a number here would be invented.
            "tempC": None,
            # The capture loop counts what the server accepted, less what it
            # refused; that counter is the loop's, not the socket's, because the
            # upload outcome never reaches this side.
            "framesSent": int(frames_sent) if isinstance(frames_sent, int) and frames_sent >= 0 else 0,
            "following": self._following(),
        }

    def _following(self) -> bool | None:
        """Whether the rig is following someone, or None when it has no tracker at all.

        `null` and `false` are different claims, which is why the contract's field is nullable: a
        rig with no tracker (no arm, `HELI_TRACKING=off`, the pieces not built) is not "not
        following" — it cannot follow, and the app's switch has nothing to turn on. The tracker is
        read off the dispatcher, which is where it was handed at wiring time, so there is one owner
        of it rather than two.
        """
        tracker = getattr(self._dispatcher, "tracker", None)
        if tracker is None:
            return None
        try:
            # `following`, not `state()['on']`: a rig that was asked to follow and whose arm
            # never took the mode is not following, and the app must not show a switch that
            # is on over an arm that is not moving.
            return bool(tracker.following)
        except Exception as exc:
            # A tracker that cannot answer is one log line, not a heartbeat that stops.
            if str(exc) != self._follow_error:
                self._follow_error = str(exc)
                self._log.warning("the tracker would not report its state: %s", exc)
            return None

    async def _arm_pose(self) -> dict | None:
        """Where the arm is, or null when there is no arm — or none that answers.

        A driver whose bus died mid-run is not a driver any more, but the rest of
        the desk keeps working, so the heartbeat reports no pose and says so once
        per distinct failure instead of every five seconds.
        """
        arm = self._arm
        if arm is None:
            return None
        try:
            pose = await asyncio.to_thread(arm.pose)
        except Exception as exc:
            if str(exc) != self._pose_error:
                self._pose_error = str(exc)
                self._log.warning("the arm would not report its pose: %s", exc)
            return None
        self._pose_error = None
        return {"pan": float(pose.pan), "tilt": float(pose.tilt)}

    # ---- what the server says ----------------------------------------------

    async def _receive(self, ws: Any) -> None:
        async for message in ws:
            if isinstance(message, bytes):
                await self._on_binary(message)
            else:
                await self._on_text(message)

    async def _on_text(self, raw: str) -> None:
        try:
            message = json.loads(raw)
        except ValueError:
            self._log.warning("the server sent text that is not JSON (%d bytes); dropped", len(raw))
            return
        if not isinstance(message, dict):
            self._log.warning("the server sent JSON that is not an object; dropped")
            return

        kind = message.get("t")
        if kind == "action":
            await self._on_action(message)
        elif kind == "audio.out":
            self._on_audio_header(message)
        elif kind == "error":
            # A refusal from the server is information, not a reason to hang up.
            self._log.warning(
                "the server reported %s: %s", message.get("code"), message.get("message")
            )
        else:
            self._log.debug("ignoring a %r message", kind)

    async def _on_action(self, message: dict) -> None:
        """The action *is* the message; its arguments are nested under `payload`."""
        ack = await self._dispatcher.handle(message)
        if not ack.get("actionId"):
            # Nothing to name, so nothing to send: the server matches an ack on
            # the id it issued. The dispatcher has already logged the reason.
            self._log.error("no ack could be sent for %r", message)
            return
        await self._send(ack)

    # ---- the spoken line ---------------------------------------------------

    def _on_audio_header(self, message: dict) -> None:
        """Remember the line's format; its PCM is the binary frame right behind it.

        The header is checked here rather than at playback so a line with an
        unusable format is one log line at the moment it arrives, and not a
        failure that looks like it happened while playing.
        """
        rate = message.get("sampleRate")
        channels = message.get("channels")
        if not _positive_int(rate) or not _positive_int(channels):
            self._log.warning(
                "audio.out with an unusable format (%r Hz, %r channels); the line is dropped",
                rate,
                channels,
            )
            self._pending_audio = None
            return

        if self._pending_audio is not None:
            self._log.warning(
                "a second audio.out arrived before the first line's PCM; keeping the newer header"
            )
        self._pending_audio = message

    async def _on_binary(self, frame: bytes) -> None:
        """A tagged binary frame. The only tag that means anything here is 0x02.

        `audio.out` announces a line and the very next binary frame is it, so a
        frame with no header before it is nothing this desk asked for: playing it
        would be a sound nobody scheduled.
        """
        header = self._pending_audio
        if header is None:
            self._log.warning(
                "dropped a %d-byte binary frame: no audio.out announced it", len(frame)
            )
            return

        tag = frame[0] if frame else None
        if tag != AUDIO_TAG:
            # Not the line's PCM. The frame is dropped rather than played as if
            # it were, and the header stays pending: the PCM the header promised
            # can still be the next thing to arrive.
            self._log.warning(
                "dropped a binary frame tagged %s while waiting for a line's 0x%02x audio",
                f"0x{tag:02x}" if tag is not None else "(empty)",
                AUDIO_TAG,
            )
            return

        self._pending_audio = None
        await self._play(header, frame[1:])

    async def _play(self, header: dict, pcm: bytes) -> None:
        """Play the line on the desk's own speakers, then ack it."""
        moment_id = header.get("momentId")
        if self._speaker is None:
            self._log.warning("the server spoke (%s) but this rig has no speaker", moment_id)
            await self._ack_line(moment_id, error="no_speaker")
            return

        before = self._speaker.state()
        duration_ms = header.get("durationMs")
        played = await asyncio.to_thread(
            self._speaker.play,
            pcm,
            int(header["sampleRate"]),
            int(header["channels"]),
            duration_ms if isinstance(duration_ms, int) else None,
        )
        after = self._speaker.state()

        if after.get("plays") != before.get("plays"):
            self._log.info("played %s for %d ms", moment_id, round(played))
            await self._ack_line(moment_id, duration_ms=int(round(played)))
            return

        if after.get("interrupted") != before.get("interrupted"):
            # A newer line ended this one. The server never queues two, so this
            # is the server having spoken twice; the ack says what became of
            # this line rather than calling it played.
            error = "interrupted"
        else:
            error = after.get("lastError") or "playback_failed"
        self._log.warning("could not play %s: %s", moment_id, error)
        await self._ack_line(moment_id, error=error)

    async def _ack_line(self, moment_id: Any, *, duration_ms: int | None = None, error: str | None = None) -> None:
        """Ack the line under the id it arrived with: its `momentId`."""
        if not isinstance(moment_id, str) or not moment_id:
            self._log.error("a line arrived with no momentId, so it cannot be acked")
            return
        await self._send(
            {
                "t": "action.ack",
                "actionId": moment_id,
                "status": "failed" if error else "done",
                "result": {"pose": None, "seq": None, "zoom": None, "durationMs": duration_ms},
                "error": error,
            }
        )

    async def _send(self, payload: dict) -> None:
        ws = self._ws
        if ws is None:
            # Only reachable through a close race: the receive loop that would
            # have carried this has already ended.
            self._log.debug("dropped a %r frame: the socket is closed", payload.get("t"))
            return
        await ws.send(json.dumps(payload))


def _positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0
