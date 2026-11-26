"""Tests for AI 编排 context compression, token budgeting, and in-loop overflow recovery."""

from __future__ import annotations

import json
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.db.models import AskConversation, User  # noqa: E402
from server.services import orchestrator, orchestrator_context  # noqa: E402
from server.services.ask_prompt import build_messages  # noqa: E402


def _make_turns(pair_count: int, body_repeat: int = 1) -> list[dict]:
    turns: list[dict] = []
    for i in range(pair_count):
        turns.append({"role": "user", "content": f"第 {i + 1} 轮需求：排查服务端口与日志 " + ("细节说明 " * body_repeat)})
        turns.append({
            "role": "assistant",
            "content": f"第 {i + 1} 轮结论：已在 Mac mini 上定位到 PID {3000 + i}，路径 /Users/dev/app " + ("分析内容 " * body_repeat),
            "toolCalls": [
                {
                    "name": "search_memory",
                    "args": {"query": f"服务配置 {i + 1}"},
                    "result": {"markdown": "命中 2 条记录"},
                }
            ],
        })
    return turns


class OrchestratorContextTests(unittest.IsolatedAsyncioTestCase):
    def test_token_estimation_handles_cjk_images_and_base64(self) -> None:
        msg_text = {"role": "user", "content": "请检查服务器状态并压缩历史上下文"}
        tok_text = orchestrator_context.estimate_message_tokens(msg_text)
        self.assertGreater(tok_text, 15)

        huge_b64 = "data:image/png;base64," + ("A" * 5000)
        msg_b64 = {"role": "user", "content": f"看这张图 {huge_b64}"}
        tok_b64 = orchestrator_context.estimate_message_tokens(msg_b64)
        self.assertLess(tok_b64, 200)  # base64 stripped, not counted raw

        msg_vision = {
            "role": "user",
            "content": [
                {"type": "text", "text": "分析截图"},
                {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}},
            ],
        }
        self.assertGreaterEqual(orchestrator_context.estimate_message_tokens(msg_vision), 770)

    def test_overflow_error_detection(self) -> None:
        self.assertTrue(orchestrator_context.is_context_overflow_error("HTTP 400: maximum context length exceeded"))
        self.assertTrue(orchestrator_context.is_context_overflow_error("context_length_exceeded"))
        self.assertTrue(orchestrator_context.is_context_overflow_error("Prompt is too long"))
        self.assertFalse(orchestrator_context.is_context_overflow_error("Connection refused"))

    async def test_prepare_ai_history_auto_compacts_and_persists_checkpoint(self) -> None:
        user = User(id=uuid.uuid4(), email="u@test.local")
        conv_id = uuid.uuid4()
        turns = _make_turns(8, body_repeat=4)  # 16 turns > AI_MAX_RAW_TURNS (12)
        persisted: dict = {}

        async def fake_load(_cid):
            return turns, {}

        async def fake_persist(_cid, payload):
            persisted.update(payload)

        with patch.object(orchestrator_context, "_load_conversation_turns_and_checkpoint", side_effect=fake_load), \
             patch.object(orchestrator_context, "_persist_checkpoint", side_effect=fake_persist), \
             patch.object(orchestrator_context, "get_ai_providers", return_value=[{"name": "mock"}]), \
             patch.object(orchestrator_context, "call_plain_chat", AsyncMock(return_value="### 对话核心目标\n- CHECKPOINT_MARKER_99 已定位 Mac mini PID 3007")):
            summary, recent, stats, evt = await orchestrator_context.prepare_ai_history(
                conv_id=conv_id,
                client_history=None,
                user=user,
                force_compact=False,
            )

        self.assertIn("CHECKPOINT_MARKER_99", summary)
        self.assertIsNotNone(evt)
        self.assertEqual(evt.scope, "history")
        self.assertEqual(evt.mode, "auto")
        self.assertEqual(len(recent) + evt.compacted_turns, len(turns))
        self.assertEqual(persisted["compacted_turn_count"], evt.compacted_turns)
        self.assertTrue(stats["has_checkpoint"])

        # Verify checkpoint is injected ONCE in build_messages, never duplicated in system or user
        msgs = build_messages(
            "继续排查",
            [],
            recent,
            checkpoint_summary=summary,
            max_history_turns=len(recent),
        )
        occurrences = sum(1 for m in msgs if "CHECKPOINT_MARKER_99" in str(m.get("content") or ""))
        self.assertEqual(occurrences, 1)
        self.assertNotIn("CHECKPOINT_MARKER_99", msgs[0]["content"])
        self.assertNotIn("CHECKPOINT_MARKER_99", msgs[-1]["content"])

    async def test_prepare_ai_history_reuses_existing_checkpoint_incrementally(self) -> None:
        user = User(id=uuid.uuid4(), email="u@test.local")
        conv_id = uuid.uuid4()
        turns = _make_turns(7)  # 14 turns total, first 10 already compacted -> only 4 uncovered
        existing_ckpt = {"summary": "早期摘要内容", "compacted_turn_count": 10}
        llm_mock = AsyncMock()

        with patch.object(orchestrator_context, "_load_conversation_turns_and_checkpoint", AsyncMock(return_value=(turns, existing_ckpt))), \
             patch.object(orchestrator_context, "call_plain_chat", llm_mock):
            summary, recent, stats, evt = await orchestrator_context.prepare_ai_history(
                conv_id=conv_id,
                client_history=None,
                user=user,
                force_compact=False,
            )

        self.assertIsNone(evt)
        self.assertEqual(summary, "早期摘要内容")
        self.assertEqual(len(recent), 4)
        self.assertEqual(stats["compacted_turns"], 10)
        llm_mock.assert_not_awaited()

    async def test_in_loop_micro_compaction_shrinks_older_tool_outputs_preserving_recent_rounds(self) -> None:
        big_payload = json.dumps({"status": "succeeded", "device_name": "Mac mini", "stdout": "line\n" * 1500}, ensure_ascii=False)
        convo = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "帮我全面检查"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "function": {"name": "run_on_device", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": big_payload},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "c2", "function": {"name": "search_memory", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c2", "content": big_payload},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "c3", "function": {"name": "memory_open", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c3", "content": json.dumps({"content": "最新一轮完整结果"}, ensure_ascii=False)},
        ]
        compacted, evt = await orchestrator_context.compact_loop_messages(
            convo,
            budget_tokens=1500,
            trigger_ratio=0.5,
        )
        self.assertIsNotNone(evt)
        self.assertEqual(evt.scope, "in_loop")
        self.assertLess(evt.after_tokens, evt.before_tokens)
        # Newest round (c3) must stay completely intact
        self.assertIn("最新一轮完整结果", compacted[-1]["content"])
        # Oldest round (c1) was compacted
        self.assertLess(len(compacted[3]["content"]), len(big_payload))

    async def test_run_agent_loop_recovers_from_context_overflow_and_blocks_device_tools_in_ask_only(self) -> None:
        user = User(id=uuid.uuid4(), email="u@test.local")
        db = AsyncMock()

        # 1) Ask-only mode blocks run_on_device even if LLM tries to call it
        call_responses = [
            (
                {
                    "choices": [{
                        "message": {
                            "content": "",
                            "tool_calls": [{
                                "id": "call_bad",
                                "function": {"name": "run_on_device", "arguments": '{"device_id":"mac","action":"shell","command":"ls"}'},
                            }],
                        }
                    }]
                },
                MagicMock(),
            ),
            (
                {"choices": [{"message": {"content": "当前为仅记忆问答模式，已基于记忆作答。", "tool_calls": []}}]},
                MagicMock(),
            ),
        ]

        with patch.object(orchestrator, "call_chat_completion", AsyncMock(side_effect=call_responses)):
            events = [
                evt
                async for evt in orchestrator.run_agent_loop(
                    db,
                    user,
                    [{"role": "system", "content": "sys"}, {"role": "user", "content": "看看设备"}],
                    tools=orchestrator.ASK_ONLY_TOOLS,
                )
            ]

        tool_results = [e for e in events if e.get("type") == "tool_result"]
        self.assertEqual(len(tool_results), 1)
        self.assertIn("仅记忆问答模式", tool_results[0]["result"]["error"])
        deltas = [e["text"] for e in events if e.get("type") == "delta"]
        self.assertTrue(any("基于记忆作答" in d for d in deltas))

    async def test_manual_compact_ai_conversation_updates_db_config(self) -> None:
        user = User(id=uuid.uuid4(), email="u@test.local")
        conv_id = uuid.uuid4()
        conv = AskConversation(
            id=conv_id,
            user_id=user.id,
            title="长对话",
            turns=_make_turns(5, body_repeat=2),
            config={"execution_mode": "ai"},
        )
        db = AsyncMock()
        res_mock = MagicMock()
        res_mock.scalars.return_value.first.return_value = conv
        db.execute.return_value = res_mock

        with patch.object(orchestrator_context, "get_ai_providers", return_value=[]):
            out = await orchestrator_context.compact_ai_conversation(db, user, conv_id, keep_recent=4)

        self.assertTrue(out["ok"])
        self.assertTrue(out["compacted"])
        self.assertEqual(out["compacted_turns"], 6)
        self.assertEqual(out["kept_turns"], 4)
        self.assertIn(orchestrator_context.CHECKPOINT_CONFIG_KEY, conv.config)
        db.commit.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
