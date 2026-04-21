from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "collector"))

from collector.codex_export import (  # noqa: E402
    discover_threads,
    export_codex_home,
    parse_session_file,
    render_thread_markdown,
)


def _write_session(path: Path) -> None:
    session_lines = [
        {
            "timestamp": "2026-04-10T17:58:27.428Z",
            "type": "session_meta",
            "payload": {
                "id": "019d788a-ffcf-7d90-b60b-73f8ef229a0f",
                "timestamp": "2026-04-10T17:57:48.631Z",
                "cwd": "/Users/test/project",
                "originator": "Codex Desktop",
                "cli_version": "0.119.0-alpha.11",
                "source": "vscode",
                "model_provider": "openai",
            },
        },
        {
            "timestamp": "2026-04-10T17:58:27.431Z",
            "type": "turn_context",
            "payload": {
                "turn_id": "turn-1",
                "cwd": "/Users/test/project",
                "timezone": "Asia/Shanghai",
                "model": "gpt-5.4",
            },
        },
        {
            "timestamp": "2026-04-10T17:58:27.432Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "怎么采集 codex 本机对话？"},
                ],
            },
        },
        {
            "timestamp": "2026-04-10T17:58:27.433Z",
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "message": "怎么采集 codex 本机对话？",
                "images": [],
                "local_images": [],
                "text_elements": [],
            },
        },
        {
            "timestamp": "2026-04-10T17:58:28.000Z",
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"pwd\"}",
                "call_id": "call-1",
            },
        },
        {
            "timestamp": "2026-04-10T17:58:28.100Z",
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "Command: pwd\nOutput:\n/Users/test/project\n",
            },
        },
        {
            "timestamp": "2026-04-10T17:58:28.200Z",
            "type": "event_msg",
            "payload": {
                "type": "agent_message",
                "message": "我先检查本机存储位置。",
                "phase": "commentary",
            },
        },
        {
            "timestamp": "2026-04-10T17:58:29.000Z",
            "type": "response_item",
            "payload": {
                "type": "reasoning",
                "summary": [],
                "encrypted_content": "ciphertext",
            },
        },
        {
            "timestamp": "2026-04-10T17:58:30.000Z",
            "type": "event_msg",
            "payload": {
                "type": "task_complete",
                "turn_id": "turn-1",
                "last_agent_message": "完整记录在 ~/.codex/sessions 和 state_5.sqlite。",
            },
        },
        {
            "timestamp": "2026-04-10T17:58:31.000Z",
            "type": "compacted",
            "payload": {
                "message": "",
                "replacement_history": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": "更早的用户消息"},
                        ],
                    },
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {"type": "output_text", "text": "更早的助手回复"},
                        ],
                    },
                ],
            },
        },
    ]
    payload = "\n".join(json.dumps(line, ensure_ascii=False) for line in session_lines) + "\n"
    path.write_text(payload, encoding="utf-8")


def _create_state_db(path: Path, rollout_path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        create table threads (
            id text primary key,
            rollout_path text not null,
            created_at integer not null,
            updated_at integer not null,
            source text not null,
            model_provider text not null,
            cwd text not null,
            title text not null,
            sandbox_policy text not null,
            approval_mode text not null,
            tokens_used integer not null default 0,
            has_user_event integer not null default 0,
            archived integer not null default 0,
            archived_at integer,
            git_sha text,
            git_branch text,
            git_origin_url text,
            cli_version text not null default '',
            first_user_message text not null default '',
            agent_nickname text,
            agent_role text,
            memory_mode text not null default 'enabled',
            model text,
            reasoning_effort text,
            agent_path text
        );
        """
    )
    conn.execute(
        """
        insert into threads (
            id, rollout_path, created_at, updated_at, source, model_provider,
            cwd, title, sandbox_policy, approval_mode, archived, cli_version,
            first_user_message, model, reasoning_effort
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "019d788a-ffcf-7d90-b60b-73f8ef229a0f",
            str(rollout_path),
            1775843868,
            1775843987,
            "vscode",
            "openai",
            "/Users/test/project",
            "采集 Codex 本机对话记录",
            "workspace-write",
            "on-request",
            0,
            "0.119.0-alpha.11",
            "怎么采集 codex 本机对话？",
            "gpt-5.4",
            "xhigh",
        ),
    )
    conn.commit()
    conn.close()


