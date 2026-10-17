"""Weekly database snapshot → MinIO. Defends against the volume-nuke
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
import logging
import re
import tempfile
from datetime import datetime, timezone, timedelta
from typing import BinaryIO

import asyncpg
import boto3
from botocore.client import Config

from ..config import settings
from .celery_app import celery_app

logger = logging.getLogger("db_backup")

BACKUP_BUCKET = "memento-backups"
RETENTION_DAYS = 56  # 8 weekly snapshots

_SAFE_NAME = re.compile(r"^[a-z_][a-z0-9_]*$")


def load_order(tables: list[str], deps: list[tuple[str, str]]) -> list[str]:
    """Every table, parents before the tables whose foreign keys point at them,
    so a restore can load the dump top to bottom. deps holds (child, parent)
    pairs; self references are ignored and any cycle is appended by name."""
    parents: dict[str, set[str]] = {t: set() for t in tables}
    for child, parent in deps:
        if child in parents and parent in parents and child != parent:
            parents[child].add(parent)
    order: list[str] = []
    ready = sorted(t for t, ps in parents.items() if not ps)
    while ready:
        table = ready.pop(0)
        order.append(table)
        for t, ps in parents.items():
            if table in ps:
                ps.discard(table)
                if not ps and t not in order and t not in ready:
                    ready.append(t)
        ready.sort()
    return order + sorted(t for t in tables if t not in order)


async def _tables(conn: asyncpg.Connection) -> list[str]:
    """All tables in the public schema (new ones are picked up automatically)."""
    names = [r["relname"] for r in await conn.fetch(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'public' AND c.relkind = 'r'"
    )]
    deps = [(r["child"], r["parent"]) for r in await conn.fetch(
        "SELECT ch.relname AS child, pa.relname AS parent FROM pg_constraint k "
        "JOIN pg_class ch ON ch.oid = k.conrelid JOIN pg_class pa ON pa.oid = k.confrelid "
        "JOIN pg_namespace n ON n.oid = ch.relnamespace "
        "WHERE k.contype = 'f' AND n.nspname = 'public'"
    )]
    return load_order(names, deps)


def _libpq_url() -> str:
    return settings.database_url.replace("postgresql+asyncpg://", "postgresql://", 1)


async def _dump_async(out: BinaryIO, dsn: str | None = None) -> dict:
    """Stream every table out via COPY ... TO STDOUT (csv), gzip into out.
    Returns per-table row counts, in load order, for the manifest.
    """
    counts: dict = {}
    conn = await asyncpg.connect(dsn or _libpq_url())
    try:
        gz = gzip.GzipFile(fileobj=out, mode="wb", compresslevel=6)
        try:
            for table in await _tables(conn):
                # Names come from the catalog, but never compose SQL with an
                # identifier we haven't checked.
                if not _SAFE_NAME.match(table):
                    logger.warning("Skipping table with an unexpected name: %r", table)
                    continue
                row = await conn.fetchrow(f'SELECT COUNT(*) AS n FROM "{table}"')
                counts[table] = int(row["n"]) if row else 0

                header = f"\n-- TABLE: {table} ({counts[table]} rows)\n".encode()
                gz.write(header)
                # COPY (SELECT * FROM tbl) TO STDOUT — works for any row count
                await conn.copy_from_query(
                    f'SELECT * FROM "{table}"',
                    output=gz,
                    format="csv",
                    header=True,
                )
        finally:
            gz.close()
    finally:
        await conn.close()
    return counts


@celery_app.task(name="server.tasks.db_backup.run_weekly_backup")
def run_weekly_backup() -> dict:
    """Celery entry point. Runs an event loop because asyncpg is async-only."""
    return asyncio.run(_run_backup())


async def _run_backup() -> dict:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    key = f"weekly/{today}.csv.gz"

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

    # Spool to disk and upload in parts: the dump is over a gigabyte, and
    # holding it (plus a copy for the upload) in memory OOM-kills the worker.
    with tempfile.TemporaryFile() as f:
        counts = await _dump_async(f)
        size = f.tell()
        f.seek(0)
        logger.info("Backup built: %d bytes, %d tables", size, len(counts))
        s3.upload_fileobj(f, BACKUP_BUCKET, key)
    logger.info("Uploaded s3://%s/%s (%d bytes)", BACKUP_BUCKET, key, size)

    # Prune older than RETENTION_DAYS (daily/ holds the snapshots from before the weekly schedule)
    try:
        cutoff = (datetime.now(timezone.utc).date() - timedelta(days=RETENTION_DAYS))
        objects = []
        for prefix in ("weekly/", "daily/"):
            objects += s3.list_objects_v2(Bucket=BACKUP_BUCKET, Prefix=prefix).get("Contents") or []
        deleted = 0
        for obj in objects:
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
