"""`heli-rig` — the rig's entry point, in four modes.

`--once` is the bench check: one frame, one upload, one JSON line on stdout, and
an exit code a script can branch on. `--doctor` walks everything the rig needs on
this machine — server, token, session, desk, socket, camera, one real upload, arm,
desk plane, speaker — and prints what is missing with the command that fixes it.
`--calibrate` records the desk plane — five prompts, five poses, one file — and
exits. The default is the long-running rig: frames up at the cadence, actions and
a line's PCM down the desk socket, with the arm and the speaker beside it. Each of
those three is loaded only when its module is in the tree, so the capture path
still runs on a rig with no arm and no speaker.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import sys
from functools import partial
from pathlib import Path
from typing import Callable, Sequence

import httpx

from . import AGENT_VERSION
from .camera import CameraUnavailable, DeferredSource, FrameSource, open_source
from .capture import CAMERA_RETRY_S, CaptureLoop
from .config import Config, load
from .upload import UploadOutcome, Uploader

LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
DEV_LOGIN_PATH = "/v1/auth/dev-login"
TOKEN_TIMEOUT_S = 5.0


def main(argv: Sequence[str] | None = None) -> int:
    """Read the config, set logging up once, and run the rig."""
    cfg = load(argv=argv)
    logging.basicConfig(level=cfg.log_level.upper(), format=LOG_FORMAT)
    if cfg.log_level != "debug":
        # httpx names every request at INFO. The rig's own lines are the story,
        # and a debug run can still have httpx's when it wants them.
        logging.getLogger("httpx").setLevel(logging.WARNING)
    log = logging.getLogger("heli_rig")
    log.debug("heli-rig %s: api=%s ws=%s camera=%s", AGENT_VERSION, cfg.api_url, cfg.ws_url, cfg.camera_source)
    try:
        if cfg.doctor:
            return asyncio.run(_doctor(cfg, log))
        if cfg.calibrate:
            return _calibrate(cfg, log)
        if cfg.once:
            return asyncio.run(_once(cfg, log))
        asyncio.run(run_rig(cfg, log))
    except KeyboardInterrupt:
        log.info("stopped")
    return 0


def _calibrate(cfg: Config, log: logging.Logger) -> int:
    """Record the desk plane: the rectangle, and the poses that frame it.

    This is the rig's half of the desktop's "aim here". The rectangle decides
    which part of the desk the rig watches, and the five pairs it records are
    what make `arm.point(x, y)` an arithmetic answer instead of a guess -- the
    frontend can drag the rectangle, but only the arm can say which pose looks
    at which corner, so the recording happens here.

    Nobody drives the arm from this process: the operator aims with the console
    (or whatever holds the bus) and this reads the pose back, so it can run
    beside the thing that is actually moving the arm.
    """
    if not cfg.rect:
        log.error("calibration needs the rectangle: --rect x,y,w,h in millimetres, or HELI_DESK_RECT")
        return 2

    if not _landed("heli_rig.arm"):
        log.error("calibration needs the arm adapter, which is not in this tree")
        return 2
    from .arm import open_arm
    from .arm.calibrate import Calibrator, parse_rect
    from .arm.calibration import RIG_FILE, Calibration

    try:
        rect = parse_rect(cfg.rect)
    except ValueError as exc:
        log.error("%s", exc)
        return 2

    arm = open_arm(cfg, log)
    if arm is None:
        log.error("calibration needs an arm; none answered -- nothing was written")
        return 3
    try:
        path = Path(cfg.heli_dir) / RIG_FILE
        recorded = Calibrator(arm, Calibration.load(path), log=log).run(rect)
    finally:
        arm.close()
    if recorded == 0:
        log.error("calibration recorded nothing; the file is unchanged in all but its rectangle")
        return 1
    return 0


async def run_rig(cfg: Config, log: logging.Logger) -> None:
    """The long-running rig: capture at the cadence, with the desk socket beside it."""
    arm = None
    speaker = None
    if _landed("heli_rig.arm"):
        from .arm import open_arm

        # `open_arm` probes the bus and can block on a serial timeout, so it goes
        # to a thread: a dead arm must not delay the first frame.
        arm = await asyncio.to_thread(open_arm, cfg, log)
    if _landed("heli_rig.audio") and cfg.speaker:
        from .audio import Speaker

        speaker = Speaker(log=log)
        # Once, at boot: the first playback in a fresh process pays CoreAudio's
        # start-up, and the line that pays it is the first one — which on a demo
        # is the one everybody is watching for.
        await asyncio.to_thread(speaker.warm)
    elif not cfg.speaker:
        # `HELI_SPEAKER=false` is a rig that hears nothing: the socket acks the line
        # `no_speaker` rather than pretending, which is what its own path already does
        # for a rig with no speaker module at all.
        log.info("HELI_SPEAKER=false: the rig will acknowledge a spoken line without playing it")
    try:
        source = await open_source(cfg, log)
    except CameraUnavailable as exc:
        # A rig whose camera is missing at boot still belongs up: the loop reopens
        # the source on its next tick, and every 5 s after that.
        log.error("camera: %s; the rig will keep looking, every %gs", exc, CAMERA_RETRY_S)
        source = _unopened_source(cfg, log)
    tokens = _tokens(cfg, log, partial(_caps, cfg, source, arm))
    uploader = Uploader(cfg, _upload_tokens(cfg, tokens, log), log)

    # The follow loop is built before the capture loop because the capture loop is
    # what feeds it: every frame it takes is handed to `observe`, and the loop reads
    # the newest one on its own cadence. One camera reader, two consumers.
    tracker = _tracker(cfg, arm, log)
    capture = CaptureLoop(source, uploader, cfg, log, on_frame=tracker.observe if tracker else None)
    tasks = [asyncio.create_task(capture.run(), name="heli-rig-capture")]
    if tracker is not None:
        tasks.append(asyncio.create_task(tracker.run(), name="heli-rig-follow"))
        log.info(
            "tracking: %s (model %s, %g fps)",
            "following" if tracker.on else "off",
            cfg.model,
            cfg.track_fps,
        )

    if _landed("heli_rig.socket"):
        from .actions import Dispatcher
        from .socket import DeskClient

        # Two directions, one process: `capture` uploads frames up, and the desk
        # socket takes actions and a line's PCM down. `tokens` here is the store
        # itself, not the uploader's bridged view of it: `hello` needs
        # `desk_id()`, and a registration the server refuses must stay a failure
        # rather than becoming a user token the desk route will reject.
        client = DeskClient(
            cfg,
            Dispatcher(capture, arm, speaker, cfg, log, tracker=tracker),
            capture,
            arm,
            speaker,
            tokens,
            log,
        )
        tasks.append(asyncio.create_task(client.run(), name="heli-rig-socket"))
    else:
        log.warning("heli_rig.socket is missing; the rig will upload and hear nothing")

    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await uploader.aclose()
        await source.close()


async def _doctor(cfg: Config, log: logging.Logger) -> int:
    """The preflight: build the same pieces the run builds, then let `doctor` question them.

    Nothing here is started — no capture loop, no socket client — because the point is to find out
    whether they *would* work. The two things that can fail while being built (the arm, the camera)
    are caught and handed on as notes, so one missing device does not end the report.
    """
    from .doctor import Rig, doctor

    arm = None
    arm_note = None
    if cfg.arm_driver != "none" and _landed("heli_rig.arm"):
        from .arm import open_arm

        notes: list[str] = []
        handler = _Collector(notes)
        # On the package logger, not `heli_rig.arm`: `open_arm` reports the missing
        # arm through the logger the caller handed it, and both are children of this.
        rig_log = logging.getLogger("heli_rig")
        rig_log.addHandler(handler)
        try:
            # `open_arm` probes the bus and can block on a serial timeout, so it goes to a thread.
            arm = await asyncio.to_thread(open_arm, cfg, log)
        finally:
            rig_log.removeHandler(handler)
        # The last word is the arm's: `open_arm` is the only thing running here.
        arm_note = notes[-1] if notes and arm is None else None
    elif not _landed("heli_rig.arm"):
        arm_note = "the arm adapter is not in this tree"

    source: FrameSource
    camera_note = None
    try:
        source = await open_source(cfg, log)
    except CameraUnavailable as exc:
        camera_note = str(exc)
        source = _unopened_source(cfg, log)

    tokens = _tokens(cfg, log, partial(_caps, cfg, source, arm))
    uploader = Uploader(cfg, _upload_tokens(cfg, tokens, log), log)
    try:
        return await doctor(
            Rig(
                cfg=cfg,
                log=log,
                source=source,
                uploader=uploader,
                arm=arm,
                user_tokens=_UserTokenSource(cfg, log),
                desk_tokens=tokens,
                arm_note=arm_note,
                camera_note=camera_note,
            )
        )
    finally:
        await uploader.aclose()
        await source.close()
        if arm is not None:
            arm.close()


class _Collector(logging.Handler):
    """Keeps the WARNING+ lines a device logs while it is being opened.

    `open_arm` reports a missing arm as a warning and a `None`; the doctor has to
    quote that warning, because "no arm" without a reason is the answer nobody can
    act on.
    """

    def __init__(self, into: list[str]) -> None:
        super().__init__(level=logging.WARNING)
        self._into = into

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self._into.append(record.getMessage())
        except Exception:  # a report must not be the thing that breaks
            pass


async def _once(cfg: Config, log: logging.Logger) -> int:
    """One frame, one upload, one line — the bench's acceptance in a single process."""
    try:
        source = await open_source(cfg, log)
    except CameraUnavailable as exc:
        log.error("camera: %s", exc)
        _emit(UploadOutcome(False, 0, None, None, None, None, "camera_unavailable", False), None)
        return 1
    store = _tokens(cfg, log, partial(_caps, cfg, source))
    uploader = Uploader(cfg, _upload_tokens(cfg, store, log), log)
    try:
        frame = await source.grab()
        outcome = await uploader.upload(frame, 1)
    except CameraUnavailable as exc:
        log.error("camera: %s", exc)
        outcome = UploadOutcome(False, 0, None, None, None, None, "camera_unavailable", False)
    except Exception:
        log.exception("the rig failed before the frame was uploaded")
        outcome = UploadOutcome(False, 0, None, None, None, None, "rig_error", False)
    finally:
        await uploader.aclose()
        await source.close()
    _emit(outcome, 1)
    return _exit_code(outcome)


