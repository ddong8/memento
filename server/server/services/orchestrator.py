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
from ..db.session import async_session_factory
from .ai_provider import (
    call_chat_completion,
    call_plain_chat,
    stream_chat_completion,
    get_ai_providers,
)
from .ws_manager import ws_manager

logger = logging.getLogger("server.orchestrator")

# Tool-call rounds before we stop and let the model summarize. Each round is
# one LLM call plus however long the dispatched tasks take.
MAX_ROUNDS = int(os.environ.get("MEMENTO_MAX_ROUNDS", "8"))
# How long to wait inline for a dispatched task.
TASK_WAIT_SECONDS = int(os.environ.get("MEMENTO_TASK_WAIT_SECONDS", "180"))
TASK_POLL_INTERVAL = 1.5
# Trim tool output before it goes back into the prompt — a 100k-char build log
# would blow the context and bury the signal.
MAX_TOOL_OUTPUT = 6000
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
                    "device_id": {"type": "string", "description": "目标设备的 device_id（UUID）或设备名称，来自 list_devices"},
                    "action": {"type": "string", "enum": ["shell", "agent"]},
                    "command": {"type": "string", "description": "action=shell 时的命令行"},
                    "prompt": {"type": "string", "description": "action=agent 时给 agent 的任务描述"},
                    "cwd": {"type": "string", "description": "工作目录，可选"},
                    "timeout_seconds": {"type": "integer", "description": "执行超时时间（秒），shell 默认 45，agent 默认 180，最大 300"},
                },
                "required": ["device_id", "action"],
            },
        },
    },
]

def normalize_device_name(name: str | None) -> str:
    """Strip platform suffixes like ' (Darwin)', ' (Windows)', ' (Linux)'."""
    if not name:
        return ""
    for suffix in (" (Darwin)", " (Windows)", " (Linux)"):
        if name.endswith(suffix):
            return name[:-len(suffix)]
    return name


_device_name_cache: dict[str, tuple[str, float]] = {}


async def _resolve_machine_name(dev_id: str) -> str:
    """Resolve device_id or alias to the friendly Machine.name safely with caching and isolated session."""
    if not dev_id:
        return ""
    now = asyncio.get_event_loop().time()
    cached = _device_name_cache.get(dev_id)
    if cached and (now - cached[1]) < 60.0:
        return cached[0]

    base_dev_id = normalize_device_name(dev_id)
    resolved_name = dev_id
    try:
        async with async_session_factory() as session:
            mach_name = (await session.execute(
                select(Machine.name).where(
                    (Machine.collector_token_hash == dev_id)
                    | (Machine.name == dev_id)
                    | (Machine.name == base_dev_id)
                    | (Machine.name.like(f"{base_dev_id}%"))
                ).order_by(Machine.last_heartbeat.desc().nulls_last())
            )).scalars().first()
            if mach_name:
                resolved_name = mach_name
    except Exception as e:
        logger.warning("Error resolving machine name for %s: %s", dev_id, e)

    _device_name_cache[dev_id] = (resolved_name, now)
    return resolved_name


