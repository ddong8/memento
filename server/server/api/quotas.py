"""API endpoints and coordinator cache for AI subscription tool quotas (Antigravity, Claude Code, OpenAI Codex)."""

import asyncio
from datetime import datetime, timezone
import logging
from typing import Any
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Machine, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.cluster import SharedDict, cluster
from ..services.ws_manager import ws_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agent/quotas", tags=["quotas"])
compat_router = APIRouter(prefix="/api/quotas", tags=["quotas"])
raw_router = APIRouter(prefix="/agent/quotas", tags=["quotas"])
raw_compat_router = APIRouter(prefix="/quotas", tags=["quotas"])

# Live agent quotas reported by connected devices (whichever replica they're on)
# Key: device_id | machine_name | machine_id
_device_quotas = SharedDict(cluster, "device_quotas")


def set_cached_device_quotas(
    device_id: str,
    report: dict[str, Any],
    machine_name: str | None = None,
    machine_id: str | None = None,
) -> None:
    """Store reported quotas into coordinator memory."""
    if not isinstance(report, dict):
        return

    report_with_meta = {
        **report,
        "device_id": device_id,
        "device_name": machine_name or device_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    _device_quotas.set((device_id, machine_name, machine_id), report_with_meta)


def get_cached_device_quotas(device_id: str | None = None) -> dict[str, Any] | None:
    """Lookup cached quotas for a specific device, or the most recent valid report."""
    reports = _device_quotas.data
    if device_id and device_id not in ("auto", "ask_only", "all"):
        if device_id in reports:
            return reports[device_id]
        for k, v in reports.items():
            if device_id.lower() in k.lower() or k.lower() in device_id.lower():
                return v
        return None

    # The latest report from any device (only when no specific device is requested)
    return max(reports.values(), key=lambda r: str(r.get("updated_at") or ""), default=None)


def _make_fallback_report(device_id: str | None = None, device_name: str | None = None) -> dict[str, Any]:
    """Generates an initial structure if no device has reported real quotas yet."""
    return {
        "device_id": device_id or "auto",
        "device_name": device_name or "当前设备",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "is_fallback": True,
        "tools": {
            "antigravity": {
                "tool": "antigravity",
                "name": "Google Antigravity",
                "available": False,
                "remaining_percent": None,
                "error": "未接收到设备实时额度上报，请确认本地服务运行并刷新",
            },
            "claude_code": {
                "tool": "claude_code",
                "name": "Claude Code",
                "available": False,
                "remaining_percent": None,
                "error": "未接收到设备实时额度上报，请确认本地服务运行并刷新",
            },
            "codex": {
                "tool": "codex",
                "name": "OpenAI Codex",
                "available": False,
                "remaining_percent": None,
                "error": "未接收到设备实时额度上报，请确认本地服务运行并刷新",
            },
            "workbuddy": {
                "tool": "workbuddy",
                "name": "WorkBuddy",
                "available": False,
                "remaining_percent": None,
                "error": "未接收到设备实时额度上报，请确认本地服务运行并刷新",
            },
        },
    }


@router.get("")
@compat_router.get("")
@raw_router.get("")
@raw_compat_router.get("")
async def get_agent_quotas(
    device_id: str | None = Query(None, description="Optional target device ID or name"),
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Fetch live or cached quota usage across all AI subscription tools (Antigravity, Claude Code, Codex)."""
    # 1. Check in-memory cache
    cached = get_cached_device_quotas(device_id)
    if cached:
        return cached

    # 2. Try to query online machine
    machine_name = None
    target_mid = None
    is_specific = bool(device_id and device_id not in ("auto", "ask_only", "all"))
    if is_specific:
        try:
            conditions = [
                Machine.name == device_id,
                Machine.collector_token_hash == device_id,
            ]
            try:
                device_uuid = uuid.UUID(device_id)
                conditions.append(Machine.id == device_uuid)
            except (ValueError, AttributeError):
                pass
            m_row = (await db.execute(
                select(Machine).where(or_(*conditions))
            )).scalars().first()
            if m_row:
                machine_name = m_row.name
                target_mid = str(m_row.id)
                cached = (
                    get_cached_device_quotas(m_row.collector_token_hash)
                    or (get_cached_device_quotas(m_row.name) if m_row.name else None)
                    or get_cached_device_quotas(str(m_row.id))
                )
                if cached:
                    return cached
        except Exception as e:
            logger.warning("Error querying machine for quotas (%s): %s", device_id, e)

    # 3. If online device is connected to WebSocket, trigger an async request
    try:
        dispatched = False
        if is_specific:
            target_key = None
            if target_mid and ws_manager.is_online(target_mid):
                target_key = target_mid
            elif device_id and ws_manager.is_online(device_id):
                target_key = device_id
            if target_key:
                await ws_manager.send_json(target_key, {"type": "get_agent_quotas"})
                dispatched = True
        elif ws_manager.has_online_devices():
            # broadcast to any online device when no specific device is targeted
            await ws_manager.broadcast({"type": "get_agent_quotas"})
            dispatched = True

        if dispatched:
            for _ in range(10):
                await asyncio.sleep(0.1)
                cached = get_cached_device_quotas(device_id)
                if not cached and target_mid:
                    cached = get_cached_device_quotas(target_mid)
                if not cached and machine_name:
                    cached = get_cached_device_quotas(machine_name)
                if cached:
                    return cached
    except Exception as e:
        logger.warning("Error dispatching get_agent_quotas over ws: %s", e)

    # Return fallback or initial report
    return _make_fallback_report(device_id=device_id, device_name=machine_name)


@router.post("/refresh")
@compat_router.post("/refresh")
@raw_router.post("/refresh")
@raw_compat_router.post("/refresh")
async def refresh_agent_quotas(
    device_id: str | None = Query(None, description="Optional target device ID to refresh"),
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Instruct online devices to immediately re-probe AI subscription quotas and return fresh report."""
    machine_name = None
    target_mid = None
    is_specific = bool(device_id and device_id not in ("auto", "ask_only", "all"))
    if is_specific:
        try:
            conditions = [
                Machine.name == device_id,
                Machine.collector_token_hash == device_id,
            ]
            try:
                device_uuid = uuid.UUID(device_id)
                conditions.append(Machine.id == device_uuid)
            except (ValueError, AttributeError):
                pass
            m_row = (await db.execute(
                select(Machine).where(or_(*conditions))
            )).scalars().first()
            if m_row:
                machine_name = m_row.name
                target_mid = str(m_row.id)
        except Exception as e:
            logger.warning("Error querying machine for quota refresh (%s): %s", device_id, e)

    # Dispatch request to WS clients
    dispatched = False
    try:
        if is_specific:
            target_key = None
            if target_mid and ws_manager.is_online(target_mid):
                target_key = target_mid
            elif device_id and ws_manager.is_online(device_id):
                target_key = device_id
            if target_key:
                await ws_manager.send_json(target_key, {"type": "get_agent_quotas"})
                dispatched = True
        else:
            await ws_manager.broadcast({"type": "get_agent_quotas"})
            dispatched = True
    except Exception as e:
        logger.warning("Error dispatching refresh_agent_quotas over ws: %s", e)

    # Wait up to 1.5s for response
    if dispatched:
        for _ in range(15):
            await asyncio.sleep(0.1)
            cached = get_cached_device_quotas(device_id)
            if not cached and target_mid:
                cached = get_cached_device_quotas(target_mid)
            if not cached and machine_name:
                cached = get_cached_device_quotas(machine_name)
            if cached:
                return cached

    res = get_cached_device_quotas(device_id)
    if not res and target_mid:
        res = get_cached_device_quotas(target_mid)
    if not res and machine_name:
        res = get_cached_device_quotas(machine_name)
    return res or _make_fallback_report(device_id=device_id, device_name=machine_name)
