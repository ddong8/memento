"""Celery tasks: Memento learning from how the user works.

- every 10 min: corrections to confirm, todos said in passing
- nightly: review finished sessions (skills, pitfalls, todos), then tidy memory
  (merge duplicates, retire contradicted memories, let unused ones go dormant)
- 09:05: push todos due today or overdue
- weekly: score retrieval against the frozen question set, and measure whether
  the user has to correct the AI less (learning eval)
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from ..db.models import User
from ..db.session import async_session_factory
from ..services import ai_health
from ..services.correction_service import learn_from_corrections, summarize_new_topics
from ..services.eval_service import regression, recent_runs, run_eval
from ..services import learning_eval_service as learning_eval
from ..services.memory_lifecycle import reconcile, sweep_dormant
from ..config import settings
from ..services.notify_service import notify_user
from ..services.retrospective_service import learn_from_tasks, review_sessions
from ..services.todo_service import due_now, learn_todos, reminder_text
from .celery_app import celery_app

logger = logging.getLogger("learning_tasks")

PUSH_COOLDOWN = 3600  # one "learned something" push per hour at most


async def _users(db) -> list[User]:
    return list((await db.execute(select(User).where(User.status == "active"))).scalars().all())


async def _run() -> dict:
    async with async_session_factory() as db:
        users = await _users(db)
    totals = {"events": 0, "new_topics": 0}
    for user in users:
        async with async_session_factory() as db:
            try:
                result = await learn_from_corrections(db, user)
            except Exception as e:
                await db.rollback()
                logger.warning("Correction learning failed for user %s: %s", user.id, e)
                continue
            totals["events"] += result["events"]
            totals["new_topics"] += len(result["new_topics"])
            auto_accepted = result.get("auto_accepted") or []
            if auto_accepted and await ai_health.claim_alert(f"learned:auto:{user.id}", PUSH_COOLDOWN):
                await notify_user(
                    user.id, "learning", "Memento 已即时采纳新铁律",
                    summarize_new_topics(auto_accepted) + "。该规则已自动同步写入常驻画像，后续所有交互和终端已即时生效。",
                )
            elif result["new_topics"] and await ai_health.claim_alert(f"learned:{user.id}", PUSH_COOLDOWN):
                verb = "从最近 30 天里找到" if result["backfill"] else "刚学到"
                await notify_user(
                    user.id, "learning", f"Memento {verb}新的规矩",
                    summarize_new_topics(result["new_topics"]) + "。到「个人设置 → 常驻画像」确认后，各个 AI 工具下次同步就会用上。",
                )
    return totals


@celery_app.task(name="server.tasks.learning_tasks.learn_corrections", acks_late=True)
def learn_corrections() -> dict:
    try:
        return asyncio.run(_run())
    except Exception as e:
        logger.warning("learn_corrections errored: %s", e)
        return {"events": 0, "error": str(e)[:200]}


# ---- todos ----

async def _todos() -> dict:
    async with async_session_factory() as db:
        users = await _users(db)
    totals = {"created": 0, "closed": 0}
    for user in users:
        async with async_session_factory() as db:
            try:
                result = await learn_todos(db, user)
            except Exception as e:
                await db.rollback()
                logger.warning("Todo learning failed for user %s: %s", user.id, e)
                continue
            totals["created"] += len(result["created"])
            totals["closed"] += result["closed"]
    return totals


@celery_app.task(name="server.tasks.learning_tasks.learn_todos", acks_late=True)
def learn_todos_task() -> dict:
    try:
        return asyncio.run(_todos())
    except Exception as e:
        logger.warning("learn_todos errored: %s", e)
        return {"error": str(e)[:200]}


async def _remind() -> dict:
    sent = 0
    now = datetime.now(timezone.utc)
    async with async_session_factory() as db:
        users = await _users(db)
    for user in users:
        async with async_session_factory() as db:
            due = await due_now(db, user, now)
            text = reminder_text(due)
            todo_url = f"{settings.public_url.rstrip('/')}/daily" if settings.public_url else "/daily"
            if text and await notify_user(user.id, "todo", text[0], text[1] + "\n打开「日报待办」查看。", url=todo_url):
                sent += 1
                for todo in due["overdue"] + due["today"]:
                    todo.reminded_at = now
                await db.commit()
    return {"sent": sent}


@celery_app.task(name="server.tasks.learning_tasks.remind_todos", acks_late=True)
def remind_todos() -> dict:
    try:
        return asyncio.run(_remind())
    except Exception as e:
        logger.warning("remind_todos errored: %s", e)
        return {"error": str(e)[:200]}


# ---- nightly review ----

def _review_push(sessions: dict, tasks: dict) -> str | None:
    parts = []
    if sessions.get("skills_new"):
        parts.append(f"{len(sessions['skills_new'])} 个新技能待确认（{'、'.join(sessions['skills_new'][:3])}）")
    if sessions.get("skill_updates"):
        parts.append(f"{sessions['skill_updates']} 个技能有改进")
    pitfalls = sessions.get("pitfalls_new", 0) + tasks.get("pitfalls_new", 0)
    if pitfalls:
        parts.append(f"记下 {pitfalls} 个踩过的坑")
    if sessions.get("todos_new"):
        parts.append(f"{sessions['todos_new']} 条没做完的事进了待办")
    if not parts:
        return None
    return f"复盘了 {sessions.get('reviewed', 0)} 个会话：" + "；".join(parts) + "。"


async def _review() -> dict:
    out = {}
    async with async_session_factory() as db:
        users = await _users(db)
    for user in users:
        run: dict = {"at": datetime.now(timezone.utc).isoformat()}
        async with async_session_factory() as db:
            try:
                sessions = await review_sessions(db, user)
            except Exception as e:
                await db.rollback()
                logger.warning("Session reviews failed for user %s: %s", user.id, e)
                sessions = {"error": str(e)[:200]}
            try:
                tasks = await learn_from_tasks(db, user)
            except Exception as e:
                await db.rollback()
                logger.warning("Task outcome learning failed for user %s: %s", user.id, e)
                tasks = {"error": str(e)[:200]}
            run.update(sessions=sessions, tasks=tasks)
            await ai_health.put_json(f"review_run:{user.id}", run)
            text = _review_push(sessions, tasks)
            if text:
                review_url = f"{settings.public_url.rstrip('/')}/memory?tab=skills" if settings.public_url else "/memory?tab=skills"
                await notify_user(user.id, "learning", "Memento 昨晚的复盘", text + "到「记忆库 → 技能」确认。", url=review_url)
            out[str(user.id)] = run
    return out


@celery_app.task(
    name="server.tasks.learning_tasks.review_sessions",
    acks_late=True, time_limit=3000, soft_time_limit=2900,
)
def review_sessions_task() -> dict:
    try:
        return asyncio.run(_review())
    except Exception as e:
        logger.warning("review_sessions errored: %s", e)
        return {"error": str(e)[:200]}


# ---- memory upkeep ----

async def _lifecycle() -> dict:
    out = {}
    async with async_session_factory() as db:
        users = await _users(db)
    for user in users:
        cursor_key = f"reconcile_cursor:{user.id}"
        cursor = await ai_health.get_json(cursor_key)
        started = datetime.now(timezone.utc)
        since = datetime.fromisoformat(cursor) if cursor else None
        async with async_session_factory() as db:
            try:
                reconciled = await reconcile(db, user, since)
                await ai_health.put_json(cursor_key, started.isoformat(), ttl_seconds=90 * 24 * 3600)
            except Exception as e:
                await db.rollback()
                logger.warning("Memory reconcile failed for user %s: %s", user.id, e)
                reconciled = {"error": str(e)[:200]}
            try:
                dormant = await sweep_dormant(db, user)
            except Exception as e:
                await db.rollback()
                dormant = {"error": str(e)[:200]}
            run = {"at": started.isoformat(), "reconcile": reconciled, "dormant": dormant}
            await ai_health.put_json(f"lifecycle_run:{user.id}", run)
            out[str(user.id)] = run
    return out


@celery_app.task(
    name="server.tasks.learning_tasks.memory_lifecycle",
    acks_late=True, time_limit=1800, soft_time_limit=1700,
)
def memory_lifecycle_task() -> dict:
    try:
        return asyncio.run(_lifecycle())
    except Exception as e:
        logger.warning("memory_lifecycle errored: %s", e)
        return {"error": str(e)[:200]}


# ---- weekly evaluation ----

async def _evaluate() -> dict:
    out = {}
    async with async_session_factory() as db:
        for user in await _users(db):
            try:
                run = await run_eval(db, user, trigger="scheduled")
            except Exception as e:
                await db.rollback()
                logger.warning("Retrieval eval failed for user %s: %s", user.id, e)
                out[str(user.id)] = {"error": str(e)[:200]}
                continue
            out[str(user.id)] = {"set_version": run.set_version, "hybrid": (run.metrics or {}).get("hybrid")}
            drop = regression(await recent_runs(db, user, limit=6))
            if drop:
                change = (f"前 5 命中率从最好时的 {drop['was']:.0%} 降到 {drop['now']:.0%}" if drop["metric"] == "hit5"
                          else f"MRR 从最好时的 {drop['was']:.2f} 降到 {drop['now']:.2f}")
                await notify_user(
                    user.id, "health", "Memento 检索变差了",
                    f"评测集 v{drop['set_version']} {change}，到「系统健康」查看。",
                )
    return out


@celery_app.task(
    name="server.tasks.learning_tasks.evaluate_retrieval",
    acks_late=True, time_limit=1800, soft_time_limit=1700,
)
def evaluate_retrieval() -> dict:
    try:
        return asyncio.run(_evaluate())
    except Exception as e:
        logger.warning("evaluate_retrieval errored: %s", e)
        return {"error": str(e)[:200]}


async def _evaluate_learning() -> dict:
    out = {}
    async with async_session_factory() as db:
        users = await _users(db)
    for user in users:
        async with async_session_factory() as db:
            try:
                weeks = await learning_eval.run_learning_eval(db, user)
            except Exception as e:
                await db.rollback()
                logger.warning("Learning eval failed for user %s: %s", user.id, e)
                out[str(user.id)] = {"error": str(e)[:200]}
                continue
            drop = learning_eval.regression(await learning_eval.recent_weeks(db, user, limit=6))
            out[str(user.id)] = {"weeks": [str(w) for w in weeks], "regression": drop}
            if drop and await ai_health.claim_alert(f"learning_eval:{user.id}:{drop['week']}", 30 * 24 * 3600):
                await notify_user(
                    user.id, "health", "Memento 学过还犯变多了",
                    learning_eval.regression_text(drop) + "到「系统健康」看是哪些规矩。",
                )
    return out


@celery_app.task(
    name="server.tasks.learning_tasks.evaluate_learning",
    acks_late=True, time_limit=1800, soft_time_limit=1700,
)
def evaluate_learning() -> dict:
    try:
        return asyncio.run(_evaluate_learning())
    except Exception as e:
        logger.warning("evaluate_learning errored: %s", e)
        return {"error": str(e)[:200]}
