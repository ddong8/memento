"""How a background mission takes its steps: waits, model failures, device commands and approvals."""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from server.db.models import AgentMission, DeviceTask, Machine, User
from server.services import mission_service as ms


def _result(one=None, all_items=None):
    r = MagicMock()
    r.scalar_one_or_none.return_value = one
    r.scalars.return_value.all.return_value = all_items or []
    return r


def _db(*results):
    db = MagicMock()
    db.execute = AsyncMock(side_effect=list(results))
    db.commit = AsyncMock()
    db.refresh = AsyncMock()
    db.add = MagicMock()
    return db


def _user(settings=None):
    return User(id=uuid.uuid4(), email="u@example.com", proactive_settings=settings)


def _mission(user, context=None, current_step=1):
    return AgentMission(
        id=uuid.uuid4(),
        user_id=user.id,
        title="检查构建",
        goal="让测试全部通过",
        status="running",
        current_step=current_step,
        steps=[{"step": 0, "type": "init"}],
        context=context or {},
    )


def _machine(user, name, token, heartbeat_minutes_ago=1):
    return Machine(
        id=uuid.uuid4(),
        user_id=user.id,
        name=name,
        collector_token_hash=token,
        last_heartbeat=datetime.now(timezone.utc) - timedelta(minutes=heartbeat_minutes_ago),
    )


def _online(*tokens):
    """ws_alias as if only the devices with these token hashes were connected."""
    return lambda device_id, machine=None: device_id if device_id in tokens else None


@pytest.mark.asyncio
async def test_a_wait_is_honored_without_asking_the_model():
    user = _user()
    later = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    mission = _mission(user, {"wait_until": later})
    db = _db(_result(one=user))
    with patch.object(ms, "call_plain_chat", AsyncMock()) as chat:
        assert await ms.step_mission(db, mission) is False
    chat.assert_not_awaited()
    assert mission.context["wait_until"] == later
    assert mission.last_heartbeat is not None


@pytest.mark.asyncio
async def test_a_wait_is_capped_at_an_hour_and_saved_as_a_new_dict():
    user = _user()
    mission = _mission(user)
    old_context, old_steps = mission.context, mission.steps
    db = _db(_result(one=user))
    with patch.object(ms, "call_plain_chat", AsyncMock(return_value='```json\n{"action": "wait", "seconds": 99999}\n```')):
        assert await ms.step_mission(db, mission) is True
    assert mission.steps[-1]["type"] == "wait" and mission.steps[-1]["seconds"] == ms.MAX_WAIT_SECONDS
    assert mission.steps[-1]["step"] == mission.current_step == 2
    until = datetime.fromisoformat(mission.context["wait_until"])
    assert timedelta(minutes=59) < until - datetime.now(timezone.utc) <= timedelta(hours=1)
    # Reassigned rather than changed in place, so SQLAlchemy sees and saves both JSONB columns.
    assert mission.context is not old_context and mission.steps is not old_steps


@pytest.mark.asyncio
async def test_unusable_replies_back_off_and_the_fifth_fails_the_mission():
    user = _user()
    mission = _mission(user)
    notify = AsyncMock()
    with patch.object(ms, "call_plain_chat", AsyncMock(return_value="好的，我来看看")), patch.object(ms, "notify_user", notify):
        for failures in range(1, ms.MAX_DECISION_FAILURES):
            mission.context = {k: v for k, v in mission.context.items() if k != "wait_until"}
            assert await ms.step_mission(_db(_result(one=user)), mission) is False
            assert mission.context["decision_failures"] == failures
            pause = datetime.fromisoformat(mission.context["wait_until"]) - datetime.now(timezone.utc)
            assert timedelta(seconds=60 * 2 ** (failures - 1) - 5) < pause <= timedelta(seconds=60 * 2 ** (failures - 1))
            assert mission.status == "running"
        mission.context = {k: v for k, v in mission.context.items() if k != "wait_until"}
        assert await ms.step_mission(_db(_result(one=user)), mission) is True
    assert mission.status == "failed"
    assert mission.steps[-1]["type"] == "error"
    notify.assert_awaited_once()
    assert notify.await_args.kwargs["url"].endswith("/profile?tab=proactive")


@pytest.mark.asyncio
async def test_a_good_reply_clears_the_failure_count():
    user = _user()
    mission = _mission(user, {"decision_failures": 3})
    with patch.object(ms, "call_plain_chat", AsyncMock(return_value='{"action": "wait", "seconds": 30}')):
        await ms.step_mission(_db(_result(one=user)), mission)
    assert "decision_failures" not in mission.context


