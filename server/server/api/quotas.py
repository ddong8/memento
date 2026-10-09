"""API endpoints and coordinator cache for AI subscription tool quotas (Antigravity, Claude Code, OpenAI Codex)."""

import asyncio
from datetime import datetime, timezone
import logging
from typing import Any
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Machine, User
from ..db.session import async_session_factory, get_db
from ..middleware.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agent/quotas", tags=["quotas"])
compat_router = APIRouter(prefix="/api/quotas", tags=["quotas"])
raw_router = APIRouter(prefix="/agent/quotas", tags=["quotas"])
raw_compat_router = APIRouter(prefix="/quotas", tags=["quotas"])

# Cache of live agent quotas reported by connected devices
# Key: device_id | machine_name | machine_id
_device_quotas: dict[str, dict[str, Any]] = {}
_latest_global_quotas: dict[str, Any] = {}


def set_cached_device_quotas(
    device_id: str,
    report: dict[str, Any],
    machine_name: str | None = None,
    machine_id: str | None = None,
) -> None:
    """Store reported quotas into coordinator memory."""
    global _latest_global_quotas
    if not isinstance(report, dict):
        return

    report_with_meta = {
        **report,
        "device_id": device_id,
        "device_name": machine_name or device_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    _device_quotas[device_id] = report_with_meta
    if machine_name:
        _device_quotas[machine_name] = report_with_meta
    if machine_id:
        _device_quotas[machine_id] = report_with_meta

    _latest_global_quotas = report_with_meta


def get_cached_device_quotas(device_id: str | None = None) -> dict[str, Any] | None:
    """Lookup cached quotas for a specific device, or the most recent valid report."""
    if device_id and device_id not in ("auto", "ask_only", "all"):
        if device_id in _device_quotas:
            return _device_quotas[device_id]
        for k, v in _device_quotas.items():
            if device_id.lower() in k.lower():
                return v

    # Fallback to latest global report
    if _latest_global_quotas:
        return _latest_global_quotas

    # Fallback to any active device quota
    if _device_quotas:
        return next(iter(_device_quotas.values()))

    return None


def _make_fallback_report(device_id: str | None = None, device_name: str | None = None) -> dict[str, Any]:
    """Generates an initial structure if no device has reported yet."""
    return {
        "device_id": device_id or "auto",
        "device_name": device_name or "当前设备",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "tools": {
            "antigravity": {
                "tool": "antigravity",
                "name": "Google Antigravity",
                "available": True,
                "logged_in": True,
                "plan_name": "Google AI Pro",
                "tier": "PRO",
                "remaining_percent": 100.0,
                "reset_time": None,
                "models": [],
            },
            "claude_code": {
                "tool": "claude_code",
                "name": "Claude Code",
                "available": True,
                "logged_in": True,
                "plan_name": "Claude Pro",
                "tier": "PRO",
                "remaining_percent": 100.0,
                "reset_time": None,
            },
            "codex": {
                "tool": "codex",
                "name": "OpenAI Codex",
                "available": True,
                "logged_in": True,
                "plan_name": "ChatGPT Free / Pro",
                "tier": "PRO",
                "remaining_percent": 100.0,
                "reset_time": None,
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
    if device_id and device_id not in ("auto", "ask_only", "all"):
        m_row = (await db.execute(
            select(Machine).where(
                (Machine.name == device_id)
                | (Machine.fingerprint == device_id)
            )
        )).scalars().first()
        if m_row:
            machine_name = m_row.name
            target_mid = str(m_row.id)

    # 3. If online device is connected to WebSocket, trigger an async request
    from ..services.ws_manager import ws_manager
    if target_mid and ws_manager.is_online(target_mid):
        await ws_manager.send_json(target_mid, {"type": "get_agent_quotas"})
    elif ws_manager.has_online_devices():
        # broadcast to any online device
        for mid in ws_manager.active_connections:
            await ws_manager.send_json(mid, {"type": "get_agent_quotas"})

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
    from ..services.ws_manager import ws_manager

    target_mid = None
    if device_id and device_id not in ("auto", "ask_only", "all"):
        m_row = (await db.execute(
            select(Machine).where(
                (Machine.name == device_id)
                | (Machine.fingerprint == device_id)
            )
        )).scalars().first()
        if m_row:
            target_mid = str(m_row.id)

    # Dispatch request to WS clients
    if target_mid and ws_manager.is_online(target_mid):
        await ws_manager.send_json(target_mid, {"type": "get_agent_quotas"})
    else:
        for mid in ws_manager.active_connections:
            await ws_manager.send_json(mid, {"type": "get_agent_quotas"})

    # Wait up to 1.5s for response
    for _ in range(15):
        await asyncio.sleep(0.1)
        cached = get_cached_device_quotas(device_id)
        if cached:
            return cached

    return get_cached_device_quotas(device_id) or _make_fallback_report(device_id=device_id)
