"""Local SQLite queue for offline-resilient sync. Thread-safe."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class QueueItem:
    id: int
    tool_name: str
    category: str
    content_type: str
    relative_path: str
    content: str
    content_hash: str
    file_size: int
    sync_strategy: str
    is_partial: bool
    offset: int
    metadata: dict[str, Any]
    created_at: float
    retry_count: int = 0


class SyncQueue:
    """Persistent queue backed by SQLite (WAL mode). All operations are thread-safe."""

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._create_tables()

    def _create_tables(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tool_name TEXT NOT NULL,
                category TEXT NOT NULL,
                content_type TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                content TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                sync_strategy TEXT NOT NULL,
                is_partial INTEGER NOT NULL DEFAULT 0,
                offset INTEGER NOT NULL DEFAULT 0,
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL,
                retry_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending'
            );
            CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status, created_at);
            CREATE TABLE IF NOT EXISTS file_state (
                tool_name TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                last_hash TEXT,
                last_offset INTEGER NOT NULL DEFAULT 0,
                last_synced_at REAL,
                PRIMARY KEY (tool_name, relative_path)
            );
        """)
        self._conn.commit()

    def enqueue(self, tool_name: str, category: str, content_type: str,
                relative_path: str, content: str, content_hash: str,
                file_size: int, sync_strategy: str, is_partial: bool = False,
                offset: int = 0, metadata: dict | None = None) -> int:
        with self._lock:
            cursor = self._conn.execute(
                """INSERT INTO queue (tool_name, category, content_type, relative_path,
                    content, content_hash, file_size, sync_strategy, is_partial, offset,
                    metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (tool_name, category, content_type, relative_path, content,
                 content_hash, file_size, sync_strategy, int(is_partial), offset,
                 json.dumps(metadata or {}, default=str), time.time()))
            self._conn.commit()
            return cursor.lastrowid  # type: ignore[return-value]

    def peek_batch(self, batch_size: int = 20) -> list[QueueItem]:
        with self._lock:
            cursor = self._conn.execute(
                """SELECT id, tool_name, category, content_type, relative_path,
                    content, content_hash, file_size, sync_strategy, is_partial,
                    offset, metadata, created_at, retry_count
                   FROM queue WHERE status = 'pending'
                   ORDER BY retry_count ASC, created_at DESC LIMIT ?""",
                (batch_size,))
            return [QueueItem(id=r[0], tool_name=r[1], category=r[2], content_type=r[3],
                    relative_path=r[4], content=r[5], content_hash=r[6], file_size=r[7],
                    sync_strategy=r[8], is_partial=bool(r[9]), offset=r[10],
                    metadata=json.loads(r[11]), created_at=r[12], retry_count=r[13])
                    for r in cursor.fetchall()]

    def mark_synced(self, item_id: int) -> None:
        with self._lock:
            self._conn.execute("UPDATE queue SET status = 'synced' WHERE id = ?", (item_id,))
            self._conn.commit()

    def mark_failed(self, item_id: int) -> None:
        with self._lock:
            self._conn.execute(
                """UPDATE queue SET retry_count = retry_count + 1,
                   status = CASE WHEN retry_count >= 9 THEN 'dead' ELSE 'pending' END
                   WHERE id = ?""", (item_id,))
            self._conn.commit()

    def get_file_state(self, tool_name: str, relative_path: str) -> tuple[str | None, int]:
        with self._lock:
            row = self._conn.execute(
                "SELECT last_hash, last_offset FROM file_state WHERE tool_name = ? AND relative_path = ?",
                (tool_name, relative_path)).fetchone()
            return (row[0], row[1]) if row else (None, 0)

    def update_file_state(self, tool_name: str, relative_path: str,
                          content_hash: str, offset: int) -> None:
        with self._lock:
            self._conn.execute(
                """INSERT INTO file_state (tool_name, relative_path, last_hash, last_offset, last_synced_at)
                   VALUES (?,?,?,?,?) ON CONFLICT(tool_name, relative_path)
                   DO UPDATE SET last_hash=excluded.last_hash, last_offset=excluded.last_offset,
                   last_synced_at=excluded.last_synced_at""",
                (tool_name, relative_path, content_hash, offset, time.time()))
            self._conn.commit()

    def cleanup_synced(self, older_than_seconds: int = 3600) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM queue WHERE status = 'synced' AND created_at < ?",
                (time.time() - older_than_seconds,))
            self._conn.commit()
            return cursor.rowcount

    def pending_count(self) -> int:
        with self._lock:
            return self._conn.execute("SELECT COUNT(*) FROM queue WHERE status = 'pending'").fetchone()[0]

    def clear_all_state(self) -> None:
        """Clear all file state and queue — forces full re-sync on next scan."""
        with self._lock:
            self._conn.execute("DELETE FROM file_state")
            self._conn.execute("DELETE FROM queue")
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()
