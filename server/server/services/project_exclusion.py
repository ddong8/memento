"""Projects the user doesn't want collected (test projects, throwaway experiments).

Every project on every device was collected, and what came of it stayed: conversations, the long
term memories and pitfalls dreaming drew from them, the project's rules in the published profile,
its skills, learned corrections, todos. The user (2026-11-17): "有些项目是用来测试的，不想它被抓取……
对应的记忆，画像等也要删除".

A project is named as the project list names it, compared like profile scopes compare names
(norm_scope_name: spaces, "-" and "_" don't count, case doesn't). "*" matches anything, so
"test-*" takes every project whose name starts with test. It holds for the user's projects in every
tool on every device.

Excluding one:
1) Collection stops at once for every collector version: ingest drops what it would file under the
   project (ingest_service checks after it works out the project) and marks the file's sync_state
   with the project's key, so the collector's next slices of the log are taken and dropped instead
   of being asked for from the start again (claim_slice would want the whole log back otherwise).
2) What was collected goes: the documents and everything hanging off them (messages, the search
   index, vectors, versions, graph observations; graph entities left with nothing) are deleted;
   the memories and pitfalls about the project, its skills, corrections scoped to it and the todos
   it produced are taken out of use, and its "## 项目：" section leaves the published profile and the
   draft. Those are kept and remembered in the entry, so 恢复采集 puts them back.
   Conversations are on the devices still: after 恢复采集 the next change to a log brings the whole
   log back (its sync_state is dropped, so the collector is asked for it from the start).
"""

from __future__ import annotations

import fnmatch
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete, false, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    AccessLog,
    ConversationMessage,
    CorrectionTopic,
    Document,
    DocumentEmbedding,
    DocumentVersion,
    KnowledgeEntity,
    KnowledgeObservation,
    KnowledgeRelation,
    Machine,
    Project,
    Skill,
    SyncState,
    Todo,
    User,
    UserMemory,
    UserProfile,
)
from .profile_service import join_profile_scopes, norm_scope_name, split_profile_scopes

logger = logging.getLogger(__name__)

EXCLUDED = "excluded"  # UserMemory.status of a memory about an excluded project
MAX_EXCLUSIONS = 200
BATCH = 50  # documents deleted per transaction: a big conversation has hundreds of thousands of messages


class ProjectExcluded(Exception):
    """What was sent belongs to a project the user doesn't collect: taken and dropped."""

    def __init__(self, key: str):
        super().__init__(f"project excluded: {key}")
        self.key = key


def exclusion_key(name: str) -> str:
    """How an excluded name is kept and compared ("*" stays a wildcard)."""
    return norm_scope_name((name or "").strip())[:120]


def matches(key: str, project_name: str | None) -> bool:
    if not key or not project_name:
        return False
    name = norm_scope_name(project_name)
    return fnmatch.fnmatchcase(name, key) if "*" in key else name == key


def match_any(keys: list[str], project_name: str | None) -> str | None:
    return next((k for k in keys if matches(k, project_name)), None)


def entries(user: User) -> list[dict]:
    return list((user.collect_settings or {}).get("excluded_projects") or [])


def keys_of(user: User) -> list[str]:
    return [e["key"] for e in entries(user) if e.get("key")]


async def excluded_keys(db: AsyncSession, user_id: str | uuid.UUID | None) -> list[str]:
    """The user's excluded keys: one primary-key read, cheap enough for every ingest."""
    if not user_id:
        return []
    try:
        uid = uuid.UUID(str(user_id))
    except (ValueError, TypeError):
        return []
    settings = await db.scalar(select(User.collect_settings).where(User.id == uid))
    return [e["key"] for e in ((settings or {}).get("excluded_projects") or []) if e.get("key")]


def _name_sql():
    """Project.title as norm_scope_name spells it."""
    return func.lower(func.regexp_replace(Project.title, r"[\s_-]+", "", "g"))


def _key_condition(key: str):
    if "*" in key:
        like = key.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_").replace("*", "%")
        return _name_sql().like(like, escape="\\")
    return _name_sql() == key


async def _own_machines(db: AsyncSession, user: User) -> list[uuid.UUID]:
    return list((await db.execute(select(Machine.id).where(Machine.user_id == user.id))).scalars())


