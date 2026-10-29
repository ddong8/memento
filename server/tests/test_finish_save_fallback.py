"""A finished result that fails to save is kept in parts, not lost.

On 2026-10-29 a NUL in a tool's output failed the task_finished write: the task stayed "running", a
later question stopped it, and its turn said the service had updated. The answer of a run that
followed the task was lost the same way when saving its turn failed.
"""

import asyncio
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from server.api import tasks
from server.services import ask_stream

TID = str(uuid.uuid4())
DATA = {"task_id": TID, "status": "succeeded", "exit_code": 0, "stdout": "答案", "stderr": "",
        "session_id": "s1", "events": [{"kind": "tool", "id": "t1"}]}


class _Db:
    def __init__(self, task, fail):
        self.task, self.fail = task, fail

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, *_a, **_k):
        return SimpleNamespace(scalar_one_or_none=lambda: self.task)

    async def commit(self):
        if self.fail:
            raise ValueError("unsupported Unicode escape sequence")


def _save(task_status: str, fails: int):
    """Runs _save_finished with the first `fails` commits raising; returns (saved, snapshots)."""
    snaps: list[dict] = []
    attempts = iter(range(10))

    def factory():
        n = next(attempts)
        task = SimpleNamespace(status=task_status, action="agent", events=[], stdout=None, stderr=None,
                               error=None, exit_code=None, session_id=None, finished_at=None)
        snaps.append(vars(task))
        return _Db(task, n < fails)

    with patch.object(tasks, "async_session_factory", factory):
        ok = asyncio.run(tasks._save_finished(TID, dict(DATA)))
    return ok, snaps


def test_saved_whole_when_it_fits():
    ok, snaps = _save("running", fails=0)
    assert ok and len(snaps) == 1
    assert snaps[0]["status"] == "succeeded" and snaps[0]["events"] == DATA["events"]


def test_drops_the_step_log_when_the_whole_result_fails():
    ok, snaps = _save("running", fails=1)
    assert ok and len(snaps) == 2
    kept = snaps[1]
    assert kept["status"] == "succeeded" and kept["stdout"] == "答案" and kept["session_id"] == "s1"
    assert kept["events"] == [] and kept["finished_at"] is not None


def test_records_why_when_nothing_else_saves():
    ok, snaps = _save("running", fails=2)
    assert ok and len(snaps) == 3
    last = snaps[2]
    assert last["status"] == "failed" and last["finished_at"] is not None
    assert "结果没能存进数据库" in last["error"] and "ValueError" in last["error"]
    assert last["stdout"] is None


def test_gives_up_quietly_when_the_database_is_gone():
    ok, snaps = _save("running", fails=3)
    assert not ok and len(snaps) == 3


def test_a_stopped_task_stays_stopped():
    ok, snaps = _save("cancelled", fails=0)
    assert not ok and snaps[0]["status"] == "cancelled"


def test_bad_task_id_is_ignored():
    assert asyncio.run(tasks._save_finished("not-a-uuid", DATA)) is False


def test_turn_saved_again_slimmed_when_it_fails():
    big = "x" * (ask_stream._SLIM_OUTPUT_CHARS + 50)
    call = {"id": "c1", "status": "succeeded",
            "result": {"stdout": big + "尾", "stderr": "e", "events": [{"kind": "tool"}], "task_id": TID}}
    saved = AsyncMock(side_effect=[False, True])
    with patch.object(ask_stream, "append_conversation_turns", saved):
        asyncio.run(ask_stream._append_turns_or_slim(conv_id="c", assistant_content="答", tool_calls=[call]))
    assert saved.await_count == 2
    first, second = (c.kwargs for c in saved.await_args_list)
    assert first["tool_calls"][0]["result"]["events"] == [{"kind": "tool"}]
    res = second["tool_calls"][0]["result"]
    assert "events" not in res and res["task_id"] == TID and res["stderr"] == "e"
    assert len(res["stdout"]) == ask_stream._SLIM_OUTPUT_CHARS and res["stdout"].endswith("尾")
    assert second["assistant_content"] == "答"
    assert call["result"]["events"], "the caller's call is left as it was"


def test_turn_saved_once_when_it_fits():
    saved = AsyncMock(return_value=True)
    with patch.object(ask_stream, "append_conversation_turns", saved):
        asyncio.run(ask_stream._append_turns_or_slim(conv_id="c", assistant_content="答", tool_calls=[]))
    assert saved.await_count == 1
