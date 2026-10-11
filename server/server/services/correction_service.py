"""Learn from corrections as they happen, and measure whether the learning sticks.

Every few minutes the user's newly synced messages are scanned for pushback on
an AI ("不对", "别再…", "我说过…"). The background model decides which are
durable guidance and which known topic each one repeats. A new topic waits for
the user to accept it: that writes a memory and adds a line to the published
profile, so every tool picks it up on its next sync, not after the nightly run.

Every correction is also logged as an event, marked as a repeat when the topic
was already known and as "already learned" when it had been accepted. Fewer
repeats over time is the plainest evidence that Memento is getting to know
the user; repeats of learned topics mean the lesson isn't reaching the AI.
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    ConversationMessage,
    CorrectionEvent,
    CorrectionTopic,
    Document,
    Machine,
    Project,
    User,
    UserMemory,
    UserProfile,
)
from . import ai_health
from .ai_provider import call_plain_chat
from .dreaming_service import _CORRECTION_RE, SUBAGENT_PATH_REGEX, _safe_json_loads, clean_user_voice
from .profile_service import (
    PROFILE_MAX_CHARS,
    SCOPED_MAX_CHARS,
    clean_device_name,
    get_draft_profile,
    get_published_profile,
    join_profile_scopes,
    norm_scope_name,
    sanitize_profile_content,
    split_profile_scopes,
)

logger = logging.getLogger("server.corrections")

CATEGORY_HEADINGS = {"communication": "沟通", "rule": "铁律", "workflow": "工作方式", "tech": "技术偏好"}
BACKFILL = timedelta(days=30)
SCAN_LIMIT = 1000  # raw user messages per run; the cursor catches up over a few runs
LLM_BATCH = 25
KNOWN_LIMIT = 120
STATEMENT_MAX = 200


# Wider than dreaming's _CORRECTION_RE, which misses the plainest pushback
# ("中文回复我", "怎么变成英文的了"). Cheap prefilter only: the model decides.
_PUSHBACK_RE = re.compile(
    r"又|还是|怎么变|怎么还|中文|英文|我要的是|我想要|我说的是|不是这个|理解错|搞错|弄错|你没有?|"
    r"别|不准|不许|不能|不应该|应该|太长|太啰嗦|啰嗦|简洁|简短|直接说|先给结论|说重点|回复我|"
    r"\bplease\b|\bi said\b|\bagain\b|\bkeep\b|\btoo (?:long|verbose)\b|\bin (?:english|chinese)\b",
    re.IGNORECASE,
)


def looks_like_pushback(text: str) -> bool:
    return bool(_CORRECTION_RE.search(text) or _PUSHBACK_RE.search(text))


class ProfileFull(Exception):
    """Adding the line would push the profile past PROFILE_MAX_CHARS."""


@dataclass
class Said:
    message_id: int
    text: str
    said_at: datetime
    project: str | None = None
    device: str | None = None

    @property
    def where(self) -> str:
        return " @ ".join(filter(None, [self.project, self.device]))


def fingerprint(said: Said) -> str:
    return hashlib.sha1(f"{said.said_at.isoformat()}|{said.text}".encode()).hexdigest()


def clean_statement(text: str) -> str:
    """One line addressed to the AI, safe to drop into the profile block."""
    line = re.sub(r"\s+", " ", text or "").strip()
    line = re.sub(r"^[-*•\d.、\s]+", "", line)
    line = line.replace("<!--", "").replace("-->", "").strip()
    return line[:STATEMENT_MAX]


def learned_by(topic: CorrectionTopic, when: datetime) -> bool:
    """Whether the topic had been accepted by the time the user said it again."""
    return topic.status == "accepted" and (topic.accepted_at is None or topic.accepted_at <= when)


def _add_general_line(general: str, heading: str, bullet: str) -> str:
    lines = general.rstrip().split("\n") if general.strip() else []
    start = next((i for i, existing in enumerate(lines) if existing.strip().lstrip("#").strip() == heading
                  and existing.strip().startswith("#")), None)
    if start is None:
        # New section, placed in the profile's usual order (沟通 → 铁律 → 工作方式 → 技术偏好).
        order = list(CATEGORY_HEADINGS.values())
        later = set(order[order.index(heading) + 1:]) if heading in order else set()
        before = next((i for i, existing in enumerate(lines)
                       if existing.strip().startswith("#") and existing.strip().lstrip("#").strip() in later), None)
        if before is None:
            return "\n".join(lines + ([""] if lines else []) + [f"### {heading}", bullet])
        return "\n".join(lines[:before] + [f"### {heading}", bullet, ""] + lines[before:])
    end = start + 1
    while end < len(lines) and not lines[end].strip().startswith("#"):
        end += 1
    insert_at = end
    while insert_at > start + 1 and not lines[insert_at - 1].strip():
        insert_at -= 1  # keep the blank line before the next heading below our bullet
    return "\n".join(lines[:insert_at] + [bullet] + lines[insert_at:])


def add_profile_line(content: str, heading: str, line: str) -> str:
    """Add "- line" under `heading`: a general heading ("铁律") goes in the general part,
    a scoped one ("项目：chembook", "设备：…") in its own section at the end."""
    bullet = f"- {line}"
    if any(existing.strip() == bullet for existing in (content or "").split("\n")):
        return (content or "").strip()
    scopes = split_profile_scopes(content or "")
    scoped = re.match(r"^(项目|设备)\s*[:：]\s*(.+)$", heading)
    if scoped:
        bucket = scopes.projects if scoped.group(1) == "项目" else scopes.devices
        name = scoped.group(2).strip()
        key = next((k for k in bucket if norm_scope_name(k) == norm_scope_name(name)), name)
        bucket.setdefault(key, []).append(bullet)
    else:
        scopes.general = _add_general_line(scopes.general, heading, bullet)
    return join_profile_scopes(scopes)


def over_limit(content: str) -> bool:
    scopes = split_profile_scopes(content)
    if len(scopes.general) > PROFILE_MAX_CHARS:
        return True
    return any(len("\n".join(lines)) > SCOPED_MAX_CHARS
               for bucket in (scopes.projects, scopes.devices) for lines in bucket.values())


def should_auto_accept(topic: CorrectionTopic, text: str) -> bool:
    """Determine if a correction topic is high-confidence enough to auto-accept without waiting for manual confirmation.
    
    Conditions:
    1. Repeated pushback (times >= 2) on the same topic, OR
    2. Strong imperative/prohibitive rules (e.g. 必须, 严禁, 始终, 统一用, 不要用, 禁止, 先给结论, always, never)
       under rule, communication, workflow, or tech category with a clear statement.
    """
    stmt = (topic.statement or "").strip()
    if not stmt or len(stmt) < 4:
        return False
    if topic.times >= 2:
        return True
    strong_signals = (
        "必须", "严禁", "始终", "统一用", "不要用", "不得", "别再", "禁止", "一律",
        "先给结论", "直接给结论", "不用角标", "用中文", "中文回复", "不能", "铁律",
        "always", "never", "must", "do not",
    )
    combined = f"{stmt} {text}".lower()
    return any(sig in combined for sig in strong_signals) and topic.category in (
        "rule", "communication", "workflow", "tech"
    )


def scope_for(kind: str, said: Said) -> str:
    """"project:chembook" / "device:DESKTOP-KR9IPP4" / "global", from where it was said."""
    if kind == "project" and said.project:
        return f"project:{said.project}"
    if kind == "device" and said.device:
        return f"device:{said.device}"
    return "global"


def topic_heading(topic: CorrectionTopic) -> str:
    """Where an accepted topic goes in the profile."""
    kind, _, name = (topic.scope or "global").partition(":")
    if kind == "project" and name:
        return f"项目：{name}"
    if kind == "device" and name:
        return f"设备：{name}"
    return CATEGORY_HEADINGS.get(topic.category, "铁律")


# ---- scanning ----

async def fetch_new_corrections(
    db: AsyncSession, user: User, after_id: int | None, now: datetime,
) -> tuple[list[Said], int | None]:
    """User messages synced after `after_id` that read like pushback, oldest first,
    and the highest message id looked at (the next cursor)."""
    from ..db.models import AskConversation

    machines = select(Machine.id).where(Machine.user_id == user.id)
    query = (
        select(ConversationMessage.id, ConversationMessage.content, ConversationMessage.timestamp,
               Project.title, Machine.name)
        .join(Document, Document.id == ConversationMessage.document_id)
        .outerjoin(Project, Project.id == Document.project_id)
        .outerjoin(Machine, Machine.id == Document.machine_id)
        .where(
            Document.machine_id.in_(machines),
            ConversationMessage.role == "user",
            ConversationMessage.timestamp.is_not(None),
            ConversationMessage.timestamp >= now - BACKFILL,
            ~ConversationMessage.content.startswith("[Result]"),
            ~Document.relative_path.op("~")(SUBAGENT_PATH_REGEX),
            ~func.coalesce(Document.metadata_.has_key("parent_session_id"), False),
        )
        .order_by(ConversationMessage.id)
        .limit(SCAN_LIMIT)
    )
    if after_id is not None:
        query = query.where(ConversationMessage.id > after_id)
    rows = (await db.execute(query)).all()
    found: list[Said] = []
    seen_texts: set[str] = set()
    for message_id, content, said_at, project, machine in rows:
        text = clean_user_voice(content)
        if text and looks_like_pushback(text):
            seen_texts.add(text)
            found.append(Said(message_id, text, said_at, project, clean_device_name(machine) if machine else None))

    # Also scan recent AskConversation turns (last 24h) so client chats in any mode
    # or before local daemon JSONL sync are immediately captured without lag.
    ask_convs = (await db.execute(
        select(AskConversation)
        .where(
            AskConversation.user_id == user.id,
            AskConversation.updated_at >= now - timedelta(hours=24),
        )
        .order_by(AskConversation.updated_at.desc())
        .limit(30)
    )).scalars().all()
    recent_quotes = set((await db.execute(
        select(CorrectionEvent.quote).where(
            CorrectionEvent.user_id == user.id,
            CorrectionEvent.said_at >= now - timedelta(hours=24),
        )
    )).scalars().all())
    for conv in ask_convs:
        cfg = conv.config or {}
        proj_name = cfg.get("project_id") or None
        for idx, turn in enumerate(conv.turns or []):
            if not isinstance(turn, dict) or turn.get("role") != "user":
                continue
            text = clean_user_voice(str(turn.get("content") or ""))
            if not text or text in seen_texts or text in recent_quotes or not looks_like_pushback(text):
                continue
            ts_raw = turn.get("created_at")
            try:
                said_at = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00")) if ts_raw else (conv.updated_at or now)
            except ValueError:
                said_at = conv.updated_at or now
            if said_at < now - timedelta(hours=24):
                continue
            seen_texts.add(text)
            found.append(Said(-1 - idx, text, said_at, proj_name, None))

    found.sort(key=lambda s: s.said_at)
    return found, (rows[-1][0] if rows else after_id)


_CLASSIFY_PROMPT = """下面是用户在各个 AI 工具里亲手打的话，都可能是在纠正 AI。请判断哪些是能长期指导 AI 以后怎么做的"规矩"。