ORCHESTRATOR_SYSTEM = """你是 Memento 的多设备调度与记忆助手，能够调用用户的多台物理设备（Mac、Linux、Windows 等）完成任务。

你有两种信息来源：
1. 「资料」——服务端资料库，用于查阅已同步的历史笔记、过往对话或知识。
2. 「设备工具」——当涉及具体机器上的服务启动、端口排查、进程管理、代码修复、故障诊断，或用户要求「继续修复/排查/运行」时，必须主动使用 run_on_device 在目标设备上执行操作与验证！
   - 先使用 list_devices 查看设备列表、系统版本、在线状态；若用户已指定设备或上下文已明确设备，可直接调用 run_on_device；
   - 确认设备 online 后，再使用 run_on_device 发送任务。
   - 【支持多设备并发】：若涉及多台机器（如排查集群或对比多机端口），你可以在一轮中同时发出针对不同机器的多个 run_on_device 调用，系统已支持全并发下发与实时流式回传！

【跟进与设备操作执行规则】（核心必遵）：
- 当用户发出「关闭」、「关掉」、「杀死」、「杀掉」、「停止」、「停掉」、「清理」、「重启」、「继续修复」、「重试」或确认词（如「好的」、「可以」、「清理吧」）等跟进指令时：
  * 必须结合历史记录中上一轮的目标设备（如 Mac mini）、目标进程 PID（如 PID 3839）、端口或服务名；
  * 必须在第一轮主动调用 run_on_device 在目标物理机上执行真实操作（例如 kill <PID>、kill -9 <PID>、pkill、systemctl stop 等）并检查状态；
  * 【绝对严禁伪造执行记录】：绝对禁止在你的回答文本中编写或伪造类似「[系统记录]」或「【在设备上调用的工具与执行结果记录】」等虚构执行文本！任何在设备上的操作必须且只能通过 tool_calls 调用 run_on_device 真实下发到物理机！
  * 严禁在未调用工具真实执行操作前直接回复「未获取到具体设备操作」或草草结束！
- 当用户发出「继续修复」、「继续」、「重试」、「还没修好」、「还是报错」等延续性指令时：
  * 代表前序任务执行遇到了报错（非零退出码、stderr 异常输出）或尚未达成目标，绝不能未执行任何操作就回复「任务已完成」或草草结束！
  * 必须仔细检查对话历史中上一轮或多轮的设备执行记录、命令退出码和 stderr 报错输出，定位失败根因。
  * 必须在第一轮主动通过 run_on_device 在目标设备上执行下一步修复或排查动作（例如杀死占用端口的进程、安装缺失依赖、修复配置并重启服务）。
  * 若不确定当前状态，先调用 run_on_device 检查对应服务/进程当前状态或查看最新日志，确认实际情况后再向用户汇报。

设备命令执行安全与性能军规（务必遵守，防止进程挂死或机器卡顿）：
- 严禁全盘递归扫描：绝对禁止在根目录 `/` 或整个用户家目录 `$HOME` 下执行无限制深度的 `find`、`grep -r` 等全盘扫描！在 macOS 上扫描 `$HOME` 会遍历 `~/Library` 下的庞大沙盒容器和 iCloud 云盘，会触发系统 I/O 挂起或权限死锁，极易超时。
- 文件查找首选极速索引：
  * macOS 下定位文件：优先使用 Spotlight 索引 `mdfind -name "文件名"`（毫秒级瞬时返回）；
  * 若使用 `find`，必须限定具体的浅层目录（如 `~/Documents`、`~/Desktop`、`~/dev`）并加上 `-maxdepth 3`；
- 端口与进程探查规范：
  * macOS: 使用 `lsof -nP -iTCP:8000 || true`
  * Windows: 使用 `netstat -ano | findstr ":8000" || echo "port not in use"`
  * Linux: 使用 `ss -tulpn | grep ":8000" || true`
  * 【重要退出码说明】：使用 grep、findstr、lsof 检查端口时，若端口未被占用（未匹配到任何内容），命令通常会返回退出码 1。这是系统的正常预期行为（1 = 无匹配），代表端口空闲/无该进程，绝对不可误报为命令执行故障，应如实告知用户端口未被占用。
- 常见应用配置快速直达：
  * Obsidian 笔记库：直接读取配置文件 `cat "$HOME/Library/Application Support/obsidian/obsidian.json"`，里面记录了所有本地 Vault 路径，无需遍历磁盘！
  * VSCode/Cursor 配置：位于 `~/Library/Application Support/Code` 或 `Cursor`。
- 严禁交互式命令：不要执行需要用户输入密码的 `sudo`、未加 `-y` 的包管理器安装等等待交互输入的命令。
- 失败与超时处理：
  * 如果命令返回 timeout 或 still_running，绝对禁止在下一轮重复发送完全相同的命令！
  * 必须分析失败原因，缩小搜索范围、改用轻量命令或直接向用户说明。
- 如实汇报：把 stderr 和关键输出带上，直面问题，不要粉饰。用户用什么语言就用什么语言回答。
- 【必须提供完整总结】：当通过工具获取到所需的终端输出、状态或文件内容后，你必须在下一轮提供详细、有条理的总结与分析（例如格式化表格、逐条说明服务与端口、解释关键信息等），严禁只跑命令而不给用户总结！"""


