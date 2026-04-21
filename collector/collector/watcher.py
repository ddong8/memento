"""File watcher — cross-platform file monitoring via watchdog with debouncing and event routing."""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from fnmatch import fnmatch
from pathlib import Path
from typing import Callable

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from .compat import normalize_path, path_starts_with
from .config import CollectorConfig
from .parsers.base import BaseParser
from .parsers.json_parser import JsonParser
from .parsers.jsonl import JsonlParser
from .parsers.markdown import MarkdownParser
from .parsers.sqlite_parser import SqliteParser
from .parsers.toml_parser import TomlParser
from .queue import SyncQueue
from .sanitizer import sanitize_json, sanitize_text
from .tools.base import BaseTool, ContentType, FileClassification, SyncStrategy

logger = logging.getLogger("collector.watcher")




_FAST_HASH_READ = 256 * 1024  # Read first 256KB for fast hashing


def _file_hash(path: Path) -> str:
    """Fast file change detection: size + mtime + hash of first 256KB.

    Full SHA-256 is too slow for frequent file changes on large JSONL files.
    The first 256KB + file size + mtime catches virtually all real changes.
    """
    try:
        stat = path.stat()
        h = hashlib.sha256()
        # Mix in size + mtime for fast detection
        h.update(f"{stat.st_size}:{stat.st_mtime_ns}".encode())
        # Only hash the first 256KB (covers headers + recent content)
        with open(path, "rb") as f:
            data = f.read(_FAST_HASH_READ)
            h.update(data)
        return h.hexdigest()
    except OSError:
        return ""


class _DebouncedHandler(FileSystemEventHandler):
    """Collects events and fires a debounced callback per unique path."""

    def __init__(
        self,
        callback: Callable[[Path], None],
        debounce_seconds: float,
        excluded_patterns: list[str],
    ) -> None:
        self._callback = callback
        self._debounce = debounce_seconds
        self._excluded = excluded_patterns
        self._pending: dict[str, float] = {}
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None

    def _is_excluded(self, path: str) -> bool:
        norm = normalize_path(path)
        for pattern in self._excluded:
            if fnmatch(norm, normalize_path(pattern)):
                return True
        return False

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        path = event.src_path
        if self._is_excluded(path):
            return

        with self._lock:
            self._pending[path] = time.time()

        # Reset debounce timer
        if self._timer is not None:
            self._timer.cancel()
        self._timer = threading.Timer(self._debounce, self._flush)
        self._timer.daemon = True
        self._timer.start()

    def _flush(self) -> None:
        with self._lock:
            paths = list(self._pending.keys())
            self._pending.clear()

        for path_str in paths:
            path = Path(path_str)
            if path.exists() and path.is_file():
                try:
                    self._callback(path)
                except Exception:
                    logger.exception("Error processing %s", path)


