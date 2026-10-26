"""Tests for server.api.updates without pytest dependency."""

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport

import server.api.updates as updates_mod
from server.api.updates import router, _compare_semver, _match_github_asset


class TestUpdatesApi(unittest.TestCase):
    def setUp(self):
        # Reset release cache before each test
        updates_mod._RELEASE_CACHE = {"time": 0.0, "data": None}

    def tearDown(self):
        updates_mod._RELEASE_CACHE = {"time": 0.0, "data": None}

    def test_semver_comparison(self):
        self.assertTrue(_compare_semver("1.0.1", "1.0.0"))
        self.assertTrue(_compare_semver("2.0.0", "1.9.9"))
        self.assertTrue(_compare_semver("1.0.10", "1.0.9"))
        self.assertFalse(_compare_semver("1.0.0", "1.0.0"))
        self.assertFalse(_compare_semver("0.9.0", "1.0.0"))
        self.assertFalse(_compare_semver("1.0.9", "1.0.10"))

    def test_match_github_asset(self):
        assets = [
            {"name": "Memento-windows-x64.zip", "size": 13000000},
            {"name": "Memento-windows-x64-setup.exe", "size": 11000000},
            {"name": "Memento-macos-arm64.zip", "size": 20000000},
            {"name": "Memento-macos-arm64.dmg", "size": 23000000},
            {"name": "Memento-linux-x64.tar.gz", "size": 11000000},
            {"name": "Memento-linux-amd64.deb", "size": 9000000},
        ]

        # Windows prefers .zip for seamless in-place hot replacement; fallback to setup.exe
        win_asset = _match_github_asset(assets, "windows")
        self.assertIsNotNone(win_asset)
        self.assertEqual(win_asset["name"], "Memento-windows-x64.zip")

        # macOS prefers .zip
        mac_asset = _match_github_asset(assets, "macos")
        self.assertIsNotNone(mac_asset)
        self.assertEqual(mac_asset["name"], "Memento-macos-arm64.zip")

        # Linux prefers .tar.gz
        linux_asset = _match_github_asset(assets, "linux")
        self.assertIsNotNone(linux_asset)
        self.assertEqual(linux_asset["name"], "Memento-linux-x64.tar.gz")

    def test_update_check_offline_no_updates(self):
        async def run():
            with tempfile.TemporaryDirectory() as tmpdir:
                updates_mod._UPDATES_DIR = Path(tmpdir)
                app = FastAPI()
                app.include_router(router)

                # Mock GitHub release fetch to return None (simulating offline/air-gapped environment)
                with patch.object(updates_mod, "_fetch_latest_github_release", new_callable=AsyncMock) as mock_fetch:
                    mock_fetch.return_value = None

                    transport = ASGITransport(app=app)
                    async with AsyncClient(transport=transport, base_url="http://test") as client:
                        res = await client.get("/api/system/update/check?platform=windows&version=1.0.0")
                        self.assertEqual(res.status_code, 200)
                        data = res.json()
                        self.assertFalse(data["has_update"])

        asyncio.run(run())

    def test_update_check_and_download_with_local_asset(self):
        async def run():
            with tempfile.TemporaryDirectory() as tmpdir:
                updates_dir = Path(tmpdir)
                updates_mod._UPDATES_DIR = updates_dir

                # Create dummy update zip
                zip_file = updates_dir / "memento-windows-v1.0.2.zip"
                zip_file.write_bytes(b"dummy zip binary content")

                app = FastAPI()
                app.include_router(router)

                with patch.object(updates_mod, "_fetch_latest_github_release", new_callable=AsyncMock) as mock_fetch:
                    mock_fetch.return_value = None

                    transport = ASGITransport(app=app)
                    async with AsyncClient(transport=transport, base_url="http://test") as client:
                        res = await client.get("/api/system/update/check?platform=windows&version=1.0.0")
                        self.assertEqual(res.status_code, 200)
                        data = res.json()
                        self.assertTrue(data["has_update"])
                        self.assertEqual(data["latest_version"], "1.0.2")
                        self.assertEqual(data["asset_name"], "memento-windows-v1.0.2.zip")
                        self.assertIsNotNone(data["download_url"])

                        # Test downloading the asset
                        res_dl = await client.get(data["download_url"])
                        self.assertEqual(res_dl.status_code, 200)
                        self.assertEqual(res_dl.content, b"dummy zip binary content")

        asyncio.run(run())

    def test_dynamic_github_release_flow(self):
        async def run():
            with tempfile.TemporaryDirectory() as tmpdir:
                updates_dir = Path(tmpdir)
                updates_mod._UPDATES_DIR = updates_dir

                app = FastAPI()
                app.include_router(router)

                mock_gh_data = {
                    "tag_name": "v1.0.10",
                    "name": "Memento v1.0.10",
                    "body": "1. 修复自动升级问题\n2. 优化托盘体验",
                    "published_at": "2026-09-16T11:35:00Z",
                    "assets": [
                        {"name": "Memento-macos-arm64.zip", "size": 20363543},
                        {"name": "Memento-windows-x64.zip", "size": 13398415},
                        {"name": "Memento-linux-x64.tar.gz", "size": 11052194},
                    ],
                }

                with patch.object(updates_mod, "_fetch_latest_github_release", new_callable=AsyncMock) as mock_fetch:
                    mock_fetch.return_value = mock_gh_data

                    transport = ASGITransport(app=app)
                    async with AsyncClient(transport=transport, base_url="http://test") as client:
                        # 1. macOS check from older version
                        res_mac = await client.get("/api/system/update/check?platform=macos&version=1.0.9")
                        self.assertEqual(res_mac.status_code, 200)
                        data_mac = res_mac.json()
                        self.assertTrue(data_mac["has_update"])
                        self.assertEqual(data_mac["latest_version"], "1.0.10")
                        self.assertEqual(data_mac["asset_name"], "Memento-macos-arm64.zip")
                        self.assertEqual(data_mac["download_url"], "/api/system/update/download?file=Memento-macos-arm64.zip&version=1.0.10")

                        # 2. Windows check from same latest version
                        res_win = await client.get("/api/system/update/check?platform=windows&version=1.0.10")
                        self.assertEqual(res_win.status_code, 200)
                        data_win = res_win.json()
                        self.assertFalse(data_win["has_update"])
                        self.assertEqual(data_win["latest_version"], "1.0.10")
                        self.assertEqual(data_win["asset_name"], "Memento-windows-x64.zip")

                        # 3. Linux check
                        res_linux = await client.get("/api/system/update/check?platform=linux&version=1.0.0")
                        self.assertEqual(res_linux.status_code, 200)
                        data_linux = res_linux.json()
                        self.assertTrue(data_linux["has_update"])
                        self.assertEqual(data_linux["asset_name"], "Memento-linux-x64.tar.gz")

                        # 4. Download when uncached locally -> verify 302 redirect to GitHub
                        res_redirect = await client.get("/api/system/update/download?file=Memento-macos-arm64.zip", follow_redirects=False)
                        self.assertEqual(res_redirect.status_code, 302)
                        self.assertIn("github.com", res_redirect.headers.get("location", ""))
                        self.assertIn("Memento-macos-arm64.zip", res_redirect.headers.get("location", ""))

        asyncio.run(run())


    def test_baked_channel_yaml_only_while_it_is_the_latest_release(self):
        """data/updates/latest-mac.yml comes with the image; after the next release (committed with
        [skip ci], so no rebuild) it must not keep telling clients the old version is the latest."""
        async def run():
            with tempfile.TemporaryDirectory() as tmpdir:
                updates_dir = Path(tmpdir)
                updates_mod._UPDATES_DIR = updates_dir
                updates_mod._YAML_CACHE.clear()
                (updates_dir / "latest-mac.yml").write_text("version: 1.0.83\nfiles: []\n", encoding="utf-8")
                app = FastAPI()
                app.include_router(router)
                transport = ASGITransport(app=app)
                for gh, expect_local in ((None, True), ({"tag_name": "v1.0.83", "assets": []}, True),
                                         ({"tag_name": "v1.0.84", "assets": []}, False)):
                    with patch.object(updates_mod, "_fetch_latest_github_release", new_callable=AsyncMock) as mock_fetch:
                        mock_fetch.return_value = gh
                        async with AsyncClient(transport=transport, base_url="http://test") as client:
                            res = await client.get("/api/system/update/latest-mac.yml", follow_redirects=False)
                    if expect_local:
                        self.assertEqual(res.status_code, 200, gh)
                        self.assertIn("1.0.83", res.text)
                    else:
                        self.assertEqual(res.status_code, 302)
                        self.assertIn("/v1.0.84/latest-mac.yml", res.headers["location"])

        asyncio.run(run())

if __name__ == "__main__":
    unittest.main()