def _emit(outcome: UploadOutcome, seq: int | None) -> None:
    """The `--once` line. A script reads this one, so it is stdout and not a log record.

    `seq` is the server's own when it answered 201, and the rig's counter for the
    frame it tried to send otherwise.
    """
    print(
        json.dumps(
            {
                "ok": outcome.ok,
                "status": outcome.status,
                "seq": outcome.seq if outcome.seq is not None else seq,
                "width": outcome.width,
                "height": outcome.height,
                "error": outcome.error,
            }
        ),
        flush=True,
    )


def _exit_code(outcome: UploadOutcome) -> int:
    """0 uploaded, 3 no open session, 4 the server refused the frame, 1 anything else."""
    if outcome.ok:
        return 0
    if outcome.status == 409:
        return 3
    if outcome.rejected:
        return 4
    return 1


def _unopened_source(cfg: Config, log: logging.Logger) -> FrameSource:
    """A camera that will be chosen when it opens, not one that was chosen at boot.

    `open_source` picks once. After a boot with no camera at all, pinning what the
    config asked for would re-try that one source every 5 s forever — the console
    for `auto`, the device for `opencv` — and never reach the camera that gets
    plugged in, which is the opposite of what `auto` documents.
    """
    return DeferredSource(cfg, log)


def _tracker(cfg: Config, arm: object | None, log: logging.Logger) -> object | None:
    """The follow loop, or None when this rig cannot have one.

    It needs all three: the module, an arm, and the control law. A rig with any of
    them missing still captures, uploads and answers actions - it simply cannot
    follow anyone, and `arm.track` says `tracking_unavailable` rather than acking a
    loop that does not exist.

    The gimbal is built from the arm's own limits: `window` and `park` are what armd
    reports, so the law's software bounds are the hardware's, not a second set that
    could disagree with them.
    """
    if not (_landed("heli_rig.follow") and _landed("heli_rig.arm.gimbal")):
        return None
    if arm is None:
        return None
    from .arm.gimbal import Gimbal
    from .follow import Tracker

    try:
        limits = _limits(arm, log)
        gimbal = Gimbal(
            log,
            window=limits.get("window"),
            ready=limits.get("ready"),
            park=limits.get("park"),
            aim=(0.5, 0.5),
            caps=limits.get("caps"),
            deadband=cfg.track_deadband,
        )
    except Exception as exc:
        log.warning("tracking is off: the control law would not start (%s)", exc)
        return None
    return Tracker(cfg, arm, gimbal, log)  # type: ignore[arg-type]


