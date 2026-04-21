"""OpenClaw tool definition — watches ~/.openclaw/ for memory, identity, learnings."""

from __future__ import annotations

from pathlib import Path

from ..config import TOOL_PATHS
from .base import (
    BaseTool, Category, ContentType, FileClassification, SyncStrategy, WatchPath,
)

# Core workspace markdown files
CORE_IDENTITY_FILES = {
    "AGENTS.md", "SOUL.md", "MEMORY.md", "IDENTITY.md",
    "USER.md", "HEARTBEAT.md", "TOOLS.md",
}


class OpenClawTool(BaseTool):

    @property
    def name(self) -> str:
        return "openclaw"

    @property
    def display_name(self) -> str:
        return "OpenClaw"

    @property
    def root_path(self) -> Path:
        return TOOL_PATHS["openclaw"]

    def get_watch_paths(self) -> list[WatchPath]:
        root = self.root_path
        ws = root / "workspace"
        return [
            # Config
            WatchPath(
                path=root,
                pattern="openclaw.json",
                category=Category.CONFIG,
                content_type=ContentType.JSON,
                description="Main OpenClaw configuration",
            ),
            # Core identity files
            WatchPath(
                path=ws,
                pattern="*.md",
                category=Category.IDENTITY,
                content_type=ContentType.MARKDOWN,
                description="Core identity: AGENTS, SOUL, MEMORY, IDENTITY, USER, HEARTBEAT, TOOLS",
            ),
            # Daily memory
            WatchPath(
                path=ws / "memory",
                pattern="*.md",
                category=Category.MEMORY,
                content_type=ContentType.MARKDOWN,
                description="Dated daily memory files (YYYY-MM-DD.md)",
            ),
            # Learning system
            WatchPath(
                path=ws / ".learnings",
                pattern="*.md",
                category=Category.LEARNING,
                content_type=ContentType.MARKDOWN,
                description="ERRORS.md, LEARNINGS.md, FEATURE_REQUESTS.md",
            ),
            # Skills
            WatchPath(
                path=ws / "skills",
                pattern="**/*.md",
                category=Category.SKILL,
                content_type=ContentType.MARKDOWN,
                recursive=True,
                description="Agent skills (self-improving-agent, etc.)",
            ),
            # Session conversations (all agents, not just main)
            WatchPath(
                path=root / "agents",
                pattern="**/sessions/*.jsonl",
                category=Category.CONVERSATION,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.DELTA,
                recursive=True,
                description="Chat session transcripts (all agents)",
            ),
        ]

    def classify_file(self, abs_path: Path) -> FileClassification | None:
        try:
            rel = abs_path.relative_to(self.root_path)
        except ValueError:
            return None

        rel_str = str(rel).replace("\\", "/")
        parts = rel.parts

        # Skip dirs handled by excluded_paths (defense in depth)
        skip_dirs = {
            "credentials", "media", "canvas", "identity", "hooks", "logs",
            "subagents", "tasks", "flows", "memory", "completions",
            "delivery-queue", "extensions", "devices", "telegram", "qqbot",
        }
        if parts and parts[0] in skip_dirs:
            return None

        # Handle agents/{agent_name}/sessions/*.jsonl — conversation sessions
        if (len(parts) >= 4 and parts[0] == "agents" and "sessions" in parts
                and abs_path.suffix == ".jsonl"):
            agent_name = parts[1]  # e.g. "main", "research", etc.
            return FileClassification(
                tool_name=self.name,
                category=Category.CONVERSATION,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.DELTA,
                relative_path=rel_str,
                metadata={
                    "session_id": abs_path.stem,
                    "agent_name": agent_name,
                    "project_hash": agent_name,
                },
            )

        # Skip other files under agents/ (non-session files like auth, models)
        if parts and parts[0] == "agents":
            return None

        # Skip backup config files
        if abs_path.name.startswith("openclaw.json.bak"):
            return None

        # openclaw.json
        if rel_str == "openclaw.json":
            return FileClassification(
                tool_name=self.name,
                category=Category.CONFIG,
                content_type=ContentType.JSON,
                sync_strategy=SyncStrategy.FULL,
                relative_path=rel_str,
            )

        # workspace/ files
        if parts[0] == "workspace":
            # Core identity files in workspace root
            if len(parts) == 2 and abs_path.name in CORE_IDENTITY_FILES:
                return FileClassification(
                    tool_name=self.name,
                    category=Category.IDENTITY,
                    content_type=ContentType.MARKDOWN,
                    sync_strategy=SyncStrategy.FULL,
                    relative_path=rel_str,
                    metadata={"identity_type": abs_path.stem},
                )

            # Daily memory: workspace/memory/*.md
            if len(parts) >= 3 and parts[1] == "memory" and abs_path.suffix == ".md":
                return FileClassification(
                    tool_name=self.name,
                    category=Category.MEMORY,
                    content_type=ContentType.MARKDOWN,
                    sync_strategy=SyncStrategy.FULL,
                    relative_path=rel_str,
                    metadata={"date_hint": abs_path.stem},
                )

            # Learnings: workspace/.learnings/*.md
            if len(parts) >= 3 and parts[1] == ".learnings" and abs_path.suffix == ".md":
                return FileClassification(
                    tool_name=self.name,
                    category=Category.LEARNING,
                    content_type=ContentType.MARKDOWN,
                    sync_strategy=SyncStrategy.FULL,
                    relative_path=rel_str,
                    metadata={"learning_type": abs_path.stem},
                )

            # Skills: workspace/skills/**/*.md
            if "skills" in parts and abs_path.suffix == ".md":
                return FileClassification(
                    tool_name=self.name,
                    category=Category.SKILL,
                    content_type=ContentType.MARKDOWN,
                    sync_strategy=SyncStrategy.FULL,
                    relative_path=rel_str,
                )

        return None

    @property
    def excluded_paths(self) -> list[str]:
        root = str(self.root_path)
        return [
            f"{root}/credentials/**",
            f"{root}/logs/**",
            f"{root}/hooks/**",
            f"{root}/media/**",
            f"{root}/canvas/**",
            f"{root}/subagents/**",
            f"{root}/tasks/**",
            f"{root}/flows/**",
            f"{root}/memory/**",
            f"{root}/completions/**",
            f"{root}/delivery-queue/**",
            f"{root}/extensions/**",
            f"{root}/devices/**",
            f"{root}/identity/**",
            f"{root}/telegram/**",
            f"{root}/qqbot/**",
        ]

    @property
    def sensitive_json_keys(self) -> list[str]:
        return ["auth", "botToken", "token"]