def _doc_scope(user: User, machine_ids: list[uuid.UUID]):
    """The user's documents: on their devices; with no device recorded (collected before devices
    were) only for the owner of a single-user server."""
    cond = Document.machine_id.in_(machine_ids) if machine_ids else false()
    if user.role == "owner":
        cond = or_(cond, Document.machine_id.is_(None))
    return cond


async def _project_doc_ids(db: AsyncSession, user: User, key: str) -> list[uuid.UUID]:
    machine_ids = await _own_machines(db, user)
    rows = await db.execute(
        select(Document.id)
        .join(Project, Project.id == Document.project_id)
        .where(_key_condition(key), _doc_scope(user, machine_ids))
    )
    return list(rows.scalars())


async def _project_names(db: AsyncSession, user: User, key: str) -> list[str]:
    """The names this key covers among the user's projects, as the project list spells them."""
    machine_ids = await _own_machines(db, user)
    rows = await db.execute(
        select(Project.title)
        .join(Document, Document.project_id == Project.id)
        .where(_key_condition(key), _doc_scope(user, machine_ids))
        .group_by(Project.title)
    )
    names = {t for t in rows.scalars() if t}
    if "*" not in key:
        names.add(key)
    return sorted(names)


# ── what a project left behind besides its documents ─────────────────────────
_PREFIX_RE = re.compile(r"^\s*【([^】]{1,80})】")
_TREE_RE = re.compile(r"^/project/([^/]+)")
_SCOPE_RE = re.compile(r"^项目[：:]\s*(.+)$")


def memory_project(mem_tree_path: str | None, mem_key: str | None, content: str | None, category: str) -> str | None:
    """Which project a memory is about, if it says: /project/<slug>/… paths, proj_<slug>_… keys of
    project memories, and the 【project】 lead of pitfalls and project memories."""
    m = _TREE_RE.match(mem_tree_path or "")
    if m:
        return m.group(1)
    if category == "project" and (mem_key or "").startswith("proj_"):
        return (mem_key or "")[5:].rsplit("_", 1)[0]
    m = _PREFIX_RE.match(content or "")
    return m.group(1) if m else None


async def _memories_for(db: AsyncSession, user: User, key: str) -> list[UserMemory]:
    rows = (await db.execute(
        select(UserMemory).where(
            UserMemory.user_id == user.id,
            UserMemory.status == "active",
            UserMemory.is_folder.is_(False),
        )
    )).scalars()
    return [m for m in rows if matches(key, memory_project(m.tree_path, m.key, m.content, m.category))]


async def _skills_for(db: AsyncSession, user: User, key: str) -> list[Skill]:
    rows = (await db.execute(
        select(Skill).where(Skill.user_id == user.id, Skill.project.isnot(None), Skill.status.in_(("draft", "published")))
    )).scalars()
    return [s for s in rows if matches(key, s.project)]


async def _corrections_for(db: AsyncSession, user: User, key: str) -> list[CorrectionTopic]:
    rows = (await db.execute(
        select(CorrectionTopic).where(
            CorrectionTopic.user_id == user.id,
            CorrectionTopic.status.in_(("pending", "accepted")),
            CorrectionTopic.scope.like("项目%"),
        )
    )).scalars()
    out = []
    for t in rows:
        m = _SCOPE_RE.match(t.scope or "")
        if m and matches(key, m.group(1)):
            out.append(t)
    return out


async def _todos_for(db: AsyncSession, user: User, key: str, doc_ids: list[uuid.UUID]) -> list[Todo]:
    rows = (await db.execute(
        select(Todo).where(Todo.user_id == user.id, Todo.status == "open", Todo.source != "manual")
    )).scalars()
    docs = set(doc_ids)
    return [t for t in rows if matches(key, t.project) or (t.source_doc_id is not None and t.source_doc_id in docs)]


