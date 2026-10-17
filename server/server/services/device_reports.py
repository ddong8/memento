"""What connected devices report about themselves: agent capabilities (tools,
models, environment) and AI subscription quotas.

A device reports to whichever api replica holds its WebSocket; the reports are
kept in SharedDicts (services/cluster.py) so every replica answers the same.
Each device is recorded under every name it goes by, together with the user it
belongs to: admins and the owner see every device's reports, other users only
those of their own devices.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timezone
from typing import Any

from ..db.models import User
from .cluster import SharedDict, cluster

_capabilities = SharedDict(cluster, "device_capabilities")
_quotas = SharedDict(cluster, "device_quotas")
_owners = SharedDict(cluster, "device_owners")


def record_owner(names: Iterable[str | None], user_id: str | None) -> None:
    """Remember who a device belongs to, under each of its names."""
    _owners.set(names, user_id)


def visible_to(name: str, user: User | None) -> bool:
    """Admins and the owner see every device's reports, other users only their own."""
    if user is None or user.role in ("admin", "owner"):
        return True
    return _owners.data.get(name) == str(user.id)


def _visible(reports: dict[str, Any], user: User | None) -> dict[str, Any]:
    return {k: v for k, v in reports.items() if visible_to(k, user)}


# ── capabilities ──────────────────────────────────────────────────────────
def set_device_capabilities(names: Iterable[str | None], caps: dict) -> None:
    _capabilities.set(names, caps)


def get_cached_device_capabilities(
    device_id: str | None = None, tool: str | None = None, user: User | None = None,
) -> dict | None:
    reports = _visible(_capabilities.data, user)
    if not device_id or device_id in ("auto", "ask_only"):
        for caps in reports.values():
            if tool:
                if tool in caps:
                    return caps[tool]
            else:
                return caps
        return None

    caps = reports.get(device_id)
    if not caps:
        for k, v in reports.items():
            if k == device_id or device_id.startswith(k) or k.startswith(device_id):
                caps = v
                break

    if not caps:
        return None
    if tool:
        return caps.get(tool)
    return caps


def get_device_environment_summary(device_id: str | None = None, user: User | None = None) -> str | None:
    """Format a compact environment profile string for system prompts and tool contexts."""
    caps = get_cached_device_capabilities(device_id, user=user)
    if not caps or not isinstance(caps, dict):
        return None
    env = caps.get("environment")
    if not env or not isinstance(env, dict):
        return None

    plat = env.get("platform") or ""
    arch = env.get("arch") or ""
    shell = env.get("shell") or ""
    username = env.get("username") or ""
    tools_dict = env.get("tools") or {}
    active_tools = [f"{k}: {v}" for k, v in tools_dict.items() if v]

    lines = [
        f"系统平台: {plat} ({arch}) | 默认 Shell: {shell} | 当前用户: {username}",
    ]
    if active_tools:
        lines.append(f"已就绪工具链: {', '.join(active_tools)}")
    workspaces = env.get("workspaces") or []
    if workspaces:
        lines.append(f"常用工作区路径: {', '.join(workspaces[:3])}")
    lines.append("提示: 目标设备已就绪上述环境与工具，执行命令时直接调用对应环境，无需重复运行 which/--version 探查。")
    return "\n".join(lines)


# ── quotas ────────────────────────────────────────────────────────────────
def set_cached_device_quotas(
    device_id: str,
    report: dict[str, Any],
    machine_name: str | None = None,
    machine_id: str | None = None,
) -> None:
    """Store a device's reported quotas."""
    if not isinstance(report, dict):
        return

    report_with_meta = {
        **report,
        "device_id": device_id,
        "device_name": machine_name or device_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    _quotas.set((device_id, machine_name, machine_id), report_with_meta)


def get_cached_device_quotas(device_id: str | None = None, user: User | None = None) -> dict[str, Any] | None:
    """Lookup cached quotas for a specific device, or the most recent report the user may see."""
    reports = _visible(_quotas.data, user)
    if device_id and device_id not in ("auto", "ask_only", "all"):
        if device_id in reports:
            return reports[device_id]
        for k, v in reports.items():
            if device_id.lower() in k.lower() or k.lower() in device_id.lower():
                return v
        return None

    # The latest report from any visible device (only when no specific device is requested)
    return max(reports.values(), key=lambda r: str(r.get("updated_at") or ""), default=None)
