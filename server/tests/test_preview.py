"""Local web server preview: paths rewritten under the preview prefix, the page sandboxed away from this site's
sign-in, tokens bound to the user's device and port."""

import asyncio
import base64
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from starlette.requests import Request

from server.api import preview
from server.db.models import Machine, User

P = "/api/preview/t/TOKEN/"


def test_absolute_paths_in_html_js_css_go_under_the_prefix_full_urls_dont():
    html = '<script type="module" src="/@vite/client"></script><link href="/assets/a.css"><a href="//cdn.x/y"><img src="https://x/y.png">'
    out = preview.rewrite_paths(html, "text/html; charset=utf-8", P)
    assert f'src="{P}@vite/client"' in out and f'href="{P}assets/a.css"' in out
    assert 'href="//cdn.x/y"' in out and 'src="https://x/y.png"' in out
    js = 'import "/src/main.ts"; import React from "/node_modules/.vite/deps/react.js?v=1"; const m = import("/src/lazy.ts"); fetch("/api/x")'
    out = preview.rewrite_paths(js, "text/javascript", P)
    assert f'import "{P}src/main.ts"' in out and f'from "{P}node_modules/.vite/deps/react.js?v=1"' in out and f'import("{P}src/lazy.ts")' in out
    assert 'fetch("/api/x")' in out  # runtime fetches aren't rewritten (documented limit)
    css = "@import '/base.css'; .a{background:url(/img/bg.png)} .b{background:url(data:image/png;base64,AA)}"
    out = preview.rewrite_paths(css, "text/css", P)
    assert f"@import '{P}base.css'" in out and f"url({P}img/bg.png)" in out and "url(data:" in out


def test_redirects_stay_inside_the_preview():
    assert preview.rewrite_location("/login?next=/", 5173, P) == f"{P}login?next=/"
    assert preview.rewrite_location("http://localhost:5173/dash", 5173, P) == f"{P}dash"
    assert preview.rewrite_location("https://github.com/login", 5173, P) == "https://github.com/login"


@pytest.fixture(autouse=True)
def single_replica():
    preview._local.clear()
    with patch.object(type(preview.cluster), "redis", property(lambda self: None)):
        yield


def _request(path: str, query: str = "") -> Request:
    scope = {"type": "http", "method": "GET", "path": path, "query_string": query.encode(), "headers": [(b"accept", b"text/html")]}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request(scope, receive)


def test_a_preview_page_is_fetched_from_the_devices_localhost_and_sandboxed():
    user = User(id=uuid.uuid4(), email="u@example.com", role="owner")
    with (
        patch.object(preview, "_resolve_device", AsyncMock(return_value=(Machine(id=uuid.uuid4(), name="mini", collector_token_hash="t"), ["dev-1"]))),
        patch.object(preview.device_reports, "device_has_feature", lambda *a, **k: True),
    ):
        sess = asyncio.run(preview.preview_session(preview.PreviewSession(device_id="mini", port=5173), db=AsyncMock(), user=user))
    token = sess["token"]
    asked = AsyncMock(return_value={"ok": True, "status": 200, "headers": {"content-type": "text/html", "x-frame-options": "DENY", "set-cookie": "a=b"},
                                     "body_b64": base64.b64encode(b'<script src="/src/main.ts"></script>').decode()})
    with patch.object(preview.ws_manager, "request_device", asked):
        res = asyncio.run(preview.preview_proxy(token, "about", _request(f"/api/preview/t/{token}/about", "tab=1")))
    sent = asked.await_args.args[1]
    assert sent["type"] == "preview_http_req" and sent["port"] == 5173 and sent["path"] == "/about?tab=1"
    assert res.status_code == 200
    assert f'src="/api/preview/t/{token}/src/main.ts"'.encode() in res.body
    assert res.headers["content-security-policy"].startswith("sandbox ")
    assert "allow-same-origin" not in res.headers["content-security-policy"]
    assert "x-frame-options" not in res.headers and "set-cookie" not in res.headers


def test_unknown_or_expired_tokens_get_nothing():
    res = asyncio.run(preview.preview_proxy("x" * 32, "", _request("/api/preview/t/x/")))
    assert res.status_code == 410
