"""Codex tool definition — watches ~/.codex/ for sessions, history, config."""

from __future__ import annotations

import json
import re
from pathlib import Path

from ..config import TOOL_PATHS
from .base import (
    BaseTool, Category, ContentType, FileClassification, SyncStrategy, WatchPath,
)

_SKIP_DIRS = {"users", "user", "home", "desktop", "dev", "documents",
              "python", "projects", "src", "code"}

# Cache: thread_id → {title, first_user_message}
_thread_info_cache: dict[str, dict] | None = None


_history_cache: dict[str, list[dict]] | None = None


def _load_history(codex_home: Path) -> dict[str, list[dict]]:
    """Read history.jsonl — maps session_id → list of {ts, text} user inputs."""
    global _history_cache
    if _history_cache is not None:
        return _history_cache

    history_file = codex_home / "history.jsonl"
    result: dict[str, list[dict]] = {}
    if not history_file.exists():
        _history_cache = result
        return result

    try:
        with open(history_file, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                sid = obj.get("session_id", "")
                text = obj.get("text", "")
                ts = obj.get("ts", 0)
                if sid and text:
                    result.setdefault(sid, []).append({"ts": ts, "text": text})
    except Exception:
        pass
    _history_cache = result
    return result


def _load_threads_from_sqlite(codex_home: Path) -> dict[str, dict]:
    """Read thread titles and first_user_message from state_5.sqlite."""
    global _thread_info_cache
    if _thread_info_cache is not None:
        return _thread_info_cache

    state_db = codex_home / "state_5.sqlite"
    if not state_db.exists():
        _thread_info_cache = {}
        return _thread_info_cache

    import sqlite3
    result: dict[str, dict] = {}
    try:
        conn = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True, timeout=5)
        cursor = conn.execute(
            "SELECT id, title, first_user_message FROM threads"
        )
        for row in cursor.fetchall():
            tid, title, first_msg = row
            if tid:
                result[str(tid)] = {
                    "title": title or "",
                    "first_user_message": first_msg or "",
                }
        conn.close()
    except Exception:
        pass
    _thread_info_cache = result
    return _thread_info_cache


