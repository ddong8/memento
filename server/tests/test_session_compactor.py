import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from server.services.session_compactor import (
    DIGEST_DETAIL_CHARS,
    DIGEST_OUTLINE_CHARS,
    build_compacted_continuation,
    build_digest,
    estimate_tokens,
    format_injected_context,
    generate_checkpoint_summary,
    is_dialogue,
    prune_message_payloads,
    split_at_latest_summary,
    split_sliding_window,
)


class SessionCompactorTests(unittest.IsolatedAsyncioTestCase):
    def test_estimate_tokens(self):
        en_text = "Hello world this is a test of token estimation."
        zh_text = "你好世界，这是一个关于会话记忆压缩的测试。"
        self.assertGreater(estimate_tokens(en_text), 0)
        self.assertGreater(estimate_tokens(zh_text), 0)
        self.assertGreaterEqual(estimate_tokens(zh_text), len(zh_text))

    def test_prune_message_payloads_base64_and_long_tool(self):
        dummy_base64 = "data:image/png;base64," + "A" * 300
        messages = [
            {"role": "user", "content": f"Please look at this screenshot: {dummy_base64}"},
            {"role": "tool", "raw_type": "tool_output", "content": "Line of output\n" * 200},
            {"role": "assistant", "content": "I see the file.", "thinking": "T" * 2000},
        ]

        pruned = prune_message_payloads(messages, max_tool_output_chars=200)

        self.assertNotIn("data:image/png;base64", pruned[0]["content"])
        self.assertIn("[图片附件", pruned[0]["content"])

        self.assertLess(len(pruned[1]["content"]), 400)
        self.assertIn("长输出截断", pruned[1]["content"])

        self.assertLessEqual(len(pruned[2]["thinking"]), 1100)
        self.assertIn("思考链已精简", pruned[2]["thinking"])

    def test_split_sliding_window(self):
        messages = [
            {"role": "user" if i % 2 == 0 else "assistant", "content": f"msg {i}"}
            for i in range(20)
        ]
        older, recent = split_sliding_window(messages, recent_turns=4)

        # 4 turns = 8 messages
        self.assertEqual(len(recent), 8)
        self.assertEqual(len(older), 12)
        self.assertEqual(recent[-1]["content"], "msg 19")
        self.assertEqual(older[0]["content"], "msg 0")

    @patch("server.services.session_compactor.get_ai_providers", return_value=[])
    async def test_generate_checkpoint_summary_heuristic(self, _mock_providers):
        # No LLM configured: exercise the heuristic path instead of calling a real provider.
        older = [
            {"role": "user", "content": "请帮我修改 server/server/api/ask.py 和 web/src/app/ask/page.tsx 中的会话接续逻辑"},
            {"role": "assistant", "content": "好的，我已经定位到相关代码并完成了初始调研。"},
            {"role": "user", "content": "继续，我们需要加上智能记忆压缩功能。"},
        ]

        summary = await generate_checkpoint_summary(older, session_title="会话压缩研发", tool_id="claude_code")
        self.assertIn("核心记忆快照", summary)
        self.assertIn("任务核心目标", summary)
        self.assertIn("文件", summary)
        self.assertTrue("ask.py" in summary or "page.tsx" in summary)

    def test_format_injected_context(self):
        summary = "### 核心记忆快照\n- 任务核心目标：修复报错\n- 涉及核心文件：main.py"
        recent = [
            {"role": "user", "content": "现在状态如何？"},
            {"role": "assistant", "content": "当前正在执行测试。"},
        ]
        injected = format_injected_context(summary, recent, original_session_id="01a07ef6-1234")
        self.assertIn("前序会话核心记忆快照", injected)
        self.assertIn("01a07ef6", injected)
        self.assertIn("用户: 现在状态如何？", injected)
        self.assertIn("执行规则", injected)


def _long_session(n_turns: int) -> list[dict]:
    messages = []
    for t in range(n_turns):
        ts = f"2026-10-{1 + t * 22 // n_turns:02d}T08:00:00+00:00"
        messages.append({"role": "user", "content": f"USER-{t} " + "需求说明" * 60, "timestamp": ts})
        messages.append({"role": "assistant", "content": f"PROGRESS-{t} " + "进度" * 100, "timestamp": ts})
        messages.append({"role": "assistant", "content": f"REPLY-{t} " + "结论" * 300, "timestamp": ts})
    return messages