async def _profiles(db: AsyncSession, user: User) -> list[UserProfile]:
    """The published profile now in use and the pending draft."""
    published = (await db.execute(
        select(UserProfile).where(UserProfile.user_id == user.id, UserProfile.status == "published")
        .order_by(UserProfile.version.desc()).limit(1)
    )).scalar_one_or_none()
    draft = (await db.execute(
        select(UserProfile).where(UserProfile.user_id == user.id, UserProfile.status == "draft").limit(1)
    )).scalar_one_or_none()
    return [p for p in (published, draft) if p is not None]


def _profile_sections(content: str, key: str) -> dict[str, list[str]]:
    return {name: lines for name, lines in split_profile_scopes(content).projects.items() if matches(key, name)}


async def preview(db: AsyncSession, user: User, name: str) -> dict:
    """What excluding name would take away, for the confirmation."""
    key = exclusion_key(name)
    if not key or key == "*":
        return {"key": key, "names": [], "documents": 0, "messages": 0, "memories": 0, "skills": 0,
                "corrections": 0, "todos": 0, "profile_rules": 0}
    doc_ids = await _project_doc_ids(db, user, key)
    messages = 0
    for i in range(0, len(doc_ids), 500):
        messages += await db.scalar(
            select(func.count()).select_from(ConversationMessage).where(
                ConversationMessage.document_id.in_(doc_ids[i:i + 500]),
                ConversationMessage.role.in_(("user", "assistant")),
            )
        ) or 0
    profile_rules = 0
    for p in await _profiles(db, user):
        if p.status == "published":
            profile_rules = sum(len(v) for v in _profile_sections(p.content, key).values())
    return {
        "key": key,
        "names": await _project_names(db, user, key),
        "documents": len(doc_ids),
        "messages": messages,
        "memories": len(await _memories_for(db, user, key)),
        "skills": len(await _skills_for(db, user, key)),
        "corrections": len(await _corrections_for(db, user, key)),
        "todos": len(await _todos_for(db, user, key, doc_ids)),
        "profile_rules": profile_rules,
    }


# ── the user's list ──────────────────────────────────────────────────────────
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _locked_user(db: AsyncSession, user_id: uuid.UUID) -> User:
    return (await db.execute(select(User).where(User.id == user_id).with_for_update())).scalar_one()


def _save(user: User, items: list[dict]) -> None:
    user.collect_settings = {**(user.collect_settings or {}), "excluded_projects": items}


async def add(db: AsyncSession, user: User, name: str) -> dict:
    """Put name on the list (state "purging": run purge next). Already there: that entry."""
    key = exclusion_key(name)
    if not key or key.strip("*") == "":
        raise ValueError("项目名不能为空，也不能只写 *")
    u = await _locked_user(db, user.id)
    items = entries(u)
    found = next((e for e in items if e.get("key") == key), None)
    if found:
        return found
    if len(items) >= MAX_EXCLUSIONS:
        raise ValueError(f"最多 {MAX_EXCLUSIONS} 条")
    entry = {"key": key, "name": name.strip()[:120], "added_at": _now(), "state": "purging", "updated_at": _now()}
    _save(u, [*items, entry])
    await db.commit()
    return entry


async def _update_entry(db: AsyncSession, user_id: uuid.UUID, key: str, **changes: Any) -> dict | None:
    u = await _locked_user(db, user_id)
    items = entries(u)
    for e in items:
        if e.get("key") == key:
            e.update(changes, updated_at=_now())
            _save(u, items)
            await db.commit()
            return e
    await db.commit()
    return None


