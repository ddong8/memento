"""Account-level export / import endpoints.

Two endpoints, both scoped to the caller's own data — no admin escape
hatch in v1.

  GET  /api/data/export?include_access_logs=false
  POST /api/data/import       multipart file=<.zip>

See server/services/{export,import}_service.py for the heavy lifting.

Concurrency + cap notes:

  * MAX_UPLOAD_BYTES (100 MiB default) gates the import body in TWO
    places: Content-Length header up front, AND a running counter while
    consuming the spool, so a lying header can't bypass it.
  * Per-user lock on both export and import, shared by every api replica
    (cluster.mutex, renewed while held). The export lock
    is held through the *entire* response lifecycle (download stream
    included), not just the build phase — otherwise a user could fire
    a second export the moment the first finishes building, doubling
    disk usage.
  * The import body is spooled to a temp file via
    `tempfile.SpooledTemporaryFile`, so a 100 MiB upload doesn't sit
    fully in process memory.
"""

from __future__ import annotations

import logging
import os
import tempfile

from fastapi import APIRouter, Depends, File, HTTPException, Header, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.export_service import ExportOptions, build_export
from ..services.import_service import (
    ImportError as ImportPackageError, run_import,
)
from ..services.cluster import cluster

logger = logging.getLogger("memento.data_io")

router = APIRouter(prefix="/api/data", tags=["data"])

MAX_UPLOAD_BYTES = int(os.environ.get("MEMENTO_IMPORT_MAX_UPLOAD_BYTES",
                                       str(100 * 1024 * 1024)))  # 100 MiB

# Per-user gates across api replicas (services/cluster.py): one import at a
# time, and one export so a user can't queue 10 parallel ~1 GB builds.
def _export_lock_name(uid: str) -> str:
    return f"export:{uid}"


def _import_lock_name(uid: str) -> str:
    return f"import:{uid}"


def _safe_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


@router.get("/export")
async def export_data(
    include_access_logs: bool = Query(False, description="Include audit log rows (PII: IP coarsened to /24 or /48)"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    """Stream a ZIP of all the caller's data.

    The per-user lock is held from acquisition through the *end of the
    response stream* — released by the FileResponse BackgroundTask
    alongside the temp-file unlink. This prevents an attacker from
    queueing parallel exports as soon as each build phase finishes.
    """
    lock = await cluster.mutex(_export_lock_name(str(user.id)))
    if lock is None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Another export is already running for this account",
        )

    try:
        opts = ExportOptions(include_access_logs=include_access_logs)
        try:
            result = await build_export(db, user, opts)
        except ValueError as e:
            raise HTTPException(status_code=413, detail=str(e)) from e
        except Exception:
            logger.exception("export build failed for user %s", str(user.id))
            raise HTTPException(status_code=500, detail="export failed; check server logs")
    except BaseException:
        # Build never produced a path → release lock and bail. The
        # success path keeps the lock for BackgroundTask cleanup.
        await lock.release()
        raise

    async def _cleanup() -> None:
        _safe_unlink(result.path)
        await lock.release()

    return FileResponse(
        result.path,
        media_type="application/zip",
        filename=result.filename,
        background=BackgroundTask(_cleanup),
        headers={
            # Disable nginx response buffering so the user sees download
            # progress immediately, not after nginx has spooled the
            # whole file.
            "X-Accel-Buffering": "no",
            # Row counts in a custom header so the UI can render
            # "exported 12,345 documents…" even though the ZIP body is
            # opaque to the browser.
            "X-Memento-Counts": ",".join(f"{k}={v}" for k, v in result.counts.items()),
        },
    )


@router.post("/import")
async def import_data(
    file: UploadFile = File(...),
    content_length: int | None = Header(default=None, alias="content-length"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Restore a Memento export ZIP into the caller's account.

    Each import creates a fresh synthetic Machine; re-importing the
    same ZIP creates a new Machine + new docs (delete the Machine to
    roll back).
    """
    # Pre-flight on Content-Length so we don't even start reading the
    # body when the client is uploading something hilariously large.
    if content_length is not None and content_length > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"upload exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB cap",
        )

    # Snapshot the ORM attribute now so the except-branch logger can't
    # trip MissingGreenlet on lazy-load after a rollback.
    user_id_str = str(user.id)

    lock = await cluster.mutex(_import_lock_name(user_id_str))
    if lock is None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Another import is already running for this account",
        )

    try:
        # Spool to disk past 8 MiB so the import isn't fully buffered
        # in process memory for a multi-hundred-MB upload. The spool
        # backs the zipfile.ZipFile reader directly.
        spool = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
        try:
            total = 0
            CHUNK = 1024 * 1024
            while True:
                chunk = await file.read(CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"upload exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB cap",
                    )
                spool.write(chunk)
            spool.seek(0)

            try:
                result = await run_import(db, user, spool)
                await db.commit()
            except ImportPackageError as e:
                await db.rollback()
                raise HTTPException(status_code=400, detail=str(e)) from e
            except Exception:
                await db.rollback()
                logger.exception("import failed for user %s", user_id_str)
                raise HTTPException(status_code=500, detail="import failed; check server logs")
        finally:
            try:
                spool.close()
            except Exception:
                pass
    finally:
        await lock.release()

    return {
        "ok": True,
        "machine_id": result.machine_id,
        "counts": result.counts,
        "warnings": result.warnings,
    }
