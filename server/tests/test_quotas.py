from __future__ import annotations

import unittest
import uuid

from server.api.quotas import _make_fallback_report
from server.db.models import User
from server.services.device_reports import (
    get_cached_device_capabilities,
    get_cached_device_quotas,
    record_owner,
    set_cached_device_quotas,
    set_device_capabilities,
)


class QuotasCoordinatorTests(unittest.TestCase):
    def test_fallback_report_structure(self) -> None:
        report = _make_fallback_report("device-123", "MacBook-Pro")
        self.assertEqual(report["device_id"], "device-123")
        self.assertEqual(report["device_name"], "MacBook-Pro")
        self.assertIn("antigravity", report["tools"])
        self.assertIn("claude_code", report["tools"])
        self.assertIn("codex", report["tools"])
        self.assertFalse(report["tools"]["antigravity"]["available"])
        self.assertIsNone(report["tools"]["antigravity"]["remaining_percent"])

    def test_cache_and_lookup(self) -> None:
        sample_report = {
            "device_id": "mac-uuid-1",
            "tools": {
                "antigravity": {
                    "tool": "antigravity",
                    "remaining_percent": 50.2,
                    "plan_name": "Google AI Pro",
                }
            },
        }
        set_cached_device_quotas("mac-uuid-1", sample_report, machine_name="MacMini", machine_id="mid-99")
        
        # Test lookup by device_id
        res1 = get_cached_device_quotas("mac-uuid-1")
        self.assertIsNotNone(res1)
        self.assertEqual(res1["device_name"], "MacMini")
        self.assertEqual(res1["tools"]["antigravity"]["remaining_percent"], 50.2)

        # Test lookup by machine_name
        res2 = get_cached_device_quotas("MacMini")
        self.assertIsNotNone(res2)
        self.assertEqual(res2["device_id"], "mac-uuid-1")

        # Test lookup by fallback / latest
        res3 = get_cached_device_quotas(None)
        self.assertIsNotNone(res3)
        self.assertEqual(res3["device_id"], "mac-uuid-1")

        res_auto = get_cached_device_quotas("auto")
        self.assertIsNotNone(res_auto)
        self.assertEqual(res_auto["device_id"], "mac-uuid-1")

        # Test lookup by unknown/non-matching device_id MUST return None
        res_unknown = get_cached_device_quotas("non-existent-device-id")
        self.assertIsNone(res_unknown)

    def test_reports_are_only_shown_to_whoever_may_see_the_device(self) -> None:
        owner_id, other_id = uuid.uuid4(), uuid.uuid4()
        mine = User(id=owner_id, email="me@example.com", role="user")
        someone_else = User(id=other_id, email="x@example.com", role="user")
        admin = User(id=uuid.uuid4(), email="a@example.com", role="admin")
        names = ("hash-77", "Studio", "mid-77")
        record_owner(names, str(owner_id))
        set_cached_device_quotas("hash-77", {"tools": {}}, machine_name="Studio", machine_id="mid-77")
        set_device_capabilities(names, {"codex": {"models": ["gpt"]}})

        self.assertEqual(get_cached_device_quotas("Studio", mine)["device_id"], "hash-77")
        self.assertEqual(get_cached_device_quotas("Studio", admin)["device_id"], "hash-77")
        self.assertIsNone(get_cached_device_quotas("Studio", someone_else))
        self.assertIsNone(get_cached_device_quotas("Stud", someone_else))  # no fuzzy match into others' devices
        latest = get_cached_device_quotas(None, someone_else)
        self.assertTrue(latest is None or latest["device_id"] != "hash-77")

        self.assertEqual(get_cached_device_capabilities("Studio", "codex", mine), {"models": ["gpt"]})
        self.assertIsNone(get_cached_device_capabilities("Studio", "codex", someone_else))
        self.assertIsNone(get_cached_device_capabilities(None, "codex", someone_else))

    def test_prompt_carries_the_device_environment_for_its_owner_only(self) -> None:
        from server.services.ask_prompt import build_messages

        owner_id = uuid.uuid4()
        mine = User(id=owner_id, email="me@example.com", role="user")
        someone_else = User(id=uuid.uuid4(), email="x@example.com", role="user")
        names = ("hash-88", "Lab-Mac", "mid-88")
        record_owner(names, str(owner_id))
        set_device_capabilities(names, {"environment": {"platform": "darwin", "arch": "arm64", "shell": "zsh"}})

        def system_prompt(user: User) -> str:
            return build_messages("q", [], None, device_id="Lab-Mac", user=user)[0]["content"]

        self.assertIn("darwin (arm64)", system_prompt(mine))
        self.assertNotIn("darwin (arm64)", system_prompt(someone_else))

    def test_ws_manager_online_helpers(self) -> None:
        from server.services.ws_manager import DeviceConnectionManager
        mgr = DeviceConnectionManager()
        self.assertFalse(mgr.has_online_devices())
        self.assertFalse(mgr.is_online("dev-1"))
        mgr._connections["dev-1"] = object()  # mock ws
        self.assertTrue(mgr.has_online_devices())
        self.assertTrue(mgr.is_online("dev-1"))
        self.assertEqual(mgr.connected_ids(), ["dev-1"])
