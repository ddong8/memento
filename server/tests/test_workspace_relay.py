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
        # The device may fetch it straight from the source over WebRTC first
        assert isinstance(out["ice_servers"], list)
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
async def test_a_stopped_tasks_commands_are_stopped_on_the_source():
    patches, ws = _env(_machine())
    ws.send_json = AsyncMock(return_value=True)

    async def go():
        out = await wr._exec({"source_device_id": "mac", "command": "npm test", "task_id": "t1", "exec_id": "e1"}, USER)
        sent = ws.request_device.await_args.args[1]
        # The source knows which task and command it runs, to stop them later
        assert sent["task_id"] == "t1" and sent["exec_id"] == "e1"
        out = await wr._exec_cancel({"source_device_id": "mac", "task_id": "t1"}, USER)
        assert out == {"sent": True}
        assert ws.send_json.await_args.args[1] == {"type": "workspace_exec_cancel", "task_id": "t1", "exec_id": ""}
        assert (await wr._exec_cancel({"source_device_id": "mac"}, USER))["error"]
        assert "exec_cancel" in wr._OPS

    patches.append(patch.object(wr, "device_has_feature", lambda *a, **k: True))
    await _run(patches, go)


@pytest.mark.asyncio
async def test_a_risky_command_or_an_old_source_is_refused_without_asking_it():
    patches, ws = _env(_machine())
    patches += [patch.object(wr, "device_has_feature", lambda *a, **k: False),
                patch.object(wr.settings, "remote_exec_policy", "catastrophic")]

    async def go():
        out = await wr._exec({"source_device_id": "mac", "command": "rm -rf ~"}, USER)
        assert out["code"] == "refused"
        out = await wr._exec({"source_device_id": "mac", "command": "npm test"}, USER)
        assert out["code"] == "source_unavailable" and "版本太旧" in out["error"]
        ws.request_device.assert_not_awaited()

    await _run(patches, go)


@pytest.mark.asyncio
async def test_the_agents_commit_is_made_on_the_source_and_an_old_source_is_told_to_upgrade():
    # 11-17: the executor only edits; the commit is a real git commit on the device the code is on
    answer = {"exit_code": 0, "stdout": "", "stderr": "lint ok", "sha": "c" * 40, "subject": "fix: x", "files": ["a.py"], "seconds": 3.1}
    patches, ws = _env(_machine(), answer=answer)
    patches.append(patch.object(wr, "device_has_feature", lambda name, feature, user=None: feature == "source_commit"))

    async def go():
        out = await wr._commit({"source_device_id": "mac", "path": "/Users/me/repo", "task_id": "t1", "snapshot": "s" * 40,
                                "base_tree": "b" * 40, "base_head": "h" * 40, "parent": "h" * 40, "patch_b64": "cA==",
                                "message": "fix: x", "paths": ["a.py", 3]}, USER)
        sent, timeout = ws.request_device.await_args.args[1], ws.request_device.await_args.args[2]
        assert sent["type"] == "workspace_commit_req" and sent["message"] == "fix: x" and sent["paths"] == ["a.py"]
        assert sent["parent"] == "h" * 40 and timeout == wr.COMMIT_TIMEOUT
        assert out == answer

    await _run(patches, go)

    patches, ws = _env(_machine())
    patches.append(patch.object(wr, "device_has_feature", lambda name, feature, user=None: feature == "source_exec"))

    async def old():
        out = await wr._commit({"source_device_id": "mac", "message": "x"}, USER)
        assert out["code"] == "source_unavailable" and "1.0.138" in out["error"]
        assert (await wr._commit({"source_device_id": "mac", "message": " "}, USER))["error"] == "提交说明是空的"
        ws.request_device.assert_not_awaited()

    await _run(patches, old)


@pytest.mark.asyncio
async def test_a_file_comes_back_from_the_source_and_commits_made_there_go_on_to_apply():
    patches, ws = _env(_machine(), answer={"data_b64": "cG5n", "size": 3, "path": "/w/shot.png"})
    patches.append(patch.object(wr, "device_has_feature", lambda name, feature, user=None: True))

    async def go():
        out = await wr._get({"source_device_id": "mac", "path": "/w", "file": "shot.png", "rel": "app"}, USER)
        assert ws.request_device.await_args.args[1]["type"] == "workspace_get_req"
        assert out == {"data_b64": "cG5n", "size": 3, "path": "/w/shot.png"}

    await _run(patches, go)
    c = wr._commits({"bundle_b64": "", "head": "c" * 40, "base_head": "h" * 40, "branch": "main", "push": True, "on_source": True})
    assert c["on_source"] is True and c["push"] is True
    assert "on_source" not in wr._commits({"head": "c" * 40})


