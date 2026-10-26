"""Media serving endpoints for S3-backed images and cached artifacts."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.storage_service import get_bytes, media_key, media_signature_ok

router = APIRouter(prefix="/api/media", tags=["media"])
logger = logging.getLogger("server.media")


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
    if not media_signature_ok(key, exp, sig):
        if not authorization:
            raise HTTPException(status_code=403, detail="Link expired or not signed")
        await get_current_user(authorization, db)

    data, content_type = await get_bytes(media_key(key))
    if not data:
        raise HTTPException(status_code=404, detail="Image not found")

    return Response(
        content=data,
        media_type=content_type or "image/jpeg",
        headers={
            # Content-addressed, and the signed URL changes weekly
            "Cache-Control": "private, max-age=604800, immutable",
            "Access-Control-Allow-Origin": "*",
        },
    )
