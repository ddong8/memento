"""An agent task the orchestrator could not send fails right away; a device restarting gets a few seconds to come back."""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from server.db.models import DeviceTask, Machine
from server.services import orchestrator as orch
from server.services.device_dispatch import OFFLINE_ERROR


def _machine(seen_ago: float | None):
    beat = None if seen_ago is None else datetime.now(timezone.utc) - timedelta(seconds=seen_ago)
    return Machine(id=uuid.uuid4(), name="vps3 (Linux)", collector_token_hash="tok-v", last_heartbeat=beat)


@pytest.mark.asyncio
async def test_a_device_reconnecting_after_a_restart_is_waited_for():
    calls = {"n": 0}

    def has_device(alias):
        calls["n"] += 1
        return alias == "tok-v" and calls["n"] > 6

    ws = MagicMock()
    ws.has_device.side_effect = has_device
    with patch.object(orch, "ws_manager", ws), patch.object(orch.asyncio, "sleep", AsyncMock()):
        assert await orch._wait_device_alias(["tok-v", "vps3"], _machine(5)) == "tok-v"


@pytest.mark.asyncio
async def test_a_device_offline_for_long_is_not_waited_for():
    ws = MagicMock()
    ws.has_device.return_value = False
    sleep = AsyncMock()
    with patch.object(orch, "ws_manager", ws), patch.object(orch.asyncio, "sleep", sleep):
        assert await orch._wait_device_alias(["tok-v"], _machine(3600)) is None
        assert await orch._wait_device_alias(["tok-v"], None) is None
    sleep.assert_not_awaited()


@pytest.mark.asyncio
async def test_an_undelivered_task_fails_only_from_queued():
    db = MagicMock()
    db.execute, db.commit, db.refresh = AsyncMock(), AsyncMock(), AsyncMock()
    task = DeviceTask(id=uuid.uuid4(), device_id="tok-v", action="agent", payload={}, timeout_seconds=60, status="queued")
    await orch._fail_undelivered(db, task, OFFLINE_ERROR)
    params = db.execute.await_args.args[0].compile().params
    assert params["status"] == "failed" and params["error"] == OFFLINE_ERROR and params["finished_at"]
    assert params["status_1"] == "queued"
    db.commit.assert_awaited_once()
    db.refresh.assert_awaited_once_with(task)
