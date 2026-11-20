"""Encrypt secrets users hand us (their model API keys) before they go into the database.

A sealed value is "enc:v1:" + a Fernet token (AES-128-CBC + HMAC-SHA256). The key comes from
MEMENTO_DATA_KEY when set (any string; a 32-byte key is derived from it), else from
MEMENTO_SECRET_KEY, so an existing deployment encrypts without new configuration. Changing the
key makes sealed values unreadable: reveal() then returns "" and the user re-enters the key.

Values saved before this existed are plaintext; reveal() passes them through and
seal_existing() (run at startup) seals them in place.
"""

from __future__ import annotations

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

from ..config import settings

logger = logging.getLogger("server.secret_box")

PREFIX = "enc:v1:"
# The fields of users.llm_settings holding secrets
LLM_SECRET_FIELDS = ("api_key", "fallback_api_key")


def _fernet() -> Fernet:
    raw = settings.data_key or settings.secret_key
    key = base64.urlsafe_b64encode(hashlib.sha256(("memento-data-key:" + raw).encode("utf-8")).digest())
    return Fernet(key)


def is_sealed(value: str | None) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def seal(value: str | None) -> str:
    """Encrypt; empty stays empty, an already-sealed value is returned as is."""
    if not value:
        return ""
    if is_sealed(value):
        return value
    return PREFIX + _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def reveal(value: str | None) -> str:
    """Decrypt a sealed value; plaintext (saved before sealing) is returned unchanged."""
    if not value:
        return ""
    if not is_sealed(value):
        return value
    try:
        return _fernet().decrypt(value[len(PREFIX):].encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        logger.warning("a stored secret can't be decrypted (MEMENTO_DATA_KEY / MEMENTO_SECRET_KEY changed?)")
        return ""


def seal_llm_settings(data: dict | None) -> dict:
    out = dict(data or {})
    for f in LLM_SECRET_FIELDS:
        if out.get(f):
            out[f] = seal(str(out[f]).strip())
    return out


def reveal_llm_settings(data: dict | None) -> dict:
    out = dict(data or {})
    for f in LLM_SECRET_FIELDS:
        if out.get(f):
            out[f] = reveal(out[f])
    return out


def mask_secret(value: str | None) -> str:
    """Return a non-reversible masked preview of a secret for UI display."""
    raw = (value or "").strip()
    if not raw:
        return ""
    if len(raw) <= 6:
        return "••••"
    return f"{raw[:3]}••••{raw[-3:]}"


def seal_fields(data: dict | None, secret_fields: tuple[str, ...] | list[str]) -> dict:
    out = dict(data or {})
    for f in secret_fields:
        val = out.get(f)
        if isinstance(val, str) and val.strip():
            out[f] = seal(val.strip())
    return out


def reveal_fields(data: dict | None, secret_fields: tuple[str, ...] | list[str]) -> dict:
    out = dict(data or {})
    for f in secret_fields:
        val = out.get(f)
        if isinstance(val, str) and val:
            out[f] = reveal(val)
    return out


def seal_existing(conn) -> int:
    """Seal plaintext keys already in users.llm_settings (sync connection, at startup). Idempotent."""
    from sqlalchemy import text

    rows = conn.execute(text(
        "SELECT id, llm_settings FROM users WHERE "
        "(llm_settings->>'api_key' <> '' AND llm_settings->>'api_key' NOT LIKE 'enc:v1:%') OR "
        "(llm_settings->>'fallback_api_key' <> '' AND llm_settings->>'fallback_api_key' NOT LIKE 'enc:v1:%')"
    )).all()
    import json

    for uid, data in rows:
        conn.execute(
            text("UPDATE users SET llm_settings = CAST(:d AS JSONB) WHERE id = :id"),
            {"d": json.dumps(seal_llm_settings(data)), "id": uid},
        )
    return len(rows)
