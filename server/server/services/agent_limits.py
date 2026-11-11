"""An agent's own report that the account's quota ran out: the run then reads as that, not as done,
failed for no reason, or still going in the background."""

from __future__ import annotations

import re

USAGE_LIMIT = "usage_limit"

# Claude Code: "You've hit your session limit · resets 12:10pm (Asia/Shanghai)" (weekly / Opus limits read
# the same); Codex: "You've hit your usage limit. …"; older Claude Code: "Claude AI usage limit reached|<epoch>".
# Read up to a quote too, for when it turns up inside a logged JSON line.
_USAGE_LIMIT = re.compile(r"You(?:'|’)ve hit your [\w ]*limit[^\n\"]*|usage limit reached[^\n\"]*", re.I)
# Antigravity: "Individual quota reached. Please upgrade your subscription … Resets in 58h12m23s.". The quota
# is per model and the daemon goes on with another one, so it counts only for a run that failed.
_AGY_QUOTA = re.compile(r"Individual quota reached[^\n\"]*", re.I)


def usage_limit_message(result: dict | None) -> str | None:
    """The quota message an agent task ended on. Only what the agent reported as its error is read
    (error, stderr), not its answer, which may well discuss limits."""
    if not result or (result.get("action") or "agent") != "agent":
        return None
    patterns = [_USAGE_LIMIT] + ([_AGY_QUOTA] if result.get("status") == "failed" else [])
    for pattern in patterns:
        for key in ("error", "stderr"):
            m = pattern.search(str(result.get(key) or ""))
            if m:
                return m.group(0).strip()
    return None


def mark_usage_limit(result: dict) -> dict:
    """An agent task that ended on its quota failed, whatever else it said: daemons before 1.0.90 reported
    it as still_running when the agent had background work open, and the answer as done."""
    msg = usage_limit_message(result)
    if msg:
        result["status"] = "failed"
        result["error_type"] = USAGE_LIMIT
        result["error"] = msg
    return result
