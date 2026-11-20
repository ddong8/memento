"""Plugin Marketplace API: browse catalog, install/uninstall plugins, save encrypted configs, and test connectivity."""

from __future__ import annotations

import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from ..config import settings
from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.plugin_service import (
    CATALOG_BY_ID,
    get_user_plugins_payload,
    is_plugin_configured,
    now_iso,
    sanitize_and_seal_config,
    server_has_studio_engine,
)
from ..services.secret_box import reveal

router = APIRouter(prefix="/api/plugins", tags=["plugins"])


class PluginInstallReq(BaseModel):
    config: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class PluginConfigReq(BaseModel):
    config: dict[str, Any] | None = None
    enabled: bool | None = None


class PluginTestReq(BaseModel):
    config: dict[str, Any] | None = None


def _ensure_plugin_exists(plugin_id: str) -> dict[str, Any]:
    spec = CATALOG_BY_ID.get(plugin_id)
    if not spec:
        raise HTTPException(status_code=404, detail=f"插件不存在: {plugin_id}")
    return spec


@router.get("")
async def list_plugins(user: User = Depends(get_current_user)) -> dict[str, Any]:
    return get_user_plugins_payload(user)


@router.post("/{plugin_id}/install")
async def install_plugin(
    plugin_id: str,
    body: PluginInstallReq | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _ensure_plugin_exists(plugin_id)
    req = body or PluginInstallReq()
    all_settings = dict(user.plugin_settings or {})
    existing = dict(all_settings.get(plugin_id) or {})
    prev_cfg = existing.get("config") if isinstance(existing.get("config"), dict) else {}

    incoming_cfg = dict(req.config or {})
    # Convenience: when installing Studio on a managed server without custom URL, default to server preset
    if plugin_id == "studio" and not incoming_cfg and not prev_cfg and server_has_studio_engine():
        incoming_cfg["use_server_default"] = True

    sealed_cfg = sanitize_and_seal_config(plugin_id, incoming_cfg, prev_cfg)
    ts = now_iso()
    all_settings[plugin_id] = {
        "installed": True,
        "enabled": bool(req.enabled),
        "config": sealed_cfg,
        "installed_at": existing.get("installed_at") or ts,
        "updated_at": ts,
    }
    user.plugin_settings = all_settings
    flag_modified(user, "plugin_settings")
    await db.commit()
    return get_user_plugins_payload(user)


@router.patch("/{plugin_id}/config")
async def update_plugin_config(
    plugin_id: str,
    body: PluginConfigReq,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _ensure_plugin_exists(plugin_id)
    all_settings = dict(user.plugin_settings or {})
    existing = dict(all_settings.get(plugin_id) or {})
    if not existing.get("installed"):
        raise HTTPException(status_code=400, detail="请先安装该插件再进行配置")

    prev_cfg = existing.get("config") if isinstance(existing.get("config"), dict) else {}
    next_cfg = (
        sanitize_and_seal_config(plugin_id, body.config, prev_cfg)
        if body.config is not None
        else prev_cfg
    )
    next_enabled = existing.get("enabled", True) if body.enabled is None else bool(body.enabled)

    all_settings[plugin_id] = {
        **existing,
        "installed": True,
        "enabled": next_enabled,
        "config": next_cfg,
        "updated_at": now_iso(),
    }
    user.plugin_settings = all_settings
    flag_modified(user, "plugin_settings")
    await db.commit()
    return get_user_plugins_payload(user)


@router.post("/{plugin_id}/test")
async def test_plugin_connection(
    plugin_id: str,
    body: PluginTestReq | None = None,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _ensure_plugin_exists(plugin_id)
    all_settings = dict(user.plugin_settings or {})
    existing = dict(all_settings.get(plugin_id) or {})
    prev_cfg = existing.get("config") if isinstance(existing.get("config"), dict) else {}
    merged = (
        sanitize_and_seal_config(plugin_id, body.config, prev_cfg)
        if (body and body.config is not None)
        else prev_cfg
    )
    if not is_plugin_configured(plugin_id, merged):
        return {"ok": False, "latency_ms": 0, "message": "请先填写必填的服务地址后再测试连接"}

    t0 = time.monotonic()
    if plugin_id == "studio":
        if merged.get("use_server_default") and server_has_studio_engine():
            base = (settings.studio_filmkit_url or "").strip().rstrip("/")
            token = (settings.studio_filmkit_token or "").strip()
        else:
            base = (merged.get("filmkit_url") or "").strip().rstrip("/")
            token = reveal(merged.get("filmkit_token")) if merged.get("filmkit_token") else ""
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.get(f"{base}/health", headers=headers)
            ms = int((time.monotonic() - t0) * 1000)
            if r.status_code == 200:
                return {"ok": True, "latency_ms": ms, "message": f"演播台引擎连接正常 ({ms} ms)"}
            return {"ok": False, "latency_ms": ms, "message": f"演播台引擎返回 HTTP {r.status_code}"}
        except Exception as e:
            ms = int((time.monotonic() - t0) * 1000)
            return {"ok": False, "latency_ms": ms, "message": f"无法连接演播台引擎: {e}"}

    if plugin_id == "wechat_publish":
        base = (merged.get("api_base_url") or "").strip().rstrip("/")
        token = reveal(merged.get("api_token")) if merged.get("api_token") else ""
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.get(f"{base}/health", headers=headers)
                if r.status_code == 404:
                    r = await client.get(f"{base}/", headers=headers)
            ms = int((time.monotonic() - t0) * 1000)
            if r.status_code < 500:
                return {"ok": True, "latency_ms": ms, "message": f"公众号推送服务可达 (HTTP {r.status_code}, {ms} ms)"}
            return {"ok": False, "latency_ms": ms, "message": f"服务异常返回 HTTP {r.status_code}"}
        except Exception as e:
            ms = int((time.monotonic() - t0) * 1000)
            return {"ok": False, "latency_ms": ms, "message": f"无法连接推送服务: {e}"}

    return {"ok": False, "latency_ms": 0, "message": "暂不支持测试该插件"}


@router.delete("/{plugin_id}")
async def uninstall_plugin(
    plugin_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _ensure_plugin_exists(plugin_id)
    all_settings = dict(user.plugin_settings or {})
    if plugin_id in all_settings:
        del all_settings[plugin_id]
        user.plugin_settings = all_settings
        flag_modified(user, "plugin_settings")
        await db.commit()
    return get_user_plugins_payload(user)
