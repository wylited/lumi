"""The rig's speaker.

A line arrives as PCM S16LE on the desk socket and has to leave through the
Mac's own speakers. We take on no audio dependency for that: the bytes become a
temp WAV through the stdlib `wave` module and `afplay` plays it. `player` stays
a parameter because a rig that grows a Raspberry Pi passes `aplay` instead.

The server never queues two lines, so the rig must not either. A `play` while a
player is still alive stops the current one first, waits for it to be gone, and
only then starts its own. How often that happened is in `state()`, because a
line being cut short is worth seeing from the server side.

Nothing here raises. `play` runs on the socket's worker thread, where an
exception is a lost line with no report; every failure — no player, no PCM, a
nonzero exit — lands in `state()['lastError']`, and the caller still gets the
duration the line would have run for.
"""

from __future__ import annotations

import array
import logging
import math
import os
import subprocess
import sys
import tempfile
import threading
import wave
from pathlib import Path

__all__ = ["Speaker", "pcm_s16le_sine"]

log = logging.getLogger("heli_rig.audio")

# `afplay` exits on its own; this is only the grace period before escalating to
# SIGKILL on a player that ignores SIGTERM, which must not stall the socket.
_STOP_TIMEOUT_S = 1.0

_BYTES_PER_SAMPLE = 2
_TEMP_PREFIX = "heli-audio-"


def pcm_s16le_sine(
    tone_hz: float, seconds: float, sample_rate: int, channels: int = 1
) -> bytes:
    """A tone of PCM S16LE at half scale.

    Something audible for a rig self-check, and a signal of known length for the
    tests: the duration arithmetic is only provable against bytes whose length
    is already known.
    """
    frames = int(seconds * sample_rate)
    samples = array.array("h")
    for index in range(frames):
        value = int(round(math.sin(2 * math.pi * tone_hz * index / sample_rate) * 16383))
        samples.extend([value] * channels)
    if sys.byteorder == "big":  # `array` is native-endian; the wire is little
        samples.byteswap()
    return samples.tobytes()


def _pcm_duration_ms(pcm: bytes, sample_rate: int, channels: int) -> float:
    """How long this PCM lasts, from its own length.

    A caller that already knows the duration passes it in; this is the fallback,
    so a chunk that is not a whole number of frames is rounded down to what the
    player will actually play.
    """
    frame_bytes = _BYTES_PER_SAMPLE * max(channels, 1)
    if sample_rate <= 0:
        return 0.0
    return len(pcm) // frame_bytes / sample_rate * 1000.0


def _temp_dir() -> str | None:
    """`TMPDIR` is the rig's own knob: a rig run as a service wants its scratch
    space somewhere it controls, and `None` leaves `tempfile` to its default."""
    return os.environ.get("TMPDIR") or None


def _write_wav(pcm: bytes, sample_rate: int, channels: int) -> Path:
    """Write the PCM into a temp WAV the player can open."""
    handle, name = tempfile.mkstemp(
        prefix=_TEMP_PREFIX, suffix=".wav", dir=_temp_dir()
    )
    os.close(handle)
    path = Path(name)
    try:
        with wave.open(str(path), "wb") as out:
            out.setnchannels(channels)
            out.setsampwidth(_BYTES_PER_SAMPLE)
            out.setframerate(sample_rate)
            out.writeframes(pcm)
    except BaseException:
        # A half-written WAV is worse than none: nothing gets left behind.
        _unlink(path)
        raise
    return path