@pytest.mark.asyncio
async def test_a_mission_stops_after_max_steps_without_asking_the_model():
    user = _user()
    mission = _mission(user, current_step=ms.MAX_STEPS)
    with patch.object(ms, "call_plain_chat", AsyncMock()) as chat, patch.object(ms, "notify_user", AsyncMock()):
        assert await ms.step_mission(_db(_result(one=user)), mission) is True
    chat.assert_not_awaited()
    assert mission.status == "failed"


@pytest.mark.asyncio
async def test_finish_succeeds_and_links_to_the_missions_page():
    user = _user()
    mission = _mission(user)
    notify = AsyncMock()
    with patch.object(ms, "call_plain_chat", AsyncMock(return_value='{"action": "finish", "summary": "全部通过"}')), \
            patch.object(ms, "notify_user", notify):
        assert await ms.step_mission(_db(_result(one=user)), mission) is True
    assert mission.status == "succeeded" and mission.summary == "全部通过"
    assert notify.await_args.kwargs["url"].endswith("/profile?tab=proactive")


@pytest.mark.asyncio
async def test_a_safe_command_goes_to_the_online_device_and_is_sent():
    user = _user(settings=None)  # no saved settings: the defaults apply
    mission = _mission(user)
    offline = _machine(user, "mac-mini", "tok-offline", heartbeat_minutes_ago=0)
    online = _machine(user, "laptop", "tok-online", heartbeat_minutes_ago=30)
    db = _db(_result(one=user), _result(all_items=[offline, online]))
    deliver = AsyncMock(return_value=True)
    reply = '{"action": "exec_shell", "command": "git status", "reason": "看改动"}'
    with patch.object(ms, "call_plain_chat", AsyncMock(return_value=reply)), \
            patch.object(ms, "ws_alias", _online("tok-online")), patch.object(ms, "deliver_task", deliver):
        assert await ms.step_mission(db, mission) is True
    task = db.add.call_args.args[0]
    assert isinstance(task, DeviceTask)
    assert task.action == "shell" and task.device_id == "tok-online" and task.machine_id == online.id
    assert task.payload == {"command": "git status", "mission_id": str(mission.id)}
    assert mission.context["active_device_task_id"] == str(task.id)
    assert mission.steps[-1]["type"] == "exec_shell" and mission.steps[-1]["device_name"] == "laptop"
    deliver.assert_awaited_once_with(db, task, online)
    # Archived and merged devices are never candidates.
    query = str(db.execute.await_args_list[1].args[0])
    assert "merged_into IS NULL" in query and "is_archived IS NOT" in query


@pytest.mark.asyncio
async def test_the_device_the_model_names_wins_when_it_is_online():
    user = _user()
    first = _machine(user, "laptop (Darwin)", "tok-a")
    named = _machine(user, "mac-mini (Darwin)", "tok-b")
    for hint, expected in (("Mac-Mini", named), ("tok-b", named), ("gone-box", first)):
        db = _db(_result(all_items=[first, named]))
        with patch.object(ms, "ws_alias", _online("tok-a", "tok-b")):
            _, target = await ms._pick_machine(db, user, hint)
        assert target is expected, hint


@pytest.mark.asyncio
async def test_with_no_device_online_the_mission_looks_again_later():
    user = _user()
    mission = _mission(user)
    db = _db(_result(all_items=[_machine(user, "laptop", "tok-a")]))
    deliver = AsyncMock()
    with patch.object(ms, "ws_alias", _online()), patch.object(ms, "deliver_task", deliver):
        assert await ms._dispatch_remote_shell(db, mission, user, "git status", "看改动") is False
    deliver.assert_not_awaited()
    db.add.assert_not_called()
    assert "没有在线的设备" in mission.steps[-1]["message"]
    pause = datetime.fromisoformat(mission.context["wait_until"]) - datetime.now(timezone.utc)
    assert timedelta(seconds=ms.OFFLINE_RETRY_SECONDS - 5) < pause <= timedelta(seconds=ms.OFFLINE_RETRY_SECONDS)


@pytest.mark.asyncio
async def test_a_dangerous_command_waits_for_approval_and_keeps_the_named_device():
    user = _user()
    mission = _mission(user)
    notify = AsyncMock()
    deliver = AsyncMock()
    reply = '{"action": "exec_shell", "command": "rm -rf build", "reason": "清理", "device_id": "mac-mini"}'
    with patch.object(ms, "call_plain_chat", AsyncMock(return_value=reply)), \
            patch.object(ms, "notify_user", notify), patch.object(ms, "deliver_task", deliver):
        assert await ms.step_mission(_db(_result(one=user)), mission) is True
    deliver.assert_not_awaited()
    assert mission.status == "waiting_approval" and mission.approval_token
    assert mission.pending_action["command"] == "rm -rf build"
    assert mission.pending_action["device_id"] == "mac-mini"
    assert mission.pending_action["risk_level"] == "danger"
    assert notify.await_args.kwargs["kind"] == "risky"
    assert mission.approval_token in notify.await_args.kwargs["url"]


