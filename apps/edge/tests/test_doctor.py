"""`heli-rig --doctor`'s desk-socket check, against a real websocket server.

The check that found this file's reason to exist: a rig whose `rig.json` holds a token for a desk
row the server no longer has — which is what a `db:reset` leaves behind — is *not* broken. Its
socket refreshes the token once and reconnects (`socket.py`'s `_refresh_token_once`), and it comes
up within a second. The doctor asked only whether the first handshake was accepted, so it reported
`fail` and exit 2 for a rig that starts and recovers on its own.

`FakeDesk(deny_tokens=...)` is a real server refusing a real handshake, so what these tests assert
is the handshake the doctor presented and the token it presented afterwards — not a mocked call.
"""

from __future__ import annotations

import logging

import pytest

from heli_rig.doctor import Rig, Report, _desk_socket
from heli_rig.upload import Uploader
from tests.fake_desk import FakeDesk, FakeSource, StubTokens, rig_config

log = logging.getLogger("tests.doctor")

CAMERA = {"model": "USB Camera", "maxWidth": 640, "maxHeight": 480, "zoom": False}


def _rig(desk: FakeDesk, tmp_path, tokens, **env) -> Rig:
    cfg = rig_config(tmp_path, api_url=f"http://127.0.0.1:{desk.port}", **env)
    source = FakeSource(dict(CAMERA))
    return Rig(
        cfg=cfg,
        log=log,
        source=source,
        uploader=Uploader(cfg, tokens, log),
        arm=None,
        user_tokens=tokens,
        desk_tokens=tokens,
    )


def _finding(report: Report, name: str) -> tuple[str, str]:
    """The level and detail of one finding, so a test can point at the line a person reads."""
    for level, found, detail, _fix in report.findings:
        if found == name:
            return level, detail
    raise AssertionError(f"no {name!r} finding in {[f[1] for f in report.findings]}")


@pytest.mark.asyncio
async def test_a_live_token_opens_the_socket(tmp_path):
    desk = FakeDesk()
    await desk.start()
    rig = _rig(desk, tmp_path, StubTokens("desk-token"))
    try:
        report = Report()
        await _desk_socket(rig, report)
        level, detail = _finding(report, "desk socket")
        assert level == "ok"
        assert "took the desk token" in detail
        assert rig.desk_tokens.refreshes == 0
    finally:
        await desk.close()


@pytest.mark.asyncio
async def test_a_stale_token_is_refreshed_rather_than_reported_broken(tmp_path):
    """The regression: a token for a desk row the server dropped, and the rig's own recovery.

    A `fail` here was the doctor telling a person their rig is blocked, for a rig that starts,
    refreshes its token, reconnects and runs — the same recovery `socket.py` performs on the same
    401. The level must be `ok`, and the refresh must actually have happened: a test that only
    asserted "not fail" would pass on a doctor that skipped the check entirely.
    """
    desk = FakeDesk(deny_tokens={"stale"})
    await desk.start()
    tokens = StubTokens("stale", refresh_token="fresh")
    rig = _rig(desk, tmp_path, tokens)
    try:
        report = Report()
        await _desk_socket(rig, report)
        level, detail = _finding(report, "desk socket")
        assert level == "ok"
        assert "after refreshing it once" in detail

        # The refresh is the whole point: two handshakes, the first refused and the second with
        # the token the store minted in its place.
        assert tokens.refreshes == 1
        assert [h["token"] for h in desk.handshakes] == ["stale", "fresh"]
    finally:
        await desk.close()


@pytest.mark.asyncio
async def test_a_refresh_that_does_not_help_is_a_failure(tmp_path):
    """Both tokens refused: the rig cannot recover, and the doctor has to say so.

    Without this the previous test would also pass on a doctor that reported `ok` for *any* 401,
    which is the opposite mistake and a worse one — a rig that never connects would read ready.
    """
    desk = FakeDesk(deny_tokens={"stale", "fresh"})
    await desk.start()
    tokens = StubTokens("stale", refresh_token="fresh")
    rig = _rig(desk, tmp_path, tokens)
    try:
        report = Report()
        await _desk_socket(rig, report)
        level, detail = _finding(report, "desk socket")
        assert level == "fail"
        assert "freshly minted desk token" in detail
        assert tokens.refreshes == 1
    finally:
        await desk.close()


@pytest.mark.asyncio
async def test_a_refusal_that_is_not_401_is_not_refreshed(tmp_path):
    """403 is not a credential problem, so the doctor does not trade one token for another.

    The socket makes the same distinction (`socket.py` refreshes on 401 only), and the two must
    agree: a doctor that refreshed here would report a recovery the run does not perform.
    """
    desk = FakeDesk(deny_tokens={"stale"}, deny_status=403)
    await desk.start()
    tokens = StubTokens("stale", refresh_token="fresh")
    rig = _rig(desk, tmp_path, tokens)
    try:
        report = Report()
        await _desk_socket(rig, report)
        level, detail = _finding(report, "desk socket")
        assert level == "fail"
        assert "403" in detail
        assert tokens.refreshes == 0
        assert [h["token"] for h in desk.handshakes] == ["stale"]
    finally:
        await desk.close()


# ------------------------------------------------------------------ the verdict

def test_the_verdict_is_the_worst_finding():
    """The exit code is what a setup script gates on, so it has to be the whole report's verdict.

    0 ready, 1 runs but degraded, 2 blocked — and `--doctor`'s docstring, `SETUP.md` and the
    `Exit code:` line it prints all promise exactly this. A verdict that took the *last* finding, or
    that counted warnings as failures, would send an agent down a path that does not exist: a rig
    with no arm is a rig that works, and a rig whose camera never opened is not.
    """
    from heli_rig.doctor import FAIL, OK, WARN

    ready = Report()
    ready.add(OK, "server", "answered")
    assert ready.verdict == 0

    degraded = Report()
    degraded.add(OK, "server", "answered")
    degraded.add(WARN, "arm", "no arm", "plug one in")
    assert degraded.verdict == 1, "a warning is not a blocker"

    blocked = Report()
    blocked.add(WARN, "arm", "no arm", None)
    blocked.add(FAIL, "camera", "no frame", "check the permission")
    assert blocked.verdict == 2, "a failure is the verdict whatever came before it"

    # And order does not matter: the verdict is a property of the set, not of the last line printed.
    reversed_order = Report()
    reversed_order.add(FAIL, "camera", "no frame", None)
    reversed_order.add(WARN, "arm", "no arm", None)
    assert reversed_order.verdict == 2
