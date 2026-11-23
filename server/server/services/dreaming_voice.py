"""User voice sanitization, batching, and signal extraction helpers for the Dreaming pipeline."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Boolean, func, not_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ConversationMessage, Document, Machine, Project, User

logger = logging.getLogger("server.dreaming_service")


def _safe_json_loads(text: str) -> dict[str, Any]:
    """Robustly parse JSON output from LLM, stripping markdown, code blocks and trailing commas."""
    if not text:
        return {}
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    cleaned = cleaned.strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}") + 1
    if start >= 0 and end > start:
        snippet = cleaned[start:end]
        try:
            return json.loads(snippet)
        except Exception:
            fixed = re.sub(r",\s*([\]}])", r"\1", snippet)
            try:
                return json.loads(fixed)
            except Exception:
                pass
    return {}


# Noise patterns to strip during Light Sleep
_BASE64_DATA_RE = re.compile(
    r"data:image/[a-zA-Z0-9\+\.\-]+;base64,[A-Za-z0-9+/=]{40,}",
    re.IGNORECASE,
)
_RAW_BASE64_BLOB_RE = re.compile(r"([A-Za-z0-9+/]{120,}={0,2})")


def sanitize_transient_text(text: str) -> str:
    """Strip base64 data and truncate massive logs for dreaming digestion."""
    if not text:
        return ""
    cleaned = _BASE64_DATA_RE.sub("[image_base64_omitted]", text)
    cleaned = _RAW_BASE64_BLOB_RE.sub("[binary_blob_omitted]", cleaned)
    if len(cleaned) > 2500:
        cleaned = cleaned[:1500] + "\n...[中段内容修剪]...\n" + cleaned[-800:]
    return cleaned.strip()


# ---------------------------------------------------------------------------
# User voice — the only input trusted for preferences and rules
# ---------------------------------------------------------------------------
# Transcripts label a lot of machine-generated text as role="user": tool results,
# slash-command echoes, harness reminders, compaction preambles, injected AGENTS.md.
# None of it was typed by the user, and some of it (web pages, third-party code) is
# attacker-controllable, so it must never be learned as a preference.
_NON_USER_PREFIXES = (
    "[Result]",
    "[Tool:",
    '{"tool_use_id"',
    "<command-",
    "<local-command",
    "<system-reminder>",
    "<task-notification>",
    "<environment_context>",
    "<user_instructions>",
    "# AGENTS.md",
    "Caveat:",
    "This session is being continued",
    "[Request interrupted",
    "[OpenClaw heartbeat",
    # written by an agent, not typed (11-09: 36 WorkBuddy compaction summaries and 26 Antigravity
    # delegations were read as the user's words; a summary is full of "用户要求…")
    "<conversation_history_summary>",
    "<cb_summary>",
    "<analysis>",
    "<original_task>",
)
_EMBEDDED_CONTEXT_RE = re.compile(
    r"<(system-reminder|ide_selection|ide_opened_file|environment_context|user_instructions"
    r"|external_codex_apps_open_page)>[\s\S]*?</\1>"
)
# Claude Code subagent transcripts: their "user" turns are prompts written by the parent agent.
SUBAGENT_PATH_REGEX = r"(^|/)agent-[0-9a-f]+\.jsonl$"
_TRIVIAL_REPLIES = frozenset({
    "continue", "go on", "ok", "okay", "yes", "y", "no", "n", "thanks",
    "继续", "好", "好的", "嗯", "是", "对", "可以", "行", "需要", "提交", "在吗", "谢谢",
})
# Marks the moments a user pushes back on an AI — the richest signal about who they are.
_CORRECTION_RE = re.compile(
    r"不对|错了|不要|别再|不用|我说过|说了多少|以后|每次|永远|一律|必须|禁止|记住|怎么又|还是没|为什么"
    r"|\bdon'?t\b|\bnever\b|\balways\b|\bstop\b|\bwrong\b|\binstead\b|\bremember\b",
    re.IGNORECASE,
)

USER_VOICE_MSG_CHARS = 300      # head of a message: the user's own framing, not the log they pasted
USER_VOICE_BATCH_CHARS = 12000  # per LLM call
USER_VOICE_MAX_BATCHES = 6      # bounds cost on very busy windows
USER_VOICE_FETCH_LIMIT = 4000


# A script's prompt to a model ("你是资深有机合成专家。给你一个化合物…", "You are an expert reviewer…"),
# sent through a CLI session so it is stored as role="user". On 2026-10-27 one batch job's review prompt
# accounted for 91 of the corrections waiting to be learned. Only long text counts: a user saying
# "你是专家，怎么还犯这种错" is talking to the AI.
_SCRIPTED_PROMPT_RE = re.compile(
    r"^(?:你是|您是)(?:一[名位个])?[^，,。！？!?\n]{0,24}?"
    r"(?:专家|助手|工程师|负责人|分析师|顾问|评审|审稿人|架构师|研究员|翻译)[。，,.:：；;！!\s]"
    r"|^you are (?:an?|the) [^.\n]{0,60}?"
    r"(?:expert|assistant|engineer|reviewer|analyst|specialist|architect|consultant|researcher|translator)\b",
    re.IGNORECASE,
)
SCRIPTED_PROMPT_MIN_CHARS = 120

# Continuing a session, Memento sends the earlier session's snapshot (quoting the user's old words)
# in front of the prompt (session_compactor.format_injected_context); only what follows the
# "当前用户指令" marker was typed this time. A snapshot with no prompt after it is dropped.
# daemon antigravity.ts also writes "【前文对话历史（续接自 Antigravity 桌面会话 xxxxxxxx）】" when it bridges a
# desktop conversation to the agy CLI (11 of them in the 14 days to 11-24).
_INJECTED_CONTEXT_RE = re.compile(
    r"^(?:Memento: )?(?:【前序会话核心记忆快照|【前文对话历史(?:（[^】]{0,60}）)?】)[\s\S]*?(?:当前用户指令[：:]|【当前用户指令】)\s*"
)
_INJECTED_CONTEXT_HEADS = ("【前序会话核心记忆快照", "【前文对话历史", "Memento: 【前序会话核心记忆快照")

# Another agent's report posted into the session as a user message: from 10-30 to 11-01 Antigravity
# pipelines sent 31 ("DeepCoder pipeline completed. **Worker Report**: > [!WARNING] Skepticism
# Disclaimer …"); two were learned as the user pushing back on a rule, and a nightly memory said the
# user wants reports to carry a Skepticism Disclaimer.
_AGENT_REPORT_RE = re.compile(r"^[\w.-]+ pipeline (?:completed|failed)\b|\*\*Worker Report\*\*|Skepticism Disclaimer", re.IGNORECASE)
# Antigravity image subagents, both directions stored as role="user" (14 days to 11-24: 197 reports
# "Generated image: `…/.gemini/antigravity/brain/<id>/x.jpg` Depicts …" and 181 English delegations
# "Generate a 9:16 vertical photorealistic … keyframe image …" written by the parent agent).
_SUBAGENT_IMAGE_REPORT_RE = re.compile(
    r"^(?:(?:Generated|Final|Saved|Output) image(?: path)?\s*:\s*)?`?\S*/\.gemini/antigravity(?:-cli)?/brain/", re.IGNORECASE
)
_SUBAGENT_IMAGE_TASK_RE = re.compile(r"^Generate an? [^\n]{0,120}?\b(?:image|keyframe|still|portrait)\b", re.IGNORECASE)

# Prompts Memento itself sends to an agent, stored as role="user". From 11-18 to 11-22 they were 28 of the
# week's 82 "corrections" and taught a rule whose evidence was "the user asked 7 times with the same template".
# - business_blueprint.generation_prompt: the whole message is generated, dropped.
# - daemon source-exec.ts sourceExecHint, put on top of a Codex / Antigravity task as "<hint>\n\n---\n\n<prompt>":
#   only what follows the separator was typed. A hint with nothing after it is dropped.
# Adding a prompt template there means adding it here (tests/test_dreaming_voice.py keeps them in step).
_GENERATED_PROMPT_RE = re.compile(r"^请为项目 .{1,120}? (?:更新仓库根目录已有的|在仓库根目录新建) BUSINESS_BLUEPRINT\.md")
_EXECUTOR_HINT_RE = re.compile(r"^\[只在这里改代码\][\s\S]*?(?:\n-{3,}\n|$)\s*")
# For SQL filters (Postgres ARE) on raw message content: the generated prompts that carry no typed words.
GENERATED_PROMPT_SQL_RE = r"^请为项目 .{1,120}? (更新仓库根目录已有的|在仓库根目录新建) BUSINESS_BLUEPRINT\.md"
# Same for the Antigravity image subagents' reports and delegations (see _SUBAGENT_IMAGE_*_RE below).
SUBAGENT_IMAGE_SQL_RE = (
    r"^\s*(((Generated|Final|Saved|Output) image( path)?\s*:\s*)?`?\S*/\.gemini/antigravity(-cli)?/brain/"
    r"|Generate an? [^\n]{0,120}?(image|keyframe|still|portrait))"
)

_CLIENT_INJECTED_BLOCK_RE = re.compile(
    r"(?:【用户上传了(?:图片|附件)\s*#\d+】[\s\S]*?(?:\n\n|$)|\[本轮答复已输出[^\]]*\])"
)


def clean_user_voice(content: str | None) -> str | None:
    """Return the part of a role="user" message the user actually typed, or None."""
    if not content:
        return None
    text = _CLIENT_INJECTED_BLOCK_RE.sub("", content).strip()
    text = _INJECTED_CONTEXT_RE.sub("", text, count=1).strip()
    text = _EXECUTOR_HINT_RE.sub("", text, count=1).strip()
    if not text or _GENERATED_PROMPT_RE.match(text):
        return None
    if text.startswith(_NON_USER_PREFIXES) or text.startswith(_INJECTED_CONTEXT_HEADS):
        return None
    text = _EMBEDDED_CONTEXT_RE.sub("", text)
    text = re.sub(r"\s+", " ", sanitize_transient_text(text)).strip()
    if len(text) < 2 or text.isdigit() or text.lower().strip(" .!！。") in _TRIVIAL_REPLIES:
        return None
    if len(text) >= SCRIPTED_PROMPT_MIN_CHARS and _SCRIPTED_PROMPT_RE.match(text):
        return None
    if _AGENT_REPORT_RE.search(text) or _SUBAGENT_IMAGE_REPORT_RE.match(text) or _SUBAGENT_IMAGE_TASK_RE.match(text):
        return None
    if len(text) > USER_VOICE_MSG_CHARS:
        text = text[:USER_VOICE_MSG_CHARS] + "…"
    return text


def plan_user_voice_batches(
    rows: list[tuple[str | None, datetime | None]] | list[tuple[str | None, datetime | None, str | None]],
) -> tuple[list[list[str]], dict[str, int]]:
    """Clean, dedupe and pack newest-first user messages into prompt-sized batches.

    Corrections are packed first so that when a busy window overflows the batch cap,
    what gets dropped is ordinary chatter rather than the times the user told an AI
    it was wrong. Each batch is rendered oldest-first for the LLM to read.
    """
    seen: set[str] = set()
    corrections: list[tuple[datetime | None, str]] = []
    others: list[tuple[datetime | None, str]] = []
    for row in rows:
        content, ts = row[0], row[1]
        where = row[2] if len(row) > 2 else None
        text = clean_user_voice(content)
        if not text or text.lower() in seen:
            continue
        seen.add(text.lower())
        # "[memento @ Mac-mini] ..." lets the profile tell a project's rule from a general one.
        tagged = f"[{where}] {text}" if where else text
        (corrections if _CORRECTION_RE.search(text) else others).append((ts, tagged))

    packed: list[list[tuple[datetime | None, str]]] = []
    current: list[tuple[datetime | None, str]] = []
    size = 0
    for item in corrections + others:
        cost = len(item[1]) + 16
        if current and size + cost > USER_VOICE_BATCH_CHARS:
            packed.append(current)
            current, size = [], 0
            if len(packed) == USER_VOICE_MAX_BATCHES:
                break
        current.append(item)
        size += cost
    else:
        if current:
            packed.append(current)

    epoch = datetime.min.replace(tzinfo=timezone.utc)
    batches = [
        [
            f"[{ts.strftime('%m-%d %H:%M') if ts else '?'}] {text}"
            for ts, text in sorted(batch, key=lambda x: x[0] or epoch)
        ]
        for batch in packed
    ]
    stats = {
        "candidates": len(rows),
        "kept": len(corrections) + len(others),
        "corrections": len(corrections),
        "used": sum(len(b) for b in batches),
        "batches": len(batches),
    }
    return batches, stats



async def fetch_user_voice_rows(
    db: AsyncSession, user: User, since_dt: datetime, until_dt: datetime, *, with_source: bool = False,
) -> list[tuple]:
    """Newest-first role="user" messages from the user's machines, minus tool output
    and subagent transcripts (whose "user" turns were written by the parent agent).

    with_source adds a third element, "project @ device", for telling a rule that
    holds in one project or on one machine from a general one."""
    user_machines_subq = select(Machine.id).where(Machine.user_id == user.id)
    columns = [ConversationMessage.content, ConversationMessage.timestamp]
    if with_source:
        columns += [Project.title, Machine.name]
    query = select(*columns).join(Document, Document.id == ConversationMessage.document_id)
    if with_source:
        query = query.outerjoin(Project, Project.id == Document.project_id).outerjoin(
            Machine, Machine.id == Document.machine_id
        )
    res = await db.execute(
        query
        .where(
            Document.machine_id.in_(user_machines_subq),
            ConversationMessage.role == "user",
            ConversationMessage.timestamp >= since_dt,
            ConversationMessage.timestamp <= until_dt,
            ~ConversationMessage.content.startswith("[Result]"),
            not_(Document.relative_path.op("~", return_type=Boolean)(SUBAGENT_PATH_REGEX)),
            ~func.coalesce(Document.metadata_.has_key("parent_session_id"), False),
        )
        .order_by(ConversationMessage.timestamp.desc())
        .limit(USER_VOICE_FETCH_LIMIT)
    )
    if not with_source:
        return list(res.all())
    from .profile_service import clean_device_name

    return [
        (content, ts, " @ ".join(filter(None, [project, clean_device_name(machine) if machine else None])) or None)
        for content, ts, project, machine in res.all()
    ]

_VOICE_SIGNAL_PROMPT = """下面是用户本人在各个 AI 工具里亲手输入的话（已去掉工具输出和系统注入内容），按时间排序。
请只从这些原话中提取能长期指导 AI 如何与该用户协作的信号：
- correction：用户指出 AI 做错了什么、要求别再怎么做
- preference：沟通语言、回复风格、工作流、技术选型习惯
- rule：用户明确要求"以后 / 每次 / 必须 / 禁止"的规则
忽略一次性的任务指令（如"帮我修这个 bug"）。每条信号都必须能在原话里找到依据，不要推测。

