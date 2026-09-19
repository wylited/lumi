"""What this machine has, asked before the rig pretends to be one.

`heli-rig --doctor` answers the question a freshly installed laptop asks: *will it work?* It walks
the things the rig needs in the order they fail — the server, a token for the user routes, a session
to upload into, the desk's own registration and socket, the camera, one real upload, the arm, the
desk plane the arm points with, the speaker — and prints one line per item saying what was found
and, when it is wrong, the command that fixes it.

The exit code is the verdict: 2 when something the rig cannot work without is missing, 1 when the
rig runs but the demo will be partial (no arm, no desk plane recorded), 0 when it is ready.

The report goes to stdout and the log stays on stderr, so the report can be read, piped or diffed
on a machine whose log level is debug.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import websockets

from .camera import CameraUnavailable, Frame, FrameSource
from .config import Config
from .socket import SUBPROTOCOL, hello_frame
from .upload import Uploader

HTTP_TIMEOUT_S = 5.0
SOCKET_TIMEOUT_S = 5.0
# How long `hello` waits for the server to complain about it. The desk socket has no ack for a
# hello: silence is the server agreeing, and an error frame is the only thing worth waiting for.
HELLO_QUIET_S = 1.5
DESK_PATH = "/v1/desk"
SESSION_BODY = '{"deviceId":"dev_seed","goalId":"goal_seed"}'
# The session a fresh database does not have: the seed writes only a closed one, and nothing in the
# desktop app opens another yet, so this command is how a person starts watching.
SESSION_FIX = (
    "open one (the desktop app cannot yet): curl -sX POST $HELI_API_URL/v1/sessions "
    f"-H \"authorization: Bearer $USER_TOKEN\" -H 'content-type: application/json' -d '{SESSION_BODY}'"
)

OK, WARN, FAIL = "ok", "warn", "fail"


@dataclass
class Rig:
    """What `--doctor` is handed: the same pieces the long-running rig builds, unstarted."""

    cfg: Config
    log: logging.Logger
    source: FrameSource
    uploader: Uploader
    arm: Any | None
    #: The user token the frames and desk-read routes want, minted from the dev-login bootstrap.
    user_tokens: Any
    #: The desk token store: `--doctor` registers the desk the same way the rig does.
    desk_tokens: Any
    #: Why there is no arm, in the arm's own words (`open_arm`'s warning), or None.
    arm_note: str | None = None
    #: Why there is no camera, in the camera's own words, or None.
    camera_note: str | None = None


@dataclass
class Report:
    """The findings, in the order they were made."""

    findings: list[tuple[str, str, str, str | None]] = field(default_factory=list)

    def add(self, level: str, name: str, detail: str, fix: str | None = None) -> None:
        self.findings.append((level, name, detail, fix))

    @property
    def verdict(self) -> int:
        """2 blocked, 1 degraded, 0 ready — the same order the levels are printed in."""
        levels = {level for level, _, _, _ in self.findings}
        if FAIL in levels:
            return 2
        return 1 if WARN in levels else 0


def _say(text: str = "") -> None:
    """The report is the tool's output, so it goes to stdout and it is always flushed."""
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


async def doctor(rig: Rig) -> int:
    """Walk the rig's requirements, print the findings, and answer with the exit code."""
    report = Report()
    cfg = rig.cfg
    report.add(
        OK,
        "this rig",
        f"server {cfg.api_url} (socket {cfg.ws_url}), camera {cfg.camera_source}, "
        f"arm {cfg.arm_driver}, state {cfg.heli_dir}, {cfg.fps:g} fps",
    )

    if not await _server(rig, report):
        _print(rig, report)
        return report.verdict

    token = _user_token(rig, report)
    if token is not None:
        await _watch(rig, report, token)
    await _desk(rig, report)
    await _desk_socket(rig, report)
    frame = await _camera(rig, report)
    if frame is not None:
        await _upload(rig, report, frame)
    _arm(rig, report)
    _desk_plane(rig, report)
    _speaker(rig, report)

    _print(rig, report)
    return report.verdict


# ------------------------------------------------------------------ the checks