def _unlink(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass  # already gone is the outcome we wanted


class Speaker:
    """Plays one line of PCM at a time through an external player."""

    def __init__(self, player: str = "afplay", log: logging.Logger | None = None) -> None:
        self._player = player
        self._log = log if log is not None else logging.getLogger("heli_rig.audio")
        self._lock = threading.Lock()
        self._proc: subprocess.Popen[bytes] | None = None
        self._killed: subprocess.Popen[bytes] | None = None
        self._last_duration_ms = 0.0
        self._last_error: str | None = None
        self._last_wav: str | None = None
        self._plays = 0
        self._interrupted = 0

    @property
    def busy(self) -> bool:
        """True only while a player process is alive."""
        with self._lock:
            proc = self._proc
        return proc is not None and proc.poll() is None

    def play(
        self,
        pcm: bytes,
        sample_rate: int,
        channels: int,
        duration_ms: int | None = None,
    ) -> float:
        """Play `pcm` and return how long it ran, in milliseconds.

        Blocks until the player exits, so a caller can ack the line when it is
        actually over. Another thread calling `play` meanwhile cuts this one
        short rather than talking over it.
        """
        duration = (
            float(duration_ms)
            if duration_ms is not None
            else _pcm_duration_ms(pcm, sample_rate, channels)
        )
        with self._lock:
            self._last_duration_ms = duration

        if not pcm:
            self._fail("empty_audio")
            return duration

        if self.busy:
            with self._lock:
                self._interrupted += 1
            self._log.info("stopping the line that is still playing")
            self.stop()

        try:
            path = _write_wav(pcm, sample_rate, channels)
        except Exception as exc:
            # No failure here may reach the socket thread.
            self._fail(f"wav_failed: {exc}")
            self._log.warning("could not write the temp wav: %s", exc)
            return duration

        with self._lock:
            # Kept even after the file is gone: a silent rig is debugged by
            # knowing which file the player was handed.
            self._last_wav = str(path)

        try:
            proc = subprocess.Popen(
                [self._player, str(path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except OSError as exc:
            _unlink(path)
            if isinstance(exc, FileNotFoundError):
                error = f"no_player: {self._player}"
            else:
                error = f"player_failed: {exc}"
            self._fail(error)
            self._log.warning("%s", error)
            return duration

        with self._lock:
            self._proc = proc

        failed: str | None = None
        stderr = b""
        try:
            # Bounded by the line's own length plus the grace `stop()` allows. A
            # player that never exits — a wedged output device, another process
            # holding it — must not stall the socket: `play` is awaited by the
            # receive loop, so every action behind it would go unanswered.
            _, stderr = proc.communicate(timeout=duration / 1000.0 + _STOP_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            failed = (
                f"player_timeout: {self._player} did not finish "
                f"{duration / 1000.0 + _STOP_TIMEOUT_S:.1f}s after a {duration:.0f} ms line"
            )
            proc.kill()
            try:
                _, stderr = proc.communicate(timeout=_STOP_TIMEOUT_S)
            except Exception:
                stderr = b""
        except Exception as exc:
            # A broken pipe on our side must not cost the caller its answer.
            failed = f"player_wait_failed: {exc}"
        finally:
            with self._lock:
                killed = self._killed is proc
                if killed:
                    self._killed = None
                if self._proc is proc:
                    self._proc = None
            _unlink(path)
            if proc.poll() is None:  # communicate() gave up; leave no child behind
                proc.kill()
                proc.wait()

        code = proc.returncode
        if killed:
            # `stop()` or a newer line ended this one; that is not a failure.
            self._log.info("the line was stopped before it finished")
        elif failed is not None:
            self._fail(failed)
            self._log.warning("%s", failed)
        elif code == 0:
            with self._lock:
                self._plays += 1
                self._last_error = None
            self._log.debug("played %.0f ms", duration)
        else:
            detail = (stderr or b"").decode("utf-8", "replace").strip()
            error = f"player_exit_{code}" + (f": {detail}" if detail else "")
            self._fail(error)
            self._log.warning("%s exited %s", self._player, code)
        return duration

    def stop(self) -> None:
        """Kill the player. Safe when nothing is playing."""
        with self._lock:
            proc = self._proc
            if proc is None:
                return
            self._killed = proc

        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=_STOP_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                self._log.warning("%s ignored SIGTERM; killing it", self._player)
                proc.kill()
                proc.wait()

        with self._lock:
            if self._proc is proc:
                self._proc = None

    def state(self) -> dict:
        """What `desk.health` and a debugging session need to know."""
        with self._lock:
            proc = self._proc
            return {
                "playing": proc is not None and proc.poll() is None,
                "lastDurationMs": self._last_duration_ms,
                "lastError": self._last_error,
                "plays": self._plays,
                "interrupted": self._interrupted,
                "lastWav": self._last_wav,
            }

    def _fail(self, error: str) -> None:
        with self._lock:
            self._last_error = error
