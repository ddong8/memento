"""Background maintenance helpers for projects: deduplication, consolidation, and document reconciliation."""

from __future__ import annotations

import time
import traceback
import uuid

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from ..db.models import Document, Machine, Project
from .cluster import cluster
from .ingest_service import (
    _IGNORE_PROJECT_NAMES,
    _is_invalid_project_name,
    _is_junk_or_uuid_title,
    _prettify_project_name,
)
from .project_placement import is_junk_project

_last_reconcile_time: dict[uuid.UUID, float] = {}
_RECONCILE_COOLDOWN_SECONDS: float = 120.0


_last_consolidation_time: float = 0.0
_CONSOLIDATION_INTERVAL_SECONDS: float = 600.0  # 10 minutes


async def _consolidate_projects_if_needed(db: AsyncSession, force: bool = False) -> None:
    """Consolidate fragmented projects, deduplicate variants, and heal orphaned docs.
    Throttled to run at most once every 10 minutes to avoid locking tables on every read request,
    and never on two api replicas at once.
    """
    global _last_consolidation_time
    now = time.time()
    if not force and (now - _last_consolidation_time < _CONSOLIDATION_INTERVAL_SECONDS):
        return
    _last_consolidation_time = now
    # The interval lock is never released: it expires when the next run is due, on any replica
    if not force and not await cluster.try_lock("project-consolidation-due", _CONSOLIDATION_INTERVAL_SECONDS):
        return
    running = await cluster.mutex("project-consolidation")
    if running is None:
        return
    try:
        all_projects = (await db.execute(select(Project))).scalars().all()
        has_changes = False
        for p in all_projects:
            raw_name = p.slug.split("/")[-1] if "/" in p.slug else p.slug
            if (
                _is_invalid_project_name(raw_name)
                or _is_invalid_project_name(p.title)
                or p.title in _IGNORE_PROJECT_NAMES
                or p.title.strip("-_./\\\"'` ") == ""
                or raw_name.strip("-_./\\\"'` ") == ""
            ):
                # Unassign orphaned documents
                await db.execute(
                    update(Document).where(Document.project_id == p.id).values(project_id=None)
                )
                await db.delete(p)
                has_changes = True
                continue

            clean_name = raw_name.strip("-\"'` ")
            prettified = _prettify_project_name(clean_name).strip("-\"'` ")
            clean_title = (p.title or "").strip("-\"'` ")
            is_dirty = (
                prettified != raw_name
                or p.title != clean_title
                or '"' in (p.title or "")
                or "'" in (p.title or "")
                or '"' in p.slug
                or "'" in p.slug
            )
            if is_dirty and not _is_invalid_project_name(prettified):
                canonical_slug = f"{p.tool_id}/{prettified}"
                canonical = (await db.execute(select(Project).where(Project.slug == canonical_slug))).scalar_one_or_none()
                if canonical and canonical.id != p.id:
                    await db.execute(
                        update(Document).where(Document.project_id == p.id).values(project_id=canonical.id)
                    )
                    await db.delete(p)
                    has_changes = True
                else:
                    p.slug = canonical_slug
                    p.title = prettified
                    has_changes = True

        # Deduplicate hyphen vs underscore equivalent projects (e.g. favorite_chat vs favorite-chat)
        all_cur_projs = (await db.execute(select(Project))).scalars().all()
        proj_by_slug: dict[str, Project] = {p.slug: p for p in all_cur_projs}
        proj_by_equiv: dict[tuple[str, str], list[Project]] = {}
        for p in all_cur_projs:
            equiv_key = (p.tool_id, p.slug.split("/")[-1].replace("-", "_").lower())
            proj_by_equiv.setdefault(equiv_key, []).append(p)
        for equiv_key, plist in proj_by_equiv.items():
            if len(plist) > 1:
                # Count docs for each project to pick canonical in a single batch query
                p_ids = [p_item.id for p_item in plist]
                doc_cnts = dict((await db.execute(
                    select(Document.project_id, func.count(Document.id))
                    .where(Document.project_id.in_(p_ids))
                    .group_by(Document.project_id)
                )).all())
                p_counts = [(doc_cnts.get(p_item.id, 0), p_item) for p_item in plist]
                p_counts.sort(key=lambda x: x[0], reverse=True)
                canonical_p = p_counts[0][1]
                for cnt, redundant_p in p_counts[1:]:
                    await db.execute(
                        update(Document).where(Document.project_id == redundant_p.id).values(project_id=canonical_p.id)
                    )
                    await db.delete(redundant_p)
                    proj_by_slug.pop(redundant_p.slug, None)
                    has_changes = True

        # Auto-adopt orphaned documents across all tools (query only necessary columns)
        orphaned_docs = (await db.execute(
            select(Document.id, Document.tool_id, Document.metadata_, Document.relative_path).where(
                Document.project_id.is_(None),
                Document.category == "conversation",
            )
        )).all()
        for od_id, od_tool_id, od_metadata, od_rel_path in orphaned_docs:
            p_cand = None
            if isinstance(od_metadata, dict):
                p_cand = od_metadata.get("project_hash")
            if not p_cand and od_rel_path and od_rel_path.startswith("projects/"):
                parts = od_rel_path.split("/")
                if len(parts) >= 3:
                    p_cand = parts[1]
            if p_cand:
                prettified = _prettify_project_name(p_cand)
                if not _is_invalid_project_name(prettified):
                    c_slug = f"{od_tool_id}/{prettified}"
                    canon = proj_by_slug.get(c_slug)
                    if canon:
                        await db.execute(
                            update(Document).where(Document.id == od_id).values(project_id=canon.id)
                        )
                        has_changes = True

        # Auto-heal misassigned conversation documents (fetch only scalar IDs & metadata, never content)
        misassigned_docs = (await db.execute(
            select(
                Document.id,
                Document.tool_id,
                Document.metadata_,
                Document.project_id,
                Project.id,
                Project.slug,
                Project.title,
            )
            .join(Project, Document.project_id == Project.id)
            .where(
                Document.category == "conversation",
                Document.metadata_.isnot(None),
            )
        )).all()
        for doc_id, doc_tool_id, doc_metadata, doc_proj_id, cur_proj_id, cur_proj_slug, cur_proj_title in misassigned_docs:
            if not isinstance(doc_metadata, dict):
                continue
            p_cand = doc_metadata.get("project_hash")
            if not p_cand:
                p_path = doc_metadata.get("project_path")
                if p_path and isinstance(p_path, str):
                    p_cand = p_path.replace("\\", "/").rstrip("/").split("/")[-1]
            if not p_cand:
                continue
            prettified = _prettify_project_name(str(p_cand)).strip("-\"'` ")
            if not prettified or _is_invalid_project_name(prettified) or is_junk_project(prettified, doc_metadata.get("project_path")):
                continue
            cur_slug_name = cur_proj_slug.split("/")[-1].lower()
            cand_lower = prettified.lower()
            if cand_lower != cur_proj_title.lower() and cand_lower != cur_slug_name:
                correct_slug = f"{doc_tool_id}/{prettified}"
                correct_p = proj_by_slug.get(correct_slug)
                if correct_p and correct_p.id != cur_proj_id:
                    await db.execute(
                        update(Document).where(Document.id == doc_id).values(project_id=correct_p.id)
                    )
                    has_changes = True

        # Auto-heal machine_id on documents where machine_id is NULL
        all_machines = (await db.execute(select(Machine))).scalars().all()
        mac_mini_m = next((m for m in all_machines if "mac-mini" in (m.name or "").lower() or "mini" in (m.name or "").lower()), None)
        macbook_m = next((m for m in all_machines if "macbook" in (m.name or "").lower()), None)
        win_m = next((m for m in all_machines if "windows" in (m.name or "").lower()), None)

        if mac_mini_m:
            await db.execute(
                update(Document)
                .where(
                    Document.machine_id.is_(None),
                    or_(
                        Document.relative_path.ilike("%haixingdong%"),
                        Document.metadata_["project_path"].astext.ilike("%haixingdong%"),
                    ),
                )
                .values(machine_id=mac_mini_m.id)
            )
            has_changes = True
        if macbook_m:
            await db.execute(
                update(Document)
                .where(
                    Document.machine_id.is_(None),
                    or_(
                        Document.relative_path.ilike("%donghaixing%"),
                        Document.metadata_["project_path"].astext.ilike("%donghaixing%"),
                    ),
                )
                .values(machine_id=macbook_m.id)
            )
            has_changes = True
        if win_m:
            await db.execute(
                update(Document)
                .where(
                    Document.machine_id.is_(None),
                    or_(
                        Document.metadata_["project_path"].astext.ilike("%d:/%"),
                        Document.metadata_["project_path"].astext.ilike("%c:/%"),
                        Document.metadata_["project_path"].astext.ilike("%d:\\%"),
                        Document.metadata_["project_path"].astext.ilike("%c:\\%"),
                    ),
                )
                .values(machine_id=win_m.id)
            )
            has_changes = True

        if has_changes:
            await db.commit()
    except Exception as exc:
        print(f"[Projects API] Consolidation error: {exc}\n{traceback.format_exc()}")
    finally:
        await running.release()


