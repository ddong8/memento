"""Code on one device, agent on another: the server relays the code and the changes between the two."""

import asyncio
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from server.db.models import Machine
from server.services import workspace_relay as wr
from server.services.ws_manager import DeviceConnectionManager

USER = uuid.uuid4()


def _machine(user_id=USER, archived=False, token="tok-mac"):
    m = Machine(id=uuid.uuid4(), name="Mac", collector_token_hash=token, user_id=user_id)
    m.is_archived = archived
    return m


@asynccontextmanager
async def _session():
    yield MagicMock()


def _env(machine, online=True, answer=None, chunk=b"bundle-bytes"):
    ws = MagicMock()
    ws.is_online.side_effect = lambda dev: online
    ws.request_device = AsyncMock(return_value=answer or {})
    ws.request_file_chunk = AsyncMock(return_value=chunk)
    ws.send_json = AsyncMock(return_value=True)
    cl = MagicMock()
    cl.redis = None
    return [
        patch.object(wr, "async_session_factory", _session),
        patch.object(wr, "find_machine_by_id_or_hash", AsyncMock(return_value=machine)),
        patch.object(wr, "ws_manager", ws),
        patch.object(wr, "cluster", cl),
    ], ws


async def _run(patches, coro_fn):
    for p in patches:
        p.start()
    try:
        return await coro_fn()
    finally:
        for p in patches:
            p.stop()


@pytest.mark.asyncio
async def test_export_hands_out_a_token_for_the_bundle_and_chunks_read_it_from_the_source():
    answer = {"bundle_path": "/Users/me/.memento/workspace-out/a.bundle", "size": 12, "head": "h", "branch": "main",
              "snapshot": "s", "tree": "t", "root": "/Users/me/repo", "rel": "", "up_to_date": False}
    patches, ws = _env(_machine(), answer=answer)

    async def go():
        out = await wr._export({"source_device_id": "mac", "path": "/Users/me/repo", "have": ["abc", 3]}, USER)
        sent = ws.request_device.await_args.args
        assert sent[0] == "tok-mac"
        assert sent[1] == {"type": "workspace_export_req", "path": "/Users/me/repo", "have": ["abc"]}
        assert out["token"] and out["branch"] == "main" and "bundle_path" not in out
        chunk = await wr._chunk({"token": out["token"], "offset": 0, "length": 999}, USER)
        # Never past the bundle's end, from the device and path the token stands for
        assert ws.request_file_chunk.await_args.args[:4] == ("tok-mac", answer["bundle_path"], 0, 12)
        assert chunk["bytes_read"] == len(b"bundle-bytes")
        # Another account can't use the token, and past the end is empty
        assert (await wr._chunk({"token": out["token"], "offset": 0}, uuid.uuid4()))["code"] == "expired"
        assert (await wr._chunk({"token": out["token"], "offset": 12}, USER)) == {"data_b64": "", "bytes_read": 0}

    await _run(patches, go)


@pytest.mark.asyncio
async def test_an_up_to_date_clone_gets_no_token():
    patches, _ = _env(_machine(), answer={"up_to_date": True, "snapshot": "s", "size": 0})
    out = await _run(patches, lambda: wr._export({"source_device_id": "mac", "path": "/r"}, USER))
    assert out["up_to_date"] is True and "token" not in out


@pytest.mark.asyncio
@pytest.mark.parametrize("machine,online,why", [
    (None, True, "找不到"),
    ("other-user", True, "不属于"),
    ("archived", True, "解除关联"),
    ("ok", False, "不在线"),
])
async def test_only_an_online_device_of_the_same_account_is_reached(machine, online, why):
    m = None if machine is None else _machine(user_id=uuid.uuid4()) if machine == "other-user" else _machine(archived=machine == "archived")
    patches, ws = _env(m, online=online)
    out = await _run(patches, lambda: wr._export({"source_device_id": "mac", "path": "/r"}, USER))
    assert out["code"] == "source_unavailable" and why in out["error"]
    ws.request_device.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_passes_the_patch_on_and_returns_what_the_source_did():
    patches, ws = _env(_machine(), answer={"applied": False, "conflict": True, "branch": "memento/abcd1234",
                                           "files": [{"status": "M", "path": "a.txt"}], "patch_path": "/r/.git/p", "detail": "x"})

    async def go():
        out = await wr._apply({"source_device_id": "mac", "path": "/r", "task_id": "t", "base_tree": "bt",
                               "mode": "weird", "patch_b64": "UEFUQ0g=", "files": [{"path": "a.txt"}]}, USER)
        payload = ws.request_device.await_args.args[1]
        assert payload["type"] == "workspace_apply_req" and payload["mode"] == "apply" and payload["base_tree"] == "bt"
        assert out == {"applied": False, "conflict": True, "branch": "memento/abcd1234",
                       "files": [{"status": "M", "path": "a.txt"}], "patch_path": "/r/.git/p", "detail": "x"}
        assert (await wr._apply({"source_device_id": "mac", "patch_b64": "x" * (wr.PATCH_MAX + 1)}, USER))["code"] == "too_big"
        assert "空" in (await wr._apply({"source_device_id": "mac", "patch_b64": ""}, USER))["error"]

    await _run(patches, go)


