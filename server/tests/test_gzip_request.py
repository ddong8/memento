"""Request bodies a collector sends gzip-compressed are inflated before the app reads them
(middleware/gzip_request.py): a slice of a log is about a sixth of its size compressed, and the
uplink through the public entry carried about 400 KB/s (10-30)."""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.middleware.gzip_request import GzipRequestMiddleware  # noqa: E402


def _app(max_bytes: int = 1 << 20) -> FastAPI:
    app = FastAPI()

    @app.post("/echo")
    async def echo(request: Request, payload: dict) -> dict:
        return {
            "payload": payload,
            "length": request.headers.get("content-length"),
            "encoding": request.headers.get("content-encoding"),
        }

    app.add_middleware(GzipRequestMiddleware, max_bytes=max_bytes)
    return app


async def _post(app: FastAPI, body: bytes, headers: dict[str, str]):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post("/echo", content=body, headers={"content-type": "application/json", **headers})


@pytest.mark.asyncio
async def test_a_compressed_body_reaches_the_app_inflated() -> None:
    raw = json.dumps({"content": "第一行\n" * 5000}).encode()
    res = await _post(_app(), gzip.compress(raw), {"content-encoding": "gzip"})
    assert res.status_code == 200
    assert res.json() == {"payload": json.loads(raw), "length": str(len(raw)), "encoding": None}


@pytest.mark.asyncio
async def test_a_plain_body_is_left_as_it_is() -> None:
    raw = json.dumps({"content": "plain"}).encode()
    res = await _post(_app(), raw, {})
    assert res.status_code == 200
    assert res.json() == {"payload": {"content": "plain"}, "length": str(len(raw)), "encoding": None}


@pytest.mark.asyncio
async def test_a_body_past_the_limit_once_inflated_is_turned_down() -> None:
    raw = json.dumps({"content": "x" * 5000}).encode()
    res = await _post(_app(max_bytes=4000), gzip.compress(raw), {"content-encoding": "gzip"})
    assert res.status_code == 413
    res = await _post(_app(max_bytes=len(raw)), gzip.compress(raw), {"content-encoding": "gzip"})
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_a_body_that_is_not_gzip_or_cut_short_is_a_bad_request() -> None:
    raw = json.dumps({"content": "x" * 5000}).encode()
    assert (await _post(_app(), raw, {"content-encoding": "gzip"})).status_code == 400
    assert (await _post(_app(), gzip.compress(raw)[:-20], {"content-encoding": "gzip"})).status_code == 400
