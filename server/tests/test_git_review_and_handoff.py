"""Tests for /api/git/* (diff review, checkpoint restore, commit/push/PR) and
POST /api/ask/conversations/{id}/handoff (explicit cross-agent handoff)."""

from __future__ import annotations

import asyncio
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from server.api import ask_conversations, git_review
from server.db.models import AskConversation, Machine, User


def _user(uid: uuid.UUID | None = None) -> User:
    u = MagicMock(spec=User)
    u.id = uid or uuid.uuid4()
    u.role = "member"
    u.email = "dev@memento.local"
    return u


def _machine(owner_id: uuid.UUID, token_hash: str = "dev-tok-1", name: str = "MacBook") -> Machine:
    m = MagicMock(spec=Machine)
    m.id = uuid.uuid4()
    m.user_id = owner_id
    m.collector_token_hash = token_hash
    m.name = name
    return m


class TestGitReviewApi(unittest.TestCase):
    def test_git_diff_forwards_to_owned_device(self):
        user = _user()
        machine = _machine(user.id)
        db = AsyncMock()
        mock_resp = {
            "ok": True,
            "branch": "main",
            "repo_root": "/repo",
            "total_files": 1,
            "total_additions": 4,
            "total_deletions": 1,
            "files": [{"path": "a.py", "status": "M", "additions": 4, "deletions": 1, "binary": False, "hunks": []}],
            "checkpoints": [],
        }

        async def _run():
            with patch.object(git_review, "find_machine_by_id_or_hash", AsyncMock(return_value=machine)), \
                 patch.object(git_review, "user_machine_ids", AsyncMock(return_value={machine.id})), \
                 patch.object(git_review, "sees_all", return_value=False), \
                 patch.object(git_review.ws_manager, "request_device", AsyncMock(return_value=mock_resp)) as req:
                out = await git_review.git_diff(
                    git_review.GitDiffRequest(device_id=machine.collector_token_hash, cwd="/repo"),
                    db=db,
                    _user=user,
                )
                req.assert_awaited_once()
                sent_dev, sent_payload = req.call_args.args[:2]
                self.assertEqual(sent_dev, "dev-tok-1")
                self.assertEqual(sent_payload["type"], "git_diff_req")
                self.assertEqual(sent_payload["cwd"], "/repo")
                self.assertTrue(out["ok"])
                self.assertEqual(out["total_files"], 1)

        asyncio.run(_run())

    def test_git_diff_rejects_unowned_device(self):
        user = _user()
        other_machine = _machine(uuid.uuid4())
        db = AsyncMock()

        async def _run():
            with patch.object(git_review, "find_machine_by_id_or_hash", AsyncMock(return_value=other_machine)), \
                 patch.object(git_review, "user_machine_ids", AsyncMock(return_value=set())), \
                 patch.object(git_review, "sees_all", return_value=False):
                with self.assertRaises(HTTPException) as ctx:
                    await git_review.git_diff(
                        git_review.GitDiffRequest(device_id=other_machine.collector_token_hash, cwd="/repo"),
                        db=db,
                        _user=user,
                    )
                self.assertEqual(ctx.exception.status_code, 403)

        asyncio.run(_run())

    def test_checkpoint_restore_rejects_non_checkpoint_ref(self):
        user = _user()
        db = AsyncMock()

        async def _run():
            with self.assertRaises(HTTPException) as ctx:
                await git_review.git_checkpoint_restore(
                    git_review.GitRestoreRequest(device_id="dev-tok-1", cwd="/repo", target_ref="HEAD~1"),
                    db=db,
                    _user=user,
                )
            self.assertEqual(ctx.exception.status_code, 400)

        asyncio.run(_run())

    def test_git_deliver_forwards_commit_push_pr(self):
        user = _user()
        machine = _machine(user.id)
        db = AsyncMock()
        mock_resp = {
            "ok": True,
            "commit_sha": "abcdef123456",
            "pushed": True,
            "pr_url": "https://github.com/org/repo/pull/42",
            "summary": "已提交 abcdef12 · 已推送到 origin/main · 已创建 PR",
        }

        async def _run():
            with patch.object(git_review, "find_machine_by_id_or_hash", AsyncMock(return_value=machine)), \
                 patch.object(git_review, "user_machine_ids", AsyncMock(return_value={machine.id})), \
                 patch.object(git_review, "sees_all", return_value=False), \
                 patch.object(git_review.ws_manager, "request_device", AsyncMock(return_value=mock_resp)) as req:
                out = await git_review.git_deliver(
                    git_review.GitDeliverRequest(
                        device_id=machine.collector_token_hash,
                        cwd="/repo",
                        message="feat: add review drawer",
                        files=["a.py"],
                        push=True,
                        create_pr=True,
                    ),
                    db=db,
                    _user=user,
                )
                self.assertEqual(out["pr_url"], "https://github.com/org/repo/pull/42")
                sent_payload = req.call_args.args[1]
                self.assertEqual(sent_payload["type"], "git_commit_push_pr_req")
                self.assertTrue(sent_payload["push"])
                self.assertTrue(sent_payload["create_pr"])
                self.assertEqual(sent_payload["files"], ["a.py"])

        asyncio.run(_run())


