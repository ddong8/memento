"""Documents API — view individual documents and their history."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import defer
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    Document, KnowledgeEntity, KnowledgeObservation, User,
)
from ..db.session import get_db
from ..middleware.access_log import log_access
from ..middleware.auth import get_current_user, get_optional_user
from ..services.permission_service import can_view_document
from ..services.user_filter import apply_user_filter, user_machine_ids

router = APIRouter(prefix="/api/documents", tags=["documents"])


async def _get_doc_with_permission(
    doc_id: uuid.UUID, db: AsyncSession, user: User | None,
    mids: list | None = None,
    include_content: bool = True,
) -> Document:
    query = select(Document).where(Document.id == doc_id).options(
        defer(Document.content_tsv),
        defer(Document.rendered_html),
    )
    if not include_content:
        query = query.options(defer(Document.content), defer(Document.metadata_))
    result = await db.execute(query)
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404)
    if not await can_view_document(db, user, doc):
        raise HTTPException(status_code=404)  # 404 to hide existence
    if mids is not None and doc.machine_id not in mids:
        raise HTTPException(status_code=404)
    return doc


_PROXY_MAX_BYTES = 5 * 1024 * 1024
_PROXY_MAX_REDIRECTS = 5
_PROXY_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "text/markdown, text/plain, text/html, */*",
}


async def _resolve(host: str, port: int) -> list[str]:
    import asyncio
    import socket

    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


async def _public_addresses(host: str, port: int) -> list[str]:
    """The addresses of ``host``, IPv4 first, all on the public internet. A name that resolves to anything
    else (a cluster service like ``minio``, the LAN, loopback, link-local metadata) is refused."""
    import ipaddress
    import socket

    try:
        addrs = await _resolve(host, port)
    except socket.gaierror:
        raise HTTPException(status_code=502, detail=f"无法解析域名 {host}")
    if not addrs or not all(ipaddress.ip_address(a.split("%")[0]).is_global for a in addrs):
        raise HTTPException(status_code=403, detail="不允许访问内网地址")
    return sorted(dict.fromkeys(addrs), key=lambda a: ":" in a)


@router.get("/proxy-fetch")
async def proxy_fetch_document(
    url: str = Query(..., description="External document URL to proxy"),
    user: User = Depends(get_current_user),
) -> dict:
    """Proxy fetch an external documentation file (e.g. Apple technotes, GitHub raw, etc.)
    to bypass browser CORS restrictions and render safely in the workbench inspector.

    Each hop (redirects included) connects to the address that was checked, so a name can't resolve to
    a public address for the check and to an internal one for the request."""
    from urllib.parse import urljoin, urlparse

    import httpx

    current = url.strip()
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
        for _ in range(_PROXY_MAX_REDIRECTS + 1):
            parsed = urlparse(current)
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise HTTPException(status_code=400, detail="只支持 http / https 地址")
            if parsed.username or parsed.password:
                raise HTTPException(status_code=400, detail="地址里不能带用户名密码")
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            addrs = await _public_addresses(parsed.hostname, port)
            host_header = parsed.hostname if parsed.port is None else f"{parsed.hostname}:{parsed.port}"
            last_error: Exception | None = None
            for ip in addrs[:4]:
                pinned = parsed._replace(netloc=f"[{ip}]:{port}" if ":" in ip else f"{ip}:{port}").geturl()
                try:
                    result = await _fetch_pinned(client, pinned, host_header, parsed.hostname)
                except (httpx.ConnectError, httpx.ConnectTimeout) as e:
                    last_error = e  # some sites' addresses are unreachable from here: try the next one
                    continue
                except httpx.RequestError as e:
                    raise HTTPException(status_code=502, detail=f"读取对方网站失败：{type(e).__name__} {e}")
                break
            else:
                raise HTTPException(status_code=502, detail=f"连不上对方网站：{type(last_error).__name__}")
            if isinstance(result, str):
                current = urljoin(current, result)  # a redirect
                continue
            return {"url": current, **result}
    raise HTTPException(status_code=502, detail="重定向次数过多")


async def _fetch_pinned(client, url: str, host: str, sni: str) -> str | dict:
    """GET from one address: the redirect target, or {content, content_type}."""
    async with client.stream("GET", url, headers={**_PROXY_HEADERS, "Host": host}, extensions={"sni_hostname": sni}) as resp:
        if resp.is_redirect and resp.headers.get("location"):
            return resp.headers["location"]
        if resp.status_code != 200:
            # Never passed through as is: a 401 from that site would log the user out here
            raise HTTPException(status_code=502, detail=f"对方网站返回 HTTP {resp.status_code}")
        body = bytearray()
        async for chunk in resp.aiter_bytes():
            body.extend(chunk)
            if len(body) >= _PROXY_MAX_BYTES:
                del body[_PROXY_MAX_BYTES:]
                break
        return {
            "content": body.decode("utf-8", errors="replace"),
            "content_type": resp.headers.get("content-type", "text/markdown"),
        }


@router.get("/{doc_id}")
async def get_document(
    doc_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_optional_user),
    _user: User = Depends(get_current_user),
) -> dict:
    mids = await user_machine_ids(db, _user)
    doc = await _get_doc_with_permission(doc_id, db, user, mids)
    await log_access(db, request, "view_document", user.id if user else None, doc.id)

    content = doc.content
    if doc.content_s3_key and doc.file_size_bytes > len(doc.content or ""):
        from ..services.storage_service import get_text
        s3_text = await get_text(doc.content_s3_key)
        if s3_text is not None:
            content = s3_text

    return {
        "id": str(doc.id),
        "tool_id": doc.tool_id,
        "project_id": str(doc.project_id) if doc.project_id else None,
        "relative_path": doc.relative_path,
        "category": doc.category,
        "content_type": doc.content_type,
        "title": doc.title,
        "content": content,
        "content_hash": doc.content_hash,
        "file_size_bytes": doc.file_size_bytes,
        "metadata": doc.metadata_,
        "ai_summary": doc.ai_summary,
        "synced_at": doc.synced_at.isoformat(),
        "created_at": doc.created_at.isoformat(),
        "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
    }


@router.get("/{doc_id}/backlinks")
async def get_document_backlinks(
    doc_id: uuid.UUID,
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_optional_user),
    _user: User = Depends(get_current_user),
) -> dict:
    """Knowledge-graph entities this document contributed observations to,
    plus the sibling documents those same entities were observed in.

    This is the Obsidian-style backlink panel, derived rather than hand-authored:
    the LLM extraction pass already records which entity each observation came
    from (``KnowledgeObservation.source_document_id``), so "what else discussed
    this?" is a two-hop walk — document → entities → other source documents —
    with no new schema and no manually written links.
    """
    mids = await user_machine_ids(db, _user)
    await _get_doc_with_permission(doc_id, db, user, mids, include_content=False)

    # Hop 1: entities this document was observed in.
    #
    # Scoped to the caller's own entities for non-admins, matching every other
    # KnowledgeEntity query in the codebase (see api/memory.py). A document can
    # be visible to this user while another tenant's extraction pass also
    # observed it; without this guard their entity names would leak here.
    ent_q = (
        select(KnowledgeEntity.id, KnowledgeEntity.name, KnowledgeEntity.entity_type)
        .join(KnowledgeObservation, KnowledgeObservation.entity_id == KnowledgeEntity.id)
        .where(KnowledgeObservation.source_document_id == doc_id)
        .distinct()
        .limit(limit)
    )
    if _user.role not in ("admin", "owner"):
        ent_q = ent_q.where(KnowledgeEntity.user_id == _user.id)
    ent_rows = (await db.execute(ent_q)).all()
    if not ent_rows:
        return {"entities": [], "related_documents": []}

    ent_ids = [e[0] for e in ent_rows]

    # Hop 2: other documents observed in those same entities. Excluding the
    # current doc; ordering by shared-entity count so the most strongly
    # related document surfaces first.
    shared = func.count(func.distinct(KnowledgeObservation.entity_id)).label("shared")
    rel_q = (
        select(
            Document.id, Document.title, Document.relative_path,
            Document.tool_id, Document.category, Document.synced_at, shared,
        )
        .join(KnowledgeObservation, KnowledgeObservation.source_document_id == Document.id)
        .where(
            KnowledgeObservation.entity_id.in_(ent_ids),
            Document.id != doc_id,
        )
        .group_by(
            Document.id, Document.title, Document.relative_path,
            Document.tool_id, Document.category, Document.synced_at,
        )
        .order_by(shared.desc(), Document.synced_at.desc())
        .limit(limit)
    )
    rel_q = apply_user_filter(rel_q, mids, Document.machine_id)
    rel_rows = (await db.execute(rel_q)).all()

    return {
        "entities": [
            {"id": str(eid), "name": name, "type": etype}
            for eid, name, etype in ent_rows
        ],
        "related_documents": [
            {
                "id": str(rid),
                "title": title or (rpath.split("/")[-1] if rpath else ""),
                "relative_path": rpath,
                "tool_id": tid,
                "category": cat,
                "synced_at": synced.isoformat() if synced else None,
                "shared_entities": int(sh),
            }
            for rid, title, rpath, tid, cat, synced, sh in rel_rows
        ],
    }
