import asyncio
import base64
import unittest
from unittest.mock import AsyncMock
from server.services.ws_manager import DeviceConnectionManager


class TestArtifactMediaStream(unittest.IsolatedAsyncioTestCase):
    async def test_ws_manager_file_stat_and_chunk(self):
        mgr = DeviceConnectionManager()
        dummy_ws = AsyncMock()
        await mgr.register('device_mac_nas', dummy_ws)

        # 1. Test request_file_stat
        async def fake_respond_stat():
            await asyncio.sleep(0.01)
            sent_data = dummy_ws.send_json.call_args[0][0]
            self.assertEqual(sent_data['type'], 'file_stat_req')
            self.assertEqual(sent_data['path'], '/Volumes/NAS/video.mp4')
            req_id = sent_data['req_id']

            mgr.handle_file_response({
                'req_id': req_id,
                'exists': True,
                'size': 33554432,
                'filename': 'video.mp4',
                'mime': 'video/mp4',
            })

        asyncio.create_task(fake_respond_stat())
        stat = await mgr.request_file_stat('device_mac_nas', '/Volumes/NAS/video.mp4', timeout=1.0)
        self.assertTrue(stat['exists'])
        self.assertEqual(stat['size'], 33554432)
        self.assertEqual(stat['mime'], 'video/mp4')

        # 2. Test request_file_chunk
        async def fake_respond_chunk():
            await asyncio.sleep(0.01)
            sent_data = dummy_ws.send_json.call_args[0][0]
            self.assertEqual(sent_data['type'], 'file_chunk_req')
            self.assertEqual(sent_data['offset'], 1024)
            self.assertEqual(sent_data['length'], 4096)
            req_id = sent_data['req_id']

            mgr.handle_file_response({
                'req_id': req_id,
                'data_b64': base64.b64encode(b'hello-artifact-video').decode('ascii'),
            })

        asyncio.create_task(fake_respond_chunk())
        chunk = await mgr.request_file_chunk(
            'device_mac_nas', '/Volumes/NAS/video.mp4', offset=1024, length=4096, timeout=1.0
        )
        self.assertIsNotNone(chunk)
        self.assertEqual(chunk, b'hello-artifact-video')

    async def test_ws_manager_offline_device(self):
        mgr = DeviceConnectionManager()
        stat = await mgr.request_file_stat('offline_device', '/test.mp4', timeout=0.1)
        self.assertFalse(stat['exists'])
        self.assertIn('not connected', stat['error'])


    async def test_stream_device_file_double_encoded_chinese_path(self):
        import os
        import tempfile
        import urllib.parse
        from unittest.mock import MagicMock
        from server.api.devices import stream_device_file

        with tempfile.TemporaryDirectory() as tmpdir:
            chinese_dir = os.path.join(tmpdir, "NAS相册第九支")
            os.makedirs(chinese_dir, exist_ok=True)
            video_path = os.path.join(chinese_dir, "去海边_45秒.mp4")
            with open(video_path, "wb") as f:
                f.write(b"fake-video-content-1234567890")

            # 模拟双重 URL 编码
            double_encoded_path = urllib.parse.quote(urllib.parse.quote(video_path))

            mock_user = MagicMock(role="admin", id=1)
            mock_db = MagicMock()
            mock_req = MagicMock(headers={})

            resp = await stream_device_file(
                device_id="auto",
                path=double_encoded_path,
                filename="去海边_45秒.mp4",
                request=mock_req,
                db=mock_db,
                _user=mock_user,
            )

            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.headers["Content-Type"], "video/mp4")
            self.assertEqual(resp.headers["Content-Length"], str(len(b"fake-video-content-1234567890")))
            self.assertIn("ETag", resp.headers)
            self.assertIn("Cache-Control", resp.headers)

    async def test_stream_device_file_head_and_304_cache(self):
        import os
        import tempfile
        from unittest.mock import MagicMock
        from server.api.devices import stream_device_file

        with tempfile.TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "岁末余晖_45秒.mp4")
            payload = b"test-mp4-stream-cache-payload-9876543210"
            with open(video_path, "wb") as f:
                f.write(payload)

            mock_user = MagicMock(role="admin", id=1)
            mock_db = MagicMock()

            # 1. Test HEAD request
            head_req = MagicMock(method="HEAD", headers={})
            head_resp = await stream_device_file(
                device_id="auto",
                path=video_path,
                filename="岁末余晖_45秒.mp4",
                request=head_req,
                db=mock_db,
                _user=mock_user,
            )
            self.assertEqual(head_resp.status_code, 200)
            self.assertEqual(head_resp.headers["Content-Length"], str(len(payload)))
            self.assertIn("ETag", head_resp.headers)
            self.assertEqual(head_resp.headers["Cache-Control"], "public, max-age=604800, stale-while-revalidate=86400")
            etag = head_resp.headers["ETag"]

            # 2. Test 304 Not Modified on matching If-None-Match
            cond_req = MagicMock(method="GET", headers={"if-none-match": etag})
            cond_resp = await stream_device_file(
                device_id="auto",
                path=video_path,
                filename="岁末余晖_45秒.mp4",
                request=cond_req,
                db=mock_db,
                _user=mock_user,
            )
            self.assertEqual(cond_resp.status_code, 304)
            self.assertEqual(cond_resp.headers["ETag"], etag)

    def test_initial_chunk_cache_bounds_and_ttl(self):
        """Verify _initial_chunk_cache enforces capacity and TTL."""
        import time
        from server.api.devices import (
            _initial_chunk_cache,
            _set_initial_chunk,
            _get_initial_chunk,
            _MAX_INITIAL_CHUNKS,
        )

        _initial_chunk_cache.clear()
        # 1. Fill past capacity
        for i in range(_MAX_INITIAL_CHUNKS + 10):
            _set_initial_chunk(f"key_{i}", f"data_{i}".encode())

        self.assertLessEqual(len(_initial_chunk_cache), _MAX_INITIAL_CHUNKS)
        # Oldest keys should have been evicted
        self.assertIsNone(_get_initial_chunk("key_0"))
        self.assertEqual(_get_initial_chunk(f"key_{_MAX_INITIAL_CHUNKS + 9}"), f"data_{_MAX_INITIAL_CHUNKS + 9}".encode())

        # 2. TTL expiration
        _initial_chunk_cache["expired_key"] = (b"stale_bytes", time.time() - 400)
        self.assertIsNone(_get_initial_chunk("expired_key"))

    def test_cache_room_is_reserved_before_a_download(self):
        """Oldest files go first, in-flight downloads count at full size, and files too
        big for the cache (or too many at once) are streamed without caching."""
        import os
        import tempfile
        import time
        from unittest.mock import patch
        from server.api import devices

        KB = 1024
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(devices._prefetch_reserved, clear=True):
            paths = []
            for i, age in enumerate((300, 200, 100)):
                path = os.path.join(tmpdir, f"video{i}.mp4")
                with open(path, "wb") as f:
                    f.write(b"x" * 100 * KB)
                os.utime(path, (time.time() - age, time.time() - age))
                paths.append(path)

            # 300 KB cached, quota 400 KB: a 100 KB download fits as is
            self.assertTrue(devices._make_room_for(tmpdir, 100 * KB, max_bytes=400 * KB))
            self.assertTrue(all(os.path.exists(p) for p in paths))

            # One 100 KB download in flight: the next one needs the oldest file gone
            devices._prefetch_reserved["inflight"] = 100 * KB
            with open(os.path.join(tmpdir, "inflight.mp4.part"), "wb") as f:
                f.write(b"y" * 50 * KB)  # counted through its reservation, not twice
            self.assertTrue(devices._make_room_for(tmpdir, 100 * KB, max_bytes=400 * KB))
            self.assertFalse(os.path.exists(paths[0]))
            self.assertTrue(os.path.exists(paths[2]))

            # Bigger than a quarter of the quota: never cached
            self.assertFalse(devices._make_room_for(tmpdir, 101 * KB, max_bytes=400 * KB))

            # Enough downloads already running
            devices._prefetch_reserved["second"] = 10 * KB
            self.assertFalse(devices._make_room_for(tmpdir, 10 * KB, max_bytes=400 * KB))


if __name__ == '__main__':
    unittest.main()