_CC_SUMMARY = (
    "<artifact-content-authored-by-others/>\nThe summarized conversation included Artifact content.\n"
    "This session is being continued from a previous conversation that ran out of context. "
    "The summary below covers the earlier portion of the conversation.\n\nSummary:\n"
    "1. Primary Request and Intent:\n   - {body}\n\n"
    "If you need specific details from before compaction, read the full transcript at: /x.jsonl\n"
    "Continue the conversation from where it left off without asking the user any further questions."
)


class CompactionCoverageTests(unittest.IsolatedAsyncioTestCase):
    def test_digest_of_a_long_session_reaches_the_newest_message(self):
        messages = _long_session(1000)
        digest = build_digest(messages)

        self.assertIn("REPLY-999", digest)
        self.assertIn("USER-999", digest)
        # Earlier turns keep only the user's instructions; the oldest are dropped and counted
        self.assertIn("只保留用户指令", digest)
        self.assertNotIn("PROGRESS-500", digest)
        self.assertIn("已省略", digest)
        self.assertNotIn("USER-0 ", digest)
        self.assertLess(len(digest), DIGEST_DETAIL_CHARS + DIGEST_OUTLINE_CHARS + 200)

    def test_final_replies_keep_more_than_progress_notes(self):
        digest = build_digest(_long_session(3))
        lines = {line.split(": ", 1)[1].split(" ", 1)[0]: line for line in digest.splitlines() if ": " in line}
        self.assertGreater(len(lines["REPLY-2"]), len(lines["PROGRESS-2"]))

    def test_latest_claude_code_summary_is_the_base(self):
        messages = [
            {"role": "user", "content": "old ask"},
            {"role": "user", "content": _CC_SUMMARY.format(body="FIRST-SUMMARY")},
            {"role": "assistant", "content": "middle"},
            {"role": "user", "content": _CC_SUMMARY.format(body="LATEST-SUMMARY"), "timestamp": "2026-10-23T07:12:07+00:00"},
            {"role": "user", "content": "new ask"},
            {"role": "assistant", "content": "new reply"},
        ]
        earlier, until, after = split_at_latest_summary(messages)

        self.assertIn("LATEST-SUMMARY", earlier)
        self.assertTrue(earlier.startswith("1. Primary Request"))
        self.assertNotIn("If you need specific details", earlier)
        self.assertEqual(until, "10-23 15:12")
        self.assertEqual([m["content"] for m in after], ["new ask", "new reply"])

    def test_a_continued_session_carries_the_previous_context_forward(self):
        injected = format_injected_context(
            "### 核心记忆快照\n- CARRIED-CHECKPOINT",
            [{"role": "user", "content": "继续"}, {"role": "assistant", "content": "CARRIED-REPLY"}],
            original_session_id="aa549791-3f81",
        )
        messages = [
            {"role": "user", "content": f"{injected}\n\n当前用户指令：\n部署完了吗", "timestamp": "2026-10-24T01:10:00+00:00"},
            {"role": "assistant", "content": "部署完了"},
        ]
        earlier, until, after = split_at_latest_summary(messages)

        self.assertIn("CARRIED-CHECKPOINT", earlier)
        self.assertIn("CARRIED-REPLY", earlier)
        self.assertNotIn("前序会话核心记忆快照", earlier)
        self.assertNotIn("执行规则", earlier)
        self.assertEqual(until, "10-24 09:10")
        self.assertEqual([m["content"] for m in after], ["部署完了吗", "部署完了"])

    def test_a_later_claude_code_summary_wins_over_the_carried_context(self):
        messages = [
            {"role": "user", "content": "【前序会话核心记忆快照】\n- old\n\n【执行规则】\nx\n\n当前用户指令：\nfirst"},
            {"role": "user", "content": _CC_SUMMARY.format(body="CC-SUMMARY")},
            {"role": "user", "content": "next"},
        ]
        earlier, _, after = split_at_latest_summary(messages)
        self.assertIn("CC-SUMMARY", earlier)
        self.assertEqual([m["content"] for m in after], ["next"])

    def test_without_a_claude_code_summary_everything_is_digested(self):
        messages = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
        self.assertEqual(split_at_latest_summary(messages), ("", "", messages))

    @patch("server.services.session_compactor.call_plain_chat", new_callable=AsyncMock, return_value="### 核心记忆快照\n- ok")
    @patch("server.services.session_compactor.get_ai_providers", return_value=[object()])
    async def test_checkpoint_prompt_has_the_earlier_summary_and_the_newest_turn(self, _providers, chat):
        summary = await generate_checkpoint_summary(
            _long_session(400), session_title="t", tool_id="claude_code",
            earlier_summary="EARLIER-SUMMARY", earlier_until="10-23 15:12",
        )

        self.assertEqual(summary, "### 核心记忆快照\n- ok")
        prompt = chat.await_args.args[0][1]["content"]
        self.assertIn("EARLIER-SUMMARY", prompt)
        self.assertIn("截至 10-23 15:12", prompt)
        self.assertIn("REPLY-399", prompt)
        self.assertIn("以最新进展为准", prompt)

    @patch("server.services.session_compactor.get_ai_providers", return_value=[])
    async def test_heuristic_lists_the_latest_instructions(self, _providers):
        summary = await generate_checkpoint_summary(_long_session(5))
        self.assertIn("USER-4", summary)
        self.assertIn("最近的用户指令", summary)

    def test_recent_context_keeps_prompts_and_final_replies_only(self):
        recent = [
            {"role": "user", "content": "完成了吗"},
            {"role": "assistant", "content": "Next, check the state."},
            {"role": "tool", "raw_type": "tool_output", "content": "2d49f13 ci(deploy) TOOL-OUTPUT"},
            {"role": "assistant", "content": "全部完成。" + "细节" * 1000 + "FINAL-END"},
            {"role": "user", "content": "【前序会话核心记忆快照（原会话 ID: aa549791...）】\n### 核心记忆快照\n- 旧\n\n当前用户指令：\n中文回复啊"},
            {"role": "assistant", "content": "好的。", "raw_type": "assistant", "timestamp": "2026-10-23T19:45:06+00:00"},
        ]
        injected = format_injected_context("### 核心记忆快照\n- x", recent)

        self.assertIn("用户: 完成了吗", injected)
        self.assertNotIn("Next, check", injected)
        self.assertNotIn("TOOL-OUTPUT", injected)
        self.assertIn("全部完成。", injected)
        # A long reply keeps its start and its conclusion
        self.assertIn("…[省略", injected)
        self.assertIn("FINAL-END", injected)
        self.assertIn("用户: 中文回复啊", injected)
        self.assertNotIn("- 旧", injected)
        self.assertIn("[10-24 03:45] 助手: 好的。", injected)

    def test_reasoning_rows_are_not_dialogue(self):
        self.assertFalse(is_dialogue({"role": "assistant", "raw_type": "reasoning", "content": "thinking"}))
        self.assertFalse(is_dialogue({"role": "tool", "content": "out"}))
        self.assertTrue(is_dialogue({"role": "assistant", "raw_type": "message", "content": "reply"}))


