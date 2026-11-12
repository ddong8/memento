"""Collaborative tasks: one big task split into sub-tasks that run at the same time on several devices
and agents, each sub-task on the agent it suits, checked and summed up at the end.

1. Planning: the user's model splits the goal into steps (what, depends on what, how to tell it's done,
   which agent on which device), knowing what each device has right now: agents, models, quota left,
   tasks running, and how its runs did over the last 30 days. A goal not worth splitting is one step.
2. Running: one replica (cluster lease "plans") goes over the open plans every few seconds and sends
   every step whose dependencies are done to its device, through the same path as the AI 执事's
   run_on_device. Steps on another device than the code's work on a copy of it (cross-device workspace)
   and send their changes back; steps on the code's own device run there one at a time.
3. A step that fails is tried again on another agent or device (quota spent: never the same one), at
   most MAX_ATTEMPTS times. When the work steps are done, a review step checks them together and runs
   the tests. Then a summary, and a push to the user's phone.

Everything is in the agent_plans row: a deploy, or the replica going away, loses nothing. The replica
that takes the lease over follows the steps' device tasks from the database.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import func, select, update
from sqlalchemy.orm.attributes import flag_modified

from ..db.models import AgentPlan, DeviceTask, User
from ..db.session import async_session_factory
from .cluster import cluster

logger = logging.getLogger(__name__)

TICK_SECONDS = 5.0
MAX_STEPS = int(os.environ.get("MEMENTO_PLAN_MAX_STEPS", "8"))
MAX_ATTEMPTS = int(os.environ.get("MEMENTO_PLAN_MAX_ATTEMPTS", "3"))
DEFAULT_PARALLEL = int(os.environ.get("MEMENTO_PLAN_PARALLEL", "4"))
# One attempt at a step; past it the device stops the agent and the step goes to another one. Small
# steps take minutes; an agent stuck far longer (a remote model queueing for hours) holds up the whole plan.
STEP_TIMEOUT = int(os.environ.get("MEMENTO_PLAN_STEP_TIMEOUT", "1800"))
# A model with less quota left than this (percent) is not given work
MIN_QUOTA = float(os.environ.get("MEMENTO_PLAN_MIN_QUOTA", "10"))
# No device/agent can take a step: wait this long for one to come online before giving up on it
WAIT_FOR_DEVICE = timedelta(minutes=30)
# A step marked running whose device task never got made (the replica went away mid-dispatch)
LOST_DISPATCH = timedelta(minutes=3)

OPEN = ("planning", "running", "integrating")
DONE = ("succeeded", "failed", "cancelled")
STEP_DONE = ("succeeded", "failed", "cancelled", "skipped")

AGENTS = ("claude", "codex", "antigravity")
AGENT_NAMES = {"claude": "Claude Code", "codex": "Codex", "antigravity": "Antigravity"}
# run_on_device's binary; the capability report's key; the quota report's key
_BINARY = {"claude": "claude", "codex": "codex", "antigravity": "agy"}
_CAPS_KEY = {"claude": "claude", "codex": "codex", "antigravity": "antigravity"}
_QUOTA_KEY = {"claude": "claude_code", "codex": "codex", "antigravity": "antigravity"}

AGENT_STRENGTHS = {
    "claude": "跨文件重构、排查疑难问题、架构设计、复杂逻辑、代码审查，最聪明；但 Claude 订阅的 5 小时和每周额度整个账号共用，留给最难的活",
    "codex": "按明确规格实现、大量机械性改动、批量修改、补测试、跑命令，速度快、额度宽裕，优先多用",
    "antigravity": "前端界面与样式、看图和截图、网页相关、文档整理，额度单独计算，优先多用",
}

# Background work of this replica: plan id or "plan_id/step_id" -> task. The plan rows are the truth;
# this only says what this replica is already doing about them.
_local: dict[str, asyncio.Task] = {}
_runner: asyncio.Task | None = None
_running = False


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _parse_time(s: Any) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _tail(text: str | None, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else "…" + text[-limit:]


# ── what the devices can do ─────────────────────────────────────────────────
async def capability_snapshot(db, user: User) -> dict:
    """Devices online right now with the agents they can run, and how each device/agent did lately."""
    from . import device_reports
    from .orchestrator import _tool_list_devices
    from .task_alerts import display_device_name

    listing = (await _tool_list_devices(db, user)).get("devices") or []
    since = _now() - timedelta(days=30)

    running: dict[str, int] = {}
    rows = (await db.execute(
        select(DeviceTask.device_id, func.count())
        .where(DeviceTask.user_id == user.id, DeviceTask.status.in_(("queued", "running")),
               DeviceTask.created_at > _now() - timedelta(days=1))
        .group_by(DeviceTask.device_id)
    )).all()
    for dev, n in rows:
        running[str(dev)] = int(n)

    stats: dict[str, dict] = {}
    binary = DeviceTask.payload["binary"].astext
    rows = (await db.execute(
        select(
            DeviceTask.device_id, binary, func.count(),
            func.count().filter(DeviceTask.status == "succeeded"),
            func.avg(func.extract("epoch", DeviceTask.finished_at - DeviceTask.dispatched_at)),
        )
        .where(DeviceTask.user_id == user.id, DeviceTask.action == "agent", DeviceTask.created_at > since,
               DeviceTask.status.in_(("succeeded", "failed", "timeout")))
        .group_by(DeviceTask.device_id, binary)
    )).all()
    by_binary = {v: k for k, v in _BINARY.items()}
    for dev, b, n, ok, avg in rows:
        agent = by_binary.get(str(b or "claude"))
        if agent:
            stats[f"{dev}/{agent}"] = {"runs": int(n), "ok": int(ok or 0), "avg_seconds": int(avg or 0)}

    devices = []
    for d in listing:
        dev_id = d.get("device_id")
        if not dev_id or not d.get("online"):
            continue
        caps = device_reports.get_cached_device_capabilities(dev_id, user=user) or {}
        quotas = (device_reports.get_cached_device_quotas(dev_id, user=user) or {}).get("tools") or {}
        env = caps.get("environment") if isinstance(caps.get("environment"), dict) else {}
        agents = {}
        for agent in AGENTS:
            c = caps.get(_CAPS_KEY[agent])
            if not isinstance(c, dict) or c.get("available") is False:
                continue
            q = quotas.get(_QUOTA_KEY[agent]) if isinstance(quotas.get(_QUOTA_KEY[agent]), dict) else {}
            if q.get("logged_in") is False:
                continue
            models = [str(m.get("id")) for m in (c.get("models") or []) if isinstance(m, dict) and m.get("id")]
            agents[agent] = model_roster(agent, models, q, default=str(q.get("default_model") or c.get("default_model") or ""))
        devices.append({
            "device_id": dev_id,
            "name": display_device_name(d.get("name") or "") or d.get("name") or dev_id,
            "platform": env.get("platform") or "",
            "workspace": "workspace_sync" in (env.get("features") or []),
            "running": running.get(dev_id, 0),
            "agents": agents,
        })
    return {"devices": devices, "stats": stats}


_EFFORTS = ("low", "medium", "high", "xhigh", "max")


def model_family(agent: str, model: str) -> str:
    """The family a quota is counted for, as the device counts it (daemon model-limits.ts)."""
    m = (model or "").strip().lower()
    if agent == "claude":
        return next((f for f in ("fable", "opus", "sonnet", "haiku") if f in m), m)
    if agent == "antigravity":
        parts = m.split("-")
        return "-".join(parts[:-1]) if len(parts) > 1 and parts[-1] in _EFFORTS else m
    return m


def _until_text(until: datetime | None) -> str:
    if not until:
        return "额度用完"
    mins = max(1, int((until - _now()).total_seconds() // 60))
    span = f"{mins} 分钟" if mins < 60 else f"{round(mins / 60)} 小时" if mins < 48 * 60 else f"{round(mins / 1440)} 天"
    return f"额度用完，约 {span}后恢复"


def model_roster(agent: str, models: list[str], quota: dict, *, default: str = "") -> dict:
    """What an agent on one device can answer with right now: its models, the ones out of quota (or
    below MIN_QUOTA, or not on the account) with why, and the model a step should use: the default
    when it still has quota, else the next one with quota (same effort when the names carry one)."""
    now = _now()
    models = [m for m in dict.fromkeys(models) if m and not m.endswith("-disabled")]
    per_model = {str(m.get("model_id")): m for m in (quota.get("models") or []) if isinstance(m, dict) and m.get("model_id")}
    some_numeric = any(isinstance(m.get("remaining_percent"), (int, float)) for m in per_model.values())
    limits: dict[str, str] = {}
    for lim in quota.get("limited_models") or []:
        if not isinstance(lim, dict):
            continue
        until = _parse_time(lim.get("until"))
        if until and until <= now:
            continue
        fam = str(lim.get("family") or model_family(agent, str(lim.get("model") or "")))
        limits[fam] = "账号不支持" if re.search(r"model is not supported", str(lim.get("message") or ""), re.I) else _until_text(until)
    out: dict[str, str] = {}
    rem = quota.get("remaining_percent")
    for m in models + ([default] if default and default not in models else []):
        fam = model_family(agent, m)
        pm = per_model.get(m) or {}
        pct = pm.get("remaining_percent")
        if fam in limits:
            out[m] = limits[fam]
        elif isinstance(pct, (int, float)) and pct < MIN_QUOTA:
            out[m] = _until_text(_parse_time(pm.get("reset_time"))) if pct <= 0 else f"额度只剩 {pct:g}%"
        elif agent == "antigravity" and pm and pct is None and some_numeric:
            # Older clients: Antigravity leaves out a spent model's remaining fraction (0 in proto3 JSON)
            out[m] = "额度用完"
        elif agent == "claude" and isinstance(rem, (int, float)) and rem < MIN_QUOTA:
            out[m] = "额度用完" if rem <= 0 else f"账号额度只剩 {rem:g}%"
    usable = [m for m in models if m not in out]
    pick = ""
    if default and default not in out:
        pick = default
    elif default or out:
        effort = default.rsplit("-", 1)[-1] if default and default.rsplit("-", 1)[-1] in _EFFORTS else ""
        same = [m for m in usable if effort and m.endswith(f"-{effort}")]
        pick = (same or usable or [""])[0]
    no_model = bool(models) and not usable
    account_out = isinstance(rem, (int, float)) and rem <= 0 and not models
    return {
        "models": usable[:12],
        "default_model": default,
        "model": pick,
        "out": out,
        "limited": list(out),
        "usable": not (no_model or account_out or (bool(out) and default in out and not pick)),
        "remaining_percent": rem,
        "reset_time": quota.get("reset_time"),
    }


def agent_usable(info: dict | None) -> bool:
    """The agent has a model left to answer with."""
    return bool(info) and info.get("usable", True) is not False


def step_model(info: dict | None, wanted: str | None = None) -> str:
    """The model a step runs with on this agent: the asked-for one while it has quota, else the agent's pick."""
    info = info or {}
    if wanted and wanted not in (info.get("out") or {}) and (wanted in (info.get("models") or []) or not info.get("models")):
        return wanted
    return info.get("model") or ""


