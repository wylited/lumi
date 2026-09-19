"""The arm, as the rest of the rig sees it: one interface, several drivers.

`open_arm` is the only door. A rig with no arm is a rig that captures, uploads and speaks; it just
never gets an `arm.*` action, because the server reads a missing `arm` in the caps as exactly that.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .calibration import RIG_FILE, Calibration
from .console_arm import ConsoleArm
from .driver import (
    ArmDriver,
    ArmError,
    ArmPose,
    ArmTimeout,
    ArmUnavailable,
    ArmUnreachable,
    armd_answers,
    console_answers,
)
from .serial_arm import SerialArm

__all__ = [
    'ArmDriver',
    'ArmError',
    'ArmPose',
    'ArmTimeout',
    'ArmUnavailable',
    'ArmUnreachable',
    'Calibration',
    'ConsoleArm',
    'SerialArm',
    'open_arm',
]

DRIVERS = ('auto', 'console', 'serial', 'none')


def open_arm(cfg, log: logging.Logger) -> ArmDriver | None:
    """The arm this rig can drive, or None when there is no arm to drive.

    `console` and `serial` are the operator saying which one to use, and answer with that driver
    even when the arm is not there - its calls then raise ArmUnavailable carrying the console's own
    reason, which is more useful than a silent None. `auto` probes: the console first, since it
    owns the bus while it runs, then a bridge of the rig's own, and reports no arm when neither
    answers. `none` means this rig has no arm at all.
    """
    choice = str(getattr(cfg, 'arm_driver', 'auto') or 'auto').strip().lower()
    if choice not in DRIVERS:
        log.warning('arm driver %r is not one of %s; using auto', choice, '|'.join(DRIVERS))
        choice = 'auto'
    if choice == 'none':
        log.debug('no arm: the arm driver is set to none')
        return None

    calibration = Calibration.load(Path(cfg.heli_dir) / RIG_FILE)
    if choice == 'console':
        return ConsoleArm(cfg.console_url, calibration=calibration, log=log)
    if choice == 'serial':
        return SerialArm(cfg.console_url, calibration=calibration, log=log)

    if console_answers(cfg.console_url):
        answered, why = armd_answers(cfg.console_url)
        if not answered:
            # A console with no armd behind it answers every command with armd's own refusal, and
            # the caps that would advertise an arm are read from armd. It is also not this rig's
            # moment to start a bridge of its own: the console may bring armd back and take the bus
            # with it, which is not a race two writers of the same serial port should run.
            log.warning('the console is up but its arm daemon is not answering: %s', why)
            return None
        log.info('arm through the console at %s', cfg.console_url)
        return ConsoleArm(cfg.console_url, calibration=calibration, log=log)
    arm = SerialArm(cfg.console_url, calibration=calibration, log=log)
    try:
        arm.connect()
    except ArmError as exc:
        arm.close()
        log.warning('no arm: %s - the rig runs without one', exc)
        return None
    log.info('arm on the bus (%s)', arm.describe())
    return arm
