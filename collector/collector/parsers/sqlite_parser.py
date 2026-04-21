"""SQLite parser — exports table rows as JSON for sync."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .base import BaseParser, ParseResult


class SqliteParser(BaseParser):
    """Exports SQLite tables as JSON.

    For incremental sync, tracks rowid and only exports new rows.
    """

    def can_parse(self, path: Path) -> bool:
        return path.suffix.lower() in (".sqlite", ".db", ".sqlite3")

    def parse(self, path: Path, offset: int = 0) -> ParseResult:
        """Parse SQLite database.

        Args:
            path: Path to the SQLite file.
            offset: Treated as the last known max rowid. Rows with
                    rowid > offset are exported.
        """
        tables_data: dict[str, list[dict]] = {}
        total_rows = 0
        table_info: dict[str, int] = {}

        try:
            # Open in read-only mode with timeout to avoid hanging on locked files
            uri = f"file:{path}?mode=ro"
            try:
                conn = sqlite3.connect(uri, uri=True, timeout=5)
            except sqlite3.OperationalError:
                # Fallback: some platforms/versions don't support URI mode
                conn = sqlite3.connect(str(path), timeout=5)
                conn.execute("PRAGMA query_only = 1")
            conn.row_factory = sqlite3.Row

            cursor = conn.cursor()

            # List all tables
            cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%'"
            )
            tables = [row[0] for row in cursor.fetchall()]

            for table in tables:
                try:
                    if offset > 0:
                        cursor.execute(
                            f"SELECT * FROM [{table}] WHERE rowid > ? "
                            f"ORDER BY rowid LIMIT 1000",
                            (offset,),
                        )
                    else:
                        # For full sync, limit to most recent 1000 rows
                        cursor.execute(
                            f"SELECT * FROM [{table}] ORDER BY rowid DESC LIMIT 1000"
                        )

                    rows = cursor.fetchall()
                    if rows:
                        columns = rows[0].keys()
                        tables_data[table] = [
                            {col: _serialize_value(row[col]) for col in columns}
                            for row in rows
                        ]
                        total_rows += len(rows)

                    # Get total row count for metadata
                    cursor.execute(f"SELECT COUNT(*) FROM [{table}]")
                    table_info[table] = cursor.fetchone()[0]

                except sqlite3.Error:
                    continue

            # Get max rowid across all tables for next offset
            max_rowid = offset
            for table in tables:
                try:
                    cursor.execute(f"SELECT MAX(rowid) FROM [{table}]")
                    row = cursor.fetchone()
                    if row and row[0] is not None:
                        max_rowid = max(max_rowid, row[0])
                except sqlite3.Error:
                    continue

            conn.close()

        except sqlite3.Error as e:
            return ParseResult(
                content=json.dumps({"error": str(e)}),
                title=path.stem,
                metadata={"parse_error": True, "error": str(e)},
            )

        content = json.dumps(tables_data, indent=2, ensure_ascii=False, default=str)

        return ParseResult(
            content=content,
            title=path.stem,
            metadata={
                "tables": table_info,
                "exported_rows": total_rows,
                "format": "sqlite_export",
            },
            line_count=total_rows,
            is_partial=offset > 0,
            offset=max_rowid,
        )


def _serialize_value(value: object) -> object:
    """Convert SQLite values to JSON-serializable types."""
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return f"<binary:{len(value)}bytes>"
    return value
