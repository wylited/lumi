"""The desk's own identity: the id it keeps and the token it presents.

The rig never holds the user's credentials for longer than one call. On the
first run it borrows one from `POST /v1/auth/dev-login` — the seeded,
single-user deployment's bootstrap — exchanges it for a **desk token** at
`POST /v1/desks`, and stores `{deskId, deskToken}` in `~/.heli/rig.json`. Every
run after that presents the stored token, and the desk id it sends is the one it
has kept since the first run, because `deskId` is what makes registration
idempotent: a re-run updates the desk rather than adding a second one.

`rig.json` is shared with the arm's calibration, so every write here is a
read-modify-write that leaves the keys this module does not own alone — and the
write is a replace, so a reader never sees half a file.

Nothing here is silent. A rig that could not get a token raises with the reason,
naming what to check, instead of continuing unauthenticated: a desk that uploads
nothing because `HELI_EMAIL` is wrong must not look like a desk with nothing to
upload.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from pathlib import Path
from typing import Any, Callable

import httpx

from .config import Config

__all__ = ["DeskTokenStore", "RegistrationError", "DevLoginError", "RIG_FILE"]

#: The desk's local file. `arm/calibration.py` writes its rectangle and poses
#: into the same object, which is why the reads and writes here are careful.
RIG_FILE = "rig.json"

#: The account `prisma/seed.ts` creates for this single-user deployment. Named
#: in the dev-login failure so a person knows which user has to exist.
SEEDED_USER = "me@heli.local"

#: `DeskRegistration.name` in `packages/contracts/src/desk.ts`: 1 to 60 characters.
DESK_NAME_MAX = 60

_DESK_ID_PREFIX = "heli-"
_HTTP_TIMEOUT_S = 10.0
#: How much of an error body is worth putting in an exception message. Enough to
#: read the server's own words, short of dumping a page into a log line.
_DETAIL_LIMIT = 200

_DEV_LOGIN_HINT = (
    "dev-login is the bootstrap of the seeded, single-user deployment: it returns a token for "
    f"whichever user exists, which `prisma/seed.ts` creates as {SEEDED_USER}. The desk token "
    "cannot be minted without it, so check that the API is reachable and seeded "
    "(`pnpm --filter @heli/server db:seed`), and that HELI_EMAIL — the bootstrap-only address — "
    "names the account this desk belongs to."
)


class RegistrationError(RuntimeError):
    """Registering the desk failed and the rig has no token to present."""


class DevLoginError(RegistrationError):
    """The bootstrap user token could not be minted.

    Its own type because it is the one failure a person fixes by hand: the rig
    has no credentials at all and nothing will upload until the seeded user is
    reachable.
    """


class DeskTokenStore:
    """`TokenSource` for the uploader and the desk socket.

    The order is the contract's: `HELI_DESK_TOKEN`, then the stored token, then
    register. `refresh=True` — what the socket asks for after a 401 — skips the
    stored token and registers again, but never skips `HELI_DESK_TOKEN`: an
    operator who set it has said which token this rig presents, and minting a
    different one behind their back would hide exactly the mistake they need to
    see.

    `token()` raises rather than returning `None` when it has no token and
    cannot register one. Returning `None` would let a caller post a frame with
    no credentials and call it an upload.
    """

    def __init__(self, cfg: Config, caps: Callable[[], dict], log: logging.Logger) -> None:
        self._cfg = cfg
        self._caps = caps
        self._log = log
        # `token()` is called from the capture loop and the socket, and may be
        # called from a worker thread; registration is the one thing that must
        # not happen twice at once.
        self._lock = threading.Lock()
        self._token: str | None = None
        self._desk_id: str | None = None

    # ---- the TokenSource the uploader holds --------------------------------

    def token(self, refresh: bool = False) -> str | None:
        """The desk token, registering one if there is none to present."""
        if self._cfg.desk_token:
            if refresh:
                self._log.warning(
                    "HELI_DESK_TOKEN is set, so a refresh presents the same token; "
                    "unset it to let the rig register itself again"
                )
            return self._cfg.desk_token

        with self._lock:
            if not refresh:
                if self._token:
                    return self._token
                stored = self._stored_token()
                if stored is not None:
                    self._token = stored
                    return stored
            return self._register()

    def register(self) -> str:
        """Register this desk and return the desk token the server answered.

        Deliberately the same call `token()` falls back to, and deliberately
        idempotent: the desk id is the one already in `rig.json`, so a re-run
        updates the desk rather than adding one.
        """
        if self._cfg.desk_token:
            self._log.info("HELI_DESK_TOKEN is set; not registering over it")
            return self._cfg.desk_token
        with self._lock:
            return self._register()

    def desk_id(self) -> str:
        """This desk's own id — minted once, then kept in `rig.json`."""
        with self._lock:
            return self._desk_id_locked()

    # ---- registration ------------------------------------------------------

    def _register(self) -> str:
        desk_id = self._desk_id_locked()
        caps = self._caps() or {}
        # `camera` and `arm` are nullable on purpose: a desk whose camera is
        # unplugged still registers, and the server reports it as having none.
        body = {
            "deskId": desk_id,
            "name": _desk_name(caps.get("name") or self._cfg.desk_name),
            "camera": caps.get("camera"),
            "arm": caps.get("arm"),
        }

        user_token = self._dev_login()
        registered = self._post("/v1/desks", body, user_token)
        token = registered.get("deskToken")
        if not isinstance(token, str) or not token:
            raise RegistrationError(
                f"{self._url('/v1/desks')} answered without a desk token for {desk_id}"
            )

        self._write({"deskId": desk_id, "deskToken": token})
        self._token = token
        self._desk_id = desk_id
        self._log.info("registered desk %s; its token is in %s", desk_id, self._path())
        return token

    def _dev_login(self) -> str:
        """The bootstrap user token, with the fix in the error when it fails."""
        try:
            answer = self._post("/v1/auth/dev-login", {}, None)
        except RegistrationError as exc:
            raise DevLoginError(f"{exc}\n{_DEV_LOGIN_HINT}") from exc
        token = answer.get("token")
        if not isinstance(token, str) or not token:
            raise DevLoginError(
                f"{self._url('/v1/auth/dev-login')} answered without a user token.\n"
                f"{_DEV_LOGIN_HINT}"
            )
        return token

    # ---- the shared file ---------------------------------------------------

    def _path(self) -> Path:
        return Path(self._cfg.heli_dir) / RIG_FILE

    def _stored_token(self) -> str | None:
        stored = self._read().get("deskToken")
        return stored if isinstance(stored, str) and stored else None

    def _desk_id_locked(self) -> str:
        if self._desk_id:
            return self._desk_id
        stored = self._read().get("deskId")
        if isinstance(stored, str) and stored:
            self._desk_id = stored
            return stored

        desk_id = f"{_DESK_ID_PREFIX}{uuid.uuid4().hex[:8]}"
        # Kept before it is used: the id is what the next run registers against,
        # so losing it here would mean a second desk on the server.
        self._write({"deskId": desk_id})
        self._desk_id = desk_id
        self._log.info("minted the desk id %s, kept in %s", desk_id, self._path())
        return desk_id

    def _read(self) -> dict:
        """Everything in `rig.json`, or an empty object when it is not there.

        A file that cannot be parsed is reported and then treated as empty: the
        calibration it may have held is gone either way, and refusing to register
        would not bring it back.
        """
        path = self._path()
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except OSError as exc:
            self._log.warning("could not read %s: %s", path, exc)
            return {}

        try:
            data = json.loads(raw)
        except ValueError as exc:
            self._log.warning("%s is not JSON (%s); registration will rewrite it", path, exc)
            return {}
        if not isinstance(data, dict):
            self._log.warning("%s does not hold an object; registration will rewrite it", path)
            return {}
        return data

    def _write(self, patch: dict) -> None:
        """Merge `patch` into `rig.json` and replace the file atomically.

        Read-modify-write, because the arm's calibration lives in the same file
        and this module has no business dropping its keys. The replace is what
        keeps a reader — or a crash — from seeing a half-written file.
        """
        path = self._path()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        data = self._read()
        data.update(patch)

        # A unique temp name: two rig processes sharing a home must not write
        # each other's temp file, only the last rename may win.
        tmp = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        # The token is a credential; the file is nobody else's to read.
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
        self._log.debug("wrote %s", path)

    # ---- HTTP --------------------------------------------------------------

    def _url(self, path: str) -> str:
        return f"{self._cfg.api_url.rstrip('/')}{path}"

    def _post(self, path: str, body: dict, user_token: str | None) -> dict:
        url = self._url(path)
        headers = {"accept": "application/json"}
        if user_token is not None:
            headers["authorization"] = f"Bearer {user_token}"

        try:
            with httpx.Client(timeout=_HTTP_TIMEOUT_S) as client:
                response = client.post(url, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise RegistrationError(f"POST {url} never arrived: {exc}") from exc

        if response.status_code >= 400:
            raise RegistrationError(
                f"POST {url} answered {response.status_code}: {_detail(response)}"
            )
        try:
            answer = response.json()
        except ValueError as exc:
            raise RegistrationError(
                f"POST {url} answered {response.status_code} with something other than JSON"
            ) from exc
        if not isinstance(answer, dict):
            raise RegistrationError(f"POST {url} answered {response.status_code} with {answer!r}")
        return answer


def _detail(response: httpx.Response) -> str:
    text = response.text.strip()
    if not text:
        return "(no body)"
    return text if len(text) <= _DETAIL_LIMIT else f"{text[:_DETAIL_LIMIT]}…"


def _desk_name(name: Any) -> str:
    """The `DeskRegistration.name`, refused here rather than by the server.

    The contract allows 1 to 60 characters, and a name that misses either bound
    is a config mistake — a 400 from the API would arrive as a bare status code,
    while this says which field and which limit. Truncating would be worse: the
    desk would register under a name nobody chose.
    """
    if not isinstance(name, str) or not name.strip():
        raise RegistrationError("the desk needs a name: set HELI_DESK_NAME to something to call it")
    if len(name) > DESK_NAME_MAX:
        raise RegistrationError(
            f"the desk name is {len(name)} characters and the server takes at most "
            f"{DESK_NAME_MAX}: {name!r}"
        )
    return name
