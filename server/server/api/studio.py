"""演播台 (Studio) API 网关：桥接 filmkit 多引擎漫剧制作引擎，并将成片归档至 Memento 媒体库后一键发送到对话内联播放。"""

from __future__ import annotations

from contextvars import ContextVar
import logging
import re
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import get_current_user, get_current_user_or_collector, verify_collector_token
from ..services.ask_store import append_conversation_turns, bust_conv_list, get_or_create_conversation
from ..services.plugin_service import is_plugin_ready, resolve_studio_connection
from ..services.storage_service import sign_video_url, store_video_bytes

router = APIRouter(prefix="/api/studio", tags=["studio"])
logger = logging.getLogger("server.studio")

_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_\-.:]{1,80}$")
_current_studio_conn: ContextVar[tuple[str, str] | None] = ContextVar("_current_studio_conn", default=None)


async def _require_studio_plugin(user: User = Depends(get_current_user)) -> User:
    _current_studio_conn.set(resolve_studio_connection(user))
    return user


def _filmkit_base() -> str:
    conn = _current_studio_conn.get()
    if conn and conn[0]:
        return conn[0]
    return (settings.studio_filmkit_url or "http://127.0.0.1:8765").strip().rstrip("/")


def _filmkit_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    headers: dict[str, str] = {}
    conn = _current_studio_conn.get()
    token = conn[1] if conn is not None else (settings.studio_filmkit_token or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if extra:
        headers.update(extra)
    return headers


def _check_id(value: str, label: str = "id") -> str:
    if not _SAFE_ID_RE.match(value or ""):
        raise HTTPException(status_code=400, detail=f"非法的 {label}")
    return value


async def _proxy_json(
    method: str,
    path: str,
    *,
    payload: Any = None,
    params: dict[str, Any] | None = None,
    extra_headers: dict[str, str] | None = None,
    timeout: float = 120.0,
) -> Any:
    url = f"{_filmkit_base()}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(
                method,
                url,
                json=payload,
                params=params,
                headers=_filmkit_headers(extra_headers),
            )
    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail=f"演播台引擎 (filmkit) 未启动或不可达 ({_filmkit_base()})，请先启动 filmkit serve",
        )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="演播台引擎请求超时")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"演播台引擎通信失败: {e}")

    if resp.status_code >= 400:
        detail: Any = resp.text[:400]
        try:
            body = resp.json()
            if isinstance(body, dict) and "detail" in body:
                detail = body["detail"]
        except Exception:
            pass
        raise HTTPException(status_code=resp.status_code, detail=detail)

    if not resp.content:
        return {"ok": True}
    try:
        return resp.json()
    except Exception:
        return {"raw": resp.text}


class PublishToChatReq(BaseModel):
    conversation_id: str | None = None
    task_id: str | None = None
    note: str = Field(default="", max_length=500)


# ---------- Health & Compute ----------

