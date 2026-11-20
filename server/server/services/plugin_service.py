"""Plugin Marketplace catalog, per-user installation state, sealed config storage, and runtime resolution.

Optional external-service capabilities (such as the AI Studio / filmkit video engine and the WeChat
official-account draft publisher) are distributed as Marketplace plugins:
- Fresh and self-hosted deployments stay clean: uninstalled or unconfigured plugins are hidden from
  the sidebar and workbench, and never leak hardcoded third-party/personal endpoints.
- Users install a plugin from /plugins, enter their own service endpoint + credentials (sealed via
  secret_box), test connectivity, and immediately unlock the plugin's UI and API routes.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from fastapi import HTTPException

from ..config import settings
from ..db.models import User
from .secret_box import mask_secret, reveal, seal

PLUGIN_CATALOG: list[dict[str, Any]] = [
    {
        "id": "studio",
        "name": "AI 演播台",
        "version": "1.2.0",
        "category": "创作生产",
        "icon": "film",
        "entry_route": "/studio",
        "summary": "多引擎 AI 短剧与漫剧制作工作台，支持角色定妆锁定、分镜并发生成、图生视频、对口型与成片回传对话内联播放。",
        "highlights": [
            "接入自建或云端 filmkit 引擎，独立管理短剧项目、角色定妆与分镜时间线",
            "成片自动归档至媒体库，支持 HTTP 206 流播与一键推送到对话内联播放",
            "未安装或未配置时自动隐藏侧边栏入口，不干扰普通自部署环境",
        ],
        "fields": [
            {
                "key": "use_server_default",
                "label": "使用当前服务端预置演播台引擎",
                "type": "boolean",
                "required": False,
                "server_capability": "studio_default",
                "help": "当前服务端已配置托管 filmkit 引擎时，可直接一键接入，无需手动填写内网地址与密钥。",
            },
            {
                "key": "filmkit_url",
                "label": "演播台引擎地址 (filmkit URL)",
                "type": "url",
                "required": True,
                "placeholder": "http://127.0.0.1:8765 或 https://studio.example.com",
                "help": "自建 filmkit serve 的访问地址（使用服务端预置引擎时可留空）。",
            },
            {
                "key": "filmkit_token",
                "label": "访问令牌 (Bearer Token)",
                "type": "secret",
                "required": False,
                "placeholder": "可选：对应 filmkit 的 FILMKIT_WEB_PASSWORD",
                "help": "服务端加密保存，仅用于代理请求时附带 Authorization 请求头。",
            },
        ],
    },
    {
        "id": "wechat_publish",
        "name": "公众号一键分发",
        "version": "1.1.0",
        "category": "内容分发",
        "icon": "share",
        "entry_route": "",
        "summary": "工作台 Markdown 多主题排版预览，一键推送至微信公众号草稿箱，并适配知乎、微博与小红书富文本导出。",
        "highlights": [
            "在工作台文档视窗中解锁「分发」入口，支持四套商业排版主题实时预览",
            "对接你自己的微信草稿排版网关（/api/convert 与 /api/wechat/draft），隔离账号与素材库",
            "可自定义默认作者、默认封面 media_id 与文末附带的官网链接",
        ],
        "fields": [
            {
                "key": "api_base_url",
                "label": "排版与草稿推送服务地址",
                "type": "url",
                "required": True,
                "placeholder": "https://wx.example.com",
                "help": "提供 /api/convert、/api/wechat/upload-cover 与 /api/wechat/draft 接口的服务根地址。",
            },
            {
                "key": "api_token",
                "label": "服务鉴权密钥 (可选)",
                "type": "secret",
                "required": False,
                "placeholder": "可选：若推送网关开启鉴权则填写",
                "help": "若你的自建网关需要 Bearer 鉴权，可在此填写并加密保存。",
            },
            {
                "key": "default_author",
                "label": "默认作者名",
                "type": "text",
                "required": False,
                "placeholder": "Memento",
                "help": "推送公众号草稿时的默认署名，可在发布弹窗中按篇修改。",
            },
            {
                "key": "default_cover_media_id",
                "label": "默认封面素材 Media ID",
                "type": "text",
                "required": False,
                "placeholder": "可选：微信永久素材库封面 media_id",
                "help": "文章无配图且未手动上传封面时使用的默认封面素材 ID。",
            },
            {
                "key": "official_site_url",
                "label": "文章附带官网链接",
                "type": "url",
                "required": False,
                "placeholder": "https://mem.ihasy.com",
                "help": "推送草稿时附带在文章底部的官网说明链接，留空则不额外追加。",
            },
        ],
    },
]

CATALOG_BY_ID: dict[str, dict[str, Any]] = {p["id"]: p for p in PLUGIN_CATALOG}


def secret_keys_for(plugin_id: str) -> tuple[str, ...]:
    spec = CATALOG_BY_ID.get(plugin_id)
    if not spec:
        return ()
    return tuple(f["key"] for f in spec.get("fields", []) if f.get("type") == "secret")


def server_has_studio_engine() -> bool:
    """Whether the current Memento backend deployment explicitly configured a managed filmkit engine."""
    url = (settings.studio_filmkit_url or "").strip().rstrip("/")
    token = (settings.studio_filmkit_token or "").strip()
    if not url:
        return False
    # Bare local fallback without a token means the deployment hasn't provisioned a hosted filmkit engine.
    if url in ("http://127.0.0.1:8765", "http://localhost:8765") and not token:
        return False
    return True


def _validate_http_url(raw: str, label: str) -> str:
    val = (raw or "").strip().rstrip("/")
    if not val:
        return ""
    parsed = urlparse(val)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail=f"{label}必须是合法的 http:// 或 https:// 地址")
    return val


def sanitize_and_seal_config(
    plugin_id: str,
    incoming: dict[str, Any],
    existing_sealed: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate incoming plugin config fields, preserve untouched secrets, and seal updated secrets."""
    spec = CATALOG_BY_ID.get(plugin_id)
    if not spec:
        raise HTTPException(status_code=404, detail=f"未知插件: {plugin_id}")

    prev = dict(existing_sealed or {})
    out: dict[str, Any] = {}
    for field in spec.get("fields", []):
        key = field["key"]
        ftype = field.get("type", "text")
        if key not in incoming:
            if key in prev:
                out[key] = prev[key]
            continue

        raw_val = incoming.get(key)
        if ftype == "boolean":
            out[key] = bool(raw_val)
        elif ftype == "url":
            s = str(raw_val or "").strip()
            out[key] = _validate_http_url(s, field["label"]) if s else ""
        elif ftype == "secret":
            # Empty string clears only when explicitly requested via "__CLEAR__"; blank keeps previous secret.
            if raw_val == "__CLEAR__":
                out[key] = ""
            elif isinstance(raw_val, str) and raw_val.strip():
                out[key] = seal(raw_val.strip())
            elif key in prev:
                out[key] = prev[key]
            else:
                out[key] = ""
        else:
            out[key] = str(raw_val or "").strip()[:300]

    # Guard: cannot use server default if this deployment has no managed studio engine.
    if plugin_id == "studio" and out.get("use_server_default") and not server_has_studio_engine():
        out["use_server_default"] = False

    return out