def _device(snapshot: dict, device_id: str | None) -> dict | None:
    if not device_id:
        return None
    for d in snapshot.get("devices") or []:
        if device_id in (d["device_id"], d["name"]):
            return d
    low = device_id.lower()
    for d in snapshot.get("devices") or []:
        if d["name"].lower().startswith(low) or low.startswith(d["name"].lower()):
            return d
    return None


def can_run(snapshot: dict, device: dict, agent: str, *, source_device_id: str | None, code: bool) -> bool:
    if not agent_usable((device.get("agents") or {}).get(agent)):
        return False
    if code and source_device_id and device["device_id"] != source_device_id:
        # Code on another device: both ends must be able to hand it over
        src = _device(snapshot, source_device_id)
        return bool(device.get("workspace")) and bool(src and src.get("workspace"))
    return True


def choose_assignment(
    snapshot: dict,
    *,
    prefer_agent: str | None = None,
    prefer_device: str | None = None,
    exclude: list | None = None,
    source_device_id: str | None = None,
    code: bool = False,
    load: dict | None = None,
    penalty: dict | None = None,
) -> tuple[str, str] | None:
    """The best (device_id, agent) left for a step. Asked for agent and device first, then the agents
    with quota to spare (Codex, Antigravity) before Claude, the less busy device, the better record.
    `penalty` counts how often each agent already failed in this plan (a timeout counts double): an
    agent stuck on one device is usually stuck on all of them, so the retry goes to another agent."""
    tried = {(str(e[0]), str(e[1])) for e in (exclude or []) if isinstance(e, (list, tuple)) and len(e) == 2}
    load = load or {}
    penalty = penalty or {}
    best: tuple[float, str, str] | None = None
    for dev in snapshot.get("devices") or []:
        for agent in dev.get("agents") or {}:
            if (dev["device_id"], agent) in tried:
                continue
            if not can_run(snapshot, dev, agent, source_device_id=source_device_id, code=code):
                continue
            score = 0.0
            if prefer_agent and agent == prefer_agent and not penalty.get(agent):
                score += 40
            if prefer_device and _device(snapshot, prefer_device) is dev:
                score += 25
            score += {"codex": 6, "antigravity": 4, "claude": 3}.get(agent, 0)
            if code and source_device_id and dev["device_id"] == source_device_id:
                score += 3  # no copy to make
            busy = dev.get("running", 0) + load.get(dev["device_id"], 0)
            score -= 8 * busy
            rem = dev["agents"][agent].get("remaining_percent")
            if isinstance(rem, (int, float)):
                score += min(rem, 100) / 20
            st = (snapshot.get("stats") or {}).get(f"{dev['device_id']}/{agent}")
            if st and st["runs"] >= 3:
                score += 15 * (st["ok"] / st["runs"] - 0.5)
                if st.get("avg_seconds", 0) > STEP_TIMEOUT:
                    score -= 5
            score -= 12 * penalty.get(agent, 0)
            if best is None or score > best[0]:
                best = (score, dev["device_id"], agent)
    return (best[1], best[2]) if best else None