@pytest.mark.asyncio
async def test_a_warned_command_needs_approval_only_when_auto_approve_is_off():
    reply = '{"action": "exec_shell", "command": "git push origin main"}'
    for settings, expected in (({"auto_approve_safe": False}, "waiting_approval"), ({}, "running")):
        user = _user(settings)
        mission = _mission(user)
        with patch.object(ms, "call_plain_chat", AsyncMock(return_value=reply)), \
                patch.object(ms, "notify_user", AsyncMock()), \
                patch.object(ms, "_dispatch_remote_shell", AsyncMock(return_value=True)) as dispatch:
            await ms.step_mission(_db(_result(one=user)), mission)
        assert mission.status == expected, settings
        assert dispatch.await_count == (expected == "running")


@pytest.mark.asyncio
async def test_a_running_device_task_is_waited_for_then_recorded():
    user = _user()
    task = DeviceTask(id=uuid.uuid4(), status="running")
    mission = _mission(user, {"active_device_task_id": str(task.id)})
    with patch.object(ms, "call_plain_chat", AsyncMock()) as chat:
        assert await ms.step_mission(_db(_result(one=user), _result(one=task)), mission) is False
    chat.assert_not_awaited()

    task.status, task.exit_code, task.stdout = "succeeded", 0, "On branch main"
    with patch.object(ms, "call_plain_chat", AsyncMock(return_value='{"action": "wait", "seconds": 5}')):
        assert await ms.step_mission(_db(_result(one=user), _result(one=task)), mission) is True
    result = next(s for s in mission.steps if s["type"] == "device_task_result")
    assert result["exit_code"] == 0 and result["output_preview"] == "On branch main"
    assert "active_device_task_id" not in mission.context


@pytest.mark.asyncio
async def test_approval_sends_the_pending_command_to_the_named_device():
    user = _user()
    mission = _mission(user)
    mission.status = "waiting_approval"
    mission.approval_token = "secret-token"
    mission.pending_action = {"action": "exec_shell", "command": "rm -rf build", "reason": "清理", "device_id": "mac-mini"}
    db = _db(_result(one=mission), _result(one=user))
    with patch.object(ms, "_dispatch_remote_shell", AsyncMock(return_value=True)) as dispatch:
        assert await ms.approve_mission(db, mission.id, "wrong-token", None) is False
        db.execute = AsyncMock(side_effect=[_result(one=mission), _result(one=user)])
        assert await ms.approve_mission(db, mission.id, "secret-token", None) is True
    assert mission.status == "running" and mission.approval_token is None and mission.pending_action is None
    assert mission.steps[-1]["type"] == "approved"
    dispatch.assert_awaited_once_with(db, mission, user, "rm -rf build", "清理", "mac-mini")


@pytest.mark.asyncio
async def test_rejection_cancels_the_mission():
    user = _user()
    mission = _mission(user)
    mission.status = "waiting_approval"
    mission.approval_token = "secret-token"
    mission.pending_action = {"action": "exec_shell", "command": "rm -rf build"}
    assert await ms.reject_mission(_db(_result(one=mission)), mission.id, None, user.id, "不要删") is True
    assert mission.status == "cancelled" and mission.pending_action is None
    assert mission.steps[-1]["type"] == "rejected" and mission.steps[-1]["reason"] == "不要删"


