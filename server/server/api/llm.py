"""User-level custom LLM API endpoints and configuration."""

from __future__ import annotations

import logging
import time

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.ai_provider import (
    get_system_default_llm_info,
)

logger = logging.getLogger("server.llm")

router = APIRouter(prefix="/api/profile/llm", tags=["llm-profile"])

PRESETS = [
    {
        "id": "anthropic",
        "name": "Anthropic 官方 (Claude Opus 5.5 / Sonnet 5.5)",
        "icon": "sparkles",
        "base_url": "https://api.anthropic.com/v1",
        "models": [
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-fable-5-1",
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-3-7-sonnet-20250219",
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
        ],
        "default_model": "claude-opus-5-5",
        "default_background_model": "claude-sonnet-5-5",
        "help_url": "https://console.anthropic.com",
    },
    {
        "id": "volcengine",
        "name": "火山方舟 (Volcengine Ark)",
        "icon": "sparkles",
        "base_url": "https://ark.cn-beijing.volces.com/api/coding/v3",
        "models": ["glm-5.2", "deepseek-v4.1-flash", "ep-2025..."],
        "default_model": "glm-5.2",
        "default_background_model": "deepseek-v4.1-flash",
        "help_url": "https://www.volcengine.com/product/ark",
    },
    {
        "id": "deepseek",
        "name": "DeepSeek 官方开放平台",
        "icon": "zap",
        "base_url": "https://api.deepseek.com/v1",
        "models": ["deepseek-chat", "deepseek-reasoner"],
        "default_model": "deepseek-chat",
        "default_background_model": "deepseek-chat",
        "help_url": "https://platform.deepseek.com",
    },
    {
        "id": "dashscope",
        "name": "阿里百炼 (DashScope / 通义千问)",
        "icon": "cloud",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "models": ["qwen-max", "qwen-plus", "qwen-turbo"],
        "default_model": "qwen-plus",
        "default_background_model": "qwen-turbo",
        "help_url": "https://bailian.console.aliyun.com",
    },
    {
        "id": "siliconflow",
        "name": "硅基流动 (SiliconFlow)",
        "icon": "cpu",
        "base_url": "https://api.siliconflow.cn/v1",
        "models": ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct", "deepseek-ai/DeepSeek-R1"],
        "default_model": "deepseek-ai/DeepSeek-V3",
        "default_background_model": "deepseek-ai/DeepSeek-V3",
        "help_url": "https://siliconflow.cn",
    },
    {
        "id": "openai",
        "name": "OpenAI 官方",
        "icon": "bot",
        "base_url": "https://api.openai.com/v1",
        "models": ["gpt-4o", "gpt-4o-mini", "o3-mini"],
        "default_model": "gpt-4o",
        "default_background_model": "gpt-4o-mini",
        "help_url": "https://platform.openai.com",
    },
    {
        "id": "ollama",
        "name": "Ollama / 本地私有化模型",
        "icon": "terminal",
        "base_url": "http://localhost:11434/v1",
        "models": ["qwen2.5-coder", "deepseek-r1", "llama3.3"],
        "default_model": "qwen2.5-coder",
        "default_background_model": "qwen2.5-coder",
        "help_url": "https://ollama.com",
    },
    {
        "id": "custom",
        "name": "自定义 OpenAI 兼容接口",
        "icon": "settings",
        "base_url": "",
        "models": [],
        "default_model": "",
        "default_background_model": "",
        "help_url": "",
    },
]


def _mask_key(key: str | None) -> str:
    if not key:
        return ""
    k = key.strip()
    if len(k) <= 8:
        return "******"
    return f"{k[:4]}****{k[-4:]}"


class LLMSettingsBody(BaseModel):
    custom_enabled: bool = False
    provider: str = "custom"
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    primary_model: str = ""
    background_model: str = ""
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(default=4096, ge=256, le=65536)
    fallback_enabled: bool = False
    fallback_base_url: str = ""
    fallback_api_key: str = ""
    fallback_model: str = ""


class LLMTestBody(BaseModel):
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    primary_model: str = ""
    provider: str = ""
    temperature: float = 0.1
    max_tokens: int = 50


@router.get("")
async def get_llm_settings(user: User = Depends(get_current_user)) -> dict:
    """Retrieve current user's custom LLM settings along with system defaults and presets."""
    saved = dict(user.llm_settings or {})
    raw_key = saved.get("api_key") or ""
    raw_fallback_key = saved.get("fallback_api_key") or ""

    primary = saved.get("primary_model") or saved.get("model") or ""
    sys_def = get_system_default_llm_info()

    settings_data = {
        "custom_enabled": saved.get("custom_enabled", False),
        "provider": saved.get("provider", "custom"),
        "base_url": saved.get("base_url", ""),
        "api_key_masked": _mask_key(raw_key),
        "has_api_key": bool(raw_key),
        "model": primary,
        "primary_model": primary,
        "background_model": saved.get("background_model", ""),
        "temperature": saved.get("temperature", 0.7),
        "max_tokens": saved.get("max_tokens", 4096),
        "fallback_enabled": saved.get("fallback_enabled", False),
        "fallback_base_url": saved.get("fallback_base_url", ""),
        "fallback_api_key_masked": _mask_key(raw_fallback_key),
        "has_fallback_api_key": bool(raw_fallback_key),
        "fallback_model": saved.get("fallback_model", ""),
    }

    return {
        "status": "ok",
        "settings": settings_data,
        **settings_data,
        "system_default": sys_def,
        "system_defaults": sys_def,
        "presets": PRESETS,
    }


