"""Previewing a local web server on one of the user's devices (a dev server an agent or the terminal started).

The page asks which ports are listening there, gets a preview token for one (bound to the user, device and
port, two hours) and loads `/api/preview/t/<token>/...` in an iframe. Each request is fetched from the device's
localhost by the daemon (preview_http_req) and passed back.

Served from this site's own origin, the previewed page's scripts could read Memento's sign-in: every response
carries `Content-Security-Policy: sandbox` (no allow-same-origin), so the page runs in an opaque origin of its
own. Paths starting with `/` in HTML, JS and CSS are rewritten under the preview prefix (dev servers use them
for every asset), and responses allow any origin so module scripts load from the sandboxed page. WebSockets
(hot reload) aren't relayed: the page works, it just doesn't refresh by itself.
"""

from __future__ import annotations

import base64
import json
import re
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services import device_reports
from ..services.cluster import cluster
from ..services.ws_manager import ws_manager
from .git_review import _resolve_device

router = APIRouter(prefix="/api/preview", tags=["preview"])

_TOKEN_KEY = "memento:preview:"
_TOKEN_TTL = 2 * 3600
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,64}$")
_local: dict[str, str] = {}
_PASS_REQ = ("accept", "accept-language", "content-type", "cache-control", "if-none-match", "if-modified-since", "range", "x-requested-with")
_DROP_RES = {"content-security-policy", "x-frame-options", "set-cookie", "strict-transport-security", "access-control-allow-origin"}


class PreviewSession(BaseModel):
    device_id: str = Field(..., min_length=1)
    port: int = Field(..., ge=1, le=65535)


async def _kv_set(key: str, value: str) -> None:
    r = cluster.redis
    if r is None:
        _local[key] = value
    else:
        await r.set(key, value, ex=_TOKEN_TTL)


async def _kv_get(key: str) -> str | None:
    r = cluster.redis
    if r is None:
        return _local.get(key)
    raw = await r.get(key)
    return raw.decode() if isinstance(raw, bytes) else raw


async def _ask(candidates: list[str], payload: dict, timeout: float) -> dict:
    resp: dict = {"error": "设备不在线", "code": "offline"}
    for cand in candidates:
        resp = await ws_manager.request_device(cand, payload, timeout=timeout)
        if resp.get("code") != "offline":
            break
    return resp


async def _device(db: AsyncSession, device_id: str, user: User) -> list[str]:
    machine, candidates = await _resolve_device(db, device_id, user)
    if not device_reports.device_has_feature(machine.name, "preview", user):
        raise HTTPException(status_code=400, detail="这台设备的 Memento 还不支持预览，升级到 1.0.165 及以上后再试")
    return candidates


@router.get("/ports")
async def preview_ports(device_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Ports listening on the device that look like dev servers."""
    resp = await _ask(await _device(db, device_id, user), {"type": "preview_ports_req"}, 10.0)
    if resp.get("code") == "offline":
        raise HTTPException(status_code=503, detail="目标设备当前不在线")
    if not resp.get("ok"):
        raise HTTPException(status_code=400, detail=resp.get("error") or "读取端口失败")
    return {"ports": resp.get("ports") or []}


@router.post("/session")
async def preview_session(body: PreviewSession, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    candidates = await _device(db, body.device_id, user)
    token = secrets.token_urlsafe(24)
    await _kv_set(_TOKEN_KEY + token, json.dumps({"user": str(user.id), "devices": candidates, "port": body.port}))
    return {"token": token, "url": f"/api/preview/t/{token}/"}


# ── rewriting absolute paths under the preview prefix ──────────────────────────────────────────────

_HTML_ATTR = re.compile(r"""(\s(?:src|href|action|poster|data-src)\s*=\s*["'])/(?!/)""", re.IGNORECASE)
_JS_IMPORT = re.compile(r"""((?:\bfrom|\bimport)\s*\(?\s*["'])/(?!/)""")
_CSS_URL = re.compile(r"""(url\(\s*["']?)/(?!/)""")
_CSS_IMPORT = re.compile(r"""(@import\s+["'])/(?!/)""")


def rewrite_paths(body: str, content_type: str, prefix: str) -> str:
    """`/x` -> `<prefix>x` where a dev server's HTML, JS or CSS refers to its own root (protocol-relative `//`
    and full URLs are left alone)."""
    ct = content_type.lower()
    if "html" in ct:
        body = _HTML_ATTR.sub(lambda m: m.group(1) + prefix, body)
        body = _JS_IMPORT.sub(lambda m: m.group(1) + prefix, body)
        body = _CSS_URL.sub(lambda m: m.group(1) + prefix, body)
    elif "javascript" in ct or "ecmascript" in ct:
        body = _JS_IMPORT.sub(lambda m: m.group(1) + prefix, body)
    elif "css" in ct:
        body = _CSS_URL.sub(lambda m: m.group(1) + prefix, body)
        body = _CSS_IMPORT.sub(lambda m: m.group(1) + prefix, body)
    return body


def rewrite_location(location: str, port: int, prefix: str) -> str:
    """A redirect to the dev server's own root (or to localhost:<port>) stays inside the preview."""
    for origin in (f"http://localhost:{port}", f"http://127.0.0.1:{port}", f"http://0.0.0.0:{port}"):
        if location.startswith(origin):
            location = location[len(origin):] or "/"
            break
    if location.startswith("/") and not location.startswith("//"):
        return prefix + location[1:]
    return location


@router.api_route("/t/{token}/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def preview_proxy(token: str, path: str, request: Request):
    """One request of the previewed page, fetched from the device's localhost. The token is the credential."""
    if not _TOKEN_RE.match(token):
        raise HTTPException(status_code=404)
    raw = await _kv_get(_TOKEN_KEY + token)
    if not raw:
        return Response("预览已过期，回到 Memento 重新打开预览", status_code=410, media_type="text/plain; charset=utf-8")
    info = json.loads(raw)
    port = int(info["port"])
    prefix = f"/api/preview/t/{token}/"
    target = "/" + path + (f"?{request.url.query}" if request.url.query else "")
    body = await request.body()
    payload = {
        "type": "preview_http_req",
        "port": port,
        "method": request.method,
        "path": target,
        "headers": {k: v for k, v in request.headers.items() if k.lower() in _PASS_REQ},
        **({"body_b64": base64.b64encode(body).decode()} if body else {}),
    }
    resp = await _ask(list(info.get("devices") or []), payload, 30.0)
    if not resp.get("ok"):
        status = 503 if resp.get("code") == "offline" else 502
        return Response(resp.get("error") or "预览请求失败", status_code=status, media_type="text/plain; charset=utf-8")

    content = base64.b64decode(resp.get("body_b64") or "")
    headers = {k: v for k, v in (resp.get("headers") or {}).items() if k.lower() not in _DROP_RES}
    ctype = headers.get("content-type", "")
    if any(t in ctype.lower() for t in ("html", "javascript", "ecmascript", "css")):
        try:
            content = rewrite_paths(content.decode("utf-8"), ctype, prefix).encode("utf-8")
        except UnicodeDecodeError:
            pass
    if "location" in headers:
        headers["location"] = rewrite_location(headers["location"], port, prefix)
    # An opaque origin of its own: the previewed page can't reach this site's storage or sign-in
    headers["content-security-policy"] = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads"
    headers["access-control-allow-origin"] = "*"
    headers["cache-control"] = "no-store"
    return Response(content=content, status_code=int(resp.get("status") or 200), headers=headers)
