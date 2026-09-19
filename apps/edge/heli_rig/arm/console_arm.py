"""The arm through the operator console: `POST /api/cmd` on http://127.0.0.1:8643.

The console supervises armd, and armd owns the serial bus, so this driver never touches the port
itself - it asks the process that already has it. That is also why it is the driver the rig
prefers: whoever is watching the arm in the console keeps watching it.

Only the transport lives here. The dialect (state, arm, mode, jog) and the aiming loop are in
`driver.BridgeArm`, shared with the driver that speaks to a bridge of its own.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

from .driver import (
    AIM_KP,
    AIM_V_MAX_DEG_S,
    REQUEST_TIMEOUT_S,
    ArmError,
    ArmUnavailable,
    BridgeArm,
    reply_text,
)


class ConsoleArm(BridgeArm):
    """armd, through the console's command endpoint."""

    def __init__(
        self,
        console_url: str,
        pan_joint: str = 'shoulder_pan',
        tilt_joint: str = 'wrist_flex',
        tol_deg: float = 1.5,
        timeout_s: float = 5.0,
        *,
        calibration=None,
        log: logging.Logger | None = None,
        kp: float = AIM_KP,
        v_max_deg_s: float = AIM_V_MAX_DEG_S,
    ) -> None:
        super().__init__(
            pan_joint,
            tilt_joint,
            tol_deg=tol_deg,
            timeout_s=timeout_s,
            calibration=calibration,
            log=log,
            kp=kp,
            v_max_deg_s=v_max_deg_s,
        )
        self.console_url = str(console_url).rstrip('/')
        self._cmd_url = f'{self.console_url}/api/cmd'
        # The console answers a command in ~15 ms and gives up on armd after 30 s of its own, so a
        # request that has not answered inside this has a wedged console behind it, not a busy arm.
        self._request_timeout_s = min(self.timeout_s, REQUEST_TIMEOUT_S)

    def _send(self, method: str, params: dict | None = None, timeout_s: float | None = None) -> dict:
        payload = json.dumps({'method': method, 'params': dict(params or {})}).encode('utf-8')
        request = urllib.request.Request(
            self._cmd_url,
            data=payload,
            headers={'content-type': 'application/json'},
            method='POST',
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_s or self._request_timeout_s) as response:
                body = response.read()
        except urllib.error.HTTPError as exc:
            # 503 is armd down, 504 is armd not answering: both bodies carry the bridge's own words,
            # and those are what the operator needs to see rather than a status code.
            raise ArmUnavailable(
                f'console {exc.code} on {method}: {reply_text(exc.read()) or exc.reason}'
            ) from exc
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise ArmUnavailable(f'the console at {self.console_url} is not answering {method}: {exc}') from exc
        try:
            reply = json.loads(body.decode('utf-8'))
        except (ValueError, UnicodeDecodeError) as exc:
            raise ArmUnavailable(f'the console answered {method} with something that is not JSON') from exc
        if not isinstance(reply, dict):
            raise ArmError(f'{method}: the console reply was not an object')
        return reply