class FileWatcher:
    """Orchestrates watching all tool directories and processing changes."""

    def __init__(
        self,
        tools: list[BaseTool],
        queue: SyncQueue,
        config: CollectorConfig,
    ) -> None:
        self._tools = tools
        self._queue = queue
        self._config = config
        self._observer = Observer()
        self._tool_map: dict[str, BaseTool] = {}  # root_path_str -> tool

        # Build parser registry
        self._parsers: list[BaseParser] = [
            MarkdownParser(),
            JsonlParser(),
            JsonParser(),
            TomlParser(),
            SqliteParser(),
        ]

        # Build excluded patterns from all tools
        all_excluded: list[str] = []
        for tool in tools:
            all_excluded.extend(tool.excluded_paths)

        # Register watches — collect all unique directories to watch per tool
        for tool in tools:
            if not tool.is_available():
                logger.info("Tool %s not available, skipping", tool.name)
                continue

            # Collect all unique root dirs from watch paths
            watch_dirs: set[str] = {str(tool.root_path)}
            for wp in tool.get_watch_paths():
                # Add parent directories that might be outside tool.root_path
                wp_str = str(wp.path)
                if not wp_str.startswith(str(tool.root_path)):
                    watch_dirs.add(wp_str)

            # Dedupe: drop any watch_dir that's already a subdirectory of another
            # (prevents duplicate events from nested recursive watches)
            normalized = sorted(watch_dirs, key=len)
            deduped: list[str] = []
            for d in normalized:
                if any(d.startswith(p + "/") or d == p for p in deduped):
                    continue
                deduped.append(d)
            watch_dirs = set(deduped)

            for watch_dir in watch_dirs:
                if not Path(watch_dir).exists():
                    continue
                self._tool_map[watch_dir] = tool

                handler = _DebouncedHandler(
                    callback=self._on_file_changed,
                    debounce_seconds=config.debounce_seconds,
                    excluded_patterns=all_excluded,
                )

                try:
                    self._observer.schedule(
                        handler, watch_dir, recursive=True,
                    )
                    logger.info(
                        "Watching %s (%s) at %s",
                        tool.display_name, tool.name, watch_dir,
                    )
                except OSError as e:
                    logger.error("Cannot watch %s: %s", watch_dir, e)

    def _find_tool(self, path: Path) -> BaseTool | None:
        """Find which tool owns a file path."""
        for root_str, tool in self._tool_map.items():
            if path_starts_with(str(path), root_str):
                return tool
        return None

    def _get_parser(self, content_type: ContentType) -> BaseParser | None:
        ext_map = {
            ContentType.MARKDOWN: ".md",
            ContentType.JSONL: ".jsonl",
            ContentType.JSON: ".json",
            ContentType.TOML: ".toml",
            ContentType.SQLITE: ".sqlite",
        }
        dummy_ext = ext_map.get(content_type)
        if dummy_ext is None:
            return None
        dummy_path = Path(f"dummy{dummy_ext}")
        for parser in self._parsers:
            if parser.can_parse(dummy_path):
                return parser
        return None

    def _process_antigravity_pb(self, path: Path) -> None:
        """Decrypt+decode an Antigravity .pb file and enqueue it as a conversation."""
        try:
            from .parsers.antigravity_export import export_conversations
        except Exception:
            return

        try:
            convos = export_conversations(pb_files=[path])
        except Exception:
            logger.debug("Antigravity pb decode failed for %s", path)
            return

        for conv in convos:
            content = conv["content"]
            meta: dict = {"source": "aghistory", "doc_type": "full_conversation"}
            if conv.get("title"):
                meta["title"] = conv["title"]
            if conv.get("cascade_id"):
                meta["session_id"] = conv["cascade_id"]
            if conv.get("project_name"):
                meta["project_hash"] = conv["project_name"]
            if conv.get("workspace"):
                meta["project_path"] = conv["workspace"]
            if conv.get("export_diagnostics"):
                meta["export_diagnostics"] = conv["export_diagnostics"]
            self._queue.enqueue(
                tool_name="antigravity",
                category="conversation",
                content_type="jsonl",
                relative_path=f"conversations/{conv['cascade_id']}.jsonl",
                content=content,
                content_hash=conv.get(
                    "content_hash", f"ag-{hash(content) & 0xFFFFFFFF:08x}",
                ),
                file_size=len(content.encode("utf-8")),
                sync_strategy="full",
                metadata=meta,
            )
            logger.info(
                "Queued antigravity/conversations/%s.jsonl (conversation, jsonl)",
                conv["cascade_id"],
            )

    def _on_file_changed(self, path: Path) -> None:
        """Process a detected file change."""
        tool = self._find_tool(path)
        if tool is None:
            return

        classification = tool.classify_file(path)
        if classification is None:
            return

        # Special handling for encrypted Antigravity .pb files
        if classification.metadata.get("__antigravity_pb__"):
            self._process_antigravity_pb(path)
            return

        # Skip POLL strategy files (SQLite)
        if classification.sync_strategy == SyncStrategy.POLL:
            return

        try:
            file_size = path.stat().st_size
        except OSError:
            return

        # Check if file content actually changed
        current_hash = _file_hash(path)
        if not current_hash:
            return

        last_hash, last_offset = self._queue.get_file_state(
            classification.tool_name, classification.relative_path,
        )

        # For FULL sync, skip if hash unchanged
        if classification.sync_strategy == SyncStrategy.FULL and current_hash == last_hash:
            return

        # Determine read offset for delta sync
        read_offset = 0
        if classification.sync_strategy == SyncStrategy.DELTA:
            file_size = path.stat().st_size
            if file_size < last_offset:
                # File was truncated, re-sync from beginning
                read_offset = 0
            else:
                read_offset = last_offset

        # Parse (with error protection)
        try:
            parser = self._get_parser(classification.content_type)
            if parser is None:
                try:
                    content = path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    return
                parsed_content = content
                new_offset = path.stat().st_size
                is_partial = read_offset > 0
            else:
                result = parser.parse(path, offset=read_offset)
                parsed_content = result.content
                new_offset = result.offset if result.offset else path.stat().st_size
                is_partial = result.is_partial
                classification.metadata.update(result.metadata)
                if result.title:
                    classification.metadata["title"] = result.title
        except Exception:
            logger.debug("Parse error for %s, skipping", path)
            return

        if not parsed_content.strip():
            return

        # Sanitize before enqueue (defense-in-depth vs local SQLite leak)
        if classification.content_type in (ContentType.JSON, ContentType.JSONL):
            san = sanitize_json(parsed_content)
        else:
            san = sanitize_text(parsed_content)
        parsed_content = san.content

        self._queue.enqueue(
            tool_name=classification.tool_name,
            category=classification.category.value,
            content_type=classification.content_type.value,
            relative_path=classification.relative_path,
            content=parsed_content,
            content_hash=current_hash,
            file_size=len(parsed_content.encode("utf-8")),
            sync_strategy=classification.sync_strategy.value,
            is_partial=is_partial,
            offset=new_offset,
            metadata=classification.metadata,
        )

        # Update file state
        self._queue.update_file_state(
            classification.tool_name,
            classification.relative_path,
            current_hash,
            new_offset,
        )

        logger.info(
            "Queued %s/%s (%s, %s%s)",
            classification.tool_name,
            classification.relative_path,
            classification.category.value,
            classification.content_type.value,
            " delta" if is_partial else "",
        )

    def initial_scan(self) -> int:
        """Do an initial full scan of all watched files. Returns count queued."""
        count = 0
        for tool in self._tools:
            if not tool.is_available():
                continue
            for wp in tool.get_watch_paths():
                if wp.sync_strategy == SyncStrategy.POLL:
                    continue  # SQLite handled by poller
                if wp.sync_strategy == SyncStrategy.IGNORE:
                    continue

                base = wp.path
                if not base.exists():
                    continue

                try:
                    if wp.recursive:
                        files_iter = base.rglob(wp.pattern)
                    else:
                        files_iter = base.glob(wp.pattern)

                    for f in files_iter:
                        if f.is_file():
                            try:
                                self._on_file_changed(f)
                                count += 1
                            except Exception:
                                logger.debug("Error scanning %s", f)
                except OSError:
                    logger.debug("Cannot scan %s", base)

            # Special: Antigravity exports are deferred to periodic task (non-blocking)
            # See main.py AG_EXPORT_INTERVAL for aghistory + vscdb extraction

        return count

    def start(self) -> None:
        self._observer.start()
        logger.info("File watcher started")

    def stop(self) -> None:
        self._observer.stop()
        self._observer.join(timeout=5)
        logger.info("File watcher stopped")