# ── planning ────────────────────────────────────────────────────────────────
def agent_penalty(steps: list[dict]) -> dict[str, int]:
    """Failures per agent across the plan's steps; a timeout counts double, a spent quota not at all
    (the quota check already keeps that agent out)."""
    out: dict[str, int] = {}
    for s in steps:
        for h in s.get("history") or []:
            if h.get("error_type") == "usage_limit" or not h.get("agent"):
                continue
            out[h["agent"]] = out.get(h["agent"], 0) + (2 if h.get("status") == "timeout" else 1)
    return out


def _snapshot_text(snapshot: dict) -> str:
    lines = []
    for d in snapshot.get("devices") or []:
        agents = []
        for a, info in (d.get("agents") or {}).items():
            bits = [AGENT_NAMES[a]]
            if not agent_usable(info):
                bits.append("暂不可用（没有额度够用的模型）")
            else:
                if info.get("model"):
                    bits.append(f"默认用 {info['model']}")
                if info.get("models"):
                    bits.append("可用模型 " + "、".join(info["models"][:8]))
            if info.get("out"):
                bits.append("不能用的模型 " + "、".join(f"{m}（{why}）" for m, why in list(info["out"].items())[:6]))
            if isinstance(info.get("remaining_percent"), (int, float)):
                bits.append(f"额度剩 {info['remaining_percent']}%")
            st = (snapshot.get("stats") or {}).get(f"{d['device_id']}/{a}")
            if st and st["runs"]:
                bits.append(f"近 30 天 {st['runs']} 次成功 {st['ok']} 次、平均 {st['avg_seconds'] // 60} 分钟")
            agents.append(f"{a}（{'；'.join(bits)}）")
        lines.append(f"- 设备「{d['name']}」 平台 {d['platform'] or '未知'}，正在跑 {d['running']} 个任务；智能体：{'，'.join(agents) or '无'}")
    return "\n".join(lines) or "（没有在线设备）"


def _planning_messages(goal: str, snapshot: dict, *, cwd: str | None, source_name: str | None, blueprint: str) -> list[dict]:
    strengths = "\n".join(f"- {a}（{AGENT_NAMES[a]}）：{s}" for a, s in AGENT_STRENGTHS.items())
    where = f"代码目录：{cwd}（在设备「{source_name or '未知'}」上；派到别的设备的子任务会在它的副本上改，改完自动合回）" if cwd else "没有指定代码目录"
    system = f"""你是任务规划器。把用户的大任务拆成可以交给不同 AI 编码智能体并行完成的子任务，输出严格的 JSON，不要输出别的文字。

规则：
1) 子任务之间尽量互不依赖、改的文件不重叠，能并行的就并行；确实有先后的用 depends_on 写明。
2) 每个子任务写清楚：要做什么（prompt，给智能体看的完整指令，说明范围和要改的文件或模块，不要假设它知道别的子任务）、验收标准（acceptance，可检查的结果，比如哪些测试通过）。
3) 按智能体特点分配 agent，按设备情况分配 device（填设备名）：
{strengths}
   暂不可用的智能体、不能用的模型（额度用完或不够）一律不要分配；同一台设备不要堆太多任务。
4) 任务本身不大、拆开反而更慢时，只输出 1 个子任务。
5) 最多 {MAX_STEPS} 个子任务。不要单独安排「汇总」或「复查」子任务，系统会在最后自动做合并复查。
6) model 只能从该设备该智能体的「可用模型」里选；一般留空，系统会用它后面写的「默认用」的模型；只有任务特别难时才指定更强的模型。

输出格式：
{{"title": "整个任务的短标题", "note": "为什么这样拆（一两句）", "steps": [{{"id": "s1", "title": "子任务短标题", "prompt": "...", "acceptance": "...", "depends_on": [], "agent": "codex", "device": "设备名", "model": ""}}]}}"""
    user_msg = f"""大任务：
{goal}

{where}

现在在线的设备和智能体：
{_snapshot_text(snapshot)}"""
    if blueprint:
        user_msg += f"\n\n项目概况（项目蓝图摘要）：\n{blueprint}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user_msg}]


def parse_plan_json(text: str | None) -> dict | None:
    """The planner's JSON, also when wrapped in a code fence or prose."""
    if not text:
        return None
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if m:
        text = m.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) and isinstance(data.get("steps"), list) else None


def _has_cycle(steps: list[dict]) -> bool:
    deps = {s["id"]: list(s.get("depends_on") or []) for s in steps}
    state: dict[str, int] = {}

    def visit(n: str) -> bool:
        if state.get(n) == 1:
            return True
        if state.get(n) == 2:
            return False
        state[n] = 1
        if any(visit(d) for d in deps.get(n, [])):
            return True
        state[n] = 2
        return False

    return any(visit(n) for n in deps)


def _new_step(sid: str, title: str, prompt: str, *, acceptance: str = "", depends_on: list | None = None,
              agent: str = "", device_id: str = "", model: str = "", kind: str = "work") -> dict:
    return {
        "id": sid, "kind": kind, "title": title[:120] or sid, "prompt": prompt, "acceptance": acceptance,
        "depends_on": depends_on or [], "agent": agent, "device_id": device_id, "device_name": "", "model": model,
        "status": "pending", "attempts": 0, "tried": [], "history": [], "task_id": None,
        "result": None, "error": None, "workspace": None, "started_at": None, "finished_at": None,
    }