class TestCrossAgentHandoffApi(unittest.TestCase):
    def test_handoff_creates_linked_conversation_and_preserves_source(self):
        user = _user()
        src = MagicMock(spec=AskConversation)
        src.id = uuid.uuid4()
        src.user_id = user.id
        src.title = "优化认证中间件"
        src.device_id = "dev-mac-1"
        src.cwd = "/Users/dev/project"
        src.config = {
            "execution_mode": "claude",
            "model": "claude-opus-4-6",
            "project_id": "proj-1",
            "session_id": "sess-orig-123",
            "device_id": "dev-mac-1",
            "cwd": "/Users/dev/project",
        }
        src.turns = [
            {
                "role": "user",
                "content": "帮我重构 JWT 校验逻辑",
            },
            {
                "role": "assistant",
                "content": "已完成中间件拆分并更新了 auth.py。",
                "tool_calls": [
                    {
                        "name": "run_on_device",
                        "result": {
                            "events": [
                                {
                                    "kind": "checkpoint",
                                    "id": "cp-turn-9",
                                    "status": "created",
                                    "repo_root": "/Users/dev/project",
                                    "branch": "feat/auth",
                                    "before_ref": "refs/memento/checkpoints/cp-turn-9/before",
                                    "after_ref": "refs/memento/checkpoints/cp-turn-9/after",
                                    "files_changed": 2,
                                    "insertions": 45,
                                    "deletions": 12,
                                    "files": [
                                        {"path": "server/auth.py", "status": "M", "additions": 40, "deletions": 12},
                                        {"path": "server/tests/test_auth.py", "status": "A", "additions": 5, "deletions": 0},
                                    ],
                                }
                            ]
                        },
                    }
                ],
            },
        ]

        added_rows: list[AskConversation] = []
        db = AsyncMock()
        res = MagicMock()
        res.scalars.return_value.first.return_value = src
        db.execute.return_value = res
        db.add = MagicMock(side_effect=lambda obj: added_rows.append(obj))

        async def _fake_refresh(obj):
            if getattr(obj, "id", None) is None:
                obj.id = uuid.uuid4()
            if getattr(obj, "created_at", None) is None:
                obj.created_at = datetime.now(timezone.utc)
            if getattr(obj, "updated_at", None) is None:
                obj.updated_at = datetime.now(timezone.utc)

        db.refresh = AsyncMock(side_effect=_fake_refresh)

        async def _run():
            with patch.object(ask_conversations, "infer_conversation_config", return_value=(dict(src.config), {})), \
                 patch.object(ask_conversations, "resolve_concrete_device_for_conv", AsyncMock(return_value="dev-mac-1")), \
                 patch.object(ask_conversations, "lookup_project_title", AsyncMock(return_value="Auth Project")), \
                 patch.object(ask_conversations, "bust_conv_list", AsyncMock()) as bust:
                out = await ask_conversations.handoff_conversation(
                    conv_id=str(src.id),
                    body=ask_conversations.HandoffConversationRequest(
                        target_execution_mode="codex",
                        instruction="请严格 review auth.py 并补齐边界测试",
                    ),
                    db=db,
                    _user=user,
                )
                bust.assert_awaited_once_with(user.id)
                self.assertEqual(len(added_rows), 1)
                created = added_rows[0]
                # Source conversation config & session_id remain untouched (R-CONFIG-LOCK)
                self.assertEqual(src.config["execution_mode"], "claude")
                self.assertEqual(src.config["session_id"], "sess-orig-123")

                # New linked conversation targets Codex with fresh session_id & handoff_from metadata
                conv_out = out["conversation"]
                self.assertEqual(conv_out["execution_mode"], "codex")
                self.assertEqual(conv_out["session_id"], "")
                self.assertEqual(conv_out["cwd"], "/Users/dev/project")
                self.assertEqual(conv_out["config"]["handoff_from"]["conversation_id"], str(src.id))
                self.assertEqual(conv_out["config"]["handoff_from"]["execution_mode"], "claude")
                self.assertEqual(conv_out["config"]["handoff_from"]["checkpoint"]["id"], "cp-turn-9")
                self.assertEqual(created.turns, [])

                # Handoff prompt carries context, checkpoint details, and custom instruction
                prompt = out["handoff_prompt"]
                self.assertIn("优化认证中间件", prompt)
                self.assertIn("feat/auth", prompt)
                self.assertIn("server/auth.py", prompt)
                self.assertIn("请严格 review auth.py 并补齐边界测试", prompt)

        asyncio.run(_run())

    def test_handoff_rejects_invalid_target_mode(self):
        user = _user()
        db = AsyncMock()

        async def _run():
            with self.assertRaises(HTTPException) as ctx:
                await ask_conversations.handoff_conversation(
                    conv_id=str(uuid.uuid4()),
                    body=ask_conversations.HandoffConversationRequest(target_execution_mode="unknown_tool"),
                    db=db,
                    _user=user,
                )
            self.assertEqual(ctx.exception.status_code, 400)

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
