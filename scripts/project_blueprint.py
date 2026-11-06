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


def scan_frontend_routes(root: Path) -> list[str]:
    """Scan Next.js App Router for web page routes."""
    routes: list[str] = []
    candidates = [
        root / "apps" / "web" / "src" / "app",
        root / "web" / "src" / "app",
        root / "src" / "app",
        root / "app",
    ]
    app_dir = next((c for c in candidates if c.is_dir()), None)
    if app_dir:
        for page_file in sorted(app_dir.glob("**/page.tsx")):
            rel = page_file.parent.relative_to(app_dir)
            route_path = "/" if str(rel) == "." else f"/{rel}"
            # Clean route groups like (auth) or (main)
            route_path = re.sub(r'/\([^)]+\)', '', route_path) or "/"
            routes.append(route_path)
    return sorted(list(dict.fromkeys(routes)))


def scan_api_routes(root: Path) -> list[dict[str, Any]]:
    """Scan server for registered FastAPI routers and their core endpoints."""
    routes: list[dict[str, Any]] = []
    api_dir = root / "server" / "server" / "api"
    if not api_dir.is_dir():
        api_dir = root / "api"

    if api_dir.is_dir():
        for py_file in sorted(api_dir.glob("*.py")):
            if py_file.name.startswith("_"):
                continue
            name = py_file.stem
            try:
                content = py_file.read_text(encoding="utf-8", errors="ignore")
                m = re.search(r'router\s*=\s*APIRouter\([^)]*prefix=["\']([^"\']+)["\']', content)
                prefix = m.group(1) if m else f"/{name}"

                endpoints: list[str] = []
                for em in re.finditer(r'@router\.(get|post|put|delete|patch)\(\s*["\']([^"\']*)["\']', content):
                    method = em.group(1).upper()
                    subpath = em.group(2)
                    full_p = f"{prefix.rstrip('/')}/{subpath.lstrip('/')}".rstrip('/') or "/"
                    endpoints.append(f"`{method} {full_p}`")

                routes.append({
                    "name": name,
                    "prefix": prefix,
                    "endpoints": endpoints[:5],
                    "total": len(endpoints),
                })
            except Exception:
                routes.append({
                    "name": name,
                    "prefix": f"/{name}",
                    "endpoints": [],
                    "total": 0,
                })

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


def detect_verification_commands(root: Path) -> list[str]:
    """Detect project-specific verification, test, and typecheck commands."""
    commands: list[str] = []

    # 1. Specialized detection for Memento Monorepo
    if (root / "packages" / "daemon").is_dir() and (root / "server" / "server").is_dir():
        commands.extend([
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
        ])
        return commands

    # 2. General Python project
    pyproject = root / "pyproject.toml"
    has_python = pyproject.exists() or (root / "requirements.txt").exists() or (root / "setup.py").exists() or any(root.glob("*.py"))
    if has_python:
        if (root / "pytest.ini").exists() or (root / "tests").is_dir() or (root / "test").is_dir():
            commands.extend(["# Python Tests", "pytest"])
        if (root / "ruff.toml").exists() or (pyproject.exists() and "ruff" in pyproject.read_text(encoding="utf-8", errors="ignore")):
            commands.extend(["# Python Lint", "ruff check ."])

    # 3. General Node / TypeScript project
    pjson_path = root / "package.json"
    if pjson_path.exists():
        try:
            pdata = json.loads(pjson_path.read_text(encoding="utf-8", errors="ignore"))
            scripts = pdata.get("scripts", {})
            if "test" in scripts:
                commands.extend(["# Unit Tests", "npm test"])
            if "typecheck" in scripts or (root / "tsconfig.json").exists():
                commands.extend(["# Typecheck", "npx tsc --noEmit"])
            if "lint" in scripts:
                commands.extend(["# Code Lint", "npm run lint"])
            if "build" in scripts:
                commands.extend(["# Build Package", "npm run build"])
        except Exception:
            pass

    # 4. Rust project
    if (root / "Cargo.toml").exists():
        commands.extend(["# Cargo Tests", "cargo test", "", "# Cargo Clippy", "cargo clippy"])

    # 5. Go project
    if (root / "go.mod").exists():
        commands.extend(["# Go Tests", "go test ./..."])

    # Fallback default
    if not commands:
        commands.extend(["# Project Status & Integrity Check", "git status -s"])

    return commands


def build_blueprint_content(root: Path) -> str:
    """Assemble the complete PROJECT_BLUEPRINT.md document."""
    repo_name = root.resolve().name
    pjson = root / "package.json"
    if pjson.exists():
        try:
            data = json.loads(pjson.read_text(encoding="utf-8", errors="ignore"))
            if data.get("name") and isinstance(data["name"], str):
                repo_name = data["name"].split("/")[-1]
        except Exception:
            pass
    git_branch = run_git_cmd(["rev-parse", "--abbrev-ref", "HEAD"], root) or "main"
    git_commit = run_git_cmd(["rev-parse", "--short", "HEAD"], root) or "unknown"
    git_date = run_git_cmd(["log", "-1", "--format=%as"], root) or "recent"

    stack = detect_tech_stack(root)
    subsystems = scan_subsystems(root)
    frontend_routes = scan_frontend_routes(root)
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

    if frontend_routes:
        doc.append("### Frontend Pages & App Router")
        doc.append("")
        for f in frontend_routes:
            doc.append(f"- `{f}`")
        doc.append("")

    if routes:
        doc.append("### Registered FastAPI API Routers & Endpoints")
        doc.append("")
        for r in routes:
            doc.append(f"#### `{r['prefix']}` ({r['name']}.py)")
            if r["endpoints"]:
                doc.append("")
                for ep in r["endpoints"]:
                    doc.append(f"- {ep}")
                if r["total"] > len(r["endpoints"]):
                    doc.append(f"- _... ({r['total'] - len(r['endpoints'])} more endpoints)_")
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
        *detect_verification_commands(root),
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
        "_Auto-maintained by `scripts/project_blueprint.py` & `.git/hooks/(post-commit, post-merge, post-checkout)`. Updates automatically on code modifications, pulls, and branch switches._",
        "",
    ])

    return "\n".join(doc)


