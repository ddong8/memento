"""What resuming a Claude Code session will cost, read from its own transcript.

Every request in a resumed session carries the whole conversation so far. Claude Code logs each
request's usage, so the latest assistant entry's input + cache_creation + cache_read tokens is the
context the next step will carry. A session also ran in some client last (VS Code, the terminal,
or memento, logged as `memento` from desktop 1.0.94 on and as `claude -p`'s `sdk-cli` before): the
prompt cache is per client and lasts an hour, so continuing it from memento right after another client,
or after an hour, first re-writes the whole context to the cache.

Measured on a 276 MB session resumed from memento: about 510k tokens per step, with 320k–590k
re-cached at every switch from VS Code and after every idle hour.

Compacting is left to Claude Code itself, by each model's own context window, as in the terminal: memento
sets no window of its own and never starts a new session on its own. The one exception is a session's first
continuation where it can't go on in place (it isn't on the device that runs this turn): that starts from a
compacted snapshot (ask_stream), and later turns resume the new session in place.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

# Above this much context the resume banner says how much each step carries.
HEAVY_CONTEXT_TOKENS = int(os.environ.get("MEMENTO_SESSION_HEAVY_TOKENS", "150000"))
# Claude Code writes its prompt cache for an hour.
CACHE_TTL_MINUTES = 60
# The client names memento's runs carry: its own, or sdk-cli (before desktop 1.0.94, or when the user keeps it)
MEMENTO_CLIENT = "memento"
MEMENTO_CLIENTS = frozenset({MEMENTO_CLIENT, "sdk-cli"})
CLIENT_NAMES = {"claude-vscode": "VS Code", "cli": "终端", "sdk-cli": "Memento", MEMENTO_CLIENT: "Memento"}


def session_activity(content: str) -> dict:
    """context_tokens / context_at from the latest request and last_client / last_client_at from
    the latest entry that names its client; only the keys found in this piece of transcript."""
    found: dict = {}
    for line in reversed(content.splitlines()):
        if len(found) == 4:
            break
        if '"entrypoint"' not in line and '"usage"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("isSidechain"):
            continue
        ts = entry.get("timestamp")
        if "last_client" not in found and entry.get("entrypoint") and ts:
            found["last_client"] = str(entry["entrypoint"])
            found["last_client_at"] = str(ts)
        msg = entry.get("message")
        usage = msg.get("usage") if isinstance(msg, dict) else None
        if "context_tokens" not in found and entry.get("type") == "assistant" and isinstance(usage, dict):
            tokens = sum(int(usage.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
            if tokens and msg.get("model") != "<synthetic>":
                found["context_tokens"] = tokens
                found["context_at"] = str(ts or "")
    return found


def _minutes_since(iso: str | None, now: datetime) -> int | None:
    if not iso:
        return None
    try:
        at = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return max(0, int((now - at).total_seconds() // 60))


def resume_cost(meta: dict | None, now: datetime | None = None) -> dict:
    """What the next step of this session costs from memento, for the session picker and the resume banner."""
    meta = meta or {}
    now = now or datetime.now(timezone.utc)
    tokens = meta.get("context_tokens")
    if not isinstance(tokens, int) or tokens <= 0:
        return {}
    client = meta.get("last_client")
    idle = _minutes_since(meta.get("last_client_at"), now)
    return {
        "context_tokens": tokens,
        "heavy": tokens > HEAVY_CONTEXT_TOKENS,
        "last_client": CLIENT_NAMES.get(client, client) if client else None,
        "minutes_since_activity": idle,
        # The next step re-writes the whole context to the cache: another client used it last
        # (its cache isn't memento's), or it sat for longer than the cache lives.
        "other_client_recent": bool(client and client not in MEMENTO_CLIENTS and idle is not None and idle < CACHE_TTL_MINUTES),
        "cache_cold": bool(idle is not None and idle >= CACHE_TTL_MINUTES),
    }


def memento_client(llm_settings: dict | None) -> bool:
    """Whether this user's Claude Code runs go out under memento's own client name (the default) instead of
    sdk-cli. As sdk-cli their sessions are hidden from `claude --resume` in the terminal, and the 5-hour limit
    is reported to drain faster (anthropics/claude-code#97074)."""
    agent = (llm_settings or {}).get("agent")
    return not (isinstance(agent, dict) and agent.get("claude_memento_client") is False)


def claude_entrypoint(llm_settings: dict | None) -> str:
    """The client name the device's Claude Code runs under, for the task payload."""
    return MEMENTO_CLIENT if memento_client(llm_settings) else "sdk-cli"