def normalize_steps(raw: list, snapshot: dict, *, source_device_id: str | None, code: bool, review: bool = True) -> list[dict]:
    """The planner's (or the user's) steps made safe to run: unique ids, known dependencies, no cycles,
    at most MAX_STEPS, an agent and device that can take each one (or blank, picked when it starts),
    and the review step at the end when there are several."""
    steps: list[dict] = []
    seen: set[str] = set()
    for i, r in enumerate(raw[:MAX_STEPS]):
        if not isinstance(r, dict) or r.get("kind") == "review":
            continue
        prompt = str(r.get("prompt") or "").strip()
        if not prompt:
            continue
        sid = re.sub(r"[^A-Za-z0-9_-]", "", str(r.get("id") or "")) or f"s{i + 1}"
        while sid in seen:
            sid = f"{sid}x"
        seen.add(sid)
        agent = str(r.get("agent") or "").strip().lower()
        agent = {"claude_code": "claude", "agy": "antigravity", "gemini": "antigravity"}.get(agent, agent)
        if agent not in AGENTS:
            agent = ""
        dev = _device(snapshot, str(r.get("device") or r.get("device_id") or "").strip())
        device_id = dev["device_id"] if dev else ""
        if dev and agent and not can_run(snapshot, dev, agent, source_device_id=source_device_id, code=code):
            device_id = ""
        model = str(r.get("model") or "").strip()
        step = _new_step(
            sid, str(r.get("title") or "").strip(), prompt,
            acceptance=str(r.get("acceptance") or "").strip(),
            depends_on=[str(d) for d in (r.get("depends_on") or []) if isinstance(d, (str, int))],
            agent=agent, device_id=device_id, model=model,
        )
        # Kept by an edit: what the step already went through
        for k in ("status", "attempts", "tried", "history", "task_id", "result", "error", "workspace", "started_at", "finished_at"):
            if k in r and r.get("status") in STEP_DONE + ("running",):
                step[k] = r[k]
        steps.append(step)
    ids = {s["id"] for s in steps}
    for s in steps:
        s["depends_on"] = [d for d in dict.fromkeys(s["depends_on"]) if d in ids and d != s["id"]]
    if _has_cycle(steps):
        # Order is the planner's best guess: each step may only wait on earlier ones
        order = {s["id"]: i for i, s in enumerate(steps)}
        for s in steps:
            s["depends_on"] = [d for d in s["depends_on"] if order[d] < order[s["id"]]]
    if review and len(steps) >= 2:
        steps.append(_new_step(
            "review", "合并检查与交叉复查", "（运行时根据各子任务结果生成）",
            acceptance="各子任务的改动完整、相互一致，项目的类型检查和测试通过",
            depends_on=[s["id"] for s in steps], kind="review",
        ))
    assign_steps(steps, snapshot, source_device_id=source_device_id, code=code)
    return steps


def assign_steps(steps: list[dict], snapshot: dict, *, source_device_id: str | None, code: bool) -> None:
    """Device, agent and model for every step not started yet, decided up front: the planner's (or the
    user's) choice when that agent and model can take it, else the best one left, steps spread over the
    devices. A model out of quota (or below MIN_QUOTA) is never picked. Checked again when each step
    starts, in case a quota ran out meanwhile."""
    load: dict[str, int] = {}
    for s in steps:
        if s["status"] != "pending":
            continue
        dev = _device(snapshot, s.get("device_id"))
        if not (dev and s.get("agent") and can_run(snapshot, dev, s["agent"], source_device_id=source_device_id, code=code)):
            pick = choose_assignment(
                snapshot, prefer_agent=s.get("agent") or ("claude" if s.get("kind") == "review" else None),
                prefer_device=s.get("device_id") or None, exclude=s.get("tried"),
                source_device_id=source_device_id, code=code, load=load,
            )
            if not pick:
                s["device_id"], s["device_name"], s["model"] = "", "", ""
                continue
            if pick[1] != s.get("agent"):
                s["model"] = ""
            dev = _device(snapshot, pick[0])
            s["device_id"], s["agent"] = pick
        s["device_name"] = dev["name"]
        s["model"] = step_model(dev["agents"].get(s["agent"]), s.get("model"))
        if s.get("kind") != "review":
            load[dev["device_id"]] = load.get(dev["device_id"], 0) + 1


def excluded_models(snapshot: dict) -> list[dict]:
    """Models left out of this plan for quota, one line per agent and model family, with the devices."""
    rows: dict[tuple[str, str], dict] = {}
    for d in snapshot.get("devices") or []:
        for a, info in (d.get("agents") or {}).items():
            for m, why in (info.get("out") or {}).items():
                key = (a, model_family(a, m))
                row = rows.setdefault(key, {"agent": a, "model": key[1], "reason": why, "devices": []})
                if d["name"] not in row["devices"]:
                    row["devices"].append(d["name"])
    return list(rows.values())


def plan_roster(steps: list[dict]) -> list[dict]:
    """Who takes part: one line per device, agent and model, with its steps."""
    rows: dict[tuple, dict] = {}
    for s in steps:
        if not s.get("agent") or not s.get("device_id"):
            continue
        key = (s["device_id"], s["agent"], s.get("model") or "")
        row = rows.setdefault(key, {"device_id": key[0], "device_name": s.get("device_name") or "", "agent": key[1], "model": key[2], "steps": []})
        row["steps"].append(s["id"])
    return list(rows.values())


async def _blueprint(db, user: User, cwd: str | None) -> str:
    if not cwd:
        return ""
    try:
        from .mind_resonance_service import _fetch_project_blueprint_summary
        return await _fetch_project_blueprint_summary(db, user, None, cwd)
    except Exception as e:
        logger.debug("No blueprint for plan cwd %s: %s", cwd, e)
        return ""


async def make_plan(plan_id: uuid.UUID) -> None:
    """planning -> ready (or running when it starts by itself)."""
    from .ai_provider import call_plain_chat
    from .task_alerts import display_device_name
    from .user_filter import find_machine_by_id_or_hash

    async with async_session_factory() as db:
        plan = await db.get(AgentPlan, plan_id)
        if not plan or plan.status != "planning":
            return
        user = await db.get(User, plan.user_id)
        if not user:
            return
        snapshot = await capability_snapshot(db, user)
        source_name = None
        if plan.source_device_id:
            src = await find_machine_by_id_or_hash(db, plan.source_device_id, user)
            source_name = display_device_name(src.name) if src else None
        blueprint = await _blueprint(db, user, plan.cwd)
        goal, cwd, source, review = plan.goal, plan.cwd, plan.source_device_id, (plan.options or {}).get("review", True)

    note = ""
    title = ""
    steps: list[dict] = []
    try:
        text = await call_plain_chat(
            _planning_messages(goal, snapshot, cwd=cwd, source_name=source_name, blueprint=blueprint),
            temperature=0.2, max_tokens=4000, timeout=240.0, user=user, background=False,
        )
        data = parse_plan_json(text)
        if data:
            title = str(data.get("title") or "").strip()
            note = str(data.get("note") or "").strip()
            steps = normalize_steps(data["steps"], snapshot, source_device_id=source, code=bool(cwd), review=review)
        else:
            logger.warning("Plan %s: planner answered no usable JSON: %s", plan_id, _tail(text, 300))
    except Exception as e:
        logger.warning("Plan %s: planning failed: %s", plan_id, e)
    if not steps:
        note = note or "没能拆分，整个任务交给一个智能体完成"
        steps = normalize_steps([{"id": "s1", "title": goal[:60], "prompt": goal, "acceptance": "任务要求全部做到"}],
                                snapshot, source_device_id=source, code=bool(cwd), review=False)

    def apply(p: AgentPlan, s: list) -> bool:
        if p.status != "planning":
            return False
        s[:] = steps
        p.title = p.title or title or goal[:60]
        p.plan_note = note
        p.options = {**(p.options or {}), "excluded_models": excluded_models(snapshot), "planned_at": _iso(_now())}
        if p.auto_start:
            p.status = "running"
            p.started_at = _now()
        else:
            p.status = "ready"
        return True

    await _mutate(plan_id, apply)


