"""SSE endpoint — real-time event stream for the frontend dashboard."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..middleware.auth import decode_token
from ..services.sse_service import format_sse, parse_event_id, subscribe

router = APIRouter(prefix="/api/events", tags=["events"])


@router.get("/stream")
async def event_stream(
    token: str | None = Query(None),
    authorization: str | None = Header(None),
    last_event_id: Annotated[str | None, Header()] = None,
):
    """SSE endpoint for real-time updates: files synced, notifications, ask runs starting and ending.

    Auth by the Authorization header (fetch-based readers: the desktop app, the web app's live
    connection), or ?token= for EventSource, which can't send headers (the token then lands in the
    access log). A reconnecting client sends Last-Event-ID and gets the events it missed."""
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
        async for event in subscribe(user_id, since=parse_event_id(last_event_id)):
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
