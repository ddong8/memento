"""Celery application configuration."""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab
from celery.signals import worker_process_init, task_prerun

from ..config import settings


def _dispose_engines() -> None:
    try:
        from ..db.session import engine, post_ingest_engine
        engine.sync_engine.dispose(close=False)  # type: ignore[attr-defined]
        post_ingest_engine.sync_engine.dispose(close=False)  # type: ignore[attr-defined]
    except Exception:
        pass


@task_prerun.connect
def _reset_engines_per_task(**_kwargs) -> None:
    """Each celery task runs `asyncio.run()` which creates a fresh event
    loop. SQLAlchemy async connections are bound to the loop they were
    created in — reusing them across tasks (same worker process, different
    loops) produces "got Future attached to a different loop" errors and
    every embedding/backup/summary call fails. Dispose before each task
    so the next acquire builds a connection in the current loop."""
    _dispose_engines()


@worker_process_init.connect
def _reset_engines_on_fork(**_kwargs) -> None:
    """When celery prefork spawns a child worker, the parent's SQLAlchemy
    engines (with live asyncpg sockets) are inherited via fork(2). Two
    children then race on the same TCP socket → asyncpg raises
    ``InterfaceError: cannot perform operation: another operation is in
    progress``. Standard fix: dispose with close=False so the child only
    drops pool records (parent's sockets stay alive for parent)."""
    _dispose_engines()

celery_app = Celery(
    "memento",
    broker=settings.redis_url,
    backend=settings.redis_url,
    # Explicit module list so workers register every task (our CLI is
    # `celery -A server.tasks.celery_app worker`, which only imports this
    # module — beat_schedule entries would otherwise fail with
    # "Received unregistered task").
    include=[
        "server.tasks.daily_digest",
        "server.tasks.summary_tasks",
        "server.tasks.embedding_retry",
        "server.tasks.knowledge_retry",
        "server.tasks.tsvector_backfill",
        "server.tasks.title_backfill",
        "server.tasks.db_backup",
        "server.tasks.dreaming_tasks",
        "server.tasks.health_check",
        "server.tasks.learning_tasks",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Shanghai",
    enable_utc=True,
    task_track_started=True,
    task_time_limit=600,  # 10 min max per task
    worker_max_tasks_per_child=100,
    # Reliability defaults so a crashed / SIGKILLed worker doesn't swallow
    # tasks silently. acks_late: ack only after success; reject_on_worker_lost:
    # if worker dies mid-task, Redis requeues it to another worker.
    task_acks_late=True,
    task_reject_on_worker_lost=True,
)

# Scheduled tasks
celery_app.conf.beat_schedule = {
    "daily-digest": {
        "task": "server.tasks.daily_digest.generate_daily_digest",
        "schedule": crontab(hour=23, minute=30),  # Run at 23:30 every day
    },
    # Same task at 03:30 the NEXT day — passes no date_str so it
    # regenerates "today" which is yesterday at this time, picking up
    # any messages that synced across midnight. The digest task now
    # UPSERTs, so this safely overwrites the 23:30 bake.
    "daily-digest-late": {
        "task": "server.tasks.daily_digest.generate_daily_digest",
        "schedule": crontab(hour=3, minute=30),
        # offset_days=-1 → "yesterday" relative to wallclock at 03:30,
        # i.e. re-bake the day that just ended.
        "kwargs": {"offset_days": -1},
    },
    # Daily 03:00 — Nightly dreaming memory consolidation (Light -> REM -> Deep -> MEMORY.md)
    "nightly-dreaming": {
        "task": "server.tasks.dreaming_tasks.run_nightly_dreaming",
        "schedule": crontab(hour=3, minute=0),
        "kwargs": {"days_back": 1},
    },
    # Every minute: embed documents that changed and went quiet, retry failures with backoff.
    "embedding-retry": {
        "task": "server.tasks.embedding_retry.retry_failed_embeddings",
        "schedule": crontab(minute="*"),
    },
    # Same cadence (offset by 2 min so the two retry beats don't hammer
    # the DB / LLM provider at the same instant). Picks up docs whose
    # knowledge-graph extract failed at ingest time — typically because
    # the LLM provider was rate-limited or the API key expired.
    "knowledge-retry": {
        "task": "server.tasks.knowledge_retry.retry_failed_knowledge",
        "schedule": crontab(minute="2,17,32,47"),
    },
    # Sundays 03:30 — table data via COPY | gzip → s3://memento-backups/weekly/<date>.csv.gz,
    # 8 weeks kept. Defends against the kind of incident that wiped pgdata
    # (volume nuke, install --purge, etc.).
    "weekly-db-backup": {
        "task": "server.tasks.db_backup.run_weekly_backup",
        "schedule": crontab(hour=3, minute=30, day_of_week="sun"),
    },
    # Hourly at :07 — re-derive real titles for docs still carrying junk
    # worker-ID titles (agent-*, wf_*, UUIDs, compaction preamble). Only
    # scans junk-titled rows and only writes on improvement, so once the
    # backlog is drained each run is a cheap near-no-op that just catches
    # any newly-arrived junk the ingest healer couldn't resolve.
    "title-backfill": {
        "task": "server.tasks.title_backfill.backfill_titles",
        "schedule": crontab(minute=7),
    },
    # Every 30 min — push to the phone if AI calls failed a lot in the last hour
    # (at most once per 6 h). Background jobs fail quietly otherwise.
    "health-check": {
        "task": "server.tasks.health_check.check_health",
        "schedule": crontab(minute="5,35"),
    },
    # Every 10 min — turn the user's fresh corrections into topics to confirm,
    # and log each one for the repeat-correction rate on the health page.
    "learn-corrections": {
        "task": "server.tasks.learning_tasks.learn_corrections",
        "schedule": crontab(minute="*/10"),
    },
    # Every 10 min, offset from corrections — "later" talk becomes todos, "done" talk closes them.
    "learn-todos": {
        "task": "server.tasks.learning_tasks.learn_todos",
        "schedule": crontab(minute="4,14,24,34,44,54"),
    },
    # 02:20 — review sessions that finished (skills, pitfalls, todos) before 03:00 dreaming.
    "review-sessions": {
        "task": "server.tasks.learning_tasks.review_sessions",
        "schedule": crontab(hour=2, minute=20),
    },
    # 04:10 — after dreaming: merge duplicate memories, retire contradicted ones, let unused ones sleep.
    "memory-lifecycle": {
        "task": "server.tasks.learning_tasks.memory_lifecycle",
        "schedule": crontab(hour=4, minute=10),
    },
    # 09:05 — push todos due today or overdue.
    "remind-todos": {
        "task": "server.tasks.learning_tasks.remind_todos",
        "schedule": crontab(hour=9, minute=5),
    },
    # Daily 04:25 — full-text index for any document still without one. Commits per
    # batch, so a big backlog is worked off over a few nights; a no-op once caught up.
    "tsvector-backfill": {
        "task": "server.tasks.tsvector_backfill.backfill_content_tsv",
        "schedule": crontab(hour=4, minute=25),
    },
    # Monday 04:40 — score retrieval against the frozen question set.
    "evaluate-retrieval": {
        "task": "server.tasks.learning_tasks.evaluate_retrieval",
        "schedule": crontab(hour=4, minute=40, day_of_week=1),
    },
}