HOOK_MARKER_START = "# <<< Memento Blueprint Hook Start >>>"
HOOK_MARKER_END = "# <<< Memento Blueprint Hook End >>>"

HOOK_TEMPLATE = f"""{HOOK_MARKER_START}
# Auto-update PROJECT_BLUEPRINT.md upon commit (managed by Memento)
BP_SCRIPT=""
if [ -f "scripts/project_blueprint.py" ]; then
    BP_SCRIPT="scripts/project_blueprint.py"
elif [ -f "$HOME/.memento/scripts/project_blueprint.py" ]; then
    BP_SCRIPT="$HOME/.memento/scripts/project_blueprint.py"
fi

if [ -n "$BP_SCRIPT" ]; then
    python3 "$BP_SCRIPT" --root . --quiet >/dev/null 2>&1 || true
fi
{HOOK_MARKER_END}"""


def _clean_hook_content(content: str) -> str:
    """Safely strip any Memento blueprint hook block or legacy artifacts."""
    # Strip tagged blocks
    cleaned = re.sub(
        rf"{re.escape(HOOK_MARKER_START)}[\s\S]*?{re.escape(HOOK_MARKER_END)}\n?",
        "",
        content,
    )
    # Strip legacy untagged artifacts
    cleaned = re.sub(
        r"# Auto-update PROJECT_BLUEPRINT\.md[^\n]*\n(?:[^\n]*\n)*?python3[^\n]*project_blueprint\.py[^\n]*\n(?:fi\n)?",
        "",
        cleaned,
    )
    # Filter orphan lines matching blueprint patterns
    clean_lines = []
    for line in cleaned.splitlines():
        trimmed = line.strip()
        if any(token in trimmed for token in ("project_blueprint.py", "PROJECT_BLUEPRINT.md", "BP_SCRIPT")):
            continue
        clean_lines.append(line)

    # If remaining lines contain no actual user logic (only repeated shebangs or dangling fi's)
    non_trivial = [l for l in clean_lines if l.strip() and not l.strip().startswith("#!") and l.strip() != "fi"]
    if not non_trivial:
        return ""
    return "\n".join(clean_lines).strip()


MANAGED_GIT_HOOKS = ["post-commit", "post-merge", "post-checkout"]


def install_git_hook(root: Path) -> bool:
    """Install post-commit, post-merge, and post-checkout Git hooks to keep PROJECT_BLUEPRINT.md in sync across all projects."""
    git_dir = root / ".git"
    if not git_dir.exists():
        print(f"Error: {git_dir} does not exist. Is this a git repository?", file=sys.stderr)
        return False

    hooks_dir = git_dir / "hooks"
    try:
        hooks_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    if not hooks_dir.is_dir():
        print(f"Error: {hooks_dir} does not exist. Is this a git repository?", file=sys.stderr)
        return False

    # Ensure generator script is synced to global ~/.memento/scripts for external repos
    try:
        global_memento_dir = Path.home() / ".memento" / "scripts"
        global_memento_dir.mkdir(parents=True, exist_ok=True)
        global_script = global_memento_dir / "project_blueprint.py"
        current_script = Path(__file__).resolve()
        if current_script.is_file():
            cur_content = current_script.read_text(encoding="utf-8")
            if not global_script.exists() or global_script.read_text(encoding="utf-8") != cur_content:
                global_script.write_text(cur_content, encoding="utf-8")
                global_script.chmod(0o755)
    except Exception:
        pass

    all_ok = True
    for hname in MANAGED_GIT_HOOKS:
        hook_file = hooks_dir / hname
        existing = hook_file.read_text(encoding="utf-8", errors="ignore") if hook_file.exists() else ""
        cleaned = _clean_hook_content(existing)

        if not cleaned or cleaned.strip() in ("#!/bin/sh", "#!/bin/bash"):
            new_content = f"#!/bin/sh\n\n{HOOK_TEMPLATE}\n"
        else:
            new_content = f"{cleaned.rstrip()}\n\n{HOOK_TEMPLATE}\n"

        try:
            hook_file.write_text(new_content, encoding="utf-8")
            hook_file.chmod(0o755)
        except Exception:
            all_ok = False

    return all_ok


def uninstall_git_hook(root: Path) -> bool:
    """Remove Memento blueprint Git hook entries across all managed hooks."""
    git_dir = root / ".git"
    hooks_dir = git_dir / "hooks" if git_dir.exists() else None
    if not hooks_dir or not hooks_dir.is_dir():
        return True

    for hname in MANAGED_GIT_HOOKS:
        hook_file = hooks_dir / hname
        if not hook_file.exists():
            continue
        existing = hook_file.read_text(encoding="utf-8", errors="ignore")
        cleaned = _clean_hook_content(existing)

        if not cleaned or cleaned.strip() in ("#!/bin/sh", "#!/bin/bash"):
            hook_file.write_text("", encoding="utf-8")
        else:
            hook_file.write_text(cleaned.strip() + "\n", encoding="utf-8")

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
        try:
            out_path = Path(args.output).resolve() if args.output else root / "PROJECT_BLUEPRINT.md"
            content = build_blueprint_content(root)
            out_path.write_text(content, encoding="utf-8")
        except Exception as e:
            if not args.quiet:
                print(f"Warning: Failed to generate blueprint file during hook install: {e}", file=sys.stderr)
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
