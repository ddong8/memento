"""Todos: things the user said they'd do later, and whether they got done.

Every few minutes the user's newly synced messages are screened for "later"
talk ("明天把…", "记一下…", "这个先放着"); the background model decides which
are real todos (not an instruction the AI should carry out right now) and
which messages close an open one ("那个搞定了", "不用做了"). Session reviews
add todos a session left unfinished and close ones a session finished.
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ConversationMessage, Document, Machine, Project, Todo, User
from . import ai_health
from .ai_provider import call_plain_chat
from .dreaming_service import SUBAGENT_PATH_REGEX, _safe_json_loads, clean_user_voice

logger = logging.getLogger("server.todos")

# China has no DST; a fixed offset avoids depending on tzdata in the slim image.
LOCAL_TZ = timezone(timedelta(hours=8), "Asia/Shanghai")
BACKFILL = timedelta(days=3)  # first run: older "later" talk is stale by now
SCAN_LIMIT = 1000
LLM_BATCH = 25
OPEN_LIMIT = 60
TITLE_MAX = 200

_LATER_RE = re.compile(
    r"待办|todo|记一下|记下来|记得|别忘|提醒我|回头|稍后|晚点|晚些|明天|后天|下周|下个月|"
    r"周[一二三四五六日天]|星期[一二三四五六日天]|改天|以后再|之后再|有空|下次|先放|先不|暂时不|"
    r"还要|还得|还需要|还没做|留着|挂起|backlog|\blater\b|tomorrow|next week|remind me",
    re.IGNORECASE,
)
_CLOSE_RE = re.compile(r"搞定|完成了|做完|弄好了|做好了|不用做|不用了|取消|算了|不做了|已经好了|\bdone\b", re.IGNORECASE)


def looks_like_later(text: str) -> bool:
    return bool(_LATER_RE.search(text))


def looks_like_close(text: str) -> bool:
    return bool(_CLOSE_RE.search(text))


def fingerprint(title: str) -> str:
    norm = re.sub(r"[\s\W_]+", "", (title or "").lower())
    return hashlib.sha1(norm.encode()).hexdigest()


def clean_title(title: str | None) -> str:
    return re.sub(r"\s+", " ", title or "").strip()[:TITLE_MAX]


def parse_due(value: Any) -> datetime | None:
    """"YYYY-MM-DD" → the start of that day, local time. Anything else → None."""
    if not value:
        return None
    try:
        d = date.fromisoformat(str(value)[:10])
    except ValueError:
        return None
    return datetime.combine(d, time.min, tzinfo=LOCAL_TZ)


def local_day_bounds(now: datetime) -> tuple[datetime, datetime]:
    local = now.astimezone(LOCAL_TZ)
    start = datetime.combine(local.date(), time.min, tzinfo=LOCAL_TZ)
    return start, start + timedelta(days=1)


def todo_out(todo: Todo) -> dict[str, Any]:
    return {
        "id": str(todo.id),
        "title": todo.title,
        "detail": todo.detail,
        "project": todo.project,
        "status": todo.status,
        "due": todo.due_at.astimezone(LOCAL_TZ).date().isoformat() if todo.due_at else None,
        "source": todo.source,
        "evidence": todo.evidence,
        "close_evidence": todo.close_evidence,
        "source_doc_id": str(todo.source_doc_id) if todo.source_doc_id else None,
        "created_at": todo.created_at.isoformat() if todo.created_at else None,
        "closed_at": todo.closed_at.isoformat() if todo.closed_at else None,
    }


async def open_todos(db: AsyncSession, user: User, limit: int = OPEN_LIMIT) -> list[Todo]:
    return list((await db.execute(
        select(Todo).where(Todo.user_id == user.id, Todo.status == "open")
        .order_by(Todo.due_at.asc().nulls_last(), Todo.created_at.desc())
        .limit(limit)
    )).scalars().all())


async def add_todo(
    db: AsyncSession,
    user: User,
    title: str,
    *,
    detail: str | None = None,
    project: str | None = None,
    due_at: datetime | None = None,
    source: str = "manual",
    evidence: str | None = None,
    source_doc_id: Any = None,
) -> tuple[Todo, bool]:
    """Add a todo, or return the open one with the same title. (todo, created). Does not commit."""
    title = clean_title(title)
    if not title:
        raise ValueError("title is empty")
    fp = fingerprint(title)
    existing = (await db.execute(
        select(Todo).where(Todo.user_id == user.id, Todo.status == "open", Todo.fingerprint == fp).limit(1)
    )).scalar_one_or_none()
    if existing is not None:
        existing.detail = existing.detail or detail
        existing.due_at = existing.due_at or due_at
        existing.project = existing.project or project
        return existing, False
    todo = Todo(
        user_id=user.id, title=title, detail=(detail or None), project=(project or None)[:120] if project else None,
        due_at=due_at, source=source, evidence=(evidence or None), source_doc_id=source_doc_id,
        fingerprint=fp, status="open",
    )
    db.add(todo)
    await db.flush()
    return todo, True


def close_todo(todo: Todo, status: str, evidence: str | None = None) -> None:
    if status not in ("done", "dropped", "open"):
        raise ValueError("status must be open, done or dropped")
    todo.status = status
    if status == "open":
        todo.closed_at, todo.close_evidence = None, None
    else:
        todo.closed_at = datetime.now(timezone.utc)
        todo.close_evidence = (evidence or None)


# ---- learning from the user's own words ----

@dataclass
class Said:
    message_id: int
    text: str
    said_at: datetime
    doc_id: Any
    project: str | None


_TODO_PROMPT = """下面是用户在各个 AI 工具里亲手打的话，每条前面是说话时间（北京时间）和所在项目。请找出其中的"待办"——用户打算以后再做、要记下来的事——以及哪些话说明某条已知待办已经做完或不做了。