@router.put("")
async def update_llm_settings(
    body: LLMSettingsBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Update current user's custom LLM configuration."""
    existing = dict(user.llm_settings or {})
    data = body.model_dump()

    # Synchronize model and primary_model
    if not data.get("model") and data.get("primary_model"):
        data["model"] = data["primary_model"]
    elif not data.get("primary_model") and data.get("model"):
        data["primary_model"] = data["model"]

    # Preserve existing real API key if client passed back masked placeholder (e.g. sk-****)
    incoming_key = data.get("api_key", "").strip()
    if incoming_key and "****" in incoming_key:
        data["api_key"] = existing.get("api_key", "")
    elif not incoming_key and not data.get("custom_enabled"):
        data["api_key"] = existing.get("api_key", "")

    incoming_fallback_key = data.get("fallback_api_key", "").strip()
    if incoming_fallback_key and "****" in incoming_fallback_key:
        data["fallback_api_key"] = existing.get("fallback_api_key", "")

    # Sanitize base URLs
    if data.get("base_url"):
        data["base_url"] = data["base_url"].strip().rstrip("/")
    if data.get("fallback_base_url"):
        data["fallback_base_url"] = data["fallback_base_url"].strip().rstrip("/")

    user.llm_settings = data
    await db.commit()

    key_masked = _mask_key(data.get("api_key"))
    fallback_key_masked = _mask_key(data.get("fallback_api_key"))

    settings_resp = {
        **data,
        "api_key_masked": key_masked,
        "has_api_key": bool(data.get("api_key")),
        "fallback_api_key_masked": fallback_key_masked,
        "has_fallback_api_key": bool(data.get("fallback_api_key")),
    }

    return {
        "status": "ok",
        "message": "大模型配置已更新并即时生效",
        "settings": settings_resp,
        **settings_resp,
    }


@router.post("/test")
async def test_llm_connection(
    body: LLMTestBody,
    user: User = Depends(get_current_user),
) -> dict:
    """Test LLM API connectivity and latency."""
    import os
    saved = dict(user.llm_settings or {})
    sys_def = get_system_default_llm_info()

    base_url = (body.base_url or "").strip().rstrip("/")
    api_key = (body.api_key or "").strip()
    model = (body.primary_model or body.model or "").strip()

    # Fallback to saved or system default if omitted
    if not base_url:
        base_url = (saved.get("base_url") or "").strip().rstrip("/")
    if not base_url:
        base_url = sys_def.get("base_url", "").strip().rstrip("/")

    if not model:
        model = (saved.get("primary_model") or saved.get("model") or "").strip()
    if not model:
        model = sys_def.get("model", "").strip()

    # If key contains mask **** or is empty, use saved key
    if not api_key or "****" in api_key:
        api_key = (saved.get("api_key") or "").strip()

    # If still no key, and targeting system default base_url, pick system key
    if not api_key and base_url == sys_def.get("base_url"):
        api_key = os.environ.get("MEMENTO_AI_API_KEY", "").strip()

    if not base_url:
        return {
            "ok": False,
            "success": False,
            "error": "未指定 API Base URL，请填写端点地址或选择上方服务商预设",
            "latency_ms": 0,
        }
    if not model:
        return {
            "ok": False,
            "success": False,
            "error": "未指定模型名称，请填写或选择测试的模型",
            "latency_ms": 0,
        }

    req_body = {
        "model": model,
        "messages": [
            {"role": "user", "content": "请只回复五个汉字：'大模型连通'，不要输出任何多余内容。"}
        ],
        "temperature": 0.1,
        "max_tokens": 50,
    }

    start = time.monotonic()
    try:
        headers = {
            "Content-Type": "application/json",
        }
        if api_key and api_key != "no-key-required":
            headers["Authorization"] = f"Bearer {api_key}"

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{base_url}/chat/completions",
                headers=headers,
                json=req_body,
            )

        latency_ms = int((time.monotonic() - start) * 1000)

        if resp.status_code != 200:
            err_text = resp.text[:300]
            logger.warning("LLM test failed: HTTP %s: %s", resp.status_code, err_text)
            return {
                "ok": False,
                "success": False,
                "status_code": resp.status_code,
                "error": f"HTTP {resp.status_code}: {err_text}",
                "latency_ms": latency_ms,
            }

        data = resp.json()
        choices = data.get("choices") or []
        reply_content = ""
        if choices:
            msg = choices[0].get("message") or {}
            reply_content = msg.get("content") or msg.get("reasoning_content") or ""

        return {
            "ok": True,
            "success": True,
            "latency_ms": latency_ms,
            "model": model,
            "reply": reply_content.strip() or "连通正常（模型握手成功）",
        }
    except httpx.TimeoutException:
        latency_ms = int((time.monotonic() - start) * 1000)
        return {
            "ok": False,
            "success": False,
            "error": "请求超时（超过 15 秒）。请检查 Base URL 是否可访问或服务商网络状态。",
            "latency_ms": latency_ms,
        }
    except Exception as e:
        latency_ms = int((time.monotonic() - start) * 1000)
        return {
            "ok": False,
            "success": False,
            "error": f"{type(e).__name__}: {str(e)}",
            "latency_ms": latency_ms,
        }
