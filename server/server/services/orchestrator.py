"""Agent orchestration — let the LLM dispatch work to the user's machines.

`/api/ask` answers from synced memory. That only covers what already made it
to the server. This module gives the model two tools so it can go get what
isn't there:

    list_devices   — which machines exist, and are they online
    run_on_device  — run a shell command or an agent task on one of them

The loop is deliberately small and explicit rather than a general ReAct agent:
propose tool calls -> execute -> feed results back -> repeat, bounded by
MAX_ROUNDS. Everything the model dispatches goes through the same DeviceTask
queue and the same authorization as a hand-dispatched task, so there is no
second, weaker path to remote execution.

Waiting: dispatch is asynchronous (the device polls every ~10s) but the model
needs an answer inline, so _await_task polls the row until it reaches a
terminal state or the deadline passes. A task that outlives the deadline keeps
running on the device — the model is simply told it is still in progress.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import DeviceTask, Machine, User

logger = logging.getLogger("server.orchestrator")

AI_BASE_URL = os.environ.get("MEMENTO_AI_BASE_URL", "https://coding.dashscope.aliyuncs.com/v1")
AI_API_KEY = os.environ.get("MEMENTO_AI_API_KEY", "")
AI_MODEL = os.environ.get("MEMENTO_AI_MODEL", "kimi-k2.5")

# Tool-call rounds before we stop and let the model summarize. Each round is
# one LLM call plus however long the dispatched tasks take.
MAX_ROUNDS = 4
# How long to wait inline for a dispatched task.
TASK_WAIT_SECONDS = 180
TASK_POLL_INTERVAL = 3
# Trim tool output before it goes back into the prompt — a 100k-char build log
# would blow the context and bury the signal.
MAX_TOOL_OUTPUT = 4000
# A device that hasn't checked in for this long is reported as likely offline,
# so the model can pick a different machine instead of waiting on a dead one.
OFFLINE_AFTER_SECONDS = 180

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_devices",
            "description": "列出用户的所有设备（机器），包含名称、最近心跳、是否在线。派活前先用它确认有哪些机器可用。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_on_device",
            "description": (
                "在指定设备上执行任务并等待结果。"
                "action=shell 跑 shell 命令（适合查文件、看状态、grep）；"
                "action=agent 跑无头编码 agent（适合需要理解代码、多步骤的活）。"
                "只在确实需要设备上的实时信息、或需要在设备上动手时才用；"
                "已同步到服务端的资料应优先用检索到的内容回答。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "device_id": {"type": "string", "description": "目标设备的 device_id，来自 list_devices"},
                    "action": {"type": "string", "enum": ["shell", "agent"]},
                    "command": {"type": "string", "description": "action=shell 时的命令行"},
                    "prompt": {"type": "string", "description": "action=agent 时给 agent 的任务描述"},
                    "cwd": {"type": "string", "description": "工作目录，可选"},
                },
                "required": ["device_id", "action"],
            },
        },
    },
]

ORCHESTRATOR_SYSTEM = """你是 Memento 的记忆助手，同时能调度用户的多台设备干活。

你有两种信息来源：
1. 「资料」——已同步到服务端的对话、笔记、计划。优先用它回答。
2. 设备工具——当资料不足、或用户明确要求在机器上做事时，用 list_devices 看有哪些机器，用 run_on_device 去执行。

