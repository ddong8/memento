"""Ingest service — processes incoming files from the collector."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone

# Set of background tasks — prevents GC from collecting them before completion
_background_tasks: set = set()
# Cap concurrent post-ingest work (each holds a DB connection + a BGE-M3 slot
# for ~10s). Without this, a re-sync storm exhausts the connection pool and
# user web requests time out.
_post_ingest_semaphore: "asyncio.Semaphore | None" = None
# Cap concurrent ingest endpoint handlers: each holds a main-pool connection
# for the entire write transaction (documents + conversation_messages +
# tsvector update). 16 leaves headroom in the 32-slot main pool for login,
# dashboard, search, etc. — collector storms can't starve the web UI.
_ingest_semaphore: "asyncio.Semaphore | None" = None


def _get_post_ingest_semaphore() -> "asyncio.Semaphore":
    global _post_ingest_semaphore
    if _post_ingest_semaphore is None:
        import asyncio as _asyncio
        _post_ingest_semaphore = _asyncio.Semaphore(8)
    return _post_ingest_semaphore


def _get_ingest_semaphore() -> "asyncio.Semaphore":
    global _ingest_semaphore
    if _ingest_semaphore is None:
        import asyncio as _asyncio
        _ingest_semaphore = _asyncio.Semaphore(24)
    return _ingest_semaphore

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db.models import (
    ConversationMessage, Document, DocumentVersion, Project, SyncState, Tool,
)

# Known tool display names
TOOL_DISPLAY_NAMES = {
    "claude_code": "Claude Code",
    "openclaw": "OpenClaw",
    "codex": "Codex",
    "antigravity": "Antigravity",
    "obsidian": "Obsidian",
    "cursor": "Cursor",
    "hermes": "Hermes",
}

# Re-sanitize patterns (defense-in-depth)
_RESANITIZE_PATTERNS = [
    (re.compile(r"sk-[a-zA-Z0-9]{20,}"), "[API_KEY_REDACTED]"),
    (re.compile(r"ghp_[a-zA-Z0-9]{36}"), "[GITHUB_TOKEN_REDACTED]"),
    (re.compile(r"bot\d+:[A-Za-z0-9_-]{35}"), "[TELEGRAM_BOT_TOKEN_REDACTED]"),
    (re.compile(
        r"-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
        r"[\s\S]*?"
        r"-----END\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
        re.MULTILINE,
    ), "[PRIVATE_KEY_REDACTED]"),
]


def _resanitize(text: str) -> tuple[str, bool]:
    """Server-side re-sanitization. Returns (cleaned_text, had_sensitive)."""
    found = False
    for pattern, replacement in _RESANITIZE_PATTERNS:
        text, n = pattern.subn(replacement, text)
        if n > 0:
            found = True
    return text, found


_WORKSPACE_PATTERNS = [
    # d:/dev/2026/0123/project_name/... (with or without file:/// or e:/// prefix)
    re.compile(r"([a-zA-Z]:/dev/\d{4}/\d+/[^/\s\)\]\"*?<>|`]+)"),
    # d:/dev/MMDD/project_name/...
    re.compile(r"([a-zA-Z]:/dev/\d+/[^/\s\)\]\"*?<>|`]+)"),
    # C:/Users/xxx/Desktop/project_name/...
    re.compile(r"([a-zA-Z]:/Users/[^/]+/Desktop/[^/\s\)\]\"*?<>|`]+)"),
    # /Users/xxx/Desktop/dev/lang/project/...
    re.compile(r"(/Users/[^/]+/Desktop/dev/[^/]+/[^/\s\)\]\"*?<>|`]+)"),
    # F:/dev/project/...
    re.compile(r"([a-zA-Z]:/dev/[^/\s\)\]\"*?<>|`]+)"),
]


def _extract_workspace_from_content(content: str) -> tuple[str | None, str | None]:
    """Extract (project_name, full_path) from brain file content."""
    from collections import Counter

    roots: Counter[str] = Counter()
    for pattern in _WORKSPACE_PATTERNS:
        for match in pattern.finditer(content):
            root = match.group(1).replace("\\", "/")
            if "/antigravity/" in root or "/.gemini/" in root:
                continue
            roots[root] += 1

    if not roots:
        return None, None

    best_root = roots.most_common(1)[0][0]
    parts = best_root.rstrip("/").split("/")
    project_name = parts[-1] if parts else None
    return project_name, best_root


async def ensure_tool(db: AsyncSession, tool_id: str) -> Tool:
    """Ensure a tool record exists, create if needed."""
    result = await db.execute(select(Tool).where(Tool.id == tool_id))
    tool = result.scalar_one_or_none()
    if tool is None:
        tool = Tool(
            id=tool_id,
            display_name=TOOL_DISPLAY_NAMES.get(tool_id, tool_id),
        )
        db.add(tool)
        await db.flush()
    return tool


def _prettify_project_name(raw: str) -> str:
    """Convert path-encoded project hash to a human-readable project name.

    Examples:
      '-Users-haixingdong-Desktop-dev-python-quant-future' → 'quant-future'
      'Users-haixingdong-Desktop-dev-ft-userdata' → 'ft-userdata'
      'D--dev-2026-0104-yicaigou-bulk-import' → 'bulk-import'
      'd--dev-1106-chembook' → 'chembook'
    """
    name = raw.strip("-")

    # Known path prefix patterns to strip (greedy match)
    # Pattern: optional drive + common dirs + optional date folders
    prefix_re = re.compile(
        r"^(?:[A-Za-z]--?)?"                       # optional drive letter: D-- or C-
        r"(?:Users-[^-]+-(?:Desktop-?|Documents-?)?)?"  # Users-xxx-Desktop- or Users-xxx-
        r"(?:dev-?)?"                                # dev-
        r"(?:python-?)?"                             # python-
        r"(?:\d{4}-\d{2,4}-?)?"                      # 2026-0104- (year-monthday)
        r"(?:\d{2,4}-?)?",                           # or just MMDD-
        re.IGNORECASE,
    )
    cleaned = prefix_re.sub("", name).strip("-")
    return cleaned if cleaned else raw


def _hash_to_path(project_hash: str) -> str:
    """Convert path-encoded project hash back to a readable filesystem path.

    'Users-haixingdong-Desktop-dev-python-quant-future' → '/Users/haixingdong/Desktop/dev/python/quant-future'
    'D--dev-2026-0104-yicaigou' → 'D:/dev/2026/0104/yicaigou'
    """
    raw = project_hash.strip("-")
    # Windows drive: 'D--dev-...' → 'D:/dev/...'
    m = re.match(r"^([A-Za-z])--(.+)$", raw)
    if m:
        return f"{m.group(1)}:/{m.group(2).replace('-', '/')}"
    # Unix: 'Users-xxx-Desktop-dev-...' → '/Users/xxx/Desktop/dev/...'
    if raw.startswith("Users-"):
        return "/" + raw.replace("-", "/")
    return project_hash


def _clean_source_path(path: str | None) -> str | None:
    if not path:
        return path
    # Strip file:/// URI prefix
    if path.startswith("file:///"):
        path = path[8:] if len(path) > 9 and path[9:10] == ":" else path[7:]
    # URL decode
    from urllib.parse import unquote
    path = unquote(path)
    # Strip \\?\
    path = re.sub(r"^\\\\?\?\\", "", path)
    return path


async def ensure_project(
    db: AsyncSession, tool_id: str, project_hash: str,
    source_path: str | None = None,
) -> Project:
    """Ensure a project record exists for a given hash/path."""
    source_path = _clean_source_path(source_path)
    slug = f"{tool_id}/{project_hash}"
    result = await db.execute(select(Project).where(Project.slug == slug))
    project = result.scalar_one_or_none()
    if project is None:
        project = Project(
            slug=slug,
            title=project_hash,
            tool_id=tool_id,
            source_path=source_path or project_hash,
        )
        db.add(project)
        await db.flush()
    elif source_path and (not project.source_path or project.source_path == project.title or len(project.source_path) < 10):
        # Update incomplete source_path with better data
        project.source_path = source_path
    return project


async def ingest_file(
    db: AsyncSession,
    tool_id: str,
    category: str,
    content_type: str,
    relative_path: str,
    content: str,
    content_hash: str,
    file_size: int,
    mode: str,
    offset: int,
    metadata: dict,
    timestamp: float | None = None,
    machine_id: str | None = None,
    user_id: str | None = None,
) -> Document:
    """Process and store an ingested file."""
    # Re-sanitize
    content = content.replace("\x00", "")  # PostgreSQL TEXT rejects null bytes
    content, had_sensitive = _resanitize(content)

    # Ensure tool exists
    tool = await ensure_tool(db, tool_id)

    # Extract project if present in metadata
    project_id = None
    project_hash = metadata.get("project_hash")

    # Server-side project extraction fallback
    # Trigger if: no hash, UUID-like, contains --, or looks like a path-encoded hash (Users-xxx or drive--)
    _looks_like_hash = bool(project_hash and (
        re.match(r"^[0-9a-f]{8}-", project_hash)
        or "--" in project_hash
        or re.match(r"^-?Users-", project_hash)
        or re.match(r"^[A-Za-z]--", project_hash)
        or len(project_hash) > 30
    ))
    _needs_extract = not project_hash or _looks_like_hash
    project_path: str | None = metadata.get("project_path")

    if _needs_extract and content and category == "conversation":
        # Universal: extract cwd from first occurrence in content (Claude Code, Codex, Cursor all have it)
        cwd_match = re.search(r'"cwd"\s*:\s*"([^"]+)"', content[:10000])
        if cwd_match:
            raw_cwd = cwd_match.group(1)
            raw_cwd = re.sub(r"^\\\\?\?\\", "", raw_cwd)
            cwd = raw_cwd.replace("\\", "/").rstrip("/")
            project_path = project_path or raw_cwd
            project_hash = cwd.split("/")[-1]
        elif _looks_like_hash and project_hash:
            # No cwd found but hash looks like encoded path — prettify it
            project_hash = _prettify_project_name(project_hash)

    if _needs_extract and content and tool_id == "antigravity" and "brain" in relative_path:
        # Antigravity: extract workspace from file:// URIs in brain content
        extracted_name, extracted_path = _extract_workspace_from_content(content)
        if extracted_name:
            project_hash = extracted_name
            if extracted_path and not project_path:
                project_path = extracted_path

    if project_hash:
        # Sanitize: strip control characters and null bytes
        project_hash = re.sub(r"[\x00-\x1f].*", "", project_hash).strip()
    if project_hash:
        if not project_path:
            project_path = metadata.get("project_path")
        project = await ensure_project(db, tool_id, project_hash, source_path=project_path)
        project_id = project.id

    # Fallback: match project via session_id from existing documents
    if not project_id:
        session_id = metadata.get("session_id") or metadata.get("cascade_id")
        if session_id:
            existing = await db.execute(
                select(Document.project_id)
                .where(Document.tool_id == tool_id, Document.metadata_["session_id"].astext == session_id, Document.project_id.isnot(None))
                .limit(1)
            )
            row = existing.scalar_one_or_none()
            if row:
                project_id = row

    # Find existing document
    result = await db.execute(
        select(Document).where(
            Document.tool_id == tool_id,
            Document.relative_path == relative_path,
        )
    )
    doc = result.scalar_one_or_none()

    now = datetime.now(timezone.utc)
    title = metadata.pop("title", None) or relative_path.split("/")[-1]

    if doc is None:
        # Create new document — always store content in DB (TEXT has no size limit)
        doc = Document(
            tool_id=tool_id,
            project_id=project_id,
            machine_id=machine_id,
            relative_path=relative_path,
            category=category,
            content_type=content_type,
            title=title,
            content=content,
            content_hash=content_hash,
            file_size_bytes=file_size,
            metadata_=metadata,
            needs_review=had_sensitive,
            synced_at=now,
            source_modified_at=datetime.fromtimestamp(timestamp, tz=timezone.utc) if timestamp else now,
        )
        db.add(doc)
    else:
        # Update existing document
        if mode == "delta" and doc.content:
            # For large files, replace instead of append to avoid unbounded growth
            if len(doc.content) + len(content) > 10_000_000:
                doc.content = content  # Replace with latest delta
            else:
                doc.content = doc.content + "\n" + content
        else:
            doc.content = content
        doc.content_hash = content_hash
        doc.file_size_bytes = file_size
        doc.metadata_ = {**doc.metadata_, **metadata}
        doc.needs_review = doc.needs_review or had_sensitive
        doc.synced_at = now
        if machine_id and not doc.machine_id:
            doc.machine_id = machine_id
        doc.title = title
        # Backfill project_id when newly resolved (was NULL, or changed).
        # Don't overwrite an existing link with NULL — keep last good value.
        if project_id and doc.project_id != project_id:
            doc.project_id = project_id

        # Save version history
        version = DocumentVersion(
            document_id=doc.id,
            content_hash=content_hash,
            file_size_bytes=file_size,
        )
        db.add(version)

    # Refresh the content_tsv full-text index from the current (possibly
    # delta-appended) content + title. Runs inside the ingest transaction
    # via a bound SQL expression so the tokenized string is passed as a
    # parameter, not compiled into SQL.
    from sqlalchemy import func as _func, update as _update
    from .tokenize import tokenize_for_index as _tok
    tsv_input = _tok(f"{doc.title or ''} {doc.content or ''}")
    await db.execute(
        _update(Document)
        .where(Document.id == doc.id)
        .values(content_tsv=_func.to_tsvector("simple", tsv_input))
    )

    await db.flush()

    # Update tool stats
    tool.last_sync_at = now
    count_result = await db.execute(
        select(Document.id).where(Document.tool_id == tool_id)
    )
    tool.total_files = len(count_result.all())

    # Extract conversation messages into conversation_messages table
    # For DELTA mode, only parse new content; for FULL mode, re-parse all
    if category == "conversation" and (
        content_type == "jsonl"
        or (content_type == "json" and tool_id == "hermes")
    ):
        await _extract_messages(db, doc, content, mode)

    # Update sync state
    await _update_sync_state(db, tool_id, relative_path, content_hash, offset, machine_id)

    # Trigger AI summary generation (async via Celery)
    if category in ("memory", "identity", "plan", "note", "learning") and len(content) > 50:
        try:
            from ..tasks.summary_tasks import generate_document_summary_task
            generate_document_summary_task.delay(str(doc.id))
        except Exception:
            pass  # Celery may not be running in dev

    # Publish SSE event
    try:
        from .sse_service import publish_event
        publish_event("file_synced", {
            "document_id": str(doc.id),
            "tool_id": tool_id,
            "category": category,
            "relative_path": relative_path,
            "title": title,
        }, user_id=user_id)
    except Exception:
        pass

    # Generate embeddings + extract knowledge graph (async, non-blocking)
    # Must keep a reference to the task to prevent GC
    import asyncio
    try:
        loop = asyncio.get_running_loop()
        task = loop.create_task(_run_post_ingest(doc.id, doc.tool_id, category))
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
    except Exception:
        pass

    return doc


async def _run_post_ingest(doc_id, tool_id: str, category: str) -> None:
    """Post-ingest: generate embeddings and extract knowledge (best-effort, own session)."""
    import logging
    logger = logging.getLogger("post_ingest")

    # Only process conversations and memory — skip configs, extensions, etc.
    if category not in ("conversation", "memory", "learning", "plan", "identity"):
        return

    sem = _get_post_ingest_semaphore()
    async with sem:
        await _run_post_ingest_inner(doc_id, tool_id, category)


async def _run_post_ingest_inner(doc_id, tool_id: str, category: str) -> None:
    import logging
    logger = logging.getLogger("post_ingest")
    logger.info("Post-ingest starting for %s/%s (category=%s)", tool_id, doc_id, category)
    try:
        from ..db.session import post_ingest_session_factory
        async with post_ingest_session_factory() as db:
            doc = (await db.execute(
                select(Document).where(Document.id == doc_id)
            )).scalar_one_or_none()
            if not doc:
                logger.info("Post-ingest: doc %s not found", doc_id)
                return

            # Embedding (skip if API not available)
            try:
                from .embedding_service import generate_document_embeddings
                count = await generate_document_embeddings(db, doc)
                if count > 0:
                    await db.commit()
            except Exception as e:
                logger.info("Embedding skipped for %s: %s", doc.relative_path, e)
                await db.rollback()

            # Knowledge graph extraction
            try:
                from .graph_service import extract_knowledge_from_document
                count = await extract_knowledge_from_document(db, doc)
                if count > 0:
                    await db.commit()
                    logger.info("Extracted %d knowledge items from %s", count, doc.relative_path)
                else:
                    logger.info("No knowledge extracted from %s", doc.relative_path)
            except Exception as e:
                import traceback
                logger.info("Graph extraction failed for %s: %s\n%s", doc.relative_path, e, traceback.format_exc())
                await db.rollback()
    except Exception as e:
        logger.info("Post-ingest error: %s", e)


async def _extract_messages(
    db: AsyncSession, doc: Document, content: str, mode: str,
) -> None:
    """Parse conversation content and store normalized messages."""
    from .conversation_parser import _iter_json_objects, parse_conversation_line

    # Hermes stores a whole session as a single top-level JSON, not JSONL.
    # Always full-replace (file is rewritten on each turn).
    if doc.tool_id == "hermes":
        from sqlalchemy import delete
        from .conversation_parser import parse_conversation
        await db.execute(
            delete(ConversationMessage).where(ConversationMessage.document_id == doc.id)
        )
        msgs = parse_conversation(content, "hermes")
        for i, m in enumerate(msgs, start=1):
            ts = None
            if m.timestamp:
                try:
                    ts = datetime.fromisoformat(m.timestamp.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    pass
            db.add(ConversationMessage(
                document_id=doc.id,
                line_number=i,
                message_type=m.role,
                role=m.role,
                content=(m.content or "").replace("\x00", ""),
                metadata_={"tool_name": m.tool_name} if m.tool_name else {},
                timestamp=ts,
            ))
        if msgs:
            await db.flush()
        return

    # Get current max line number for delta mode
    if mode == "delta":
        result = await db.execute(
            select(ConversationMessage.line_number)
            .where(ConversationMessage.document_id == doc.id)
            .order_by(ConversationMessage.line_number.desc())
            .limit(1)
        )
        row = result.scalar_one_or_none()
        start_line = (row or 0) + 1
    else:
        # Full mode: clear existing messages
        from sqlalchemy import delete
        await db.execute(
            delete(ConversationMessage).where(ConversationMessage.document_id == doc.id)
        )
        start_line = 1

    tool_id = doc.tool_id
    line_num = start_line
    batch = []
    seen_contents: set[str] = set()  # Deduplicate identical messages
    # Walk the content with the tolerant JSON iterator so pretty-printed
    # multi-line entries from Claude Code (Windows 2.1.x) don't get
    # shattered into unparseable single-character fragments by split("\n").
    for line in _iter_json_objects(content):
        line = line.strip()
        if not line:
            continue

        # Use conversation_parser for normalized output. We store user / assistant
        # plus OpenClaw-style tool / system (compaction summaries) so the
        # conversation viewer + /api/search can see the full transcript —
        # downstream "daily activity" queries already filter to user+assistant
        # on their side, so this doesn't inflate message counts.
        normalized = parse_conversation_line(line, tool_id)
        if normalized and normalized.role in ("user", "assistant", "tool", "system"):
            # Deduplicate: same role + content + timestamp (within same second).
            # This prevents event_msg/user_message and response_item/user duplicates
            # while keeping genuinely repeated inputs across different turns.
            ts_bucket = (normalized.timestamp or "")[:19]  # truncate to second
            dedupe_key = hashlib.md5(f"{normalized.role}:{ts_bucket}:{normalized.content}".encode()).hexdigest()
            if dedupe_key in seen_contents:
                continue
            seen_contents.add(dedupe_key)

            ts = None
            if normalized.timestamp:
                try:
                    ts = datetime.fromisoformat(normalized.timestamp.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    pass

            meta = {}
            if normalized.thinking:
                meta["thinking"] = normalized.thinking.replace("\x00", "")
            batch.append(ConversationMessage(
                document_id=doc.id,
                line_number=line_num,
                message_type=normalized.raw_type or normalized.role,
                role=normalized.role,
                content=normalized.content.replace("\x00", ""),
                metadata_=meta,
                timestamp=ts,
            ))
            line_num += 1

            # Flush in batches to avoid memory issues with large files
            if len(batch) >= 100:
                db.add_all(batch)
                await db.flush()
                batch = []

    if batch:
        db.add_all(batch)
        await db.flush()

    # Codex user messages: supplement from history.jsonl and state_5.sqlite.
    # history.jsonl has ALL user inputs with timestamps; state_5.sqlite has first prompt.
    user_history = (doc.metadata_ or {}).get("user_history", [])
    if user_history and isinstance(user_history, list):
        # Inject history entries that aren't already in DB (by content dedup)
        existing = await db.execute(
            select(ConversationMessage.content)
            .where(
                ConversationMessage.document_id == doc.id,
                ConversationMessage.role == "user",
            )
        )
        existing_texts = {r[0] for r in existing.all()}
        injected = 0
        for entry in user_history:
            text = entry.get("text", "").strip()
            ts_epoch = entry.get("ts", 0)
            if not text or text in existing_texts:
                continue
            existing_texts.add(text)
            ts = None
            if ts_epoch:
                ts = datetime.fromtimestamp(ts_epoch, tz=timezone.utc)
            db.add(ConversationMessage(
                document_id=doc.id,
                line_number=-1000 + injected,  # Negative = injected from history
                message_type="history_user_message",
                role="user",
                content=text.replace("\x00", ""),
                metadata_={},
                timestamp=ts,
            ))
            injected += 1
        if injected:
            await db.flush()
    elif not user_history:
        # Fallback: first_user_message from state_5.sqlite
        first_user_msg = (doc.metadata_ or {}).get("first_user_message", "").strip()
        if first_user_msg:
            existing_user = await db.execute(
                select(ConversationMessage.id)
                .where(
                    ConversationMessage.document_id == doc.id,
                    ConversationMessage.role == "user",
                )
                .limit(1)
            )
            if existing_user.scalar_one_or_none() is None:
                db.add(ConversationMessage(
                    document_id=doc.id,
                    line_number=0,
                    message_type="first_user_message",
                    role="user",
                    content=first_user_msg.replace("\x00", ""),
                    metadata_={},
                    timestamp=doc.source_modified_at or doc.synced_at,
                ))
                await db.flush()


async def _update_sync_state(
    db: AsyncSession,
    tool_id: str,
    relative_path: str,
    content_hash: str,
    offset: int,
    machine_id: str | None,
) -> None:
    """Update server-side sync state."""
    result = await db.execute(
        select(SyncState).where(
            SyncState.tool_id == tool_id,
            SyncState.relative_path == relative_path,
        )
    )
    state = result.scalar_one_or_none()
    now = datetime.now(timezone.utc)

    if state is None:
        state = SyncState(
            tool_id=tool_id,
            relative_path=relative_path,
            last_hash=content_hash,
            last_offset=offset,
            last_synced_at=now,
        )
        db.add(state)
    else:
        state.last_hash = content_hash
        state.last_offset = offset
        state.last_synced_at = now
