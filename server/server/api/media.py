"""Media serving endpoints for S3-backed images and cached artifacts."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.enterprise_policy import sees_all
from ..services.storage_service import get_bytes, media_key, media_signature_ok

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
