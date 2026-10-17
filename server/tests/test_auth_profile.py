from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from fastapi import HTTPException, UploadFile
from server.api.auth import (
    UpdateProfileRequest,
    delete_avatar,
    update_profile,
    upload_avatar,
)
from server.db.models import User


class AuthProfileTests(unittest.IsolatedAsyncioTestCase):
    async def test_update_profile_name_and_avatar(self) -> None:
        user = User(
            id=MagicMock(),
            email="test@example.com",
            name="旧昵称",
            avatar_url=None,
            role="viewer",
            status="active",
        )
        db = AsyncMock()

        # Update both name and avatar
        req = UpdateProfileRequest(
            name="新昵称",
            avatar_url="https://example.com/avatar.png",
        )
        res = await update_profile(req, user=user, db=db)
        self.assertEqual(res.name, "新昵称")
        self.assertEqual(res.avatar_url, "https://example.com/avatar.png")
        self.assertEqual(user.name, "新昵称")
        self.assertEqual(user.avatar_url, "https://example.com/avatar.png")
        db.flush.assert_called_once()

    async def test_update_profile_inactive_user(self) -> None:
        user = User(
            id=MagicMock(),
            email="disabled@example.com",
            name="停用账号",
            status="disabled",
        )
        db = AsyncMock()
        req = UpdateProfileRequest(name="尝试修改")
        with self.assertRaises(HTTPException) as ctx:
            await update_profile(req, user=user, db=db)
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_upload_avatar_success(self) -> None:
        user = User(
            id=MagicMock(),
            email="test@example.com",
            name="测试",
            avatar_url=None,
            status="active",
            role="viewer",
        )
        db = AsyncMock()

        fake_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
        file = UploadFile(file=io.BytesIO(fake_png), filename="avatar.png", headers={"content-type": "image/png"})

        res = await upload_avatar(file, user=user, db=db)
        self.assertTrue(res.avatar_url.startswith("data:image/png;base64,"))
        self.assertTrue(user.avatar_url.startswith("data:image/png;base64,"))

    async def test_upload_avatar_invalid_type(self) -> None:
        user = User(
            id=MagicMock(),
            email="test@example.com",
            status="active",
        )
        db = AsyncMock()
        file = UploadFile(file=io.BytesIO(b"bad"), filename="bad.txt", headers={"content-type": "text/plain"})
        with self.assertRaises(HTTPException) as ctx:
            await upload_avatar(file, user=user, db=db)
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_delete_avatar(self) -> None:
        user = User(
            id=MagicMock(),
            email="test@example.com",
            name="测试",
            avatar_url="data:image/png;base64,abc",
            status="active",
            role="viewer",
        )
        db = AsyncMock()
        res = await delete_avatar(user=user, db=db)
        self.assertIsNone(res.avatar_url)
        self.assertIsNone(user.avatar_url)
