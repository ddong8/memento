from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.api.ask import _classify_continuation  # noqa: E402


class AskContinuationTests(unittest.TestCase):
    def setUp(self):
        self.history = [
            {"role": "user", "content": "帮我看看 Mac mini 上有什么进程运行"},
            {
                "role": "assistant",
                "content": (
                    "已检查 Mac mini 上的进程状态。虽然 CPU 和内存占用不高，但当前有以下关键任务正在运行：\n"
                    "1. PPT 生成任务 (PID 3839) : slidep-start ...\n"
                    "💡 提示：注意到有一个之前遗留的 PPT 生成守护进程还在后台运行（从逆合成分析项目遗留至今）。如果你不再需要它，可以告诉我帮你清理。"
                ),
                "tool_calls": [
                    {
                        "name": "run_on_device",
                        "args": {"device_id": "Mac mini", "action": "shell", "command": "ps aux"},
                        "status": "succeeded",
                    }
                ],
            },
        ]

    def test_action_continuation_commands(self):
        test_cases = [
            ("帮我关闭它", True, True),
            ("关掉", True, True),
            ("关了它", True, True),
            ("把它杀了", True, True),
            ("杀死这个进程", True, True),
            ("清理掉这个守护进程", True, True),
            ("好的", True, True),
            ("可以", True, True),
            ("行，帮我清理一下", True, True),
            ("把PID 3839干掉", True, True),
            ("重启一下服务", True, True),
        ]
        for query, expected_cont, expected_act in test_cases:
            is_cont, is_act, ctx = _classify_continuation(query, self.history)
            self.assertEqual(is_cont, expected_cont, f"Failed cont for '{query}'")
            self.assertEqual(is_act, expected_act, f"Failed act for '{query}'")
            self.assertEqual(ctx["device_name"], "Mac mini")
            self.assertTrue(any("3839" in e for e in ctx["entities"]))

    def test_informational_continuation(self):
        query = "为什么这个任务会遗留？"
        is_cont, is_act, ctx = _classify_continuation(query, self.history)
        self.assertTrue(is_cont)
        self.assertFalse(is_act)  # Not an action command, so RAG should be allowed

    def test_unrelated_query(self):
        query = "明天北京天气怎么样"
        is_cont, is_act, ctx = _classify_continuation(query, self.history)
        self.assertFalse(is_cont)
        self.assertFalse(is_act)


if __name__ == "__main__":
    unittest.main()