async def _server(rig: Rig, report: Report) -> bool:
    """`GET /healthz`: without the server there is nothing else to check."""
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S) as client:
            response = await client.get(f"{rig.cfg.api_url}/healthz")
        response.raise_for_status()
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        report.add(
            FAIL,
            "server",
            f"no answer from {rig.cfg.api_url}/healthz: {exc}",
            "start it: docker compose -f apps/server/docker-compose.yml up -d, then "
            "pnpm install && pnpm --filter @heli/server db:reset && pnpm --filter @heli/server dev",
        )
        return False
    report.add(OK, "server", f"{rig.cfg.api_url}/healthz answered {response.status_code}")
    return True


def _user_token(rig: Rig, report: Report) -> str | None:
    """The token the frames and desk-read routes take: a *user* token, from the dev-login bootstrap."""
    try:
        token = rig.user_tokens.token()
    except Exception as exc:
        token = None
        detail = str(exc)
    else:
        detail = "dev-login answered without a token"
    if not token:
        report.add(
            FAIL,
            "user token",
            f"the frames route authenticates the person, so the rig borrows a token: {detail}",
            "seed the user and try again: pnpm --filter @heli/server db:reset (it creates user_seed, "
            "and POST /v1/auth/dev-login hands out a token for it)",
        )
        return None
    report.add(OK, "user token", "the dev-login bootstrap handed over a user token for the uploads")
    return str(token)


async def _watch(rig: Rig, report: Report, token: str) -> None:
    """`GET /v1/desk`: no open session means every upload is refused 409 and the loop watches nobody."""
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S) as client:
            response = await client.get(
                f"{rig.cfg.api_url}{DESK_PATH}", headers={"authorization": f"Bearer {token}"}
            )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        report.add(
            WARN, "watch", f"{DESK_PATH} did not answer with the desk: {exc}", None
        )
        return
    session = payload.get("session") if isinstance(payload, dict) else None
    desk = payload.get("desk") if isinstance(payload, dict) else None
    if isinstance(session, dict) and session.get("id"):
        report.add(
            OK,
            "watch",
            f"a session is open ({session.get('id')}), and the desk row is "
            f"{desk.get('id') if isinstance(desk, dict) else 'not registered yet'}",
        )
        return
    report.add(
        FAIL,
        "watch",
        "no session is open: frames are answered 409 and the observation loop watches nobody",
        SESSION_FIX,
    )


async def _desk(rig: Rig, report: Report) -> None:
    """`POST /v1/desks`, through the same store the rig registers with."""
    try:
        token = rig.desk_tokens.token()
        desk_id = rig.desk_tokens.desk_id()
    except Exception as exc:
        report.add(
            FAIL,
            "desk",
            f"the desk could not register: {exc}",
            "a desk route that fails on a database that predates a schema change answers 500 with a "
            "Prisma validation error: pnpm --filter @heli/server exec prisma db push && "
            "pnpm --filter @heli/server db:generate (or db:reset on a database you can throw away)",
        )
        return
    if not token:
        report.add(FAIL, "desk", "registration answered without a desk token", None)
        return
    ours = rig.desk_tokens.desk_id()
    # A desk row is keyed by the id the rig keeps in its own state file, while `GET /v1/desk`
    # answers with the *first* row ever registered (`findFirst` by `registeredAt`). A second
    # rig on one server therefore registers a row that nothing watches, and a person reading
    # this report has to be able to see that the two ids differ.
    theirs = await _reported_desk_id(rig)
    if theirs is not None and theirs != ours:
        report.add(
            WARN,
            "desk",
            f"registered as {ours}; its token is the one the socket presents, but {DESK_PATH} "
            f"reports {theirs} — a row from an earlier run, which is the one the loop watches",
            f"a desk row is keyed by the id the rig keeps in HELI_DIR, and {DESK_PATH} answers with "
            "the first row ever registered, so a second rig is invisible to it: stop the other rig, "
            "give this one a server of its own (HELI_API_URL), or clear the desks on a database you "
            "can throw away",
        )
        return
    report.add(OK, "desk", f"registered as {ours}; its token is the one the socket presents")


