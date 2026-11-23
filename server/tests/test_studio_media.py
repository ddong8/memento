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
from server.api.studio import (
    PublishToChatReq,
    _public_asset_headers,
    batch_upscale_episode,
    confirm_episode_story,
    dispatch_publish_job,
    download_publish_bundle,
    episode_stream_status,
    publish_agent_claim,
    publish_agent_heartbeat,
    publish_agent_report,
    _require_media_user,
    get_publish_platforms,
    proxy_episode_latest_video,
    proxy_task_video,
    publish_episode_to_chat,
)
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

    async def test_studio_video_proxy_sets_cache_control_and_etag(self):
        fake_mp4 = b"\x00\x00\x00\x18ftypmp42" + (b"B" * 256)
        ep_detail = {
            "project": {"id": "p1", "slug": "proj"},
            "episode": {"id": "ep1", "slug": "ep01", "last_task_id": "task_42"},
        }
        fake_user = SimpleNamespace(id=uuid.uuid4(), role="admin")

        class FakeStreamResp:
            status_code = 200
            headers = {
                "content-type": "video/mp4",
                "content-length": str(len(fake_mp4)),
                "accept-ranges": "bytes",
            }

            async def aiter_bytes(self, chunk_size=65536):
                yield fake_mp4

            async def aclose(self):
                pass

        class FakeStreamClient:
            def __init__(self, *args, **kwargs):
                pass

            def build_request(self, method, url, params=None, headers=None):
                return (method, url)

            async def send(self, req, stream=False):
                return FakeStreamResp()

            async def aclose(self):
                pass

        with patch("server.api.studio._proxy_json", AsyncMock(return_value=ep_detail)), \
             patch("server.api.studio.httpx.AsyncClient", FakeStreamClient):
            resp_versioned = await proxy_episode_latest_video(
                eid="ep1", v="task_42", range_header=None, _user=fake_user
            )
            self.assertEqual(resp_versioned.headers["cache-control"], "private, max-age=604800, immutable")
            self.assertEqual(resp_versioned.headers["etag"], '"studio-ep-ep1-task_42"')
            self.assertEqual(await _collect_stream(resp_versioned), fake_mp4)

            resp_unversioned = await proxy_episode_latest_video(
                eid="ep1", v=None, range_header=None, _user=fake_user
            )
            self.assertEqual(resp_unversioned.headers["cache-control"], "private, max-age=3600")
            self.assertEqual(await _collect_stream(resp_unversioned), fake_mp4)

            resp_task = await proxy_task_video(task_id="task_42", range_header=None, _user=fake_user)
            self.assertEqual(resp_task.headers["cache-control"], "private, max-age=604800, immutable")
            self.assertEqual(resp_task.headers["etag"], '"studio-task-task_42"')
            self.assertEqual(await _collect_stream(resp_task), fake_mp4)

    async def test_publish_center_proxy_headers_and_zip_streaming(self):
        fake_user = SimpleNamespace(id=uuid.uuid4(), role="admin")

        class FakeRequest:
            def __init__(self, body_bytes: bytes = b"{}", headers: dict[str, str] | None = None):
                self._body = body_bytes
                self.headers = headers or {
                    "host": "mem.ihasy.com",
                    "x-forwarded-proto": "https",
                    "authorization": "Bearer jwt_test_token",
                }
                self.url = SimpleNamespace(scheme="https")

            async def body(self):
                return self._body

            async def json(self):
                import json as _json
                return _json.loads(self._body.decode("utf-8"))

        req = FakeRequest(b'{"force": true}')
        with patch("server.api.studio.settings.public_url", "https://mem.ihasy.com"):
            hdrs = _public_asset_headers(req)
            self.assertEqual(hdrs["X-Public-Asset-Base"], "https://mem.ihasy.com/api/studio/assets")
            self.assertEqual(hdrs["X-Public-Asset-Auth"], "Bearer jwt_test_token")

            proxy_mock = AsyncMock(return_value={"job": {"id": "pub_1", "status": "queued"}})
            with patch("server.api.studio._proxy_json", proxy_mock):
                res = await dispatch_publish_job("pub_1", req, _user=fake_user)
                self.assertEqual(res["job"]["status"], "queued")
                proxy_mock.assert_awaited_once()
                call_kwargs = proxy_mock.call_args.kwargs
                self.assertEqual(
                    call_kwargs["extra_headers"]["X-Public-Asset-Base"],
                    "https://mem.ihasy.com/api/studio/assets",
                )
                self.assertEqual(call_kwargs["extra_headers"]["X-Public-Asset-Auth"], "Bearer jwt_test_token")

                await get_publish_platforms(_user=fake_user)
                await confirm_episode_story("ep_1", FakeRequest(b'{"confirmed": true}'), _user=fake_user)
                await batch_upscale_episode("ep_1", FakeRequest(b"{}"), _user=fake_user)

        fake_zip = b"PK\x03\x04fake-publish-bundle-zip"

        class FakeZipResp:
            status_code = 200
            headers = {
                "content-type": "application/zip",
                "content-length": str(len(fake_zip)),
                "content-disposition": 'attachment; filename="ep_1_publish_bundle.zip"',
            }

            async def aiter_bytes(self, chunk_size=65536):
                yield fake_zip

            async def aclose(self):
                pass

        class FakeZipClient:
            def __init__(self, *args, **kwargs):
                pass

            def build_request(self, method, url, headers=None):
                return (method, url)

            async def send(self, req_obj, stream=False):
                return FakeZipResp()

            async def aclose(self):
                pass

        with patch("server.api.studio.httpx.AsyncClient", FakeZipClient):
            zip_resp = await download_publish_bundle("ep_1", _user=fake_user)
            self.assertEqual(zip_resp.status_code, 200)
            self.assertEqual(zip_resp.media_type, "application/zip")
            self.assertIn("ep_1_publish_bundle.zip", zip_resp.headers["content-disposition"])
            self.assertEqual(await _collect_stream(zip_resp), fake_zip)


