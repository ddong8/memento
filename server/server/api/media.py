"""Media serving endpoints for S3-backed images and cached artifacts."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.enterprise_policy import sees_all
from ..services.storage_service import (
    get_bytes,
    head_video_object,
    media_key,
    media_signature_ok,
    read_video_range,
    video_media_key,
    video_signature_ok,
)

router = APIRouter(prefix="/api/media", tags=["media"])
logger = logging.getLogger("server.media")

_SAFE_RASTER_IMAGE_TYPES = frozenset({
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
    "image/bmp",
    "image/avif",
})

_SAFE_VIDEO_TYPES = frozenset({
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-m4v",
})

_VIDEO_CHUNK_SIZE = 1024 * 1024  # 1 MiB streaming chunks


def _parse_byte_range(range_header: str | None, total_size: int) -> tuple[int, int] | None:
    """Parse HTTP `Range: bytes=start-end` into inclusive (start, end). Returns None if invalid/absent."""
    if not range_header or not range_header.lower().startswith("bytes="):
        return None
    spec = range_header.split("=", 1)[1].split(",", 1)[0].strip()
    if "-" not in spec:
        return None
    s_raw, e_raw = spec.split("-", 1)
    try:
        if not s_raw and e_raw:
            suffix = int(e_raw)
            if suffix <= 0:
                return None
            start = max(0, total_size - suffix)
            end = total_size - 1
        else:
            start = int(s_raw)
            end = int(e_raw) if e_raw else total_size - 1
    except ValueError:
        return None
    if start < 0 or start >= total_size or end < start:
        return None
    return start, min(end, total_size - 1)


@router.get("/image/{key:path}")
async def get_media_image(
    key: str,
    exp: int | None = Query(None),
    sig: str | None = Query(None),
    authorization: str | None = Header(None),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Serve an image pasted into a conversation. Pages get these links signed with an expiry (the
    conversation and share APIs sign them); a signed-in request needs no signature."""
    try:
        normalized_key = media_key(key)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid image key")

    if not media_signature_ok(key, exp, sig):
        if not authorization:
            raise HTTPException(status_code=403, detail="Link expired or not signed")
        user = await get_current_user(authorization, db)
        # User-scoped keys (images/u/<user_id>/...) may only be read by their owner or sees_all admin
        parts = normalized_key.split("/")
        if len(parts) >= 4 and parts[1] == "u" and parts[2] != str(user.id) and not sees_all(user):
            raise HTTPException(status_code=403, detail="Image access denied")

    data, content_type = await get_bytes(normalized_key)
    if not data:
        raise HTTPException(status_code=404, detail="Image not found")

    resolved_type = (content_type or "image/jpeg").split(";", 1)[0].strip().lower()
    headers = {
        # Content-addressed, and the signed URL changes weekly
        "Cache-Control": "private, max-age=604800, immutable",
        "X-Content-Type-Options": "nosniff",
    }
    if resolved_type not in _SAFE_RASTER_IMAGE_TYPES:
        headers["Content-Security-Policy"] = "sandbox"
        resolved_type = "application/octet-stream"

    return Response(
        content=data,
        media_type=resolved_type,
        headers=headers,
    )


@router.get("/video/{key:path}")
async def get_media_video(
    key: str,
    exp: int | None = Query(None),
    sig: str | None = Query(None),
    range_header: str | None = Header(None, alias="Range"),
    authorization: str | None = Header(None),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Stream an archived studio MP4/WebM video with HTTP 206 Range support & signed/owner auth."""
    try:
        normalized_key = video_media_key(key)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid video key")

    if not video_signature_ok(key, exp, sig):
        if not authorization:
            raise HTTPException(status_code=403, detail="Video link expired or not signed")
        user = await get_current_user(authorization, db)
        parts = normalized_key.split("/")
        if len(parts) >= 4 and parts[1] == "u" and parts[2] != str(user.id) and not sees_all(user):
            raise HTTPException(status_code=403, detail="Video access denied")

    total_size, content_type = await head_video_object(normalized_key)
    if not total_size or total_size <= 0:
        raise HTTPException(status_code=404, detail="Video not found")

    resolved_type = (content_type or "video/mp4").split(";", 1)[0].strip().lower()
    if resolved_type not in _SAFE_VIDEO_TYPES:
        resolved_type = "video/mp4"

    base_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=604800, immutable",
        "X-Content-Type-Options": "nosniff",
    }

    parsed = _parse_byte_range(range_header, total_size)
    if range_header and parsed is None:
        return Response(
            status_code=416,
            headers={**base_headers, "Content-Range": f"bytes */{total_size}"},
        )

    if parsed is not None:
        start, end = parsed
        length = end - start + 1
        # Cap initial chunk to avoid slow huge single read if client sent open-ended `bytes=0-`
        # while still streaming sequentially to `end`.
        async def _iter_range():
            pos = start
            while pos <= end:
                chunk_end = min(end, pos + _VIDEO_CHUNK_SIZE - 1)
                data = await read_video_range(normalized_key, pos, chunk_end)
                if not data:
                    break
                yield data
                pos += len(data)

        return StreamingResponse(
            _iter_range(),
            status_code=206,
            media_type=resolved_type,
            headers={
                **base_headers,
                "Content-Range": f"bytes {start}-{end}/{total_size}",
                "Content-Length": str(length),
            },
        )

    async def _iter_all():
        pos = 0
        while pos < total_size:
            chunk_end = min(total_size - 1, pos + _VIDEO_CHUNK_SIZE - 1)
            data = await read_video_range(normalized_key, pos, chunk_end)
            if not data:
                break
            yield data
            pos += len(data)

    return StreamingResponse(
        _iter_all(),
        status_code=200,
        media_type=resolved_type,
        headers={
            **base_headers,
            "Content-Length": str(total_size),
        },
    )