async def _tool_list_devices(db: AsyncSession, user: User) -> dict:
    try:
        q = select(Machine).order_by(Machine.last_heartbeat.desc().nulls_last())
        if user.role not in ("admin", "owner"):
            q = q.where(Machine.user_id == user.id)
        machines = (await db.execute(q)).scalars().all()
        now = datetime.now(timezone.utc)
        out = []
        seen_names = set()
        for m in machines:
            if m.name in seen_names:
                continue
            seen_names.add(m.name)
            hb = m.last_heartbeat
            if hb and hb.tzinfo is None:
                hb = hb.replace(tzinfo=timezone.utc)
            age = (now - hb).total_seconds() if hb else None
            out.append({
                "device_id": m.collector_token_hash,
                "name": m.name,
                "collector_version": m.collector_version,
                "last_heartbeat": hb.isoformat() if hb else None,
                "online": age is not None and age < OFFLINE_AFTER_SECONDS,
            })
        return {"devices": out}
    except Exception as e:
        logger.exception("list_devices failed: %s", e)
        return {"devices": [], "error": str(e)}


async def _await_task_stream(
    db: AsyncSession,
    task: DeviceTask,
    machine_name: str,
    deadline: float,
    task_q: asyncio.Queue | None = None,
):
    """Poll the task row or receive chunks from WebSocket queue until terminal or deadline."""
    task_id = task.id
    target_device_id = task.device_id
    task_action = task.action
    last_status = task.status

    yield {
        "type": "task_progress",
        "task_id": str(task_id),
        "device_id": target_device_id,
        "device_name": machine_name,
        "action": task_action,
        "status": last_status,
    }

    while asyncio.get_event_loop().time() < deadline:
        # Check WebSocket queue for real-time chunks or completion
        if task_q is not None:
            try:
                item = await asyncio.wait_for(task_q.get(), timeout=1.0)
                itype = item.get("type")
                if itype == "task_chunk":
                    yield item
                    continue
                elif itype == "task_progress":
                    yield item
                    continue
                elif itype == "task_finished":
                    yield {"type": "_task_finished_ws", "result": item.get("result") or {}}
                    return
            except asyncio.TimeoutError:
                pass
        else:
            await asyncio.sleep(TASK_POLL_INTERVAL)

        # Database poll check (using isolated session to avoid cache / MissingGreenlet)
        current = None
        try:
            async with async_session_factory() as read_session:
                current = (await read_session.execute(
                    select(DeviceTask).where(DeviceTask.id == task_id)
                )).scalars().first()
        except Exception as e:
            logger.warning("Error polling task %s from db: %s", task_id, e)

        if current:
            if current.status != last_status:
                last_status = current.status
                yield {
                    "type": "task_progress",
                    "task_id": str(task_id),
                    "device_id": current.device_id,
                    "device_name": machine_name,
                    "action": current.action,
                    "status": current.status,
                }

            if current.status in ("succeeded", "failed", "timeout", "cancelled"):
                yield {"type": "_task_finished", "task": current}
                return

        # Keepalive ping so Nginx / ingress / proxies never close the SSE stream
        yield {"type": "ping"}

    yield {"type": "_task_timeout", "task_id": str(task_id)}