async def _reported_desk_id(rig: Rig) -> str | None:
    """The desk id `GET /v1/desk` answers with, or None when it cannot be read."""
    try:
        token = rig.user_tokens.token()
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S) as client:
            response = await client.get(
                f"{rig.cfg.api_url}{DESK_PATH}", headers={"authorization": f"Bearer {token}"}
            )
        response.raise_for_status()
        desk = response.json().get("desk") or {}
        return desk.get("id")
    except (httpx.HTTPError, ValueError, KeyError):
        return None


async def _desk_socket(rig: Rig, report: Report) -> None:
    """Open `/ws/desk`, send the same `hello` the run sends, and see whether it draws an error."""
    try:
        token = rig.desk_tokens.token()
        desk_id = rig.desk_tokens.desk_id()
    except Exception as exc:
        report.add(WARN, "desk socket", f"not opened: the desk is not registered ({exc})", None)
        return
    if not token:
        report.add(WARN, "desk socket", "not opened: there is no desk token", None)
        return
    try:
        async with websockets.connect(
            f"{rig.cfg.ws_url}?token={token}", subprotocols=[SUBPROTOCOL], open_timeout=SOCKET_TIMEOUT_S
        ) as ws:
            await ws.send(json.dumps(hello_frame(desk_id, _describe(rig.source), _describe(rig.arm))))
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=HELLO_QUIET_S)
            except asyncio.TimeoutError:
                report.add(OK, "desk socket", f"{rig.cfg.ws_url} took the desk token and accepted hello")
                return
    except Exception as exc:
        report.add(
            FAIL,
            "desk socket",
            f"{rig.cfg.ws_url} refused the connection: {exc}",
            "the desk socket takes the desk token (not the user one) and the subprotocol heli.v1; "
            "a 404 means the server on this port is not the desk server",
        )
        return
    report.add(WARN, "desk socket", f"hello drew an answer: {str(raw)[:200]}", None)


async def _camera(rig: Rig, report: Report) -> Frame | None:
    """One frame from the configured source: the console's, or the device opened directly."""
    try:
        if not await rig.source.is_open():
            await rig.source.open()
        frame = await rig.source.grab()
    except CameraUnavailable as exc:
        report.add(
            FAIL,
            "camera",
            f"no frame: {exc}",
            f"check the camera source (HELI_CONSOLE_URL is {rig.cfg.console_url}), then permission: "
            "grant Camera to whatever runs the rig (System Settings → Privacy & Security → Camera). "
            f"HELI_CAMERA_SOURCE=opencv opens the device itself (index {rig.cfg.camera_index}) when no "
            "console holds it",
        )
        return None
    caps = rig.source.describe() or {}
    report.add(
        OK,
        "camera",
        f"{caps.get('model', 'a camera')} at {frame.width}x{frame.height}, "
        f"{len(frame.jpeg) / 1024:.0f} KiB per frame",
    )
    return frame


async def _upload(rig: Rig, report: Report, frame: Frame) -> None:
    """One real upload: the only check that covers the token, the session, the store and the schema."""
    outcome = await rig.uploader.upload(frame, 1)
    if outcome.ok:
        report.add(
            OK,
            "upload",
            f"{len(frame.jpeg) / 1024:.0f} KiB accepted as {outcome.ref} (seq {outcome.seq})",
        )
        return
    fix = {
        "unauthorized": "the frames route wants a user token: check that POST /v1/auth/dev-login "
        "answers, and that the user it names exists (pnpm --filter @heli/server db:reset)",
        "no_open_session": SESSION_FIX,
        "transport": "the server stopped answering: is it still up?",
    }.get(outcome.error or "", "")
    if outcome.status >= 500:
        fix = (
            "a 500 here is the server's own: check the object store (MEDIA_ENABLED / S3_*, e.g. the "
            "MinIO from docker compose) and the schema (pnpm --filter @heli/server exec prisma db push)"
        )
    report.add(
        FAIL,
        "upload",
        f"the frame was not stored: {outcome.error} (status {outcome.status})",
        fix or None,
    )


