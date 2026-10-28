"""What direct_agent_stream saves when a run ends some other way than its task reporting, and how
a replica that takes a run over follows the task instead of dispatching it again."""

import asyncio
import json
import uuid
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

from server.db.models import User
from server.services import ask_stream
from server.services.ask_runs import ask_runs

USER = User(id=uuid.uuid4(), email="u@example.com", role="owner")
CONV = uuid.uuid4()


def _kwargs(**over):
    kw = dict(question="跑测试", conv_title="t", execution_mode="claude", device_id="mini", cwd="/w")
    kw.update(over)
    return kw


class _Harness:
    """direct_agent_stream with the device and the database stubbed out."""

    def __init__(self, device_events, hang=False, raise_exc=None):
        self.sent: list[dict] = []
        self.saved = AsyncMock()
        self.device_events = device_events
        self.hang = hang
        self.raise_exc = raise_exc

    async def fake_run(self, db, user, args):
        self.sent.append(args)
        for evt in self.device_events:
            yield evt
        if self.raise_exc:
            raise self.raise_exc
        if self.hang:
            await asyncio.Event().wait()

    def patches(self):
        stack = ExitStack()
        stack.enter_context(patch("server.services.orchestrator._tool_run_on_device", self.fake_run))
        stack.enter_context(patch("server.services.user_filter.user_machine_ids", AsyncMock(return_value=["m1"])))
        stack.enter_context(patch.object(ask_stream, "append_conversation_turns", self.saved))
        stack.enter_context(patch.object(ask_stream, "get_device_environment_summary", lambda *a: ""))
        return stack

    def saved_call(self) -> tuple[str, dict]:
        kw = self.saved.await_args.kwargs
        return kw["assistant_content"], kw["tool_calls"][0]


def _events(frames):
    out = []
    for f in frames:
        if f.startswith("data: "):
            out.append(json.loads(f[6:]))
    return out


async def _consume_until(gen, frames, ready):
    async for f in gen:
        frames.append(f)
        if ready(frames):
            break
    await asyncio.Event().wait()


def _run_and_stop(h: _Harness, ckpt: dict, before_cancel=None):
    """Start the run, wait until its task is on the device, then cut it short."""
    frames: list[str] = []

    async def main():
        gen = ask_stream.direct_agent_stream(db=AsyncMock(), user=USER, conv_id=CONV, checkpoint=ckpt, **_kwargs())

        async def pump():
            async for f in gen:
                frames.append(f)

        task = asyncio.create_task(pump())
        while not ckpt.get("task_id"):
            await asyncio.sleep(0.01)
        if before_cancel:
            before_cancel(task)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        finally:
            ask_runs._moving.discard(task)

    with h.patches():
        asyncio.run(main())
    return frames


PROGRESS = {"type": "task_progress", "task_id": "t-1", "status": "running", "device_name": "mini"}


def test_checkpoint_has_what_a_takeover_needs():
    h = _Harness([PROGRESS, {"type": "tool_result", "result": {"task_id": "t-1", "status": "succeeded", "stdout": "全部通过", "exit_code": 0}}])
    ckpt: dict = {}

    async def run():
        gen = ask_stream.direct_agent_stream(db=AsyncMock(), user=USER, conv_id=CONV, checkpoint=ckpt, **_kwargs(images=["data:image/png;base64,AAAA"]))
        return [f async for f in gen]

    with h.patches():
        asyncio.run(run())
    assert ckpt["task_id"] == "t-1" and ckpt["result"] is True
    assert ckpt["call"]["name"] == "run_on_device" and ckpt["call"]["id"] == ckpt["call_id"]
    assert ckpt["call"]["args"]["images"] == ["<image attachment 1>"]  # no image data kept for the handover
    assert ckpt["action"] == "agent" and ckpt["user_created_at"] and ckpt["started_at"]
    content, call = h.saved_call()
    assert "全部通过" in content and call["result"]["status"] == "succeeded"


def test_stopped_by_the_user_is_saved_as_stopped_not_done():
    h = _Harness([PROGRESS], hang=True)
    _run_and_stop(h, {})
    content, call = h.saved_call()
    assert content == "⏹ 已停止"
    assert call["result"]["status"] == "cancelled" and call["result"]["task_id"] == "t-1"
    assert "任务执行完成" not in json.dumps(call, ensure_ascii=False)


def test_handed_over_saves_nothing_here():
    h = _Harness([PROGRESS], hang=True)
    ckpt: dict = {}

    def moving(task):
        ckpt["moving"] = True
        ask_runs._moving.add(task)

    _run_and_stop(h, ckpt, before_cancel=moving)
    h.saved.assert_not_awaited()


def test_interrupted_with_the_task_on_the_device_leaves_the_turn_to_its_result():
    h = _Harness([PROGRESS], hang=True)
    with patch.object(ask_runs, "shutting_down", True):
        _run_and_stop(h, {})
    # Saved from the task when it reports (recover_orphaned_tasks_for_conv): saving here doubled the question
    h.saved.assert_not_awaited()


def test_an_error_is_saved_as_failed():
    h = _Harness([PROGRESS], raise_exc=RuntimeError("设备连接断开"))
    ckpt: dict = {}

    async def run():
        gen = ask_stream.direct_agent_stream(db=AsyncMock(), user=USER, conv_id=CONV, checkpoint=ckpt, **_kwargs())
        return [f async for f in gen]

    with h.patches():
        frames = asyncio.run(run())
    content, call = h.saved_call()
    assert "设备连接断开" in content and content.startswith("❌")
    assert call["result"]["status"] == "failed"
    assert [e["type"] for e in _events(frames)][-1] == "done"


