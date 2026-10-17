"""Brute-force guards on login / register, and the client IP they key on."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from fastapi import HTTPException  # noqa: E402
from starlette.requests import Request  # noqa: E402

from server.api import auth  # noqa: E402
from server.services import rate_limit  # noqa: E402


def _request(headers: dict[str, str] | None = None, peer: str | None = "10.42.0.9") -> Request:
    return Request({
        "type": "http",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        "client": (peer, 40000) if peer else None,
    })


def _db_returning(user) -> AsyncMock:
    db = AsyncMock()
    db.execute.return_value = MagicMock(scalar_one_or_none=MagicMock(return_value=user))
    return db


class ClientIpTests(unittest.TestCase):
    def test_prefers_the_address_nginx_saw(self) -> None:
        r = _request({"X-Real-IP": "203.0.113.7", "X-Forwarded-For": "1.2.3.4, 203.0.113.7"})
        self.assertEqual(rate_limit.client_ip(r), "203.0.113.7")

    def test_falls_back_to_forwarded_for_then_peer(self) -> None:
        self.assertEqual(rate_limit.client_ip(_request({"X-Forwarded-For": "198.51.100.2, 10.0.0.1"})), "198.51.100.2")
        self.assertEqual(rate_limit.client_ip(_request()), "10.42.0.9")

    def test_skips_garbage_and_returns_none_without_a_valid_ip(self) -> None:
        self.assertEqual(rate_limit.client_ip(_request({"X-Real-IP": "not-an-ip"})), "10.42.0.9")
        self.assertIsNone(rate_limit.client_ip(_request({"X-Real-IP": "nope"}, peer=None)))


class LimiterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        rate_limit._local.clear()
        self.no_redis = patch.object(rate_limit, "redis_client", return_value=None)
        self.no_redis.start()

    def tearDown(self) -> None:
        self.no_redis.stop()

    async def test_limit_then_reset(self) -> None:
        for _ in range(3):
            await rate_limit.check("k", 3)
            await rate_limit.hit("k", 60)
        with self.assertRaises(HTTPException) as ctx:
            await rate_limit.check("k", 3)
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertTrue(1 <= int(ctx.exception.headers["Retry-After"]) <= 60)
        await rate_limit.reset("k")
        await rate_limit.check("k", 3)

    async def test_login_locks_an_account_after_repeated_failures(self) -> None:
        user = MagicMock(hashed_password="right", status="active", id="u1", role="viewer")
        req = auth.LoginRequest(email="Owner@Example.com", password="wrong")
        with patch.object(auth, "verify_password", side_effect=lambda pw, h: pw == h):
            for _ in range(auth.LOGIN_MAX_PER_ACCOUNT):
                with self.assertRaises(HTTPException) as ctx:
                    await auth.login(req, _request({"X-Real-IP": "203.0.113.7"}), _db_returning(user))
                self.assertEqual(ctx.exception.status_code, 401)
            # Locked: even the right password from another address is refused until the window ends
            good = auth.LoginRequest(email="owner@example.com", password="right")
            db = _db_returning(user)
            with self.assertRaises(HTTPException) as ctx:
                await auth.login(good, _request({"X-Real-IP": "198.51.100.2"}), db)
            self.assertEqual(ctx.exception.status_code, 429)
            db.execute.assert_not_called()

    async def test_a_successful_login_clears_the_account_counter(self) -> None:
        user = MagicMock(hashed_password="right", status="active", id="u1", role="viewer")
        with patch.object(auth, "verify_password", side_effect=lambda pw, h: pw == h):
            for _ in range(auth.LOGIN_MAX_PER_ACCOUNT - 1):
                with self.assertRaises(HTTPException):
                    await auth.login(auth.LoginRequest(email="a@example.com", password="x"), _request(), _db_returning(user))
            res = await auth.login(auth.LoginRequest(email="a@example.com", password="right"), _request(), _db_returning(user))
            self.assertTrue(res.access_token)
            for _ in range(auth.LOGIN_MAX_PER_ACCOUNT - 1):  # a fresh allowance, not one left
                with self.assertRaises(HTTPException) as ctx:
                    await auth.login(auth.LoginRequest(email="a@example.com", password="x"), _request(), _db_returning(user))
                self.assertEqual(ctx.exception.status_code, 401)

    async def test_register_counts_every_attempt_per_ip(self) -> None:
        existing = MagicMock()
        req = auth.RegisterRequest(email="taken@example.com", password="pw")
        for _ in range(auth.REGISTER_MAX_PER_IP):
            with self.assertRaises(HTTPException) as ctx:
                await auth.register(req, _request({"X-Real-IP": "203.0.113.9"}), _db_returning(existing))
            self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            await auth.register(req, _request({"X-Real-IP": "203.0.113.9"}), _db_returning(existing))
        self.assertEqual(ctx.exception.status_code, 429)
        # Another address is unaffected
        with self.assertRaises(HTTPException) as ctx:
            await auth.register(req, _request({"X-Real-IP": "203.0.113.10"}), _db_returning(existing))
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
