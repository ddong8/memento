"""Regression tests for P0 security hardening and P1 stability/concurrency fixes."""

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException


class TestSecurityAndStability(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        from server.api import devices
        devices._known_cache_map.clear()
        devices._file_stat_cache.clear()
        devices._negative_stat_cache.clear()

    async def test_share_token_without_file_signature_is_rejected(self):
        """A bare public ShareLink token must not allow arbitrary file reads on owner's devices."""
        from server.api.devices import stream_device_file

        owner_id = uuid.uuid4()
        fake_link = MagicMock(
            token="pubtok_abc",
            owner_user_id=owner_id,
            target_user_id=None,
            expires_at=None,
            revoked_at=None,
        )
        res_link = MagicMock(scalar_one_or_none=MagicMock(return_value=fake_link))
        db = MagicMock(execute=AsyncMock(return_value=res_link), commit=AsyncMock())
        req = MagicMock(headers={}, query_params={}, method="GET")

        with self.assertRaises(HTTPException) as ctx:
            await stream_device_file(
                device_id="dev-hash-1",
                path="/Users/victim/.ssh/id_rsa",
                share_token="pubtok_abc",
                file_exp=None,
                file_sig=None,
                request=req,
                db=db,
                _user=None,
            )
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_share_token_rejects_tampered_path_and_auto_device(self):
        from server.api.devices import stream_device_file
        from server.services.storage_service import sign_share_file_params

        owner_id = uuid.uuid4()
        fake_link = MagicMock(
            token="pubtok_xyz",
            owner_user_id=owner_id,
            target_user_id=None,
            expires_at=None,
            revoked_at=None,
        )
        res_link = MagicMock(scalar_one_or_none=MagicMock(return_value=fake_link))
        db = MagicMock(execute=AsyncMock(return_value=res_link), commit=AsyncMock())
        req = MagicMock(headers={}, query_params={}, method="GET")

        exp, sig = sign_share_file_params("pubtok_xyz", "dev-hash-1", "/tmp/allowed.png")

        # Tampering path must fail with 403
        with self.assertRaises(HTTPException) as ctx:
            await stream_device_file(
                device_id="dev-hash-1",
                path="/tmp/other.png",
                share_token="pubtok_xyz",
                file_exp=exp,
                file_sig=sig,
                request=req,
                db=db,
                _user=None,
            )
        self.assertEqual(ctx.exception.status_code, 403)

        # device_id="auto" is never allowed for share links
        exp_auto, sig_auto = sign_share_file_params("pubtok_xyz", "auto", "/tmp/allowed.png")
        with self.assertRaises(HTTPException) as ctx2:
            await stream_device_file(
                device_id="auto",
                path="/tmp/allowed.png",
                share_token="pubtok_xyz",
                file_exp=exp_auto,
                file_sig=sig_auto,
                request=req,
                db=db,
                _user=None,
            )
        self.assertEqual(ctx2.exception.status_code, 403)

    async def test_device_file_cache_isolated_between_users(self):
        """User B must never hit User A's cached file or stat entry for an identical path."""
        from server.api import devices

        user_a = MagicMock(id=uuid.uuid4(), role="member")
        user_b = MagicMock(id=uuid.uuid4(), role="member")

        with tempfile.TemporaryDirectory() as tmpdir:
            cached_a = os.path.join(tmpdir, "a.pdf")
            with open(cached_a, "wb") as fh:
                fh.write(b"secret-user-a-report")

            scope_a = devices._user_cache_scope(user_a)
            scope_b = devices._user_cache_scope(user_b)

            devices._remember_known_cache(scope_a, "dev-a", "/tmp/report.pdf", len(b"secret-user-a-report"), cached_a)
            self.assertIsNotNone(devices._lookup_known_cache(scope_a, "dev-a", "/tmp/report.pdf"))
            self.assertIsNotNone(devices._lookup_known_cache(scope_a, "auto", "/tmp/report.pdf"))
            self.assertIsNone(devices._lookup_known_cache(scope_b, "dev-a", "/tmp/report.pdf"))
            self.assertIsNone(devices._lookup_known_cache(scope_b, "auto", "/tmp/report.pdf"))

            await devices._set_cached_stat("/tmp/report.pdf", 1234, "dev-a", scope_a)
            self.assertEqual(await devices._get_cached_stat("/tmp/report.pdf", scope_a), (1234, "dev-a"))
            self.assertIsNone(await devices._get_cached_stat("/tmp/report.pdf", scope_b))

    async def test_html_and_svg_device_stream_responses_are_sandboxed(self):
        from server.api.devices import stream_device_file

        with tempfile.TemporaryDirectory() as tmpdir, patch("server.api.devices._SERVER_FILE_ROOTS", (tmpdir,)):
            for fname, body in (("evil.html", b"<script>alert(1)</script>"), ("pic.svg", b"<svg onload=alert(1)/>")):
                fpath = os.path.join(tmpdir, fname)
                with open(fpath, "wb") as fh:
                    fh.write(body)
                mock_user = MagicMock(role="admin", id=uuid.uuid4())
                mock_db = MagicMock(commit=AsyncMock())
                req = MagicMock(method="HEAD", headers={})
                resp = await stream_device_file(
                    device_id="auto",
                    path=fpath,
                    filename=fname,
                    request=req,
                    db=mock_db,
                    _user=mock_user,
                )
                self.assertEqual(resp.headers.get("Content-Security-Policy"), "sandbox")
                self.assertEqual(resp.headers.get("X-Content-Type-Options"), "nosniff")
                self.assertTrue(resp.headers.get("Cache-Control", "").startswith("private,"))

    async def test_media_image_blocks_traversal_svg_and_cross_user_keys(self):
        from server.api.media import get_media_image

        db = MagicMock()
        # Path traversal rejected
        with self.assertRaises(HTTPException) as ctx:
            await get_media_image(key="../../etc/passwd", exp=None, sig=None, authorization="Bearer tok", db=db)
        self.assertEqual(ctx.exception.status_code, 400)

        # Cross-user u/<other>/... rejected
        caller = MagicMock(id=uuid.uuid4(), role="member")
        other_uid = uuid.uuid4()
        with patch("server.api.media.get_current_user", AsyncMock(return_value=caller)):
            with self.assertRaises(HTTPException) as ctx2:
                await get_media_image(
                    key=f"u/{other_uid}/pic.png",
                    exp=None,
                    sig=None,
                    authorization="Bearer valid",
                    db=db,
                )
            self.assertEqual(ctx2.exception.status_code, 403)

        # SVG downgraded and sandboxed
        with patch("server.api.media.get_current_user", AsyncMock(return_value=caller)), \
                patch("server.api.media.get_bytes", AsyncMock(return_value=(b"<svg/>", "image/svg+xml"))):
            resp = await get_media_image(
                key=f"u/{caller.id}/pic.svg",
                exp=None,
                sig=None,
                authorization="Bearer valid",
                db=db,
            )
            self.assertEqual(resp.headers.get("Content-Security-Policy"), "sandbox")
            self.assertEqual(resp.headers.get("X-Content-Type-Options"), "nosniff")
            self.assertEqual(resp.media_type, "application/octet-stream")

    async def test_events_stream_rejects_deactivated_user(self):
        from server.api.events import event_stream

        uid = uuid.uuid4()
        fake_res = MagicMock(scalar_one_or_none=MagicMock(return_value="disabled"))
        fake_db = AsyncMock()
        fake_db.execute = AsyncMock(return_value=fake_res)
        fake_ctx = AsyncMock()
        fake_ctx.__aenter__.return_value = fake_db
        fake_ctx.__aexit__.return_value = None

        with patch("server.api.events.decode_token", return_value={"sub": str(uid)}), \
                patch("server.api.events.async_session_factory", return_value=fake_ctx):
            with self.assertRaises(HTTPException) as ctx:
                await event_stream(token="signed-jwt", authorization=None, last_event_id=None)
            self.assertEqual(ctx.exception.status_code, 401)

    def test_parse_byte_range_edge_cases(self):
        from server.api.devices import _parse_byte_range

        # Normal full response
        self.assertEqual(_parse_byte_range(None, 1000), (0, 999, 200))
        # Open-ended range
        self.assertEqual(_parse_byte_range("bytes=100-", 1000), (100, 999, 206))
        # Clamps end beyond total_size
        self.assertEqual(_parse_byte_range("bytes=0-999999", 1000), (0, 999, 206))
        # Suffix range
        self.assertEqual(_parse_byte_range("bytes=-250", 1000), (750, 999, 206))
        # Malformed syntax -> 400
        with self.assertRaises(HTTPException) as bad:
            _parse_byte_range("bytes=abc-def", 1000)
        self.assertEqual(bad.exception.status_code, 400)
        # Out of bounds -> 416
        with self.assertRaises(HTTPException) as oob:
            _parse_byte_range("bytes=1500-2000", 1000)
        self.assertEqual(oob.exception.status_code, 416)

    async def test_ask_retry_commits_db_before_streaming(self):
        from server.api.ask import AskRequest, ask

        fake_run = MagicMock()
        fake_run.stream.return_value = iter(())
        mock_db = MagicMock(commit=AsyncMock())
        mock_user = MagicMock(id=uuid.uuid4())

        with patch("server.api.ask.ask_runs.by_request", AsyncMock(return_value=fake_run)):
            resp = await ask(AskRequest(question="hello", request_id="req-1"), db=mock_db, _user=mock_user)
            self.assertEqual(resp.media_type, "text/event-stream")
            mock_db.commit.assert_awaited_once()

    async def test_bg_tasks_tracks_and_cancels_cleanly(self):
        from server.services import bg_tasks

        ran = asyncio.Event()

        async def ok_job():
            ran.set()

        t = bg_tasks.spawn(ok_job(), name="test-ok")
        await t
        await asyncio.sleep(0)
        self.assertTrue(ran.is_set())
        self.assertNotIn(t, bg_tasks._tasks)

        # Failing task logs warning and cleans up without raising
        async def bad_job():
            raise RuntimeError("boom")

        t2 = bg_tasks.spawn(bad_job(), name="test-bad")
        with self.assertRaises(RuntimeError):
            await t2
        await asyncio.sleep(0)
        self.assertNotIn(t2, bg_tasks._tasks)

        # cancel_all cancels pending tasks
        never = asyncio.Event()
        t3 = bg_tasks.spawn(never.wait(), name="test-never")
        self.assertIn(t3, bg_tasks._tasks)
        await bg_tasks.cancel_all(timeout=1.0)
        self.assertTrue(t3.cancelled())


if __name__ == "__main__":
    unittest.main()
