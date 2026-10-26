"""Skills API — review and publish in the app, pull from collectors."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Machine, Skill, User
from ..db.session import get_db
from ..middleware.auth import get_current_user, verify_collector_token
from ..services.cache import cache_delete_prefix, cache_get, cache_set
from ..services.skill_service import (
    apply_edits,
    apply_pending_update,
    injection_for,
    publish,
    skill_counts,
    skill_out,
)

router = APIRouter(prefix="/api/skills", tags=["skills"])


class SkillEdit(BaseModel):
    title: str | None = None
    description: str | None = None
    body: str | None = None
    slug: str | None = None
    project: str | None = None


class InjectionReport(BaseModel):
    results: dict[str, str]


async def _own(db: AsyncSession, user: User, skill_id: str) -> Skill:
    try:
        sid = uuid.UUID(skill_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="not found")
    skill = await db.get(Skill, sid)
    if skill is None or skill.user_id != user.id:
        raise HTTPException(status_code=404, detail="not found")
    return skill


async def _edit(db: AsyncSession, user: User, skill: Skill, body: SkillEdit | None) -> None:
    if body is None:
        return
    edits = body.model_dump(exclude_none=True)
    if not edits:
        return
    try:
        await apply_edits(db, user, skill, edits)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


async def _bust_skills_cache(user_id: uuid.UUID) -> None:
    try:
        await cache_delete_prefix(f"skills:list:{user_id}")
        await cache_delete_prefix(f"skills_injection:{user_id}")
    except Exception:
        pass


@router.get("")
async def list_skills(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    cache_key = f"skills:list:{user.id}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    rows = (await db.execute(
        select(Skill).where(Skill.user_id == user.id)
        .order_by(Skill.last_seen_at.desc().nulls_last(), Skill.created_at.desc())
    )).scalars().all()
    machines = (await db.execute(
        select(Machine).where(Machine.user_id == user.id, Machine.merged_into.is_(None), Machine.is_archived.is_(False)).order_by(Machine.last_heartbeat.desc().nulls_last())
    )).scalars().all()
    payload = {
        "drafts": [skill_out(s) for s in rows if s.status == "draft"],
        "published": [skill_out(s) for s in rows if s.status == "published"],
        "archived": [skill_out(s, full=False) for s in rows if s.status in ("dismissed", "retired")],
        "counts": await skill_counts(db, user),
        "devices": [
            {
                "device_id": m.collector_token_hash,
                "name": m.name,
                "targets": m.profile_targets or [],
                "status": m.skill_status or {},
            }
            for m in machines
        ],
    }
    await cache_set(cache_key, payload, ttl_seconds=30)
    return payload


@router.put("/{skill_id}")
async def edit_skill(
    skill_id: str,
    body: SkillEdit,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Save edits. On a published skill this ships a new version right away."""
    skill = await _own(db, user, skill_id)
    await _edit(db, user, skill, body)
    if skill.status == "published":
        publish(skill)
    await db.commit()
    await _bust_skills_cache(user.id)
    await db.refresh(skill)
    return {"skill": skill_out(skill)}


@router.post("/{skill_id}/publish")
async def publish_skill(
    skill_id: str,
    body: SkillEdit | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    skill = await _own(db, user, skill_id)
    await _edit(db, user, skill, body)
    if not skill.description.strip() or not skill.body.strip():
        raise HTTPException(status_code=400, detail="说明和步骤都不能为空")
    publish(skill)
    await db.commit()
    await _bust_skills_cache(user.id)
    await db.refresh(skill)
    return {"skill": skill_out(skill)}


@router.post("/{skill_id}/dismiss")
async def dismiss_skill(
    skill_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """A draft the user doesn't want. Reviews won't propose it again."""
    skill = await _own(db, user, skill_id)
    skill.status = "dismissed"
    await db.commit()
    await _bust_skills_cache(user.id)
    return {"skill": skill_out(skill)}


@router.post("/{skill_id}/retire")
async def retire_skill(
    skill_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Stop shipping a published skill; collectors remove it on their next sync."""
    skill = await _own(db, user, skill_id)
    skill.status = "retired"
    await db.commit()
    await _bust_skills_cache(user.id)
    return {"skill": skill_out(skill)}


@router.post("/{skill_id}/restore")
async def restore_skill(
    skill_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Back to draft from dismissed / retired."""
    skill = await _own(db, user, skill_id)
    skill.status = "draft"
    await db.commit()
    await _bust_skills_cache(user.id)
    return {"skill": skill_out(skill)}


@router.post("/{skill_id}/update/apply")
async def apply_update(
    skill_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Take the change a later session proposed (publishes a new version if published)."""
    skill = await _own(db, user, skill_id)
    if not skill.pending_update:
        raise HTTPException(status_code=400, detail="没有待确认的更新")
    apply_pending_update(skill)
    await db.commit()
    await _bust_skills_cache(user.id)
    await db.refresh(skill)
    return {"skill": skill_out(skill)}


@router.post("/{skill_id}/update/discard")
async def discard_update(
    skill_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    skill = await _own(db, user, skill_id)
    skill.pending_update = None
    await db.commit()
    await _bust_skills_cache(user.id)
    return {"skill": skill_out(skill)}


# ---------------------------------------------------------------------------
# Collector (X-Collector-Token + X-Device-Id)
# ---------------------------------------------------------------------------

async def _machine(db: AsyncSession, user: User, device_id: str) -> Machine:
    machine = (await db.execute(
        select(Machine).where(Machine.collector_token_hash == device_id, Machine.user_id == user.id)
    )).scalars().first()
    if machine is None:
        raise HTTPException(status_code=404, detail="device not found")
    return machine


@router.get("/injection")
async def get_injection(
    x_device_id: str = Header(..., alias="X-Device-Id"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(verify_collector_token),
) -> dict:
    """Published skills and the skills folders this device should keep them in.

    Folders follow the per-device tool switches of the resident profile: turning a
    tool off there also takes its skills back out.
    """
    cache_key = f"skills_injection:{user.id}:{x_device_id}"
    try:
        cached = await cache_get(cache_key)
        if isinstance(cached, dict):
            return cached
    except Exception:
        pass

    machine = await _machine(db, user, x_device_id)
    res = await injection_for(db, user, machine)
    try:
        await cache_set(cache_key, res, ttl_seconds=60)
    except Exception:
        pass
    return res


@router.post("/injection/status")
async def report_injection(
    body: InjectionReport,
    x_device_id: str = Header(..., alias="X-Device-Id"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(verify_collector_token),
) -> dict:
    machine = await _machine(db, user, x_device_id)
    machine.skill_status = {
        "results": {str(k)[:120]: str(v)[:200] for k, v in list(body.results.items())[:200]},
        "reported_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.commit()
    return {"status": "ok"}
