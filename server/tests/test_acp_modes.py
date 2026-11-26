"""ACP agents: allowed as execution modes, and a device lists the ones it has installed."""

import uuid
from unittest.mock import patch

from server.api import devices
from server.db.models import User
from server.services.ask_stream import ACP_MODES, AGENT_MODES


def test_acp_agents_are_agent_modes():
    assert set(ACP_MODES) == {"opencode", "gemini", "cursor", "kiro", "copilot"}
    assert {"claude", "codex", "antigravity", "workbuddy"} <= set(AGENT_MODES)
    assert set(ACP_MODES) <= set(AGENT_MODES)


def test_a_device_lists_the_acp_agents_it_reported():
    user = User(id=uuid.uuid4(), email="u@example.com", role="owner")
    caps = {"claude": {"tool": "claude"}, "gemini": {"tool": "gemini", "protocol": "acp"}, "opencode": {"tool": "opencode", "protocol": "acp"}, "environment": {}}
    with patch("server.services.device_reports.get_cached_device_capabilities", lambda name, user=None: caps):
        assert devices._acp_agents("mini", user) == ["gemini", "opencode"]
    with patch("server.services.device_reports.get_cached_device_capabilities", lambda name, user=None: None):
        assert devices._acp_agents("mini", user) == []
