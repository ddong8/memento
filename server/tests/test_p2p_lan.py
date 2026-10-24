"""LAN shortcut for devices, and the WebRTC signalling that lets a page fetch a device's file directly."""

from __future__ import annotations

import hashlib
import hmac
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from fastapi.testclient import TestClient  # noqa: E402

from server.api import devices, ingest  # noqa: E402
from server.db.session import get_db  # noqa: E402
from server.main import app  # noqa: E402
from server.middleware.auth import get_current_user  # noqa: E402


class LanHelloTests(unittest.TestCase):
    def test_proves_the_server_to_a_lan_caller(self) -> None:
        r = TestClient(app).get(
            "/api/ingest/lan-hello",
            params={"device": "dev-1", "challenge": "c" * 32},
            headers={"X-Forwarded-For": "192.168.0.10"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        # The device checks it with the key its heartbeat got over TLS
        key = ingest._lan_key("dev-1")
        self.assertEqual(r.json()["proof"], hmac.new(key.encode(), ("c" * 32).encode(), hashlib.sha256).hexdigest())

    def test_refuses_anything_that_came_through_the_public_entry(self) -> None:
        # The entry's nginx appends the caller's public address, whatever the caller put in front
        for xff in ("8.8.8.8", "192.168.0.5, 8.8.8.8", "192.168.0.5, 8.8.8.8, 10.0.0.7"):
            r = TestClient(app).get("/api/ingest/lan-hello", params={"device": "dev-1", "challenge": "c" * 32}, headers={"X-Forwarded-For": xff})
            self.assertEqual(r.status_code, 404, xff)

    def test_keys_differ_per_device(self) -> None:
        self.assertNotEqual(ingest._lan_key("dev-1"), ingest._lan_key("dev-2"))


class P2PSignallingTests(unittest.TestCase):
    def setUp(self) -> None:
        user = MagicMock(id=uuid.uuid4(), role="user")
        app.dependency_overrides[get_current_user] = lambda: user
        app.dependency_overrides[get_db] = lambda: AsyncMock()
        self.machine = MagicMock(id=uuid.uuid4(), collector_token_hash="tok-hash")
        self.authorized = patch.object(devices, "_authorized_machine", AsyncMock(return_value=(self.machine, [self.machine.id])))
        self.authorized.start()

    def tearDown(self) -> None:
        self.authorized.stop()
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_db, None)

    def test_relays_the_offer_and_returns_the_devices_answer(self) -> None:
        relay = AsyncMock(return_value={"sdp": "v=0 answer"})
        with patch.object(devices.ws_manager, "has_device", return_value=True), \
             patch.object(devices.ws_manager, "request_p2p_answer", relay):
            r = TestClient(app).post("/api/devices/dev-1/p2p/offer", json={"sdp": "v=0 offer"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"sdp": "v=0 answer"})
        token, sdp, ice = relay.await_args.args
        self.assertEqual((token, sdp), ("tok-hash", "v=0 offer"))
        self.assertTrue(all(u.startswith("stun:") for u in ice))

    def test_offline_device_or_declined_offer_is_an_error(self) -> None:
        with patch.object(devices.ws_manager, "has_device", return_value=False):
            self.assertEqual(TestClient(app).post("/api/devices/dev-1/p2p/offer", json={"sdp": "x"}).status_code, 409)
        with patch.object(devices.ws_manager, "has_device", return_value=True), \
             patch.object(devices.ws_manager, "request_p2p_answer", AsyncMock(return_value={"error": "direct transfer is not available"})):
            r = TestClient(app).post("/api/devices/dev-1/p2p/offer", json={"sdp": "x"})
        self.assertEqual(r.status_code, 502)

    def test_locate_finds_the_device_holding_the_file(self) -> None:
        stat = AsyncMock(return_value=({"exists": True, "total_size": 1234}, "tok-hash"))
        with patch.object(devices, "_stat_on_devices", stat), \
             patch.object(devices, "_get_cached_stat", AsyncMock(return_value=None)), \
             patch.object(devices, "_set_cached_stat", AsyncMock()):
            r = TestClient(app).get("/api/devices/dev-1/files/locate", params={"path": "/Users/me/clip.mp4"})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["device"], body["size"]), ("tok-hash", 1234))
        self.assertTrue(body["ice_servers"])

    def test_locate_says_local_when_the_server_has_the_file(self) -> None:
        r = TestClient(app).get("/api/devices/dev-1/files/locate", params={"path": __file__})
        self.assertEqual(r.json(), {"local": True})
