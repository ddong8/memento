"""A new agent session is told the environment of the device it really runs on.

2026-11-17: with the device on "auto", the environment profile was looked up before a device was picked; the
lookup hands back the first device in the capability cache, so a task that went to the Mac was told it ran
on Linux as opc (vps3) and not to bother checking with which/--version.
"""
from __future__ import annotations

import asyncio
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import Machine, User
from server.services import orchestrator
from server.services.device_reports import get_device_environment_summary, set_device_capabilities

LINUX_NAMES = ("tok-fp-vps", "fp-vps (Linux)", "mid-fp-vps")
MAC_NAMES = ("tok-fp-mac", "fp-mac.local (Darwin)", "mid-fp-mac")
LINUX_ENV = {"environment": {"platform": "linux", "arch": "arm64", "shell": "/bin/bash", "username": "opc"}}
MAC_ENV = {"environment": {"platform": "darwin", "arch": "arm64", "shell": "/bin/zsh", "username": "fp-mac-user"}}
MAC = Machine(id=uuid.uuid4(), name=MAC_NAMES[1], collector_token_hash=MAC_NAMES[0], is_archived=False)
OWNER = User(id=uuid.uuid4(), email="o@example.com", role="owner")


def _cache_devices() -> None:
    # The Linux box first: the order "auto" used to pick from
    set_device_capabilities(LINUX_NAMES, LINUX_ENV)
    set_device_capabilities(MAC_NAMES, MAC_ENV)


def _dispatched_payload(args: dict) -> dict:
    """Run run_on_device up to the task it queues, picking the Mac, and return that task's payload."""
    added: list = []
    db = AsyncMock()
    db.add = MagicMock(side_effect=added.append)
    db.execute.return_value = MagicMock(scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[MAC]))))

    async def run() -> None:
        gen = orchestrator._tool_run_on_device(db, OWNER, args)
        try:
            async for evt in gen:
                if evt.get("type") == "task_progress" or added:
                    break
        finally:
            await gen.aclose()

    resonance = MagicMock()
    with patch("server.api.tasks.REMOTE_EXEC_ENABLED", True), \
         patch.object(orchestrator, "_select_affinity_machine", AsyncMock(return_value=MAC)), \
         patch.object(orchestrator, "_device_cwd", AsyncMock(return_value=None)), \
         patch.object(orchestrator.ws_manager, "has_device", lambda name: name in MAC_NAMES), \
         patch("server.services.mind_resonance_service.sense_resonance", AsyncMock(return_value=resonance)), \
         patch("server.services.mind_resonance_service.render_mind_resonance_markdown", lambda r: ""):
        asyncio.run(run())
    assert added, "no task was queued"
    return added[0].payload


class EnvironmentProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        _cache_devices()

    def test_no_profile_without_a_named_device(self) -> None:
        for device in (None, "", "auto", "ask_only", "all"):
            self.assertIsNone(get_device_environment_summary(device, OWNER), device)

    def test_a_named_device_gets_its_own_profile(self) -> None:
        self.assertIn("darwin (arm64)", get_device_environment_summary(MAC_NAMES[1], OWNER) or "")
        self.assertIn("linux (arm64)", get_device_environment_summary(LINUX_NAMES[0], OWNER) or "")

    def test_auto_dispatch_tells_the_task_about_the_device_it_landed_on(self) -> None:
        append = _dispatched_payload({"device_id": "auto", "action": "agent", "binary": "claude", "prompt": "memento"}).get(
            "system_prompt_append") or ""
        self.assertIn("【目标设备就绪环境指纹画像】", append)
        self.assertIn("darwin (arm64)", append)
        self.assertIn("fp-mac-user", append)
        self.assertNotIn("linux", append)
        self.assertNotIn("opc", append)

    def test_the_profile_goes_after_what_the_caller_appended(self) -> None:
        append = _dispatched_payload({"device_id": "auto", "action": "agent", "binary": "claude", "prompt": "q",
                                      "system_prompt_append": "【调用方】"})["system_prompt_append"]
        self.assertTrue(append.startswith("【调用方】"))
        self.assertIn("darwin (arm64)", append)

    def test_a_resumed_session_is_not_told_again(self) -> None:
        payload = _dispatched_payload({"device_id": "auto", "action": "agent", "binary": "claude", "prompt": "q",
                                       "session_id": str(uuid.uuid4())})
        self.assertNotIn("【目标设备就绪环境指纹画像】", payload.get("system_prompt_append") or "")


if __name__ == "__main__":
    unittest.main()