class TestStudioStreamCopyAndPullAgent(unittest.IsolatedAsyncioTestCase):
    async def test_stream_quality_tries_online_copy_first_with_own_etag(self):
        ep_detail = {"project": {"id": "p1", "slug": "proj"}, "episode": {"id": "ep1", "slug": "ep01", "last_task_id": "t1"}}
        fake_user = SimpleNamespace(id=uuid.uuid4(), role="admin")
        asked: list[str] = []

        class Resp:
            def __init__(self, code):
                self.status_code = code
                self.headers = {"content-type": "video/mp4", "content-length": "4"}

            async def aiter_bytes(self, chunk_size=65536):
                yield b"mp4!"

            async def aclose(self):
                pass

        class Client:
            def __init__(self, *a, **k):
                pass

            def build_request(self, method, url, params=None, headers=None):
                return url

            async def send(self, url, stream=False):
                asked.append(url)
                return Resp(200 if url.endswith("/stream-video") and ready else 200 if not url.endswith("/stream-video") else 404)

            async def aclose(self):
                pass

        with patch("server.api.studio._proxy_json", AsyncMock(return_value=ep_detail)), \
             patch("server.api.studio.httpx.AsyncClient", Client):
            ready = True
            resp = await proxy_episode_latest_video(eid="ep1", v="t1", quality="stream", range_header=None, _user=fake_user)
            self.assertTrue(asked[0].endswith("/api/studio/episodes/ep1/stream-video"))
            self.assertEqual(resp.headers["etag"], '"studio-ep-ep1-t1-stream"')
            asked.clear()
            ready = False  # 还没压好：回落到原片
            resp = await proxy_episode_latest_video(eid="ep1", v="t1", quality="stream", range_header=None, _user=fake_user)
            self.assertTrue(asked[1].endswith("/api/tasks/t1/video"), asked)
            self.assertEqual(resp.headers["etag"], '"studio-ep-ep1-t1"')
            asked.clear()
            await proxy_episode_latest_video(eid="ep1", v="t1", quality=None, range_header=None, _user=fake_user)
            self.assertFalse(any(u.endswith("/stream-video") for u in asked))

    async def test_stream_status_treats_missing_as_not_ready(self):
        fake_user = SimpleNamespace(id=uuid.uuid4(), role="admin")
        with patch("server.api.studio._proxy_json", AsyncMock(side_effect=HTTPException(404, "x"))):
            self.assertEqual(await episode_stream_status("ep1", _user=fake_user), {"ready": False, "variant": ""})
        with patch("server.api.studio._proxy_json", AsyncMock(return_value={"ready": True, "variant": "stream"})) as m:
            self.assertTrue((await episode_stream_status("ep1", _user=fake_user))["ready"])
            self.assertEqual(m.call_args.kwargs["params"], {"check": "true"})

    async def test_pull_agent_endpoints_forward_to_filmkit(self):
        fake_user = SimpleNamespace(id=uuid.uuid4(), role="admin")

        class Req:
            def __init__(self, body: bytes):
                self._b = body

            async def body(self):
                return self._b

            async def json(self):
                import json as _json
                return _json.loads(self._b)

        m = AsyncMock(return_value={"ok": True})
        with patch("server.api.studio._proxy_json", m):
            await publish_agent_heartbeat(Req(b'{"agent_id": "mac"}'), _user=fake_user)
            await publish_agent_claim(Req(b'{"agent_id": "mac"}'), _user=fake_user)
            await publish_agent_report(Req(b'{"job_id": "j1", "status": "draft_saved"}'), _user=fake_user)
        paths = [c.args[1] for c in m.call_args_list]
        self.assertEqual(paths, [
            "/api/studio/publish/agent/heartbeat", "/api/studio/publish/agent/claim", "/api/studio/publish/agent/report",
        ])
        self.assertEqual(m.call_args_list[2].kwargs["payload"]["status"], "draft_saved")

    async def test_media_user_accepts_device_token_for_the_mac_agent(self):
        user = SimpleNamespace(id=uuid.uuid4(), role="owner")
        with patch("server.api.studio.verify_collector_token", AsyncMock(return_value=user)) as vt, \
             patch("server.api.studio.get_current_user", AsyncMock()) as gu, \
             patch("server.api.studio.resolve_studio_connection", return_value=("http://f", "t")):
            got = await _require_media_user(authorization=None, token=None, x_collector_token="dev-tok", db=None)
        self.assertIs(got, user)
        vt.assert_awaited_once_with("dev-tok", None)
        gu.assert_not_awaited()