async def _tool_run_on_device(db: AsyncSession, user: User, args: dict):
    from ..api.tasks import EXEC_ACTIONS, REMOTE_EXEC_ENABLED

    if not REMOTE_EXEC_ENABLED:
        yield {
            "type": "tool_result",
            "name": "run_on_device",
            "result": {"error": "远程执行未启用（服务端设 MEMENTO_REMOTE_EXEC=1 即可，设备端无需配置）"},
        }
        return

    device_id = args.get("device_id") or ""
    action = args.get("action") or ""
    if action not in EXEC_ACTIONS:
        yield {
            "type": "tool_result",
            "name": "run_on_device",
            "result": {"error": f"不支持的 action: {action}"},
        }
        return

    try:
        # If device_id is omitted by the model, fall back to the user's most recently active machine
        if not device_id:
            mq = select(Machine).order_by(Machine.last_heartbeat.desc().nulls_last())
            if user.role not in ("admin", "owner"):
                mq = mq.where(Machine.user_id == user.id)
            machine = (await db.execute(mq)).scalars().first()
        else:
            base_dev_id = normalize_device_name(device_id)
            machine = (await db.execute(
                select(Machine).where(
                    (Machine.collector_token_hash == device_id)
                    | (Machine.name == device_id)
                    | (Machine.name == base_dev_id)
                    | (Machine.name.like(f"{base_dev_id}%"))
                ).order_by(Machine.last_heartbeat.desc().nulls_last())
            )).scalars().first()

        if user.role not in ("admin", "owner"):
            if not machine or machine.user_id != user.id:
                yield {
                    "type": "tool_result",
                    "name": "run_on_device",
                    "result": {"error": "设备不存在或无权限"},
                }
                return

        # Normalize device_id to the machine's actual collector_token_hash
        if machine:
            device_id = machine.collector_token_hash

        mach_name = machine.name if machine else device_id
        payload: dict = {}
        if action == "shell":
            if not (args.get("command") or "").strip():
                yield {
                    "type": "tool_result",
                    "name": "run_on_device",
                    "result": {"error": "shell 需要 command"},
                }
                return
            payload["command"] = args["command"]
        else:
            if not (args.get("prompt") or "").strip():
                yield {
                    "type": "tool_result",
                    "name": "run_on_device",
                    "result": {"error": "agent 需要 prompt"},
                }
                return
            payload["prompt"] = args["prompt"]
        if args.get("cwd"):
            payload["cwd"] = args["cwd"]

        # Determine timeout: shell defaults to 45s, agent defaults to TASK_WAIT_SECONDS (180s)
        default_timeout = 45 if action == "shell" else TASK_WAIT_SECONDS
        req_timeout = args.get("timeout_seconds")
        if req_timeout and isinstance(req_timeout, int) and req_timeout > 0:
            device_timeout = min(req_timeout, 300)
        else:
            device_timeout = default_timeout

        # Server deadline adds safety margin so device-side timeout status arrives cleanly before server deadline
        server_margin = 7 if action == "shell" else 10
        server_wait = device_timeout + server_margin

        task = DeviceTask(
            device_id=device_id,
            machine_id=machine.id if machine else None,
            user_id=user.id,
            action=action,
            payload=payload,
            timeout_seconds=device_timeout,
            status="queued",
        )
        db.add(task)
        await db.commit()
        await db.refresh(task)
        task_id_str = str(task.id)
        logger.info("orchestrator dispatched task %s (%s, timeout=%ds) to %s", task.id, action, device_timeout, device_id)

        task_q = None
        # Try WebSocket dispatch by all candidate aliases
        target_ws_id = None
        base_mach_name = normalize_device_name(mach_name)
        candidates = [device_id, mach_name, base_mach_name]
        if machine:
            candidates.extend([
                machine.collector_token_hash,
                machine.name,
                normalize_device_name(machine.name),
                str(machine.id),
            ])
        for cand in candidates:
            if cand and ws_manager.has_device(cand):
                target_ws_id = cand
                break

        if target_ws_id:
            task_q = ws_manager.subscribe_task(task_id_str)
            dispatched_ws = await ws_manager.send_task(target_ws_id, {
                "id": task_id_str,
                "action": action,
                "payload": payload,
                "timeout_seconds": device_timeout,
            })
            if dispatched_ws:
                task.status = "running"
                task.dispatched_at = datetime.now(timezone.utc)
                await db.commit()
            else:
                ws_manager.unsubscribe_task(task_id_str)
                task_q = None

        deadline = asyncio.get_event_loop().time() + server_wait
        done_task = None
        done_ws = None

        try:
            async for evt in _await_task_stream(db, task, mach_name, deadline, task_q=task_q):
                if evt["type"] == "_task_finished":
                    done_task = evt["task"]
                elif evt["type"] == "_task_finished_ws":
                    done_ws = evt["result"]
                elif evt["type"] == "_task_timeout":
                    done_task = None
                    done_ws = None
                else:
                    yield evt
        except (asyncio.CancelledError, GeneratorExit):
            logger.info("Task %s cancelled by client, sending cancel to device %s", task_id_str, device_id)
            await ws_manager.send_cancel(device_id, task_id_str)
            raise
        finally:
            if task_q is not None:
                ws_manager.unsubscribe_task(task_id_str)

        if done_ws:
            yield {
                "type": "tool_result",
                "name": "run_on_device",
                "result": {
                    "task_id": task_id_str,
                    "device_id": device_id,
                    "device_name": mach_name,
                    "action": action,
                    "status": done_ws.get("status", "succeeded"),
                    "exit_code": done_ws.get("exit_code"),
                    "stdout": (done_ws.get("stdout") or "")[:MAX_TOOL_OUTPUT],
                    "stderr": (done_ws.get("stderr") or "")[:MAX_TOOL_OUTPUT],
                    "error": done_ws.get("error"),
                },
            }
            return

        if not done_task:
            yield {
                "type": "tool_result",
                "name": "run_on_device",
                "result": {
                    "task_id": task_id_str,
                    "device_id": device_id,
                    "device_name": mach_name,
                    "action": action,
                    "status": "still_running",
                    "note": f"任务执行已超过 {device_timeout}s，设备端已尝试终止或仍在后台，请勿重复执行相同命令，建议换用更精准快速的查询方式。",
                },
            }
            return

        yield {
            "type": "tool_result",
            "name": "run_on_device",
            "result": {
                "task_id": str(done_task.id),
                "device_id": device_id,
                "device_name": mach_name,
                "action": action,
                "status": done_task.status,
                "exit_code": done_task.exit_code,
                "stdout": (done_task.stdout or "")[:MAX_TOOL_OUTPUT],
                "stderr": (done_task.stderr or "")[:MAX_TOOL_OUTPUT],
                "error": done_task.error,
            },
        }
    except Exception as e:
        logger.exception("run_on_device failed: %s", e)
        yield {
            "type": "tool_result",
            "name": "run_on_device",
            "result": {"error": f"执行遇到异常: {e}"},
        }