## 已知的未完成待办
{open}

## 用户的原话
{messages}

## 要求
- 待办只算这几种：用户明确把"做这件事"推迟了（"明天再弄""先放着回头处理""下次再说""有空再搞"）；让 AI"记一下 / 记下来 / 提醒我"的事；用户给自己安排、不需要 AI 当场做的事（"下周三要跟张三对一下接口"）。
- 只要这句话是在让 AI 现在就去做某件事，就不是待办——哪怕带着"暂时不要部署""先计划一下怎么做""我还要再加一张表""下周分享要用，帮我写资料"这类限定。这是最常见的误判，务必排除。
- 宁缺毋滥：拿不准就不算。
- title：一句动宾短语，不超过 40 字，说清楚做什么（如"给 memento 的导出接口加分页"）。
- due：用户说了时间就换算成日期 YYYY-MM-DD（以说话那天为准，"明天"就是说话日期加一天）；没说就填 null。
- project：待办所属项目，不确定就用那句话所在的项目。
- 同一件事说了好几次合成一条，i 里列出所有编号。和已知待办是同一件事的不要重复新建。
- close：原话说明某条已知待办已经做完（done）或不做了（dropped），填它的编号（如 "d2"）和依据的原话编号。

只输出 JSON：{{"new": [{{"i": [1], "title": "...", "detail": "补充说明或 null", "due": null, "project": "..."}}], "close": [{{"d": "d2", "status": "done", "i": [3]}}]}}"""


async def fetch_new_messages(
    db: AsyncSession, user: User, after_id: int | None, now: datetime, has_open: bool,
) -> tuple[list[Said], int | None]:
    from ..db.models import AskConversation

    machines = select(Machine.id).where(Machine.user_id == user.id)
    query = (
        select(
            ConversationMessage.id, ConversationMessage.content, ConversationMessage.timestamp,
            Document.id, Project.title,
        )
        .join(Document, Document.id == ConversationMessage.document_id)
        .outerjoin(Project, Project.id == Document.project_id)
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
    for message_id, content, said_at, doc_id, project in rows:
        text = clean_user_voice(content)
        if text and (looks_like_later(text) or (has_open and looks_like_close(text))):
            seen_texts.add(text)
            found.append(Said(message_id, text, said_at, doc_id, project))

    # Also scan recent AskConversation user turns (last 24h) not yet in ConversationMessage
    ask_cursor_key = f"todos_ask_cursor:{user.id}"
    ask_cursor_iso = await ai_health.get_json(ask_cursor_key)
    ask_since = datetime.fromisoformat(ask_cursor_iso) if isinstance(ask_cursor_iso, str) else (now - timedelta(hours=24))
    ask_convs = (await db.execute(
        select(AskConversation)
        .where(
            AskConversation.user_id == user.id,
            AskConversation.updated_at > ask_since,
        )
        .order_by(AskConversation.updated_at.asc())
        .limit(30)
    )).scalars().all()
    latest_ask_ts = ask_since
    for conv in ask_convs:
        if conv.updated_at and conv.updated_at > latest_ask_ts:
            latest_ask_ts = conv.updated_at
        cfg = conv.config or {}
        proj_name = cfg.get("project_id") or None
        for idx, turn in enumerate(conv.turns or []):
            if not isinstance(turn, dict) or turn.get("role") != "user":
                continue
            ts_raw = turn.get("created_at")
            try:
                said_at = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00")) if ts_raw else (conv.updated_at or now)
            except ValueError:
                said_at = conv.updated_at or now
            if said_at <= ask_since:
                continue
            text = clean_user_voice(str(turn.get("content") or ""))
            if text and text not in seen_texts and (looks_like_later(text) or (has_open and looks_like_close(text))):
                seen_texts.add(text)
                found.append(Said(-1 - idx, text, said_at, None, proj_name))
    if latest_ask_ts > ask_since:
        await ai_health.put_json(ask_cursor_key, latest_ask_ts.isoformat(), ttl_seconds=90 * 24 * 3600)

    found.sort(key=lambda s: s.said_at)
    return found, (rows[-1][0] if rows else after_id)


def _indices(raw: Any, size: int) -> list[int]:
    out = set()
    for v in raw if isinstance(raw, list) else [raw]:
        try:
            i = int(v)
        except (TypeError, ValueError):
            continue
        if 1 <= i <= size:
            out.add(i)
    return sorted(out)


def _render_said(s: Said, n: int) -> str:
    local = s.said_at.astimezone(LOCAL_TZ)
    weekday = "一二三四五六日"[local.weekday()]
    return f"[{n}] ({local:%Y-%m-%d} 周{weekday} {local:%H:%M} · {s.project or '未知项目'}) {s.text}"


async def classify(batch: list[Said], opened: list[Todo]) -> dict[str, Any]:
    open_text = "\n".join(f"d{n}: {t.title}" + (f"（{t.project}）" if t.project else "") for n, t in enumerate(opened, 1)) or "（无）"
    messages = "\n".join(_render_said(s, i) for i, s in enumerate(batch, 1))
    raw = await call_plain_chat(
        messages=[
            {"role": "system", "content": "You extract a user's todos from what they typed. Respond only with valid JSON."},
            {"role": "user", "content": _TODO_PROMPT.format(open=open_text, messages=messages)},
        ],
        max_tokens=1500,
    )
    if raw is None:
        raise RuntimeError("todo classification got no answer from any AI provider")
    return _safe_json_loads(raw)


async def learn_todos(db: AsyncSession, user: User) -> dict[str, Any]:
    """Process messages synced since the last run. Returns what changed."""
    now = datetime.now(timezone.utc)
    cursor_key = f"todos_cursor:{user.id}"
    cursor = await ai_health.get_json(cursor_key)
    opened = await open_todos(db, user)
    said, next_cursor = await fetch_new_messages(db, user, cursor, now, bool(opened))
    await db.commit()

    created: list[Todo] = []
    closed = 0
    for start in range(0, len(said), LLM_BATCH):
        batch = said[start:start + LLM_BATCH]
        result = await classify(batch, opened)
        for item in result.get("new") or []:
            if not isinstance(item, dict):
                continue
            idx = _indices(item.get("i"), len(batch))
            title = clean_title(item.get("title"))
            if not idx or not title:
                continue
            first = batch[idx[0] - 1]
            todo, is_new = await add_todo(
                db, user, title,
                detail=str(item.get("detail") or "").strip() or None,
                project=str(item.get("project") or first.project or "").strip() or None,
                due_at=parse_due(item.get("due")),
                source="voice",
                evidence=" / ".join(batch[i - 1].text for i in idx)[:1000],
                source_doc_id=first.doc_id,
            )
            if is_new:
                created.append(todo)
                opened.append(todo)
        refs = {f"d{n}": t for n, t in enumerate(opened, 1)}
        for item in result.get("close") or []:
            if not isinstance(item, dict):
                continue
            todo = refs.get(str(item.get("d") or ""))
            status = str(item.get("status") or "done")
            if todo is None or todo.status != "open" or status not in ("done", "dropped"):
                continue
            idx = _indices(item.get("i"), len(batch))
            close_todo(todo, status, " / ".join(batch[i - 1].text for i in idx)[:1000] or None)
            closed += 1
        await db.commit()
        opened = [t for t in opened if t.status == "open"]

    await ai_health.put_json(cursor_key, next_cursor, ttl_seconds=90 * 24 * 3600)
    return {"scanned": len(said), "created": [t.title for t in created], "closed": closed}


# ---- reminders & numbers ----

async def due_now(db: AsyncSession, user: User, now: datetime | None = None) -> dict[str, list[Todo]]:
    """Open todos due today and overdue ones."""
    now = now or datetime.now(timezone.utc)
    today, tomorrow = local_day_bounds(now)
    rows = (await db.execute(
        select(Todo).where(Todo.user_id == user.id, Todo.status == "open", Todo.due_at.is_not(None), Todo.due_at < tomorrow)
        .order_by(Todo.due_at)
    )).scalars().all()
    return {"overdue": [t for t in rows if t.due_at < today], "today": [t for t in rows if t.due_at >= today]}


def reminder_text(due: dict[str, list[Todo]]) -> tuple[str, str] | None:
    items = due["overdue"] + due["today"]
    if not items:
        return None
    parts = []
    if due["today"]:
        parts.append(f"今天到期 {len(due['today'])} 条")
    if due["overdue"]:
        parts.append(f"逾期 {len(due['overdue'])} 条")
    body = "；".join(f"{t.title}" for t in items[:5]) + ("…" if len(items) > 5 else "")
    return "Memento 待办：" + "，".join(parts), body


async def todo_counts(db: AsyncSession, user: User, days: int = 7) -> dict[str, int]:
    now = datetime.now(timezone.utc)
    today, _ = local_day_bounds(now)
    since = now - timedelta(days=days)
    open_n = (await db.execute(
        select(func.count()).select_from(Todo).where(Todo.user_id == user.id, Todo.status == "open")
    )).scalar() or 0
    overdue = (await db.execute(
        select(func.count()).select_from(Todo).where(
            Todo.user_id == user.id, Todo.status == "open", Todo.due_at.is_not(None), Todo.due_at < today,
        )
    )).scalar() or 0
    done = (await db.execute(
        select(func.count()).select_from(Todo).where(
            Todo.user_id == user.id, Todo.status == "done", Todo.closed_at >= since,
        )
    )).scalar() or 0
    added = (await db.execute(
        select(func.count()).select_from(Todo).where(Todo.user_id == user.id, Todo.created_at >= since)
    )).scalar() or 0
    return {"open": open_n, "overdue": overdue, "done_recent": done, "added_recent": added}
