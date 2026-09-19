"""The arm on a bridge of its own, for when the console is not running.

Exactly one process may drive the serial bus. This driver starts
`tracking.bridge --no-vision` itself - the same program the console supervises, without its vision
child - and refuses to start at all while the console answers, because two writers on one bus is
how a rig ends up with a servo in overload protection.

The child's JSONL dialect (one JSON object per line in, replies and `{"ev": ...}` lines out) is
armd's dialect, the same one the console relays, so it stops at this file: nothing above the arm
package ever sees lerobot, a serial port or a servo register.
"""

from __future__ import annotations

import collections
import json
import logging
import queue
import subprocess
import threading
import time
from collections.abc import Sequence
from pathlib import Path
from typing import IO

from .driver import (
    AIM_KP,
    AIM_V_MAX_DEG_S,
    REQUEST_TIMEOUT_S,
    ArmUnavailable,
    BridgeArm,
    console_answers,
)

# The bridge lives in the tracking project, whose interpreter has lerobot and the arm's own
# calibration; the rig's own interpreter has neither and must not grow them. Where that project
# lives is a setting (`HELI_BRIDGE_DIR` / `HELI_BRIDGE_PYTHON`, `--bridge-dir` / `--bridge-python`):
# it used to be a constant here, and on every machine but the one it was written on that constant
# was a missing directory, which the rig reported as "no arm" and nobody could act on.
BRIDGE_ARGS = ('-m', 'tracking.bridge', '--no-vision')
BRIDGE_START_TIMEOUT_S = 10.0   # armd opens the arm (handshake, calibration, travel) first
BRIDGE_STOP_TIMEOUT_S = 3.0
BRIDGE_REAP_TIMEOUT_S = 1.0     # how long to wait for the exit code of a bridge that just died
STDERR_KEEP = 5                 # lines of the child's own words to quote when it dies
CONSOLE_HOLDS_ARM = 'console holds the arm'


