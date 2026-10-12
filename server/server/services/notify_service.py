"""Phone push notifications via Bark (https://github.com/Finb/Bark).

The user pastes the push address the Bark app shows (https://api.day.app/<key>/...)
once; the server then pushes risky agent operations and finished tasks to it.
Everything here is fire-and-forget: a failed push is logged and never affects the
task that triggered it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from sqlalchemy import select

from ..config import settings
from ..db.models import User
from ..db.session import async_session_factory

logger = logging.getLogger("server.notify")

# Pushes per task for risky operations; beyond this they're recorded but not pushed,
# so a looping agent can't flood the phone.
RISKY_PUSHES_PER_TASK = 5
_risky_push_counts: dict[str, int] = {}
_background: set[asyncio.Task] = set()


def parse_push_url(raw: str | None) -> tuple[str, str, str] | None:
    """Parse a push endpoint into (provider, base_or_target_url, key_or_topic).
    
    Supported:
    - Bark (iOS): 'https://api.day.app/KEY[/anything]' -> ('bark', 'https://api.day.app', 'KEY')
    - ntfy (Android & multiplatform): 'https://ntfy.sh/TOPIC' -> ('ntfy', 'https://ntfy.sh/TOPIC', 'TOPIC')
    """
    if not raw:
        return None
    parsed = urlparse(raw.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    parts = [p for p in parsed.path.split("/") if p]
    if not parts:
        return None
    
    # Bark (official Bark endpoint requires https)
    if "api.day.app" in parsed.netloc:
        if parsed.scheme != "https":
            return None
        return "bark", f"https://{parsed.netloc}", parts[0]
    
    # ntfy (either ntfy.sh or self-hosted ntfy instance)
    if "ntfy" in parsed.netloc or len(parts) == 1:
        return "ntfy", f"{parsed.scheme}://{parsed.netloc}/{parts[0]}", parts[0]

    return "bark", f"{parsed.scheme}://{parsed.netloc}", parts[0]


def parse_bark_url(raw: str | None) -> tuple[str, str] | None:
    if not raw:
        return None
    parsed = urlparse(raw.strip())
    if parsed.scheme != "https":
        return None
    res = parse_push_url(raw)
    if not res:
        return None
    return res[1], res[2]


def mask_push_url(raw: str | None) -> str | None:
    res = parse_push_url(raw)
    if not res:
        return None
    provider, target, key = res
    if provider == "bark":
        return f"{target}/{key[:4]}…"
    # ntfy
    return f"{target[:-len(key)]}{key[:4]}…"


def mask_bark_url(raw: str | None) -> str | None:
    return mask_push_url(raw)


async def _is_public_host(host: str) -> bool:
    """Refuse to push to private/loopback/link-local addresses: the URL is user
    supplied, and the server must not be usable to probe its own network."""
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, 443)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


async def send_bark(
    push_url: str,
    title: str,
    body: str,
    *,
    url: str | None = None,
    level: str = "active",
) -> bool:
    """Send push notification supporting both Bark (iOS) and ntfy (Android/Universal)."""
    parsed = parse_push_url(push_url)
    if not parsed:
        return False
    provider, target, key = parsed
    host = urlparse(target).hostname or ""
    if not await _is_public_host(host):
        logger.warning("Push refused: %s does not resolve to a public address", host)
        return False

    if provider == "ntfy":
        # Send via ntfy (Android & multiplatform)
        headers = {
            "Title": title.encode("utf-8").decode("latin-1", "replace"),
            "Priority": "urgent" if level == "timeSensitive" else "default",
            "Tags": "robot,memento",
        }
        if url:
            headers["Click"] = url
        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
                resp = await client.post(target, content=body.encode("utf-8"), headers=headers)
            if resp.status_code not in (200, 201):
                logger.warning("ntfy push failed: HTTP %s %s", resp.status_code, resp.text[:200])
                return False
            return True
        except httpx.HTTPError as e:
            logger.warning("ntfy push failed: %s", e)
            return False

    # Default Bark (iOS)
    payload = {"device_key": key, "title": title, "body": body, "group": "Memento", "level": level}
    if url:
        payload["url"] = url
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            resp = await client.post(f"{target}/push", json=payload)
        if resp.status_code != 200:
            logger.warning("Bark push failed: HTTP %s %s", resp.status_code, resp.text[:200])
            return False
        return True
    except httpx.HTTPError as e:
        logger.warning("Bark push failed: %s", e)
        return False


def task_link(task_id: str) -> str | None:
    base = (settings.public_url or "").rstrip("/")
    return f"{base}/tasks/{task_id}" if base else f"/tasks/{task_id}"


_apns_jwt_cache: dict[str, tuple[str, float]] = {}


def _get_apns_jwt() -> str | None:
    auth_key = getattr(settings, "apns_auth_key", "")
    key_id = getattr(settings, "apns_key_id", "JMF779PKS9")
    team_id = getattr(settings, "apns_team_id", "WHNZV34GK4")
    if not auth_key or not key_id or not team_id:
        return None

    now = time.time()
    cached = _apns_jwt_cache.get(key_id)
    if cached and now < cached[1]:
        return cached[0]

    key_pem = auth_key.strip()
    if not key_pem.startswith("-----BEGIN"):
        try:
            import base64
            key_pem = base64.b64decode(key_pem).decode("utf-8")
        except Exception:
            pass

    try:
        from jose import jwt
        claims = {"iss": team_id, "iat": int(now)}
        token = jwt.encode(claims, key_pem, algorithm="ES256", headers={"kid": key_id})
        _apns_jwt_cache[key_id] = (token, now + 3000)  # 50 min validity
        return token
    except Exception as e:
        logger.warning("Failed to generate APNs JWT token: %s", e)
        return None


async def send_apns_push(
    tokens: list[str],
    title: str,
    body: str,
    *,
    url: str | None = None,
    level: str = "active",
) -> bool:
    """Send native remote push notifications directly to iOS devices via Apple APNs HTTP/2 gateway.
    
    This delivers notifications even when the app is completely terminated or killed.
    """
    if not tokens:
        return False

    jwt_token = _get_apns_jwt()
    if not jwt_token:
        logger.debug("APNs push skipped: APNs credentials not configured")
        return False

    # Real APNs device tokens are hexadecimal strings (typically 64 chars)
    apns_tokens = [
        tok.strip()
        for tok in tokens
        if tok and not tok.startswith("ExponentPushToken")
        and not tok.startswith("ExpoPushToken")
        and not tok.startswith("client_")
        and not tok.startswith("memento_")
        and not tok.startswith("ios_")
    ]
    apns_tokens = list(dict.fromkeys(apns_tokens))
    if not apns_tokens:
        return False

    bundle_id = getattr(settings, "apns_bundle_id", "com.ihasy.memento")
    is_prod = getattr(settings, "apns_production", True)

    payload = {
        "aps": {
            "alert": {
                "title": title,
                "body": body,
            },
            "sound": "default",
            "badge": 1,
            "mutable-content": 1,
            "content-available": 1,
        },
    }
    if level == "timeSensitive":
        payload["aps"]["interruption-level"] = "time-sensitive"
    if url:
        payload["url"] = url
        payload["body"] = {"url": url}
        payload["data"] = {"url": url}

    headers = {
        "authorization": f"bearer {jwt_token}",
        "apns-topic": bundle_id,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": str(int(time.time()) + 86400 * 3),
    }

    delivered = 0
    hosts = ["api.push.apple.com", "api.sandbox.push.apple.com"] if is_prod else ["api.sandbox.push.apple.com", "api.push.apple.com"]

    try:
        async with httpx.AsyncClient(http2=True, timeout=10.0) as client:
            for tok in apns_tokens:
                for host in hosts:
                    endpoint = f"https://{host}/3/device/{tok}"
                    try:
                        resp = await client.post(endpoint, json=payload, headers=headers)
                        if resp.status_code == 200:
                            delivered += 1
                            logger.info("APNs push delivered successfully to device %s… via %s", tok[:8], host)
                            break
                        elif resp.status_code == 400 and "BadDeviceToken" in resp.text:
                            # Sandbox vs Production mismatch: try fallback host
                            continue
                        else:
                            logger.warning("APNs push to %s failed (HTTP %s): %s", host, resp.status_code, resp.text[:200])
                    except Exception as e:
                        logger.warning("APNs request error to %s: %s", host, e)
    except Exception as e:
        logger.warning("APNs HTTP/2 client error: %s", e)

    return delivered > 0


async def send_apns_live_activity(
    tokens: list[str],
    event: str,
    content_state: dict,
    *,
    attributes: dict | None = None,
    alert: dict | None = None,
    dismissal_date: int | None = None,
    priority: str = "10",
) -> bool:
    """Send iOS ActivityKit / Dynamic Island liveactivity push via Apple APNs HTTP/2 gateway.

    event: "start" | "update" | "end"
    """
    if not tokens:
        return False

    jwt_token = _get_apns_jwt()
    if not jwt_token:
        return False

    valid_tokens = [
        tok.strip()
        for tok in tokens
        if tok and len(tok.strip()) >= 32 and all(c in "0123456789abcdefABCDEF" for c in tok.strip())
    ]
    valid_tokens = list(dict.fromkeys(valid_tokens))
    if not valid_tokens:
        return False

    bundle_id = getattr(settings, "apns_bundle_id", "com.ihasy.memento")
    is_prod = getattr(settings, "apns_production", True)
    now_ts = int(time.time())

    aps_dict: dict = {
        "timestamp": now_ts,
        "event": event,
        "content-state": content_state,
    }
    if event == "start" and attributes:
        aps_dict["attributes-type"] = "MementoTaskAttributes"
        aps_dict["attributes"] = attributes
    if alert:
        aps_dict["alert"] = alert
    if dismissal_date is not None:
        aps_dict["dismissal-date"] = dismissal_date

    payload = {"aps": aps_dict}
    headers = {
        "authorization": f"bearer {jwt_token}",
        "apns-topic": f"{bundle_id}.push-type.liveactivity",
        "apns-push-type": "liveactivity",
        "apns-priority": priority,
        "apns-expiration": str(now_ts + 3600),
    }

    delivered = 0
    hosts = ["api.push.apple.com", "api.sandbox.push.apple.com"] if is_prod else ["api.sandbox.push.apple.com", "api.push.apple.com"]

    try:
        async with httpx.AsyncClient(http2=True, timeout=8.0) as client:
            for tok in valid_tokens:
                for host in hosts:
                    endpoint = f"https://{host}/3/device/{tok}"
                    try:
                        resp = await client.post(endpoint, json=payload, headers=headers)
                        if resp.status_code == 200:
                            delivered += 1
                            break
                        elif resp.status_code == 400 and "BadDeviceToken" in resp.text:
                            continue
                        else:
                            logger.debug("APNs liveactivity (%s) to %s HTTP %s: %s", event, host, resp.status_code, resp.text[:160])
                    except Exception as e:
                        logger.debug("APNs liveactivity request error to %s: %s", host, e)
    except Exception as e:
        logger.debug("APNs liveactivity HTTP/2 client error: %s", e)

    return delivered > 0


async def push_live_activity_event(
    user_id: uuid.UUID | str | None,
    conversation_id: str,
    event: str,
    *,
    status: str,
    current_step: str,
    step_count: int = 1,
    tool_name: str | None = None,
    elapsed_seconds: int = 0,
    title: str = "",
    engine: str = "AI",
    device_name: str = "云端",
    started_at_epoch: float | None = None,
) -> bool:
    """Dispatch start / update / end Live Activity push for a background task."""
    if not user_id or not conversation_id:
        return False
    try:
        async with async_session_factory() as db:
            user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
        if not user:
            return False
        prefs = user.notify_settings or {}
        act_map: dict = prefs.get("live_activity_tokens") or {}
        start_tokens: list = prefs.get("live_activity_start_tokens") or []

        content_state = {
            "status": status,
            "currentStep": current_step[:90],
            "stepCount": max(1, int(step_count)),
            "toolName": tool_name,
            "elapsedSeconds": max(0, int(elapsed_seconds)),
        }

        if event == "start":
            # If the mobile device already registered a specific activity token for this conversation,
            # update it instead of starting a duplicate activity via push-to-start.
            act_tok = act_map.get(conversation_id)
            if act_tok:
                return await send_apns_live_activity(
                    [act_tok],
                    "update",
                    content_state,
                    priority="10",
                )
            if not start_tokens:
                return False
            attributes = {
                "conversationId": conversation_id,
                "title": (title or "后台任务")[:50],
                "engine": engine or "AI",
                "deviceName": device_name or "云端",
                "startedAtEpoch": float(started_at_epoch or time.time()),
            }
            return await send_apns_live_activity(
                start_tokens,
                "start",
                content_state,
                attributes=attributes,
                alert={
                    "title": f"Memento · {engine or 'AI'} 任务已启动",
                    "body": (title or current_step)[:60],
                },
                priority="10",
            )

        act_tok = act_map.get(conversation_id)
        if not act_tok:
            return False

        if event == "end":
            return await send_apns_live_activity(
                [act_tok],
                "end",
                content_state,
                dismissal_date=int(time.time()) + 180,
                priority="10",
            )

        return await send_apns_live_activity(
            [act_tok],
            "update",
            content_state,
            priority="5" if status == "generating" else "10",
        )
    except Exception as e:
        logger.debug("push_live_activity_event failed: %s", e)
        return False


async def send_expo_push(
    tokens: list[str],
    title: str,
    body: str,
    *,
    url: str | None = None,
    level: str = "active",
) -> bool:
    """Send native push notifications directly to the Memento mobile app via Expo Push service."""
    if not tokens:
        return False
    messages = [
        {
            "to": tok,
            "title": title,
            "body": body,
            "sound": "default",
            "priority": "high" if level == "timeSensitive" else "default",
            "data": {"url": url} if url else {},
            "_displayInForeground": True,
        }
        for tok in tokens
        if tok.startswith("ExponentPushToken") or tok.startswith("ExpoPushToken")
    ]
    if not messages:
        return False

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://exp.host/--/api/v2/push/send",
                json=messages,
                headers={"Accept": "application/json", "Accept-Encoding": "gzip, deflate", "Content-Type": "application/json"},
            )
        if resp.status_code != 200:
            logger.warning("Expo native push failed: HTTP %s %s", resp.status_code, resp.text[:200])
            return False

        data = resp.json()
        tickets = data.get("data") or []
        for ticket in tickets:
            if ticket.get("status") == "error":
                logger.warning("Expo Push delivery error: %s (%s)", ticket.get("message"), ticket.get("details"))
        return True
    except httpx.HTTPError as e:
        logger.warning("Expo native push failed: %s", e)
        return False


# Server-side sliding-window deduplication (120 seconds)
_recent_pushes: dict[str, float] = {}
DEDUP_WINDOW_SECONDS = 120.0


def _extract_core_body(body: str) -> str:
    """Strip leading device name prefix ('device：') and trailing alert count ('（期间 N 次危险操作）')."""
    core = (body or "").strip()
    if "：" in core:
        core = core.split("：", 1)[1].strip()
    if "（期间 " in core:
        core = core.split("（期间 ", 1)[0].strip()
    return core


def _is_duplicate_push(user_id: str | uuid.UUID, title: str, body: str) -> bool:
    now = time.time()
    # Prune old records
    expired = [k for k, ts in _recent_pushes.items() if now - ts > DEDUP_WINDOW_SECONDS * 2]
    for k in expired:
        _recent_pushes.pop(k, None)

    clean_title = (title or "").strip()
    clean_body = (body or "").strip()
    uid = str(user_id)
    key = f"{uid}:{clean_title}:{clean_body}"
    core_body = _extract_core_body(clean_body)
    core_key = f"{uid}:{clean_title}:{core_body}" if core_body else key

    last_ts = _recent_pushes.get(key)
    if last_ts is not None and (now - last_ts) < DEDUP_WINDOW_SECONDS:
        return True
    core_ts = _recent_pushes.get(core_key)
    if core_ts is not None and (now - core_ts) < DEDUP_WINDOW_SECONDS:
        return True

    _recent_pushes[key] = now
    _recent_pushes[core_key] = now
    return False


async def notify_user(
    user_id: uuid.UUID | str | None,
    kind: str,
    title: str,
    body: str,
    *,
    url: str | None = None,
) -> bool:
    """Push to the user's phone via native Memento app (or Bark/ntfy if configured).

    kind: "risky" (agent did something dangerous) | "task_done" (task finished
    while nobody was watching) | "health" (background AI jobs or nightly
    dreaming are failing) | "learning" (new corrections, skills or pitfalls learned) |
    "todo" (todos due today or overdue).
    """
    if not user_id:
        return False
    if _is_duplicate_push(user_id, title, body):
        logger.info("Deduplicated duplicate push notification for user %s: %s", user_id, title)
        return True
    async with async_session_factory() as db:
        user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    prefs = (user.notify_settings or {}) if user else {}
    
    toggle = {
        "risky": "notify_risky", "health": "notify_health", "learning": "notify_learning", "todo": "notify_todo",
    }.get(kind, "notify_task_done")
    if not prefs.get(toggle, True):
        return False
    level = "timeSensitive" if kind == "risky" else "active"

    # Record to user's notification feed for real-time mobile synchronization
    item = {
        "id": str(uuid.uuid4()),
        "kind": kind,
        "title": title,
        "body": body,
        "url": url,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        async with async_session_factory() as db:
            db_user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
            if db_user:
                p = dict(db_user.notify_settings or {})
                feed = list(p.get("recent_notifications") or [])
                feed.insert(0, item)
                p["recent_notifications"] = feed[:30]
                db_user.notify_settings = p
                await db.commit()
    except Exception as e:
        logger.warning("Failed to record notification feed for user %s: %s", user_id, e)

    sent = True

    # 1. Native Memento Mobile App Push (APNs & Expo)
    device_tokens = prefs.get("device_tokens") or []
    if device_tokens:
        # Separate APNs native tokens and Expo push tokens
        apns_tokens = [
            tok.strip()
            for tok in device_tokens
            if tok and not tok.startswith("ExponentPushToken")
            and not tok.startswith("ExpoPushToken")
            and not tok.startswith("client_")
            and not tok.startswith("memento_")
            and not tok.startswith("ios_")
        ]
        apns_tokens = list(dict.fromkeys(apns_tokens))

        expo_tokens = [
            tok.strip()
            for tok in device_tokens
            if tok and (tok.startswith("ExponentPushToken") or tok.startswith("ExpoPushToken"))
        ]
        expo_tokens = list(dict.fromkeys(expo_tokens))

        # Prioritize direct APNs HTTP/2 gateway. Only fallback to Expo if no direct APNs token exists,
        # ensuring we never send duplicate pushes through both channels to the same device.
        if apns_tokens:
            await send_apns_push(apns_tokens, title, body, url=url, level=level)
        elif expo_tokens:
            await send_expo_push(expo_tokens, title, body, url=url, level=level)

    # 2. Bark / ntfy channel (if configured as secondary or fallback)
    if prefs.get("bark_url"):
        await send_bark(prefs["bark_url"], title, body, url=url, level=level)

    return sent


def allow_risky_push(task_id: str) -> bool:
    count = _risky_push_counts.get(task_id, 0)
    if count >= RISKY_PUSHES_PER_TASK:
        return False
    _risky_push_counts[task_id] = count + 1
    return True


def forget_task(task_id: str) -> None:
    _risky_push_counts.pop(task_id, None)


def spawn(coro) -> None:
    """Run a notification in the background, keeping a reference until it's done."""
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)