class CodexTool(BaseTool):

    @property
    def name(self) -> str:
        return "codex"

    @property
    def display_name(self) -> str:
        return "Codex"

    @property
    def root_path(self) -> Path:
        return TOOL_PATHS["codex"]

    def get_watch_paths(self) -> list[WatchPath]:
        root = self.root_path
        return [
            # Config
            WatchPath(
                path=root,
                pattern="config.toml",
                category=Category.CONFIG,
                content_type=ContentType.TOML,
                description="Main config: model, reasoning level, personality",
            ),
            # AGENTS.md
            WatchPath(
                path=root,
                pattern="AGENTS.md",
                category=Category.IDENTITY,
                content_type=ContentType.MARKDOWN,
                description="Agent instructions",
            ),
            # History
            WatchPath(
                path=root,
                pattern="history.jsonl",
                category=Category.HISTORY,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.DELTA,
                description="Session command history",
            ),
            # Active sessions — FULL sync to avoid DELTA truncation of user_message
            WatchPath(
                path=root / "sessions",
                pattern="**/*.jsonl",
                category=Category.CONVERSATION,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.FULL,
                recursive=True,
                description="Conversation session transcripts",
            ),
            # Archived sessions
            WatchPath(
                path=root / "archived_sessions",
                pattern="*.jsonl",
                category=Category.CONVERSATION,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.FULL,
                description="Archived conversation sessions",
            ),
            # SQLite logs (polled)
            WatchPath(
                path=root,
                pattern="logs_1.sqlite",
                category=Category.STATE,
                content_type=ContentType.SQLITE,
                sync_strategy=SyncStrategy.POLL,
                description="Structured log database",
            ),
            # SQLite state (polled)
            WatchPath(
                path=root,
                pattern="state_5.sqlite",
                category=Category.STATE,
                content_type=ContentType.SQLITE,
                sync_strategy=SyncStrategy.POLL,
                description="Threads and jobs state database",
            ),
        ]

    def classify_file(self, abs_path: Path) -> FileClassification | None:
        try:
            rel = abs_path.relative_to(self.root_path)
        except ValueError:
            return None

        rel_str = str(rel).replace("\\", "/")
        parts = rel.parts

        # Exclude auth, cache, tmp, log, shell snapshots
        skip_dirs = {"cache", "tmp", ".tmp", "log", "shell_snapshots"}
        if parts and parts[0] in skip_dirs:
            return None

        # Exclude auth.json entirely
        if rel_str == "auth.json":
            return None

        # config.toml
        if rel_str == "config.toml":
            return FileClassification(
                tool_name=self.name,
                category=Category.CONFIG,
                content_type=ContentType.TOML,
                sync_strategy=SyncStrategy.FULL,
                relative_path=rel_str,
            )

        # AGENTS.md
        if rel_str == "AGENTS.md":
            return FileClassification(
                tool_name=self.name,
                category=Category.IDENTITY,
                content_type=ContentType.MARKDOWN,
                sync_strategy=SyncStrategy.FULL,
                relative_path=rel_str,
            )

        # history.jsonl
        if rel_str == "history.jsonl":
            return FileClassification(
                tool_name=self.name,
                category=Category.HISTORY,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.DELTA,
                relative_path=rel_str,
            )

        # Active sessions
        if parts[0] == "sessions" and abs_path.suffix == ".jsonl":
            project_name, project_path = self._extract_cwd_from_session(abs_path)
            meta: dict = {"session_name": abs_path.stem}
            if project_name:
                meta["project_hash"] = project_name
            if project_path:
                meta["project_path"] = project_path
            self._enrich_with_thread_info(abs_path, meta)
            return FileClassification(
                tool_name=self.name,
                category=Category.CONVERSATION,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.FULL,
                relative_path=rel_str,
                metadata=meta,
            )

        # Archived sessions
        if parts[0] == "archived_sessions" and abs_path.suffix == ".jsonl":
            project_name, project_path = self._extract_cwd_from_session(abs_path)
            meta = {"session_name": abs_path.stem, "archived": True}
            if project_name:
                meta["project_hash"] = project_name
            if project_path:
                meta["project_path"] = project_path
            self._enrich_with_thread_info(abs_path, meta)
            return FileClassification(
                tool_name=self.name,
                category=Category.CONVERSATION,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.FULL,
                relative_path=rel_str,
                metadata=meta,
            )

        # version.json
        if rel_str == "version.json":
            return FileClassification(
                tool_name=self.name,
                category=Category.CONFIG,
                content_type=ContentType.JSON,
                sync_strategy=SyncStrategy.FULL,
                relative_path=rel_str,
            )

        # SQLite databases
        if abs_path.name in ("logs_1.sqlite", "state_5.sqlite"):
            return FileClassification(
                tool_name=self.name,
                category=Category.STATE,
                content_type=ContentType.SQLITE,
                sync_strategy=SyncStrategy.POLL,
                relative_path=rel_str,
            )

        # Skip vendor_imports (built-in skill templates, not user data)
        if parts[0] == "vendor_imports":
            return None

        # models_cache.json — useful for tracking model availability
        if rel_str == "models_cache.json":
            return FileClassification(
                tool_name=self.name,
                category=Category.CONFIG,
                content_type=ContentType.JSON,
                sync_strategy=SyncStrategy.FULL,
                relative_path=rel_str,
            )

        return None

    def _enrich_with_thread_info(self, abs_path: Path, meta: dict) -> None:
        """Add title, first_user_message, and history from sqlite + history.jsonl."""
        thread_id = self._extract_thread_id(abs_path)
        if not thread_id:
            return
        # Thread info from sqlite (title + first prompt)
        threads = _load_threads_from_sqlite(self.root_path)
        info = threads.get(thread_id)
        if info:
            if info.get("title"):
                meta["title"] = info["title"]
            if info.get("first_user_message"):
                meta["first_user_message"] = info["first_user_message"]
        # User input history from history.jsonl (all user messages for this session)
        history = _load_history(self.root_path)
        user_inputs = history.get(thread_id, [])
        if user_inputs:
            meta["user_history"] = user_inputs

    @staticmethod
    def _extract_thread_id(abs_path: Path) -> str:
        """Extract thread UUID from session JSONL (from session_meta or filename)."""
        # Try reading session_meta first
        try:
            with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    obj = json.loads(line)
                    if obj.get("type") == "session_meta":
                        tid = obj.get("payload", {}).get("id", "")
                        if tid:
                            return tid
                    break
        except Exception:
            pass
        # Fallback: extract from filename (rollout-YYYY-MM-DDTHH-MM-SS-UUID.jsonl)
        name = abs_path.stem
        import re
        match = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", name, re.I)
        return match.group(1) if match else ""

    @staticmethod
    def _extract_cwd_from_session(abs_path: Path) -> tuple[str | None, str | None]:
        """Extract (project_name, full_cwd) from session_meta cwd field."""
        try:
            with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    obj = json.loads(line)
                    if obj.get("type") == "session_meta":
                        cwd = obj.get("payload", {}).get("cwd", "")
                        if cwd:
                            parts = cwd.replace("\\", "/").rstrip("/").split("/")
                            meaningful = [p for p in parts
                                          if p.lower() not in _SKIP_DIRS and len(p) > 1]
                            name = meaningful[-1] if meaningful else None
                            return name, cwd
                    break
        except Exception:
            pass
        return None, None

    @property
    def excluded_paths(self) -> list[str]:
        root = str(self.root_path)
        return [
            f"{root}/auth.json",
            f"{root}/cache/**",
            f"{root}/tmp/**",
            f"{root}/.tmp/**",
            f"{root}/log/**",
            f"{root}/shell_snapshots/**",
            f"{root}/vendor_imports/**",
        ]