规则：
- 能用资料回答的，不要派活。派活有延迟，且会真的在用户机器上执行命令。
- 派活前先 list_devices 确认设备在线；离线设备不要派。
- shell 用于查看类操作；agent 用于需要理解代码、多步骤的任务。
- 引用资料时用 [1] [2] 标注来源编号。
- 如实汇报：命令失败就说失败，把 stderr 里的关键信息带上，不要粉饰。
- 用户用什么语言就用什么语言回答。"""


async def _tool_list_devices(db: AsyncSession, user: User) -> dict:
    q = select(Machine)
    if user.role not in ("admin", "owner"):
        q = q.where(Machine.user_id == user.id)
    machines = (await db.execute(q)).scalars().all()
    now = datetime.now(timezone.utc)
    out = []
    for m in machines:
        hb = m.last_heartbeat
        age = (now - hb).total_seconds() if hb else None
        out.append({
            "device_id": m.collector_token_hash,
            "name": m.name,
            "collector_version": m.collector_version,
            "last_heartbeat": hb.isoformat() if hb else None,
            "online": age is not None and age < OFFLINE_AFTER_SECONDS,
        })
    return {"devices": out}


async def _await_task(db: AsyncSession, task_id, deadline: float) -> DeviceTask | None:
    """Poll the task row until terminal or the deadline passes."""
    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(TASK_POLL_INTERVAL)
        # expire_all: this session may hold a stale copy from a prior read,
        # and the collector writes the result through a different session.
        db.expire_all()
        task = (await db.execute(
            select(DeviceTask).where(DeviceTask.id == task_id)
        )).scalar_one_or_none()
        if task and task.status in ("succeeded", "failed", "timeout", "cancelled"):
            return task
    return None


async def _tool_run_on_device(db: AsyncSession, user: User, args: dict) -> dict:
    from ..api.tasks import EXEC_ACTIONS, REMOTE_EXEC_ENABLED

    if not REMOTE_EXEC_ENABLED:
        return {"error": "远程执行未启用（服务端设 MEMENTO_REMOTE_EXEC=1 即可，设备端无需配置）"}

    device_id = args.get("device_id") or ""
    action = args.get("action") or ""
    if action not in EXEC_ACTIONS:
        return {"error": f"不支持的 action: {action}"}

    # Same ownership check as the hand-dispatch endpoint — the model must not
    # be a way around device authorization.
    machine = (await db.execute(
        select(Machine).where(Machine.collector_token_hash == device_id)
    )).scalar_one_or_none()
    if user.role not in ("admin", "owner"):
        if not machine or machine.user_id != user.id:
            return {"error": "设备不存在或无权限"}

    payload: dict = {}
    if action == "shell":
        if not (args.get("command") or "").strip():
            return {"error": "shell 需要 command"}
        payload["command"] = args["command"]
    else:
        if not (args.get("prompt") or "").strip():
            return {"error": "agent 需要 prompt"}
        payload["prompt"] = args["prompt"]
    if args.get("cwd"):
        payload["cwd"] = args["cwd"]

    task = DeviceTask(
        device_id=device_id,
        machine_id=machine.id if machine else None,
        user_id=user.id,
        action=action,
        payload=payload,
        timeout_seconds=TASK_WAIT_SECONDS,
        status="queued",
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    logger.info("orchestrator dispatched task %s (%s) to %s", task.id, action, device_id)

    deadline = asyncio.get_event_loop().time() + TASK_WAIT_SECONDS
    done = await _await_task(db, task.id, deadline)
    if not done:
        return {
            "task_id": str(task.id),
            "device_id": device_id,
            "device_name": machine.name if machine else device_id,
            "action": action,
            "status": "still_running",
            "note": f"任务仍在执行（已等待 {TASK_WAIT_SECONDS}s），可稍后在派活页查看结果",
        }
    return {
        "task_id": str(done.id),
        "device_id": device_id,
        "device_name": machine.name if machine else device_id,
        "action": action,
        "status": done.status,
        "exit_code": done.exit_code,
        "stdout": (done.stdout or "")[:MAX_TOOL_OUTPUT],
        "stderr": (done.stderr or "")[:MAX_TOOL_OUTPUT],
        "error": done.error,
    }


async def _dispatch_tool(db: AsyncSession, user: User, name: str, args: dict) -> dict:
    if name == "list_devices":
        return await _tool_list_devices(db, user)
    if name == "run_on_device":
        return await _tool_run_on_device(db, user, args)
    return {"error": f"unknown tool: {name}"}


async def run_agent_loop(
    db: AsyncSession, user: User, messages: list[dict]
):
    """Run the tool-calling loop, yielding SSE-shaped events.

    Yields dicts: {"type": "tool_call"|"tool_result"|"delta"|"error"}.
    The caller serializes them; keeping this transport-agnostic makes the loop
    testable without spinning up a request.
    """
    convo = list(messages)

    for round_no in range(MAX_ROUNDS):
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    f"{AI_BASE_URL}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {AI_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": AI_MODEL,
                        "messages": convo,
                        "tools": TOOLS,
                        "temperature": 0.3,
                        "max_tokens": 1500,
                    },
                )
        except Exception as e:
            logger.exception("orchestrator LLM call failed")
            yield {"type": "error", "message": f"AI 调用失败: {type(e).__name__}"}
            return

        if resp.status_code != 200:
            yield {"type": "error", "message": f"AI 服务返回 {resp.status_code}"}
            return

        choice = (resp.json().get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        calls = msg.get("tool_calls") or []

        if not calls:
            # No more tools wanted — this is the final answer.
            content = msg.get("content") or ""
            if content:
                yield {"type": "delta", "text": content}
            return

        # Echo the assistant's tool-call turn back into the conversation
        # verbatim; providers reject a tool result whose call is missing.
        convo.append({
            "role": "assistant",
            "content": msg.get("content") or "",
            "tool_calls": calls,
        })

        for call in calls:
            fn = (call.get("function") or {})
            name = fn.get("name") or ""
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}

            call_evt = {"type": "tool_call", "name": name, "args": args}
            if name == "run_on_device":
                dev_id = args.get("device_id")
                if dev_id:
                    mach_name = (await db.execute(
                        select(Machine.name).where(Machine.collector_token_hash == dev_id)
                    )).scalar_one_or_none()
                    if mach_name:
                        call_evt["device_name"] = mach_name

            yield call_evt
            result = await _dispatch_tool(db, user, name, args)
            yield {"type": "tool_result", "name": name, "result": result}

            convo.append({
                "role": "tool",
                "tool_call_id": call.get("id"),
                "content": json.dumps(result, ensure_ascii=False)[:MAX_TOOL_OUTPUT],
            })

    # Ran out of rounds with tools still pending.
    yield {
        "type": "delta",
        "text": f"\n\n(已达到 {MAX_ROUNDS} 轮工具调用上限，以上是目前得到的信息。)",
    }
