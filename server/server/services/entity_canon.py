"""One knowledge-graph entity per thing.

Extraction names the same thing differently from one conversation to the next: Memento
is a project in one, a tool in another, a file in a third. Each (name, type) used to get
its own entity, and the nightly dedup only merged within a type, so by 2026-10-27 one
user had 1852 same-name extras, and the five Memento entities each carried part of the
story; the tool one, summarised from a single conversation about uninstalling an old
local build, said "已彻底卸载" and was what got injected.

- find_entity: the entity a name belongs to, however it is cased or hyphenated, across
  types. People and organisations only match their own type (a person named like a tool
  is somebody else).
- summary_update: a summary saying the thing is gone doesn't replace one that doesn't;
  it is kept as an observation of the conversation that said it instead.
- merge_duplicate_entities (nightly, in dreaming): folds the existing duplicates into the
  one with the most observations and relations, recording each merged row in aliases.
- mark_stale_entities (nightly): a summary saying it is gone while later conversations
  keep using it is marked stale, and not injected, rather than deleted.
"""

from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, literal_column, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import KnowledgeEntity, KnowledgeObservation, KnowledgeRelation

logger = logging.getLogger("server.entity_canon")

IDENTITY_TYPES = frozenset({"person", "organization"})
_ANY_TYPE = "*"
# "已彻底卸载", "被删除", "不再使用", "已被 X 取代": the summary says the thing is no longer around
GONE_PATTERN = (
    r"(已|被)(彻底|完全|全部)?(卸载|删除|删掉|移除|下线|废弃|弃用|停用|淘汰|清除|清理掉)"
    r"|不再(使用|维护)|已被[^，。]{0,12}(替换|取代|替代)"
)
GONE_RE = re.compile(GONE_PATTERN)
# Conversations after the one that said it was gone, still talking about it
STALE_MIN_DOCUMENTS = 2
STALE_AFTER = timedelta(days=1)


def norm_name(name: str | None) -> str:
    return re.sub(r"[-_\s]+", "", (name or "").strip().lower())


def norm_name_sql() -> Any:
    # Written exactly as idx_knowledge_entities_norm_name, constants inline so the planner uses it
    return func.regexp_replace(
        func.lower(KnowledgeEntity.name), literal_column("'[-_\\s]+'"), literal_column("''"), literal_column("'g'"),
    )


def merge_class(entity_type: str | None) -> str:
    t = (entity_type or "").strip().lower()
    return t if t in IDENTITY_TYPES else _ANY_TYPE


def is_gone(summary: str | None) -> bool:
    return bool(summary and GONE_RE.search(summary))


async def find_entity(db: AsyncSession, user_id: Any, name: str, entity_type: str) -> KnowledgeEntity | None:
    """The user's entity for this name: the exact (name, type) if there is one, else the
    oldest one the name normalises to within the type's merge class."""
    norm = norm_name(name)
    if not norm:
        return None
    q = select(KnowledgeEntity).where(KnowledgeEntity.user_id == user_id, norm_name_sql() == norm)
    cls, etype = merge_class(entity_type), func.lower(KnowledgeEntity.entity_type)
    q = q.where(etype.notin_(IDENTITY_TYPES) if cls == _ANY_TYPE else etype == cls)
    rows = list((await db.execute(q.order_by(KnowledgeEntity.created_at).limit(20))).scalars().all())
    exact = next((r for r in rows if r.name == name and r.entity_type == entity_type), None)
    return exact or (rows[0] if rows else None)


def summary_update(old: str | None, new: str | None, old_stale: bool = False) -> str | None:
    """The summary to store when a conversation describes an existing entity, or None to keep it."""
    new = (new or "").strip()
    if not new or new == (old or "").strip():
        return None
    if not old:
        return new
    old_gone, new_gone = old_stale or is_gone(old), is_gone(new)
    if new_gone and not old_gone:
        return None  # one conversation's "removed" doesn't rewrite what the others say it is
    if old_gone and not new_gone:
        return new  # described as in use again
    return new if len(new) > len(old) else None


# ---------------------------------------------------------------------------
# Nightly merge
# ---------------------------------------------------------------------------


@dataclass
class EntityRow:
    id: Any
    name: str
    entity_type: str
    summary: str | None
    created_at: datetime | None
    aliases: list = field(default_factory=list)
    observations: int = 0
    relations: int = 0
    stale_at: datetime | None = None
    stale_reason: str | None = None

    @property
    def weight(self) -> int:
        return self.observations + self.relations


@dataclass
class Merge:
    canonical: EntityRow
    duplicates: list[EntityRow]
    summary: str | None
    aliases: list
    clear_stale: bool


def _ts(d: datetime | None) -> float:
    return d.timestamp() if d else float("inf")