## 已知的话题（用户以前说过、或已经记住的）
{known}

## 用户的原话
{messages}

## 要求
- 只挑长期有效的：沟通方式、必须遵守或禁止的做法、工作习惯、技术偏好。一次性的任务指令（"帮我改这个 bug"、"不要改那个文件"这类只针对当前任务的）不要。
- statement：写成直接对 AI 的一句祈使句，如"始终用中文回复"、"git commit 不要加 Co-Authored-By"。不超过 60 字。
- category：communication（沟通方式）| rule（必须/禁止）| workflow（工作方式）| tech（技术偏好）。
- scope：global（到哪都适用，默认）| project（只在原话所在的那个项目里成立，比如涉及它的业务、数据格式、专有工具）| device（只在那台机器上成立，比如本机磁盘、路径）。原话前的 [项目 @ 设备] 标注说明它是在哪说的。沟通方式、工作习惯这类，即使只在一个项目里说过，也是 global。
- i：表达这条规矩的所有原话编号。同一件事在下面说了好几次，就合成一条，把编号都列上。
- match：如果和某个已知话题说的是同一件事，填它的编号（如 "t3"、"m12"）；否则填 null。宁可匹配已知话题，也不要把同一件事拆成两个。
- 抱怨 AI 又违反了某个已知话题的话也要输出、填上 match，哪怕它本身不像一条规矩。例如已知话题是"始终用中文回复"，原话"怎么又变成英文了"就匹配它。这类重复最重要，不要漏。
- 不是规矩的原话直接略过，不用输出。

