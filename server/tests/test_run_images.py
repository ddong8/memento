"""A run's summary carries links to the pasted images, not the images.

/run, /runs and the iOS live activity poll the summary every few seconds, and every mirror
write to Redis re-serialises it. With the pasted base64 inside, a single phone photo made each
/run poll 225 KB and each /runs list ~40 KB (2026-10-28, mem.ihasy.com access log).
"""

import asyncio
import base64
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from server.services import ask_stream, storage_service
from server.services.ask_runs import AskRun

PASTED = "data:image/png;base64," + base64.b64encode(b"\x89PNG not really").decode()


async def _start_with(images, **patches):
    seen: dict = {}

    async def start(*a, **k):
        seen["images"] = k.get("images")
        return MagicMock(stream=lambda after: iter(()))

    with patch.object(ask_stream.ask_runs, "start", side_effect=start):
        await ask_stream.run_response("c", MagicMock(id=1), "q", None, lambda *_: None, images=images)
    return seen["images"]


@pytest.mark.asyncio
async def test_run_starts_with_stored_image_links():
    upload = AsyncMock(side_effect=lambda key, data, content_type: key)
    with patch.object(storage_service, "upload_bytes", upload):
        images = await _start_with([PASTED])

    assert len(images) == 1 and images[0].startswith("/api/media/image/images/")
    assert images[0].endswith(".png")
    upload.assert_awaited_once()


@pytest.mark.asyncio
async def test_run_keeps_the_pasted_image_when_storage_is_down():
    with patch.object(storage_service, "upload_bytes", AsyncMock(return_value=None)):
        assert await _start_with([PASTED]) == [PASTED]


@pytest.mark.asyncio
async def test_run_keeps_the_pasted_image_when_storing_hangs():
    with patch.object(ask_stream, "store_images", AsyncMock(side_effect=asyncio.TimeoutError)):
        assert await _start_with([PASTED]) == [PASTED]


@pytest.mark.asyncio
async def test_run_without_images_stores_nothing():
    with patch.object(ask_stream, "store_images", AsyncMock()) as store:
        assert await _start_with(None) is None
    store.assert_not_awaited()


def test_summary_hands_out_signed_links():
    run = AskRun("c", uuid.uuid4(), "q", None, images=["/api/media/image/images/ab/abc.jpg", PASTED])
    link, inline = run.summary()["images"]

    assert link.startswith("/api/media/image/images/ab/abc.jpg?exp=") and "&sig=" in link
    assert inline == PASTED
