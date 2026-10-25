"""S3 / MinIO object storage service for large documents, transcripts, and media."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from ..config import settings

logger = logging.getLogger("server.storage")

_s3_client: Any | None = None
_bucket_ensured: bool = False


def get_s3_client() -> Any:
    global _s3_client
    if _s3_client is not None:
        return _s3_client
    try:
        _s3_client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            config=Config(signature_version="s3v4", connect_timeout=5, read_timeout=15),
        )
    except Exception as e:
        logger.warning("Failed to initialize S3 client: %s", e)
        _s3_client = None
    return _s3_client


async def ensure_bucket() -> bool:
    global _bucket_ensured
    if _bucket_ensured:
        return True
    s3 = get_s3_client()
    if s3 is None:
        return False

    def _sync_ensure():
        try:
            s3.head_bucket(Bucket=settings.s3_bucket)
            return True
        except ClientError:
            try:
                s3.create_bucket(Bucket=settings.s3_bucket)
                return True
            except Exception as e:
                logger.warning("Could not create S3 bucket %s: %s", settings.s3_bucket, e)
                return False
        except Exception as e:
            logger.warning("S3 head_bucket failed: %s", e)
            return False

    ok = await asyncio.to_thread(_sync_ensure)
    if ok:
        _bucket_ensured = True
    return ok


async def upload_text(key: str, text: str, content_type: str = "text/plain; charset=utf-8") -> str | None:
    """Upload UTF-8 text string to S3, returns the S3 key on success, None on error."""
    raw = text.encode("utf-8")
    return await upload_bytes(key, raw, content_type=content_type)


async def upload_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> str | None:
    """Upload raw bytes to S3, returns key on success, None on error."""
    s3 = get_s3_client()
    if s3 is None:
        return None
    await ensure_bucket()

    def _put():
        s3.put_object(
            Bucket=settings.s3_bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
        )
        return key

    try:
        return await asyncio.to_thread(_put)
    except Exception as e:
        logger.warning("S3 upload failed for key %s: %s", key, e)
        return None


async def get_bytes(key: str) -> tuple[bytes | None, str]:
    """Retrieve raw bytes and content-type from S3."""
    s3 = get_s3_client()
    if s3 is None:
        return None, ""

    def _get():
        resp = s3.get_object(Bucket=settings.s3_bucket, Key=key)
        content_type = resp.get("ContentType", "application/octet-stream")
        data = resp["Body"].read()
        return data, content_type

    try:
        return await asyncio.to_thread(_get)
    except Exception as e:
        logger.debug("S3 get_object failed for key %s: %s", key, e)
        return None, ""


async def get_text(key: str) -> str | None:
    """Retrieve UTF-8 text from S3."""
    data, _ = await get_bytes(key)
    if data is None:
        return None
    return data.decode("utf-8", errors="replace")


async def store_image_b64(data_uri: str) -> str:
    """Store base64 image data URI into S3 and return a lightweight URL.

    If S3 upload fails or image format is invalid, safely returns original data_uri.
    """
    if not isinstance(data_uri, str) or not data_uri.startswith("data:image"):
        return data_uri

    try:
        header, b64_part = data_uri.split(",", 1)
        raw_bytes = base64.b64decode(b64_part)
        ext = "jpg"
        content_type = "image/jpeg"
        if "png" in header:
            ext = "png"
            content_type = "image/png"
        elif "webp" in header:
            ext = "webp"
            content_type = "image/webp"
        elif "gif" in header:
            ext = "gif"
            content_type = "image/gif"

        h = hashlib.sha256(raw_bytes).hexdigest()
        key = f"images/{h[:2]}/{h}.{ext}"
        s3_key = await upload_bytes(key, raw_bytes, content_type=content_type)
        if s3_key:
            return f"/api/media/image/{key}"
    except Exception as e:
        logger.warning("Failed to store image in S3: %s", e)

    return data_uri
