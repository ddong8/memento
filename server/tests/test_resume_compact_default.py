"""A resumed Claude Code session goes on in place, as in Claude Code: only its first continuation on another device starts from a snapshot."""

import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import User
from server.services import ask_stream
from types import SimpleNamespace

USER = User(id=uuid.uuid4(), email="u@example.com", role="owner")


MINI, PC = uuid.uuid4(), uuid.uuid4()


def _dispatch(compact_mode, cost, execution_mode="claude", fork=None, mode=None, events=None, home=MINI):
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
         patch("server.services.user_filter.find_machine_by_id_or_hash", AsyncMock(return_value=SimpleNamespace(id=MINI))), \
         patch("server.services.session_compactor.session_machine_id", AsyncMock(return_value=home)), \
         patch("server.services.session_compactor.claude_resume_cost", AsyncMock(return_value=cost)) as sized, \
         patch("server.services.session_compactor.build_compacted_continuation",
               AsyncMock(return_value={"injected_context": "【前序会话核心记忆快照】……"})), \
         patch.object(ask_stream, "append_conversation_turns", AsyncMock()), \
         patch.object(ask_stream, "get_device_environment_summary", lambda *a: ""):
        out = asyncio.run(collect())
    if events is not None:
        events.extend(out)
    return sent, sized


HEAVY_COLD = {"context_tokens": 342_668, "heavy": True, "cache_cold": True, "minutes_since_activity": 600}


def test_a_heavy_session_not_chosen_goes_on_in_place():
    # memento never starts a new session on its own, whatever an old resume-mode setting said
    for mode in (None, "auto", "compact"):
        sent, sized = _dispatch(None, HEAVY_COLD, mode=mode)
        assert sent["session_id"] == "sess-1" and "compact_mode" not in sent and "parent_session_id" not in sent, mode
        sized.assert_not_awaited()


def test_the_user_picking_compact_starts_from_a_snapshot():
    sent, _ = _dispatch(True, HEAVY_COLD)
    assert "session_id" not in sent
    assert sent["compact_mode"] is True and sent["parent_session_id"] == "sess-1"
    assert sent["prompt"].startswith("【前序会话核心记忆快照】") and sent["prompt"].endswith("继续")


def test_explicit_raw_resume_is_kept():
    sent, sized = _dispatch(False, HEAVY_COLD)
    assert sent["session_id"] == "sess-1" and "compact_mode" not in sent
    sized.assert_not_awaited()


def test_the_first_continuation_on_another_device_starts_from_a_snapshot():
    # the session is on the PC, the run goes to the mini: it can't be resumed there
    events: list = []
    sent, _ = _dispatch(None, HEAVY_COLD, home=PC, events=events)
    assert "session_id" not in sent and sent["compact_mode"] is True and sent["parent_session_id"] == "sess-1"
    assert sent["prompt"].startswith("【前序会话核心记忆快照】")
    assert "[跨设备续接] 原会话 sess-1 不在这台设备上" in "".join(events)


def test_a_session_on_this_device_or_unknown_goes_on_in_place():
    for home in (MINI, None):
        sent, _ = _dispatch(None, HEAVY_COLD, home=home)
        assert sent["session_id"] == "sess-1" and "compact_mode" not in sent, home


def test_explicit_raw_resume_on_another_device_is_kept():
    sent, _ = _dispatch(False, HEAVY_COLD, home=PC)
    assert sent["session_id"] == "sess-1" and "compact_mode" not in sent


def test_a_compacted_resume_says_so_in_the_conversation():
    events: list = []
    _dispatch(True, HEAVY_COLD, events=events)
    text = "".join(events)
    assert "[瘦身续接] 这次从原会话 sess-1" in text
    assert "已新开会话 `new-5678`，接续自 `sess-1`" in text


def test_a_raw_resume_says_nothing_about_a_new_session():
    events: list = []
    _dispatch(None, HEAVY_COLD, events=events)
    text = "".join(events)
    assert "瘦身续接" not in text and "已新开会话" not in text
