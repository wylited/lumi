"""HELI-045's speaker: the duration arithmetic, the one-line rule, the failures.

Every test points `player` at a stand-in that records what it was handed — a
real `afplay` in a test suite is a test that needs speakers and a second per
line. What is asserted is what a caller can observe: the returned duration, the
WAV the player actually received, the order in which players were started and
stopped, and `state()`.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest

from heli_rig.audio import Speaker, pcm_s16le_sine

# The stand-in player: it notes its lifetime (so a test can prove an overlap
# never happened) and the WAV it was handed, waits `HELI_SECONDS`, then exits
# with `HELI_EXIT`. The `up` line is written only after SIGTERM is handled, so a
# test can wait for the player to be interruptible before interrupting it.
_PLAYER_SOURCE = '''#!{python}
import os
import signal
import sys
import time
import wave

trace = os.environ.get("HELI_TRACE")


def note(line):
    if trace:
        with open(trace, "a") as handle:
            handle.write(line + "\\n")


note("start %d" % os.getpid())
if len(sys.argv) > 1:
    try:
        with wave.open(sys.argv[1], "rb") as wav:
            note("wav %d %d %d %d" % (os.getpid(), wav.getframerate(), wav.getnchannels(), wav.getnframes()))
    except Exception as exc:
        note("badwav %d %s" % (os.getpid(), exc))


def stopped(signum, frame):
    note("term %d" % os.getpid())
    sys.exit(0)


signal.signal(signal.SIGTERM, stopped)
note("up %d" % os.getpid())

deadline = time.monotonic() + float(os.environ.get("HELI_SECONDS", "0"))
while time.monotonic() < deadline:
    time.sleep(0.005)

note("end %d" % os.getpid())
sys.exit(int(os.environ.get("HELI_EXIT", "0")))
'''


def _trace(tmp_path: Path) -> Path:
    return tmp_path / "player-trace"


def _fake_player(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    seconds: float = 0.0,
    code: int = 0,
) -> str:
    """Write the stand-in and point its environment at this test's trace."""
    script = tmp_path / "fake-player"
    script.write_text(_PLAYER_SOURCE.format(python=sys.executable))
    script.chmod(0o755)
    monkeypatch.setenv("HELI_TRACE", str(_trace(tmp_path)))
    monkeypatch.setenv("HELI_SECONDS", str(seconds))
    monkeypatch.setenv("HELI_EXIT", str(code))
    return str(script)


def _events(tmp_path: Path) -> list[tuple[str, int, str]]:
    trace = _trace(tmp_path)
    if not trace.exists():
        return []
    events = []
    for line in trace.read_text().splitlines():
        parts = line.split(" ", 2)
        if len(parts) >= 2 and parts[1].isdigit():
            events.append((parts[0], int(parts[1]), parts[2] if len(parts) > 2 else ""))
    return events


