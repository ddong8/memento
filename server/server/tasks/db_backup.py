"""Daily database snapshot → MinIO. Defends against the volume-nuke
incident (5/5: pgdata wiped, all conversations / users / projects lost
because nothing was backed up).

Implementation note: doesn't shell out to pg_dump (would need matching
client major version inside the worker image, see Dockerfile history).
Instead streams data table-by-table via COPY ... TO STDOUT,
gzips, uploads to MinIO. Schema is rebuilt by ``_run_migrations`` on
restore — we only need the data.
"""

from __future__ import annotations

import asyncio
import gzip
import io
import logging
import re
from datetime import datetime, timezone, timedelta

import asyncpg
import boto3
from botocore.client import Config

from ..config import settings
from .celery_app import celery_app

logger = logging.getLogger("db_backup")

BACKUP_BUCKET = "memento-backups"
RETENTION_DAYS = 14

# Tables to back up, in load order (FK-safe). Append new tables here as
# the schema grows.
TABLES = [
    "users",
    "invite_codes",
    "machines",
    "tools",
    "projects",
    "documents",
    "document_versions",
    "document_embeddings",
    "conversation_messages",
    "knowledge_entities",
    "knowledge_relations",
    "knowledge_observations",
    "permissions",
    "access_logs",
    "share_links",
    "share_views",
    "daily_summaries",
    "sync_state",
]


def _libpq_url() -> str:
    return settings.database_url.replace("postgresql+asyncpg://", "postgresql://", 1)


async def _dump_async(buf: io.BytesIO) -> dict:
    """Stream every table out via COPY ... TO STDOUT (binary), gzip into buf.
    Returns per-table row counts for the manifest.
    """
    counts: dict = {}
    conn = await asyncpg.connect(_libpq_url())
    try:
        gz = gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6)
        try:
            for table in TABLES:
                # Validate table name (defensive — TABLES is a static allow-list,
                # but never compose SQL with raw identifiers).
                if not re.match(r"^[a-z_][a-z0-9_]*$", table):
                    raise ValueError(f"unsafe table name: {table}")
                row = await conn.fetchrow(f"SELECT COUNT(*) AS n FROM {table}")
                counts[table] = int(row["n"]) if row else 0

                header = f"\n-- TABLE: {table} ({counts[table]} rows)\n".encode()
                gz.write(header)
                # COPY (SELECT * FROM tbl) TO STDOUT — works for any row count
                await conn.copy_from_query(
                    f"SELECT * FROM {table}",
                    output=gz,
                    format="csv",
                    header=True,
                )
        finally:
            gz.close()
    finally:
        await conn.close()
    return counts


@celery_app.task(name="server.tasks.db_backup.run_daily_backup")
def run_daily_backup() -> dict:
    """Celery entry point. Runs an event loop because asyncpg is async-only."""
    return asyncio.run(_run_backup())


async def _run_backup() -> dict:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    key = f"daily/{today}.csv.gz"

    buf = io.BytesIO()
    counts = await _dump_async(buf)
    size = buf.tell()
    buf.seek(0)
    logger.info("Backup built in memory: %d bytes, %d tables", size, len(counts))

    s3 = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )
    try:
        s3.head_bucket(Bucket=BACKUP_BUCKET)
    except Exception:
        s3.create_bucket(Bucket=BACKUP_BUCKET)
    s3.put_object(Bucket=BACKUP_BUCKET, Key=key, Body=buf.getvalue())
    logger.info("Uploaded s3://%s/%s (%d bytes)", BACKUP_BUCKET, key, size)

    # Prune older than RETENTION_DAYS
    try:
        cutoff = (datetime.now(timezone.utc).date() - timedelta(days=RETENTION_DAYS))
        resp = s3.list_objects_v2(Bucket=BACKUP_BUCKET, Prefix="daily/")
        deleted = 0
        for obj in resp.get("Contents") or []:
            stem = obj["Key"].split("/")[-1].split(".")[0]
            try:
                obj_date = datetime.strptime(stem, "%Y-%m-%d").date()
            except ValueError:
                continue
            if obj_date < cutoff:
                s3.delete_object(Bucket=BACKUP_BUCKET, Key=obj["Key"])
                deleted += 1
        if deleted:
            logger.info("Pruned %d old backups (>%dd)", deleted, RETENTION_DAYS)
    except Exception as e:
        logger.warning("Prune step failed (non-fatal): %s", e)

    return {"ok": True, "key": key, "size_bytes": size, "row_counts": counts}