async def _reconcile_project_documents(
    db: AsyncSession,
    target_project: Project,
    target_mid: uuid.UUID | None = None,
    force: bool = False,
) -> int:
    """Auto-adopt and reconcile conversations belonging to this project.

    Catches documents that were:
      - left orphaned (doc.project_id IS NULL)
      - assigned to fragmented projects (e.g. claude_code/d-dev-2026-0707-pubchem or claude_code/d:)
      - misassigned during initial delta ingest
    Returns the number of adopted documents.
    """
    global _last_reconcile_time
    now = time.time()
    last_t = _last_reconcile_time.get(target_project.id, 0.0)
    if not force and (now - last_t < _RECONCILE_COOLDOWN_SECONDS):
        return 0
    _last_reconcile_time[target_project.id] = now
    # Cooldown shared by the api replicas: the lock simply expires
    if not force and not await cluster.try_lock(f"reconcile:{target_project.id}", _RECONCILE_COOLDOWN_SECONDS):
        return 0
    try:
        tool_id = target_project.tool_id
        raw_slug_name = target_project.slug.split("/")[-1] if "/" in target_project.slug else target_project.slug
        clean_title = _prettify_project_name(target_project.title or raw_slug_name)
        if _is_invalid_project_name(clean_title):
            return 0

        # 1. Expand candidate aliases (hyphen and underscore variants)
        cand_titles = {
            clean_title,
            clean_title.replace("_", "-"),
            clean_title.replace("-", "_"),
        }
        cand_titles = {t for t in cand_titles if t and not _is_invalid_project_name(t)}

        frag_conditions = [
            Project.slug.in_([f"{tool_id}/d:", f"{tool_id}/c:", f"{tool_id}/d", f"{tool_id}/c"]),
        ]
        for ct in cand_titles:
            frag_conditions.extend([
                Project.slug.ilike(f"%-{ct}"),
                Project.slug.ilike(f"%/{ct}"),
                Project.title.ilike(f"%-{ct}"),
                Project.title.ilike(ct),
                Project.slug.ilike(f"{tool_id}/{ct}"),
            ])

        frag_q = select(Project).where(
            Project.tool_id == tool_id,
            Project.id != target_project.id,
            or_(*frag_conditions),
        )
        frag_rows = (await db.execute(frag_q)).scalars().all()
        frag_ids = [fp.id for fp in frag_rows]

        # 2. Build match conditions for documents that belong to this project
        doc_conds = []
        for ct in cand_titles:
            doc_conds.extend([
                Document.relative_path.ilike(f"%/{ct}/%"),
                Document.relative_path.ilike(f"%-{ct}/%"),
                Document.metadata_["project_hash"].astext == ct,
                Document.metadata_["project_path"].astext.ilike(f"%{ct}"),
                Document.metadata_["project_path"].astext.ilike(f"%{ct}/%"),
                Document.metadata_["project_path"].astext.ilike(f"%{ct}\\%"),
            ])
            if tool_id == "antigravity":
                doc_conds.extend([
                    Document.content.ilike(f"%Active Workspaces:%/{ct}%"),
                    Document.content.ilike(f"%Command Working Directory:%/{ct}%"),
                    Document.content.ilike(f"%\"cwd\"%/{ct}%"),
                    Document.content.ilike(f"%\"Cwd\"%/{ct}%"),
                ])
        adopt_cond = or_(*doc_conds)
        if frag_ids:
            adopt_cond = adopt_cond | Document.project_id.in_(frag_ids)

        match_docs_q = (
            select(Document)
            .options(
                defer(Document.content),
                defer(Document.rendered_html),
            )
            .where(
                Document.tool_id == tool_id,
                Document.category == "conversation",
                or_(
                    Document.project_id.is_(None),
                    Document.project_id.in_(frag_ids),
                ) if frag_ids else Document.project_id.is_(None),
                adopt_cond,
            )
        )
        if target_mid is not None:
            match_docs_q = match_docs_q.where(
                or_(
                    Document.machine_id == target_mid,
                    Document.machine_id.is_(None),
                )
            )

        docs_to_adopt = (await db.execute(match_docs_q)).scalars().all()
        adopted_count = len(docs_to_adopt)
        if docs_to_adopt:
            for doc in docs_to_adopt:
                doc.project_id = target_project.id
                if target_mid is not None and doc.machine_id is None:
                    doc.machine_id = target_mid
            # Also adopt any associated state/plan documents sharing session_id
            adopted_sids = [
                d.metadata_.get("session_id")
                for d in docs_to_adopt
                if isinstance(d.metadata_, dict) and d.metadata_.get("session_id")
            ]
            if adopted_sids:
                related_docs_q = (
                    select(Document)
                    .options(
                        defer(Document.content),
                        defer(Document.rendered_html),
                    )
                    .where(
                        Document.tool_id == tool_id,
                        Document.project_id.is_(None),
                        Document.metadata_["session_id"].astext.in_(adopted_sids),
                    )
                )
                related_docs = (await db.execute(related_docs_q)).scalars().all()
                for rd in related_docs:
                    rd.project_id = target_project.id
            await db.flush()

        # 2.5. Auto-materialize parent conversation documents for subagents
        # When subagents (e.g. projects/.../<session_id>/subagents/...) exist in this project
        # but the parent document (projects/.../<session_id>.jsonl) does not exist (e.g. because
        # the parent file was huge or failed upload), the session is orphaned and omitted.
        subagent_q = (
            select(Document)
            .options(
                defer(Document.content),
                defer(Document.rendered_html),
            )
            .where(
                Document.project_id == target_project.id,
                Document.category == "conversation",
                Document.relative_path.ilike("%/subagents/%"),
            )
        )
        if target_mid is not None:
            subagent_q = subagent_q.where(Document.machine_id == target_mid)
        subagent_rows = (await db.execute(subagent_q)).scalars().all()

        parent_to_subs: dict[str, list[Document]] = {}
        for s_doc in subagent_rows:
            rp = s_doc.relative_path or ""
            if "/subagents/" in rp:
                parent_base = rp.split("/subagents/")[0] + ".jsonl"
                parent_to_subs.setdefault(parent_base, []).append(s_doc)

        for parent_base, s_docs in parent_to_subs.items():
            # Check if parent Document exists
            p_exist_q = select(Document).where(
                Document.relative_path == parent_base,
            )
            p_exist = (await db.execute(p_exist_q)).scalar_one_or_none()
            if p_exist is None:
                first_sub = s_docs[0]
                session_id = parent_base.split("/")[-1].replace(".jsonl", "")
                parent_title = ""

                # Try to extract title from memory files referencing this session
                mem_q = select(Document).where(
                    Document.project_id == target_project.id,
                    Document.category == "memory",
                    Document.content.ilike(f"%{session_id}%"),
                ).limit(1)
                mem_doc = (await db.execute(mem_q)).scalar_one_or_none()
                if mem_doc and mem_doc.title:
                    clean_mem = mem_doc.title.strip().replace("-", " ")
                    parent_title = clean_mem
                elif first_sub.title and not _is_junk_or_uuid_title(first_sub.title, session_id):
                    parent_title = first_sub.title

                if not parent_title or _is_junk_or_uuid_title(parent_title, session_id):
                    parent_title = f"{clean_title} 会话"

                new_parent = Document(
                    id=uuid.uuid4(),
                    project_id=target_project.id,
                    machine_id=first_sub.machine_id,
                    tool_id=target_project.tool_id,
                    category="conversation",
                    content_type="jsonl",
                    relative_path=parent_base,
                    title=parent_title,
                    file_size_bytes=0,
                    content="",
                    content_hash=f"synthetic-{session_id[:8]}",
                    metadata_={
                        "session_id": session_id,
                        "is_subagent": False,
                        "project_hash": clean_title,
                        "synthetic": True,
                    },
                    synced_at=first_sub.synced_at,
                    source_modified_at=first_sub.source_modified_at,
                )
                db.add(new_parent)
                adopted_count += 1
            elif p_exist.project_id != target_project.id:
                p_exist.project_id = target_project.id
                adopted_count += 1

        # 3. Clean up empty fragmented projects
        for fp in frag_rows:
            remaining_cnt = (await db.execute(
                select(func.count(Document.id)).where(Document.project_id == fp.id)
            )).scalar()
            if not remaining_cnt:
                await db.delete(fp)
        await db.flush()
        return adopted_count
    except Exception:
        return 0
