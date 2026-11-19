"""Code on one device, agent on another: the server carries the code between them.

The device running the agent (the executor) asks over its own WebSocket (``ws_relay``) and the
server passes each request on to the device holding the code (the source) over that one's:

- ``export``: the source packs the directory into a git bundle (history + a snapshot of the
  working tree); the server keeps where it is under a token, for the executor to fetch;
- ``chunk``: one piece of that bundle, read from the source like any other device file;
- ``p2p``: the executor's WebRTC offer for that bundle, answered by the source: the bundle then goes
  straight between the two (same LAN, IPv6, a punched NAT) instead of through the server's few-Mbps
  entry; ``chunk`` fetches whatever didn't arrive that way;
- ``session``: a Claude Code session's transcript on the device it is on, for the executor to continue it
  as is: the source says where the file is and how far it goes; the server keeps that under a token,
  read like a bundle with ``chunk``;
- ``exec``: a command of the agent's to run on the source, on the snapshot plus what the agent changed so
  far, in a checkout of the source's own (not the user's working tree): tests and builds run where the
  code's environment is. Commands risk_policy rates danger or critical run and the user's phone is told
  (refused only under MEMENTO_REMOTE_EXEC_POLICY, see ``_refusal``);
- ``commit``: the agent's commit, made on the source (11-17: the executor only edits code): a real
  ``git commit`` of what it changed there, so the source's hooks run and the commit is the user's own;
  it waits there until ``apply`` puts it on the branch;
- ``get``: a file the agent's commands made on the source (a screenshot, a log), for it to read;
- ``put``: a file the agent wrote, put anywhere on the source outside the project (the old one backed up
  there first); sensitive places (.ssh, .env, /etc, shell profiles, credentials) tell the user's phone
  (refused only when the policy is strict);
- ``apply``: what the agent changed, as a patch for the source to apply to its working tree, plus
  its commits (made on the source, or a bundle from older executors) for the source to put on its
  branch, and push when asked: the executor holds no credentials, the source does.

Neither device has to reach the other: both only hold their connection to the server. Only
devices of the same account can reach each other this way.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid
from typing import Any

from ..config import settings
from ..db.session import async_session_factory
from . import notify_service
from .cluster import cluster
from .device_reports import device_has_feature
from .risk_policy import classify_catastrophic, classify_file_change, classify_shell_command
from .user_filter import find_machine_by_id_or_hash
from .ws_manager import ws_manager

logger = logging.getLogger(__name__)

TOKEN_TTL = 1800
_TOKEN_KEY = "memento:ws:bundle:"
# Single replica without Redis: token -> (expires, entry)
_local_tokens: dict[str, tuple[float, dict[str, Any]]] = {}

EXPORT_TIMEOUT = 150.0
APPLY_TIMEOUT = 150.0
# The source pushes too (and may first rebase onto what the remote got meanwhile)
PUSH_TIMEOUT = 300.0
CHUNK_TIMEOUT = 60.0
# A command on the source: at most this long (the source stops it then), plus time to send it and its output
EXEC_MAX_MS = 30 * 60 * 1000
EXEC_SLACK = 90.0
# While a command runs there: how often the source is checked on, and how long it may be gone
EXEC_CHECK_SECONDS = 60.0
EXEC_STATUS_TIMEOUT = 15.0
SOURCE_GONE_GRACE = 120.0
SESSION_TIMEOUT = 30.0
CHUNK_MAX = 8 * 1024 * 1024
# gzip+base64 of a patch, as the executor caps it
PATCH_MAX = 10 * 1024 * 1024 + 1024
# Patch and commit bundle together: the bundle is only base64, a third bigger than the executor counts it
CARRY_MAX = PATCH_MAX * 3 // 2


# The version a source needs for a feature (older ones never reported it)
_FEATURE_VERSION = {"source_exec": "1.0.121", "source_commit": "1.0.138", "source_put": "1.0.141"}
COMMIT_TIMEOUT = 20 * 60.0
GET_TIMEOUT = 120.0
# A file brought back by ``get``: 8MB, base64
GET_MAX = 8 * 1024 * 1024 * 4 // 3 + 1024


async def _source_device(source_id: str, user_id: Any, feature: str | None = None) -> tuple[str | None, str | None]:
    """The source's connection id when it belongs to the same account as the executor (and reported
    feature, when given); else (None, why)."""
    async with async_session_factory() as db:
        m = await find_machine_by_id_or_hash(db, source_id)
    if not m or not m.collector_token_hash:
        return None, "找不到代码所在的设备"
    if user_id is None or m.user_id != user_id:
        return None, "代码所在的设备不属于这个账号"
    if getattr(m, "is_archived", False):
        return None, "代码所在的设备已解除关联"
    if not ws_manager.is_online(m.collector_token_hash):
        return None, f"{m.name or '代码所在的设备'} 不在线，打开它上面的 Memento 后再试"
    if feature and not device_has_feature(m.name, feature):
        need = _FEATURE_VERSION.get(feature, "1.0.121")
        return None, f"{m.name or '代码所在的设备'} 上的 Memento 版本太旧，升级到 {need} 及以上后再试"
    return m.collector_token_hash, None


async def _put_token(entry: dict[str, Any]) -> str:
    token = uuid.uuid4().hex
    r = cluster.redis
    if r is not None:
        await r.set(_TOKEN_KEY + token, json.dumps(entry), ex=TOKEN_TTL)
    else:
        now = time.monotonic()
        for k in [k for k, (exp, _) in _local_tokens.items() if exp < now]:
            _local_tokens.pop(k, None)
        _local_tokens[token] = (now + TOKEN_TTL, entry)
    return token


async def _get_token(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    r = cluster.redis
    if r is not None:
        raw = await r.get(_TOKEN_KEY + token)
        return json.loads(raw) if raw else None
    hit = _local_tokens.get(token)
    return hit[1] if hit and hit[0] >= time.monotonic() else None


async def _export(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    source, why = await _source_device(str(data.get("source_device_id") or ""), user_id)
    if not source:
        return {"error": why, "code": "source_unavailable"}
    have = [str(h) for h in (data.get("have") or []) if isinstance(h, str)][:20]
    res = await ws_manager.request_device(
        source, {"type": "workspace_export_req", "path": str(data.get("path") or ""), "have": have}, EXPORT_TIMEOUT,
    )
    if res.get("error"):
        return {"error": res["error"], "code": res.get("code") or "failed"}
    out = {k: res.get(k) for k in (
        "size", "head", "branch", "snapshot", "tree", "root", "rel", "up_to_date", "upstream", "user_name", "user_email", "left_behind",
    )}
    if not res.get("up_to_date"):
        out["token"] = await _put_token({
            "device": source, "path": res.get("bundle_path"), "size": int(res.get("size") or 0), "user": str(user_id),
        })
        # The executor may try the source directly first (op p2p)
        out["ice_servers"] = _ice_servers()
    return out


def _ice_servers() -> list[str]:
    from ..config import settings
    return [u.strip() for u in (settings.stun_urls or "").split(",") if u.strip()]


async def _p2p(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    entry = await _get_token(str(data.get("token") or ""))
    if not entry or entry.get("user") != str(user_id):
        return {"error": "传输已过期，重新开始任务", "code": "expired"}
    sdp = str(data.get("sdp") or "")
    if not sdp or len(sdp) > 64 * 1024:
        return {"error": "bad offer"}
    res = await ws_manager.request_p2p_answer(entry["device"], sdp, _ice_servers())
    if not res.get("sdp"):
        return {"error": res.get("error") or "源设备没有应答直连", "code": "no_direct"}
    return {"sdp": res["sdp"], "path": entry["path"]}


async def _session(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    source, why = await _source_device(str(data.get("source_device_id") or ""), user_id)
    if not source:
        return {"error": why, "code": "source_unavailable"}
    res = await ws_manager.request_device(
        source, {"type": "session_export_req", "session_id": str(data.get("session_id") or "")}, SESSION_TIMEOUT,
    )
    if res.get("error"):
        return {"error": res["error"], "code": res.get("code") or "failed"}
    size = int(res.get("size") or 0)
    out: dict[str, Any] = {"size": size, "last_uuid": str(res.get("last_uuid") or "")}
    if size > 0:
        out["token"] = await _put_token({"device": source, "path": res.get("path"), "size": size, "user": str(user_id)})
        # The device may fetch it from the source directly first (op p2p), as a workspace bundle
        out["ice_servers"] = _ice_servers()
    return out


async def _chunk(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    entry = await _get_token(str(data.get("token") or ""))
    if not entry or entry.get("user") != str(user_id):
        return {"error": "传输已过期，重新开始任务", "code": "expired"}
    offset = max(0, int(data.get("offset") or 0))
    length = max(1, min(int(data.get("length") or CHUNK_MAX), CHUNK_MAX, int(entry["size"]) - offset))
    if offset >= int(entry["size"]):
        return {"data_b64": "", "bytes_read": 0}
    chunk = await ws_manager.request_file_chunk(entry["device"], entry["path"], offset, length, timeout=CHUNK_TIMEOUT)
    if chunk is None:
        return {"error": "从代码所在的设备读取代码包失败（设备离线或文件已清理）", "code": "source_unavailable"}
    return {"data_b64": base64.b64encode(chunk).decode("ascii"), "bytes_read": len(chunk)}


async def _exec(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    command = str(data.get("command") or "").strip()
    if not command:
        return {"error": "没有要执行的命令"}
    risk = classify_shell_command(command)
    risky = bool(risk and risk.level in ("danger", "critical"))
    refused = _refusal(command, risk if risky else None)
    if refused:
        return {"error": refused, "code": "refused"}
    source, why = await _source_device(str(data.get("source_device_id") or ""), user_id, "source_exec")
    if not source:
        return {"error": why, "code": "source_unavailable"}
    if risky and risk is not None:
        # Run, and the user's phone told (sudo, writing /etc, a service restarted…): their own computer, their agent
        notify_service.spawn(_tell_risky(str(data.get("task_id") or ""), risk, str(data.get("source_device_id") or ""), user_id))
    patch = str(data.get("patch_b64") or "")
    if len(patch) > PATCH_MAX:
        return {"error": "改动太大", "code": "too_big"}
    timeout_ms = max(10_000, min(int(data.get("timeout_ms") or EXEC_MAX_MS), EXEC_MAX_MS))
    res = await _await_source(source, {
        "type": "workspace_exec_req",
        "path": str(data.get("path") or ""),
        "snapshot": str(data.get("snapshot") or ""),
        "rel": str(data.get("rel") or ""),
        "patch_b64": patch,
        "command": command,
        "timeout_ms": timeout_ms,
        "task_id": str(data.get("task_id") or ""),
        "exec_id": str(data.get("exec_id") or ""),
    }, timeout_ms / 1000 + EXEC_SLACK, exec_id=str(data.get("exec_id") or ""))
    if res.get("error"):
        return {"error": res["error"], "code": res.get("code") or "failed"}
    return {k: res[k] for k in ("exit_code", "stdout", "stderr", "timed_out", "seconds") if k in res}


def _refusal(command: str, risk: Any) -> str | None:
    """Why a command isn't run on the source under MEMENTO_REMOTE_EXEC_POLICY, or None.

    11-19: every risky command used to be refused (sudo, writing /etc, a systemctl restart, even ones sent
    on over ssh to another server), with no way to allow it: ops work an agent was asked to do couldn't be
    done. Now nothing is refused by default and the user's phone is told of risky ones instead; a
    deployment can refuse what wrecks the source (catastrophic) or every risky command (strict).
    """
    policy = _policy()
    if policy not in ("strict", "catastrophic"):
        return None
    if policy == "strict":
        if risk is not None:
            return f"这条命令有风险（{risk.label}），这个部署不允许在代码所在的设备上执行；需要的话请用户自己在那台设备上执行"
        return None
    fatal = classify_catastrophic(command)
    if fatal:
        return f"这条命令会{fatal.label}，不在代码所在的设备上执行；确实需要请用户自己在那台设备上执行"
    return None


def _policy() -> str:
    return (settings.remote_exec_policy or "off").strip().lower()


async def _tell_risky(task_id: str, risk: Any, source_id: str, user_id: Any) -> None:
    """Recorded on the agent's task and pushed to the user's phone (straight to the phone without a task)."""
    from .task_alerts import display_device_name, raise_alert  # task_alerts pulls in more of the app than this module needs

    try:
        async with async_session_factory() as db:
            m = await find_machine_by_id_or_hash(db, source_id)
        name = m.name if m else None
        if task_id and await raise_alert(task_id, risk, "memento-source", name, user_id=user_id):
            return
        if user_id is not None:
            await notify_service.notify_user(user_id, "risky", f"⚠️ {risk.label}", f"{display_device_name(name)}：{risk.detail}")
    except Exception as e:
        logger.warning("risky command alert for %s failed: %s", task_id or user_id, e)


async def _await_source(source: str, payload: dict[str, Any], timeout: float, exec_id: str = "") -> dict[str, Any]:
    """request_device for something that runs a while on the source (a command, a commit), checked on meanwhile.

    The answer was waited for up to the full timeout (30 minutes for a command) whatever happened there:
    the source gone (asleep, offline) or Memento restarted on it (the command gone with it, no answer ever
    coming) left the agent's command hanging that long. Now: gone for SOURCE_GONE_GRACE, or the source says
    it doesn't know the command, ends the wait with an error; a command it finished whose answer got lost
    on the way (sent over a connection that dropped) is taken from its status reply. Sources from before
    ``workspace_exec_status`` don't answer that and are only watched for being gone.
    """
    req = asyncio.ensure_future(ws_manager.request_device(source, payload, timeout))
    gone_since: float | None = None
    try:
        while True:
            done, _ = await asyncio.wait({req}, timeout=EXEC_CHECK_SECONDS)
            if done:
                return req.result()
            if not ws_manager.is_online(source):
                gone_since = gone_since or time.monotonic()
                if time.monotonic() - gone_since >= SOURCE_GONE_GRACE:
                    return {"error": f"代码所在的设备断开连接超过 {int(SOURCE_GONE_GRACE)} 秒（睡眠或断网），这条命令的结果拿不回来了；它恢复在线后再试",
                            "code": "source_unavailable"}
                continue
            gone_since = None
            if not exec_id:
                continue
            st = await ws_manager.request_device(source, {"type": "workspace_exec_status", "exec_id": exec_id}, EXEC_STATUS_TIMEOUT)
            if req.done():
                return req.result()
            state = st.get("state")
            if state == "done" and isinstance(st.get("result"), dict):
                return st["result"]
            if state == "unknown":
                return {"error": "代码所在的设备上已经没有这条命令了（那边的 Memento 重启过），请重新执行", "code": "lost"}
    finally:
        if not req.done():
            req.cancel()


async def _exec_cancel(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    """The executor's task ended: the source kills that task's commands and skips its queued ones.

    Commands of one repository run there one at a time, so one left running held up every later one
    (any task's) until its 30 minutes ran out. Sources before this ignore the message.
    """
    task_id = str(data.get("task_id") or "")
    if not task_id:
        return {"error": "缺少任务 id"}
    source, why = await _source_device(str(data.get("source_device_id") or ""), user_id)
    if not source:
        return {"error": why, "code": "source_unavailable"}
    sent = await ws_manager.send_json(source, {
        "type": "workspace_exec_cancel", "task_id": task_id, "exec_id": str(data.get("exec_id") or ""),
    })
    return {"sent": bool(sent)}


async def _commit(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    message = str(data.get("message") or "").strip()
    if not message:
        return {"error": "提交说明是空的"}
    source, why = await _source_device(str(data.get("source_device_id") or ""), user_id, "source_commit")
    if not source:
        return {"error": why, "code": "source_unavailable"}
    patch = str(data.get("patch_b64") or "")
    if len(patch) > PATCH_MAX:
        return {"error": "改动太大", "code": "too_big"}
    paths = [str(p) for p in (data.get("paths") or []) if isinstance(p, str)][:200]
    res = await _await_source(source, {
        "type": "workspace_commit_req",
        **{k: str(data.get(k) or "") for k in ("path", "task_id", "snapshot", "base_tree", "base_head", "parent")},
        "patch_b64": patch,
        "message": message[:5000],
        "paths": paths,
    }, COMMIT_TIMEOUT)
    if res.get("error"):
        return {"error": res["error"], "code": res.get("code") or "failed"}
    return {k: res[k] for k in ("exit_code", "stdout", "stderr", "sha", "subject", "files", "hook_patch_b64", "seconds") if k in res}


async def _get(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    source, why = await _source_device(str(data.get("source_device_id") or ""), user_id, "source_commit")
    if not source:
        return {"error": why, "code": "source_unavailable"}
    res = await ws_manager.request_device(source, {
        "type": "workspace_get_req",
        "path": str(data.get("path") or ""),
        "file": str(data.get("file") or ""),
        "rel": str(data.get("rel") or ""),
        # The source runs commands in several checkouts: the task's is where its files are
        "task_id": str(data.get("task_id") or ""),
    }, GET_TIMEOUT)
    if res.get("error"):
        return {"error": res["error"], "code": res.get("code") or "failed"}
    if len(str(res.get("data_b64") or "")) > GET_MAX:
        return {"error": "文件太大", "code": "too_big"}
    return {k: res[k] for k in ("data_b64", "size", "path") if k in res}


async def _put(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    dest = str(data.get("dest") or "").strip()
    if not dest:
        return {"error": "没有给要写到的位置"}
    risk = classify_file_change(dest, None)
    risky = risk is not None and risk.level in ("danger", "critical")
    # Sensitive places (.ssh, .env, /etc, shell profiles, credentials): written and the phone told, the old
    # file backed up there first; refused only where the deployment is strict
    if risky and _policy() == "strict":
        return {"error": f"这个部署不允许写这个位置（{risk.label}）；需要的话请用户自己在那台设备上改", "code": "refused"}
    content = str(data.get("data_b64") or "")
    if len(content) > GET_MAX:
        return {"error": "文件太大", "code": "too_big"}
    source, why = await _source_device(str(data.get("source_device_id") or ""), user_id, "source_put")
    if not source:
        return {"error": why, "code": "source_unavailable"}
    if risky and risk is not None:
        notify_service.spawn(_tell_risky(str(data.get("task_id") or ""), risk, str(data.get("source_device_id") or ""), user_id))
    res = await ws_manager.request_device(source, {
        "type": "workspace_put_req",
        "path": str(data.get("path") or ""),
        "dest": dest,
        "data_b64": content,
    }, GET_TIMEOUT)
    if res.get("error"):
        return {"error": res["error"], "code": res.get("code") or "failed"}
    return {k: res[k] for k in ("path", "size", "backup") if k in res}


async def _apply(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    source, why = await _source_device(str(data.get("source_device_id") or ""), user_id)
    if not source:
        return {"error": why, "code": "source_unavailable"}
    patch = str(data.get("patch_b64") or "")
    if not patch:
        return {"error": "补丁是空的"}
    if len(patch) > PATCH_MAX:
        return {"error": "补丁太大", "code": "too_big"}
    files = data.get("files") if isinstance(data.get("files"), list) else []
    commits = _commits(data.get("commits"))
    if commits and len(patch) + len(commits["bundle_b64"]) > CARRY_MAX:
        return {"error": "改动和提交太大", "code": "too_big"}
    res = await ws_manager.request_device(source, {
        "type": "workspace_apply_req",
        "path": str(data.get("path") or ""),
        "task_id": str(data.get("task_id") or ""),
        "base_tree": str(data.get("base_tree") or ""),
        "mode": "save" if data.get("mode") == "save" else "apply",
        "patch_b64": patch,
        "files": files[:2000],
        **({"commits": commits} if commits else {}),
    }, PUSH_TIMEOUT if commits and commits["push"] else APPLY_TIMEOUT)
    if res.get("error"):
        return {"error": res["error"], "code": res.get("code") or "failed"}
    return {k: res[k] for k in _APPLY_REPLY if k in res}


_APPLY_REPLY = (
    "applied", "conflict", "branch", "files", "patch_path", "detail",
    "commits", "committed", "commit_branch", "commits_error", "push",
)


def _commits(raw: Any) -> dict[str, Any] | None:
    """The agent's commits as the executor sent them, passed on as they are (only the shape checked)."""
    if not isinstance(raw, dict):
        return None
    return {
        "bundle_b64": str(raw.get("bundle_b64") or ""),
        "head": str(raw.get("head") or ""),
        "base_head": str(raw.get("base_head") or ""),
        "branch": str(raw.get("branch") or ""),
        "push": raw.get("push") is True,
        **({"on_source": True} if raw.get("on_source") is True else {}),
    }


_OPS = {"export": _export, "chunk": _chunk, "p2p": _p2p, "session": _session, "exec": _exec, "exec_cancel": _exec_cancel, "commit": _commit, "get": _get, "put": _put, "apply": _apply}


async def handle(data: dict[str, Any], executor_id: str, user_id: Any) -> None:
    """One ws_relay request from executor_id; the answer goes back as ws_relay_reply (run off the receive loop)."""
    req_id = data.get("req_id")
    op = str(data.get("op") or "")
    fn = _OPS.get(op)
    try:
        reply = await fn(data, user_id) if fn else {"error": f"unknown op {op}"}
    except Exception as e:  # the executor waits on this reply: always send one
        logger.warning("workspace relay %s for %s failed: %s", op, executor_id, e)
        reply = {"error": f"服务器中转失败：{e or type(e).__name__}"}
    if op != "chunk" or reply.get("error"):
        logger.info("workspace relay %s for %s: %s", op, executor_id, reply.get("error") or "ok")
    await ws_manager.send_json(executor_id, {**reply, "type": "ws_relay_reply", "req_id": req_id})