def _limits(arm: object, log: logging.Logger) -> dict:
    """What the control law needs from the arm, read off the arm itself.

    The tracking project kept this in `limits.json`, written once when a person
    armed the arm and moved it by hand. The rig has no such file and does not need
    one: armd already reports the window it will hold, the pose it calls park, and
    the joints' signs are a property of the arm's own axes. Reading them per boot
    means a law that cannot disagree with the arm it is driving.
    """
    try:
        return dict(arm.limits())  # type: ignore[attr-defined]
    except Exception as exc:
        log.debug("the arm would not report its limits: %s", exc)
        return {}


def _caps(cfg: Config, source: FrameSource, arm: object | None = None) -> dict:
    """What `POST /v1/desks` registers: the desk's name, its camera and its arm.

    A missing `arm` is reported as `null` on purpose: it is what tells the server
    never to send an aim, and a rig that claimed an arm it cannot move would be
    asked to point at a page and answer `no_arm` forever.
    """
    return {
        "name": cfg.desk_name,
        "camera": source.describe(),
        "arm": arm.describe() if arm is not None else None,  # type: ignore[attr-defined]
    }


def _tokens(cfg: Config, log: logging.Logger, caps: Callable[[], dict]) -> TokenSource:
    """The desk token store: `heli_rig.registration` when it has landed, else the environment.

    This is what the desk socket presents, so its failures stay its own: a store
    that could not register raises, and the socket reports why rather than
    reconnecting against a token the server will refuse.
    """
    if _landed("heli_rig.registration"):
        from .registration import DeskTokenStore

        return DeskTokenStore(cfg, caps, log)
    return _UserThenDesk(_UserTokenSource(cfg, log), _EnvDeskToken(cfg))