# ── running ─────────────────────────────────────────────────────────────────
async def _mutate(plan_id: uuid.UUID, fn: Callable[[AgentPlan, list], bool | None]) -> AgentPlan | None:
    """Change a plan under its row lock (whichever replica or request does it). fn edits the plan and
    its steps list in place; returning False leaves both as they were."""
    async with async_session_factory() as db:
        plan = (await db.execute(select(AgentPlan).where(AgentPlan.id == plan_id).with_for_update())).scalar_one_or_none()
        if not plan:
            return None
        steps = copy.deepcopy(plan.steps or [])
        if fn(plan, steps) is False:
            await db.rollback()
            return plan
        plan.steps = steps
        flag_modified(plan, "steps")
        plan.updated_at = _now()
        await db.commit()
        await db.refresh(plan)
        return plan


def _step(steps: list, sid: str) -> dict | None:
    return next((s for s in steps if s.get("id") == sid), None)


def build_step_prompt(plan: AgentPlan | Any, step: dict, steps: list[dict]) -> str:
    deps = [s for s in steps if s["id"] in (step.get("depends_on") or [])]
    others = [s for s in steps if s["id"] != step["id"] and s.get("kind") != "review"]
    if step.get("kind") == "review":
        done = "\n\n".join(
            f"### {s['title']}（{AGENT_NAMES.get(s.get('agent'), s.get('agent'))}，{s.get('device_name') or ''}）\n"
            f"验收标准：{s.get('acceptance') or '无'}\n结果：{_tail(s.get('result') or s.get('error') or '无输出', 2500)}"
            + (f"\n改动合并情况：{_workspace_note(s['workspace'])}" if s.get("workspace") else "")
            for s in deps
        )
        return f"""你是这个协作任务最后的复查人。总目标：
{plan.goal}

几个智能体已经分头做完了各自的部分（结果在下面），改动都已在当前目录里（合不进来的在提示的分支上）。请：
1) 通读这些改动，检查是否完整做到总目标、彼此是否一致（接口、命名、调用关系）。
2) 运行项目里已有的类型检查、lint 和测试，发现问题直接修好。
3) 不要 git commit / push。
4) 最后用中文简洁汇报：整体是否完成、你修了什么、测试结果、还剩什么问题。

各子任务结果：
{done}"""
    parts = [f"这是一个协作任务中的一个子任务。总目标（供理解背景）：\n{plan.goal}\n", f"你负责的子任务：{step['title']}\n{step['prompt']}"]
    if step.get("acceptance"):
        parts.append(f"验收标准：{step['acceptance']}")
    if others:
        parts.append("其他智能体同时在做这些部分，不要动它们负责的内容：\n" + "\n".join(f"- {s['title']}" for s in others))
    if deps:
        parts.append("你依赖的前置子任务已完成，结果如下：\n" + "\n\n".join(
            f"### {s['title']}\n{_tail(s.get('result') or '', 2000)}" for s in deps))
    if step.get("history"):
        last = step["history"][-1]
        parts.append(f"上一次尝试（{AGENT_NAMES.get(last.get('agent'), last.get('agent'))}）没有成功：{_tail(last.get('error') or '', 800)}\n这次请换个思路完成。")
    parts.append("要求：只做你负责的部分；不要 git commit / push；做完按验收标准自检。最后用中文简洁说明做了什么、改了哪些文件、验收结果。")
    return "\n\n".join(parts)


def _workspace_note(ws: dict | None) -> str:
    if not ws:
        return ""
    st = ws.get("status")
    if st == "applied":
        return f"已合回源目录（{ws.get('files') or 0} 个文件）"
    if st == "conflict":
        return f"和源目录有冲突，改动放在分支 {ws.get('branch') or '?'}"
    if st == "saved":
        return f"改动另存在 {ws.get('branch') or ws.get('patch_path') or '源设备'}"
    if st == "pending":
        return "源设备离线，改动等它上线后自动送回"
    if st == "unchanged":
        return "没有改动文件"
    return f"改动没能送回：{ws.get('error') or st}"


def _workspace_outcome(events: list | None) -> dict | None:
    out = None
    for e in events or []:
        if isinstance(e, dict) and e.get("kind") == "workspace" and e.get("status") not in ("syncing", "synced"):
            out = {
                "status": e.get("status"), "branch": e.get("branch"), "patch_path": e.get("patch_path"),
                "files": len(e.get("files") or []), "error": e.get("error"),
            }
    return out


async def _step_args(db, user: User, plan: AgentPlan, step: dict, steps: list[dict]) -> dict:
    from .ask_stream import _workspace_spec
    args: dict[str, Any] = {
        "action": "agent",
        "device_id": step["device_id"],
        "binary": _BINARY.get(step.get("agent") or "claude", "claude"),
        "prompt": build_step_prompt(plan, step, steps),
        "title": f"{plan.title or plan.goal[:40]} · {step['title']}"[:120],
        "user_question": step["title"],
        "timeout_seconds": int((plan.options or {}).get("step_timeout") or STEP_TIMEOUT),
    }
    if step.get("model"):
        args["model"] = step["model"]
    if plan.project_id:
        args["project_id"] = plan.project_id
    if plan.cwd:
        args["cwd"] = plan.cwd
        if plan.source_device_id:
            ws = await _workspace_spec(db, user, step["device_id"], plan.source_device_id, plan.cwd)
            if ws:
                args["workspace"] = ws
    return args


def _result_of(res: dict | None) -> tuple[bool, dict]:
    """(succeeded, what to keep on the step) from run_on_device's result."""
    res = res or {}
    status = res.get("status") or ("failed" if res.get("error") else "")
    ok = status in ("succeeded", "still_running") and not (res.get("exit_code") not in (None, 0))
    kept = {
        "status": status or "failed",
        "result": _tail(res.get("stdout") or "", 6000) or None,
        "error": None if ok else (_tail(res.get("error") or res.get("stderr") or res.get("note") or "没有结果", 300 if status == "timeout" else 2000)),
        "error_type": res.get("error_type"),
        "workspace": _workspace_outcome(res.get("events")),
        "session_id": res.get("session_id"),
    }
    return ok, kept


async def _finish_step(plan_id: uuid.UUID, sid: str, attempt: int, res: dict | None) -> None:
    ok, kept = _result_of(res)

    def apply(p: AgentPlan, steps: list) -> bool:
        s = _step(steps, sid)
        if not s or s["status"] != "running" or s["attempts"] != attempt:
            return False  # stopped, retried or finished by someone else meanwhile
        s["finished_at"] = _iso(_now())
        s["result"] = kept["result"]
        s["workspace"] = kept["workspace"]
        s["session_id"] = kept["session_id"]
        if ok:
            s["status"] = "succeeded"
            s["error"] = None
            return True
        if kept["status"] == "cancelled":
            s["status"] = "cancelled"
            s["error"] = "已停止"
            return True
        s["error"] = kept["error"]
        s["history"] = (s.get("history") or []) + [{
            "attempt": attempt, "device_id": s["device_id"], "device_name": s.get("device_name"), "agent": s["agent"],
            "model": s.get("model") or "", "task_id": s.get("task_id"), "error": kept["error"], "error_type": kept["error_type"], "status": kept["status"],
            "at": s["finished_at"],
        }]
        s["tried"] = (s.get("tried") or []) + [[s["device_id"], s["agent"]]]
        if attempt < MAX_ATTEMPTS:
            # Picked again when it starts: another agent or device than the ones that failed it
            s["status"] = "pending"
            s["task_id"] = None
            s["device_id"] = ""
            s["agent"] = ""
            s["model"] = ""
        else:
            s["status"] = "failed"
        return True

    await _mutate(plan_id, apply)


