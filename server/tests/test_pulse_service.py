"""The proactive pulse: device offline alerts once per outage, quiet hours, and one user's error not stopping the rest."""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from server.db.models import Machine, User
from server.services import pulse_service as ps

NOW = datetime(2026, 11, 8, 6, 0, tzinfo=timezone.utc)  # 14:00 at UTC+8, outside quiet hours


class _Store:
    """ai_health's get_json / put_json over a dict."""

    def __init__(self):
        self.data = {}

    async def get_json(self, key):
        return self.data.get(key)

    async def put_json(self, key, value, ttl_seconds=None):
        self.data[key] = value


def _machine(name, token, minutes_ago):
    return Machine(
        id=uuid.uuid4(), user_id=uuid.uuid4(), name=name, collector_token_hash=token,
        last_heartbeat=NOW - timedelta(minutes=minutes_ago),
    )


def _db(*machine_lists):
    db = MagicMock()
    results = []
    for machines in machine_lists:
        r = MagicMock()
        r.scalars.return_value.all.return_value = machines
        results.append(r)
    db.execute = AsyncMock(side_effect=results)
    db.rollback = AsyncMock()
    return db


def _patches(store, notify, connected=()):
    return (
        patch.object(ps, "ai_health", store),
        patch.object(ps, "notify_user", notify),
        patch.object(ps, "ws_alias", lambda device_id, machine=None: device_id if device_id in connected else None),
    )


@pytest.mark.asyncio
async def test_an_outage_is_alerted_once_and_the_next_outage_again():
    user = User(id=uuid.uuid4())
    store, notify = _Store(), AsyncMock()
    m = _machine("laptop", "tok-a", minutes_ago=6)
    p1, p2, p3 = _patches(store, notify)
    with p1, p2, p3:
        await ps._check_device_alerts(_db([m]), user, NOW)
        # Still down a few minutes later, same outage: no second push.
        await ps._check_device_alerts(_db([m]), user, NOW + timedelta(minutes=4))
        assert notify.await_count == 1
        # Back for a while, then down again: a new outage.
        m.last_heartbeat = NOW + timedelta(hours=2)
        await ps._check_device_alerts(_db([m]), user, NOW + timedelta(hours=2, minutes=7))
    assert notify.await_count == 2
    assert "laptop" in notify.await_args.kwargs["body"]


@pytest.mark.asyncio
async def test_connected_or_long_gone_devices_get_no_alert():
    user = User(id=uuid.uuid4())
    store, notify = _Store(), AsyncMock()
    machines = [
        _machine("late-heartbeat", "tok-connected", minutes_ago=8),  # connected, only the write is late
        _machine("fresh", "tok-b", minutes_ago=2),
        _machine("gone-for-days", "tok-c", minutes_ago=60 * 24 * 3),
    ]
    p1, p2, p3 = _patches(store, notify, connected={"tok-connected"})
    with p1, p2, p3:
        await ps._check_device_alerts(_db(machines), user, NOW)
    notify.assert_not_awaited()


@pytest.mark.asyncio
async def test_alerts_and_briefs_only_look_at_active_devices():
    db = _db([])
    await ps._active_machines(db, User(id=uuid.uuid4()))
    query = str(db.execute.await_args.args[0])
    assert "merged_into IS NULL" in query and "is_archived IS NOT" in query


def test_online_means_connected_or_heard_from_in_three_minutes():
    connected, recent, stale = (_machine("a", "tok-a", 30), _machine("b", "tok-b", 2), _machine("c", "tok-c", 4))
    with patch.object(ps, "ws_alias", lambda device_id, machine=None: device_id if device_id == "tok-a" else None):
        assert [ps._is_online(m, NOW) for m in (connected, recent, stale)] == [True, True, False]


@pytest.mark.asyncio
async def test_missions_step_in_quiet_hours_but_nothing_is_pushed():
    user = User(id=uuid.uuid4(), proactive_settings={"quiet_hours_start": "13:00", "quiet_hours_end": "15:00"})
    with patch.object(ps, "_advance_user_missions", AsyncMock()) as missions, \
            patch.object(ps, "_check_device_alerts", AsyncMock()) as alerts, \
            patch.object(ps, "_send_morning_brief", AsyncMock()) as brief:
        await ps._pulse_user(MagicMock(), user, NOW)
    missions.assert_awaited_once()
    alerts.assert_not_awaited()
    brief.assert_not_awaited()


@pytest.mark.asyncio
async def test_the_morning_brief_is_sent_once_a_day():
    user = User(id=uuid.uuid4(), proactive_settings={"device_alert_enabled": False})
    morning = datetime(2026, 11, 8, 1, 0, tzinfo=timezone.utc)  # 09:00 at UTC+8
    store = _Store()
    with patch.object(ps, "ai_health", store), patch.object(ps, "_advance_user_missions", AsyncMock()), \
            patch.object(ps, "_send_morning_brief", AsyncMock()) as brief:
        await ps._pulse_user(MagicMock(), user, morning)
        await ps._pulse_user(MagicMock(), user, morning + timedelta(minutes=1))
    brief.assert_awaited_once()
    assert f"proactive:morning:{user.id}:2026-11-08" in store.data


@pytest.mark.asyncio
async def test_an_empty_model_reply_sends_no_brief():
    user = User(id=uuid.uuid4())
    todos = MagicMock()
    todos.scalars.return_value.all.return_value = []
    db = MagicMock()
    db.execute = AsyncMock(return_value=todos)
    notify = AsyncMock()
    with patch.object(ps, "call_plain_chat", AsyncMock(return_value=None)), patch.object(ps, "notify_user", notify), \
            patch.object(ps, "_active_machines", AsyncMock(return_value=[])):
        await ps._send_morning_brief(db, user, NOW)
    notify.assert_not_awaited()


@pytest.mark.asyncio
async def test_one_users_error_does_not_stop_the_others():
    users = [User(id=uuid.uuid4()), User(id=uuid.uuid4())]
    listing = MagicMock()
    listing.scalars.return_value.all.return_value = users
    db = MagicMock()
    db.execute = AsyncMock(return_value=listing)
    db.rollback = AsyncMock()
    seen = []

    async def pulse_user(_db, user, _now):
        seen.append(user.id)
        if user is users[0]:
            raise RuntimeError("database hiccup")

    with patch.object(ps, "_pulse_user", pulse_user):
        await ps._execute_pulse_cycle(db)
    assert seen == [u.id for u in users]
    db.rollback.assert_awaited_once()
