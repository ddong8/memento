"""An agent's own report that the account's quota ran out: the run then reads as that, not as done,
failed for no reason, or still going in the background."""

from __future__ import annotations

import re

USAGE_LIMIT = "usage_limit"

# Claude Code: "You've hit your session limit · resets 12:10pm (Asia/Shanghai)" (weekly limit reads the same);
# Codex: "You've hit your usage limit. …"; older Claude Code: "Claude AI usage limit reached|<epoch>".
# Read up to a quote too, for when it turns up inside a logged JSON line.
_USAGE_LIMIT = re.compile(r"You(?:'|’)ve hit your [\w' ]*limit[^\n\"]*|You(?:'|’)ve hit your team(?:'|’)s shared budget[^\n\"]*|usage limit reached[^\n\"]*", re.I)
# A limit of one model, not of the account: the daemon goes on with another model, so these count only for
# a run that failed. Claude Code's own weekly limit for Opus / Sonnet / Fable and a team's budget for a model,
# Codex's "usage limit for GPT-…. Switch to another model now", Antigravity's "Individual quota reached. …
# Resets in 58h12m23s." (its quota is per model).
_MODEL_LIMIT = re.compile(
    r"You(?:'|’)ve hit your (?:Opus|Sonnet|Fable|Haiku) limit|You(?:'|’)ve hit your team(?:'|’)s shared budget"
    r"|You(?:'|’)ve hit your usage limit for ",
    re.I,
)
_AGY_QUOTA = re.compile(r"Individual quota reached[^\n\"]*", re.I)


def usage_limit_message(result: dict | None) -> str | None:
    """The quota message an agent task ended on. Only what the agent reported as its error is read
    (error, stderr), not its answer, which may well discuss limits."""
    if not result or (result.get("action") or "agent") != "agent":
        return None
    failed = result.get("status") == "failed"
    for key in ("error", "stderr"):
        text = str(result.get(key) or "")
        for m in _USAGE_LIMIT.finditer(text):
            if failed or not _MODEL_LIMIT.match(m.group(0)):
                return m.group(0).strip()
        if failed and (m := _AGY_QUOTA.search(text)):
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
