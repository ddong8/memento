from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.api.profile import (
    AvatarGenerateRequest,
    AvatarSettingsPayload,
    generate_avatar_from_photo,
    get_avatar_settings,
    save_avatar_settings,
)
from server.db.models import User


class AvatarProfileTests(unittest.IsolatedAsyncioTestCase):
    async def test_get_avatar_settings_default_uninitialized(self) -> None:
        user = User(
            id=MagicMock(),
            email="test@example.com",
            name="测试用户",
            avatar_url=None,
            avatar_settings={},
        )
        db = AsyncMock()

        res = await get_avatar_settings(db=db, user=user)
        self.assertFalse(res["is_initialized"])
        self.assertEqual(res["gender"], "male")
        self.assertEqual(res["preset_id"], "geek_male")
        self.assertIn("黑框眼镜", res["features"])

    async def test_save_avatar_settings(self) -> None:
        user = User(
            id=MagicMock(),
            email="test@example.com",
            name="测试用户",
            avatar_url=None,
            avatar_settings={},
        )
        db = AsyncMock()

        payload = AvatarSettingsPayload(
            is_initialized=True,
            gender="female",
            style="cyberpunk",
            preset_id="cyber_female",
            nickname="赛博姬",
            avatar_url="https://example.com/cyber.png",
            custom_photo_url="data:image/png;base64,abc",
            theme_color="#EC4899",
            outfit_color="#DB2777",
            features=["电光粉挑染", "高领赛博风衣", "全域感知环"],
        )

        res = await save_avatar_settings(body=payload, db=db, user=user)
        self.assertEqual(res["status"], "ok")
        self.assertTrue(res["settings"]["is_initialized"])
        self.assertEqual(res["settings"]["gender"], "female")
        self.assertEqual(res["settings"]["style"], "cyberpunk")
        self.assertEqual(user.avatar_url, "https://example.com/cyber.png")
        db.commit.assert_called_once()

    async def test_generate_avatar_from_photo(self) -> None:
        user = User(
            id=MagicMock(),
            email="test@example.com",
            name="海星",
            avatar_url=None,
            avatar_settings={},
        )
        db = AsyncMock()

        req = AvatarGenerateRequest(
            photo_data="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
            gender="female",
            style_preference="cyberpunk",
        )

        res = await generate_avatar_from_photo(body=req, db=db, user=user)
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["gender"], "female")
        self.assertEqual(res["style"], "cyberpunk")
        self.assertEqual(res["preset_id"], "cyber_female")
        self.assertTrue(len(res["features"]) > 0)
        self.assertIn("已通过 AI 多模态视觉解析用户照片特征", res["analysis_summary"])


if __name__ == "__main__":
    unittest.main()
