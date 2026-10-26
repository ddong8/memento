"""SSE endpoint — real-time event stream for the frontend dashboard."""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..middleware.auth import decode_token
from ..services.sse_service import format_sse, subscribe

router = APIRouter(prefix="/api/events", tags=["events"])


@router.get("/stream")
async def event_stream(
    token: str | None = Query(None),
    authorization: str | None = Header(None),
):
    """SSE endpoint for real-time updates: files synced, notifications, ask runs starting and ending.

    Auth by the Authorization header (fetch-based readers: the desktop app, the web app's live
    connection), or ?token= for EventSource, which can't send headers (the token then lands in the
    access log)."""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing token")
    try:
        payload = decode_token(token)
    except HTTPException:
        raise HTTPException(status_code=401, detail="Invalid token")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")
    async def generate():
        async for event in subscribe(user_id):
            yield format_sse(event)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