def test_resume_follows_the_task_already_on_the_device():
    ckpt = {
        "user_created_at": "2026-10-28T01:00:00+00:00",
        "started_at": 1_000.0,
        "action": "agent",
        "session_id": "sess-1",
        "orig_session_id": None,
        "call_id": "direct_abcd1234",
        "call": {"id": "direct_abcd1234", "tool_call_id": "direct_abcd1234", "name": "run_on_device",
                 "args": {"action": "claude"}, "status": "running"},
        "task_id": "t-1",
        "thinking": ["先看测试。"],
    }
    h = _Harness([{"type": "task_chunk", "text": "rest"},
                  {"type": "tool_result", "result": {"task_id": "t-1", "status": "succeeded", "stdout": "完成", "exit_code": 0}}])
    resume = ask_stream._resume_direct_agent({**_kwargs(), "conv_id": str(CONV)}, ckpt)

    async def run():
        return [f async for f in resume(AsyncMock(), USER)]

    with h.patches():
        frames = asyncio.run(run())
    assert h.sent == [{"attach_task_id": "t-1"}]  # not dispatched a second time
    types = [e["type"] for e in _events(frames)]
    assert "conversation_id" not in types and "tool_call" not in types  # already sent before the handover
    assert types[-1] == "done"
    kw = h.saved.await_args.kwargs
    assert kw["conv_id"] == CONV and kw["user_created_at"] == "2026-10-28T01:00:00+00:00"
    assert kw["thinking"] == "先看测试。"
    assert kw["tool_calls"][0]["id"] == "direct_abcd1234"
    assert "完成" in kw["assistant_content"]
    assert ask_runs.resumers["direct_agent"] is ask_stream._resume_direct_agent


# ── orchestrator: following a task another replica dispatched ─────────────────

def _attach(task_row, queued=()):
    """_attach_device_task with the row in the database and these events already queued."""
    from unittest.mock import MagicMock

    from server.services import orchestrator as orch

    q: asyncio.Queue = asyncio.Queue()
    for evt in queued:
        q.put_nowait(evt)
    result = MagicMock()
    result.scalars.return_value.first.return_value = task_row
    session = AsyncMock()
    session.execute.return_value = result
    factory = MagicMock()
    factory.return_value.__aenter__.return_value = session
    subscribe, unsubscribe = AsyncMock(return_value=q), AsyncMock()
    db = AsyncMock()
    db.get.return_value = None

    async def run():
        return [e async for e in orch._attach_device_task(db, USER, str(task_row.id if task_row else uuid.uuid4()))]

    with patch.object(orch, "async_session_factory", factory), \
            patch.object(orch.ws_manager, "subscribe_task", subscribe), \
            patch.object(orch.ws_manager, "unsubscribe_task", unsubscribe), \
            patch.object(orch, "_load_alerts", AsyncMock(return_value=[])):
        events = asyncio.run(run())
    return events, subscribe, unsubscribe


def _task_row(**over):
    from server.db.models import DeviceTask

    kw = dict(id=uuid.uuid4(), user_id=USER.id, device_id="dev-1", machine_id=None, action="agent",
              status="running", timeout_seconds=0, payload={"conversation_id": str(CONV)})
    kw.update(over)
    return DeviceTask(**kw)


def test_attach_picks_up_a_task_that_ended_during_the_handover():
    row = _task_row(status="succeeded", stdout="全部通过", exit_code=0)
    events, subscribe, unsubscribe = _attach(row)
    assert subscribe.await_count == 1 and unsubscribe.await_count >= 1  # subscribed before reading the row
    result = events[-1]
    assert result["type"] == "tool_result"
    assert result["result"]["task_id"] == str(row.id) and result["result"]["status"] == "succeeded"
    assert result["result"]["stdout"] == "全部通过"


def test_attach_streams_what_the_device_sends_from_now_on():
    row = _task_row()
    events, _, _ = _attach(row, queued=[
        {"type": "task_chunk", "task_id": str(row.id), "stream": "stdout", "text": "后半段输出"},
        {"type": "task_finished", "task_id": str(row.id), "result": {"status": "succeeded", "stdout": "完成", "exit_code": 0}},
    ])
    assert [e["type"] for e in events] == ["task_progress", "task_chunk", "tool_result"]
    assert events[1]["text"] == "后半段输出"
    assert events[-1]["result"]["stdout"] == "完成" and events[-1]["result"]["status"] == "succeeded"


def test_attach_refuses_a_task_of_another_user():
    row = _task_row(user_id=uuid.uuid4(), status="succeeded", stdout="别人的输出")
    events, _, unsubscribe = _attach(row)
    assert len(events) == 1 and events[0]["result"]["status"] == "failed"
    assert "别人的输出" not in json.dumps(events, ensure_ascii=False)
    assert unsubscribe.await_count == 1


def test_attach_to_a_missing_task_fails_instead_of_dispatching():
    events, _, _ = _attach(None)
    assert len(events) == 1 and events[0]["type"] == "tool_result"
    assert events[0]["result"]["error"] == "要继续跟进的设备任务不存在"
