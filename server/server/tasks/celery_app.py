"""Celery application configuration."""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from ..config import settings

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
    # Every 15 min: reattempt documents whose embedding pipeline errored
    # (e.g. the host-side BGE-M3 server was briefly unreachable).
    "embedding-retry": {
        "task": "server.tasks.embedding_retry.retry_failed_embeddings",
        "schedule": crontab(minute="*/15"),
    },
}
