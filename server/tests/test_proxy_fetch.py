"""The workbench's proxy for other sites' documents: public sites only, never a 401 passed through."""

from __future__ import annotations

import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from fastapi.testclient import TestClient  # noqa: E402

from server.api import documents  # noqa: E402
from server.main import app  # noqa: E402
from server.middleware.auth import get_current_user  # noqa: E402

APPLE = "https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy.md"
PUBLIC = {"developer.apple.com": "17.253.144.10", "raw.githubusercontent.com": "185.199.108.133"}
RAW_ADDRS = ["2606:50c0:8000::154", "185.199.108.133", "185.199.109.133"]
INTERNAL = {"minio": "10.43.12.7", "localhost": "127.0.0.1", "metadata": "169.254.169.254", "nas.lan": "192.168.0.20"}


async def fake_resolve(host: str, port: int) -> list[str]:
    import ipaddress

    try:
        return [str(ipaddress.ip_address(host))]  # as getaddrinfo does for a literal address
    except ValueError:
        pass
    if host == "raw.githubusercontent.com":
        return list(RAW_ADDRS)
    addr = PUBLIC.get(host) or INTERNAL.get(host)
    if addr is None:
        import socket
        raise socket.gaierror(host)
    return [addr]


class ProxyFetchTests(unittest.TestCase):
    def setUp(self) -> None:
        app.dependency_overrides[get_current_user] = lambda: MagicMock(id=uuid.uuid4(), role="user")
        self.seen: list[httpx.Request] = []

    def tearDown(self) -> None:
        app.dependency_overrides.pop(get_current_user, None)

    def get(self, url: str, handler) -> httpx.Response:
        def record(request: httpx.Request) -> httpx.Response:
            self.seen.append(request)
            return handler(request)

        real_client = httpx.AsyncClient

        def client(**kw):
            kw.pop("transport", None)
            return real_client(transport=httpx.MockTransport(record), **kw)

        with patch.object(documents, "_resolve", AsyncMock(side_effect=fake_resolve)), \
             patch("httpx.AsyncClient", client):
            return TestClient(app).get("/api/documents/proxy-fetch", params={"url": url})

    def test_fetches_a_public_document_from_the_address_it_checked(self) -> None:
        r = self.get(APPLE, lambda req: httpx.Response(200, text="# TN3179", headers={"content-type": "text/markdown"}))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["content"], "# TN3179")
        req = self.seen[0]
        self.assertEqual(req.url.host, "17.253.144.10")  # connects to the checked address
        self.assertEqual(req.headers["host"], "developer.apple.com")
        self.assertEqual(req.extensions["sni_hostname"], "developer.apple.com")

    def test_names_that_resolve_inside_are_refused(self) -> None:
        for url in ("http://minio:9000/memento-backups/", "http://localhost:8000/api/admin", "http://metadata/latest",
                    "http://nas.lan/", "http://127.0.0.1/", "https://user:pw@developer.apple.com/"):
            r = self.get(url, lambda req: httpx.Response(200, text="secret"))
            self.assertIn(r.status_code, (400, 403), url)
        self.assertEqual(self.seen, [])

    def test_a_redirect_into_the_network_is_refused(self) -> None:
        r = self.get(APPLE, lambda req: httpx.Response(302, headers={"location": "http://minio:9000/"}))
        self.assertEqual(r.status_code, 403)
        self.assertEqual(len(self.seen), 1)

    def test_a_public_redirect_is_followed(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            if req.headers["host"] == "developer.apple.com":
                return httpx.Response(301, headers={"location": "https://raw.githubusercontent.com/a/b/README.md"})
            return httpx.Response(200, text="readme")

        r = self.get(APPLE, handler)
        self.assertEqual(r.json()["content"], "readme")

    def test_the_sites_401_does_not_become_ours(self) -> None:
        # authFetch logs the user out on a 401 from Memento's API
        r = self.get(APPLE, lambda req: httpx.Response(401))
        self.assertEqual(r.status_code, 502)
        self.assertIn("401", r.json()["detail"])

    def test_large_documents_are_cut(self) -> None:
        r = self.get(APPLE, lambda req: httpx.Response(200, content=b"a" * (documents._PROXY_MAX_BYTES + 1000)))
        self.assertEqual(len(r.json()["content"]), documents._PROXY_MAX_BYTES)


    def test_an_unreachable_address_falls_through_to_the_next_ipv4_first(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            if req.url.host == "185.199.108.133":
                raise httpx.ConnectError("reset")
            return httpx.Response(200, text="readme")

        r = self.get("https://raw.githubusercontent.com/a/b/README.md", handler)
        self.assertEqual(r.json()["content"], "readme")
        self.assertEqual([q.url.host for q in self.seen], ["185.199.108.133", "185.199.109.133"])

if __name__ == "__main__":
    unittest.main()
