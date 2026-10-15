"""AI Provider service — multi-provider fallback client.

Maintains a priority list of OpenAI-compatible LLM providers.
If the primary provider encounters network timeouts, rate limits (429), or server errors (5xx),
it automatically falls back to the next configured provider (e.g. OneAPI qwen3.8-27b).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import AsyncGenerator

import httpx

from . import ai_health

logger = logging.getLogger("server.ai_provider")


@dataclass
class AIProviderConfig:
    name: str
    base_url: str
    api_key: str
    model: str
    timeout: float = 120.0


def get_system_default_llm_info() -> dict:
    """Return default system LLM configuration info (read-only for client reference)."""
    return {
        "base_url": os.environ.get("MEMENTO_AI_BASE_URL", "https://coding.dashscope.aliyuncs.com/v1").rstrip("/"),
        "model": os.environ.get("MEMENTO_AI_MODEL", "kimi-k2.5").strip(),
        "background_model": os.environ.get("MEMENTO_AI_BACKGROUND_MODEL", "").strip(),
        "has_api_key": bool(os.environ.get("MEMENTO_AI_API_KEY", "").strip()),
        "fallback_model": os.environ.get("MEMENTO_AI_FALLBACK_MODEL", "qwen3.8-27b").strip(),
    }


def get_ai_providers(
    background: bool = False,
    user: Any = None,
    custom_settings: dict | None = None,
) -> list[AIProviderConfig]:
    """Return all configured AI providers in fallback priority order.

    If the user has custom_enabled=True in llm_settings (or custom_settings is passed),
    the user's configured provider is placed first with highest priority.
    """
    providers: list[AIProviderConfig] = []

    # 1. User-customized provider (highest priority if enabled)
    user_settings = custom_settings
    if not user_settings and user and hasattr(user, "llm_settings"):
        user_settings = user.llm_settings

    if user_settings and user_settings.get("custom_enabled"):
        u_base_url = (user_settings.get("base_url") or "").rstrip("/")
        u_api_key = (user_settings.get("api_key") or "").strip()
        u_model = (user_settings.get("model") or "").strip()
        u_bg_model = (user_settings.get("background_model") or "").strip()

        if u_base_url and u_model:
            effective_key = u_api_key or "no-key-required"
            if background and u_bg_model and u_bg_model != u_model:
                providers.append(AIProviderConfig(
                    name="user_custom_background",
                    base_url=u_base_url,
                    api_key=effective_key,
                    model=u_bg_model,
                ))
            providers.append(AIProviderConfig(
                name="user_custom",
                base_url=u_base_url,
                api_key=effective_key,
                model=u_model,
            ))

        if user_settings.get("fallback_enabled"):
            fb_url = (user_settings.get("fallback_base_url") or "").rstrip("/")
            fb_key = (user_settings.get("fallback_api_key") or "").strip()
            fb_model = (user_settings.get("fallback_model") or "").strip()
            if fb_url and fb_model:
                providers.append(AIProviderConfig(
                    name="user_custom_fallback",
                    base_url=fb_url,
                    api_key=fb_key or "no-key-required",
                    model=fb_model,
                ))

    # 2. System Primary provider (MEMENTO_AI_*)
    primary_url = os.environ.get("MEMENTO_AI_BASE_URL", "https://coding.dashscope.aliyuncs.com/v1").rstrip("/")
    primary_key = os.environ.get("MEMENTO_AI_API_KEY", "").strip()
    primary_model = os.environ.get("MEMENTO_AI_MODEL", "kimi-k2.5").strip()
    background_model = os.environ.get("MEMENTO_AI_BACKGROUND_MODEL", "").strip()

    if primary_key and background and background_model and background_model != primary_model:
        providers.append(AIProviderConfig(
            name="primary_background",
            base_url=primary_url,
            api_key=primary_key,
            model=background_model,
        ))
    if primary_key:
        providers.append(AIProviderConfig(
            name="primary",
            base_url=primary_url,
            api_key=primary_key,
            model=primary_model,
        ))

    # 3. Fallback provider (OneAPI with self-deployed qwen3.8-27b)
    fallback_url = os.environ.get(
        "MEMENTO_AI_FALLBACK_BASE_URL",
        "https://oneapi.aiphacas.com/v1",
    ).rstrip("/")
    fallback_key = os.environ.get(
        "MEMENTO_AI_FALLBACK_API_KEY",
        "sk-8RpD0Jo7Uk4ImKaGCF1Wb2dZ6cYerROdEUlzGoJt0qfMQL6a",
    ).strip()
    fallback_model = os.environ.get("MEMENTO_AI_FALLBACK_MODEL", "qwen3.8-27b").strip()

    is_duplicate = any(p.api_key == fallback_key and p.base_url == fallback_url for p in providers)
    if fallback_key and not is_duplicate:
        providers.append(AIProviderConfig(
            name="oneapi_fallback",
            base_url=fallback_url,
            api_key=fallback_key,
            model=fallback_model,
        ))

    # 4. Additional providers from MEMENTO_AI_PROVIDERS JSON array
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
    background: bool = False,
    user: Any = None,
    custom_settings: dict | None = None,
) -> tuple[dict, AIProviderConfig]:
    """Call chat/completions with automatic fallback across all configured providers.

    background=True is for extraction and summary jobs: it prefers the background
    model and asks reasoning models to answer without thinking, which can
    otherwise take minutes.

    Returns (response_json_dict, provider_used).
    Raises RuntimeError if all providers fail.
    """
    providers = get_ai_providers(background=background, user=user, custom_settings=custom_settings)
    if not providers:
        raise RuntimeError("No AI API providers configured (missing API keys)")

    kind = "background" if background else "interactive"
    errors: list[str] = []
    failures: list[dict[str, str]] = []

    def fell_short(p: AIProviderConfig, reason: str, detail: str) -> None:
        failures.append({"provider": p.name, "model": p.model, "reason": reason, "detail": detail})

    for index, p in enumerate(providers):
        budget = max_tokens
        switch_off_thinking = background and _provider_key(p) not in _THINKING_SWITCH_REJECTED
        widened = False
        retried_without_switch = False
        rate_limit_retries = 0
        while True:
            req_body: dict = {
                "model": p.model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": budget,
            }
            if tools:
                req_body["tools"] = tools
            if switch_off_thinking:
                req_body["thinking"] = {"type": "disabled"}

            started = time.monotonic()
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
            except (httpx.TimeoutException, httpx.NetworkError) as e:
                if rate_limit_retries < 2:
                    rate_limit_retries += 1
                    wait_s = 1.0 * rate_limit_retries
                    logger.warning(
                        "Provider '%s' (%s) network error %s; retrying in %.1fs (retry %d/2)",
                        p.name, p.model, type(e).__name__, wait_s, rate_limit_retries,
                    )
                    await asyncio.sleep(wait_s)
                    continue
                err_msg = f"Provider '{p.name}' ({p.base_url}, {p.model}) error: {type(e).__name__}: {e}"
                logger.warning(err_msg)
                errors.append(err_msg)
                fell_short(p, ai_health.reason_for_exception(e), f"{type(e).__name__}: {e}")
                break
            except Exception as e:
                err_msg = f"Provider '{p.name}' ({p.base_url}, {p.model}) error: {type(e).__name__}: {e}"
                logger.warning(err_msg)
                errors.append(err_msg)
                fell_short(p, ai_health.reason_for_exception(e), f"{type(e).__name__}: {e}")
                break

            if resp.status_code in (400, 422) and switch_off_thinking:
                switch_off_thinking = False
                retried_without_switch = True
                logger.warning(
                    "Provider '%s' (%s) answered HTTP %d to thinking=disabled (%s); retrying without it",
                    p.name, p.model, resp.status_code, resp.text[:200],
                )
                continue
            if retried_without_switch and resp.status_code == 200:
                # The switch was the problem; stop sending it to this provider.
                _THINKING_SWITCH_REJECTED.add(_provider_key(p))
                retried_without_switch = False

            if resp.status_code in (429, 503) and rate_limit_retries < 2:
                rate_limit_retries += 1
                wait_s = 1.5 * rate_limit_retries
                logger.warning(
                    "Provider '%s' (%s) returned HTTP %d (%s); retrying in %.1fs (retry %d/2)",
                    p.name, p.model, resp.status_code, resp.text[:120], wait_s, rate_limit_retries,
                )
                await asyncio.sleep(wait_s)
                continue

            if resp.status_code != 200:
                err_msg = f"Provider '{p.name}' ({p.base_url}, {p.model}) returned HTTP {resp.status_code}: {resp.text[:200]}"
                logger.warning(err_msg)
                errors.append(err_msg)
                fell_short(p, ai_health.reason_for_status(resp.status_code), f"HTTP {resp.status_code}: {resp.text[:200]}")
                break

            data = resp.json()
            problem = completion_problem(data)
            if problem is None:
                await ai_health.record_call(
                    kind, "ok" if index == 0 else "fallback",
                    provider=p.name, model=p.model,
                    latency_ms=int((time.monotonic() - started) * 1000),
                    failures=failures,
                )
                return data, p
            if problem == "reasoning_exhausted" and not widened:
                widened = True
                budget = max_tokens + REASONING_RETRY_EXTRA_TOKENS
                logger.warning(
                    "Provider '%s' (%s) spent max_tokens=%d on reasoning; retrying with %d",
                    p.name, p.model, max_tokens, budget,
                )
                fell_short(p, "reasoning_retry", f"max_tokens={max_tokens}")
                continue
            err_msg = f"Provider '{p.name}' ({p.base_url}, {p.model}) returned no usable answer ({problem}, max_tokens={budget})"
            logger.warning(err_msg)
            errors.append(err_msg)
            fell_short(p, problem, f"max_tokens={budget}")
            break

    await ai_health.record_call(kind, "failed", failures=failures)
    raise RuntimeError(f"All {len(providers)} AI providers failed: " + "; ".join(errors))


# Providers (base_url|model) that answered 400 to {"thinking": {"type": "disabled"}}.
_THINKING_SWITCH_REJECTED: set[str] = set()


def _provider_key(p: AIProviderConfig) -> str:
    return f"{p.base_url}|{p.model}"


# Reasoning models (Ark / DashScope coding plans) count their hidden thinking
# against max_tokens. A budget sized for the answer can be spent entirely on
# thinking, which comes back as HTTP 200 with empty or cut-off content.
REASONING_RETRY_EXTRA_TOKENS = 8000


def completion_problem(data: dict) -> str | None:
    """Why a 200 chat/completions response has no usable answer, or None if it has one.

    "reasoning_exhausted": thinking ran into max_tokens, so the answer is missing
    or truncated. "empty": no answer and no tool calls.
    """
    choices = data.get("choices") or []
    if not choices:
        return "empty"
    choice = choices[0]
    msg = choice.get("message") or {}
    if msg.get("tool_calls"):
        return None
    raw = msg.get("content") or ""
    reasoning = msg.get("reasoning_content") or ""
    usage = data.get("usage") or {}
    reasoning_tokens = usage.get("reasoning_tokens") or (usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
    if choice.get("finish_reason") == "length" and (reasoning.strip() or "<think>" in raw or reasoning_tokens):
        return "reasoning_exhausted"
    _, answer = split_thinking(raw, reasoning)
    return None if answer else "empty"


import re


def split_thinking(raw_content: str | None, reasoning_content: str | None = None) -> tuple[str, str]:
    """Separates thinking/reasoning process from user-facing answer content.

    Handles both explicit `reasoning_content` (DeepSeek, Qwen) and inline `<think>...</think>` tags.
    Returns (thinking_text, clean_content).
    """
    thinking_parts: list[str] = []
    clean_content = (raw_content or "").strip()

    if reasoning_content and reasoning_content.strip():
        thinking_parts.append(reasoning_content.strip())

    if "<think>" in clean_content:
        pattern = re.compile(r"<think>(.*?)(?:</think>|$)", re.DOTALL)
        for m in pattern.findall(clean_content):
            if m.strip():
                thinking_parts.append(m.strip())
        clean_content = pattern.sub("", clean_content).strip()

    thinking = "\n\n".join(thinking_parts).strip()
    return thinking, clean_content


async def stream_chat_completion(
    messages: list[dict],
    temperature: float = 0.3,
    max_tokens: int = 2500,
    timeout: float = 120.0,
    user: Any = None,
    custom_settings: dict | None = None,
) -> AsyncGenerator[dict[str, str], None]:
    """Stream text chunks (type: 'thinking' | 'content') from chat/completions with automatic fallback."""
    providers = get_ai_providers(background=False, user=user, custom_settings=custom_settings)
    if not providers:
        raise RuntimeError("No AI API providers configured (missing API keys)")

    errors: list[str] = []
    failures: list[dict[str, str]] = []
    for index, p in enumerate(providers):
        started = False
        began = time.monotonic()
        stream_retries = 0
        while stream_retries <= 2:
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
                        if resp.status_code in (429, 503) and stream_retries < 2:
                            stream_retries += 1
                            wait_s = 1.5 * stream_retries
                            logger.warning(
                                "Provider '%s' stream returned HTTP %d; retrying in %.1fs (retry %d/2)",
                                p.name, resp.status_code, wait_s, stream_retries,
                            )
                            await asyncio.sleep(wait_s)
                            continue

                        if resp.status_code != 200:
                            detail = (await resp.aread()).decode("utf-8", "replace")[:200]
                            err_msg = f"Provider '{p.name}' HTTP {resp.status_code}: {detail}"
                            logger.warning(err_msg)
                            errors.append(err_msg)
                            failures.append({
                                "provider": p.name, "model": p.model,
                                "reason": ai_health.reason_for_status(resp.status_code),
                                "detail": f"HTTP {resp.status_code}: {detail}",
                            })
                            break

                        started = True
                        in_think_tag = False
                        async for line in resp.aiter_lines():
                            if not line or not line.startswith("data: "):
                                continue
                            data_str = line[6:].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data_str)
                                delta = (chunk.get("choices") or [{}])[0].get("delta", {})
                                reasoning = delta.get("reasoning_content") or ""
                                if reasoning:
                                    yield {"type": "thinking", "text": reasoning}

                                content = delta.get("content") or ""
                                if content:
                                    if in_think_tag:
                                        if "</think>" in content:
                                            t_part, c_part = content.split("</think>", 1)
                                            if t_part:
                                                yield {"type": "thinking", "text": t_part}
                                            in_think_tag = False
                                            if c_part:
                                                yield {"type": "content", "text": c_part}
                                        else:
                                            yield {"type": "thinking", "text": content}
                                    elif "<think>" in content:
                                        c_part, rest = content.split("<think>", 1)
                                        if c_part:
                                            yield {"type": "content", "text": c_part}
                                        in_think_tag = True
                                        if "</think>" in rest:
                                            t_part, after = rest.split("</think>", 1)
                                            if t_part:
                                                yield {"type": "thinking", "text": t_part}
                                            in_think_tag = False
                                            if after:
                                                yield {"type": "content", "text": after}
                                        else:
                                            if rest:
                                                yield {"type": "thinking", "text": rest}
                                    else:
                                        yield {"type": "content", "text": content}
                            except Exception:
                                continue

                        await ai_health.record_call(
                            "stream", "ok" if index == 0 else "fallback",
                            provider=p.name, model=p.model,
                            latency_ms=int((time.monotonic() - began) * 1000),
                            failures=failures,
                        )
                        return
            except Exception as e:
                err_msg = f"Provider '{p.name}' stream error: {type(e).__name__}: {e}"
                logger.warning(err_msg)
                errors.append(err_msg)
                failures.append({
                    "provider": p.name, "model": p.model,
                    "reason": ai_health.reason_for_exception(e), "detail": f"{type(e).__name__}: {e}",
                })
                if started:  # broke off mid-answer; the caller already has part of it
                    await ai_health.record_call("stream", "failed", failures=failures)
                    return
                break

    await ai_health.record_call("stream", "failed", failures=failures)
    raise RuntimeError(f"All {len(providers)} AI providers failed to stream: " + "; ".join(errors))


async def call_plain_chat(
    messages: list[dict],
    temperature: float = 0.3,
    max_tokens: int = 1500,
    timeout: float = 120.0,
    user: Any = None,
    custom_settings: dict | None = None,
    background: bool = True,
) -> str | None:
    """Plain completion for background jobs (extraction, summaries, profile), returning
    the clean response string or None. Asks reasoning models not to think."""
    try:
        data, _ = await call_chat_completion(
            messages=messages,
            tools=None,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
            background=background,
            user=user,
            custom_settings=custom_settings,
        )
        choices = data.get("choices") or []
        if choices:
            msg = choices[0].get("message") or {}
            _, clean_content = split_thinking(msg.get("content"), msg.get("reasoning_content"))
            return clean_content or None
        return None
    except Exception as e:
        logger.warning("call_plain_chat failed across all providers: %s", e)
        return None