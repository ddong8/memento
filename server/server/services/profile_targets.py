"""Which AI tools on a device carry the resident profile (and with it the memento-memory MCP entry,
the completion-check hook and the skills folder).

Every tool, unless the user turned it off for that device: the daemon only writes into tools it finds
installed (their own directory exists) and picks one up on the next sync once it is installed, so a
new computer or an executor gets the profile without anyone ticking boxes. Before 2026-11-17 each
device started with none and kept none until someone found the switch in the web app.
"""

from __future__ import annotations

from collections.abc import Iterable

INJECTION_TARGETS = ("claude_code", "codex", "antigravity", "workbuddy", "openclaw", "hermes")


def profile_targets(machine) -> list[str]:
    """The tools this device injects into: all of them but the ones turned off."""
    off = set(getattr(machine, "profile_targets_off", None) or [])
    return [t for t in INJECTION_TARGETS if t not in off]


def targets_off(wanted: Iterable[str]) -> list[str]:
    """What to store for a device whose user wants exactly `wanted` on."""
    on = set(wanted)
    return [t for t in INJECTION_TARGETS if t not in on]