def plan_merges(rows: list[EntityRow], now: datetime) -> list[Merge]:
    """Group by normalised name within a merge class; the one with most observations and
    relations (then the oldest) stays. Pure, so the choice is testable."""
    groups: dict[tuple[str, str], list[EntityRow]] = defaultdict(list)
    for r in rows:
        n = norm_name(r.name)
        if n:
            groups[(n, merge_class(r.entity_type))].append(r)

    plans: list[Merge] = []
    at = now.isoformat()
    for group in groups.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda r: (-r.weight, _ts(r.created_at), str(r.id)))
        keep, dups = group[0], group[1:]
        aliases = list(keep.aliases or [])
        for d in dups:
            aliases.append({
                "id": str(d.id), "name": d.name, "type": d.entity_type, "summary": d.summary,
                "observations": d.observations, "relations": d.relations, "merged_at": at,
            })
            aliases.extend(d.aliases or [])

        summary, clear_stale = keep.summary, False
        if not summary or keep.stale_at or is_gone(summary):
            better = [d for d in dups if d.summary and not d.stale_at and not is_gone(d.summary)]
            if better:
                summary, clear_stale = better[0].summary, True
            elif not summary:
                summary = next((d.summary for d in dups if d.summary), None)
            if summary != keep.summary and keep.summary:
                aliases.append({"id": str(keep.id), "name": keep.name, "type": keep.entity_type,
                                "summary": keep.summary, "replaced_at": at})
        plans.append(Merge(keep, dups, summary, aliases, clear_stale))
    return plans


_MAP = "unnest(CAST(:dups AS uuid[]), CAST(:canons AS uuid[])) AS m(dup, canon)"


async def _load_rows(db: AsyncSession, user_id: Any) -> list[EntityRow]:
    E = KnowledgeEntity
    obs = (
        select(KnowledgeObservation.entity_id.label("eid"), func.count().label("n"))
        .join(E, E.id == KnowledgeObservation.entity_id)
        .where(E.user_id == user_id)
        .group_by(KnowledgeObservation.entity_id)
        .subquery()
    )
    ends = (
        select(KnowledgeRelation.source_id.label("eid")).join(E, E.id == KnowledgeRelation.source_id).where(E.user_id == user_id)
        .union_all(select(KnowledgeRelation.target_id.label("eid")).join(E, E.id == KnowledgeRelation.target_id).where(E.user_id == user_id))
        .subquery()
    )
    rels = select(ends.c.eid, func.count().label("n")).group_by(ends.c.eid).subquery()
    q = (
        select(E.id, E.name, E.entity_type, E.summary, E.created_at, E.aliases, E.stale_at, E.stale_reason,
               func.coalesce(obs.c.n, 0), func.coalesce(rels.c.n, 0))
        .outerjoin(obs, obs.c.eid == E.id)
        .outerjoin(rels, rels.c.eid == E.id)
        .where(E.user_id == user_id)
    )
    return [
        EntityRow(id=i, name=n, entity_type=t, summary=s, created_at=c, aliases=a or [], stale_at=sa, stale_reason=sr,
                  observations=int(no), relations=int(nr))
        for i, n, t, s, c, a, sa, sr, no, nr in (await db.execute(q)).all()
    ]


def _forget_graph_objects(db: AsyncSession) -> None:
    """Rows were moved and deleted behind the ORM's back: drop its copies so nothing
    flushes or lazy-loads a deleted entity later in the same session."""
    if not isinstance(db, AsyncSession):
        return
    for obj in list(db.sync_session.identity_map.values()):
        if isinstance(obj, (KnowledgeEntity, KnowledgeObservation, KnowledgeRelation)):
            db.expunge(obj)


async def merge_duplicate_entities(db: AsyncSession, user_id: Any, now: datetime | None = None) -> dict[str, int]:
    """Fold same-name entities into one per merge class. Observations and relations move to
    the kept entity (identical observations and parallel edges collapse, self-loops go),
    the merged rows are deleted and recorded in its aliases."""
    now = now or datetime.now(timezone.utc)
    stats = {"merged_entities": 0, "merged_groups": 0, "cross_type": 0, "merged_observations": 0,
             "updated_relations": 0, "collapsed_edges": 0}
    await db.flush()  # pending rows first, so they move with the rest
    plans = plan_merges(await _load_rows(db, user_id), now)
    if plans:
        await _fold(db, plans, stats)
        logger.info("Merged %d same-name entities into %d for user %s", stats["merged_entities"], len(plans), user_id)
    stats["collapsed_edges"] = await collapse_parallel_edges(db, user_id)
    if plans or stats["collapsed_edges"]:
        _forget_graph_objects(db)
    return stats