@pytest.mark.asyncio
async def test_apply_carries_the_agents_commits_and_the_push_with_a_longer_wait():
    pushed = {"status": "pushed", "remote": "origin", "branch": "main", "rebased": 2}
    patches, ws = _env(_machine(), answer={
        "applied": True, "files": [], "patch_path": "/r/.git/p", "committed": "branch",
        "commits": [{"sha": "c" * 40, "subject": "feat: x"}], "push": pushed, "ignored": 1,
    })
    commits = {"bundle_b64": "QlVORExF", "head": "c" * 40, "base_head": "b" * 40, "branch": "main", "push": True, "extra": 1}

    async def go():
        out = await wr._apply({"source_device_id": "mac", "path": "/r", "task_id": "t", "patch_b64": "UEFUQ0g=", "commits": commits}, USER)
        payload, timeout = ws.request_device.await_args.args[1:3]
        assert payload["commits"] == {k: v for k, v in commits.items() if k != "extra"}
        assert timeout == wr.PUSH_TIMEOUT
        assert out == {"applied": True, "files": [], "patch_path": "/r/.git/p", "committed": "branch",
                       "commits": [{"sha": "c" * 40, "subject": "feat: x"}], "push": pushed}
        await wr._apply({"source_device_id": "mac", "patch_b64": "UEFUQ0g=", "commits": {**commits, "push": False}}, USER)
        assert ws.request_device.await_args.args[2] == wr.APPLY_TIMEOUT
        await wr._apply({"source_device_id": "mac", "patch_b64": "UEFUQ0g="}, USER)
        assert "commits" not in ws.request_device.await_args.args[1]
        big = {**commits, "bundle_b64": "x" * wr.CARRY_MAX}
        assert (await wr._apply({"source_device_id": "mac", "patch_b64": "UEFUQ0g=", "commits": big}, USER))["code"] == "too_big"

    await _run(patches, go)


@pytest.mark.asyncio
async def test_the_executor_always_gets_a_reply_even_when_the_relay_blows_up():
    patches, ws = _env(_machine())

    async def go():
        with patch.object(wr, "_export", AsyncMock(side_effect=RuntimeError("boom"))), \
                patch.dict(wr._OPS, {"export": wr._export}):
            await wr.handle({"req_id": "r1", "op": "export"}, "tok-vps", USER)
        reply = ws.send_json.await_args.args
        assert reply[0] == "tok-vps" and reply[1]["type"] == "ws_relay_reply" and reply[1]["req_id"] == "r1"
        assert "boom" in reply[1]["error"]
        await wr.handle({"req_id": "r2", "op": "nope"}, "tok-vps", USER)
        assert "unknown op" in ws.send_json.await_args.args[1]["error"]

    await _run(patches, go)


@pytest.mark.asyncio
async def test_request_device_waits_for_the_answer_with_the_same_req_id():
    mgr = DeviceConnectionManager()
    sent: list[dict] = []

    async def fake_send(device_id, payload):
        sent.append(payload)
        asyncio.get_running_loop().call_soon(mgr.handle_file_response, {"req_id": payload["req_id"], "ok": 1})
        return True

    mgr._connections["tok-mac"] = MagicMock()
    with patch.object(mgr, "_send_json_local", fake_send):
        res = await mgr.request_device("tok-mac", {"type": "workspace_export_req", "path": "/r"}, timeout=2)
    assert res["ok"] == 1 and sent[0]["type"] == "workspace_export_req"
    assert mgr._pending_file_requests == {}

    async def silent(device_id, payload):
        return True

    with patch.object(mgr, "_send_json_local", silent):
        res = await mgr.request_device("tok-mac", {"type": "workspace_export_req"}, timeout=0.05)
    assert res["code"] == "timeout"
    mgr._connections.clear()
    with patch.object(mgr, "_owner", AsyncMock(return_value=None)):
        assert (await mgr.request_device("tok-mac", {"type": "x"}))["code"] == "offline"


@pytest.mark.parametrize("caps,ok", [
    ({"environment": {"features": ["workspace_sync"]}}, True),
    ({"environment": {"features": []}}, False),  # a client from before 1.0.105
    ({"claude": {}}, False),
    (None, False),  # never reported (offline)
])
def test_both_ends_must_have_reported_workspace_sync(caps, ok):
    from server.services import orchestrator
    with patch("server.services.device_reports.get_cached_device_capabilities", return_value=caps):
        assert orchestrator._supports_workspace(["tok-mac"], None) is ok
    assert orchestrator._supports_workspace([None, ""], None) is False


