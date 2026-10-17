"""The WeChat webhook only trusts requests signed with a configured Token."""

from __future__ import annotations

import hashlib
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from fastapi.testclient import TestClient  # noqa: E402

from server.api import auth  # noqa: E402
from server.db.session import get_db  # noqa: E402
from server.main import app  # noqa: E402

NEW, OLD = "new_token_0123456789abcdef", "old_token_value"


def _signed(token: str, timestamp: int | None = None, nonce: str = "42") -> dict[str, str]:
    ts = str(int(time.time()) if timestamp is None else timestamp)
    return {"signature": hashlib.sha1("".join(sorted([token, ts, nonce])).encode()).hexdigest(), "timestamp": ts, "nonce": nonce}


SUBSCRIBE = (b"<xml><ToUserName>gh_x</ToUserName><FromUserName>openid-1</FromUserName>"
             b"<MsgType>event</MsgType><Event>subscribe</Event></xml>")


class WechatWebhookTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tokens = patch.multiple(auth.settings, wechat_token=NEW, wechat_token_previous=OLD)
        self.tokens.start()
        app.dependency_overrides[get_db] = lambda: None
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.pop(get_db, None)
        self.tokens.stop()

    def test_signature_matches_the_current_or_previous_token(self) -> None:
        self.assertEqual(auth._wechat_token_used(**_signed(NEW)), "current")
        self.assertEqual(auth._wechat_token_used(**_signed(OLD)), "previous")
        self.assertIsNone(auth._wechat_token_used(**_signed("someone-else")))

    def test_url_verification_echoes_only_for_a_known_token(self) -> None:
        for token in (NEW, OLD):
            r = self.client.get("/api/auth/wechat/webhook", params={**_signed(token), "echostr": "hello"})
            self.assertEqual((r.status_code, r.text), (200, "hello"))
        r = self.client.get("/api/auth/wechat/webhook", params={**_signed("forged"), "echostr": "hello"})
        self.assertEqual(r.status_code, 403)

    def test_unsigned_forged_or_stale_pushes_are_refused(self) -> None:
        for params in ({}, _signed("forged"), _signed(NEW, timestamp=int(time.time()) - 3600)):
            r = self.client.post("/api/auth/wechat/webhook", params=params, content=SUBSCRIBE)
            self.assertEqual(r.status_code, 403, params)

    def test_a_signed_push_is_handled(self) -> None:
        r = self.client.post("/api/auth/wechat/webhook", params=_signed(NEW), content=SUBSCRIBE)
        self.assertEqual(r.status_code, 200)
        self.assertIn("openid-1", r.text)  # the welcome reply goes back to the sender


if __name__ == "__main__":
    unittest.main()
