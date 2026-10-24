"""The device / project / session a run uses belong together, and a cleared choice stays cleared."""

from __future__ import annotations

import asyncio
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from fastapi.testclient import TestClient  # noqa: E402

from server.api import ask  # noqa: E402
from server.db.models import AskConversation, Machine, User  # noqa: E402
from server.db.session import get_db  # noqa: E402
from server.main import app  # noqa: E402
from server.middleware.auth import get_current_user  # noqa: E402
from server.services import ask_store, user_filter  # noqa: E402
from server.services.ask_store import (  # noqa: E402
    _RUN_EMPTY_IS_A_CHOICE,
    _skip_config_value,
    infer_conversation_config,
    reconcile_session,
)

MINI = Machine(id=uuid.uuid4(), name="haixingdeMac-mini.local (Darwin)", collector_token_hash="tok-mini")
BOOK = Machine(id=uuid.uuid4(), name="donghaixingdeMacBook-Pro.local (Darwin)", collector_token_hash="tok-book")


class ClearedChoiceTests(unittest.TestCase):
    def test_empty_project_and_session_sent_by_the_user_are_saved(self) -> None:
        self.assertFalse(_skip_config_value("session_id", ""))
        self.assertFalse(_skip_config_value("project_id", ""))
        self.assertTrue(_skip_config_value("session_id", None))
        # A run that brought no session back (device offline, say) doesn't drop the conversation's one
        self.assertTrue(_skip_config_value("session_id", "", _RUN_EMPTY_IS_A_CHOICE))

    def test_cleared_session_is_not_inferred_back_from_earlier_turns(self) -> None:
        # The user switched to a new session: reopening must not bring the old one back from the tool call
        conv = AskConversation(
            id=uuid.uuid4(),
            title="t",
            config={"execution_mode": "claude", "session_id": "", "project_id": ""},
            turns=[{
                "role": "assistant",
                "content": "完成",
                "toolCalls": [{
                    "name": "run_on_device",
                    "args": {"action": "agent", "binary": "claude", "session_id": "old-sess", "project_id": "old-proj"},
                }],
            }],
        )
        cfg, _ = infer_conversation_config(conv)
        self.assertEqual((cfg["session_id"], cfg["project_id"]), ("", ""))

        # Never saved: still filled in from the turns
        conv.config = {"execution_mode": "claude"}
        cfg, _ = infer_conversation_config(conv)
        self.assertEqual((cfg["session_id"], cfg["project_id"]), ("old-sess", "old-proj"))


class ReconcileSessionTests(unittest.TestCase):
    def run_it(self, mode: str, device: str | None, home, target=None):
        user = User(id=uuid.uuid4(), email="u@example.com", role="owner")
        with patch.object(ask_store, "_session_home", AsyncMock(return_value=home)), \
             patch.object(user_filter, "find_machine_by_id_or_hash", AsyncMock(return_value=target)):
            return asyncio.run(reconcile_session(AsyncMock(), user, mode, device, "sess-1"))

    def test_session_of_another_tool_is_not_resumed(self) -> None:
        # Shell mode on Windows carrying a MacBook Antigravity session (seen in production)
        self.assertEqual(self.run_it("claude", "tok-book", ("antigravity", BOOK), BOOK), (None, "tok-book"))

    def test_session_on_another_device_is_not_resumed_there(self) -> None:
        self.assertEqual(self.run_it("claude", "tok-mini", ("claude_code", BOOK), MINI), (None, "tok-mini"))

    def test_session_on_the_device_picked_is_resumed(self) -> None:
        self.assertEqual(self.run_it("claude", "tok-book", ("claude_code", BOOK), BOOK), ("sess-1", "tok-book"))

    def test_auto_runs_where_the_session_is(self) -> None:
        self.assertEqual(self.run_it("codex", "auto", ("codex", BOOK)), ("sess-1", "tok-book"))
        self.assertEqual(self.run_it("codex", None, ("codex", BOOK)), ("sess-1", "tok-book"))

    def test_unsynced_session_is_left_alone(self) -> None:
        self.assertEqual(self.run_it("claude", "tok-mini", None, MINI), ("sess-1", "tok-mini"))


class AskSendsWhatThePageShowsTests(unittest.TestCase):
    """POST /api/ask: "" for session / project / cwd is a choice; not sent, the conversation's value is used."""

    def send(self, **fields) -> dict:
        captured: dict = {}

        def fake_stream(**kw):
            captured.update(kw)
            return iter(())

        async def fake_run_response(conv_id, user, question, request_id, factory, **kw):
            factory(None, user)
            return {"ok": True}

        stored = {"execution_mode": "claude", "session_id": "old-sess", "project_id": "old-proj", "cwd": "/old"}
        db = AsyncMock()
        db.execute.return_value = MagicMock(scalars=MagicMock(return_value=MagicMock(first=MagicMock(return_value=None))))
        app.dependency_overrides[get_current_user] = lambda: MagicMock(id=uuid.uuid4(), role="owner")
        app.dependency_overrides[get_db] = lambda: db
        try:
            with patch.object(ask.ask_runs, "by_request", AsyncMock(return_value=None)), \
                 patch.object(ask, "get_or_create_conversation", AsyncMock(return_value=(uuid.uuid4(), "t", stored))), \
                 patch.object(ask, "reconcile_session", AsyncMock(side_effect=lambda db, u, m, d, s: (s, d))), \
                 patch.object(ask, "direct_agent_stream", fake_stream), \
                 patch.object(ask, "run_response", fake_run_response):
                body = {"question": "继续", "conversation_id": str(uuid.uuid4()), "execution_mode": "claude",
                        "device_id": "tok-mini", **fields}
                r = TestClient(app).post("/api/ask", json=body)
        finally:
            app.dependency_overrides.pop(get_current_user, None)
            app.dependency_overrides.pop(get_db, None)
        self.assertEqual(r.status_code, 200, r.text)
        return captured

    def test_cleared_choices_do_not_fall_back_to_the_conversations(self) -> None:
        got = self.send(session_id="", project_id="", cwd="")
        self.assertEqual((got["session_id"], got["project_id"], got["cwd"]), (None, None, None))

    def test_not_sent_uses_the_conversations(self) -> None:
        got = self.send()
        self.assertEqual((got["session_id"], got["project_id"], got["cwd"]), ("old-sess", "old-proj", "/old"))

    def test_shell_never_resumes_a_session(self) -> None:
        got = self.send(execution_mode="shell", session_id="sess-x")
        self.assertIsNone(got["session_id"])


class AutoDeviceTests(unittest.TestCase):
    def test_auto_dispatch_picks_a_device_instead_of_looking_up_one_named_auto(self) -> None:
        from server.services import orchestrator

        pick = AsyncMock(return_value=None)
        db = AsyncMock()
        db.execute.return_value = MagicMock(scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[MINI]))))
        user = User(id=uuid.uuid4(), email="u@example.com", role="owner")

        async def run():
            return [e async for e in orchestrator._tool_run_on_device(db, user, {"device_id": "auto", "action": "shell", "command": "ls"})]

        with patch("server.api.tasks.REMOTE_EXEC_ENABLED", True), \
             patch.object(orchestrator, "_select_affinity_machine", pick):
            asyncio.run(run())
        pick.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