@router.get("/health")
async def studio_health(user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        base, token = resolve_studio_connection(user)
    except HTTPException as exc:
        return {
            "online": False,
            "installed": is_plugin_ready(user, "studio"),
            "configured": False,
            "filmkit_url": "",
            "compute": None,
            "error": str(exc.detail),
        }
    _current_studio_conn.set((base, token))
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{base}/health", headers=_filmkit_headers())
            if r.status_code != 200:
                return {"online": False, "installed": True, "configured": True, "filmkit_url": base, "error": f"HTTP {r.status_code}"}
            compute = None
            try:
                rc = await client.get(f"{base}/api/studio/compute/status", headers=_filmkit_headers())
                if rc.status_code == 200:
                    compute = (rc.json() or {}).get("compute")
            except Exception:
                pass
            return {"online": True, "installed": True, "configured": True, "filmkit_url": base, "compute": compute, "error": ""}
    except Exception as e:
        return {"online": False, "installed": True, "configured": True, "filmkit_url": base, "compute": None, "error": str(e)}


@router.get("/compute/status")
async def compute_status(_user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("GET", "/api/studio/compute/status", timeout=15.0)


@router.post("/compute/start")
async def compute_start(request: Request, _user: User = Depends(_require_studio_plugin)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json("POST", "/api/studio/compute/start", payload=body, timeout=30.0)


@router.post("/compute/stop")
async def compute_stop(_user: User = Depends(_require_studio_plugin)):
    # filmkit 停机后要核实 Colab 真的释放（一般 10 秒左右，unassign 失败重试时最长约 2 分钟）
    return await _proxy_json("POST", "/api/studio/compute/stop", timeout=150.0)


@router.post("/compute/extend")
async def compute_extend(request: Request, _user: User = Depends(_require_studio_plugin)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json("POST", "/api/studio/compute/extend", payload=body, timeout=15.0)


# ---------- Projects, Characters, Voices & BGM ----------

@router.get("/presets")
async def list_presets(_user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("GET", "/api/studio/presets")


@router.get("/projects")
async def list_projects(_user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("GET", "/api/studio/projects")


@router.post("/projects")
async def create_project(request: Request, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("POST", "/api/studio/projects", payload=await request.json())


@router.get("/projects/{pid}")
async def get_project(pid: str, _user: User = Depends(_require_studio_plugin)):
    clean_pid = _check_id(pid, "project_id")
    projs_res = await _proxy_json("GET", "/api/studio/projects")
    proj = next((p for p in (projs_res.get("projects") or []) if p.get("id") == clean_pid), None)
    if not proj:
        raise HTTPException(status_code=404, detail="项目不存在")
    chars_res = await _proxy_json("GET", f"/api/studio/projects/{clean_pid}/characters")
    eps_res = await _proxy_json("GET", f"/api/studio/projects/{clean_pid}/episodes")
    return {
        "project": proj,
        "characters": chars_res.get("characters") or [],
        "episodes": eps_res.get("episodes") or [],
    }


@router.get("/projects/{pid}/characters")
async def list_project_characters(pid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("GET", f"/api/studio/projects/{_check_id(pid, 'project_id')}/characters")


@router.get("/projects/{pid}/episodes")
async def list_project_episodes(pid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("GET", f"/api/studio/projects/{_check_id(pid, 'project_id')}/episodes")


@router.delete("/projects/{pid}")
async def delete_project(pid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("DELETE", f"/api/studio/projects/{_check_id(pid, 'project_id')}")


@router.post("/projects/{pid}/characters")
async def create_character(pid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "POST",
        f"/api/studio/projects/{_check_id(pid, 'project_id')}/characters",
        payload=await request.json(),
    )


@router.patch("/characters/{cid}")
async def update_character(cid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "PATCH",
        f"/api/studio/characters/{_check_id(cid, 'character_id')}",
        payload=await request.json(),
    )


@router.delete("/characters/{cid}")
async def delete_character(cid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("DELETE", f"/api/studio/characters/{_check_id(cid, 'character_id')}")


@router.get("/voices")
async def list_voices(_user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("GET", "/api/studio/voices")


@router.post("/voices/preview")
async def preview_voice(request: Request, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("POST", "/api/studio/voices/preview", payload=await request.json(), timeout=90.0)


@router.get("/bgm")
async def list_bgm(_user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("GET", "/api/studio/bgm")


@router.post("/bgm/generate")
async def generate_bgm(request: Request, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("POST", "/api/studio/bgm/generate", payload=await request.json(), timeout=240.0)


# ---------- Episodes & Shots ----------

@router.post("/projects/{pid}/episodes")
async def create_episode(pid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "POST",
        f"/api/studio/projects/{_check_id(pid, 'project_id')}/episodes",
        payload=await request.json(),
    )


@router.get("/episodes/{eid}")
async def get_episode(eid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("GET", f"/api/studio/episodes/{_check_id(eid, 'episode_id')}")


@router.patch("/episodes/{eid}")
async def update_episode(eid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "PATCH",
        f"/api/studio/episodes/{_check_id(eid, 'episode_id')}",
        payload=await request.json(),
    )


@router.post("/episodes/{eid}/breakdown")
async def breakdown_episode(eid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "POST",
        f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/ai-breakdown",
        payload=await request.json(),
        timeout=180.0,
    )


@router.post("/episodes/{eid}/sync-audio-durations")
async def sync_audio_durations(eid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "POST",
        f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/sync-audio-durations",
        timeout=240.0,
    )


@router.post("/episodes/{eid}/render")
async def render_episode(eid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("POST", f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/render", timeout=60.0)


@router.post("/episodes/{eid}/shots")
async def add_shot(eid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "POST",
        f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/shots",
        payload=await request.json(),
    )


@router.patch("/shots/{sid}")
async def update_shot(sid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "PATCH",
        f"/api/studio/shots/{_check_id(sid, 'shot_id')}",
        payload=await request.json(),
    )


@router.delete("/shots/{sid}")
async def delete_shot(sid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("DELETE", f"/api/studio/shots/{_check_id(sid, 'shot_id')}")


@router.post("/shots/{sid}/generate")
async def generate_shot(sid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "POST",
        f"/api/studio/shots/{_check_id(sid, 'shot_id')}/generate",
        payload=await request.json(),
        timeout=240.0,
    )


@router.post("/shots/{sid}/pick")
async def pick_shot(sid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "POST",
        f"/api/studio/shots/{_check_id(sid, 'shot_id')}/pick",
        payload=await request.json(),
    )


@router.post("/shots/{sid}/tts-preview")
async def shot_tts_preview(sid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "POST",
        f"/api/studio/shots/{_check_id(sid, 'shot_id')}/tts-preview",
        timeout=120.0,
    )


@router.post("/shots/{sid}/animate")
async def animate_shot(sid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "POST",
        f"/api/studio/shots/{_check_id(sid, 'shot_id')}/animate",
        timeout=600.0,
    )


@router.post("/shots/{sid}/use-prev-last-frame")
async def use_prev_last_frame(sid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "POST",
        f"/api/studio/shots/{_check_id(sid, 'shot_id')}/use-prev-last-frame",
        timeout=60.0,
    )


@router.post("/shots/{sid}/lipsync")
async def lipsync_shot(sid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "POST",
        f"/api/studio/shots/{_check_id(sid, 'shot_id')}/lipsync",
        timeout=600.0,
    )


@router.post("/episodes/{eid}/batch-generate")
async def batch_generate_episode(eid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json(
        "POST",
        f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/batch-generate",
        payload=body,
        timeout=30.0,
    )


@router.post("/episodes/{eid}/batch-animate")
async def batch_animate_episode(eid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json(
        "POST",
        f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/batch-animate",
        payload=body,
        timeout=30.0,
    )


@router.get("/episodes/{eid}/batch-status")
async def get_batch_status(eid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "GET",
        f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/batch-status",
        timeout=15.0,
    )


@router.get("/tasks/{task_id}")
async def get_task(task_id: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("GET", f"/api/tasks/{_check_id(task_id, 'task_id')}")


# ---------- Asset & Video Proxies ----------

async def _require_media_user(
    authorization: str | None = Header(None),
    token: str | None = Query(None),
    x_collector_token: str | None = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    auth_header = authorization or (f"Bearer {token.strip()}" if token and token.strip() else None)
    if not auth_header and x_collector_token:
        # Mac 上的本机分发代理用设备令牌拉成片与封面
        user = await verify_collector_token(x_collector_token, db)
    else:
        user = await get_current_user(auth_header, db)
    _current_studio_conn.set(resolve_studio_connection(user))
    return user


@router.get("/assets")
async def proxy_asset(
    path: str = Query(..., min_length=1, max_length=400),
    range_header: str | None = Header(None, alias="Range"),
    _user: User = Depends(_require_media_user),
):
    """Stream studio thumbnails, audio previews, shot clips and deduped publish MP4s from filmkit."""
    url = f"{_filmkit_base()}/api/assets"
    headers = _filmkit_headers({"Range": range_header} if range_header else None)
    client = httpx.AsyncClient(timeout=300.0)
    try:
        req = client.build_request("GET", url, params={"path": path}, headers=headers)
        resp = await client.send(req, stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"演播台素材拉取失败: {e}")

    if resp.status_code >= 400:
        await resp.aclose()
        await client.aclose()
        raise HTTPException(status_code=resp.status_code, detail="素材不存在或不可访问")

    out_headers = {}
    for hk in ("content-type", "content-range", "accept-ranges", "content-length"):
        if hk in resp.headers:
            out_headers[hk] = resp.headers[hk]
    out_headers.setdefault("cache-control", "private, max-age=300")

    async def _gen():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=512 * 1024):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(
        _gen(),
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/octet-stream"),
        headers=out_headers,
    )


@router.get("/tasks/{task_id}/video")
async def proxy_task_video(
    task_id: str,
    range_header: str | None = Header(None, alias="Range"),
    _user: User = Depends(_require_media_user),
):
    """Stream rendered task MP4 from filmkit with HTTP 206 Range forwarding."""
    tid = _check_id(task_id, "task_id")
    url = f"{_filmkit_base()}/api/tasks/{tid}/video"
    headers = _filmkit_headers({"Range": range_header} if range_header else None)

    client = httpx.AsyncClient(timeout=120.0)
    try:
        req = client.build_request("GET", url, headers=headers)
        resp = await client.send(req, stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"视频流拉取失败: {e}")

    if resp.status_code >= 400:
        await resp.aclose()
        await client.aclose()
        raise HTTPException(status_code=resp.status_code, detail="成片视频尚未就绪")

    out_headers = {}
    for hk in ("content-range", "accept-ranges", "content-length", "etag", "last-modified"):
        if hk in resp.headers:
            out_headers[hk] = resp.headers[hk]
    out_headers.setdefault("etag", f'"studio-task-{tid}"')
    out_headers["cache-control"] = "private, max-age=604800, immutable"

    async def _gen():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=512 * 1024):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(
        _gen(),
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "video/mp4"),
        headers=out_headers,
    )


@router.get("/episodes/{eid}/stream-status")
async def episode_stream_status(eid: str, _user: User = Depends(_require_studio_plugin)):
    """在线观看版压好没有（没压好会顺带在后台开压）。播放页据此决定带不带 quality=stream。"""
    try:
        return await _proxy_json(
            "GET", f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/stream-video", params={"check": "true"}, timeout=20.0,
        )
    except HTTPException as exc:
        if exc.status_code == 404:
            return {"ready": False, "variant": ""}
        raise


@router.get("/episodes/{eid}/latest-video")
async def proxy_episode_latest_video(
    eid: str,
    v: str | None = Query(None),
    quality: str | None = Query(None),
    range_header: str | None = Header(None, alias="Range"),
    _user: User = Depends(_require_media_user),
):
    """Stream the latest rendered MP4 of an episode (from last_task or canonical films/<slug>_final.mp4).

    quality=stream 先给在线观看版（短边 720、约 1.4 Mbps）：公网入口出口约 3.25 Mbps，1080P 原片直接播会卡；
    还没压好时 filmkit 返回 404 并在后台开压，这里接着回落到原片。"""
    detail = await _proxy_json("GET", f"/api/studio/episodes/{_check_id(eid, 'episode_id')}")
    ep = detail.get("episode") or {}
    proj = detail.get("project") or {}
    tid = (ep.get("last_task_id") or "").strip()
    headers = _filmkit_headers({"Range": range_header} if range_header else None)
    slug_name = f"{proj.get('slug', '')}_{ep.get('slug', '')}".strip("_")
    candidates = []
    if isinstance(quality, str) and quality.strip() == "stream":
        candidates.append((f"{_filmkit_base()}/api/studio/episodes/{eid}/stream-video", None))
    if tid:
        candidates.append((f"{_filmkit_base()}/api/tasks/{tid}/video", None))
    if slug_name:
        candidates.append((f"{_filmkit_base()}/api/studio/episodes/{eid}/video", None))
        candidates.append((f"{_filmkit_base()}/api/assets", {"path": f"films/{slug_name}/{slug_name}_final.mp4"}))

    for url, params in candidates:
        client = httpx.AsyncClient(timeout=120.0)
        try:
            req = client.build_request("GET", url, params=params, headers=headers)
            resp = await client.send(req, stream=True)
            if resp.status_code in (200, 206):
                out_headers = {
                    hk: resp.headers[hk]
                    for hk in ("content-range", "accept-ranges", "content-length", "etag", "last-modified")
                    if hk in resp.headers
                }
                version_tag = tid or slug_name or eid
                variant = "-stream" if url.endswith("/stream-video") else ""
                out_headers.setdefault("etag", f'"studio-ep-{eid}-{version_tag}{variant}"')
                if v and tid and v.strip() == tid:
                    out_headers["cache-control"] = "private, max-age=604800, immutable"
                else:
                    out_headers["cache-control"] = "private, max-age=3600"

                async def _gen(_resp=resp, _client=client):
                    try:
                        async for chunk in _resp.aiter_bytes(chunk_size=512 * 1024):
                            yield chunk
                    finally:
                        await _resp.aclose()
                        await _client.aclose()

                return StreamingResponse(
                    _gen(),
                    status_code=resp.status_code,
                    media_type=resp.headers.get("content-type", "video/mp4"),
                    headers=out_headers,
                )
            await resp.aclose()
            await client.aclose()
        except httpx.HTTPError:
            await client.aclose()
            continue

    raise HTTPException(status_code=404, detail="该剧集尚未渲染出可播放成片")


# ---------- Archive & Publish directly into Memento /ask Chat ----------

@router.post("/episodes/{eid}/publish-to-chat")
async def publish_episode_to_chat(
    eid: str,
    body: PublishToChatReq,
    user: User = Depends(_require_studio_plugin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """将演播台成片持久化归档到 Memento S3/媒体库，并直接写入对话气泡实现内联播放、全屏与缓存。"""
    clean_eid = _check_id(eid, "episode_id")
    detail = await _proxy_json("GET", f"/api/studio/episodes/{clean_eid}")
    ep = detail.get("episode") or {}
    proj = detail.get("project") or {}
    shots = detail.get("shots") or []

    proj_name = (proj.get("name") or "未命名项目").strip()
    ep_title = (ep.get("title") or "成片").strip()
    slug_name = f"{proj.get('slug', 'studio')}_{ep.get('slug', 'ep')}".strip("_")
    tid = (body.task_id or ep.get("last_task_id") or "").strip()

    # 按优先级从 filmkit 拉取最终 MP4 字节
    mp4_bytes: bytes | None = None
    candidates: list[tuple[str, dict[str, str] | None]] = []
    if tid:
        candidates.append((f"{_filmkit_base()}/api/tasks/{_check_id(tid, 'task_id')}/video", None))
    candidates.append((f"{_filmkit_base()}/api/studio/episodes/{clean_eid}/video", None))
    candidates.append((f"{_filmkit_base()}/api/assets", {"path": f"films/{slug_name}/{slug_name}_final.mp4"}))

    async with httpx.AsyncClient(timeout=180.0) as client:
        for url, params in candidates:
            try:
                r = await client.get(url, params=params, headers=_filmkit_headers())
                if r.status_code == 200 and len(r.content) > 4096:
                    mp4_bytes = r.content
                    break
            except httpx.HTTPError:
                continue

    if not mp4_bytes:
        raise HTTPException(status_code=404, detail="未找到该剧集的已渲染 MP4 成片，请先点击合成母带")

    canonical_video_url = await store_video_bytes(
        str(user.id),
        f"{slug_name}_final.mp4",
        mp4_bytes,
        content_type="video/mp4",
    )
    signed_video_url = sign_video_url(canonical_video_url)

    total_sec = sum(float(s.get("duration") or 0) for s in shots)
    display_title = f"《{proj_name}》{ep_title}"
    size_mb = len(mp4_bytes) / (1024 * 1024)
    user_prompt = (body.note or "").strip() or f"从演播台发布成片：{display_title}"
    assistant_md = (
        f"演播台成片已归档，可直接在对话内播放、全屏或缓存（{len(shots)} 镜 · 约 {total_sec:.1f}s · {size_mb:.1f} MB）：\n\n"
        f"![{display_title}]({canonical_video_url})\n\n"
        f"- 在演播台继续精修：[{display_title}](/studio?project={proj.get('id', '')}&episode={clean_eid})"
    )

    conv_id, conv_title, _cfg = await get_or_create_conversation(
        body.conversation_id,
        user,
        question=f"演播台成片 · {display_title}",
        device_id=None,
        cwd=None,
        config={"execution_mode": "ai"},
    )
    await append_conversation_turns(
        conv_id,
        user_content=user_prompt,
        assistant_content=assistant_md,
        user_id=user.id,
    )
    await bust_conv_list(user.id)

    return {
        "ok": True,
        "conversation_id": str(conv_id),
        "conversation_title": conv_title,
        "title": display_title,
        "video_url": signed_video_url,
        "canonical_video_url": canonical_video_url,
        "size_bytes": len(mp4_bytes),
    }


# ---------- Settings, Story Confirm & Batch Upscale ----------

@router.get("/settings")
async def get_studio_settings(_user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("GET", "/api/studio/settings", timeout=15.0)


@router.put("/settings")
async def update_studio_settings(request: Request, _user: User = Depends(_require_studio_plugin)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json("PUT", "/api/studio/settings", payload=body, timeout=15.0)


@router.post("/episodes/{eid}/confirm-story")
async def confirm_episode_story(eid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    body = await request.json() if await request.body() else {"confirmed": True}
    return await _proxy_json(
        "POST",
        f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/confirm-story",
        payload=body,
        timeout=15.0,
    )


@router.post("/episodes/{eid}/batch-upscale")
async def batch_upscale_episode(eid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json(
        "POST",
        f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/batch-upscale",
        payload=body,
        timeout=30.0,
    )


# ---------- Multi-Platform Video Publish Center ----------

def _public_asset_headers(request: Request) -> dict[str, str]:
    """透传公网可访问的素材网关地址与当前用户鉴权头，供 Mac 本机分发代理拉取成片与封面。"""
    pub = (settings.public_url or "").strip().rstrip("/")
    if not pub:
        proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "https").split(",")[0].strip()
        host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
        if host:
            pub = f"{proto}://{host}"
    headers: dict[str, str] = {}
    if pub:
        headers["X-Public-Asset-Base"] = f"{pub}/api/studio/assets"
    auth = (request.headers.get("authorization") or "").strip()
    if auth:
        headers["X-Public-Asset-Auth"] = auth
    return headers


@router.get("/publish/platforms")
async def get_publish_platforms(_user: User = Depends(_require_studio_plugin)):
    return await _proxy_json("GET", "/api/studio/publish/platforms", timeout=15.0)


async def _require_agent_device(user: User = Depends(get_current_user_or_collector)) -> User:
    """本机分发代理（拉模式）用设备令牌来心跳、领任务、回报进度。"""
    _current_studio_conn.set(resolve_studio_connection(user))
    return user


@router.post("/publish/agent/heartbeat")
async def publish_agent_heartbeat(request: Request, _user: User = Depends(_require_agent_device)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json("POST", "/api/studio/publish/agent/heartbeat", payload=body, timeout=15.0)


@router.post("/publish/agent/claim")
async def publish_agent_claim(request: Request, _user: User = Depends(_require_agent_device)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json("POST", "/api/studio/publish/agent/claim", payload=body, timeout=15.0)


@router.post("/publish/agent/report")
async def publish_agent_report(request: Request, _user: User = Depends(_require_agent_device)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json("POST", "/api/studio/publish/agent/report", payload=body, timeout=15.0)


@router.post("/publish/agent/login")
async def trigger_publish_agent_login(request: Request, _user: User = Depends(_require_studio_plugin)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json("POST", "/api/studio/publish/agent/login", payload=body, timeout=20.0)


@router.get("/episodes/{eid}/publish")
async def get_episode_publish_overview(eid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "GET",
        f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/publish",
        timeout=30.0,
    )


@router.post("/episodes/{eid}/publish/prepare")
async def prepare_episode_publish(eid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json(
        "POST",
        f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/publish/prepare",
        payload=body,
        timeout=240.0,
    )


@router.patch("/publish/jobs/{jid}")
async def patch_publish_job(jid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json(
        "PATCH",
        f"/api/studio/publish/jobs/{_check_id(jid, 'job_id')}",
        payload=body,
        timeout=30.0,
    )


@router.delete("/publish/jobs/{jid}")
async def delete_publish_job(jid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "DELETE",
        f"/api/studio/publish/jobs/{_check_id(jid, 'job_id')}",
        timeout=30.0,
    )


@router.post("/publish/jobs/{jid}/dispatch")
async def dispatch_publish_job(jid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json(
        "POST",
        f"/api/studio/publish/jobs/{_check_id(jid, 'job_id')}/dispatch",
        payload=body,
        extra_headers=_public_asset_headers(request),
        timeout=30.0,
    )


@router.post("/episodes/{eid}/publish/dispatch-batch")
async def dispatch_batch_publish(eid: str, request: Request, _user: User = Depends(_require_studio_plugin)):
    body = await request.json() if await request.body() else {}
    return await _proxy_json(
        "POST",
        f"/api/studio/episodes/{_check_id(eid, 'episode_id')}/publish/dispatch-batch",
        payload=body,
        extra_headers=_public_asset_headers(request),
        timeout=60.0,
    )


@router.get("/publish/jobs/{jid}/sync")
async def sync_publish_job(jid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "GET",
        f"/api/studio/publish/jobs/{_check_id(jid, 'job_id')}/sync",
        timeout=15.0,
    )


@router.post("/publish/jobs/{jid}/confirm")
async def confirm_publish_job(jid: str, _user: User = Depends(_require_studio_plugin)):
    return await _proxy_json(
        "POST",
        f"/api/studio/publish/jobs/{_check_id(jid, 'job_id')}/confirm",
        payload={},
        timeout=15.0,
    )


@router.get("/episodes/{eid}/publish/bundle.zip")
async def download_publish_bundle(eid: str, _user: User = Depends(_require_media_user)):
    """流式下载该剧集的多平台差异化分发包 ZIP。"""
    clean_eid = _check_id(eid, "episode_id")
    url = f"{_filmkit_base()}/api/studio/episodes/{clean_eid}/publish/bundle.zip"
    client = httpx.AsyncClient(timeout=180.0)
    try:
        req = client.build_request("GET", url, headers=_filmkit_headers())
        resp = await client.send(req, stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"拉取多平台分发包失败: {e}")

    if resp.status_code >= 400:
        await resp.aclose()
        await client.aclose()
        raise HTTPException(status_code=resp.status_code, detail="尚未生成多平台发布包")

    out_headers: dict[str, str] = {}
    for hk in ("content-disposition", "content-length"):
        if hk in resp.headers:
            out_headers[hk] = resp.headers[hk]
    out_headers.setdefault("content-disposition", f'attachment; filename="{clean_eid}_publish_bundle.zip"')

    async def _gen():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=512 * 1024):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(
        _gen(),
        status_code=resp.status_code,
        media_type="application/zip",
        headers=out_headers,
    )