class _Result:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value

    def all(self):
        return self.value


class _FakeDB:
    def __init__(self, *results):
        self.results = list(results)
        self.statements = []

    async def execute(self, stmt):
        self.statements.append(str(stmt.compile(compile_kwargs={"literal_binds": False})))
        return _Result(self.results.pop(0))


def _row(role, content, message_type=None):
    return SimpleNamespace(role=role, content=content, timestamp=None, message_type=message_type or role)


class BuildContinuationTests(unittest.IsolatedAsyncioTestCase):
    @patch("server.services.session_compactor.get_ai_providers", return_value=[])
    async def test_scoped_to_the_users_devices_and_reads_only_dialogue(self, _providers):
        doc = SimpleNamespace(id=uuid.uuid4(), title="memento", tool_id="claude_code", content="", file_size_bytes=0)
        rows = []
        for t in range(10):
            rows += [_row("user", f"ask {t}"), _row("assistant", f"reply {t}")]
        db = _FakeDB(doc, rows)

        res = await build_compacted_continuation(db, "aa549791-3f81-4e86-bbee-e892b7131a4f", "继续", machine_ids=[uuid.uuid4()])

        self.assertIn("documents.machine_id IN", db.statements[0])
        self.assertIn("conversation_messages.role IN", db.statements[1])
        self.assertIn("核心记忆快照", res["checkpoint"])
        self.assertIn("reply 9", res["injected_context"])
        self.assertTrue(res["new_prompt_with_context"].endswith("当前用户指令：\n继续"))

    async def test_a_session_not_found_gives_no_context(self):
        db = _FakeDB(None, None)
        res = await build_compacted_continuation(db, "aa549791-3f81-4e86-bbee-e892b7131a4f", "继续", machine_ids=[])

        self.assertEqual(res["injected_context"], "")
        self.assertEqual(res["new_prompt_with_context"], "继续")