@pytest.mark.asyncio
async def test_a_file_outside_the_project_is_written_on_the_source_and_a_sensitive_one_tells_the_phone():
    patches, ws = _env(_machine(), answer={"path": "/Users/me/other/conf.yaml", "size": 3, "backup": "/b/x"})
    told = []

    async def tell(*a):
        told.append(a)

    patches += [patch.object(wr, "device_has_feature", lambda name, feature, user=None: feature == "source_put"),
                patch.object(wr, "_tell_risky", tell),
                patch.object(wr.notify_service, "spawn", lambda coro: asyncio.ensure_future(coro))]

    async def go():
        out = await wr._put({"source_device_id": "mac", "path": "/Users/me/repo", "dest": "/Users/me/other/conf.yaml", "data_b64": "eHl6"}, USER)
        sent = ws.request_device.await_args.args[1]
        assert sent["type"] == "workspace_put_req" and sent["dest"] == "/Users/me/other/conf.yaml" and sent["data_b64"] == "eHl6"
        assert out == {"path": "/Users/me/other/conf.yaml", "size": 3, "backup": "/b/x"}
        await asyncio.sleep(0)
        assert told == []
        # 11-19: written (the old file backed up there) and the phone told, instead of refused
        for sensitive in ("/Users/me/.ssh/config", "/Users/me/app/.env", "/etc/hosts", "/Users/me/.zshrc", "/Users/me/.aws/credentials"):
            out = await wr._put({"source_device_id": "mac", "dest": sensitive, "data_b64": "eA==", "task_id": "t1"}, USER)
            assert "code" not in out, sensitive
        await asyncio.sleep(0)
        assert len(told) == 5 and told[0][0] == "t1"

    await _run(patches, go)


@pytest.mark.asyncio
async def test_a_strict_deployment_still_refuses_sensitive_files():
    patches, ws = _env(_machine())
    patches += [patch.object(wr, "device_has_feature", lambda *a, **k: True),
                patch.object(wr.settings, "remote_exec_policy", "strict")]

    async def go():
        for bad in ("/Users/me/.ssh/config", "/etc/hosts"):
            out = await wr._put({"source_device_id": "mac", "dest": bad, "data_b64": "eA=="}, USER)
            assert out["code"] == "refused", bad
        ws.request_device.assert_not_awaited()

    await _run(patches, go)


@pytest.mark.asyncio
async def test_a_risky_command_is_recorded_on_the_task_and_pushed():
    patches, ws = _env(_machine())
    raised, pushed = AsyncMock(return_value={"label": "x"}), AsyncMock()
    from server.services import task_alerts
    patches += [patch.object(task_alerts, "raise_alert", raised), patch.object(wr.notify_service, "notify_user", pushed)]

    async def go():
        risk = wr.classify_shell_command("sudo tee /etc/hosts")
        await wr._tell_risky("t1", risk, "mac", USER)
        assert raised.await_args.args[:3] == ("t1", risk, "memento-source") and raised.await_args.args[3] == "Mac"
        pushed.assert_not_awaited()
        # Without a task (or one it can't find), straight to the phone
        raised.return_value = None
        await wr._tell_risky("", risk, "mac", USER)
        assert pushed.await_args.args[0] == USER and "以 root 权限执行" in pushed.await_args.args[2]

    await _run(patches, go)


class _Cl:
    """Just enough of a cluster for two DeviceConnectionManagers on "two replicas"."""

    def __init__(self, pod_id, peers):
        self.pod_id, self.peers, self.ops, self.tasks = pod_id, peers, {}, []
        peers[pod_id] = self

    def op(self, name, fn):
        self.ops[name] = fn

    def on(self, *a):
        pass

    on_pattern = on_start = on_stop = on

    def spawn(self, coro):
        self.tasks.append(asyncio.ensure_future(coro))

    async def call(self, pod, op, payload, timeout=10.0):
        return await self.peers[pod].ops[op](payload)


@pytest.mark.asyncio
async def test_an_answer_over_a_newer_connection_on_another_replica_reaches_the_one_that_asked():
    # The source reconnected while its command ran, now to replica B: the answer used to be dropped there
    # and the agent's command waited out its 30 minutes
    peers: dict = {}
    a, b = DeviceConnectionManager(_Cl("pod-a", peers)), DeviceConnectionManager(_Cl("pod-b", peers))
    sent: list[dict] = []

    async def fake_send(device_id, payload):
        sent.append(payload)
        return True

    a._connections["tok-mac"] = MagicMock()
    with patch.object(a, "_send_json_local", fake_send):
        pending = asyncio.ensure_future(a.request_device("tok-mac", {"type": "workspace_exec_req"}, timeout=2))
        await asyncio.sleep(0)
        assert sent[0]["req_id"].startswith("pod-a~")
        b.handle_file_response({"req_id": sent[0]["req_id"], "type": "workspace_resp", "exit_code": 0, "stdout": "ok"})
        await asyncio.gather(*peers["pod-b"].tasks)
        res = await pending
    assert res["exit_code"] == 0 and res["stdout"] == "ok"
    # Unknown or own ids go nowhere
    b.handle_file_response({"req_id": "pod-b~gone"})
    b.handle_file_response({"req_id": "plainhex"})
    assert peers["pod-b"].tasks[1:] == []


