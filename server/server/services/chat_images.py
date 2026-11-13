"""Images the user pasted into a question, as the agent on the device sees them and the workbench shows them.

The prompt names each one as /tmp/memento_images/<conversation>/<name> and the device writes it there. Two things
made the workbench show the wrong picture or none:
- every question named its images image_1, image_2 …, and the page sends every paste as webp, so each question's
  first screenshot overwrote the one before (image_1.webp) on the device and on the server;
- the copies were temporary: the device drops them after a day, and the server kept its copy in the api pod's
  own /tmp (one replica's, gone at the next deploy).

So each question's images get a name of their own (image_<question>_<n>), for devices whose daemon writes the
name it is given (desktop 1.0.125 on), and the server keeps a copy in object storage under the same path, which
GET /api/devices/…/files/stream serves first for these paths.
"""

from __future__ import annotations

import re
import time
import uuid
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Machine
from .storage_service import get_bytes, upload_bytes
from .user_filter import normalize_device_name

# Desktop/daemon version from which the device writes payload["image_names"] (older ones write image_<n>)
NAMED_IMAGES_FROM = (1, 0, 125)

_PATH = re.compile(
    r"^(?:/tmp/memento_images|/data2/memento/images)/([A-Za-z0-9_-]{1,80})/(image_[A-Za-z0-9_]{1,40}\.(?:png|jpe?g|webp|gif|bmp|avif))$",
    re.IGNORECASE,
)
_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif", "bmp": "image/bmp", "avif": "image/avif"}


def _version(v: str | None) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:3])


async def device_names_images(db: AsyncSession, device_id: str | None) -> bool:
    """Whether the device's daemon writes the image names the server gives it (1.0.125 on)."""
    if not device_id or device_id in ("auto", "all", "ask_only"):
        return False
    base = normalize_device_name(device_id)
    try:
        rows = (
            await db.execute(
                select(Machine.collector_version).where(
                    or_(Machine.collector_token_hash == device_id, Machine.name == device_id, Machine.name == base, Machine.name.like(f"{base} (%"))
                )
            )
        ).scalars().all()
    except Exception:
        return False  # not known: the old names, which every daemon writes
    versions = [v for v in rows if v]
    return bool(versions) and all(_version(v) >= NAMED_IMAGES_FROM for v in versions)


def image_names(exts: list[str], unique: bool) -> list[str]:
    """The file names for one question's images: its own (image_<question>_<n>) or the old image_<n>."""
    if not unique:
        return [f"image_{i + 1}.{ext}" for i, ext in enumerate(exts)]
    tag = f"{int(time.time()):x}{uuid.uuid4().hex[:4]}"
    return [f"image_{tag}_{i + 1}.{ext}" for i, ext in enumerate(exts)]


def agent_path(conv_id: Any, name: str) -> str:
    return f"/tmp/memento_images/{conv_id}/{name}"


def storage_key(user_id: Any, path: str) -> str | None:
    """The object-storage key of a chat image path (/tmp/memento_images/<conv>/<name>), None for any other path."""
    m = _PATH.match(path or "")
    return f"chat-images/{user_id}/{m.group(1)}/{m.group(2).lower()}" if m else None


async def keep(user_id: Any, conv_id: Any, name: str, data: bytes) -> bool:
    key = storage_key(user_id, agent_path(conv_id, name))
    if not key:
        return False
    ext = name.rsplit(".", 1)[-1].lower()
    return await upload_bytes(key, data, content_type=_MIME.get(ext, "application/octet-stream")) is not None


async def load(user_id: Any, path: str) -> tuple[bytes, str] | None:
    """The kept copy of a chat image path for this user, or None."""
    key = storage_key(user_id, path)
    if not key:
        return None
    data, content_type = await get_bytes(key)
    if not data:
        return None
    ext = key.rsplit(".", 1)[-1]
    return data, (content_type if content_type.startswith("image/") else _MIME.get(ext, "application/octet-stream"))