@pytest.mark.asyncio
async def test_work_for_an_agent_goes_to_claude_code_and_the_next_step_resumes_its_session():
    user = _user()
    mission = _mission(user)
    laptop = _machine(user, "laptop", "tok-a")
    mini = _machine(user, "mac-mini", "tok-b")
    db = _db(_result(one=user), _result(all_items=[laptop, mini]))
    reply = '{"action": "run_agent", "prompt": "修好失败的测试", "cwd": "/Users/me/repo", "device_id": "mac-mini"}'
    chat = AsyncMock(return_value=reply)
    with patch.object(ms, "call_plain_chat", chat), patch.object(ms, "ws_alias", _online("tok-a", "tok-b")), \
            patch.object(ms, "deliver_task", AsyncMock(return_value=True)):
        assert await ms.step_mission(db, mission) is True
    # The model is told which devices it can use
    assert "laptop, mac-mini" in chat.await_args.args[0][0]["content"]
    task = db.add.call_args.args[0]
    assert task.action == "agent" and task.device_id == "tok-b" and task.timeout_seconds == ms.AGENT_TIMEOUT_SECONDS
    assert task.payload["prompt"] == "修好失败的测试" and task.payload["binary"] == "claude"
    assert task.payload["cwd"] == "/Users/me/repo" and task.payload["mission_id"] == str(mission.id)
    assert "session_id" not in task.payload
    assert mission.steps[-1]["type"] == "run_agent" and mission.steps[-1]["device_name"] == "mac-mini"

    # Its result: the answer's end is kept, and the session it ran in
    task.status, task.exit_code, task.stdout, task.session_id = "succeeded", 0, "x" * 5000 + "全部通过", "sess-9"
    db = _db(_result(one=user), _result(one=task), _result(all_items=[laptop, mini]))
    reply = '{"action": "run_agent", "prompt": "再跑一遍确认"}'
    with patch.object(ms, "call_plain_chat", AsyncMock(return_value=reply)), \
            patch.object(ms, "ws_alias", _online("tok-a", "tok-b")), patch.object(ms, "deliver_task", AsyncMock(return_value=True)):
        assert await ms.step_mission(db, mission) is True
    result = next(s for s in mission.steps if s["type"] == "device_task_result")
    assert result["output_preview"].endswith("全部通过") and len(result["output_preview"]) == ms.AGENT_OUTPUT_PREVIEW
    nxt = db.add.call_args.args[0]
    # Same session, on the device it is on (no device named)
    assert nxt.payload["session_id"] == "sess-9" and nxt.device_id == "tok-b" and "session_home" not in nxt.payload


@pytest.mark.asyncio
async def test_an_agent_step_on_another_device_fetches_the_session_from_where_it_is():
    user = _user()
    laptop = _machine(user, "laptop", "tok-a")
    mini = _machine(user, "mac-mini", "tok-b")
    mission = _mission(user, {"agent_session_id": "sess-9", "agent_machine_id": str(mini.id)})
    db = _db(_result(all_items=[laptop, mini]))
    with patch.object(ms, "ws_alias", _online("tok-a", "tok-b")), patch.object(ms, "deliver_task", AsyncMock(return_value=True)):
        await ms._dispatch_agent(db, mission, user, "继续", None, "", "laptop")
    task = db.add.call_args.args[0]
    assert task.device_id == "tok-a" and task.payload["session_id"] == "sess-9" and task.payload["session_home"] == str(mini.id)


@pytest.mark.asyncio
async def test_an_agent_step_waits_for_approval_when_auto_approve_is_off():
    user = _user({"auto_approve_safe": False})
    mission = _mission(user)
    notify = AsyncMock()
    with patch.object(ms, "call_plain_chat", AsyncMock(return_value='{"action": "run_agent", "prompt": "重构登录"}')), \
            patch.object(ms, "notify_user", notify), patch.object(ms, "_dispatch_agent", AsyncMock()) as dispatch:
        assert await ms.step_mission(_db(_result(one=user)), mission) is True
    dispatch.assert_not_awaited()
    assert mission.status == "waiting_approval" and mission.pending_action["action"] == "run_agent"
    assert mission.steps[-1]["prompt"] == "重构登录"
    db = _db(_result(one=mission), _result(one=user))
    with patch.object(ms, "_dispatch_agent", AsyncMock(return_value=True)) as dispatch:
        assert await ms.approve_mission(db, mission.id, mission.approval_token, None) is True
    dispatch.assert_awaited_once()
    assert dispatch.await_args.args[3] == "重构登录"


@pytest.mark.asyncio
async def test_a_device_reporting_the_task_steps_its_mission_right_away():
    user = _user()
    task = DeviceTask(id=uuid.uuid4(), status="succeeded", payload={"mission_id": ""})
    mission = _mission(user, {"active_device_task_id": str(task.id)})
    task.payload = {"mission_id": str(mission.id)}

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def factory():
        yield _db(_result(one=task), _result(one=mission))

    with patch("server.db.session.async_session_factory", factory), \
            patch.object(ms, "step_mission_locked", AsyncMock(return_value=True)) as step:
        await ms.wake_for_task(str(task.id))
        step.assert_awaited_once()
        # Another task (or one no mission waits on) wakes nothing
        mission.context = {"active_device_task_id": str(uuid.uuid4())}
        await ms.wake_for_task(str(task.id))
        step.assert_awaited_once()


@pytest.mark.asyncio
async def test_steps_of_one_mission_never_overlap():
    user = _user()
    mission = _mission(user)
    lock = MagicMock()
    lock.release = AsyncMock()
    with patch.object(ms.cluster, "mutex", AsyncMock(side_effect=[None, lock])), \
            patch.object(ms, "step_mission", AsyncMock(return_value=True)) as step:
        assert await ms.step_mission_locked(_db(), mission) is False
        step.assert_not_awaited()
        assert await ms.step_mission_locked(_db(), mission) is True
    step.assert_awaited_once()
    lock.release.assert_awaited_once()
