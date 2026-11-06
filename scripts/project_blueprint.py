#!/usr/bin/env python3
"""Project Living Blueprint Generator (活体代码蓝图生成器)

Analyzes a codebase (monorepo or single project), extracts directory topology,
subsystem responsibilities, key entry points, data models, API routes, and Git
evolution history, and produces an auto-updating `PROJECT_BLUEPRINT.md`.

Designed for AI coding agents (Antigravity, Claude Code, Codex, Cursor, etc.)
to instantly understand the full architectural blueprint of a project in <100ms
without expensive, repetitive grep/find reconnaissance.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

# Ignored directories for structural analysis
IGNORED_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    "dist",
    "build",
    ".next",
    ".turbo",
    "out",
    "target",
    "coverage",
    ".idea",
    ".vscode",
    ".gemini",
    "data",
}

# Max depth for directory tree rendering in blueprint
MAX_TREE_DEPTH = 3


def run_git_cmd(args: list[str], cwd: Path) -> str:
    """Run a git command safely and return trimmed stdout."""
    try:
        res = subprocess.run(
            ["git", *args],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=5,
            check=False,
        )
        return res.stdout.strip()
    except Exception:
        return ""


def detect_tech_stack(root: Path) -> dict[str, Any]:
    """Detect technologies, package managers, and architectural styles."""
    stack: list[str] = []
    frameworks: list[str] = []
    project_type = "Standard Repository"

    # Monorepo indicators
    p_json = root / "package.json"
    pnpm_ws = root / "pnpm-workspace.yaml"
    is_monorepo = False

    if p_json.exists():
        try:
            data = json.loads(p_json.read_text(encoding="utf-8", errors="ignore"))
            if data.get("workspaces") or pnpm_ws.exists():
                is_monorepo = True
                project_type = "Monorepo (Workspaces)"
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            if "next" in deps:
                frameworks.append("Next.js")
            if "react" in deps:
                frameworks.append("React")
            if "electron" in deps:
                frameworks.append("Electron")
            if "vite" in deps:
                frameworks.append("Vite")
            if "tailwindcss" in deps:
                frameworks.append("TailwindCSS")
            if "@modelcontextprotocol/sdk" in deps:
                frameworks.append("Model Context Protocol (MCP)")
            stack.append("TypeScript/JavaScript")
        except Exception:
            pass

    # Python
    pyproject = root / "server" / "pyproject.toml"
    if not pyproject.exists():
        pyproject = root / "pyproject.toml"
    reqs = root / "requirements.txt"

    if pyproject.exists() or reqs.exists() or (root / "server").is_dir():
        stack.append("Python")
        content = ""
        if pyproject.exists():
            content += pyproject.read_text(encoding="utf-8", errors="ignore")
        if reqs.exists():
            content += reqs.read_text(encoding="utf-8", errors="ignore")
        if "fastapi" in content.lower():
            frameworks.append("FastAPI")
        if "sqlalchemy" in content.lower():
            frameworks.append("SQLAlchemy")
        if "celery" in content.lower():
            frameworks.append("Celery")
        if "pydantic" in content.lower():
            frameworks.append("Pydantic")
        if "alembic" in content.lower():
            frameworks.append("Alembic")

    # Rust
    if (root / "Cargo.toml").exists():
        stack.append("Rust")

    # Go
    if (root / "go.mod").exists():
        stack.append("Go")

    # Docker / K8s
    if (root / "Dockerfile").exists() or (root / "server" / "Dockerfile").exists():
        frameworks.append("Docker")
    if (root / "deploy" / "k8s").is_dir() or (root / "k8s").is_dir():
        frameworks.append("Kubernetes / Fleet")

    return {
        "project_type": project_type,
        "is_monorepo": is_monorepo,
        "languages": list(dict.fromkeys(stack)),
        "frameworks": list(dict.fromkeys(frameworks)),
    }


def scan_subsystems(root: Path) -> list[dict[str, Any]]:
    """Scan top-level apps, packages, and core directories."""
    subsystems = []

    # Check for apps/
    apps_dir = root / "apps"
    if apps_dir.is_dir():
        for d in sorted(apps_dir.iterdir()):
            if d.is_dir() and d.name not in IGNORED_DIRS and not d.name.startswith("."):
                desc = "Application package"
                pj = d / "package.json"
                if pj.exists():
                    try:
                        pdata = json.loads(pj.read_text(encoding="utf-8", errors="ignore"))
                        desc = pdata.get("description") or f"{d.name} application"
                    except Exception:
                        pass
                subsystems.append({
                    "name": f"apps/{d.name}",
                    "path": str(d.relative_to(root)),
                    "type": "Application",
                    "description": desc,
                })

    # Check for packages/
    pkgs_dir = root / "packages"
    if pkgs_dir.is_dir():
        for d in sorted(pkgs_dir.iterdir()):
            if d.is_dir() and d.name not in IGNORED_DIRS and not d.name.startswith("."):
                desc = "Shared library package"
                pj = d / "package.json"
                if pj.exists():
                    try:
                        pdata = json.loads(pj.read_text(encoding="utf-8", errors="ignore"))
                        desc = pdata.get("description") or f"{d.name} package"
                    except Exception:
                        pass
                subsystems.append({
                    "name": f"packages/{d.name}",
                    "path": str(d.relative_to(root)),
                    "type": "Package / Service",
                    "description": desc,
                })

    # Check for server/
    server_dir = root / "server"
    if server_dir.is_dir():
        subsystems.append({
            "name": "server",
            "path": "server",
            "type": "Backend API Service",
            "description": "FastAPI backend services, database models, background Celery workers",
        })

    # Check for embedding/
    emb_dir = root / "embedding"
    if emb_dir.is_dir():
        subsystems.append({
            "name": "embedding",
            "path": "embedding",
            "type": "Embedding Microservice",
            "description": "Vector embedding & semantic indexing service",
        })

    # Check for deploy/
    deploy_dir = root / "deploy"
    if deploy_dir.is_dir():
        subsystems.append({
            "name": "deploy",
            "path": "deploy",
            "type": "Infrastructure & Deployment",
            "description": "Kubernetes kustomization manifests, Fleet GitOps configs, systemd services",
        })

    # Fallback if no monorepo structure
    if not subsystems:
        for d in sorted(root.iterdir()):
            if d.is_dir() and d.name not in IGNORED_DIRS and not d.name.startswith("."):
                subsystems.append({
                    "name": d.name,
                    "path": d.name,
                    "type": "Module",
                    "description": f"{d.name} module directory",
                })

    return subsystems


def scan_api_routes(root: Path) -> list[str]:
    """Scan server for registered FastAPI routers."""
    routes: list[str] = []
    api_dir = root / "server" / "server" / "api"
    if not api_dir.is_dir():
        api_dir = root / "api"

    if api_dir.is_dir():
        for py_file in sorted(api_dir.glob("*.py")):
            if py_file.name.startswith("_"):
                continue
            name = py_file.stem
            # Inspect route prefixes
            try:
                content = py_file.read_text(encoding="utf-8", errors="ignore")
                m = re.search(r'router\s*=\s*APIRouter\([^)]*prefix=["\']([^"\']+)["\']', content)
                prefix = m.group(1) if m else f"/{name}"
                routes.append(f"`{prefix}` ({name}.py)")
            except Exception:
                routes.append(f"`/{name}` ({name}.py)")

    return routes


def scan_data_models(root: Path) -> list[str]:
    """Scan server for SQLAlchemy / Pydantic models."""
    models: list[str] = []
    models_file = root / "server" / "server" / "db" / "models.py"
    if not models_file.exists():
        for cand in root.glob("**/models.py"):
            if not any(ign in cand.parts for ign in IGNORED_DIRS):
                models_file = cand
                break

    if models_file.exists():
        try:
            content = models_file.read_text(encoding="utf-8", errors="ignore")
            # Match class ClassName(Base): or class ClassName(BaseModel):
            matches = re.finditer(r'class\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*:', content)
            for m in matches:
                cname = m.group(1)
                bases = m.group(2)
                if any(b in bases for b in ("Base", "Model", "BaseModel", "Table")):
                    models.append(cname)
        except Exception:
            pass

    return models


def generate_mermaid_diagram(subsystems: list[dict[str, Any]], stack: dict[str, Any]) -> str:
    """Generate a high-level architectural data flow diagram in Mermaid format."""
    lines = ["```mermaid", "flowchart TD"]

    has_web = any("apps/web" in s["name"] for s in subsystems)
    has_desktop = any("apps/desktop" in s["name"] for s in subsystems)
    has_daemon = any("packages/daemon" in s["name"] for s in subsystems)
    has_mcp = any("packages/mcp" in s["name"] for s in subsystems)
    has_server = any("server" in s["name"] for s in subsystems)
    has_emb = any("embedding" in s["name"] for s in subsystems)

    lines.append('    subgraph Clients["终端与接入层"]')
    if has_web:
        lines.append('        WEB["Web 前端 (Next.js / React)"]')
    if has_desktop:
        lines.append('        DESK["桌面客户端 (Electron)"]')
    if has_mcp:
        lines.append('        MCP["Memento MCP Server (Claude/Antigravity/Codex)"]')
    lines.append("    end")
    lines.append("")

    if has_daemon:
        lines.append('    subgraph Devices["物理设备守护层"]')
        lines.append('        DAEMON["@memento/daemon (节点执行器 / 文件与会话采集)"]')
        lines.append("    end")
        lines.append("")

    if has_server or has_emb:
        lines.append('    subgraph CoreBackend["后端中枢与智能计算"]')
        if has_server:
            lines.append('        API["FastAPI 异步主服务 (REST / SSE / WS)"]')
            lines.append('        CELERY["Celery 异步 Worker (会话整理 / 梦境提炼 / 任务收割)"]')
        if has_emb:
            lines.append('        EMB["向量推理服务 (Embedding Pipeline)"]')
        lines.append("    end")
        lines.append("")

    lines.append('    subgraph Storage["数据持久化与缓存集群"]')
    lines.append('        PG[("PostgreSQL 向量与全量知识库 (JSONB + pgvector)")]')
    lines.append('        REDIS[("Redis 缓存 / 分布式锁 / 任务总线")]')
    lines.append("    end")
    lines.append("")

    # Relationships
    if has_web and has_server:
        lines.append("    WEB -->|HTTP / SSE / WebSocket| API")
    if has_desktop and has_server:
        lines.append("    DESK -->|HTTP / 自动更新通道| API")
    if has_mcp and has_server:
        lines.append("    MCP -->|API RPC 查询 / 蓝图与规则注入| API")
    if has_daemon and has_server:
        lines.append("    DAEMON -->|长连接心跳 / 采集数据流推入 / 远程任务回传| API")
    if has_server:
        lines.append("    API -->|读写会话、实体、向量| PG")
        lines.append("    API -->|缓存会话字典、租约分发| REDIS")
        lines.append("    CELERY -->|异步任务编排| REDIS")
        lines.append("    CELERY -->|离线提炼、梦境知识归纳| PG")
    if has_server and has_emb:
        lines.append("    API -->|文本向量化| EMB")
        lines.append("    CELERY -->|离线图嵌入| EMB")

    lines.append("```")
    return "\n".join(lines)


def get_git_evolution(root: Path, limit: int = 5) -> list[str]:
    """Retrieve recent non-merge, non-bump commits as evolution steps."""
    out = run_git_cmd(["log", f"-n{limit * 3}", "--pretty=format:%h|%s|%as"], root)
    if not out:
        return []

    evos = []
    for line in out.splitlines():
        parts = line.split("|", 2)
        if len(parts) == 3:
            sha, msg, date = parts
            # Skip CI automated deployment commits
            if "[skip ci]" in msg or "ci(deploy):" in msg:
                continue
            evos.append(f"- `{sha}` ({date}): {msg}")
            if len(evos) >= limit:
                break
    return evos


def build_blueprint_content(root: Path) -> str:
    """Assemble the complete PROJECT_BLUEPRINT.md document."""
    repo_name = root.resolve().name
    git_branch = run_git_cmd(["rev-parse", "--abbrev-ref", "HEAD"], root) or "main"
    git_commit = run_git_cmd(["rev-parse", "--short", "HEAD"], root) or "unknown"
    git_date = run_git_cmd(["log", "-1", "--format=%as"], root) or "recent"

    stack = detect_tech_stack(root)
    subsystems = scan_subsystems(root)
    routes = scan_api_routes(root)
    models = scan_data_models(root)
    mermaid_diagram = generate_mermaid_diagram(subsystems, stack)
    evolution_list = get_git_evolution(root, limit=6)

    doc = [
        f"# Project Blueprint: {repo_name}",
        "",
        "> [!NOTE]",
        f"> **Living Blueprint Auto-Generated** · Branch: `{git_branch}` · Commit: `{git_commit}` · Updated: `{git_date}`",
        "> This document provides an instant, comprehensive architectural map of the codebase.",
        "> AI coding agents (Antigravity, Claude Code, Codex, Cursor, etc.) can read this blueprint",
        "> at the start of any session for instant global orientation without repetitive grep scans.",
        "",
        "## 1. Project Overview & Tech Stack",
        "",
        f"- **Project Type**: {stack['project_type']}",
        f"- **Core Languages**: {', '.join(stack['languages']) if stack['languages'] else 'Generic'}",
        f"- **Key Frameworks**: {', '.join(stack['frameworks']) if stack['frameworks'] else 'None detected'}",
        "",
        "## 2. High-Level Architecture Topology",
        "",
        mermaid_diagram,
        "",
        "## 3. Subsystem Breakdown & Responsibilities",
        "",
        "| Subsystem / Path | Category | Role & Purpose |",
        "| :--- | :--- | :--- |",
    ]

    for s in subsystems:
        doc.append(f"| [`{s['name']}`]({s['path']}) | {s['type']} | {s['description']} |")

    doc.extend([
        "",
        "## 4. Key Entry Points & API Endpoints",
        "",
    ])

    if routes:
        doc.append("### Registered FastAPI API Routers")
        doc.append("")
        for r in routes:
            doc.append(f"- {r}")
        doc.append("")

    if models:
        doc.append("### Core Database Models (`models.py`)")
        doc.append("")
        doc.append(", ".join(f"`{m}`" for m in models))
        doc.append("")

    doc.extend([
        "## 5. Development & Verification Commands",
        "",
        "```bash",
        "# Backend Tests (Python)",
        "cd server && uv run pytest -W error::RuntimeWarning",
        "",
        "# Backend Lint",
        "uvx ruff check --isolated --select F server/server",
        "",
        "# Frontend Tests & Typecheck (Next.js)",
        "cd apps/web && npx tsc --noEmit && npm test",
        "",
        "# Daemon Tests",
        "cd packages/daemon && npm test",
        "",
        "# Desktop Tests & Typecheck (Electron)",
        "npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test",
        "```",
        "",
        "## 6. Recent Architectural Evolutions",
        "",
    ])

    if evolution_list:
        doc.extend(evolution_list)
    else:
        doc.append("- Initial project baseline established.")

    doc.extend([
        "",
        "---",
        "_Auto-maintained by `scripts/project_blueprint.py` & `.git/hooks/post-commit`. Updates automatically on code modifications._",
        "",
    ])

    return "\n".join(doc)


def install_git_hook(root: Path) -> bool:
    """Install a post-commit Git hook to keep PROJECT_BLUEPRINT.md in sync."""
    hooks_dir = root / ".git" / "hooks"
    if not hooks_dir.is_dir():
        print(f"Error: {hooks_dir} does not exist. Is this a git repository?", file=sys.stderr)
        return False

    hook_file = hooks_dir / "post-commit"
    hook_script = """#!/bin/sh