def _arm(rig: Rig, report: Report) -> None:
    """Whether the arm can be driven — and, when it cannot, the arm's own words about why."""
    if rig.arm is None and rig.cfg.arm_driver == "none":
        # Not a miss: this rig is meant to have no arm. The server is told so at hello,
        # and sends it nothing that needs one.
        report.add(
            OK,
            "arm",
            "no arm, by HELI_ARM_DRIVER=none: the desk registers arm: null and every arm.* is "
            "answered no_arm without being sent",
        )
        return
    if rig.arm is None:
        report.add(
            WARN,
            "arm",
            f"{rig.arm_note or 'no arm: nothing answered'}",
            "an arm needs either the operator console (which owns the serial bus while it runs) or "
            "the bridge project: HELI_BRIDGE_DIR (default ~/Repos/tracking, the project with "
            "`tracking.bridge` and lerobot) and HELI_BRIDGE_PYTHON if its interpreter is elsewhere. "
            "Without one every arm.* action is answered no_arm",
        )
        return
    try:
        pose = rig.arm.pose()
        detail = f"{rig.arm.describe()} at pan {pose.pan:.1f} tilt {pose.tilt:.1f}"
    except Exception as exc:
        report.add(WARN, "arm", f"the arm is configured but would not answer: {exc}", None)
        return
    report.add(OK, "arm", detail)


def _desk_plane(rig: Rig, report: Report) -> None:
    """The calibration `arm.point` needs. `arm.aim` works without it; pointing at the page does not."""
    try:
        from .arm.calibration import MIN_POSES, RIG_FILE, Calibration
    except ImportError:
        report.add(WARN, "desk plane", "the arm half is not in this tree, so nothing points", None)
        return
    calibration = Calibration.load(Path(rig.cfg.heli_dir) / RIG_FILE)
    poses = len(calibration.poses)
    if poses >= MIN_POSES:
        rect = calibration.rect() or {}
        report.add(
            OK,
            "desk plane",
            f"{poses} poses recorded"
            + (f" for a {rect.get('w', 0):g}x{rect.get('h', 0):g} mm rectangle" if rect else ""),
        )
        return
    report.add(
        WARN,
        "desk plane",
        f"{poses} pose(s) recorded, and arm.point needs {MIN_POSES} spanning the desk plane",
        "record it on this machine, with the arm free: heli-rig --calibrate --rect x,y,w,h "
        "(millimetres of the desk area). arm.aim works without it; pointing at a page does not",
    )


def _speaker(rig: Rig, report: Report) -> None:
    """Playing the line needs `afplay` (what `heli_rig.audio.Speaker` shells out to)."""
    if not rig.cfg.speaker:
        report.add(
            WARN,
            "speaker",
            "HELI_SPEAKER=false: a spoken line is acked no_speaker rather than played",
            None,
        )
        return
    player = shutil.which("afplay")
    if player is None:
        report.add(
            WARN,
            "speaker",
            "afplay is not on PATH, so the line cannot be played",
            "afplay ships with macOS at /usr/bin/afplay; a rig without it still acks the line",
        )
        return
    report.add(OK, "speaker", f"the line plays through {player}")


# ------------------------------------------------------------------ the report


def _describe(device: Any | None) -> dict | None:
    """`describe()` from a source or an arm, or None when there is nothing to ask."""
    if device is None:
        return None
    try:
        caps = device.describe()
    except Exception:
        return None
    return caps if isinstance(caps, dict) else None


def _print(rig: Rig, report: Report) -> None:
    """One line per check, and the fix under the ones that need one."""
    _say()
    for level, name, detail, fix in report.findings:
        _say(f"{level:<4} {name:<12} {detail}")
        if fix:
            _say(f"     {'':<12} -> {fix}")
    blocked = [name for level, name, _, _ in report.findings if level == FAIL]
    degraded = [name for level, name, _, _ in report.findings if level == WARN]
    _say()
    if blocked:
        _say(f"not ready: {', '.join(blocked)} must be fixed before the rig does its job")
    elif degraded:
        _say(f"ready, with less than everything: {', '.join(degraded)}")
    else:
        _say(f"ready: {rig.cfg.api_url} will take frames from this machine's camera")
    _say("exit 0 ready, 1 partial, 2 blocked")