def is_plugin_configured(plugin_id: str, raw_config: dict[str, Any] | None) -> bool:
    cfg = raw_config or {}
    if plugin_id == "studio":
        if cfg.get("use_server_default") and server_has_studio_engine():
            return True
        return bool((cfg.get("filmkit_url") or "").strip())
    if plugin_id == "wechat_publish":
        return bool((cfg.get("api_base_url") or "").strip())
    return False


def _user_plugin_entry(user: User | None, plugin_id: str) -> dict[str, Any]:
    raw = getattr(user, "plugin_settings", None) if user is not None else None
    if not isinstance(raw, dict):
        return {}
    entry = raw.get(plugin_id)
    return entry if isinstance(entry, dict) else {}


def is_plugin_ready(user: User | None, plugin_id: str) -> bool:
    entry = _user_plugin_entry(user, plugin_id)
    if not entry.get("installed") or not entry.get("enabled", True):
        return False
    return is_plugin_configured(plugin_id, entry.get("config") or {})


def public_plugin_config(plugin_id: str, sealed_config: dict[str, Any] | None) -> dict[str, Any]:
    """Return safe config payload for the browser: plaintext non-secrets + masked/has flags for secrets."""
    spec = CATALOG_BY_ID.get(plugin_id)
    if not spec:
        return {}
    raw = sealed_config or {}
    out: dict[str, Any] = {}
    for field in spec.get("fields", []):
        key = field["key"]
        ftype = field.get("type", "text")
        if ftype == "secret":
            decrypted = reveal(raw.get(key)) if raw.get(key) else ""
            out[f"has_{key}"] = bool(decrypted)
            out[f"{key}_masked"] = mask_secret(decrypted)
        elif ftype == "boolean":
            out[key] = bool(raw.get(key, False))
        else:
            out[key] = str(raw.get(key) or "")
    return out


