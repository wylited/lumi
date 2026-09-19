"""The desk rig: the Mac that holds the camera, sends frames and takes actions.

`config` is what the environment and the flags said, `camera` produces one JPEG
at a time from whichever process holds the device, `upload` posts it to the
server, and `capture` sets the cadence the rest of the rig reads.
"""

AGENT_VERSION = "0.1.0"
