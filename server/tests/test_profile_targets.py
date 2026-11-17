"""Every device carries the profile in all its tools unless the user turned one off there."""

from __future__ import annotations

import sys
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

import pytest  # noqa: E402

from server.db.models import Machine, User  # noqa: E402
from server.services.profile_targets import INJECTION_TARGETS, profile_targets, targets_off  # noqa: E402


def test_a_device_nobody_configured_injects_into_every_tool():
    assert profile_targets(Machine(name="vps3", collector_token_hash="d")) == list(INJECTION_TARGETS)
    # The old opt-in list no longer limits it: devices left at [] got nothing before
    assert profile_targets(Machine(name="mbp", collector_token_hash="d", profile_targets=[])) == list(INJECTION_TARGETS)


def test_turned_off_tools_stay_off():
    m = Machine(name="mac", collector_token_hash="d", profile_targets_off=["workbuddy", "hermes"])
    assert profile_targets(m) == ["claude_code", "codex", "antigravity", "openclaw"]
    assert targets_off(["claude_code", "codex", "antigravity", "openclaw"]) == ["workbuddy", "hermes"]


@pytest.mark.asyncio
async def test_unticking_a_tool_in_the_web_app_turns_just_that_one_off():
    from server.api import profile as profile_api

    m = Machine(id=uuid.uuid4(), name="mac", collector_token_hash="dev1")
    user = User(id=uuid.uuid4(), email="u@example.com")
    db = MagicMock(commit=AsyncMock())
    body = profile_api.TargetsBody(targets=[t for t in INJECTION_TARGETS if t != "codex"])
    with patch.object(profile_api, "_owned_machine", AsyncMock(return_value=m)), \
         patch.object(profile_api, "_bust_user_profile_cache", AsyncMock()):
        res = await profile_api.set_device_targets("dev1", body, db=db, user=user)
    assert m.profile_targets_off == ["codex"]
    assert "codex" not in res["targets"] and "claude_code" in res["targets"]