{quotes}

原话前面如果有 [项目 @ 设备] 标注，把它原样填进 source，没有就留空。

只输出 JSON：{{"signals": [{{"kind": "correction|preference|rule", "statement": "一句话概括", "evidence": "原话片段", "source": ""}}]}}
"""


async def _extract_voice_signals(batch: list[str]) -> list[dict[str, str]]:
    from . import dreaming_service as _ds
    raw = await _ds.call_plain_chat(
        messages=[
            {"role": "system", "content": "You extract durable user preferences. Respond only with valid JSON."},
            {"role": "user", "content": _VOICE_SIGNAL_PROMPT.format(quotes="\n".join(batch))},
        ],
        max_tokens=1200,
    )
    signals = _safe_json_loads(raw or "").get("signals") or []
    return [s for s in signals if isinstance(s, dict) and str(s.get("statement") or "").strip()]


async def render_user_voice(batches: list[list[str]]) -> str:
    """One batch goes to the dream prompt verbatim; more are condensed batch-by-batch first."""
    if not batches:
        return ""
    from . import dreaming_service as _ds
    if len(batches) == 1 or not _ds.get_ai_providers():
        return "\n".join(batches[0])

    sem = asyncio.Semaphore(3)

    async def run(batch: list[str]) -> list[dict[str, str]]:
        async with sem:
            try:
                return await _extract_voice_signals(batch)
            except Exception as e:
                logger.warning("User-voice signal extraction failed for one batch: %s", e)
                return []

    results = await asyncio.gather(*(run(b) for b in batches))
    lines: list[str] = []
    seen: set[str] = set()
    for signals in results:
        for s in signals:
            statement = str(s["statement"]).strip()
            if statement.lower() in seen:
                continue
            seen.add(statement.lower())
            evidence = str(s.get("evidence") or "").strip()[:120]
            kind = str(s.get("kind") or "signal").strip()
            source = str(s.get("source") or "").strip().strip("[]")[:80]
            lines.append(
                f"- [{kind}] {statement}"
                + (f"（原话：{evidence}）" if evidence else "")
                + (f"（出自 {source}）" if source else "")
            )
    # Every extraction failed: fall back to the correction-heavy first batch.
    return "\n".join(lines) if lines else "\n".join(batches[0])