async def collapse_parallel_edges(db: AsyncSession, user_id: Any) -> int:
    """One edge per (source, target, relation type), strengths added: merges bring the same
    relation seen under two names together, and dreaming used to add a new edge every night."""
    collapsed = await db.execute(text(
        "WITH g AS ("
        " SELECT (array_agg(r.id ORDER BY r.created_at NULLS LAST, r.id))[1] AS keep, array_agg(r.id) AS ids,"
        " sum(coalesce(r.strength, 1.0)) AS strength"
        " FROM knowledge_relations r JOIN knowledge_entities e ON e.id = r.source_id"
        " WHERE e.user_id = :uid"
        " GROUP BY r.source_id, r.target_id, r.relation_type HAVING count(*) > 1"
        "), bumped AS (UPDATE knowledge_relations r SET strength = g.strength FROM g WHERE r.id = g.keep RETURNING r.id)"
        " DELETE FROM knowledge_relations r USING g WHERE r.id = ANY(g.ids) AND r.id <> g.keep"
    ), {"uid": user_id})
    return collapsed.rowcount or 0


async def _fold(db: AsyncSession, plans: list[Merge], stats: dict[str, int]) -> None:
    dups = [d.id for p in plans for d in p.duplicates]
    canons = [p.canonical.id for p in plans for _ in p.duplicates]
    kept = [p.canonical.id for p in plans]
    m = {"dups": dups, "canons": canons}

    moved = await db.execute(text(f"UPDATE knowledge_observations o SET entity_id = m.canon FROM {_MAP} WHERE o.entity_id = m.dup"), m)
    stats["merged_observations"] = moved.rowcount or 0
    # Identical facts now on one entity: keep the latest sighting
    await db.execute(text(
        "DELETE FROM knowledge_observations o USING ("
        " SELECT id, row_number() OVER (PARTITION BY entity_id, content ORDER BY observed_at DESC NULLS LAST, id) AS rn"
        " FROM knowledge_observations WHERE entity_id = ANY(CAST(:kept AS uuid[]))"
        ") d WHERE o.id = d.id AND d.rn > 1"
    ), {"kept": kept})

    src = await db.execute(text(f"UPDATE knowledge_relations r SET source_id = m.canon FROM {_MAP} WHERE r.source_id = m.dup"), m)
    tgt = await db.execute(text(f"UPDATE knowledge_relations r SET target_id = m.canon FROM {_MAP} WHERE r.target_id = m.dup"), m)
    stats["updated_relations"] = (src.rowcount or 0) + (tgt.rowcount or 0)
    await db.execute(text(
        "DELETE FROM knowledge_relations WHERE source_id = target_id AND source_id = ANY(CAST(:kept AS uuid[]))"
    ), {"kept": kept})

    await db.execute(text("DELETE FROM knowledge_entities WHERE id = ANY(CAST(:dups AS uuid[]))"), {"dups": dups})
    # updated_at stays: a merge isn't news about the thing (dreaming reads recently updated entities)
    await db.execute(text(
        "UPDATE knowledge_entities SET aliases = CAST(:aliases AS jsonb), summary = :summary,"
        " stale_at = CASE WHEN :clear THEN NULL ELSE stale_at END,"
        " stale_reason = CASE WHEN :clear THEN NULL ELSE stale_reason END,"
        " updated_at = updated_at WHERE id = :id"
    ), [
        {"id": p.canonical.id, "aliases": json.dumps(p.aliases, ensure_ascii=False, default=str),
         "summary": p.summary, "clear": p.clear_stale}
        for p in plans
    ])

    stats["merged_entities"] = len(dups)
    stats["merged_groups"] = len(plans)
    stats["cross_type"] = sum(1 for p in plans if any(d.entity_type != p.canonical.entity_type for d in p.duplicates))


async def mark_stale_entities(db: AsyncSession, user_id: Any, now: datetime | None = None) -> int:
    """Summaries that say the thing is gone, while conversations after the one that said so
    keep mentioning it as in use: marked stale (with why), left in place."""
    now = now or datetime.now(timezone.utc)
    E, O = KnowledgeEntity, KnowledgeObservation
    cands = (await db.execute(
        select(E.id, E.updated_at).where(E.user_id == user_id, E.stale_at.is_(None), E.summary.op("~")(GONE_PATTERN))
    )).all()
    if not cands:
        return 0
    updated = {eid: at for eid, at in cands}
    seen: dict[Any, list[tuple[Any, str, datetime | None]]] = defaultdict(list)
    for eid, doc_id, content, at in (await db.execute(
        select(O.entity_id, O.source_document_id, O.content, O.observed_at).where(O.entity_id.in_(list(updated)))
    )).all():
        seen[eid].append((doc_id, content or "", at))

    marked = 0
    for eid, obs in seen.items():
        said = [(d, at) for d, c, at in obs if GONE_RE.search(c)]
        since = max((at for _, at in said if at), default=None) or updated[eid]
        gone_docs = {d for d, _ in said}
        later = {d for d, c, at in obs
                 if d and d not in gone_docs and at and since and at > since + STALE_AFTER and not GONE_RE.search(c)}
        if len(later) < STALE_MIN_DOCUMENTS:
            continue
        await db.execute(
            update(E).where(E.id == eid)
            .values(stale_at=now, stale_reason=f"描述说它已经不在了，但之后又有 {len(later)} 个对话提到它", updated_at=E.updated_at)
            .execution_options(synchronize_session=False)
        )
        marked += 1
    return marked
