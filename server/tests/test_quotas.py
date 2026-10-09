from __future__ import annotations

import unittest
from server.api.quotas import (
    _make_fallback_report,
    get_cached_device_quotas,
    set_cached_device_quotas,
)


class QuotasCoordinatorTests(unittest.TestCase):
    def test_fallback_report_structure(self) -> None:
        report = _make_fallback_report("device-123", "MacBook-Pro")
        self.assertEqual(report["device_id"], "device-123")
        self.assertEqual(report["device_name"], "MacBook-Pro")
        self.assertIn("antigravity", report["tools"])
        self.assertIn("claude_code", report["tools"])
        self.assertIn("codex", report["tools"])
        self.assertTrue(report["tools"]["antigravity"]["available"])
        self.assertEqual(report["tools"]["antigravity"]["plan_name"], "Google AI Pro")

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

    def test_ws_manager_online_helpers(self) -> None:
        from server.services.ws_manager import DeviceConnectionManager
        mgr = DeviceConnectionManager()
        self.assertFalse(mgr.has_online_devices())
        self.assertFalse(mgr.is_online("dev-1"))
        mgr._connections["dev-1"] = object()  # mock ws
        self.assertTrue(mgr.has_online_devices())
        self.assertTrue(mgr.is_online("dev-1"))
        self.assertEqual(len(mgr.active_connections), 1)