@pytest.mark.asyncio
async def test_a_session_on_another_device_is_handed_out_like_a_bundle():
    answer = {"path": "/Users/me/.claude/projects/-Users-me-repo/s1.jsonl", "size": 20, "last_uuid": "u-9"}
    patches, ws = _env(_machine(), answer=answer, chunk=b'{"uuid":"u-9"}')

    async def go():
        out = await wr._session({"source_device_id": "mac", "session_id": "s1"}, USER)
        assert ws.request_device.await_args.args[:2] == ("tok-mac", {"type": "session_export_req", "session_id": "s1"})
        assert out["size"] == 20 and out["last_uuid"] == "u-9" and out["token"] and "path" not in out
        await wr._chunk({"token": out["token"], "offset": 0, "length": 999}, USER)
        assert ws.request_file_chunk.await_args.args[:4] == ("tok-mac", answer["path"], 0, 20)

    await _run(patches, go)


@pytest.mark.asyncio
async def test_a_session_the_source_lacks_or_an_offline_source_says_why():
    patches, _ = _env(_machine(), answer={"error": "这台设备上没有会话 s1", "code": "not_found"})
    out = await _run(patches, lambda: wr._session({"source_device_id": "mac", "session_id": "s1"}, USER))
    assert out == {"error": "这台设备上没有会话 s1", "code": "not_found"}
    patches, _ = _env(_machine(), online=False)
    out = await _run(patches, lambda: wr._session({"source_device_id": "mac", "session_id": "s1"}, USER))
    assert out["code"] == "source_unavailable"


@pytest.mark.asyncio
async def test_the_executor_can_pull_the_bundle_directly_with_the_sources_answer():
    answer = {"bundle_path": "/Users/me/.memento/workspace-out/a.bundle", "size": 12, "up_to_date": False}
    patches, ws = _env(_machine(), answer=answer)
    ws.request_p2p_answer = AsyncMock(return_value={"sdp": "v=0 answer"})

    async def go():
        out = await wr._export({"source_device_id": "mac", "path": "/Users/me/repo"}, USER)
        assert isinstance(out["ice_servers"], list)
        got = await wr._p2p({"token": out["token"], "sdp": "v=0 offer"}, USER)
        assert ws.request_p2p_answer.await_args.args[:2] == ("tok-mac", "v=0 offer")
        # The path on the source only comes from the token, never from the executor
        assert got == {"sdp": "v=0 answer", "path": answer["bundle_path"]}
        assert (await wr._p2p({"token": out["token"], "sdp": "x"}, uuid.uuid4()))["code"] == "expired"
        ws.request_p2p_answer.return_value = {"error": "direct transfer is not available on this device"}
        assert (await wr._p2p({"token": out["token"], "sdp": "x"}, USER))["code"] == "no_direct"

    await _run(patches, go)


@pytest.mark.asyncio
async def test_an_agents_command_runs_on_the_source_and_its_result_comes_back():
    answer = {"exit_code": 1, "stdout": "2 failed", "stderr": "", "seconds": 4.2}
    patches, ws = _env(_machine(), answer=answer)
    patches.append(patch.object(wr, "device_has_feature", lambda name, feature, user=None: feature == "source_exec"))

    async def go():
        out = await wr._exec({"source_device_id": "mac", "path": "/Users/me/repo", "snapshot": "s" * 40, "rel": "app",
                              "patch_b64": "cGF0Y2g=", "command": "npm test", "timeout_ms": 99 * 60 * 1000}, USER)
        sent, timeout = ws.request_device.await_args.args[1], ws.request_device.await_args.args[2]
        assert sent["type"] == "workspace_exec_req" and sent["command"] == "npm test" and sent["rel"] == "app"
        # Never longer than the cap, plus time to carry the output back
        assert sent["timeout_ms"] == wr.EXEC_MAX_MS and timeout == wr.EXEC_MAX_MS / 1000 + wr.EXEC_SLACK
        assert out == answer

    await _run(patches, go)


@pytest.mark.asyncio
async def test_a_risky_command_or_an_old_source_is_refused_without_asking_it():
    patches, ws = _env(_machine())
    patches.append(patch.object(wr, "device_has_feature", lambda *a, **k: False))

    async def go():
        out = await wr._exec({"source_device_id": "mac", "command": "rm -rf ~"}, USER)
        assert out["code"] == "refused"
        out = await wr._exec({"source_device_id": "mac", "command": "npm test"}, USER)
        assert out["code"] == "source_unavailable" and "版本太旧" in out["error"]
        ws.request_device.assert_not_awaited()

    await _run(patches, go)
