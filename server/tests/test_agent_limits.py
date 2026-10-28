"""An agent that ran out of quota reads as that, and the session a conversation goes on in after a run."""

import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.services.agent_limits import mark_usage_limit, usage_limit_message
from server.services.ask_stream import _next_session

LIMIT = "You've hit your session limit · resets 11:40am (Asia/Shanghai)"


def test_the_quota_message_is_read_from_the_agents_errors():
    assert usage_limit_message({"action": "agent", "error": LIMIT}) == LIMIT
    assert usage_limit_message({"stderr": f"x\n{LIMIT}\n"}) == LIMIT
    assert usage_limit_message({"error": "You’ve hit your weekly limit · resets Nov 3"}) == "You’ve hit your weekly limit · resets Nov 3"
    assert usage_limit_message({"error": "Claude AI usage limit reached|1761710400"}) == "usage limit reached|1761710400"
    # Inside a logged JSON line: up to the quote
    assert usage_limit_message({"stderr": '{"text":"' + LIMIT + '"}'}) == LIMIT


def test_an_answer_about_limits_or_a_shell_task_is_not_a_quota_stop():
    assert usage_limit_message({"action": "agent", "stdout": LIMIT, "error": None}) is None
    assert usage_limit_message({"action": "shell", "stderr": LIMIT}) is None
    assert usage_limit_message({"action": "agent", "error": "API Error: 529 overloaded"}) is None
    assert usage_limit_message(None) is None


def test_old_daemons_still_running_on_quota_is_failed():
    r = mark_usage_limit({"action": "agent", "status": "still_running", "error": f"x {LIMIT}"})
    assert (r["status"], r["error_type"], r["error"]) == ("failed", "usage_limit", LIMIT)
    ok = {"action": "agent", "status": "succeeded", "stdout": "done"}
    assert mark_usage_limit(dict(ok)) == ok


def test_next_session():
    # The one the device reports, also when the run failed
    assert _next_session({"status": "failed", "session_id": "new"}, "old", None) == "new"
    assert _next_session({"status": "succeeded", "session_id": "s"}, None, None) == "s"
    # Gone, and the device reported only the dead one or nothing: forget it
    gone = {"status": "failed", "error": "No conversation found with session ID: old", "session_id": "old"}
    assert _next_session(gone, "old", None) == ""
    assert _next_session({"status": "failed", "stderr": "session not found"}, None, "old") == ""
    # Gone, but the device started a new one in its place
    assert _next_session({**gone, "session_id": "fresh"}, "old", None) == "fresh"
    # Failed without saying: keep what the conversation has
    assert _next_session({"status": "failed", "error": "boom"}, "old", None) is None
    # Done, without a report: the one it asked for
    assert _next_session({"status": "succeeded"}, None, "orig") == "orig"
    assert _next_session(None, None, None) is None


def test_stop_orphaned_agent_tasks_cancels_on_the_device():
    from server.db.models import DeviceTask, User
    from server.services import orchestrator

    user = User(id=uuid.uuid4(), email="u@example.com", role="owner")
    t = DeviceTask(id=uuid.uuid4(), user_id=user.id, device_id="mini", action="agent", status="running", payload={})
    db = MagicMock()
    res = MagicMock()
    res.scalars.return_value.all.return_value = [t]
    db.execute = AsyncMock(return_value=res)
    db.commit = AsyncMock()
    cancel = AsyncMock()
    with patch.object(orchestrator.ws_manager, "cancel_when_back", cancel):
        stopped = asyncio.run(orchestrator.stop_orphaned_agent_tasks(db, user, "conv"))
    assert stopped == [t]
    cancel.assert_awaited_once_with("mini", str(t.id))
    assert t.status == "cancelled" and t.finished_at is not None and t.error == orchestrator.ORPHAN_STOPPED
    db.commit.assert_awaited_once()
    sql = str(db.execute.await_args.args[0].compile(compile_kwargs={"literal_binds": True}))
    assert "'agent'" in sql and "conversation_id" in sql and "still_running" not in sql