# Auto-update PROJECT_BLUEPRINT.md upon commit
if [ -f "scripts/project_blueprint.py" ]; then
    python3 scripts/project_blueprint.py --root . --quiet >/dev/null 2>&1 || true
fi
"""

    if hook_file.exists():
        existing = hook_file.read_text(encoding="utf-8", errors="ignore")
        if "project_blueprint.py" in existing:
            # Already installed
            return True
        hook_file.write_text(existing + "\n" + hook_script, encoding="utf-8")
    else:
        hook_file.write_text(hook_script, encoding="utf-8")

    try:
        hook_file.chmod(0o755)
    except Exception:
        pass

    return True


def uninstall_git_hook(root: Path) -> bool:
    """Remove post-commit Git hook entry."""
    hook_file = root / ".git" / "hooks" / "post-commit"
    if not hook_file.exists():
        return True

    existing = hook_file.read_text(encoding="utf-8", errors="ignore")
    lines = [line for line in existing.splitlines() if "project_blueprint.py" not in line and "PROJECT_BLUEPRINT.md" not in line]
    hook_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate and maintain living PROJECT_BLUEPRINT.md for AI agents.")
    parser.add_argument("--root", type=str, default=".", help="Project root directory (default: current directory)")
    parser.add_argument("--output", type=str, default="", help="Output markdown path (default: <root>/PROJECT_BLUEPRINT.md)")
    parser.add_argument("--install-hook", action="store_true", help="Install git post-commit hook for auto-syncing")
    parser.add_argument("--uninstall-hook", action="store_true", help="Uninstall git post-commit hook")
    parser.add_argument("--check", action="store_true", help="Check if current PROJECT_BLUEPRINT.md is up-to-date")
    parser.add_argument("--quiet", action="store_true", help="Suppress stdout messages")

    args = parser.parse_args()
    root = Path(args.root).resolve()

    if args.install_hook:
        ok = install_git_hook(root)
        if not args.quiet:
            print("Git post-commit hook installed successfully." if ok else "Failed to install git hook.")
        return 0 if ok else 1

    if args.uninstall_hook:
        ok = uninstall_git_hook(root)
        if not args.quiet:
            print("Git post-commit hook uninstalled.")
        return 0 if ok else 1

    out_path = Path(args.output).resolve() if args.output else root / "PROJECT_BLUEPRINT.md"
    content = build_blueprint_content(root)

    if args.check:
        if not out_path.exists():
            if not args.quiet:
                print(f"{out_path.name} is missing.")
            return 1
        current = out_path.read_text(encoding="utf-8", errors="ignore")
        if current.strip() != content.strip():
            if not args.quiet:
                print(f"{out_path.name} is outdated.")
            return 1
        if not args.quiet:
            print(f"{out_path.name} is up to date.")
        return 0

    out_path.write_text(content, encoding="utf-8")
    if not args.quiet:
        print(f"Generated living blueprint at: {out_path} ({len(content)} bytes)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