async def _run_step(plan_id: uuid.UUID, sid: str, attempt: int) -> None:
    """Send the step to its device and follow it to the end (on this replica)."""
    from .orchestrator import _tool_run_on_device

    result: dict | None = None
    try:
        async with async_session_factory() as db:
            plan = await db.get(AgentPlan, plan_id)
            user = await db.get(User, plan.user_id) if plan else None
            step = _step(plan.steps or [], sid) if plan else None
            if not plan or not user or not step or step["status"] != "running" or step["attempts"] != attempt:
                return
            args = await _step_args(db, user, plan, step, plan.steps or [])
            recorded = False
            async for evt in _tool_run_on_device(db, user, args):
                if evt.get("type") == "task_progress" and evt.get("task_id") and not recorded:
                    recorded = True
                    tid, name = str(evt["task_id"]), evt.get("device_name") or ""

                    def started(p: AgentPlan, steps: list, tid=tid, name=name) -> bool:
                        s = _step(steps, sid)
                        if not s or s["status"] != "running" or s["attempts"] != attempt:
                            return False
                        s["task_id"] = tid
                        if name:
                            from .task_alerts import display_device_name
                            s["device_name"] = display_device_name(name) or name
                        return True

                    await _mutate(plan_id, started)
                elif evt.get("type") == "tool_result":
                    result = evt.get("result")
    except asyncio.CancelledError:
        raise  # the replica is going: the device keeps the task, the next lease holder follows it
    except Exception as e:
        logger.exception("Plan %s step %s failed to run: %s", plan_id, sid, e)
        result = {"status": "failed", "error": f"派发出错：{e}"}
    await _finish_step(plan_id, sid, attempt, result)


async def _watch_task(plan_id: uuid.UUID, sid: str, attempt: int, task_id: str) -> None:
    """A step's device task sent before this replica took over: followed in the database."""
    from .agent_limits import mark_usage_limit

    try:
        tid = uuid.UUID(task_id)
    except ValueError:
        await _finish_step(plan_id, sid, attempt, {"status": "failed", "error": "任务号无效"})
        return
    while True:
        async with async_session_factory() as db:
            t = await db.get(DeviceTask, tid)
        if not t:
            await _finish_step(plan_id, sid, attempt, {"status": "failed", "error": "设备任务不见了"})
            return
        if t.status in ("succeeded", "failed", "timeout", "cancelled", "still_running"):
            res = {
                "action": "agent", "status": t.status, "exit_code": t.exit_code, "stdout": t.stdout,
                "stderr": t.stderr, "error": t.error, "events": t.events or [], "session_id": t.session_id,
            }
            await _finish_step(plan_id, sid, attempt, mark_usage_limit(res))
            return
        created = t.created_at if t.created_at.tzinfo else t.created_at.replace(tzinfo=timezone.utc)
        if t.status == "queued" and not t.dispatched_at and _now() - created > LOST_DISPATCH:
            await _finish_step(plan_id, sid, attempt, {"status": "failed", "error": "任务没有送到设备"})
            return
        limit = (t.timeout_seconds or 0) + 900
        if t.timeout_seconds and _now() - created > timedelta(seconds=limit):
            await _finish_step(plan_id, sid, attempt, {"status": "timeout", "error": "设备超过时限没有回报结果"})
            return
        await asyncio.sleep(TICK_SECONDS)


def _spawn(key: str, coro) -> None:
    task = asyncio.create_task(coro)
    _local[key] = task
    task.add_done_callback(lambda t, k=key: _local.pop(k, None) if _local.get(k) is t else None)


def plan_progress(steps: list[dict]) -> dict:
    """Which steps can start now, which can never run, whether everything is over."""
    status = {s["id"]: s["status"] for s in steps}
    blocked = [s["id"] for s in steps if s["status"] == "pending"
               and any(status.get(d) in ("failed", "cancelled", "skipped") for d in s.get("depends_on") or [])]
    ready = [s["id"] for s in steps if s["status"] == "pending" and s["id"] not in blocked
             and all(status.get(d) == "succeeded" for d in s.get("depends_on") or [])]
    over = all(st in STEP_DONE for sid, st in status.items() if sid not in blocked)
    return {"ready": ready, "blocked": blocked, "over": over and bool(steps)}