只输出 JSON：{{"items": [{{"i": [1, 4], "statement": "...", "category": "rule", "scope": "global", "match": null}}]}}"""


async def classify(batch: list[Said], known: list[tuple[str, str]]) -> list[dict[str, Any]]:
    known_text = "\n".join(f"{ref}: {text[:100]}" for ref, text in known) or "（无）"
    messages = "\n".join(f"[{i}] " + (f"[{s.where}] " if s.where else "") + s.text for i, s in enumerate(batch, 1))
    raw = await call_plain_chat(
        messages=[
            {"role": "system", "content": "You extract durable user preferences. Respond only with valid JSON."},
            {"role": "user", "content": _CLASSIFY_PROMPT.format(known=known_text, messages=messages)},
        ],
        max_tokens=2000,
    )
    if raw is None:
        raise RuntimeError("correction classification got no answer from any AI provider")
    items = _safe_json_loads(raw).get("items") or []
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        raw_i = item.get("i")
        indices = set()
        for v in raw_i if isinstance(raw_i, list) else [raw_i]:
            try:
                indices.add(int(v))
            except (TypeError, ValueError):
                continue
        indices = sorted(i for i in indices if 1 <= i <= len(batch))
        statement = clean_statement(str(item.get("statement") or ""))
        if not indices or not statement:
            continue
        category = str(item.get("category") or "rule")
        scope = str(item.get("scope") or "global")
        out.append({
            "indices": indices,
            "statement": statement,
            "category": category if category in CATEGORY_HEADINGS else "rule",
            "scope": scope if scope in ("global", "project", "device") else "global",
            "match": str(item["match"]) if item.get("match") else None,
        })
    return out


async def learn_from_corrections(db: AsyncSession, user: User) -> dict[str, Any]:
    """Process corrections synced since the last run. Returns what changed."""
    now = datetime.now(timezone.utc)
    cursor_key = f"corrections_cursor:{user.id}"
    cursor = await ai_health.get_json(cursor_key)
    said, next_cursor = await fetch_new_corrections(db, user, cursor, now)

    topics = (await db.execute(
        select(CorrectionTopic).where(CorrectionTopic.user_id == user.id)
        .order_by(CorrectionTopic.last_at.desc().nulls_last()).limit(KNOWN_LIMIT)
    )).scalars().all()
    linked = {t.memory_id for t in topics if t.memory_id}
    memories = [m for m in (await db.execute(
        select(UserMemory).where(
            UserMemory.user_id == user.id,
            UserMemory.category.in_(("preference", "rule", "rules")),
            UserMemory.is_folder.is_(False),
            UserMemory.status == "active",
        ).order_by(UserMemory.updated_at.desc()).limit(KNOWN_LIMIT)
    )).scalars().all() if m.id not in linked]

    refs: dict[str, CorrectionTopic | UserMemory] = {}
    for n, t in enumerate(topics, 1):
        refs[f"t{n}"] = t
    for n, m in enumerate(memories, 1):
        refs[f"m{n}"] = m

    # Read everything we need, then let go of the connection while the model thinks.
    await db.commit()

    events = 0
    new_topics: list[CorrectionTopic] = []
    auto_accepted: list[CorrectionTopic] = []
    for start in range(0, len(said), LLM_BATCH):
        batch = said[start:start + LLM_BATCH]
        known = [(ref, obj.statement if isinstance(obj, CorrectionTopic) else obj.content) for ref, obj in refs.items()]
        items = await classify(batch, known)
        # Every (message, topic) pair oldest first, so the first time a topic is
        # said counts as new and the rest as repeats.
        occurrences = sorted(
            ((batch[i - 1], n) for n, item in enumerate(items) for i in item["indices"]),
            key=lambda pair: pair[0].said_at,
        )
        resolved: dict[int, CorrectionTopic] = {}
        for s, n in occurrences:
            item = items[n]
            fp = fingerprint(s)
            if (await db.execute(select(CorrectionEvent.id).where(
                CorrectionEvent.user_id == user.id,
                (CorrectionEvent.fingerprint == fp) | (
                    (CorrectionEvent.quote == s.text) &
                    (CorrectionEvent.said_at >= s.said_at - timedelta(minutes=30)) &
                    (CorrectionEvent.said_at <= s.said_at + timedelta(minutes=30))
                ),
            ))).first():
                continue
            target = resolved.get(n) or refs.get(item["match"] or "")
            if isinstance(target, UserMemory):
                # Something already remembered; track it as an accepted topic from now on.
                topic = CorrectionTopic(
                    user_id=user.id, statement=clean_statement(target.content), category=item["category"],
                    status="accepted", accepted_at=target.created_at, memory_id=target.id, times=0,
                )
                db.add(topic)
                await db.flush()
                ref = next(r for r, o in refs.items() if o is target)
                refs[ref] = topic
                resolved[n] = topic
                # Backfilled corrections can predate the memory; only later ones are repeats.
                learned = learned_by(topic, s.said_at)
                repeat = learned
            elif isinstance(target, CorrectionTopic):
                topic = target
                repeat, learned = True, learned_by(topic, s.said_at)
            else:
                topic = CorrectionTopic(
                    user_id=user.id, statement=item["statement"], category=item["category"],
                    status="pending", times=0, scope=scope_for(item.get("scope", "global"), s),
                )
                db.add(topic)
                await db.flush()
                refs[f"t{len(refs) + 1}"] = topic
                resolved[n] = topic
                new_topics.append(topic)
                repeat, learned = False, False
            topic.times += 1
            topic.first_at = min(filter(None, [topic.first_at, s.said_at]))
            topic.last_at = max(filter(None, [topic.last_at, s.said_at]))

            # Fast-path self-evolution: auto-accept high-confidence or repeated rules
            if topic.status == "pending" and should_auto_accept(topic, s.text):
                try:
                    await accept_topic(db, user, topic)
                    auto_accepted.append(topic)
                    logger.info("Fast-path self-evolution: auto-accepted rule for user %s: %s", user.id, topic.statement)
                except ProfileFull:
                    logger.warning("Profile is full; leaving topic %s as pending", topic.id)
                except Exception as e:
                    logger.warning("Failed to auto-accept topic %s: %s", topic.id, e)

            db.add(CorrectionEvent(
                user_id=user.id, topic_id=topic.id, quote=s.text, said_at=s.said_at,
                repeat=repeat, already_learned=learned, fingerprint=fp,
            ))
            events += 1
        await db.commit()

    await ai_health.put_json(cursor_key, next_cursor, ttl_seconds=90 * 24 * 3600)
    return {
        "scanned": len(said),
        "events": events,
        "new_topics": [t.statement for t in new_topics if t.status == "pending"],
        "auto_accepted": [t.statement for t in auto_accepted],
        "backfill": cursor is None,
    }


# ---- accepting ----

async def _append_published(db: AsyncSession, user: User, content: str) -> UserProfile:
    """A new published version with `content`, leaving any pending draft alone."""
    last = (await db.execute(
        select(func.max(UserProfile.version)).where(UserProfile.user_id == user.id)
    )).scalar() or 0
    profile = UserProfile(
        user_id=user.id, status="published", version=last + 1, content=content,
        stats={"source": "correction"}, published_at=datetime.now(timezone.utc),
    )
    db.add(profile)
    return profile


async def accept_topic(
    db: AsyncSession, user: User, topic: CorrectionTopic, statement: str | None = None,
    general: bool = False,
) -> CorrectionTopic:
    """Remember the topic and add it to the published profile (and the draft, if any).
    general=True widens a project / device topic to apply everywhere."""
    line = clean_statement(statement or topic.statement)
    if not line:
        raise ValueError("statement is empty")
    if general:
        topic.scope = "global"
    heading = topic_heading(topic)

    published = await get_published_profile(db, user)
    base = (published.content if published else "").strip()
    updated = add_profile_line(base, heading, line)
    if over_limit(updated):
        raise ProfileFull()
    if updated != base:
        await _append_published(db, user, sanitize_profile_content(updated))
    draft = await get_draft_profile(db, user)
    if draft is not None:
        draft.content = add_profile_line(draft.content, heading, line)

    memory = await db.get(UserMemory, topic.memory_id) if topic.memory_id else None
    if memory is None:
        key = f"correction_{topic.id.hex[:8]}"
        category = "rule" if topic.category == "rule" else "preference"
        memory = UserMemory(
            user_id=user.id, category=category, key=key, content=line, confidence=1.0,
            source="manual", tree_path=f"/{category}/{key}",
        )
        db.add(memory)
        await db.flush()
    else:
        memory.content = line

    topic.statement = line
    topic.status = "accepted"
    topic.accepted_at = datetime.now(timezone.utc)
    topic.memory_id = memory.id
    await db.commit()
    await db.refresh(topic)
    return topic


# ---- measuring ----

async def correction_stats(db: AsyncSession, user: User, days: int = 30, weeks: int = 5) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=max(days, weeks * 7))
    rows = (await db.execute(
        select(CorrectionEvent.said_at, CorrectionEvent.repeat, CorrectionEvent.already_learned, CorrectionEvent.topic_id)
        .where(CorrectionEvent.user_id == user.id, CorrectionEvent.said_at >= since)
    )).all()
    window = [r for r in rows if r[0] >= now - timedelta(days=days)]
    last_week = [r for r in rows if r[0] >= now - timedelta(days=7)]

    weekly = []
    for w in range(weeks - 1, -1, -1):
        end = now - timedelta(days=7 * w)
        chunk = [r for r in rows if end - timedelta(days=7) <= r[0] < end]
        weekly.append({
            "end": end.isoformat(),
            "total": len(chunk),
            "repeat": sum(1 for r in chunk if r[1]),
            "learned_repeat": sum(1 for r in chunk if r[2]),
        })

    counts: dict[uuid.UUID, int] = {}
    learned_counts: dict[uuid.UUID, int] = {}
    for r in window:
        counts[r[3]] = counts.get(r[3], 0) + 1
        if r[2]:
            learned_counts[r[3]] = learned_counts.get(r[3], 0) + 1
    top_ids = sorted(counts, key=lambda t: counts[t], reverse=True)[:8]
    topics = {t.id: t for t in (await db.execute(
        select(CorrectionTopic).where(CorrectionTopic.id.in_(top_ids))
    )).scalars().all()} if top_ids else {}
    pending = (await db.execute(
        select(func.count()).select_from(CorrectionTopic)
        .where(CorrectionTopic.user_id == user.id, CorrectionTopic.status == "pending")
    )).scalar() or 0

    return {
        "window_days": days,
        "total": len(window),
        "repeat": sum(1 for r in window if r[1]),
        "learned_repeat": sum(1 for r in window if r[2]),
        "learned_repeat_7d": sum(1 for r in last_week if r[2]),
        "pending": pending,
        "weekly": weekly,
        "top": [
            {
                "id": str(t),
                "statement": topics[t].statement,
                "status": topics[t].status,
                "count": counts[t],
                "learned_repeat": learned_counts.get(t, 0),
                "last_at": topics[t].last_at.isoformat() if topics[t].last_at else None,
            }
            for t in top_ids if t in topics
        ],
    }


def topic_out(topic: CorrectionTopic, quotes: list[CorrectionEvent] | None = None) -> dict[str, Any]:
    return {
        "id": str(topic.id),
        "statement": topic.statement,
        "category": topic.category,
        "heading": topic_heading(topic),
        "scope": topic.scope or "global",
        "status": topic.status,
        "times": topic.times,
        "first_at": topic.first_at.isoformat() if topic.first_at else None,
        "last_at": topic.last_at.isoformat() if topic.last_at else None,
        "quotes": [{"text": e.quote, "said_at": e.said_at.isoformat()} for e in quotes or []],
    }


def summarize_new_topics(statements: list[str]) -> str:
    head = "；".join(statements[:2])
    return head + (f" 等 {len(statements)} 条" if len(statements) > 2 else "")
