from __future__ import annotations

import sys
import unittest
import uuid
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

    def test_retrieve_core_memories_prioritization(self):
        import asyncio
        from unittest.mock import AsyncMock, MagicMock
        import uuid
        from server.api.ask import _retrieve_core_memories
        from server.db.models import User, UserMemory

        mock_user = User(id=uuid.uuid4(), email="dev@example.com")
        mem_proj = UserMemory(
            id=uuid.uuid4(),
            user_id=mock_user.id,
            category="project",
            key="proj_memento_overview",
            tree_path="/project/memento/overview",
            content="Memento project architecture",
            is_folder=False,
            confidence=0.95,
        )
        mem_rule = UserMemory(
            id=uuid.uuid4(),
            user_id=mock_user.id,
            category="rule",
            key="windows_zip_update",
            tree_path="/rules/windows",
            content="Windows desktop auto-update must use .zip",
            is_folder=False,
            confidence=1.0,
        )

        db = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [mem_proj, mem_rule]
        mock_result.scalar_one_or_none.return_value = None
        db.execute.return_value = mock_result

        async def _run():
            return await _retrieve_core_memories(
                db=db,
                user=mock_user,
                question="这个项目发布怎么做",
                project_id="memento",
                cwd="/Users/dev/memento",
                limit=10,
            )

        mems = asyncio.run(_run())
        self.assertTrue(len(mems) > 0)
        keys = [m.key for m in mems]
        self.assertIn("proj_memento_overview", keys)

    def test_infer_conversation_config_codex(self):
        from server.api.ask import _infer_conversation_config
        from server.db.models import AskConversation

        mock_conv = AskConversation(
            id=uuid.uuid4(),
            title="写一个打地鼠的游戏",
            cwd="/Users/dev/react-native/my-game",
            device_id="haixingdeMac-mini.local",
            config={"execution_mode": "ai"},  # generic default
            turns=[
                {
                    "role": "user",
                    "content": "写一个打地鼠的游戏",
                },
                {
                    "role": "assistant",
                    "content": "任务执行完成",
                    "toolCalls": [
                        {
                            "name": "run_on_device",
                            "device_name": "haixingdeMac-mini.local",
                            "args": {
                                "action": "agent",
                                "binary": "codex",
                                "prompt": "【前文对话历史】 用户: 写一个打地鼠的游戏...",
                                "project_id": "proj-react-native-123",
                                "session_id": "sess-codex-abc",
                                "model": "gpt-5-codex",
                                "effort": "high",
                                "cwd": "/Users/dev/react-native/my-game",
                            },
                            "result": {
                                "status": "succeeded",
                                "exit_code": 0,
                            },
                        }
                    ],
                },
            ],
        )

        cfg, inferred = _infer_conversation_config(mock_conv)
        self.assertEqual(cfg["execution_mode"], "codex")
        self.assertEqual(cfg["project_id"], "proj-react-native-123")
        self.assertEqual(cfg["session_id"], "sess-codex-abc")
        self.assertEqual(cfg["model"], "gpt-5-codex")
        self.assertEqual(cfg["effort"], "high")
        self.assertEqual(cfg["cwd"], "/Users/dev/react-native/my-game")
        self.assertEqual(cfg["device_id"], "haixingdeMac-mini.local")

    def test_infer_conversation_config_json_string_args(self):
        import json
        from server.api.ask import _infer_conversation_config
        from server.db.models import AskConversation

        mock_conv = AskConversation(
            id=uuid.uuid4(),
            title="Claude 历史会话测试",
            config=None,
            turns=[
                {
                    "role": "assistant",
                    "content": "完成",
                    "tool_calls": [
                        {
                            "name": "run_on_device",
                            "args": json.dumps({
                                "action": "agent",
                                "binary": "claude",
                                "session_id": "sess-claude-xyz",
                            }),
                        }
                    ],
                }
            ],
        )

        cfg, inferred = _infer_conversation_config(mock_conv)
        self.assertEqual(cfg["execution_mode"], "claude")
        self.assertEqual(cfg["session_id"], "sess-claude-xyz")

    def test_clean_injected_title(self):
        import re
        dirty_q1 = "【前序会话核心记忆快照（原会话 ID: 52792607...）】\n### 核心记忆快照\n- 目标: 卸载\n当前用户指令：\n我是说会话新开的问题"
        clean_q1 = re.sub(r"^【前序会话核心记忆快照[\s\S]*?当前用户指令[：:]\s*", "", dirty_q1)
        clean_q1 = re.sub(r"^【前文对话历史】[\s\S]*?【当前用户指令】\s*", "", clean_q1).strip()
        self.assertEqual(clean_q1, "我是说会话新开的问题")

        dirty_q2 = "【前文对话历史】\n用户: 你好\n助手: 在的\n【当前用户指令】\n再做一个视频吧"
        clean_q2 = re.sub(r"^【前序会话核心记忆快照[\s\S]*?当前用户指令[：:]\s*", "", dirty_q2)
        clean_q2 = re.sub(r"^【前文对话历史】[\s\S]*?【当前用户指令】\s*", "", clean_q2).strip()
        self.assertEqual(clean_q2, "再做一个视频吧")

    def test_pinned_conversation_request(self):
        from server.api.ask import UpdateConversationRequest
        req = UpdateConversationRequest(pinned=True, title="Pinned Conversation")
        self.assertTrue(req.pinned)
        self.assertEqual(req.title, "Pinned Conversation")

        req_unpin = UpdateConversationRequest(pinned=False)
        self.assertFalse(req_unpin.pinned)

    def test_pinned_conversation_sorting(self):
        items = [
            {"id": "1", "updated_at": "2026-10-14T09:00:00Z", "config": {}},
            {"id": "2", "updated_at": "2026-10-14T08:00:00Z", "config": {"pinned": True}},
            {"id": "3", "updated_at": "2026-10-14T09:30:00Z", "config": {"pinned": False}},
            {"id": "4", "updated_at": "2026-10-14T07:00:00Z", "config": {"pinned": True}},
        ]
        from datetime import datetime
        items.sort(
            key=lambda x: (
                0 if (x.get("config") or {}).get("pinned") else 1,
                -(datetime.fromisoformat(x["updated_at"].replace("Z", "+00:00")).timestamp() if x.get("updated_at") else 0),
            )
        )
        # Pinned items come first, sorted by updated_at desc (2 then 4), then unpinned (3 then 1)
        self.assertEqual([x["id"] for x in items], ["2", "4", "3", "1"])


if __name__ == "__main__":
    unittest.main()


