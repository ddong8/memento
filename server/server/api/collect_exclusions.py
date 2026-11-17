"""Projects the user doesn't collect: list, preview, add (and clean up), put back.

See services/project_exclusion.py for what excluding does.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services import project_exclusion as px

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/collect/exclusions", tags=["collect"])

STALE = timedelta(minutes=10)  # a cleanup still "purging" after this died with its replica: run it again


def _out(entry: dict) -> dict:
    return {k: entry.get(k) for k in ("key", "name", "added_at", "state", "updated_at", "purged", "error")}


async def _run_purge(user_id: uuid.UUID, key: str) -> None:
    from ..db.session import async_session_factory
    from ..services.cluster import cluster

    lock = await cluster.mutex(f"project-exclusion:{user_id}:{key}", ttl=300)
    if lock is None:
        return  # running on another replica
    try:
        async with async_session_factory() as db:
            user = (await db.execute(select(User).where(User.id == user_id))).scalar_one()
            if key not in px.keys_of(user):
                return  # put back meanwhile
            counts = await px.purge(db, user, key)
            logger.info("Project exclusion %s for %s cleaned up: %s", key, user_id, counts)
    except Exception as e:
        logger.exception("Project exclusion cleanup %s for %s failed", key, user_id)
        try:
            async with async_session_factory() as db:
                await px._update_entry(db, user_id, key, state="failed", error=str(e)[:300])
        except Exception:
            pass
    finally:
        await lock.release()


def _spawn(user_id: uuid.UUID, key: str) -> None:
    from ..services.cluster import cluster

    cluster.spawn(_run_purge(user_id, key))


@router.get("")
async def list_exclusions(user: User = Depends(get_current_user)) -> dict:
    items = px.entries(user)
    now = datetime.now(timezone.utc)
    for e in items:
        if e.get("state") in ("purging", "failed"):
            try:
                stale = now - datetime.fromisoformat(e.get("updated_at") or "") > STALE
            except ValueError:
                stale = True
            if stale or e.get("state") == "purging" and not e.get("purged"):
                _spawn(user.id, e["key"])
    return {"items": [_out(e) for e in items]}


@router.get("/preview")
async def preview_exclusion(
    name: str = Query(..., min_length=1, max_length=120),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    return await px.preview(db, user, name)


class ExclusionIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


@router.post("")
async def add_exclusion(
    body: ExclusionIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Stop collecting the project now and clean up what it left, in the background."""
    try:
        entry = await px.add(db, user, body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await px.invalidate(user.id)
    _spawn(user.id, entry["key"])
    return {"item": _out(entry)}


@router.post("/{key}/retry")
async def retry_exclusion(key: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    entry = await px._update_entry(db, user.id, key, state="purging", error=None)
    if entry is None:
        raise HTTPException(status_code=404)
    _spawn(user.id, key)
    return {"item": _out(entry)}


@router.delete("/{key}")
async def restore_exclusion(key: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Collect the project again; memories, skills, corrections, todos and profile rules come back,
    conversations come back from the devices on their next change."""
    entry = await px.restore(db, user, key)
    if entry is None:
        raise HTTPException(status_code=404)
    return {"item": _out(entry)}
