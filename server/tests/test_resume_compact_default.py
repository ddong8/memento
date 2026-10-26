"""A heavy Claude Code session resumes from a compacted snapshot unless the client asked for raw."""

import asyncio
import uuid
from unittest.mock import AsyncMock, patch

from server.db.models import User
from server.services import ask_stream
from server.services.claude_session import auto_compact_window, valid_auto_compact_window

USER = User(id=uuid.uuid4(), email="u@example.com", role="owner")


def _dispatch(compact_mode, cost, execution_mode="claude", fork=None):
    """The args direct_agent_stream hands to the device, for a resume of session "sess-1"."""
    sent: dict = {}

    async def fake_run(db, user, args):
        sent.update(args)
        yield {"type": "tool_result", "result": {"status": "succeeded", "stdout": "ok", "exit_code": 0}}

    async def collect():
        gen = ask_stream.direct_agent_stream(
            db=AsyncMock(), user=USER, question="继续", conv_id=uuid.uuid4(), conv_title="t",
            execution_mode=execution_mode, device_id="mini", cwd="/w", session_id="sess-1",
            compact_mode=compact_mode, fork=fork,
        )
        return [e async for e in gen]

    with patch("server.services.orchestrator._tool_run_on_device", fake_run), \
         patch("server.services.user_filter.user_machine_ids", AsyncMock(return_value=["m1"])), \
         patch("server.services.session_compactor.claude_resume_cost", AsyncMock(return_value=cost)) as sized, \
         patch("server.services.session_compactor.build_compacted_continuation",
               AsyncMock(return_value={"injected_context": "【前序会话核心记忆快照】……"})), \
         patch.object(ask_stream, "append_conversation_turns", AsyncMock()), \
         patch.object(ask_stream, "get_device_environment_summary", lambda *a: ""):
        asyncio.run(collect())
    return sent, sized


def test_heavy_session_not_chosen_resumes_compacted():
    sent, _ = _dispatch(None, {"context_tokens": 342_668, "heavy": True})
    assert "session_id" not in sent
    assert sent["compact_mode"] is True and sent["parent_session_id"] == "sess-1"
    assert sent["prompt"].startswith("【前序会话核心记忆快照】") and sent["prompt"].endswith("继续")


def test_explicit_raw_resume_is_kept():
    sent, sized = _dispatch(False, {"context_tokens": 342_668, "heavy": True})
    assert sent["session_id"] == "sess-1" and "compact_mode" not in sent
    sized.assert_not_awaited()


def test_light_or_unknown_session_resumes_raw():
    for cost in ({"context_tokens": 90_000, "heavy": False}, {}):
        sent, _ = _dispatch(None, cost)
        assert sent["session_id"] == "sess-1"


def test_only_claude_and_not_forks_are_sized():
    for kwargs in ({"execution_mode": "codex"}, {"fork": True}):
        sent, sized = _dispatch(None, {"context_tokens": 342_668, "heavy": True}, **kwargs)
        assert sent["session_id"] == "sess-1"
        sized.assert_not_awaited()


def test_auto_compact_window_setting():
    assert auto_compact_window({}) == 200_000
    assert auto_compact_window({"agent": {"claude_auto_compact_window": 0}}) == 0
    assert auto_compact_window({"agent": {"claude_auto_compact_window": 500_000}}) == 500_000
    # a value Claude Code wouldn't accept falls back to the default
    assert auto_compact_window({"agent": {"claude_auto_compact_window": 50_000}}) == 200_000
    for bad in (99_999, 1_000_001, True, "200000", None):
        assert valid_auto_compact_window(bad) is None
