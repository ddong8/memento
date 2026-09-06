"""AI Provider service — multi-provider fallback client.

Maintains a priority list of OpenAI-compatible LLM providers.
If the primary provider encounters network timeouts, rate limits (429), or server errors (5xx),
it automatically falls back to the next configured provider (e.g. OneAPI qwen3.8-27b).
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import AsyncGenerator

import httpx

logger = logging.getLogger("server.ai_provider")


@dataclass
class AIProviderConfig:
    name: str
    base_url: str
    api_key: str
    model: str
    timeout: float = 120.0


def get_ai_providers() -> list[AIProviderConfig]:
    """Return all configured AI providers in fallback priority order."""
    providers: list[AIProviderConfig] = []

    # 1. Primary provider (MEMENTO_AI_*)
    primary_url = os.environ.get("MEMENTO_AI_BASE_URL", "https://coding.dashscope.aliyuncs.com/v1").rstrip("/")
    primary_key = os.environ.get("MEMENTO_AI_API_KEY", "").strip()
    primary_model = os.environ.get("MEMENTO_AI_MODEL", "kimi-k2.5").strip()

    if primary_key:
        providers.append(AIProviderConfig(
            name="primary",
            base_url=primary_url,
            api_key=primary_key,
            model=primary_model,
        ))

    # 2. Fallback provider (OneAPI with self-deployed qwen3.8-27b)
    fallback_url = os.environ.get(
        "MEMENTO_AI_FALLBACK_BASE_URL",
        "https://oneapi.aiphacas.com/v1",
    ).rstrip("/")
    fallback_key = os.environ.get(
        "MEMENTO_AI_FALLBACK_API_KEY",
        "sk-8RpD0Jo7Uk4ImKaGCF1Wb2dZ6cYerROdEUlzGoJt0qfMQL6a",
    ).strip()
    fallback_model = os.environ.get("MEMENTO_AI_FALLBACK_MODEL", "qwen3.8-27b").strip()

    is_duplicate = bool(
        providers
        and providers[0].api_key == fallback_key
        and providers[0].base_url == fallback_url
    )
    if fallback_key and not is_duplicate:
        providers.append(AIProviderConfig(
            name="oneapi_fallback",
            base_url=fallback_url,
            api_key=fallback_key,
            model=fallback_model,
        ))

    # 3. Additional providers from MEMENTO_AI_PROVIDERS JSON array
    raw_json = os.environ.get("MEMENTO_AI_PROVIDERS", "").strip()
    if raw_json:
        try:
            extra = json.loads(raw_json)
            if isinstance(extra, list):
                for idx, item in enumerate(extra):
                    if isinstance(item, dict) and item.get("api_key") and item.get("base_url"):
                        providers.append(AIProviderConfig(
                            name=item.get("name") or f"provider_{idx + 1}",
                            base_url=item["base_url"].rstrip("/"),
                            api_key=item["api_key"].strip(),
                            model=item.get("model") or "qwen3.8-27b",
                        ))
        except Exception as e:
            logger.warning("Failed to parse MEMENTO_AI_PROVIDERS: %s", e)

    return providers


async def call_chat_completion(
    messages: list[dict],
    tools: list[dict] | None = None,
    temperature: float = 0.3,
    max_tokens: int = 1500,
    timeout: float = 120.0,
) -> tuple[dict, AIProviderConfig]:
    """Call chat/completions with automatic fallback across all configured providers.

    Returns (response_json_dict, provider_used).
    Raises RuntimeError if all providers fail.
    """
    providers = get_ai_providers()
    if not providers:
        raise RuntimeError("No AI API providers configured (missing API keys)")

    errors: list[str] = []
    for p in providers:
        req_body: dict = {
            "model": p.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if tools:
            req_body["tools"] = tools

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    f"{p.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {p.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=req_body,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return data, p

                err_msg = f"Provider '{p.name}' ({p.base_url}, {p.model}) returned HTTP {resp.status_code}: {resp.text[:200]}"
                logger.warning(err_msg)
                errors.append(err_msg)
        except Exception as e:
            err_msg = f"Provider '{p.name}' ({p.base_url}, {p.model}) error: {type(e).__name__}: {e}"
            logger.warning(err_msg)
            errors.append(err_msg)

    raise RuntimeError(f"All {len(providers)} AI providers failed: " + "; ".join(errors))


async def stream_chat_completion(
    messages: list[dict],
    temperature: float = 0.3,
    max_tokens: int = 2500,
    timeout: float = 120.0,
) -> AsyncGenerator[str, None]:
    """Stream text deltas from chat/completions with automatic fallback if connection fails."""
    providers = get_ai_providers()
    if not providers:
        raise RuntimeError("No AI API providers configured (missing API keys)")

    errors: list[str] = []
    for p in providers:
        started = False
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                    "POST",
                    f"{p.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {p.api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": p.model,
                        "messages": messages,
                        "temperature": temperature,
                        "max_tokens": max_tokens,
                        "stream": True,
                    },
                ) as resp:
                    if resp.status_code != 200:
                        detail = (await resp.aread()).decode("utf-8", "replace")[:200]
                        err_msg = f"Provider '{p.name}' HTTP {resp.status_code}: {detail}"
                        logger.warning(err_msg)
                        errors.append(err_msg)
                        continue

                    started = True
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        data_str = line[6:].strip()
                        if data_str == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data_str)
                            delta = (chunk.get("choices") or [{}])[0].get("delta", {})
                            content = delta.get("content") or ""
                            if content:
                                yield content
                        except Exception:
                            continue
                    return
        except Exception as e:
            err_msg = f"Provider '{p.name}' stream error: {type(e).__name__}: {e}"
            logger.warning(err_msg)
            errors.append(err_msg)
            if started:
                return

    raise RuntimeError(f"All {len(providers)} AI providers failed to stream: " + "; ".join(errors))


async def call_plain_chat(
    messages: list[dict],
    temperature: float = 0.3,
    max_tokens: int = 1500,
    timeout: float = 120.0,
) -> str | None:
    """Convenience wrapper for non-tool plain completion returning the response string or None."""
    try:
        data, _ = await call_chat_completion(
            messages=messages,
            tools=None,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )
        choices = data.get("choices") or []
        if choices:
            msg = choices[0].get("message") or {}
            return msg.get("content")
        return None
    except Exception as e:
        logger.warning("call_plain_chat failed across all providers: %s", e)
        return None