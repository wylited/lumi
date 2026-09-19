"""HELI-045's registration: the desk's id, its token, and the file they live in.

The API is a real HTTP server on a free port (`fake_desk.FakeApi`), because what
these tests are about is what the rig sent and what it kept: the `Bearer` the
registration call carried, the `deskId` that makes a re-run an update rather than
a second desk, and the calibration keys in `rig.json` that must survive a write.
"""

from __future__ import annotations

import json
import logging
import re
import stat
from pathlib import Path

import pytest

from heli_rig.registration import RIG_FILE, DeskTokenStore, DevLoginError, RegistrationError
from tests.fake_desk import FakeApi, rig_config

log = logging.getLogger("tests.registration")

CAMERA = {
    "model": "USB Camera",
    "maxWidth": 640,
    "maxHeight": 480,
    "zoom": False,
}
ARM = {"model": "SO-100", "dof": 6, "port": "usbmodem5C4C1279531"}


@pytest.fixture
def api():
    server = FakeApi()
    try:
        yield server
    finally:
        server.close()


def caps(name: str = "Desk 1", *, arm: dict | None = None) -> dict:
    return {"name": name, "camera": dict(CAMERA), "arm": dict(arm) if arm else None}


def store(cfg, *, name: str = "Desk 1", arm: dict | None = None) -> DeskTokenStore:
    return DeskTokenStore(cfg, lambda: caps(name, arm=arm), log)


def rig_json(cfg) -> dict:
    return json.loads((Path(cfg.heli_dir) / RIG_FILE).read_text())


def test_the_first_run_registers_the_desk_and_keeps_its_token(tmp_path, api):
    cfg = rig_config(tmp_path, api_url=api.url)
    tokens = store(cfg, arm=ARM)

    assert tokens.token() == api.desk_token

    # The bootstrap presents nothing and sends nothing; the registration itself
    # is the one call that holds the user's credentials, and it is a Bearer.
    assert [request["path"] for request in api.requests] == [
        "/v1/auth/dev-login",
        "/v1/desks",
    ]
    login, registered = api.requests
    assert login["authorization"] is None
    assert json.loads(login["body"] or b"{}") == {}
    assert registered["authorization"] == f"Bearer {api.user_token}"
    assert json.loads(registered["body"]) == {
        "deskId": tokens.desk_id(),
        "name": "Desk 1",
        "camera": CAMERA,
        "arm": ARM,
    }

    stored = rig_json(cfg)
    assert re.fullmatch(r"heli-[0-9a-f]{8}", stored["deskId"])
    assert stored["deskToken"] == api.desk_token
    # A token at rest is a credential: only its owner reads the file.
    mode = stat.S_IMODE((Path(cfg.heli_dir) / RIG_FILE).stat().st_mode)
    assert mode == 0o600


def test_a_later_run_presents_the_stored_token_without_registering(tmp_path, api):
    cfg = rig_config(tmp_path, api_url=api.url)
    store(cfg).register()
    api.requests.clear()

    tokens = store(cfg)
    assert tokens.token() == api.desk_token  # and it is not re-read from the API
    assert api.requests == []


def test_an_operator_token_is_presented_and_never_traded_for_another(tmp_path, api):
    cfg = rig_config(tmp_path, api_url=api.url, HELI_DESK_TOKEN="pinned-token")
    tokens = store(cfg)

    assert tokens.token() == "pinned-token"
    # A 401 is the socket's reason for refreshing, and an operator's token is
    # not the rig's to replace: it says so instead of minting a second desk.
    assert tokens.token(refresh=True) == "pinned-token"
    assert tokens.register() == "pinned-token"
    assert api.requests == []
    assert not (Path(cfg.heli_dir) / RIG_FILE).exists()


def test_re_registering_updates_the_same_desk_and_keeps_unrelated_keys(tmp_path, api):
    cfg = rig_config(tmp_path, api_url=api.url)
    first = store(cfg)
    first.register()

    # The arm's calibration shares this file; the second run has no business
    # dropping what it does not own.
    path = Path(cfg.heli_dir) / RIG_FILE
    calibration = {"rectangle": {"x": 1, "y": 2, "w": 3, "h": 4}, "poses": [{"pan": 1.0}]}
    path.write_text(json.dumps({**json.loads(path.read_text()), **calibration}))
    api.desk_token = "desk-token-2"

    assert store(cfg, name="Study room").register() == "desk-token-2"

    assert list(api.desks) == [first.desk_id()]  # one desk, the same one
    assert api.desks[first.desk_id()]["name"] == "Study room"
    assert json.loads(path.read_text()) == {
        **calibration,
        "deskId": first.desk_id(),
        "deskToken": "desk-token-2",
    }


def test_refreshing_registers_again_and_replaces_the_stored_token(tmp_path, api):
    cfg = rig_config(tmp_path, api_url=api.url)
    tokens = store(cfg)
    tokens.register()

    api.desk_token = "desk-token-2"
    assert tokens.token(refresh=True) == "desk-token-2"

    assert rig_json(cfg)["deskToken"] == "desk-token-2"
    assert len(api.of_path("/v1/desks")) == 2  # one registration, not one per call
    assert list(api.desks) == [tokens.desk_id()]


def test_the_desk_id_is_minted_once_and_kept(tmp_path, api):
    cfg = rig_config(tmp_path, api_url=api.url)
    desk_id = store(cfg).desk_id()
    assert re.fullmatch(r"heli-[0-9a-f]{8}", desk_id)

    # A second process with the same home is the same desk, so the server
    # updates it rather than adding one.
    assert store(cfg).desk_id() == desk_id
    assert api.requests == []


def test_a_dev_login_failure_names_the_bootstrap_token_and_the_seeded_user(tmp_path, api):
    api.login_status = 503
    cfg = rig_config(tmp_path, api_url=api.url)
    tokens = store(cfg)

    with pytest.raises(DevLoginError) as raised:
        tokens.register()

    message = str(raised.value)
    assert "takes no body and no address" in message
    assert "me@heli.local" in message
    assert "503" in message
    assert api.of_path("/v1/desks") == []  # no desk token was minted
    assert "deskToken" not in rig_json(cfg)

    # The id was minted before the failure and is what the retry registers under.
    api.login_status = 200
    assert tokens.register() == api.desk_token
    assert rig_json(cfg)["deskId"] == tokens.desk_id()


def test_a_name_the_contract_would_refuse_is_refused_here_with_the_limit(tmp_path, api):
    cfg = rig_config(tmp_path, api_url=api.url)

    with pytest.raises(RegistrationError) as raised:
        store(cfg, name="D" * 61).register()

    assert "60" in str(raised.value)
    assert api.requests == []  # nothing was sent to be refused


def test_an_unreachable_api_raises_rather_than_running_unauthenticated(tmp_path):
    # Nothing listens on the discard port, so the dev-login never lands.
    cfg = rig_config(tmp_path, api_url="http://127.0.0.1:9")
    tokens = store(cfg)

    with pytest.raises(RegistrationError) as raised:
        tokens.token()

    assert "/v1/auth/dev-login" in str(raised.value)
