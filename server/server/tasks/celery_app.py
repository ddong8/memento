"""Celery application configuration."""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from ..config import settings

celery_app = Celery(
    "memento",
    broker=settings.redis_url,
    backend=settings.redis_url,
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
)

# Scheduled tasks
celery_app.conf.beat_schedule = {
    "daily-digest": {
        "task": "server.tasks.daily_digest.generate_daily_digest",
        "schedule": crontab(hour=23, minute=30),  # Run at 23:30 every day
    },
}