def _waiting_source(ws, status):
    """request_device: the command never answers; the status check answers `status`."""
    never = asyncio.get_running_loop().create_future()

    async def request_device(source, payload, timeout):
        if payload["type"] == "workspace_exec_status":
            return status
        return await never

    ws.request_device = request_device


@pytest.mark.asyncio
@pytest.mark.parametrize("online,status,want", [
    # Memento restarted there: the command is gone, no answer is coming
    (True, {"state": "unknown"}, {"code": "lost"}),
    # It finished but the answer was lost on a dropping connection: taken from the status
    (True, {"state": "done", "result": {"exit_code": 0, "stdout": "fine", "seconds": 1}}, {"exit_code": 0, "stdout": "fine"}),
    # Asleep / offline past the grace
    (False, {}, {"code": "source_unavailable"}),
])
async def test_a_command_whose_answer_will_never_come_ends_the_wait(online, status, want):
    patches, ws = _env(_machine(), online=online)
    patches += [patch.object(wr, "device_has_feature", lambda *a, **k: True),
                patch.object(wr, "EXEC_CHECK_SECONDS", 0.01), patch.object(wr, "SOURCE_GONE_GRACE", 0.03)]

    async def go():
        _waiting_source(ws, status)
        # Online for the source lookup, then whatever the case says
        ws.is_online.side_effect = iter([True] + [online] * 1000)
        out = await asyncio.wait_for(wr._exec({"source_device_id": "mac", "command": "npm test", "exec_id": "e1"}, USER), 2)
        assert all(out.get(k) == v for k, v in want.items()), out

    await _run(patches, go)


@pytest.mark.asyncio
async def test_a_source_still_running_the_command_or_too_old_to_say_is_waited_for():
    patches, ws = _env(_machine())
    patches += [patch.object(wr, "device_has_feature", lambda *a, **k: True), patch.object(wr, "EXEC_CHECK_SECONDS", 0.01)]

    async def go():
        for status in ({"state": "running"}, {"error": "设备 15 秒没有回应", "code": "timeout"}):
            _waiting_source(ws, status)
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(wr._exec({"source_device_id": "mac", "command": "npm test", "exec_id": "e1"}, USER), 0.1)

    await _run(patches, go)


@pytest.mark.asyncio
@pytest.mark.parametrize("policy,command,refused", [
    # The default since 11-19: nothing refused, risky ones pushed
    (None, "rm -rf ~", False),
    (None, "sudo reboot", False),
    # 11-19: ops work an agent was asked to do (sudo, writing nginx config on a server over ssh) ran nowhere
    ("catastrophic", "sudo tee /etc/nginx/sites-available/film.example.com < conf", False),
    ("catastrophic", 'ssh root@vps "cat /root/.acme.sh/account.conf; systemctl reload nginx; reboot"', False),
    ("catastrophic", "git reset --hard && rm -rf dist", False),
    # What wrecks the computer the code is on still doesn't run there
    ("catastrophic", "rm -rf ~", True),
    ("catastrophic", "sudo reboot", True),
    ("catastrophic", "diskutil eraseDisk APFS X disk2", True),
    # A deployment can keep the old rule, or drop every refusal
    ("strict", "sudo tee /etc/hosts", True),
    ("strict", "npm test", False),
    ("off", "rm -rf ~", False),
])
async def test_only_what_wrecks_the_source_is_refused_unless_the_deployment_says_otherwise(policy, command, refused):
    patches, ws = _env(_machine(), answer={"exit_code": 0, "stdout": "", "stderr": "", "seconds": 0.1})
    told = []

    async def tell(*a):
        told.append(a)

    patches += [patch.object(wr, "device_has_feature", lambda *a, **k: True),
                patch.object(wr.settings, "remote_exec_policy", policy or wr.settings.__class__.model_fields["remote_exec_policy"].default),
                patch.object(wr, "_tell_risky", tell),
                patch.object(wr.notify_service, "spawn", lambda coro: asyncio.ensure_future(coro))]

    async def go():
        out = await wr._exec({"source_device_id": "mac", "command": command, "task_id": "t1", "exec_id": "e1"}, USER)
        await asyncio.sleep(0)
        if refused:
            assert out["code"] == "refused"
            assert not any(c.args[1].get("type") == "workspace_exec_req" for c in ws.request_device.await_args_list)
        else:
            assert out.get("exit_code") == 0, out
            # A risky one that runs is reported to the user's phone
            assert bool(told) == (wr.classify_shell_command(command) is not None
                                  and wr.classify_shell_command(command).level in ("danger", "critical"))

    await _run(patches, go)
