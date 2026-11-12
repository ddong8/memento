"""A heavy Claude Code session resumes from a compacted snapshot unless the client asked for raw."""

import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import User
from server.services import ask_stream
from server.services.claude_session import auto_compact_window, resume_mode, valid_auto_compact_window

USER = User(id=uuid.uuid4(), email="u@example.com", role="owner")


def _dispatch(compact_mode, cost, execution_mode="claude", fork=None, mode=None, events=None):
    """The args direct_agent_stream hands to the device, for a resume of session "sess-1"."""
    sent: dict = {}
    user = User(id=USER.id, email=USER.email, role="owner", llm_settings={"agent": {"claude_resume_mode": mode}} if mode else {})

    mock_db = AsyncMock()
    mock_res = MagicMock()
    mock_res.scalars.return_value.all.return_value = []
    mock_res.scalars.return_value.first.return_value = None
    mock_res.scalar_one_or_none.return_value = None
    mock_db.execute.return_value = mock_res

    async def fake_run(db, user, args):
        sent.update(args)
        new = "new-5678-session" if args.get("compact_mode") else args.get("session_id")
        yield {"type": "tool_result", "result": {"status": "succeeded", "stdout": "ok", "exit_code": 0, "session_id": new}}

    async def collect():
        gen = ask_stream.direct_agent_stream(
            db=mock_db, user=user, question="继续", conv_id=uuid.uuid4(), conv_title="t",
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
        out = asyncio.run(collect())
    if events is not None:
        events.extend(out)
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


def test_resume_mode_setting():
    assert resume_mode({}) == "auto"
    assert resume_mode({"agent": {"claude_resume_mode": "native"}}) == "native"
    assert resume_mode({"agent": {"claude_resume_mode": "bogus"}}) == "auto"


def test_always_native_never_compacts_a_heavy_session():
    sent, sized = _dispatch(None, {"context_tokens": 342_668, "heavy": True}, mode="native")
    assert sent["session_id"] == "sess-1" and "compact_mode" not in sent
    sized.assert_not_awaited()


def test_always_compact_compacts_a_light_session():
    sent, sized = _dispatch(None, {"context_tokens": 20_000, "heavy": False}, mode="compact")
    assert sent["compact_mode"] is True and "session_id" not in sent
    sized.assert_not_awaited()


def test_the_client_choice_beats_the_setting():
    sent, _ = _dispatch(False, {}, mode="compact")
    assert sent["session_id"] == "sess-1" and "compact_mode" not in sent


def test_a_compacted_resume_says_so_in_the_conversation():
    events: list = []
    _dispatch(None, {"context_tokens": 342_668, "heavy": True}, events=events)
    text = "".join(events)
    assert "[瘦身续接] 原会话 sess-1" in text
    assert "已新开会话 `new-5678`，接续自 `sess-1`" in text


def test_a_raw_resume_says_nothing_about_a_new_session():
    events: list = []
    _dispatch(None, {"context_tokens": 90_000, "heavy": False}, events=events)
    text = "".join(events)
    assert "瘦身续接" not in text and "已新开会话" not in text
