"""A new device carries the profile in the same tools as the user's other devices."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services.device_service import inherited_profile_targets  # noqa: E402


def test_new_device_gets_the_tools_other_devices_use():
    assert inherited_profile_targets([["codex", "claude_code"], ["claude_code", "antigravity"], None, []]) == [
        "claude_code", "codex", "antigravity",
    ]


def test_first_device_or_all_off_starts_with_none():
    assert inherited_profile_targets([]) == []
    assert inherited_profile_targets([[], None]) == []


def test_unknown_tools_are_dropped():
    assert inherited_profile_targets([["claude_code", "gone_tool"]]) == ["claude_code"]
