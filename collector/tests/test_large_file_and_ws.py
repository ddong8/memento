import json
import tempfile
import unittest
from pathlib import Path

from collector.parsers.jsonl import JsonlParser, MAX_BATCH_SIZE, MAX_LINE_SIZE
from collector.queue import SyncQueue, MAX_QUEUE_CONTENT_SIZE
from collector.ws_client import _patch_websockets_connection_lost


class LargeFileAndWSTests(unittest.TestCase):
    def test_jsonl_parser_chunks_large_file(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w+", delete=False, encoding="utf-8") as f:
            line = json.dumps({"type": "message", "content": "x" * 10000}) + "\n"
            target_size = MAX_BATCH_SIZE + 50000
            written = 0
            while written < target_size:
                f.write(line)
                written += len(line.encode("utf-8"))
            file_path = Path(f.name)

        try:
            parser = JsonlParser()
            res1 = parser.parse(file_path, offset=0)
            self.assertTrue(res1.is_partial)
            self.assertTrue(res1.metadata.get("has_more"))
            self.assertGreater(res1.offset, 0)
            self.assertLess(res1.offset, file_path.stat().st_size)
            self.assertLessEqual(len(res1.content.encode("utf-8")), MAX_BATCH_SIZE + 20000)

            res2 = parser.parse(file_path, offset=res1.offset)
            self.assertEqual(res2.offset, file_path.stat().st_size)
        finally:
            file_path.unlink(missing_ok=True)

    def test_jsonl_parser_truncates_giant_line(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w+", delete=False, encoding="utf-8") as f:
            giant_line = json.dumps({"type": "tool_result", "data": "A" * (MAX_LINE_SIZE + 5000)}) + "\n"
            f.write(giant_line)
            file_path = Path(f.name)

        try:
            parser = JsonlParser()
            res = parser.parse(file_path, offset=0)
            self.assertIn("TRUNCATED", res.content)
            self.assertLess(len(res.content), MAX_LINE_SIZE + 10000)
        finally:
            file_path.unlink(missing_ok=True)

    def test_queue_truncates_exceeding_content(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = Path(td) / "queue.db"
            queue = SyncQueue(db_path)

            oversized_content = "Z" * (MAX_QUEUE_CONTENT_SIZE + 1000)
            item_id = queue.enqueue(
                tool_name="test_tool",
                category="conversation",
                content_type="jsonl",
                relative_path="test.jsonl",
                content=oversized_content,
                content_hash="dummy_hash",
                file_size=len(oversized_content),
                sync_strategy="delta",
            )
            self.assertIsInstance(item_id, int)
            batch = queue.peek_batch(1)
            self.assertEqual(len(batch), 1)
            self.assertIn("CONTENT TRUNCATED", batch[0].content)

    def test_patch_websockets_connection_lost(self):
        try:
            from websockets.asyncio.connection import Connection
        except ImportError:
            return

        _patch_websockets_connection_lost()

        class DummyConnection(Connection):
            def __init__(self):
                pass

        conn = DummyConnection()
        try:
            conn.connection_lost(None)
        except AttributeError:
            self.fail("Connection.connection_lost raised AttributeError when recv_messages is missing")

    def test_jsonl_parser_extracts_claude_ai_title(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w+", delete=False, encoding="utf-8") as f:
            f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "hello"}}) + "\n")
            f.write(json.dumps({"type": "ai-title", "aiTitle": "项目时间线记录功能", "sessionId": "aa549791-3f81-4e86-bbee-e892b7131a4f"}) + "\n")
            file_path = Path(f.name)

        try:
            parser = JsonlParser()
            res = parser.parse(file_path, offset=0)
            self.assertEqual(res.title, "项目时间线记录功能")

            # Also check when parsing with offset after ai-title
            res_delta = parser.parse(file_path, offset=file_path.stat().st_size)
            self.assertEqual(res_delta.title, "项目时间线记录功能")
        finally:
            file_path.unlink(missing_ok=True)

    def test_build_agent_command_codex_resume(self):
        from collector.executor import build_agent_command

        cmd = build_agent_command(
            binary="codex",
            resolved="/usr/local/bin/codex",
            prompt="怎么还在执行任务啊",
            session_id="01a07ef6-f778-7b01-87c2-84b8617b1dc4",
            model="o3",
            effort="high",
        )
        self.assertEqual(cmd[0], "/usr/local/bin/codex")
        self.assertEqual(cmd[1], "exec")
        self.assertEqual(cmd[2], "resume")
        self.assertNotIn("--color", cmd)
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", cmd)
        self.assertIn("--skip-git-repo-check", cmd)
        self.assertIn("-c", cmd)
        self.assertIn('model_reasoning_effort="high"', cmd)
        self.assertIn("-m", cmd)
        self.assertIn("o3", cmd)
        self.assertEqual(cmd[-2], "01a07ef6-f778-7b01-87c2-84b8617b1dc4")
        self.assertEqual(cmd[-1], "怎么还在执行任务啊")

    def test_build_agent_command_codex_fork(self):
        from collector.executor import build_agent_command

        cmd = build_agent_command(
            binary="codex",
            resolved="/usr/local/bin/codex",
            prompt="fork and continue",
            session_id="01a07ef6-f778-7b01-87c2-84b8617b1dc4",
            fork=True,
        )
        self.assertEqual(cmd[0], "/usr/local/bin/codex")
        self.assertEqual(cmd[1], "exec")
        self.assertEqual(cmd[2], "fork")
        self.assertNotIn("resume", cmd)
        self.assertNotIn("--color", cmd)
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", cmd)
        self.assertIn("--skip-git-repo-check", cmd)
        self.assertEqual(cmd[-2], "01a07ef6-f778-7b01-87c2-84b8617b1dc4")
        self.assertEqual(cmd[-1], "fork and continue")

    def test_build_agent_command_codex_new(self):
        from collector.executor import build_agent_command

        cmd = build_agent_command(
            binary="codex",
            resolved="/usr/local/bin/codex",
            prompt="hello new session",
        )
        self.assertEqual(cmd[0], "/usr/local/bin/codex")
        self.assertEqual(cmd[1], "exec")
        self.assertNotIn("resume", cmd)
        self.assertNotIn("--color", cmd)
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", cmd)
        self.assertEqual(cmd[-1], "hello new session")

    def test_build_agent_command_claude(self):
        from collector.executor import build_agent_command

        cmd = build_agent_command(
            binary="claude",
            resolved="/usr/local/bin/claude",
            prompt="write code",
            session_id="session-123",
            max_budget_usd=5.0,
        )
        self.assertEqual(cmd[0], "/usr/local/bin/claude")
        self.assertIn("-p", cmd)
        self.assertIn("-r", cmd)
        self.assertIn("session-123", cmd)
        self.assertIn("--max-budget-usd", cmd)
        self.assertIn("5.0", cmd)
        self.assertEqual(cmd[-1], "write code")

    def test_build_agent_command_agy(self):
        from collector.executor import build_agent_command

        cmd = build_agent_command(
            binary="agy",
            resolved="/usr/local/bin/agy",
            prompt="refactor this",
            session_id="conv-456",
            model="pro",
        )
        self.assertEqual(cmd[0], "/usr/local/bin/agy")
        self.assertIn("--resume", cmd)
        self.assertIn("conv-456", cmd)
        self.assertIn("--model", cmd)
        self.assertIn("pro", cmd)
        self.assertIn("-p", cmd)
        self.assertEqual(cmd[-1], "refactor this")


if __name__ == "__main__":
    unittest.main()