class SerialArm(BridgeArm):
    """The bridge as a child process, spoken to over its stdin and stdout."""

    def __init__(
        self,
        console_url: str,
        pan_joint: str = 'shoulder_pan',
        tilt_joint: str = 'wrist_flex',
        tol_deg: float = 1.5,
        timeout_s: float = 5.0,
        *,
        python: str | None = None,
        args: Sequence[str] = BRIDGE_ARGS,
        cwd: str | None = None,
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
        self.python = python
        self.args = tuple(args)
        self.cwd = cwd
        self._request_timeout_s = min(self.timeout_s, REQUEST_TIMEOUT_S)
        self._proc: subprocess.Popen | None = None
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._stderr: collections.deque[str] = collections.deque(maxlen=STDERR_KEEP)
        self._next_id = 1
        self._pumps: list[threading.Thread] = []

    # ------------------------------------------------------------ transport
    def _start(self) -> None:
        """Start the bridge, unless the console holds the arm."""
        if console_answers(self.console_url):
            raise ArmUnavailable(CONSOLE_HOLDS_ARM)
        missing = self._bridge_missing()
        if missing is not None:
            raise ArmUnavailable(missing)
        assert self.python is not None and self.cwd is not None
        command = [self.python, *self.args]
        self.log.info('starting the bridge: %s (cwd %s)', ' '.join(command), self.cwd)
        try:
            self._proc = subprocess.Popen(
                command,
                cwd=self.cwd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            raise ArmUnavailable(f'could not start the bridge ({self.python}): {exc}') from exc
        self._lines = queue.Queue()
        self._stderr.clear()
        self._pumps = [
            threading.Thread(target=self._pump_out, args=(self._proc.stdout,), daemon=True),
            threading.Thread(target=self._pump_err, args=(self._proc.stderr,), daemon=True),
        ]
        for pump in self._pumps:
            pump.start()

    def _bridge_missing(self) -> str | None:
        """Why this rig is not configured to start a bridge, or None when it is.

        Answered before `Popen`, because the OS error for a missing interpreter ("No such file")
        names a path and not the setting behind it — and the path that used to be baked in here
        only existed on one machine.
        """
        if not self.python or not self.cwd:
            return (
                'the bridge is not configured - set HELI_BRIDGE_DIR to the project that '
                'owns the serial bus (it has `tracking.bridge` and an interpreter with lerobot), and '
                'HELI_BRIDGE_PYTHON if its interpreter is not <dir>/.venv/bin/python'
            )
        if not Path(self.cwd).is_dir():
            return (
                f'the bridge project {self.cwd} is not a directory - the arm needs that '
                f'project; point HELI_BRIDGE_DIR at it (or drop the console, which drives the same '
                f'arm at {self.console_url})'
            )
        if not Path(self.python).exists():
            return (
                f'the bridge interpreter {self.python} is not there - set HELI_BRIDGE_PYTHON '
                f'to the interpreter of {self.cwd}, or run its own installer so its .venv exists'
            )
        return None

    def _pump_out(self, stream: IO[str] | None) -> None:
        """stdout: one JSON object per line. The None at the end is the child's obituary - without
        it a waiter would sit out its own timeout instead of learning the bridge is gone."""
        if stream is None:
            return
        for line in stream:
            self._lines.put(line)
        self._lines.put(None)

    def _pump_err(self, stream: IO[str] | None) -> None:
        """stderr: armd's own words about what it is doing, kept for the error a dead bridge is
        going to produce (an unplugged arm explains itself here and nowhere else)."""
        if stream is None:
            return
        for line in stream:
            text = line.rstrip()
            if text:
                self._stderr.append(text)

    def _send(self, method: str, params: dict | None = None, timeout_s: float | None = None) -> dict:
        budget = timeout_s if timeout_s is not None else self._request_timeout_s
        proc = self._proc
        if proc is None:
            self._start()
            proc = self._proc
            assert proc is not None
            budget = max(budget, BRIDGE_START_TIMEOUT_S)
        elif proc.poll() is not None:
            raise ArmUnavailable(self._exit_note())
        ident = self._next_id
        self._next_id += 1
        line = json.dumps({'id': ident, 'method': method, 'params': dict(params or {})})
        try:
            assert proc.stdin is not None
            proc.stdin.write(line + '\n')
            proc.stdin.flush()
        except (BrokenPipeError, OSError, ValueError) as exc:
            raise ArmUnavailable(f'{self._exit_note()}: {exc}') from exc
        deadline = time.monotonic() + budget
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ArmUnavailable(
                    f'the bridge did not answer {method} within {budget:.1f} s{self._stderr_note()}'
                )
            try:
                reply_line = self._lines.get(timeout=remaining)
            except queue.Empty:
                continue    # round again, and let the deadline above name the reason
            if reply_line is None:
                raise ArmUnavailable(self._exit_note())
            if not reply_line.strip():
                continue
            try:
                reply = json.loads(reply_line)
            except ValueError:
                self.log.debug('the bridge said something unreadable: %s', reply_line[:200])
                continue
            if reply.get('ev'):
                if reply.get('ev') == 'log':
                    self.log.debug('bridge: %s', reply.get('msg'))
                continue
            if reply.get('id') == ident:
                return reply
            # A reply for another id can only be a late answer to a command that already timed
            # out (this driver holds its lock for a whole operation).
            self.log.debug('the bridge answered an older command: %s', reply_line[:200])

    # ------------------------------------------------------------ lifecycle
    def is_connected(self) -> bool:
        return self._connected and not self._closed and self._proc is not None and self._proc.poll() is None

    def close(self) -> None:
        with self._lock:
            proc, self._proc = self._proc, None
            super().close()
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()    # armd's SIGTERM path freezes motion and lets go of the bus
        try:
            proc.wait(timeout=BRIDGE_STOP_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            self.log.warning('the bridge did not stop within %g s; killing it', BRIDGE_STOP_TIMEOUT_S)
            proc.kill()
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass

    # ---------------------------------------------------------------- errors
    def _exit_note(self) -> str:
        """The child's exit code, and its own last words.

        Waited for, bounded: the child has just closed its stdout, and the OS has not necessarily
        reaped it yet, so `returncode` can still be None - and "exit None" tells nobody anything.
        """
        code = self._proc.returncode if self._proc is not None else None
        if code is None and self._proc is not None:
            try:
                code = self._proc.wait(timeout=BRIDGE_REAP_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                code = None
        return f'the bridge is gone (exit {code}){self._stderr_note()}'

    def _stderr_note(self) -> str:
        tail = ' | '.join(line for line in self._stderr if line)
        return f' - it said: {tail}' if tail else ''