def _upload_tokens(cfg: Config, store: TokenSource, log: logging.Logger) -> TokenSource:
    """What the uploads present: the person's token, then the desk token.

    `POST /v1/desk/frames` authenticates the **user**, not the desk, so a rig that
    presented its desk token there was answered 401 on every frame -- and the store
    read that 401 as a stale desk token and re-registered the desk on each retry,
    which is a desk registration per frame. The person's token is borrowed from the
    dev-login bootstrap, because a rig holds no credentials by design, and the desk
    token stays behind it for the day the frames route takes one.

    The socket does not get this: `/ws/desk` refuses anything but a desk token, and
    a bridge there would only hide a failure the log needs to show.
    """
    return _UserThenDesk(_UserTokenSource(cfg, log), store)


class _UserThenDesk:
    """Two token stores, tried in order. Which one is first depends on the route."""

    def __init__(self, first: TokenSource, second: TokenSource) -> None:
        self._first = first
        self._second = second

    def token(self, refresh: bool = False) -> str | None:
        return self._first.token(refresh=refresh) or self._second.token(refresh=refresh)


class _EnvDeskToken:
    """`HELI_DESK_TOKEN`: the token whatever set this rig up handed it."""

    def __init__(self, cfg: Config) -> None:
        self._token = cfg.desk_token

    def token(self, refresh: bool = False) -> str | None:
        del refresh  # a token from the environment cannot be refreshed
        return self._token


class _UserTokenSource:
    """The person's token, borrowed from `POST /v1/auth/dev-login`.

    The one route the rig calls that authenticates the user is reached through the
    bootstrap of the seeded, single-user deployment: the rig has no credentials of
    its own, which is exactly what the desk token is for. Cached for the process,
    and `refresh=True` mints a new one -- which is what a 401 asks for.
    """

    def __init__(self, cfg: Config, log: logging.Logger) -> None:
        self._cfg = cfg
        self._log = log
        self._cached: str | None = None

    def token(self, refresh: bool = False) -> str | None:
        if refresh:
            self._cached = None
        if self._cached is None:
            self._cached = self._dev_login()
        return self._cached

    def _dev_login(self) -> str | None:
        # Synchronous because `TokenSource.token` is: it blocks the loop for one
        # loopback request, once per process, which is cheaper than a second async
        # path for a token the rig already holds.
        self._log.debug("minting a user token from the dev-login bootstrap")
        try:
            with httpx.Client(timeout=TOKEN_TIMEOUT_S) as client:
                response = client.post(f"{self._cfg.api_url}{DEV_LOGIN_PATH}", json={})
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            self._log.error(
                "dev-login failed, so frames cannot be uploaded: %s. The rig uploads as the "
                "seeded user (a user route owns the frames), and a deployment that has stopped "
                "serving dev-login leaves it no way to authenticate.",
                exc,
            )
            return None
        except ValueError as exc:
            self._log.error("dev-login answered with something that is not JSON: %s", exc)
            return None
        token = payload.get("token") if isinstance(payload, dict) else None
        if not isinstance(token, str) or not token:
            self._log.error("dev-login answered without a token")
            return None
        return token


def _landed(module: str) -> bool:
    """Whether a module a later commit owns exists yet (HELI-042, HELI-045)."""
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


if __name__ == "__main__":
    sys.exit(main())
