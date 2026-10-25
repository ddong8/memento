"""Media serving endpoints for S3-backed images and cached artifacts."""

from __future__ import annotations

import logging
from fastapi import APIRouter, HTTPException, Response

from ..services.storage_service import get_bytes

router = APIRouter(prefix="/api/media", tags=["media"])
logger = logging.getLogger("server.media")


@router.get("/image/{key:path}")
async def get_media_image(key: str) -> Response:
    """Serve content-addressed images stored in MinIO / S3 with immutable caching."""
    clean_key = key.lstrip("/")
    if not clean_key.startswith("images/"):
        clean_key = f"images/{clean_key}"

    data, content_type = await get_bytes(clean_key)
    if not data:
        raise HTTPException(status_code=404, detail="Image not found")

    return Response(
        content=data,
        media_type=content_type or "image/jpeg",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "Access-Control-Allow-Origin": "*",
        },
    )
