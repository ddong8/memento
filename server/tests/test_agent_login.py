"""Signing a device's agent CLIs in from the devices page (POST /api/devices/{id}/agent-login)."""

import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from server.api import devices


@pytest.fixture
def machine(monkeypatch):
    m = SimpleNamespace(id=uuid.uuid4(), name="vps3 (Linux)", collector_token_hash="tok-vps3", user_id=uuid.uuid4())

    async def owned(_db, _id, _user):
        return m

    monkeypatch.setattr(devices, "_verify_device_ownership", owned)
    monkeypatch.setattr(devices.ws_manager, "has_device", lambda d: d == "tok-vps3")
    monkeypatch.setattr(devices, "_has_feature", lambda name, feature, user: True)
    return m


async def _call(body):
    return await devices.agent_login(uuid.uuid4(), devices.AgentLoginBody(**body), db=None, _user=SimpleNamespace(role="user"))


@pytest.mark.asyncio
async def test_forwards_to_the_device_and_strips_envelope(machine, monkeypatch):
    sent = {}

    async def request_device(device_id, payload, timeout=30.0):
        sent.update(device=device_id, payload=payload, timeout=timeout)
        return {"type": "agent_login_resp", "req_id": "r1", "agent": "codex", "state": "waiting", "url": "https://auth.openai.com/codex/device", "user_code": "ABCD-12345"}

    monkeypatch.setattr(devices.ws_manager, "request_device", request_device)
    res = await _call({"action": "start", "agent": "codex"})
    assert sent["device"] == "tok-vps3"
    assert sent["payload"] == {"type": "agent_login_req", "action": "start", "agent": "codex", "code": ""}
    assert res == {"agent": "codex", "state": "waiting", "url": "https://auth.openai.com/codex/device", "user_code": "ABCD-12345"}


@pytest.mark.parametrize("body", [
    {"action": "rm -rf", "agent": "codex"},
    {"action": "start", "agent": "bash"},
    {"action": "start", "agent": ""},
    {"action": "submit", "agent": "claude", "code": "x" * 5000},
])
@pytest.mark.asyncio
async def test_rejects_bad_requests(machine, body):
    with pytest.raises(HTTPException) as e:
        await _call(body)
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_offline_and_old_clients(machine, monkeypatch):
    monkeypatch.setattr(devices.ws_manager, "has_device", lambda d: False)
    with pytest.raises(HTTPException) as e:
        await _call({"action": "status"})
    assert e.value.status_code == 409

    monkeypatch.setattr(devices.ws_manager, "has_device", lambda d: True)
    monkeypatch.setattr(devices, "_has_feature", lambda name, feature, user: False)
    with pytest.raises(HTTPException) as e:
        await _call({"action": "status"})
    assert e.value.status_code == 409 and "1.0.106" in e.value.detail


@pytest.mark.asyncio
async def test_device_timeout_is_a_504(machine, monkeypatch):
    async def request_device(device_id, payload, timeout=30.0):
        return {"error": "设备 30 秒没有回应", "code": "timeout"}

    monkeypatch.setattr(devices.ws_manager, "request_device", request_device)
    with pytest.raises(HTTPException) as e:
        await _call({"action": "start", "agent": "claude"})
    assert e.value.status_code == 504


def test_has_feature_reads_the_reported_environment(monkeypatch):
    from server.services import device_reports
    monkeypatch.setattr(device_reports, "get_cached_device_capabilities",
                        lambda name, user=None: {"environment": {"features": ["workspace_sync", "agent_login"]}} if name == "a" else {"environment": {"features": []}})
    assert devices._has_feature("a", "agent_login", None) is True
    assert devices._has_feature("b", "agent_login", None) is False
    assert devices._has_feature(None, "agent_login", None) is False