async def _advance(plan_id: uuid.UUID) -> None:
    """One pass over a running plan: follow, skip, start what can start, close it when it's over."""
    async with async_session_factory() as db:
        plan = await db.get(AgentPlan, plan_id)
        if not plan or plan.status != "running":
            return
        user = await db.get(User, plan.user_id)
        steps = copy.deepcopy(plan.steps or [])
        if not user:
            return
        now = _now()
        for s in steps:
            key = f"{plan_id}/{s['id']}"
            if s["status"] != "running" or key in _local:
                continue
            if s.get("task_id"):
                _spawn(key, _watch_task(plan_id, s["id"], s["attempts"], s["task_id"]))
            elif (started := _parse_time(s.get("started_at"))) and now - started > LOST_DISPATCH:
                attempt = s["attempts"]

                def lost(p: AgentPlan, st: list, sid=s["id"], attempt=attempt) -> bool:
                    x = _step(st, sid)
                    if not x or x["status"] != "running" or x["attempts"] != attempt or x.get("task_id"):
                        return False
                    x["status"] = "pending"
                    x["attempts"] = max(0, attempt - 1)
                    return True

                await _mutate(plan_id, lost)

        prog = plan_progress(steps)
        if prog["blocked"]:
            def skip(p: AgentPlan, st: list) -> bool:
                for x in st:
                    if x["id"] in prog["blocked"] and x["status"] == "pending":
                        x["status"] = "skipped"
                        x["error"] = "前置子任务没有完成"
                return True

            await _mutate(plan_id, skip)
            return  # the rest next pass, on the new state
        if prog["over"]:
            def closing(p: AgentPlan, st: list) -> bool:
                if p.status != "running":
                    return False
                p.status = "integrating"
                return True

            if await _mutate(plan_id, closing):
                _spawn(str(plan_id), _finalize(plan_id))
            return
        if not prog["ready"]:
            return

        parallel = int((plan.options or {}).get("max_parallel") or DEFAULT_PARALLEL)
        running = sum(1 for s in steps if s["status"] == "running")
        if running >= parallel:
            return
        snapshot = await capability_snapshot(db, user)
        # The code's own device works right in its directory: one step there at a time
        direct_busy = any(s["status"] == "running" and plan.cwd and s.get("device_id") == plan.source_device_id for s in steps)
        load: dict[str, int] = {}
        penalty = agent_penalty(steps)
        starts: list[tuple[str, str, str, str]] = []
        waiting: list[str] = []
        for sid in prog["ready"]:
            if running + len(starts) >= parallel:
                break
            s = _step(steps, sid)
            pick = None
            dev = _device(snapshot, s.get("device_id"))
            # The planned (or last) agent, unless it already failed in this plan: then picked afresh
            if dev and s.get("agent") and [dev["device_id"], s["agent"]] not in (s.get("tried") or []) \
                    and not penalty.get(s["agent"]) and can_run(snapshot, dev, s["agent"], source_device_id=plan.source_device_id, code=bool(plan.cwd)):
                pick = (dev["device_id"], s["agent"])
            if not pick:
                pick = choose_assignment(
                    snapshot, prefer_agent=s.get("agent") or ("claude" if s.get("kind") == "review" else None),
                    exclude=s.get("tried"), source_device_id=plan.source_device_id, code=bool(plan.cwd), load=load,
                    penalty=penalty,
                )
            if not pick:
                waiting.append(sid)
                continue
            if plan.cwd and pick[0] == plan.source_device_id:
                if direct_busy:
                    continue
                direct_busy = True
            load[pick[0]] = load.get(pick[0], 0) + 1
            picked = _device(snapshot, pick[0]) or {}
            same = pick[0] == s.get("device_id") and pick[1] == s.get("agent")
            # The planned model, unless its quota ran out since; another agent gets its own pick
            model = step_model((picked.get("agents") or {}).get(pick[1]), s.get("model") if same else None)
            starts.append((sid, pick[0], pick[1], picked.get("name") or "", model))

    if waiting:
        def wait(p: AgentPlan, st: list) -> bool:
            changed = False
            for x in st:
                if x["id"] not in waiting or x["status"] != "pending":
                    continue
                since = _parse_time(x.get("waiting_since"))
                if not since:
                    x["waiting_since"] = _iso(_now())
                    x["error"] = "暂时没有可用的设备和智能体，等它们上线或额度恢复"
                    changed = True
                elif _now() - since > WAIT_FOR_DEVICE:
                    x["status"] = "failed"
                    x["error"] = "等了 30 分钟仍没有可用的设备和智能体（离线或额度用完）"
                    changed = True
            return changed

        await _mutate(plan_id, wait)

    for sid, device_id, agent, name, model in starts:
        def start(p: AgentPlan, st: list, sid=sid, device_id=device_id, agent=agent, name=name, model=model) -> bool:
            x = _step(st, sid)
            if p.status != "running" or not x or x["status"] != "pending":
                return False
            x.update(status="running", device_id=device_id, agent=agent, device_name=name, model=model, task_id=None,
                     attempts=x["attempts"] + 1, started_at=_iso(_now()), finished_at=None, error=None)
            x.pop("waiting_since", None)
            return True

        p = await _mutate(plan_id, start)
        x = _step(p.steps or [], sid) if p else None
        if x and x["status"] == "running" and x["device_id"] == device_id and not x.get("task_id"):
            _spawn(f"{plan_id}/{sid}", _run_step(plan_id, sid, x["attempts"]))


def _summary_messages(plan: AgentPlan) -> list[dict]:
    body = "\n\n".join(
        f"### {s['title']}（{s['status']}，{AGENT_NAMES.get(s.get('agent'), s.get('agent') or '')}，{s.get('device_name') or ''}）\n"
        f"{_tail(s.get('result') or s.get('error') or '', 2500)}"
        + (f"\n改动：{_workspace_note(s['workspace'])}" if s.get("workspace") else "")
        for s in plan.steps or []
    )
    return [
        {"role": "system", "content": "你在给用户汇报一个多智能体协作任务的最终结果。用中文，直接给结论：整体完成了没有、每部分做了什么、改动合到了哪里、测试结果、还剩什么没做或要用户处理的。简洁，不要客套，不用加粗符号，编号用 1) 2)。"},
        {"role": "user", "content": f"总目标：\n{plan.goal}\n\n各子任务结果：\n{body}"},
    ]


async def _finalize(plan_id: uuid.UUID) -> None:
    from .ai_provider import call_plain_chat
    from .notify_service import notify_user

    async with async_session_factory() as db:
        plan = await db.get(AgentPlan, plan_id)
        if not plan or plan.status != "integrating":
            return
        user = await db.get(User, plan.user_id)
        steps = plan.steps or []
        all_ok = all(s["status"] == "succeeded" for s in steps)
        summary = None
        try:
            summary = await call_plain_chat(_summary_messages(plan), temperature=0.2, max_tokens=1500, timeout=180.0, user=user)
        except Exception as e:
            logger.warning("Plan %s: summary failed: %s", plan_id, e)
        if not summary:
            summary = "\n".join(f"{i}) {s['title']}：{'完成' if s['status'] == 'succeeded' else (s.get('error') or s['status'])}"
                                for i, s in enumerate(steps, 1))
        title, user_id = plan.title or plan.goal[:40], plan.user_id

    def done(p: AgentPlan, st: list) -> bool:
        if p.status != "integrating":
            return False
        p.status = "succeeded" if all_ok else "failed"
        p.summary = summary
        p.finished_at = _now()
        if not all_ok:
            bad = [s["title"] for s in st if s["status"] != "succeeded"]
            p.error = "没完成的子任务：" + "、".join(bad)
        return True

    if await _mutate(plan_id, done):
        try:
            await notify_user(
                user_id, "task_done", f"协作任务{'完成' if all_ok else '结束（有子任务没完成）'}：{title}",
                _tail(summary, 300), url=f"/plans/{plan_id}",
            )
        except Exception as e:
            logger.warning("Plan %s: notify failed: %s", plan_id, e)


async def tick() -> None:
    async with async_session_factory() as db:
        rows = (await db.execute(select(AgentPlan.id, AgentPlan.status).where(AgentPlan.status.in_(OPEN)))).all()
    for pid, status in rows:
        try:
            if status == "planning":
                if str(pid) not in _local:
                    _spawn(str(pid), make_plan(pid))
            elif status == "integrating":
                if str(pid) not in _local:
                    _spawn(str(pid), _finalize(pid))
            else:
                await _advance(pid)
        except Exception as e:
            logger.exception("Plan %s: scheduling pass failed: %s", pid, e)


async def _loop() -> None:
    while _running:
        try:
            async with cluster.leased("plans", ttl=60.0) as mine:
                if mine:
                    await tick()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.exception("Plan runner pass failed: %s", e)
        await asyncio.sleep(TICK_SECONDS)


async def start_plan_runner() -> None:
    global _runner, _running
    if _runner is None:
        _running = True
        _runner = asyncio.create_task(_loop())


async def hand_over_plans() -> None:
    """Shutdown, before ask_runs.drain: start no more steps here and let a replica that stays (running
    the new code) take the scheduling over at once. Steps already followed here go on until
    stop_plan_runner; the new holder follows the same device tasks from the database meanwhile and
    whichever sees the result first records it (the other finds the step done and leaves it)."""
    global _runner, _running
    _running = False
    if _runner:
        _runner.cancel()
        await asyncio.gather(_runner, return_exceptions=True)
        _runner = None
    await cluster.release_lease("plans")