async def purge(db: AsyncSession, user: User, key: str) -> dict:
    """Take away what the project left (see the module docstring). Safe to run again: it picks up
    whatever is still there. Returns the counts."""
    user_id = user.id
    doc_ids = await _project_doc_ids(db, user, key)

    # Not in use any more, kept for 恢复采集
    undo: dict[str, Any] = {"memories": [], "skills": [], "corrections": [], "todos": [], "profile": {}}
    reason = f"项目已设为不采集（{key}）"
    for m in await _memories_for(db, user, key):
        m.status, m.status_reason = EXCLUDED, reason
        undo["memories"].append(str(m.id))
    for s in await _skills_for(db, user, key):
        undo["skills"].append([str(s.id), s.status])
        s.status = "retired"
    for t in await _corrections_for(db, user, key):
        undo["corrections"].append([str(t.id), t.status])
        t.status = "dismissed"
    for t in await _todos_for(db, user, key, doc_ids):
        undo["todos"].append([str(t.id), t.status])
        t.status = "dropped"
    profile_rules = 0
    for p in await _profiles(db, user):
        scopes = split_profile_scopes(p.content)
        gone = {n: lines for n, lines in scopes.projects.items() if matches(key, n)}
        if gone:
            for n in gone:
                scopes.projects.pop(n)
            p.content = join_profile_scopes(scopes)
            undo["profile"][p.status] = gone
            if p.status == "published":
                profile_rules = sum(len(v) for v in gone.values())
    await db.commit()

    # Further slices of these logs are dropped, not asked for from the start
    entity_ids: set[uuid.UUID] = set()
    for i in range(0, len(doc_ids), BATCH):
        batch = doc_ids[i:i + BATCH]
        files = (await db.execute(
            select(Document.machine_id, Document.tool_id, Document.relative_path).where(Document.id.in_(batch))
        )).all()
        for mid, tool, path in files:
            await db.execute(
                update(SyncState)
                .where(SyncState.tool_id == tool, SyncState.relative_path == path,
                       SyncState.machine_id == mid if mid else SyncState.machine_id.is_(None))
                .values(excluded_project=key)
            )
        entity_ids.update(
            e for e in (await db.execute(
                select(KnowledgeObservation.entity_id).where(KnowledgeObservation.source_document_id.in_(batch))
            )).scalars() if e
        )
        await db.execute(update(AccessLog).where(AccessLog.document_id.in_(batch)).values(document_id=None))
        await db.execute(delete(KnowledgeObservation).where(KnowledgeObservation.source_document_id.in_(batch)))
        await db.execute(delete(ConversationMessage).where(ConversationMessage.document_id.in_(batch)))
        await db.execute(delete(DocumentVersion).where(DocumentVersion.document_id.in_(batch)))
        await db.execute(delete(DocumentEmbedding).where(DocumentEmbedding.document_id.in_(batch)))
        await db.execute(delete(Document).where(Document.id.in_(batch)))
        await db.commit()

    # Graph entities those documents alone spoke of
    if entity_ids:
        ids = list(entity_ids)
        still = set((await db.execute(
            select(KnowledgeObservation.entity_id).where(KnowledgeObservation.entity_id.in_(ids))
        )).scalars())
        orphans = [e for e in ids if e not in still]
        if orphans:
            await db.execute(delete(KnowledgeRelation).where(
                KnowledgeRelation.source_id.in_(orphans) | KnowledgeRelation.target_id.in_(orphans)
            ))
            await db.execute(delete(KnowledgeEntity).where(KnowledgeEntity.id.in_(orphans)))
    # Project rows nobody has documents in any more (projects are shared by name across users)
    await db.execute(delete(Project).where(
        _key_condition(key),
        ~Project.id.in_(select(Document.project_id).where(Document.project_id.isnot(None))),
    ))
    await db.commit()

    counts = {
        "documents": len(doc_ids),
        "memories": len(undo["memories"]),
        "skills": len(undo["skills"]),
        "corrections": len(undo["corrections"]),
        "todos": len(undo["todos"]),
        "profile_rules": profile_rules,
    }
    # Undo lists of an earlier run of the same entry are kept: append, don't replace
    u = await _locked_user(db, user_id)
    items = entries(u)
    for e in items:
        if e.get("key") == key:
            prev = e.get("undo") or {}
            merged = {
                k: (prev.get(k) or []) + undo[k] for k in ("memories", "skills", "corrections", "todos")
            }
            merged["profile"] = {**(prev.get("profile") or {}), **undo["profile"]}
            done = e.get("purged") or {}
            e.update(
                state="done", updated_at=_now(), undo=merged,
                purged={k: (done.get(k) or 0) + v for k, v in counts.items()},
            )
    _save(u, items)
    await db.commit()
    await invalidate(user_id)
    return counts