async def _dispatch_tool(db: AsyncSession, user: User, name: str, args: dict):
    if name == "list_devices":
        res = await _tool_list_devices(db, user)
        yield {"type": "tool_result", "name": name, "result": res}
        return
    if name == "run_on_device":
        async for evt in _tool_run_on_device(db, user, args):
            yield evt
        return
    yield {"type": "tool_result", "name": name, "result": {"error": f"unknown tool: {name}"}}


async def run_agent_loop(
    db: AsyncSession, user: User, messages: list[dict]
):
    """Run the tool-calling loop, yielding SSE-shaped events.

    Yields dicts: {"type": "tool_call"|"task_progress"|"ping"|"tool_result"|"delta"|"error"}.
    The caller serializes them; keeping this transport-agnostic makes the loop
    testable without spinning up a request.
    """
    convo = list(messages)
    # Track executed command signatures and their outcomes to prevent repeat death spirals:
    # "device_id:action:cmd" -> status ("succeeded", "failed", "timeout", "still_running")
    executed_commands: dict[str, str] = {}

    for round_no in range(MAX_ROUNDS):
        try:
            resp_data, used_provider = await call_chat_completion(
                messages=convo,
                tools=TOOLS,
                temperature=0.3,
                max_tokens=1500,
                timeout=120.0,
            )
        except Exception as e:
            logger.exception("orchestrator LLM call failed across all providers: %s", e)
            yield {"type": "error", "message": f"AI 调用失败: {e}"}
            return

        choice = (resp_data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        calls = msg.get("tool_calls") or []

        if not calls:
            content = (msg.get("content") or msg.get("reasoning_content") or "").strip()

            if round_no == 0:
                # Catch case where model hallucinates tool execution in plain text instead of making a tool_call
                if any(kw in content for kw in ("run_on_device", "【在设备上调用的工具", "[系统记录", "已终止 PID", "已杀死进程")):
                    logger.warning("Model produced hallucinated tool execution text in round 0; nudging to call run_on_device")
                    convo.append({"role": "assistant", "content": content})
                    convo.append({
                        "role": "user",
                        "content": "【系统纠偏】：你刚刚在回复文本中写出了设备操作记录，但并未真正调用 run_on_device 工具！请不要在文本中假装执行，现在必须立即通过 tool_calls 调用 run_on_device 工具向目标设备下发真实命令！",
                    })
                    continue

                if content:
                    yield {"type": "delta", "text": content}
                    return
                # Round 0 with no calls and empty content: fallback to plain chat without tools
                logger.info("Orchestrator round 0 returned no calls and empty content; falling back to plain chat")
                plain_content = await call_plain_chat(convo, temperature=0.3, max_tokens=1500)
                if plain_content and plain_content.strip():
                    yield {"type": "delta", "text": plain_content.strip()}
                    return

                yield {"type": "delta", "text": "未能向设备发送操作指令。如需在设备上排查、关闭进程或修复，请告知目标设备与具体要求。"}
                return

            # round_no > 0: Tools WERE executed in previous rounds!
            # If the model produced a substantive summary, return it.
            if content and len(content) > 15 and "任务已执行完成" not in content:
                yield {"type": "delta", "text": content}
                return

            # If tools ran but LLM provided empty or trivial summary, trigger the full synthesis step!
            logger.info("Tools executed in previous rounds; invoking full synthesis")
            break

        # Echo the assistant's tool-call turn back into the conversation
        # verbatim; providers reject a tool result whose call is missing.
        convo.append({
            "role": "assistant",
            "content": msg.get("content") or "",
            "tool_calls": calls,
        })

        # 1. Parse all tool calls and yield tool_call events immediately
        parsed_calls = []
        for call in calls:
            call_id = call.get("id") or ""
            fn = (call.get("function") or {})
            name = fn.get("name") or ""
            args_raw = fn.get("arguments") or "{}"
            try:
                args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
            except Exception:
                args = {}
            if not isinstance(args, dict):
                args = {}

            call_evt = {"type": "tool_call", "id": call_id, "tool_call_id": call_id, "name": name, "args": args}
            if name == "run_on_device":
                dev_id = args.get("device_id")
                if dev_id:
                    mach_name = await _resolve_machine_name(str(dev_id))
                    if mach_name:
                        call_evt["device_name"] = mach_name

            yield call_evt
            parsed_calls.append((call, call_id, name, args))

        # 2. Run all tool calls concurrently across devices
        event_queue: asyncio.Queue = asyncio.Queue()
        tool_results_by_id: dict[str, dict] = {}

        async def _run_single_tool(c_call, c_id, c_name, c_args):
            sig = None
            if c_name == "run_on_device":
                action = c_args.get("action") or ""
                cmd_or_prompt = (c_args.get("command") if action == "shell" else c_args.get("prompt")) or ""
                dev_key = str(c_args.get("device_id") or "")
                sig = f"{dev_key}:{action}:{cmd_or_prompt.strip()}"
                prev_status = executed_commands.get(sig)
                if prev_status in ("timeout", "still_running", "failed"):
                    logger.warning("Circuit breaker triggered for repeated command: %s (status: %s)", sig, prev_status)
                    breaker_msg = {
                        "status": "circuit_break",
                        "error": (
                            f"【防死循环熔断】该命令在上一轮执行已出现 {prev_status}，系统已拦截重复下发！"
                            "请换用更高效的方式（例如使用 Spotlight 索引 `mdfind`、读取具体配置文件、限定具体浅层子目录），或直接向用户说明情况。"
                        ),
                    }
                    tool_results_by_id[c_id] = breaker_msg
                    await event_queue.put({
                        "type": "tool_result",
                        "tool_call_id": c_id,
                        "name": c_name,
                        "result": breaker_msg,
                    })
                    return

            async with async_session_factory() as session:
                res_obj = None
                try:
                    async for evt in _dispatch_tool(session, user, c_name, c_args):
                        evt["tool_call_id"] = c_id
                        if evt.get("type") == "tool_result":
                            res_obj = evt.get("result")
                        await event_queue.put(evt)
                except Exception as e:
                    logger.exception("Concurrent tool %s failed: %s", c_name, e)
                    res_obj = {"error": f"Tool execution failed: {e}"}
                    await event_queue.put({
                        "type": "tool_result",
                        "tool_call_id": c_id,
                        "name": c_name,
                        "result": res_obj,
                    })

                tool_results_by_id[c_id] = res_obj or {}
                if sig and isinstance(res_obj, dict):
                    executed_commands[sig] = res_obj.get("status") or ""

        worker_tasks = [
            asyncio.create_task(_run_single_tool(c_call, c_id, c_name, c_args))
            for c_call, c_id, c_name, c_args in parsed_calls
        ]

        active_workers = set(worker_tasks)
        try:
            while active_workers:
                try:
                    evt = await asyncio.wait_for(event_queue.get(), timeout=0.2)
                    yield evt
                except asyncio.TimeoutError:
                    pass
                active_workers = {t for t in active_workers if not t.done()}

            # Drain any remaining events in queue
            while not event_queue.empty():
                yield event_queue.get_nowait()
        except (asyncio.CancelledError, GeneratorExit):
            for t in worker_tasks:
                if not t.done():
                    t.cancel()
            raise

        # Append all tool results in original order into convo
        for call in calls:
            cid = call.get("id") or ""
            convo.append({
                "role": "tool",
                "tool_call_id": cid,
                "content": json.dumps(tool_results_by_id.get(cid) or {}, ensure_ascii=False)[:MAX_TOOL_OUTPUT],
            })

    # Ran out of tool rounds. Always invoke the LLM one final time to synthesize all gathered results into a complete answer!
    convo.append({
        "role": "user",
        "content": (
            "【执行完毕总结】请根据上述所有已执行的命令输出与终端日志，"
            "为用户提供一份完整、详尽、结构清晰的最终总结与分析（例如梳理服务/容器名称、端口映射、运行状态等，并直接解答初始提问）。"
            "无需再请求任何工具。"
        ),
    })

    try:
        async for delta in stream_chat_completion(
            messages=convo,
            temperature=0.3,
            max_tokens=2500,
            timeout=120.0,
        ):
            yield {"type": "delta", "text": delta}
    except Exception as e:
        logger.exception("Final synthesis LLM call failed: %s", e)
        yield {
            "type": "delta",
            "text": f"\n\n(已完成所有工具调用，总结生成异常: {e})",
        }
