"""演播台 (Studio) 视频归档、HTTP 206 Range 流播与发布到对话内联播放测试。"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlparse

from fastapi import HTTPException

from server.api.media import get_media_video
from server.api.studio import PublishToChatReq, publish_episode_to_chat
from server.services import storage_service as st


async def _collect_stream(resp) -> bytes:
    chunks = []
    async for chunk in resp.body_iterator:
        chunks.append(chunk if isinstance(chunk, bytes) else chunk.encode("utf-8"))
    return b"".join(chunks)


class TestStudioVideoAndChatPublish(unittest.IsolatedAsyncioTestCase):
    async def test_video_sign_and_markdown_resign(self):
        url = "/api/media/video/videos/u/user123/abcdef123456.mp4"
        signed = st.sign_video_url(url, now=1_700_000_000)
        parsed = urlparse(signed)
        qs = parse_qs(parsed.query)
        self.assertIn("exp", qs)
        self.assertIn("sig", qs)
        self.assertTrue(
            st.video_signature_ok(
                "videos/u/user123/abcdef123456.mp4",
                int(qs["exp"][0]),
                qs["sig"][0],
                now=1_700_000_100,
            )
        )
        # Re-signing inside markdown text replaces canonical video link with fresh signature
        md = f"已归档成片：\n\n![测试成片]({url})\n"
        resigned = st.sign_video_links_in_text(md, now=1_700_000_000)
        self.assertIn(signed, resigned)

        with self.assertRaises(ValueError):
            st.video_media_key("../etc/passwd")

    async def test_get_media_video_range_206_and_auth(self):
        payload = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ" * 400  # 14.4 KB fake mp4 bytes
        with tempfile.TemporaryDirectory() as tmpdir, \
             patch.object(st.settings, "studio_local_video_dir", tmpdir), \
             patch.object(st, "get_s3_client", return_value=None):
            canonical = await st.store_video_bytes("user-a", "ep01_final.mp4", payload, "video/mp4")
            self.assertTrue(canonical.startswith("/api/media/video/videos/u/user-a/"))

            signed = st.sign_video_url(canonical)
            parsed = urlparse(signed)
            qs = parse_qs(parsed.query)
            key = parsed.path[len("/api/media/video/"):]
            exp = int(qs["exp"][0])
            sig = qs["sig"][0]

            # 1) Full 200 streaming via signed URL
            resp_full = await get_media_video(
                key=key, exp=exp, sig=sig, range_header=None, authorization=None, db=AsyncMock()
            )
            self.assertEqual(resp_full.status_code, 200)
            self.assertEqual(resp_full.headers["accept-ranges"], "bytes")
            self.assertEqual(resp_full.headers["content-length"], str(len(payload)))
            self.assertEqual(await _collect_stream(resp_full), payload)

            # 2) Partial HTTP 206 Range request
            resp_part = await get_media_video(
                key=key, exp=exp, sig=sig, range_header="bytes=10-29", authorization=None, db=AsyncMock()
            )
            self.assertEqual(resp_part.status_code, 206)
            self.assertEqual(resp_part.headers["content-range"], f"bytes 10-29/{len(payload)}")
            self.assertEqual(resp_part.headers["content-length"], "20")
            self.assertEqual(await _collect_stream(resp_part), payload[10:30])

            # 3) Unsatisfiable Range returns 416
            resp_416 = await get_media_video(
                key=key, exp=exp, sig=sig, range_header="bytes=999999-1000000", authorization=None, db=AsyncMock()
            )
            self.assertEqual(resp_416.status_code, 416)

            # 4) Unsigned without Authorization returns 403
            with self.assertRaises(HTTPException) as ctx:
                await get_media_video(
                    key=key, exp=None, sig=None, range_header=None, authorization=None, db=AsyncMock()
                )
            self.assertEqual(ctx.exception.status_code, 403)

            # 5) Other user with Authorization denied (403)
            other_user = SimpleNamespace(id="user-b", role="viewer")
            with patch("server.api.media.get_current_user", AsyncMock(return_value=other_user)), \
                 patch("server.api.media.sees_all", return_value=False):
                with self.assertRaises(HTTPException) as ctx2:
                    await get_media_video(
                        key=key, exp=None, sig=None, range_header=None, authorization="Bearer tok", db=AsyncMock()
                    )
                self.assertEqual(ctx2.exception.status_code, 403)

    async def test_publish_episode_to_chat_archives_and_embeds_video_markdown(self):
        fake_mp4 = b"\x00\x00\x00\x18ftypmp42" + (b"A" * 8192)
        ep_detail = {
            "project": {"id": "p1", "name": "夜班守墓人七条铁律", "slug": "night_gravekeeper"},
            "episode": {"id": "ep1", "title": "第1集", "slug": "ep01", "last_task_id": ""},
            "shots": [{"duration": 8.0}, {"duration": 7.5}],
        }
        fake_user = SimpleNamespace(id=uuid.uuid4(), role="admin")
        target_conv_id = uuid.uuid4()

        class FakeResp:
            def __init__(self, status_code: int, content: bytes):
                self.status_code = status_code
                self.content = content

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def get(self, url, params=None, headers=None):
                if url.endswith("/api/studio/episodes/ep1/video"):
                    return FakeResp(200, fake_mp4)
                return FakeResp(404, b"")

        append_mock = AsyncMock()
        bust_mock = AsyncMock()
        get_conv_mock = AsyncMock(return_value=(target_conv_id, "演播台成片 · 《夜班守墓人七条铁律》第1集", {}))

        with tempfile.TemporaryDirectory() as tmpdir, \
             patch.object(st.settings, "studio_local_video_dir", tmpdir), \
             patch.object(st, "get_s3_client", return_value=None), \
             patch("server.api.studio._proxy_json", AsyncMock(return_value=ep_detail)), \
             patch("server.api.studio.httpx.AsyncClient", FakeAsyncClient), \
             patch("server.api.studio.get_or_create_conversation", get_conv_mock), \
             patch("server.api.studio.append_conversation_turns", append_mock), \
             patch("server.api.studio.bust_conv_list", bust_mock):
            res = await publish_episode_to_chat(
                "ep1",
                PublishToChatReq(note="发布 v4 母带"),
                user=fake_user,
                db=AsyncMock(),
            )

            self.assertTrue(res["ok"])
            self.assertEqual(res["conversation_id"], str(target_conv_id))
            self.assertEqual(res["size_bytes"], len(fake_mp4))
            self.assertIn("exp=", res["video_url"])
            self.assertIn("sig=", res["video_url"])

            # Verify markdown turn appended into conversation embeds inline video & studio link
            append_mock.assert_awaited_once()
            kwargs = append_mock.call_args.kwargs
            self.assertIn("![《夜班守墓人七条铁律》第1集](/api/media/video/videos/u/", kwargs["assistant_content"])
            self.assertIn("/studio?project=p1&episode=ep1", kwargs["assistant_content"])

            # Verify the archived video can actually be streamed back via HTTP 206
            parsed = urlparse(res["video_url"])
            qs = parse_qs(parsed.query)
            key = parsed.path[len("/api/media/video/"):]
            resp = await get_media_video(
                key=key,
                exp=int(qs["exp"][0]),
                sig=qs["sig"][0],
                range_header="bytes=0-15",
                authorization=None,
                db=AsyncMock(),
            )
            self.assertEqual(resp.status_code, 206)
            self.assertEqual(await _collect_stream(resp), fake_mp4[:16])
