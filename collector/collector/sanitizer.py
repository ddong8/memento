"""Sensitive data sanitizer — filters secrets before sync."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

# Regex patterns for common secrets
_PATTERNS: list[tuple[re.Pattern, str]] = [
    # API keys
    (re.compile(r"sk-[a-zA-Z0-9]{20,}"), "[API_KEY_REDACTED]"),
    (re.compile(r"sk-ant-[a-zA-Z0-9\-]{20,}"), "[ANTHROPIC_KEY_REDACTED]"),
    # GitHub tokens
    (re.compile(r"ghp_[a-zA-Z0-9]{36}"), "[GITHUB_TOKEN_REDACTED]"),
    (re.compile(r"gho_[a-zA-Z0-9]{36}"), "[GITHUB_OAUTH_REDACTED]"),
    (re.compile(r"github_pat_[a-zA-Z0-9_]{22,}"), "[GITHUB_PAT_REDACTED]"),
    # Slack tokens
    (re.compile(r"xoxb-[a-zA-Z0-9\-]+"), "[SLACK_BOT_TOKEN_REDACTED]"),
    (re.compile(r"xoxp-[a-zA-Z0-9\-]+"), "[SLACK_USER_TOKEN_REDACTED]"),
    # Telegram bot tokens
    (re.compile(r"bot\d+:[A-Za-z0-9_-]{35}"), "[TELEGRAM_BOT_TOKEN_REDACTED]"),
    (re.compile(r"\d{8,}:[A-Za-z0-9_-]{35}"), "[TELEGRAM_TOKEN_REDACTED]"),
    # Private keys
    (re.compile(
        r"-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
        r"[\s\S]*?"
        r"-----END\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
        re.MULTILINE,
    ), "[PRIVATE_KEY_REDACTED]"),
    # Generic secret patterns (key=value or key: value)
    (re.compile(
        r'(?i)(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)'
        r'\s*[:=]\s*["\']?([^\s"\']{8,})["\']?'
    ), r"\1=[REDACTED]"),
    # Bearer tokens in headers
    (re.compile(r"Bearer\s+[a-zA-Z0-9\-_.]+"), "Bearer [TOKEN_REDACTED]"),
    # URLs with embedded credentials (limit to single line, reasonable length)
    (re.compile(r"(https?://)[^\s:]{1,100}:[^\s@]{1,100}@"), r"\1[CREDS_REDACTED]@"),
    # AWS keys
    (re.compile(r"AKIA[0-9A-Z]{16}"), "[AWS_ACCESS_KEY_REDACTED]"),
    # OpenAI keys
    (re.compile(r"sk-proj-[a-zA-Z0-9\-]{20,}"), "[OPENAI_KEY_REDACTED]"),
]

# JSON keys to strip entirely from parsed JSON content
DEFAULT_SENSITIVE_KEYS = frozenset({
    "token", "secret", "password", "apiKey", "api_key",
    "accessToken", "access_token", "refreshToken", "refresh_token",
    "botToken", "bot_token", "authToken", "auth_token",
    "privateKey", "private_key", "credentials",
})


@dataclass
class SanitizeResult:
    content: str
    redaction_count: int
    has_sensitive_content: bool


def sanitize_text(text: str) -> SanitizeResult:
    """Apply regex-based sanitization to text content."""
    count = 0
    result = text
    for pattern, replacement in _PATTERNS:
        result, n = pattern.subn(replacement, result)
        count += n
    return SanitizeResult(
        content=result,
        redaction_count=count,
        has_sensitive_content=count > 0,
    )


def sanitize_json(
    text: str,
    extra_sensitive_keys: frozenset[str] | None = None,
) -> SanitizeResult:
    """Sanitize JSON content: strip sensitive keys, then apply regex patterns."""
    sensitive_keys = DEFAULT_SENSITIVE_KEYS
    if extra_sensitive_keys:
        sensitive_keys = sensitive_keys | extra_sensitive_keys

    count = 0

    try:
        data = json.loads(text)
        data, key_count = _strip_keys(data, sensitive_keys)
        count += key_count
        text = json.dumps(data, indent=2, ensure_ascii=False)
    except (json.JSONDecodeError, TypeError):
        pass

    # Also apply regex patterns
    result = sanitize_text(text)
    return SanitizeResult(
        content=result.content,
        redaction_count=count + result.redaction_count,
        has_sensitive_content=(count + result.redaction_count) > 0,
    )


def _strip_keys(obj: object, keys: frozenset[str]) -> tuple[object, int]:
    """Recursively strip sensitive keys from a JSON-like object."""
    count = 0
    if isinstance(obj, dict):
        cleaned = {}
        for k, v in obj.items():
            if k in keys or k.lower() in {s.lower() for s in keys}:
                cleaned[k] = "[REDACTED]"
                count += 1
            else:
                v, c = _strip_keys(v, keys)
                cleaned[k] = v
                count += c
        return cleaned, count
    elif isinstance(obj, list):
        result = []
        for item in obj:
            item, c = _strip_keys(item, keys)
            result.append(item)
            count += c
        return result, count
    return obj, 0
