"""Antigravity tool definition — watches ~/.antigravity/ and ~/.gemini/antigravity/."""

from __future__ import annotations

from pathlib import Path

import json
import os
import platform
import re

from ..config import TOOL_PATHS, HOME
from .base import (
    BaseTool, Category, ContentType, FileClassification, SyncStrategy, WatchPath,
)

# Antigravity stores conversations and brain data in ~/.gemini/ (Unix) or %APPDATA%/.gemini (Windows)
if platform.system() == "Windows":
    _appdata = Path(os.environ.get("APPDATA", str(HOME / "AppData" / "Roaming")))
    GEMINI_ROOT = _appdata / ".gemini" if (_appdata / ".gemini").exists() else HOME / ".gemini"
else:
    GEMINI_ROOT = HOME / ".gemini"


def _extract_brain_metadata(cascade_id: str, transcript_path: Path) -> dict[str, Any]:
    meta: dict[str, Any] = {"session_id": cascade_id, "source": "antigravity"}

    # 1. Extract workspace from conversation db
    db_path = GEMINI_ROOT / "antigravity" / "conversations" / f"{cascade_id}.db"
    if db_path.exists():
        try:
            import sqlite3
            conn = sqlite3.connect(db_path)
            cur = conn.cursor()
            cur.execute('SELECT data FROM trajectory_metadata_blob WHERE id="main"')
            row = cur.fetchone()
            conn.close()
            if row and row[0]:
                data = row[0]
                m = re.search(rb'file://(/[a-zA-Z]:/[a-zA-Z0-9_.-]+(?:/[a-zA-Z0-9_.-]+)*|/[a-zA-Z0-9_.-]+(?:/[a-zA-Z0-9_.-]+)*)', data)
                if m:
                    raw_ws = m.group(1).decode("utf-8", errors="ignore").rstrip("R").rstrip("/")
                    if re.match(r"^/[a-zA-Z]:/", raw_ws):
                        raw_ws = raw_ws[1:]  # /C:/foo -> C:/foo
                    cand_name = Path(raw_ws).name
                    if cand_name and not cand_name.isdigit() and cand_name.lower() not in ("...", "dev", "desktop", "tmp", "temp", "scratch"):
                        meta["project_path"] = raw_ws
                        meta["project_hash"] = cand_name
        except Exception:
            pass

    # 1.5 Fallback: Extract workspace from transcript.jsonl (<user_information> or Cwd)
    if not meta.get("project_path") and transcript_path.exists():
        try:
            with open(transcript_path, "r", encoding="utf-8") as f:
                for idx, line in enumerate(f):
                    if idx > 500:
                        break
                    if "<user_information>" in line:
                        u_match = re.search(r"<user_information>[\s\S]*?((?:/[a-zA-Z0-9_.\-]+)+|[a-zA-Z]:/[a-zA-Z0-9_.\-]+)\s*->", line)
                        if u_match:
                            ws = u_match.group(1).replace("\\", "/").rstrip("/")
                            c_name = ws.split("/")[-1]
                            if c_name and not c_name.isdigit() and c_name.lower() not in ("...", "dev", "desktop", "tmp", "temp", "scratch"):
                                meta["project_path"] = ws
                                meta["project_hash"] = c_name
                                break
                    if '"Cwd"' in line or '"cwd"' in line:
                        c_match = re.search(r'"[Cc]wd"\s*:\s*"?\\?"?((?:/[a-zA-Z0-9_.\-]+)+|[a-zA-Z]:/[a-zA-Z0-9_.\-]+)\\?"?', line)
                        if c_match:
                            ws = c_match.group(1).replace("\\", "/").rstrip("/")
                            c_name = ws.split("/")[-1]
                            if (
                                c_name
                                and not c_name.isdigit()
                                and c_name.lower() not in ("...", "dev", "desktop", "tmp", "temp", "scratch")
                                and "/antigravity/" not in ws
                                and "/.gemini/" not in ws
                            ):
                                meta["project_path"] = ws
                                meta["project_hash"] = c_name
                                break
        except Exception:
            pass

    # 2. Extract title from annotations pbtxt FIRST (this is what Antigravity IDE sidebar displays!)
    ann_path = GEMINI_ROOT / "antigravity" / "annotations" / f"{cascade_id}.pbtxt"
    if ann_path.exists():
        try:
            content = ann_path.read_text("utf-8", errors="ignore")
            m = re.search(r'title:\s*"([^"]+)"', content)
            if m and m.group(1).strip():
                meta["title"] = m.group(1).strip()
        except Exception:
            pass

    # 3. Fallback: Extract title from first user prompt in transcript
    if not meta.get("title") and transcript_path.exists():
        try:
            with open(transcript_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    d = json.loads(line)
                    if d.get("type") == "USER_INPUT":
                        content = d.get("content") or ""
                        req_m = re.search(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", content, re.DOTALL)
                        if req_m:
                            t = req_m.group(1).strip()
                            meta["title"] = t.split("\n")[0][:60]
                        elif content.strip():
                            meta["title"] = content.strip().split("\n")[0][:60]
                        break
        except Exception:
            pass

    return meta


class AntigravityTool(BaseTool):

    @property
    def name(self) -> str:
        return "antigravity"

    @property
    def display_name(self) -> str:
        return "Antigravity"

    @property
    def root_path(self) -> Path:
        return TOOL_PATHS["antigravity"]

    @property
    def _gemini_path(self) -> Path:
        return GEMINI_ROOT / "antigravity"

    def is_available(self) -> bool:
        return self.root_path.exists() or self._gemini_path.exists()

    def get_watch_paths(self) -> list[WatchPath]:
        root = self.root_path
        gemini = self._gemini_path
        paths = [
            # VS Code config
            WatchPath(
                path=root,
                pattern="argv.json",
                category=Category.CONFIG,
                content_type=ContentType.JSON,
                description="VS Code argv configuration",
            ),
            WatchPath(
                path=root / "extensions",
                pattern="extensions.json",
                category=Category.EXTENSION,
                content_type=ContentType.JSON,
                description="Installed extension registry",
            ),
        ]

        # GEMINI.md (user rules) — skip brain plans (too noisy, duplicated)
        if gemini.exists():
            paths.append(
                WatchPath(
                    path=GEMINI_ROOT,
                    pattern="GEMINI.md",
                    category=Category.IDENTITY,
                    content_type=ContentType.MARKDOWN,
                    description="Gemini user rules file",
                ),
            )
            # Encrypted conversation .pb files (legacy format) — real-time updates via watchdog
            paths.append(
                WatchPath(
                    path=gemini / "conversations",
                    pattern="*.pb",
                    category=Category.CONVERSATION,
                    content_type=ContentType.JSONL,
                    description="Encrypted Antigravity conversation trajectories",
                ),
            )
            # Modern Antigravity brain transcripts — real-time incremental updates via watchdog
            paths.append(
                WatchPath(
                    path=gemini / "brain",
                    pattern="**/.system_generated/logs/transcript.jsonl",
                    category=Category.CONVERSATION,
                    content_type=ContentType.JSONL,
                    sync_strategy=SyncStrategy.DELTA,
                    recursive=True,
                    description="Antigravity conversation transcripts (incremental JSONL)",
                ),
            )
            # Antigravity session annotations (title summaries and view timestamps)
            paths.append(
                WatchPath(
                    path=gemini / "annotations",
                    pattern="*.pbtxt",
                    category=Category.STATE,
                    content_type=ContentType.TEXT,
                    sync_strategy=SyncStrategy.FULL,
                    description="Antigravity conversation title annotations",
                ),
            )

        return paths

    def classify_file(self, abs_path: Path) -> FileClassification | None:
        # Try ~/.antigravity/ first
        try:
            rel = abs_path.relative_to(self.root_path)
            rel_str = str(rel).replace("\\", "/")

            if rel_str == "argv.json":
                return FileClassification(
                    tool_name=self.name, category=Category.CONFIG,
                    content_type=ContentType.JSON, sync_strategy=SyncStrategy.FULL,
                    relative_path=rel_str,
                )
            if rel_str == "extensions/extensions.json":
                return FileClassification(
                    tool_name=self.name, category=Category.EXTENSION,
                    content_type=ContentType.JSON, sync_strategy=SyncStrategy.FULL,
                    relative_path=rel_str,
                )
            return None
        except ValueError:
            pass

        # Try ~/.gemini/
        try:
            rel = abs_path.relative_to(GEMINI_ROOT)
            rel_str = str(rel).replace("\\", "/")
            parts = rel.parts
        except ValueError:
            return None

        # GEMINI.md
        if rel_str == "GEMINI.md":
            return FileClassification(
                tool_name=self.name, category=Category.IDENTITY,
                content_type=ContentType.MARKDOWN, sync_strategy=SyncStrategy.FULL,
                relative_path=f"gemini/{rel_str}",
            )

        # Encrypted conversation .pb files — decrypted and decoded by
        # antigravity_export.export_conversations() at the watcher level.
        # Return a special classification that the watcher recognizes.
        if (
            len(parts) >= 3
            and parts[0] == "antigravity"
            and parts[1] == "conversations"
            and abs_path.suffix == ".pb"
        ):
            cascade_id = abs_path.stem
            return FileClassification(
                tool_name=self.name,
                category=Category.CONVERSATION,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.FULL,
                relative_path=f"conversations/{cascade_id}.jsonl",
                metadata={"__antigravity_pb__": True, "session_id": cascade_id},
            )

        # Modern Antigravity brain transcripts: ~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl
        if (
            len(parts) >= 5
            and parts[0] == "antigravity"
            and parts[1] == "brain"
            and abs_path.name == "transcript.jsonl"
        ):
            cascade_id = parts[2]
            meta = _extract_brain_metadata(cascade_id, abs_path)
            return FileClassification(
                tool_name=self.name,
                category=Category.CONVERSATION,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.DELTA,
                relative_path=f"antigravity/brain/{cascade_id}/transcript.jsonl",
                metadata=meta,
            )

        # Antigravity session annotations: ~/.gemini/antigravity/annotations/<session_id>.pbtxt
        if (
            len(parts) >= 3
            and parts[0] == "antigravity"
            and parts[1] == "annotations"
            and abs_path.suffix == ".pbtxt"
        ):
            cascade_id = abs_path.stem
            title = ""
            try:
                content = abs_path.read_text("utf-8", errors="ignore")
                m = re.search(r'title:\s*"([^"]+)"', content)
                if m:
                    title = m.group(1).strip()
            except Exception:
                pass
            return FileClassification(
                tool_name=self.name,
                category=Category.STATE,
                content_type=ContentType.TEXT,
                sync_strategy=SyncStrategy.FULL,
                relative_path=f"antigravity/annotations/{cascade_id}.pbtxt",
                metadata={"session_id": cascade_id, "title": title},
            )

        return None

    @property
    def excluded_paths(self) -> list[str]:
        root = str(self.root_path)
        gemini = str(GEMINI_ROOT)
        return [
            f"{root}/extensions/*/dist/**",
            f"{root}/extensions/*/bundled/**",
            f"{root}/extensions/*/node_modules/**",
            # Skip non-essential subdirs under antigravity, allow brain transcripts
            f"{gemini}/antigravity/implicit/**",
            f"{gemini}/antigravity/code_tracker/**",
            f"{gemini}/antigravity/browser_recordings/**",
            f"{gemini}/antigravity/brain/*/scratch/**",
            f"{gemini}/antigravity/brain/*/.system_generated/logs/transcript_full.jsonl",
            f"{gemini}/antigravity-browser-profile/**",
        ]