async def restore(db: AsyncSession, user: User, key: str) -> dict | None:
    """Collect the project again and put back what purge took out of use. None: not on the list."""
    u = await _locked_user(db, user.id)
    items = entries(u)
    entry = next((e for e in items if e.get("key") == key), None)
    if entry is None:
        await db.commit()
        return None
    _save(u, [e for e in items if e.get("key") != key])
    undo = entry.get("undo") or {}

    def ids(values):
        return [uuid.UUID(v if isinstance(v, str) else v[0]) for v in values]

    mem_ids = ids(undo.get("memories") or [])
    if mem_ids:
        await db.execute(
            update(UserMemory).where(UserMemory.id.in_(mem_ids), UserMemory.status == EXCLUDED)
            .values(status="active", status_reason=None)
        )
    for model, field_values, now_status in (
        (Skill, undo.get("skills") or [], "retired"),
        (CorrectionTopic, undo.get("corrections") or [], "dismissed"),
        (Todo, undo.get("todos") or [], "dropped"),
    ):
        for item_id, prev in field_values:
            await db.execute(
                update(model).where(model.id == uuid.UUID(item_id), model.status == now_status).values(status=prev)
            )
    for p in await _profiles(db, user):
        gone = (undo.get("profile") or {}).get(p.status) or {}
        if gone:
            scopes = split_profile_scopes(p.content)
            for name, lines in gone.items():
                scopes.projects.setdefault(name, lines)
            p.content = join_profile_scopes(scopes)
    # The logs come back whole on their next change: no sync_state, so the collector is asked from the start
    await db.execute(delete(SyncState).where(SyncState.excluded_project == key, SyncState.machine_id.in_(
        select(Machine.id).where(Machine.user_id == user.id)
    )))
    await db.commit()
    await invalidate(user.id)
    return entry


async def invalidate(user_id: uuid.UUID) -> None:
    try:
        from .cache import cache_delete_prefix

        for prefix in (
            "projects:list:", "projects:list:v2:", "project:conv:", "project:conv:v3:", "project:timeline:",
            "profile_content:", "profile_injection:", "skills_injection:", "memory:resonance:", "learning:check:",
        ):
            await cache_delete_prefix(f"{prefix}{user_id}")
    except Exception as e:  # a stale cache shows the project a few minutes longer, nothing more
        logger.warning("Cache invalidation after project exclusion failed: %s", e)


# ── at ingest ────────────────────────────────────────────────────────────────
async def drop_excluded(
    db: AsyncSession, user_id: str | None, machine_id: str | None, tool_id: str, relative_path: str,
    project_name: str | None, content_hash: str, offset: int, end_offset: int | None,
) -> None:
    """Raise ProjectExcluded after recording the file as dropped, when project_name is excluded."""
    key = match_any(await excluded_keys(db, user_id), project_name)
    if key is None:
        return
    from .ingest_service import _update_sync_state

    await _update_sync_state(db, tool_id, relative_path, content_hash, offset, machine_id, end_offset)
    await mark_file(db, machine_id, tool_id, relative_path, key)
    raise ProjectExcluded(key)


async def mark_file(db: AsyncSession, machine_id: str | None, tool_id: str, relative_path: str, key: str | None) -> None:
    mid = uuid.UUID(str(machine_id)) if machine_id else None
    await db.execute(
        update(SyncState)
        .where(SyncState.tool_id == tool_id, SyncState.relative_path == relative_path,
               SyncState.machine_id == mid if mid else SyncState.machine_id.is_(None))
        .values(excluded_project=key)
    )


async def dropped_slice(
    db: AsyncSession, user_id: str, machine_id: str, tool_id: str, relative_path: str,
    content_hash: str, offset: int, end_offset: int | None,
) -> bool:
    """A slice of a log already known to belong to an excluded project: recorded as taken, True.
    A file whose project was put back (or never excluded) isn't: False, ingest as usual."""
    mid = uuid.UUID(str(machine_id))
    key = await db.scalar(
        select(SyncState.excluded_project).where(
            SyncState.machine_id == mid, SyncState.tool_id == tool_id, SyncState.relative_path == relative_path,
        )
    )
    if not key:
        return False
    if key not in await excluded_keys(db, user_id):
        await mark_file(db, machine_id, tool_id, relative_path, None)
        return False
    from .ingest_service import _update_sync_state

    await _update_sync_state(db, tool_id, relative_path, content_hash, offset, machine_id, end_offset)
    return True
