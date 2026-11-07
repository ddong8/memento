"""A task row is sent to its device right away: running when the device has it, failed with the reason when not."""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from server.api import tasks as tasks_api
from server.db.models import DeviceTask, Machine, User
from server.services import device_dispatch as dd


def _db():
    db = MagicMock()
    db.execute = AsyncMock()
    db.commit = AsyncMock()
    db.refresh = AsyncMock()
    db.add = MagicMock()
    return db


def _task(device_id="tok-a"):
    return DeviceTask(id=uuid.uuid4(), device_id=device_id, action="shell", payload={"command": "ls"}, timeout_seconds=60, status="queued")


def _values(db):
    """The parameters of the conditional update: the values written, and status_1 for the row it may change."""
    return db.execute.await_args.args[0].compile().params


def _ws(connected=(), send_ok=True):
    ws = MagicMock()
    ws.has_device.side_effect = lambda alias: alias in connected
    ws.send_task = AsyncMock(return_value=send_ok)
    return patch.object(dd, "ws_manager", ws), ws


def test_any_alias_the_device_registered_under_is_found():
    m = Machine(id=uuid.uuid4(), name="mac-mini (Darwin)", collector_token_hash="tok-a")
    p, _ = _ws(connected={"mac-mini"})
    with p:
        assert dd.ws_alias("tok-a", m) == "mac-mini"
        assert dd.ws_alias("tok-a") is None


@pytest.mark.asyncio
async def test_a_connected_device_gets_the_task_and_it_is_running():
    db, task = _db(), _task()
    p, ws = _ws(connected={"tok-a"})
    with p:
        assert await dd.deliver_task(db, task) is True
    sent = ws.send_task.await_args.args
    assert sent == ("tok-a", {"id": str(task.id), "action": "shell", "payload": {"command": "ls"}, "timeout_seconds": 60})
    values = _values(db)
    assert values["status"] == "running" and values["dispatched_at"]
    # Only a still-queued row moves: a quick task_finished is not overwritten.
    assert values["status_1"] == "queued"
    db.commit.assert_awaited_once()
    db.refresh.assert_awaited_once_with(task)


@pytest.mark.asyncio
async def test_an_offline_device_fails_the_task_at_once():
    db, task = _db(), _task()
    p, ws = _ws()
    with p:
        assert await dd.deliver_task(db, task) is False
    ws.send_task.assert_not_awaited()
    values = _values(db)
    assert values["status"] == "failed" and values["error"] == dd.OFFLINE_ERROR and values["finished_at"]


@pytest.mark.asyncio
async def test_a_send_that_fails_says_the_connection_just_dropped():
    db, task = _db(), _task()
    p, _ = _ws(connected={"tok-a"}, send_ok=False)
    with p:
        assert await dd.deliver_task(db, task) is False
    assert _values(db)["error"] == dd.SEND_FAILED_ERROR


@pytest.mark.asyncio
async def test_dispatch_endpoint_sends_the_task_it_creates():
    db = _db()
    user = User(id=uuid.uuid4(), email="u@example.com", role="admin")
    machine = Machine(id=uuid.uuid4(), name="laptop", collector_token_hash="tok-a")
    deliver = AsyncMock(return_value=True)
    with patch.object(tasks_api, "REMOTE_EXEC_ENABLED", True), \
            patch.object(tasks_api, "_authorize_device", AsyncMock(return_value=machine)), \
            patch.object(tasks_api, "deliver_task", deliver):
        out = await tasks_api.create_task("laptop", tasks_api.CreateTask(action="shell", payload={"command": "ls"}), db, user)
    task = db.add.call_args.args[0]
    assert task.device_id == "tok-a" and task.machine_id == machine.id
    deliver.assert_awaited_once_with(db, task, machine)
    assert out["id"] == str(task.id)


@pytest.mark.asyncio
async def test_dispatch_endpoint_refuses_actions_the_device_would_run_as_an_agent():
    db = _db()
    user = User(id=uuid.uuid4(), email="u@example.com", role="admin")
    with patch.object(tasks_api, "REMOTE_EXEC_ENABLED", True):
        for action in ("resync", "update", "rediscover"):
            with pytest.raises(HTTPException) as e:
                await tasks_api.create_task("laptop", tasks_api.CreateTask(action=action), db, user)
            assert e.value.status_code == 400
    db.add.assert_not_called()
