import asyncio
import base64
import unittest
from unittest.mock import AsyncMock
from server.services.ws_manager import DeviceConnectionManager


class TestArtifactMediaStream(unittest.IsolatedAsyncioTestCase):
    async def test_ws_manager_file_stat_and_chunk(self):
        mgr = DeviceConnectionManager()
        dummy_ws = AsyncMock()
        mgr.register('device_mac_nas', dummy_ws)

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


if __name__ == '__main__':
    unittest.main()
