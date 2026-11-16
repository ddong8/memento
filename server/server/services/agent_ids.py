"""Small checks on what devices report about themselves and their agents' sessions.

Both went wrong by matching text loosely (2026-11-16):
  - "win" in a device name: "darwin" contains it, so every Mac was taken for Windows, a task's Unix folder
    looked like another platform's path and was swapped for one guessed from the project's documents
    (302 Antigravity tasks on one Mac in 30 days ran in a conversation's walkthrough.md, i.e. the home folder);
  - a session id read out of an agent's output: `session_id: ""` in a file Antigravity read became the
    session `\\"\\"`, and every turn after it failed with "Timed out waiting for Antigravity response log".
"""

from __future__ import annotations

import re

# Devices are named "<host> (Darwin)" by the collector; the platform isn't stored on its own
_PLATFORM_SUFFIX_RE = re.compile(r"\((darwin|macos|windows|linux|ios|android)\)\s*$", re.IGNORECASE)
_OS_OF_SUFFIX = {"darwin": "macos", "macos": "macos", "windows": "windows", "linux": "linux", "ios": "ios", "android": "android"}

# Agents' session ids: UUIDs, or tokens such as "wb-session-1" (letters, digits, - _ . : @)
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][\w.:@-]{0,127}$", re.ASCII)
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def device_os(name: str | None) -> str | None:
    """"macos", "windows", "linux", "ios" or "android" from the device's name; None when it doesn't say."""
    m = _PLATFORM_SUFFIX_RE.search(name or "")
    return _OS_OF_SUFFIX[m.group(1).lower()] if m else None


def clean_session_id(value: object, binary: str | None = None) -> str | None:
    """The session id, trimmed, when an agent could have made it; None for anything else (text taken for one).

    Antigravity's conversations (the app's and Google's CLI's) are UUIDs, so for it nothing else goes."""
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not _SESSION_ID_RE.match(s):
        return None
    b = (binary or "").lower()
    if ("agy" in b or "antigravity" in b) and not _UUID_RE.match(s):
        return None
    return s


_REPORTED_SESSION_RE = re.compile(r"^session id:\s*(\S+)", re.IGNORECASE | re.MULTILINE)


def reported_session_id(stderr: str | None, binary: str | None = None) -> str | None:
    """The session memento's runners name on stderr ("session id: <id>", one line per run; the last counts).

    Never read out of the answer (stdout): it can quote any id. For a device too old to report the session
    itself, or one that reported text taken for it."""
    last = None
    for m in _REPORTED_SESSION_RE.finditer(stderr or ""):
        sid = clean_session_id(m.group(1), binary)
        if sid:
            last = sid
    return last