class CodexExportTests(unittest.TestCase):
    def test_discover_threads_merges_state_and_session_meta(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            codex_home = Path(tmp) / ".codex"
            session_dir = codex_home / "sessions" / "2026" / "04" / "11"
            session_dir.mkdir(parents=True)
            session_path = session_dir / "rollout-2026-04-11T01-57-48-019d788a-ffcf-7d90-b60b-73f8ef229a0f.jsonl"
            _write_session(session_path)
            _create_state_db(codex_home / "state_5.sqlite", session_path)

            threads = discover_threads(codex_home)

        self.assertEqual(len(threads), 1)
        thread = threads[0]
        self.assertEqual(thread["thread_id"], "019d788a-ffcf-7d90-b60b-73f8ef229a0f")
        self.assertEqual(thread["title"], "采集 Codex 本机对话记录")
        self.assertEqual(thread["model"], "gpt-5.4")
        self.assertEqual(Path(thread["rollout_path"]).resolve(), session_path.resolve())

    def test_parse_session_file_recovers_key_event_types(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            codex_home = Path(tmp) / ".codex"
            session_dir = codex_home / "sessions" / "2026" / "04" / "11"
            session_dir.mkdir(parents=True)
            session_path = session_dir / "rollout-2026-04-11T01-57-48-019d788a-ffcf-7d90-b60b-73f8ef229a0f.jsonl"
            _write_session(session_path)

            events = parse_session_file({
                "thread_id": "019d788a-ffcf-7d90-b60b-73f8ef229a0f",
                "rollout_path": str(session_path),
            })

        self.assertEqual(events[2]["kind"], "message")
        self.assertEqual(events[3]["kind"], "user_message")
        self.assertEqual(events[4]["kind"], "tool_call")
        self.assertEqual(events[4]["tool_name"], "exec_command")
        self.assertEqual(events[5]["kind"], "tool_output")
        self.assertEqual(events[6]["kind"], "commentary")
        self.assertEqual(events[7]["kind"], "reasoning")
        self.assertEqual(events[7]["text"], "[encrypted reasoning omitted]")
        self.assertEqual(events[8]["kind"], "final_message")
        self.assertEqual(events[9]["kind"], "compacted")

    def test_render_thread_markdown_includes_tools_reasoning_and_compaction(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            codex_home = Path(tmp) / ".codex"
            session_dir = codex_home / "sessions" / "2026" / "04" / "11"
            session_dir.mkdir(parents=True)
            session_path = session_dir / "rollout-2026-04-11T01-57-48-019d788a-ffcf-7d90-b60b-73f8ef229a0f.jsonl"
            _write_session(session_path)
            thread = {
                "thread_id": "019d788a-ffcf-7d90-b60b-73f8ef229a0f",
                "title": "采集 Codex 本机对话记录",
                "created_at": "2026-04-10T17:57:48Z",
                "updated_at": "2026-04-10T17:58:30Z",
                "cwd": "/Users/test/project",
                "source": "vscode",
                "model": "gpt-5.4",
                "model_provider": "openai",
                "reasoning_effort": "xhigh",
                "rollout_path": str(session_path),
            }
            events = parse_session_file(thread)

            markdown = render_thread_markdown(thread, events)

        self.assertIn("Assistant Commentary", markdown)
        self.assertIn("Tool Call `exec_command`", markdown)
        self.assertIn("Tool Output `exec_command`", markdown)
        self.assertIn("[encrypted reasoning omitted]", markdown)
        self.assertIn("Context Compacted", markdown)
        self.assertIn("更早的助手回复", markdown)

    def test_export_codex_home_writes_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            codex_home = root / ".codex"
            session_dir = codex_home / "sessions" / "2026" / "04" / "11"
            session_dir.mkdir(parents=True)
            session_path = session_dir / "rollout-2026-04-11T01-57-48-019d788a-ffcf-7d90-b60b-73f8ef229a0f.jsonl"
            _write_session(session_path)
            _create_state_db(codex_home / "state_5.sqlite", session_path)
            (codex_home / "history.jsonl").write_text("", encoding="utf-8")
            output_dir = root / "export"

            manifest = export_codex_home(codex_home, output_dir)
            self.assertEqual(manifest["thread_count"], 1)
            self.assertTrue((output_dir / "manifest.json").exists())
            self.assertTrue((output_dir / "normalized" / "threads.jsonl").exists())
            self.assertTrue((output_dir / "normalized" / "events.jsonl").exists())
            self.assertTrue((output_dir / "normalized" / "index.sqlite").exists())
            markdown_files = list((output_dir / "markdown").glob("*.md"))
            self.assertEqual(len(markdown_files), 1)
            self.assertTrue((output_dir / "raw" / ".codex" / "sessions").exists())


if __name__ == "__main__":
    unittest.main()