async def stop_plan_runner() -> None:
    """After ask_runs.drain: the device tasks of steps cut short here keep going (shutting_down), the
    replica taking the lease over follows them from the database."""
    from .ask_runs import ask_runs

    global _runner, _running
    _running = False
    if _runner:
        _runner.cancel()
        _runner = None
    # The steps' device tasks must survive the cancel below. drain returns early without marking the
    # shutdown when no ask run was going, and the cancelled dispatch then stopped the task on the
    # device (11-12: a step cut off a minute in by a deploy).
    ask_runs.shutting_down = True
    tasks = list(_local.values())
    for t in tasks:
        t.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    _local.clear()


# ── user actions ────────────────────────────────────────────────────────────
async def create_plan(db, user: User, goal: str, *, cwd: str | None = None, source_device_id: str | None = None,
                      project_id: str | None = None, auto_start: bool = True, title: str = "",
                      options: dict | None = None) -> AgentPlan:
    from .user_filter import find_machine_by_id_or_hash

    source = None
    if source_device_id:
        m = await find_machine_by_id_or_hash(db, source_device_id, user)
        source = m.collector_token_hash if m else None
    plan = AgentPlan(
        user_id=user.id, goal=goal.strip(), title=title.strip()[:255], cwd=(cwd or "").strip() or None,
        source_device_id=source, project_id=project_id, auto_start=auto_start, options=options or {},
        status="planning", steps=[],
    )
    db.add(plan)
    await db.commit()
    await db.refresh(plan)
    return plan


async def _cancel_device_task(task_id: str | None) -> None:
    from .ws_manager import ws_manager

    if not task_id:
        return
    try:
        tid = uuid.UUID(task_id)
    except ValueError:
        return
    async with async_session_factory() as db:
        t = await db.get(DeviceTask, tid)
        if not t or t.status in ("succeeded", "failed", "timeout", "cancelled"):
            return
        await ws_manager.send_cancel(t.device_id, task_id)
        await db.execute(update(DeviceTask).where(DeviceTask.id == tid, DeviceTask.status.in_(("queued", "running", "still_running")))
                         .values(status="cancelled", finished_at=_now()))
        await db.commit()


async def cancel_plan(plan_id: uuid.UUID) -> AgentPlan | None:
    stop: list[str] = []

    def apply(p: AgentPlan, st: list) -> bool:
        if p.status in DONE:
            return False
        for x in st:
            if x["status"] == "running":
                stop.append(x.get("task_id"))
            if x["status"] in ("pending", "running"):
                x["status"] = "cancelled"
                x["error"] = "已停止"
                x["finished_at"] = _iso(_now())
        p.status = "cancelled"
        p.finished_at = _now()
        return True

    plan = await _mutate(plan_id, apply)
    for tid in stop:
        await _cancel_device_task(tid)
    return plan


async def cancel_step(plan_id: uuid.UUID, sid: str) -> AgentPlan | None:
    stop: list[str] = []

    def apply(p: AgentPlan, st: list) -> bool:
        x = _step(st, sid)
        if not x or x["status"] not in ("pending", "running"):
            return False
        if x["status"] == "running":
            stop.append(x.get("task_id"))
        x["status"] = "cancelled"
        x["error"] = "已停止"
        x["finished_at"] = _iso(_now())
        return True

    plan = await _mutate(plan_id, apply)
    for tid in stop:
        await _cancel_device_task(tid)
    return plan


async def retry_step(plan_id: uuid.UUID, sid: str) -> AgentPlan | None:
    def apply(p: AgentPlan, st: list) -> bool:
        x = _step(st, sid)
        if not x or x["status"] not in ("failed", "cancelled", "skipped"):
            return False
        again = {sid}
        # Steps that were skipped because of it run too, once it's done
        changed = True
        while changed:
            changed = False
            for y in st:
                if y["id"] not in again and y["status"] == "skipped" and set(y.get("depends_on") or []) & again:
                    again.add(y["id"])
                    changed = True
        if x.get("kind") != "review":
            review = _step(st, "review")
            if review and review["status"] in ("succeeded", "skipped", "failed", "cancelled"):
                again.add("review")
        for y in st:
            if y["id"] in again:
                y.update(status="pending", attempts=0, tried=[], task_id=None, error=None, finished_at=None)
                y.pop("waiting_since", None)
        if p.status in DONE or p.status == "integrating":
            p.status = "running"
            p.finished_at = None
            p.error = None
        return True

    return await _mutate(plan_id, apply)


async def start_plan(plan_id: uuid.UUID) -> AgentPlan | None:
    def apply(p: AgentPlan, st: list) -> bool:
        if p.status != "ready":
            return False
        p.status = "running"
        p.started_at = _now()
        return True

    return await _mutate(plan_id, apply)


async def replan(plan_id: uuid.UUID) -> AgentPlan | None:
    def apply(p: AgentPlan, st: list) -> bool:
        if p.status not in ("ready", "failed", "cancelled"):
            return False
        st[:] = []
        p.status = "planning"
        p.plan_note = None
        p.summary = None
        p.error = None
        p.finished_at = None
        return True

    return await _mutate(plan_id, apply)


async def edit_steps(db, user: User, plan_id: uuid.UUID, raw: list) -> AgentPlan | None:
    """The user's own version of the plan, before it starts."""
    plan = await db.get(AgentPlan, plan_id)
    if not plan:
        return None
    snapshot = await capability_snapshot(db, user)
    steps = normalize_steps(raw, snapshot, source_device_id=plan.source_device_id, code=bool(plan.cwd),
                            review=(plan.options or {}).get("review", True))

    def apply(p: AgentPlan, st: list) -> bool:
        if p.status != "ready":
            return False
        st[:] = steps
        return True

    return await _mutate(plan_id, apply)


def plan_out(plan: AgentPlan, *, full: bool = True) -> dict:
    steps = plan.steps or []
    counts: dict[str, int] = {}
    for s in steps:
        counts[s["status"]] = counts.get(s["status"], 0) + 1
    out = {
        "id": str(plan.id),
        "title": plan.title or plan.goal[:60],
        "goal": plan.goal,
        "status": plan.status,
        "auto_start": plan.auto_start,
        "cwd": plan.cwd,
        "source_device_id": plan.source_device_id,
        "project_id": plan.project_id,
        "options": plan.options or {},
        "plan_note": plan.plan_note,
        "summary": plan.summary,
        "error": plan.error,
        "step_counts": counts,
        "step_total": len(steps),
        "created_at": _iso(plan.created_at),
        "updated_at": _iso(plan.updated_at),
        "started_at": _iso(plan.started_at),
        "finished_at": _iso(plan.finished_at),
    }
    out["roster"] = plan_roster(steps)
    if full:
        out["steps"] = steps
    return out
