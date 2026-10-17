"""Celery task for Nightly Dreaming Consolidation."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from ..db.models import User
from ..db.session import async_session_factory
from ..services import ai_health
from ..services.cluster import PREFIX, Mutex, cluster
from ..services.dreaming_service import run_dreaming_backfill, run_dreaming_pipeline
from ..services.notify_service import notify_user
from ..services.profile_service import build_profile_draft

try:
    from .celery_app import celery_app
except (ImportError, ModuleNotFoundError):
    class _DummyCelery:
        def task(self, *args, **kwargs):
            def decorator(fn):
                fn.delay = fn
                return fn
            return decorator
    celery_app = _DummyCelery()

logger = logging.getLogger("server.tasks.dreaming_tasks")

# A backfill runs on the api replica that got the request, holding the
# BACKFILL_LOCK mutex; its progress goes to Redis so any replica can report it.
_BACKFILL_STATUS: dict[str, dict] = {}
_BACKFILL_KEY = f"{PREFIX}dream-backfill:"
BACKFILL_LOCK = "dream-backfill:"


async def get_backfill_status(user_id: str) -> dict:
    """Get the current progress or latest result of a user's dreaming backfill."""
    status = _BACKFILL_STATUS.get(user_id)
    if status and status.get("status") == "running":
        return status  # it runs here: this copy is the freshest
    r = cluster.redis
    if r is not None:
        try:
            raw = await r.get(_BACKFILL_KEY + user_id)
            status = json.loads(raw) if raw else status
        except Exception as e:
            logger.warning("reading backfill status of %s failed: %s", user_id, e)
    if status is None:
        return {"status": "idle"}
    if status.get("status") == "running" and not await cluster.locked(BACKFILL_LOCK + user_id):
        return {"status": "error", "error": "回填所在的服务实例已重启，回填中断，可以重新发起"}
    return status


def set_backfill_status(user_id: str, status: dict) -> None:
    """Update backfill status (this replica, and Redis for the others)."""
    _BACKFILL_STATUS[user_id] = status
    blob = json.dumps(status, ensure_ascii=False, default=str)
    cluster.write(lambda r: r.set(_BACKFILL_KEY + user_id, blob, ex=7 * 86400))


async def _run_all_users_dreaming(days_back: int = 1) -> dict[str, int]:
    """Run dreaming consolidation for all active users."""
    async with async_session_factory() as db:
        res = await db.execute(
            select(User).where(User.status == "active")
        )
        users = res.scalars().all()
        processed = 0
        errors = 0

        for user in users:
            run: dict = {"at": datetime.now(timezone.utc).isoformat(), "ok": True}
            try:
                journal = await run_dreaming_pipeline(db, user, days_back=days_back)
                processed += 1
                run["promoted"] = ((journal.stage_metrics or {}).get("promoted_count") if journal else None)
            except Exception as e:
                logger.error("Dreaming failed for user %s (%s): %s", user.id, user.email, e)
                await db.rollback()
                errors += 1
                run.update(ok=False, error=f"{type(e).__name__}: {e}"[:300])

            # Refresh the resident-profile draft. It only reaches AI tools once
            # the user publishes it, so a bad night can't spread anywhere.
            try:
                _, run["profile_status"] = await build_profile_draft(db, user)
            except Exception as e:
                logger.warning("Profile draft failed for user %s: %s", user.id, e)
                await db.rollback()
                run["profile_status"] = "error"
                run["profile_error"] = f"{type(e).__name__}: {e}"[:300]

            await ai_health.put_json(f"dreaming:{user.id}", run)
            await _alert_bad_night(user, run)

        return {"processed": processed, "errors": errors}


async def _alert_bad_night(user: User, run: dict) -> None:
    problems = []
    if not run["ok"]:
        problems.append(f"做梦失败：{run.get('error', '')}")
    if run.get("profile_status") in ("llm_failed", "error"):
        problems.append(f"画像草稿生成失败：{run.get('profile_error') or 'AI 没有返回可用内容'}")
    if problems:
        await notify_user(user.id, "health", "Memento 夜间任务出错", "\n".join(problems)[:500], url="/profile?tab=health")


@celery_app.task(
    name="server.tasks.dreaming_tasks.run_nightly_dreaming",
    autoretry_for=(Exception,),
    max_retries=2,
    retry_backoff=True,
    retry_backoff_max=300,
    acks_late=True,
)
def run_nightly_dreaming(days_back: int = 1) -> dict[str, int]:
    """Execute nightly dreaming memory consolidation across all users."""
    logger.info("Starting nightly dreaming consolidation (days_back=%d)...", days_back)
    return asyncio.run(_run_all_users_dreaming(days_back=days_back))


async def run_user_backfill_async(
    user_id: str, chunk_days: int = 3, max_chunks: int = 30, mutex: Mutex | None = None,
) -> dict:
    """Execute backfill asynchronously for a single user, releasing `mutex` (BACKFILL_LOCK) at the end."""
    try:
        return await _run_user_backfill(user_id, chunk_days, max_chunks)
    finally:
        if mutex is not None:
            await cluster.flush()  # the final status is out before another backfill may start
            await mutex.release()


async def _run_user_backfill(user_id: str, chunk_days: int, max_chunks: int) -> dict:
    import uuid
    set_backfill_status(user_id, {
        "status": "running",
        "current": 0,
        "total": 0,
        "promoted_total": 0,
        "message": "正在初始化时间切片与历史活动探测...",
    })
    async with async_session_factory() as db:
        u_uuid = uuid.UUID(user_id) if isinstance(user_id, str) else user_id
        user = (await db.execute(select(User).where(User.id == u_uuid))).scalar_one_or_none()
        if not user:
            set_backfill_status(user_id, {"status": "error", "error": "User not found"})
            return {"error": "User not found"}

        def on_progress(p: dict):
            set_backfill_status(user_id, {
                "status": "running",
                "current": p.get("current", 0),
                "total": p.get("total", 0),
                "window": p.get("window", []),
                "window_status": p.get("status", ""),
                "promoted_total": p.get("promoted_total", 0),
            })

        try:
            result = await run_dreaming_backfill(
                db,
                user,
                chunk_days=chunk_days,
                max_chunks=max_chunks,
                progress_callback=on_progress,
            )
            set_backfill_status(user_id, {
                "status": "completed",
                "result": result,
            })
            return result
        except Exception as e:
            logger.error("Dreaming backfill failed for user %s: %s", user_id, e)
            set_backfill_status(user_id, {
                "status": "error",
                "error": str(e),
            })
            raise