def get_user_plugins_payload(user: User | None) -> dict[str, Any]:
    """Build the full Plugin Marketplace listing for the authenticated user."""
    server_caps = {"studio_default": server_has_studio_engine()}
    items: list[dict[str, Any]] = []
    for spec in PLUGIN_CATALOG:
        pid = spec["id"]
        entry = _user_plugin_entry(user, pid)
        installed = bool(entry.get("installed", False))
        enabled = bool(entry.get("enabled", True)) if installed else False
        raw_cfg = entry.get("config") if isinstance(entry.get("config"), dict) else {}
        configured = is_plugin_configured(pid, raw_cfg)
        ready = installed and enabled and configured
        items.append({
            **copy.deepcopy(spec),
            "installed": installed,
            "enabled": enabled,
            "configured": configured,
            "ready": ready,
            "installed_at": entry.get("installed_at"),
            "updated_at": entry.get("updated_at"),
            "config": public_plugin_config(pid, raw_cfg),
        })
    return {
        "plugins": items,
        "server_capabilities": server_caps,
    }


def resolve_studio_connection(user: User | None) -> tuple[str, str]:
    """Resolve (filmkit_base_url, bearer_token) for the user's installed Studio plugin.

    Raises HTTP 412 when the plugin is not installed, disabled, or not configured, ensuring
    unconfigured self-hosted deployments never hit stray local ports or leak another server's engine.
    """
    entry = _user_plugin_entry(user, "studio")
    if not entry.get("installed") or not entry.get("enabled", True):
        raise HTTPException(
            status_code=412,
            detail="尚未安装或启用「AI 演播台」插件，请前往「插件市场」安装并完成配置后再使用。",
        )
    cfg = entry.get("config") if isinstance(entry.get("config"), dict) else {}
    if cfg.get("use_server_default"):
        if not server_has_studio_engine():
            raise HTTPException(
                status_code=412,
                detail="当前服务端未托管预置演播台引擎，请在「插件市场」为「AI 演播台」填写你的 filmkit 引擎地址。",
            )
        return (
            (settings.studio_filmkit_url or "").strip().rstrip("/"),
            (settings.studio_filmkit_token or "").strip(),
        )
    url = (cfg.get("filmkit_url") or "").strip().rstrip("/")
    if not url:
        raise HTTPException(
            status_code=412,
            detail="「AI 演播台」插件尚未配置引擎地址，请前往「插件市场」填写 filmkit URL 后再使用。",
        )
    token = reveal(cfg.get("filmkit_token")) if cfg.get("filmkit_token") else ""
    return url, token.strip()


def resolve_wechat_connection(user: User | None) -> tuple[str, str, dict[str, Any]]:
    """Resolve (api_base_url, api_token, public_cfg) for the user's installed WeChat publish plugin."""
    entry = _user_plugin_entry(user, "wechat_publish")
    if not entry.get("installed") or not entry.get("enabled", True):
        raise HTTPException(
            status_code=412,
            detail="尚未安装或启用「公众号一键分发」插件，请前往「插件市场」安装并配置后再使用。",
        )
    cfg = entry.get("config") if isinstance(entry.get("config"), dict) else {}
    url = (cfg.get("api_base_url") or "").strip().rstrip("/")
    if not url:
        raise HTTPException(
            status_code=412,
            detail="「公众号一键分发」插件尚未配置推送服务地址，请先在「插件市场」完成配置。",
        )
    token = reveal(cfg.get("api_token")) if cfg.get("api_token") else ""
    return url, token.strip(), public_plugin_config("wechat_publish", cfg)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