def _wait_for(predicate, timeout: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("timed out waiting for the player")


def _tone(seconds: float = 0.2, sample_rate: int = 16000, channels: int = 1) -> bytes:
    return pcm_s16le_sine(440.0, seconds, sample_rate, channels)


def test_the_duration_comes_from_the_pcm_and_an_explicit_duration_wins(
    tmp_path, monkeypatch
):
    speaker = Speaker(player=_fake_player(tmp_path, monkeypatch))
    pcm = _tone(0.4, 16000, 1)
    assert len(pcm) == 6400 * 2

    assert speaker.play(pcm, 16000, 1) == pytest.approx(400.0)

    # The same bytes read as stereo 22.05 kHz last half as long.
    stereo_ms = len(pcm) // 4 / 22050 * 1000
    assert speaker.play(pcm, 22050, 2) == pytest.approx(stereo_ms)

    assert speaker.play(pcm, 16000, 1, duration_ms=250) == 250.0
    assert speaker.state()["plays"] == 3


def test_the_player_is_handed_a_wav_of_the_asked_format(tmp_path, monkeypatch):
    speaker = Speaker(player=_fake_player(tmp_path, monkeypatch))
    assert speaker.play(_tone(0.25, 8000, 1), 8000, 1) == pytest.approx(250.0)

    formats = [event for event in _events(tmp_path) if event[0] == "wav"]
    assert len(formats) == 1
    assert formats[0][2] == "8000 1 2000"


def test_the_temp_wav_lands_in_tmpdir_and_does_not_outlive_the_line(
    tmp_path, monkeypatch
):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    monkeypatch.setenv("TMPDIR", str(scratch))
    speaker = Speaker(player=_fake_player(tmp_path, monkeypatch))

    speaker.play(_tone(), 16000, 1)

    last = Path(speaker.state()["lastWav"])
    assert last.parent == scratch
    assert not last.exists()


def test_a_second_line_ends_the_first_one_before_it_starts(tmp_path, monkeypatch):
    player = _fake_player(tmp_path, monkeypatch, seconds=2.0)
    speaker = Speaker(player=player)
    pcm = _tone(0.1)

    played: list[float] = []
    first = threading.Thread(
        target=lambda: played.append(speaker.play(pcm, 16000, 1)), daemon=True
    )
    first.start()
    _wait_for(lambda: speaker.busy)
    _wait_for(lambda: any(event[0] == "up" for event in _events(tmp_path)))

    monkeypatch.setenv("HELI_SECONDS", "0")  # the interrupting line is a short one
    started = time.monotonic()
    assert speaker.play(pcm, 16000, 1) == pytest.approx(100.0)
    interrupting_ms = (time.monotonic() - started) * 1000

    first.join(timeout=2.0)
    assert not first.is_alive()
    assert len(played) == 1  # the first call returned, so its player is gone

    events = _events(tmp_path)
    starts = [event for event in events if event[0] == "start"]
    assert len(starts) == 2
    first_pid, second_pid = starts[0][1], starts[1][1]

    assert ("term", first_pid, "") in events
    assert not any(event[0] == "end" and event[1] == first_pid for event in events)
    assert events.index(("term", first_pid, "")) < events.index(
        ("start", second_pid, "")
    )
    assert any(event[0] == "end" and event[1] == second_pid for event in events)

    assert speaker.state()["interrupted"] == 1
    assert interrupting_ms < 2000  # it did not wait the first player out


def test_an_empty_chunk_is_reported_and_plays_nothing(tmp_path, monkeypatch):
    speaker = Speaker(player=_fake_player(tmp_path, monkeypatch, seconds=2.0))

    assert speaker.play(b"", 16000, 1) == 0

    state = speaker.state()
    assert state["lastError"] == "empty_audio"
    assert state["plays"] == 0
    assert state["playing"] is False
    assert not _trace(tmp_path).exists()  # no player was ever started


def test_a_player_that_exits_nonzero_is_reported_not_raised(tmp_path, monkeypatch):
    speaker = Speaker(player=_fake_player(tmp_path, monkeypatch, code=3))

    assert speaker.play(_tone(0.2), 16000, 1) == pytest.approx(200.0)

    state = speaker.state()
    assert state["lastError"] == "player_exit_3"
    assert state["plays"] == 0
    assert state["playing"] is False


def test_a_missing_player_is_reported_not_raised(tmp_path, monkeypatch):
    speaker = Speaker(player=str(tmp_path / "no-such-player"))

    assert speaker.play(_tone(0.2), 16000, 1) == pytest.approx(200.0)

    state = speaker.state()
    assert state["lastError"].startswith("no_player:")
    assert state["plays"] == 0


def test_stop_is_safe_when_idle_and_ends_a_line_in_flight(tmp_path, monkeypatch):
    player = _fake_player(tmp_path, monkeypatch, seconds=2.0)
    speaker = Speaker(player=player)

    speaker.stop()  # nothing is playing; this must be a no-op
    assert speaker.state()["plays"] == 0
    assert speaker.state()["interrupted"] == 0

    played: list[float] = []
    playing = threading.Thread(
        target=lambda: played.append(speaker.play(_tone(0.1), 16000, 1)), daemon=True
    )
    playing.start()
    _wait_for(lambda: speaker.busy)
    _wait_for(lambda: any(event[0] == "up" for event in _events(tmp_path)))

    speaker.stop()
    playing.join(timeout=1.0)

    assert not playing.is_alive()
    state = speaker.state()
    assert state["playing"] is False
    assert speaker.busy is False
    assert state["plays"] == 0  # a stopped line is not a line that played
    assert state["interrupted"] == 0
    assert not Path(state["lastWav"]).exists()
    assert any(event[0] == "term" for event in _events(tmp_path))
