"""API endpoints for AI subscription tool quotas (Antigravity, Claude Code, OpenAI Codex).

Devices report their quotas over their WebSocket; the reports are kept in
services/device_reports.py. Users only see, and can only probe, their own
devices (admins and the owner: all of them).
"""

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
from ..services.device_reports import get_cached_device_quotas
from ..services.ws_manager import ws_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agent/quotas", tags=["quotas"])
compat_router = APIRouter(prefix="/api/quotas", tags=["quotas"])
raw_router = APIRouter(prefix="/agent/quotas", tags=["quotas"])
raw_compat_router = APIRouter(prefix="/quotas", tags=["quotas"])

def _sees_all(user: User) -> bool:
    return user.role in ("admin", "owner")


async def _find_machine(db: AsyncSession, user: User, device_id: str) -> Machine | None:
    """The device by name, collector hash or id, among those the user may see."""
    conditions = [
        Machine.name == device_id,
        Machine.collector_token_hash == device_id,
    ]
    try:
        conditions.append(Machine.id == uuid.UUID(device_id))
    except (ValueError, AttributeError):
        pass
    query = select(Machine).where(or_(*conditions))
    if not _sees_all(user):
        query = query.where(Machine.user_id == user.id)
    return (await db.execute(query)).scalars().first()


async def _ask_for_quotas(
    db: AsyncSession, user: User, device_id: str | None, target_mid: str | None, is_specific: bool,
) -> bool:
    """Ask the device, or every online device the user may see, to report fresh quotas."""
    msg = {"type": "get_agent_quotas"}
    if is_specific:
        target = target_mid if target_mid and ws_manager.is_online(target_mid) else None
        if target is None and _sees_all(user) and device_id and ws_manager.is_online(device_id):
            target = device_id
        return bool(target) and await ws_manager.send_json(target, msg)
    if _sees_all(user):
        if not ws_manager.has_online_devices():
            return False
        await ws_manager.broadcast(msg)
        return True
    hashes = (await db.execute(
        select(Machine.collector_token_hash).where(Machine.user_id == user.id)
    )).scalars().all()
    sent = False
    for h in hashes:
        if h and ws_manager.is_online(h):
            sent = await ws_manager.send_json(h, msg) or sent
    return sent


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
    # 1. Check the cache
    cached = get_cached_device_quotas(device_id, _user)
    if cached:
        return cached

    # 2. Try to query online machine
    machine_name = None
    target_mid = None
    is_specific = bool(device_id and device_id not in ("auto", "ask_only", "all"))
    if is_specific:
        try:
            m_row = await _find_machine(db, _user, device_id)
            if m_row:
                machine_name = m_row.name
                target_mid = str(m_row.id)
                cached = (
                    get_cached_device_quotas(m_row.collector_token_hash, _user)
                    or (get_cached_device_quotas(m_row.name, _user) if m_row.name else None)
                    or get_cached_device_quotas(str(m_row.id), _user)
                )
                if cached:
                    return cached
        except Exception as e:
            logger.warning("Error querying machine for quotas (%s): %s", device_id, e)

    # 3. If online device is connected to WebSocket, trigger an async request
    try:
        if await _ask_for_quotas(db, _user, device_id, target_mid, is_specific):
            for _ in range(10):
                await asyncio.sleep(0.1)
                cached = get_cached_device_quotas(device_id, _user)
                if not cached and target_mid:
                    cached = get_cached_device_quotas(target_mid, _user)
                if not cached and machine_name:
                    cached = get_cached_device_quotas(machine_name, _user)
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
            m_row = await _find_machine(db, _user, device_id)
            if m_row:
                machine_name = m_row.name
                target_mid = str(m_row.id)
        except Exception as e:
            logger.warning("Error querying machine for quota refresh (%s): %s", device_id, e)

    # Dispatch request to WS clients
    dispatched = False
    try:
        dispatched = await _ask_for_quotas(db, _user, device_id, target_mid, is_specific)
    except Exception as e:
        logger.warning("Error dispatching refresh_agent_quotas over ws: %s", e)

    # Wait up to 1.5s for response
    if dispatched:
        for _ in range(15):
            await asyncio.sleep(0.1)
            cached = get_cached_device_quotas(device_id, _user)
            if not cached and target_mid:
                cached = get_cached_device_quotas(target_mid, _user)
            if not cached and machine_name:
                cached = get_cached_device_quotas(machine_name, _user)
            if cached:
                return cached

    res = get_cached_device_quotas(device_id, _user)
    if not res and target_mid:
        res = get_cached_device_quotas(target_mid, _user)
    if not res and machine_name:
        res = get_cached_device_quotas(machine_name, _user)
    return res or _make_fallback_report(device_id=device_id, device_name=machine_name)
