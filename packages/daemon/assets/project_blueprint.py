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
import ast
import hashlib
import json
import os
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
    "env",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    ".tox",
    "dist",
    "build",
    ".next",
    ".turbo",
    "out",
    "target",
    "coverage",
    "htmlcov",
    ".idea",
    ".vscode",
    ".gemini",
    "data",
    "datasets",
    "logs",
    "tmp",
    "temp",
    "checkpoints",
    "weights",
    "site-packages",
    "vendor",
}

# Max depth for directory tree rendering in blueprint
MAX_TREE_DEPTH = 3

# Monotonically increasing generator version for cross-device OTA synchronization
BLUEPRINT_SCRIPT_VERSION = 20261111

BLUEPRINT_FILE = "PROJECT_BLUEPRINT.md"
# The footer every generated blueprint ends with: tells our files from hand-written ones
GENERATED_MARK = "_Auto-maintained by `scripts/project_blueprint.py`"
# The HEAD the blueprint was last generated for, in the repo's git dir (the collector compares it)
HEAD_MARKER = ".memento_blueprint_head"
# Keeps a generated, untracked blueprint out of `git status` (in .git/info/exclude, never .gitignore)
EXCLUDE_MARK = "# memento:blueprint (generated locally, not tracked)"
ANCHOR_MARKER = "<!-- memento:blueprint-anchor -->"


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


def _git_ok(args: list[str], cwd: Path) -> bool:
    """Whether a git command exits 0."""
    try:
        res = subprocess.run(
            ["git", *args],
            cwd=cwd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
        return res.returncode == 0
    except Exception:
        return False


def _git_path(root: Path, flag: str) -> Path | None:
    """`git rev-parse --git-dir` / `--git-common-dir` as an absolute path (worktrees have a .git file)."""
    out = run_git_cmd(["rev-parse", flag], root)
    if out:
        p = Path(out)
        return (p if p.is_absolute() else root / p).resolve()
    dot_git = root / ".git"
    return dot_git if dot_git.is_dir() else None


def _is_tracked(root: Path) -> bool:
    return _git_ok(["ls-files", "--error-unmatch", "--", BLUEPRINT_FILE], root)


def _is_generated(path: Path) -> bool:
    """A blueprint this script wrote (not a hand-written file of the same name)."""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    return text.startswith("# Project Blueprint:") and GENERATED_MARK in text


def _atomic_write(path: Path, content: str) -> bool:
    """Write through a temp file and a rename, so a reader never sees half a file. False when unchanged."""
    try:
        if path.read_text(encoding="utf-8") == content:
            return False
    except (OSError, UnicodeDecodeError):
        pass
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    return True


# What this script changed in each repo, so turning it off or uninstalling takes all of it back.
# One file per repo: the collector refreshes several repos at once.
def _state_dir() -> Path:
    return Path.home() / ".memento" / "blueprint_repos"


def _state_file(root: Path) -> Path:
    key = hashlib.sha1(str(root.resolve()).encode("utf-8")).hexdigest()[:16]
    return _state_dir() / f"{key}.json"


def _load_state(root: Path) -> dict[str, Any]:
    try:
        data = json.loads(_state_file(root).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _record_state(root: Path, **changes: Any) -> None:
    """Merge into the repo's state; lists are unions (hooks, anchors), other values replace."""
    try:
        state = _load_state(root)
        state["root"] = str(root.resolve())
        for key, value in changes.items():
            if isinstance(value, list):
                state[key] = sorted(set(state.get(key) or []) | set(value))
            else:
                state[key] = value
        path = _state_file(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    except OSError:
        pass


_REPO_FILE_CACHE: dict[Path, list[tuple[Path, str]]] = {}
_GLOB_REGEX_CACHE: dict[str, re.Pattern[str]] = {}


def _compile_glob_pattern(pattern: str) -> re.Pattern[str]:
    if pattern in _GLOB_REGEX_CACHE:
        return _GLOB_REGEX_CACHE[pattern]
    p = pattern
    out: list[str] = ["^"]
    i = 0
    n = len(p)
    while i < n:
        if p.startswith("/**/", i):
            out.append("(?:/.+)?/")
            i += 4
        elif i == 0 and p.startswith("**/", i):
            out.append("(?:.+/)?")
            i += 3
        elif p[i] == "*":
            out.append("[^/]*")
            i += 1
        elif p[i] == "?":
            out.append("[^/]")
            i += 1
        elif p[i] == "[":
            j = p.find("]", i + 1)
            if j != -1:
                out.append(p[i : j + 1])
                i = j + 1
            else:
                out.append(r"\[")
                i += 1
        else:
            out.append(re.escape(p[i]))
            i += 1
    out.append("$")
    rx = re.compile("".join(out))
    _GLOB_REGEX_CACHE[pattern] = rx
    return rx


def _read_code(path: Path, max_chars: int = 200_000) -> str:
    """Safely read up to max_chars of a source file to prevent hanging on giant bundles or dumps."""
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as fh:
            return fh.read(max_chars)
    except Exception:
        return ""


def _get_repo_files(root: Path) -> list[tuple[Path, str]]:
    resolved = root.resolve()
    if resolved in _REPO_FILE_CACHE:
        return _REPO_FILE_CACHE[resolved]
    files: list[tuple[Path, str]] = []
    root_str = str(resolved)
    for cur_dir, dirs, filenames in os.walk(root_str):
        rel_dir = os.path.relpath(cur_dir, root_str)
        depth = 0 if rel_dir == "." else rel_dir.count(os.sep) + 1
        if depth >= 6:
            dirs[:] = []
        else:
            dirs[:] = sorted(
                d
                for d in dirs
                if d not in IGNORED_DIRS and not d.startswith(".git") and (d == ".github" or not d.startswith("."))
            )
        for fn in sorted(filenames):
            if fn.startswith(".") and fn not in (".env.example", ".env.sample"):
                continue
            if fn.endswith((".min.js", ".bundle.js", ".chunk.js", ".map")):
                continue
            full_p = Path(cur_dir) / fn
            rel_posix = fn if rel_dir == "." else f"{rel_dir.replace(os.sep, '/')}/{fn}"
            files.append((full_p, rel_posix))
            if len(files) >= 6000:
                break
        if len(files) >= 6000:
            break
    _REPO_FILE_CACHE[resolved] = files
    return files


def _iter_repo_files(root: Path, pattern: str, limit: int = 80) -> list[Path]:
    """Safely iterate matching files in root using single-pass pruned directory walk."""
    rx = _compile_glob_pattern(pattern)
    out: list[Path] = []
    for full_p, rel_posix in _get_repo_files(root):
        if rx.match(rel_posix):
            out.append(full_p)
            if len(out) >= limit:
                break
    return sorted(out)


def detect_tech_stack(root: Path) -> dict[str, Any]:
    """Detect technologies, package managers, and architectural styles across root and all subdirectories."""
    stack: list[str] = []
    frameworks: list[str] = []
    project_type = "Standard Repository"

    p_json = root / "package.json"
    pnpm_ws = root / "pnpm-workspace.yaml"
    is_monorepo = False

    # 1. Node / TypeScript / Frontend / Desktop manifests (root + subdirectories)
    pkg_files = [p_json] if p_json.exists() else []
    for sub_pj in _iter_repo_files(root, "**/package.json", limit=25):
        if sub_pj not in pkg_files:
            pkg_files.append(sub_pj)

    if len(pkg_files) > 1 or pnpm_ws.exists() or ((root / "backend").is_dir() and (root / "frontend").is_dir()):
        project_type = "Multi-Service / Full-Stack Repository"

    for pj in pkg_files:
        try:
            data = json.loads(_read_code(pj))
            if pj == p_json and (data.get("workspaces") or pnpm_ws.exists()):
                is_monorepo = True
                project_type = "Monorepo (Workspaces)"
            deps = {**(data.get("dependencies") or {}), **(data.get("devDependencies") or {})}
            dep_keys = {k.lower() for k in deps}
            if "next" in dep_keys:
                frameworks.append("Next.js")
            if "react" in dep_keys or "react-dom" in dep_keys:
                frameworks.append("React")
            if "vue" in dep_keys or "nuxt" in dep_keys:
                frameworks.append("Vue / Nuxt")
            if "electron" in dep_keys:
                frameworks.append("Electron")
            if "@tauri-apps/api" in dep_keys or "@tauri-apps/cli" in dep_keys:
                frameworks.append("Tauri")
            if "vite" in dep_keys:
                frameworks.append("Vite")
            if "tailwindcss" in dep_keys:
                frameworks.append("TailwindCSS")
            if "express" in dep_keys:
                frameworks.append("Express")
            if "fastify" in dep_keys:
                frameworks.append("Fastify")
            if "socket.io" in dep_keys or "socket.io-client" in dep_keys:
                frameworks.append("Socket.IO")
            if "@modelcontextprotocol/sdk" in dep_keys:
                frameworks.append("Model Context Protocol (MCP)")
            stack.append("TypeScript/JavaScript")
        except Exception:
            pass

    # 2. Python manifests & source files (root + subdirectories)
    py_manifests = (
        ([root / "pyproject.toml"] if (root / "pyproject.toml").exists() else [])
        + ([root / "requirements.txt"] if (root / "requirements.txt").exists() else [])
        + _iter_repo_files(root, "**/pyproject.toml", limit=15)
        + _iter_repo_files(root, "**/requirements*.txt", limit=15)
    )
    py_files = _iter_repo_files(root, "**/*.py", limit=20)
    if py_manifests or py_files:
        stack.append("Python")
        py_blob = "\n".join(_read_code(m, 50_000).lower() for m in dict.fromkeys(py_manifests))
        if len(py_blob) < 200 and py_files:
            py_blob += "\n" + "\n".join(_read_code(pf, 8_000).lower() for pf in py_files[:8])
        if "fastapi" in py_blob:
            frameworks.append("FastAPI")
        if "flask" in py_blob:
            frameworks.append("Flask")
        if "django" in py_blob:
            frameworks.append("Django")
        if "sqlalchemy" in py_blob or "sqlmodel" in py_blob:
            frameworks.append("SQLAlchemy")
        if "celery" in py_blob:
            frameworks.append("Celery")
        if "pydantic" in py_blob:
            frameworks.append("Pydantic")
        if "alembic" in py_blob:
            frameworks.append("Alembic")
        if "tqsdk" in py_blob:
            frameworks.append("TqSdk (Futures Quant)")
        if "rdkit" in py_blob:
            frameworks.append("RDKit (Cheminformatics)")
        if "socketio" in py_blob or "engineio" in py_blob:
            frameworks.append("Socket.IO")

    # 3. Rust / Tauri / Go / JVM / Shell
    cargo_files = ([root / "Cargo.toml"] if (root / "Cargo.toml").exists() else []) + _iter_repo_files(root, "**/Cargo.toml", limit=10)
    if cargo_files or _iter_repo_files(root, "**/*.rs", limit=5):
        stack.append("Rust")
        cargo_blob = "\n".join(_read_code(cf, 30_000).lower() for cf in cargo_files)
        if "tauri" in cargo_blob:
            frameworks.append("Tauri")
        if "axum" in cargo_blob:
            frameworks.append("Axum")
        if "actix-web" in cargo_blob:
            frameworks.append("Actix Web")

    if (root / "go.mod").exists() or _iter_repo_files(root, "**/go.mod", limit=5) or _iter_repo_files(root, "**/*.go", limit=5):
        stack.append("Go")

    if not stack and _iter_repo_files(root, "**/*.[tj]s*", limit=5):
        stack.append("TypeScript/JavaScript")
    if _iter_repo_files(root, "**/*.sh", limit=5):
        stack.append("Shell / Bash")

    # 4. Docker / K8s
    if (
        (root / "Dockerfile").exists()
        or (root / "docker-compose.yml").exists()
        or (root / "docker-compose.yaml").exists()
        or _iter_repo_files(root, "**/Dockerfile*", limit=10)
        or _iter_repo_files(root, "**/dockerfile*", limit=10)
    ):
        frameworks.append("Docker")
    if (root / "deploy" / "k8s").is_dir() or (root / "k8s").is_dir() or _iter_repo_files(root, "**/k8s/*.y*ml", limit=5):
        frameworks.append("Kubernetes / Fleet")

    return {
        "project_type": project_type,
        "is_monorepo": is_monorepo,
        "languages": list(dict.fromkeys(stack)),
        "frameworks": list(dict.fromkeys(frameworks)),
    }


# Template READMEs that say nothing about the project itself
README_BOILERPLATE = (
    "this template should help get you started",
    "getting started with create react app",
    "a new flutter project",
    "welcome to your new",
    "bootstrapped with",
    "create-next-app",
    "react + typescript + vite",
    "vue 3 + typescript + vite",
    "recommended ide setup",
)
README_NAMES = ("README.md", "readme.md", "Readme.md", "README.zh-CN.md", "README_zh.md", "README.markdown", "README.rst", "README.txt", "README")
ABOUT_MAX_CHARS = 200


def _plain_markdown(line: str) -> str:
    """One markdown line as plain text: links keep their text, images, emphasis and inline code marks go."""
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", line)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"(\*\*|__|\*|`)", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _readme_about(text: str) -> str:
    """The README's opening prose (tagline and first paragraph), skipping titles, badges, nav and lists."""
    paragraphs: list[str] = []
    current: list[str] = []
    in_fence = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if line.startswith(">"):
            line = line.lstrip("> ").strip()
            if line.startswith("[!"):
                line = ""
        skip = (
            not line
            or line.startswith(("#", "<", "|", "![", "[![", "- ", "* ", "+ ", "===", "---", "***"))
            or re.match(r"^\d+[.)]\s", line) is not None
            or len(re.findall(r"\]\(", line)) >= 2  # a row of links: badges, nav, language switch
        )
        plain = "" if skip else _plain_markdown(line)
        if not plain or len(re.sub(r"[\W_]", "", plain)) < 4:
            if current:
                paragraphs.append(" ".join(current))
                current = []
            if line.startswith("#") and paragraphs:
                break  # the intro ends at the first section heading after it
            continue
        if any(bp in plain.lower() for bp in README_BOILERPLATE):
            return ""
        current.append(plain)
        if len(paragraphs) >= 2:
            break
    if current:
        paragraphs.append(" ".join(current))
    about = ""
    for para in paragraphs[:2]:
        if about and len(about) >= 60:
            break
        sep = "" if not about else ("" if about.endswith(("。", "！", "？", ".", "!", "?", "；", ";")) else "。")
        about = f"{about}{sep}{para}" if about else para
    return about


def _clip_sentence(text: str, limit: int = ABOUT_MAX_CHARS) -> str:
    """Cut at the last sentence end within the limit, or at the limit with an ellipsis."""
    if len(text) <= limit:
        return text
    head = text[:limit]
    cut = max(head.rfind(ch) for ch in ("。", "！", "？", "；", ". ", "! ", "? "))
    if cut >= limit // 2:
        return head[: cut + 1].rstrip()
    return head.rstrip() + "…"


def detect_project_about(root: Path) -> str:
    """What the project is, in its authors' words: README intro, else the manifest description, else docs/."""
    for name in README_NAMES:
        rm = root / name
        if rm.is_file():
            about = _readme_about(_read_code(rm, 8_000))
            if about:
                return _clip_sentence(_sanitize_blueprint_text(about))
            break
    pj = root / "package.json"
    if pj.is_file():
        try:
            desc = json.loads(_read_code(pj, 50_000)).get("description")
            if isinstance(desc, str) and desc.strip():
                return _clip_sentence(_sanitize_blueprint_text(_plain_markdown(desc)))
        except Exception:
            pass
    for manifest, section in (("pyproject.toml", "project"), ("pyproject.toml", "tool.poetry"), ("Cargo.toml", "package")):
        mf = root / manifest
        if not mf.is_file():
            continue
        body = re.search(rf"^\[{re.escape(section)}\]\s*$([\s\S]*?)(?=^\[|\Z)", _read_code(mf, 50_000), re.MULTILINE)
        m = re.search(r'^description\s*=\s*["\']([^"\']+)["\']', body.group(1), re.MULTILINE) if body else None
        if m and m.group(1).strip():
            return _clip_sentence(_sanitize_blueprint_text(m.group(1).strip()))
    # No README or manifest at the root (e.g. a backend/ + frontend/ repo): its overview doc
    for name in ("README.md", "overview.md", "architecture.md", "index.md", "intro.md"):
        doc = root / "docs" / name
        if doc.is_file():
            about = _readme_about(_read_code(doc, 8_000))
            if about:
                return _clip_sentence(_sanitize_blueprint_text(about))
    return ""


def _infer_dir_role_and_desc(d: Path) -> tuple[str, str]:
    """Infer semantic category and human-readable description for a project subdirectory."""
    name_low = d.name.lower()
    role_map = {
        "backend": ("Backend API Service", "Backend API server, domain business logic, and data access layer"),
        "server": ("Backend API Service", "Backend service, HTTP/WebSocket handlers, and persistence"),
        "api": ("API Layer", "REST / RPC API routers and request handlers"),
        "src": ("Core Source Package", "Primary application source code, API handlers, and domain engines"),
        "frontend": ("Frontend Web App", "Web frontend user interface, state management, and components"),
        "web": ("Frontend Web App", "Browser web interface, interactive views, and client assets"),
        "mobile": ("Mobile Application", "Cross-platform mobile client application"),
        "client": ("Frontend Client", "Client-side application views and API integration"),
        "desktop": ("Desktop Application", "Cross-platform desktop client application (Electron / Tauri)"),
        "src-tauri": ("Rust Native Core", "Tauri Rust native backend, system tray, and OS integration"),
        "quant": ("Quant Trading Core", "Quantitative strategy execution, market data feed, and order routing"),
        "research": ("Quant Research & Alpha", "Factor mining, backtesting experiments, and quantitative research scripts"),
        "market_data": ("Market Data Pipeline", "Historical and real-time market quote ingestion and storage"),
        "engineio": ("Real-Time Transport", "Socket.IO / Engine.IO bidirectional real-time event transport"),
        "scripts": ("Automation & CLI Scripts", "Data loading, maintenance, operational CLI, and automation utilities"),
        "ci-scripts": ("CI/CD Automation", "Continuous integration build, packaging, and verification scripts"),
        "docker": ("Container Infrastructure", "Dockerfiles, container entrypoints, and environment build configs"),
        "deploy": ("Infrastructure & Deployment", "Kubernetes manifests, GitOps configs, and service deployment definitions"),
        "k8s": ("Kubernetes Manifests", "Kubernetes Deployments, Services, Ingresses, and ConfigMaps"),
        "docs": ("Architecture & Docs", "Technical specifications, runbooks, and design documentation"),
        "tests": ("Test Suites", "Automated unit, integration, and end-to-end verification suites"),
        "test": ("Test Suites", "Automated unit and integration verification suites"),
    }
    role, default_desc = role_map.get(name_low, ("Core Module", f"{d.name} domain module"))

    pj = d / "package.json"
    if pj.exists():
        try:
            pdata = json.loads(_read_code(pj, 20_000))
            if isinstance(pdata.get("description"), str) and pdata["description"].strip():
                return role, pdata["description"].strip()[:120]
        except Exception:
            pass

    pp = d / "pyproject.toml"
    if pp.exists():
        m = re.search(r'^description\s*=\s*["\']([^"\']+)["\']', _read_code(pp, 20_000), re.MULTILINE)
        if m and m.group(1).strip():
            return role, m.group(1).strip()[:120]

    for rm_name in ("README.md", "readme.md"):
        rm = d / rm_name
        if rm.exists():
            for line in _read_code(rm, 4_000).splitlines():
                sline = line.strip()
                if sline and not sline.startswith(("#", "!", "[", ">", "`", "-")):
                    if any(bp in sline.lower() for bp in README_BOILERPLATE):
                        break
                    return role, sline[:120]

    entry_candidates = [
        d / "main.py",
        d / "app.py",
        d / "server.py",
        d / "__init__.py",
        d / "app" / "main.py",
        d / "src" / "index.ts",
        d / "src" / "main.ts",
    ]
    if name_low == "src":
        for child in sorted(d.iterdir()):
            if child.is_dir() and not child.name.startswith(("_", ".")):
                entry_candidates.extend([child / "__init__.py", child / "main.py", child / "cli.py", child / "api" / "app.py"])

    for ep in entry_candidates:
        if ep.is_file():
            txt = _read_code(ep, 3_000)
            dm = re.match(r'^(?:#![^\n]*\n)?\s*(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')', txt)
            if dm and dm.group(1).strip():
                first_line = dm.group(1).strip().splitlines()[0].strip()
                if first_line:
                    return role, first_line[:120]

    return role, default_desc


def scan_subsystems(root: Path) -> list[dict[str, Any]]:
    """Scan top-level apps, packages, core directories, and root-level primary modules."""
    subsystems: list[dict[str, Any]] = []
    seen_paths: set[str] = set()

    apps_dir = root / "apps"
    pkgs_dir = root / "packages"
    is_workspace_monorepo = apps_dir.is_dir() or pkgs_dir.is_dir()

    if is_workspace_monorepo:
        if apps_dir.is_dir():
            for d in sorted(apps_dir.iterdir()):
                if d.is_dir() and d.name not in IGNORED_DIRS and not d.name.startswith("."):
                    _, desc = _infer_dir_role_and_desc(d)
                    rel = str(d.relative_to(root))
                    seen_paths.add(rel)
                    subsystems.append({
                        "name": f"apps/{d.name}",
                        "path": rel,
                        "type": "Application",
                        "description": desc if desc != f"{d.name} domain module" else f"{d.name} application",
                    })

        if pkgs_dir.is_dir():
            for d in sorted(pkgs_dir.iterdir()):
                if d.is_dir() and d.name not in IGNORED_DIRS and not d.name.startswith("."):
                    _, desc = _infer_dir_role_and_desc(d)
                    rel = str(d.relative_to(root))
                    seen_paths.add(rel)
                    subsystems.append({
                        "name": f"packages/{d.name}",
                        "path": rel,
                        "type": "Package / Service",
                        "description": desc if desc != f"{d.name} domain module" else f"{d.name} package",
                    })

        for fixed_name, fixed_type, fixed_desc in (
            ("server", "Backend API Service", "FastAPI backend services, database models, background Celery workers"),
            ("embedding", "Embedding Microservice", "Vector embedding & semantic indexing service"),
            ("deploy", "Infrastructure & Deployment", "Kubernetes kustomization manifests, Fleet GitOps configs, systemd services"),
        ):
            if (root / fixed_name).is_dir() and fixed_name not in seen_paths:
                seen_paths.add(fixed_name)
                subsystems.append({
                    "name": fixed_name,
                    "path": fixed_name,
                    "type": fixed_type,
                    "description": fixed_desc,
                })
        return subsystems

    skip_dirs = IGNORED_DIRS | {"backups", "uploads", "templates", "assets", "public", "static", "results", "output", "outputs", "artifacts"}
    for d in sorted(root.iterdir()):
        if d.is_dir() and d.name not in skip_dirs and not d.name.startswith("."):
            role, desc = _infer_dir_role_and_desc(d)
            subsystems.append({
                "name": d.name,
                "path": d.name,
                "type": role,
                "description": desc,
            })
            if (d / "src-tauri").is_dir():
                t_role, t_desc = _infer_dir_role_and_desc(d / "src-tauri")
                subsystems.append({
                    "name": f"{d.name}/src-tauri",
                    "path": f"{d.name}/src-tauri",
                    "type": t_role,
                    "description": t_desc,
                })

    for f in sorted(root.iterdir()):
        if f.is_file() and f.suffix in (".py", ".ts", ".js") and not f.name.startswith(("_", "test_")) and f.name not in ("setup.py", "conftest.py") and not f.name.endswith((".config.js", ".config.ts")):
            txt = _read_code(f, 3_000)
            doc = ""
            ide_tags = (
                "@time", "@author", "@file", "@software", "@project", "@date", "@version",
                "@contact", "@license", "copyright", "coding:", "-*-", "do have a faith", "all rights reserved",
            )
            dm = re.match(r'^(?:#![^\n]*\n)?\s*(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')', txt)
            if dm and dm.group(1).strip():
                raw_block = dm.group(1).strip()
                is_ide_header = any(t in raw_block.lower() for t in ("@time", "@author", "@file", "@software"))
                for dline in raw_block.splitlines():
                    sd = dline.strip().lstrip("*#- ")
                    if not sd or sd.lower().startswith(ide_tags):
                        continue
                    if sd.lower().startswith(("@description", "@desc")):
                        sd = re.sub(r"^@[a-zA-Z]+\s*[:：]?\s*", "", sd).strip()
                        if len(sd) > 4:
                            doc = sd
                        break
                    if not is_ide_header and len(sd) > 4:
                        doc = sd
                        break
            if not doc:
                has_ide_comments = any(t in txt[:600].lower() for t in ("@time", "@author", "@file", "@software"))
                for cline in txt.splitlines()[:12]:
                    scline = cline.strip()
                    if scline.startswith("#!") or any(tag in scline.lower() for tag in ide_tags):
                        continue
                    if scline.startswith(("#", "//")):
                        cand = scline.lstrip("#/ ").strip()
                        if cand.lower().startswith(("@description", "@desc")):
                            cand = re.sub(r"^@[a-zA-Z]+\s*[:：]?\s*", "", cand).strip()
                            if len(cand) > 4:
                                doc = cand
                            break
                        if not has_ide_comments and len(cand) > 4 and not cand.lower().startswith(ide_tags):
                            doc = cand
                            break
            role = "Backend / Web Entrypoint" if f.stem in ("server", "app", "main", "api") else "Core Engine Module"
            subsystems.append({
                "name": f.name,
                "path": f.name,
                "type": role,
                "description": doc[:110] if doc else f"Root-level {role.lower()} ({f.name})",
            })

    # Fallback for data/playlist/configuration repositories with no subdirectories or code scripts
    if not subsystems:
        for f in sorted(root.iterdir()):
            if f.is_file() and not f.name.startswith(".") and f.name not in ("PROJECT_BLUEPRINT.md", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"):
                role = "Documentation" if f.name.lower().startswith("readme") else "Data / Config Asset"
                subsystems.append({
                    "name": f.name,
                    "path": f.name,
                    "type": role,
                    "description": f"Repository {role.lower()} ({f.name})",
                })

    support_names = {"docs", "doc", "scripts", "script", "tests", "test", "docker", "deploy", "k8s", "ci-scripts", "ci"}
    support_types = {
        "Architecture & Docs",
        "Automation & CLI Scripts",
        "Test Suites",
        "Container Infrastructure",
        "Infrastructure & Deployment",
        "CI/CD & Build Scripts",
        "Documentation",
        "Data / Config Asset",
    }

    def _sub_priority(s: dict[str, Any]) -> tuple[int, str]:
        sname = str(s.get("name", "")).lower()
        stype = str(s.get("type", ""))
        sdesc = str(s.get("description", ""))
        if sname in support_names or stype in support_types:
            return (2, sname)
        if (
            sname in {"research", "notebooks", "examples", "benchmarks"}
            or "Research" in stype
            or sdesc.startswith("Root-level ")
        ):
            return (1, sname)
        return (0, sname)

    subsystems.sort(key=_sub_priority)
    return subsystems


def scan_frontend_routes(root: Path) -> list[str]:
    """Scan web page routes across Next.js (App & Pages Router), Nuxt/Vue Router, React Router, SvelteKit, and Remix."""
    routes: list[str] = []
    # 1. Next.js App Router
    candidates = [
        root / "apps" / "web" / "src" / "app",
        root / "web" / "src" / "app",
        root / "src" / "app",
        root / "app",
    ]
    app_dir = next((c for c in candidates if c.is_dir()), None)
    if app_dir:
        for page_file in sorted(app_dir.glob("**/page.[tj]s*")):
            rel = page_file.parent.relative_to(app_dir)
            route_path = "/" if str(rel) == "." else f"/{rel}"
            route_path = re.sub(r'/\([^)]+\)', '', route_path) or "/"
            routes.append(route_path)

    # 2. Next.js Pages Router / Nuxt Pages (`pages/**/*.{tsx,vue}`)
    for pages_cand in (root / "apps" / "web" / "src" / "pages", root / "src" / "pages", root / "pages"):
        if pages_cand.is_dir():
            for pf in sorted(pages_cand.glob("**/*.[tvj]s*")) + sorted(pages_cand.glob("**/*.vue")):
                if pf.stem.startswith("_") or pf.parent.name == "api":
                    continue
                rel = pf.relative_to(pages_cand).with_suffix("")
                rpath = "/" + str(rel).replace("/index", "").lstrip("/")
                routes.append(rpath or "/")

    # 3. Vue Router / React Router explicit path declarations
    if not routes:
        for rf in _iter_repo_files(root, "**/*router*.[tj]s*", limit=15) + _iter_repo_files(root, "**/*routes*.[tj]s*", limit=15):
            try:
                content = rf.read_text(encoding="utf-8", errors="ignore")
                for pm in re.finditer(r'\bpath\s*:\s*["\'](/[^"\']*)["\']', content):
                    routes.append(pm.group(1))
            except Exception:
                pass

    return sorted(list(dict.fromkeys(routes)))


def scan_api_routes(root: Path) -> list[dict[str, Any]]:
    """Scan backend HTTP routers across Python (FastAPI/Flask/Django), Next.js, Node (Express/NestJS/Hono), Go (Gin/Echo/Chi), Rust (Axum/Actix), and Java/Kotlin (Spring Boot)."""
    routes: list[dict[str, Any]] = []
    seen_files: set[Path] = set()

    # 0. Collect include_router(xxx_router, prefix="/...") mount prefixes from aggregator files
    mounted_prefixes: dict[str, str] = {}
    for init_cand in _iter_repo_files(root, "**/api/**/*.py", limit=40) + _iter_repo_files(root, "**/routers/**/*.py", limit=40):
        try:
            init_txt = _read_code(init_cand, 30_000)
            if "include_router(" not in init_txt:
                continue
            var_to_mod: dict[str, str] = {}
            for im in re.finditer(r'from\s+\.?([a-zA-Z0-9_.]+)\s+import\s+router\s+as\s+([a-zA-Z0-9_]+)', init_txt):
                var_to_mod[im.group(2)] = im.group(1).split(".")[-1]
            for im2 in re.finditer(r'from\s+\.?([a-zA-Z0-9_.]+)\s+import\s+([a-zA-Z0-9_]+)', init_txt):
                if im2.group(2) not in var_to_mod:
                    var_to_mod[im2.group(2)] = im2.group(1).split(".")[-1]
            for inc in re.finditer(r'include_router\(\s*([a-zA-Z0-9_.]+)\s*[^)]*?prefix\s*=\s*["\']([^"\']+)["\']', init_txt):
                rvar, pfx = inc.group(1), inc.group(2)
                mod_name = rvar.split(".")[0] if "." in rvar else var_to_mod.get(rvar, rvar.replace("_router", ""))
                if mod_name and pfx:
                    mounted_prefixes[mod_name] = pfx
        except Exception:
            pass

    # 1. Python FastAPI / Flask / Django Ninja
    py_api_files: list[Path] = []
    for root_py in ("server.py", "app.py", "main.py", "api.py"):
        rp = root / root_py
        if rp.is_file():
            py_api_files.append(rp)
    for d in (root / "server" / "server" / "api", root / "api", root / "app" / "api", root / "src" / "api", root / "backend" / "app" / "api"):
        if d.is_dir():
            py_api_files.extend(sorted(d.glob("*.py")))
    for pf in (
        _iter_repo_files(root, "**/api/**/*.py", limit=40)
        + _iter_repo_files(root, "**/routers/**/*.py", limit=40)
        + _iter_repo_files(root, "**/*route*.py", limit=30)
        + _iter_repo_files(root, "**/views*.py", limit=25)
    ):
        if pf not in py_api_files:
            py_api_files.append(pf)

    for py_file in py_api_files:
        if py_file.name.startswith("_") or py_file in seen_files:
            continue
        seen_files.add(py_file)
        name = py_file.stem
        try:
            content = _read_code(py_file)
            if not re.search(r'@(?:router|app|bp|api)\.(get|post|put|delete|patch|route|websocket)\b', content) and "APIRouter" not in content:
                continue
            m = re.search(r'(?:router|bp)\s*=\s*(?:APIRouter|Blueprint)\([^)]*(?:prefix|url_prefix)=["\']([^"\']+)["\']', content)
            explicit_prefix = m.group(1) if m else mounted_prefixes.get(name, "")
            display_prefix = explicit_prefix or ("/" if name in ("server", "app", "main") else f"/{name}")

            endpoints: list[str] = []
            for em in re.finditer(r'@(?:router|app|bp|api)\.(get|post|put|delete|patch|route|websocket)\(\s*["\']([^"\']*)["\']', content):
                raw_m = em.group(1).upper()
                method = "WS" if raw_m == "WEBSOCKET" else raw_m
                subpath = em.group(2)
                if explicit_prefix:
                    if subpath == explicit_prefix or subpath.startswith(explicit_prefix.rstrip("/") + "/"):
                        full_p = subpath
                    else:
                        full_p = f"{explicit_prefix.rstrip('/')}/{subpath.lstrip('/')}".rstrip('/') or "/"
                else:
                    if subpath.startswith("/") and len(subpath) > 1:
                        if name not in ("server", "app", "main") and not subpath.startswith(f"/{name}"):
                            full_p = f"{display_prefix.rstrip('/')}/{subpath.lstrip('/')}".rstrip('/') or "/"
                        else:
                            full_p = subpath.rstrip("/")
                    else:
                        full_p = f"{display_prefix.rstrip('/')}/{subpath.lstrip('/')}".rstrip('/') or "/"
                endpoints.append(f"`{method} {full_p}`")

            if endpoints:
                routes.append({
                    "name": name,
                    "file": py_file.name,
                    "prefix": display_prefix,
                    "endpoints": endpoints[:5],
                    "total": len(endpoints),
                })
        except Exception:
            pass

    # 2. Next.js App Router API Route Handlers (app/api/**/route.ts)
    for app_cand in (root / "apps" / "web" / "src" / "app" / "api", root / "src" / "app" / "api", root / "app" / "api"):
        if app_cand.is_dir():
            for route_file in sorted(app_cand.glob("**/route.[tj]s*")):
                try:
                    rel = route_file.parent.relative_to(app_cand.parent)
                    prefix = f"/{rel}"
                    content = _read_code(route_file)
                    methods = re.findall(r'export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\b', content)
                    endpoints = [f"`{m} {prefix}`" for m in dict.fromkeys(methods)]
                    routes.append({
                        "name": route_file.parent.name,
                        "file": route_file.name,
                        "prefix": prefix,
                        "endpoints": endpoints[:5],
                        "total": len(endpoints),
                    })
                except Exception:
                    pass

    # 3. Node/TS Express, Fastify, Hono & NestJS Controllers
    for ts_file in dict.fromkeys(
        _iter_repo_files(root, "**/*.controller.ts", limit=30)
        + _iter_repo_files(root, "**/routes/**/*.[tj]s", limit=30)
        + _iter_repo_files(root, "server/src/**/*.[tj]s", limit=20)
    ):
        try:
            content = _read_code(ts_file)
            endpoints: list[str] = []
            ctrl_m = re.search(r'@Controller\(\s*["\']?([^"\')\s]*)["\']?\s*\)', content)
            prefix = "/" + ctrl_m.group(1).strip("/") if ctrl_m and ctrl_m.group(1) else f"/{ts_file.stem.replace('.controller', '')}"
            for nm in re.finditer(r'@(Get|Post|Put|Delete|Patch)\(\s*["\']?([^"\')\s]*)["\']?\s*\)', content):
                full_p = f"{prefix.rstrip('/')}/{nm.group(2).lstrip('/')}".rstrip("/") or "/"
                endpoints.append(f"`{nm.group(1).upper()} {full_p}`")
            for exm in re.finditer(r'\b(?:app|router|server)\.(get|post|put|delete|patch)\(\s*["\']([^"\']+)["\']', content):
                endpoints.append(f"`{exm.group(1).upper()} {exm.group(2)}`")
            if endpoints:
                routes.append({
                    "name": ts_file.stem,
                    "file": ts_file.name,
                    "prefix": prefix,
                    "endpoints": endpoints[:5],
                    "total": len(endpoints),
                })
        except Exception:
            pass

    # 4. Go (Gin / Echo / Chi / Fiber / net/http)
    for go_file in _iter_repo_files(root, "**/*.go", limit=40):
        if go_file.name.endswith("_test.go"):
            continue
        try:
            content = _read_code(go_file)
            endpoints = []
            for gm in re.finditer(r'\.\s*(GET|POST|PUT|DELETE|PATCH|HandleFunc)\(\s*"([^"]+)"', content):
                m_str = "ANY" if gm.group(1) == "HandleFunc" else gm.group(1)
                endpoints.append(f"`{m_str} {gm.group(2)}`")
            if endpoints:
                routes.append({
                    "name": go_file.stem,
                    "file": go_file.name,
                    "prefix": f"/{go_file.stem}",
                    "endpoints": endpoints[:5],
                    "total": len(endpoints),
                })
        except Exception:
            pass

    # 5. Java / Kotlin Spring Boot (@RestController) & Rust (Axum / Actix / Tauri) & Electron IPC
    for jk_file in _iter_repo_files(root, "**/*Controller.java", limit=25) + _iter_repo_files(root, "**/*Controller.kt", limit=25):
        try:
            content = _read_code(jk_file)
            req_m = re.search(r'@RequestMapping\(\s*(?:value\s*=\s*)?["\']([^"\']+)["\']', content)
            prefix = req_m.group(1) if req_m else f"/{jk_file.stem.replace('Controller', '').lower()}"
            endpoints = []
            for sm in re.finditer(r'@(Get|Post|Put|Delete|Patch)Mapping(?:\(\s*(?:value\s*=\s*)?["\']([^"\']*)["\'])?', content):
                sub = sm.group(2) or ""
                full_p = f"{prefix.rstrip('/')}/{sub.lstrip('/')}".rstrip("/") or "/"
                endpoints.append(f"`{sm.group(1).upper()} {full_p}`")
            if endpoints:
                routes.append({
                    "name": jk_file.stem,
                    "file": jk_file.name,
                    "prefix": prefix,
                    "endpoints": endpoints[:5],
                    "total": len(endpoints),
                })
        except Exception:
            pass

    for rs_file in _iter_repo_files(root, "**/*.rs", limit=30):
        try:
            content = _read_code(rs_file)
            endpoints = []
            for tm in re.finditer(r'#\[tauri::command[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)', content):
                endpoints.append(f"`IPC tauri:{tm.group(1)}`")
            for am in re.finditer(r'#\[(get|post|put|delete|patch)\(\s*"([^"]+)"', content):
                endpoints.append(f"`{am.group(1).upper()} {am.group(2)}`")
            if endpoints:
                routes.append({
                    "name": rs_file.stem,
                    "file": rs_file.name,
                    "prefix": f"ipc://{rs_file.stem}",
                    "endpoints": endpoints[:5],
                    "total": len(endpoints),
                })
        except Exception:
            pass

    for el_file in _iter_repo_files(root, "**/main.ts", limit=15) + _iter_repo_files(root, "**/ipc*.ts", limit=15):
        try:
            content = _read_code(el_file)
            if "ipcMain.handle" not in content:
                continue
            endpoints = [
                f"`IPC {im.group(1)}`"
                for im in re.finditer(r'ipcMain\.handle\(\s*["\']([^"\']+)["\']', content)
            ]
            if endpoints:
                routes.append({
                    "name": el_file.stem,
                    "file": el_file.name,
                    "prefix": "ipc://electron",
                    "endpoints": endpoints[:5],
                    "total": len(endpoints),
                })
        except Exception:
            pass

    return routes


def scan_data_models(root: Path) -> dict[str, Any]:
    """Scan multi-language ORM / schema models and foreign key relations:
    - Python: SQLAlchemy (ForeignKey), Django (models.ForeignKey / OneToOneField / ManyToManyField), SQLModel
    - Prisma: schema.prisma (model + @relation)
    - TypeScript / JS: Drizzle ORM (pgTable/mysqlTable/sqliteTable + .references), TypeORM (@Entity + @ManyToOne/@JoinColumn)
    - Go: GORM / db structs (gorm:"foreignKey:...")
    - Rust: SeaORM (DeriveEntityModel + #[sea_orm(belongs_to = ...)]) / Diesel (#[diesel(belongs_to(...))])
    - Java / Kotlin: JPA / Hibernate (@Entity + @ManyToOne / @JoinColumn)
    - SQL DDL: CREATE TABLE + FOREIGN KEY / REFERENCES
    """
    models: list[str] = []
    relations: list[str] = []
    unique_constraints: list[str] = []

    def _add_model(name: str) -> None:
        if name and name not in models:
            models.append(name)

    def _add_rel(rel: str) -> None:
        if rel and rel not in relations:
            relations.append(rel)

    def _add_unique(uq: str) -> None:
        if uq and uq not in unique_constraints:
            unique_constraints.append(uq)

    def _iter_project_files(pattern: str, limit: int = 80) -> list[Path]:
        return _iter_repo_files(root, pattern, limit=limit)

    # 1. Python (SQLAlchemy / Django / SQLModel / Pydantic)
    py_candidates: list[Path] = []
    default_py = root / "server" / "server" / "db" / "models.py"
    if default_py.exists():
        py_candidates.append(default_py)
    for cand in _iter_project_files("**/models.py", limit=30) + _iter_project_files("**/models/*.py", limit=30):
        if cand not in py_candidates and not cand.name.startswith("_"):
            py_candidates.append(cand)

    for models_file in py_candidates:
        try:
            content = models_file.read_text(encoding="utf-8", errors="ignore")
            current_class = None
            for line in content.splitlines():
                cm = re.match(r'^class\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*:', line)
                if cm:
                    cname, bases = cm.group(1), cm.group(2)
                    if any(b in bases for b in ("Base", "Model", "BaseModel", "SQLModel", "Table", "Document")):
                        _add_model(cname)
                        current_class = cname
                    else:
                        current_class = None
                    continue
                if current_class:
                    # SQLAlchemy / SQLModel ForeignKey("table.col")
                    if "ForeignKey(" in line:
                        fkm = re.search(r'([a-zA-Z0-9_]+)\s*[:=][^;]*ForeignKey\(\s*["\']([^"\']+)["\']', line)
                        if fkm:
                            _add_rel(f"`{current_class}.{fkm.group(1)}` ➔ `{fkm.group(2)}`")
                    if "UniqueConstraint(" in line:
                        uqm = re.search(r'UniqueConstraint\(([^)]+)\)', line)
                        if uqm:
                            cols = [c.strip().strip("\"'") for c in uqm.group(1).split(",") if "name=" not in c and c.strip()]
                            if cols:
                                _add_unique(f"`{current_class}`: unique({', '.join(cols)})")
                    elif "unique=True" in line:
                        ufm = re.search(r'^\s*([a-zA-Z0-9_]+)\s*[:=]', line)
                        if ufm:
                            _add_unique(f"`{current_class}.{ufm.group(1)}` (unique)")
                    # Django models.ForeignKey / OneToOneField / ManyToManyField("Target" or Target)
                    dj = re.search(
                        r'([a-zA-Z0-9_]+)\s*=\s*(?:models\.)?(?:ForeignKey|OneToOneField|ManyToManyField)\(\s*["\']?([A-Za-z0-9_.]+)["\']?',
                        line,
                    )
                    if dj and dj.group(2) not in ("self", "settings"):
                        _add_rel(f"`{current_class}.{dj.group(1)}` ➔ `{dj.group(2)}`")
        except Exception:
            pass

    # 2. Prisma (schema.prisma)
    for prisma_file in _iter_project_files("**/*.prisma", limit=20):
        try:
            content = prisma_file.read_text(encoding="utf-8", errors="ignore")
            current_model = None
            for line in content.splitlines():
                mm = re.match(r'^\s*model\s+([A-Za-z0-9_]+)\s*\{', line)
                if mm:
                    current_model = mm.group(1)
                    _add_model(current_model)
                    continue
                if current_model and re.match(r'^\s*\}', line):
                    current_model = None
                    continue
                if current_model and "@relation" in line:
                    rm = re.search(
                        r'^\s*([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)\??\s+.*@relation\([^)]*fields:\s*\[([^\]]+)\][^)]*references:\s*\[([^\]]+)\]',
                        line,
                    )
                    if rm:
                        target_model = rm.group(2)
                        fk_field = rm.group(3).strip()
                        ref_field = rm.group(4).strip()
                        _add_rel(f"`{current_model}.{fk_field}` ➔ `{target_model}.{ref_field}`")
        except Exception:
            pass

    # 3. TypeScript / JS (Drizzle ORM & TypeORM)
    ts_schema_files = (
        _iter_project_files("**/schema.ts", limit=30)
        + _iter_project_files("**/schema/*.ts", limit=30)
        + _iter_project_files("**/entities/*.ts", limit=30)
        + _iter_project_files("**/*.entity.ts", limit=30)
    )
    for ts_file in dict.fromkeys(ts_schema_files):
        try:
            content = ts_file.read_text(encoding="utf-8", errors="ignore")
            # Drizzle ORM: export const users = pgTable("users", { ... })
            for dm in re.finditer(r'(?:pgTable|mysqlTable|sqliteTable)\(\s*["\']([a-zA-Z0-9_]+)["\']\s*,\s*\{([\s\S]*?)\}\s*[,)]', content):
                tname = dm.group(1)
                tbody = dm.group(2)
                _add_model(tname)
                for rfm in re.finditer(r'([a-zA-Z0-9_]+)\s*:[^\n,]*?\.references\(\s*\(\)\s*=>\s*([a-zA-Z0-9_.]+)', tbody):
                    _add_rel(f"`{tname}.{rfm.group(1)}` ➔ `{rfm.group(2)}`")
            # TypeORM: @Entity() export class User
            if "@Entity" in content:
                current_entity = None
                pending_target = None
                for line in content.splitlines():
                    em = re.search(r'class\s+([A-Za-z0-9_]+)', line)
                    if em:
                        current_entity = em.group(1)
                        _add_model(current_entity)
                        continue
                    rel_dec = re.search(r'@(?:ManyToOne|OneToOne|ManyToMany)\(\s*\(\)\s*=>\s*([A-Za-z0-9_]+)', line)
                    if rel_dec:
                        pending_target = rel_dec.group(1)
                        continue
                    if current_entity and pending_target:
                        prop = re.match(r'^\s*([a-zA-Z0-9_]+)\??\s*:', line)
                        if prop and not line.strip().startswith("@"):
                            _add_rel(f"`{current_entity}.{prop.group(1)}` ➔ `{pending_target}`")
                            pending_target = None
        except Exception:
            pass

    # 4. Go (GORM structs)
    for go_file in _iter_project_files("**/*.go", limit=40):
        if go_file.name.endswith("_test.go"):
            continue
        try:
            content = go_file.read_text(encoding="utf-8", errors="ignore")
            if "gorm:" not in content and "db:" not in content:
                continue
            for sm in re.finditer(r'type\s+([A-Za-z0-9_]+)\s+struct\s*\{([\s\S]*?)\}', content):
                sname, sbody = sm.group(1), sm.group(2)
                if "gorm:" not in sbody and "db:" not in sbody:
                    continue
                _add_model(sname)
                for line in sbody.splitlines():
                    fkm = re.search(r'^\s*([A-Za-z0-9_]+)\s+\*?([A-Za-z0-9_]+)\s+`[^`]*gorm:"[^"]*foreignKey:([A-Za-z0-9_]+)', line)
                    if fkm:
                        _add_rel(f"`{sname}.{fkm.group(3)}` ➔ `{fkm.group(2)}`")
                    elif re.search(r'^\s*([A-Za-z0-9_]+)ID\s+(?:uint|int|string|uuid\.UUID)\b', line):
                        idm = re.search(r'^\s*([A-Za-z0-9_]+)ID\s+', line)
                        if idm and idm.group(1) != sname:
                            _add_rel(f"`{sname}.{idm.group(1)}ID` ➔ `{idm.group(1)}.ID`")
        except Exception:
            pass

    # 5. Rust (SeaORM / Diesel)
    for rs_file in _iter_project_files("**/*.rs", limit=40):
        try:
            content = rs_file.read_text(encoding="utf-8", errors="ignore")
            if "sea_orm" in content:
                tm = re.search(r'#\[sea_orm\(\s*table_name\s*=\s*"([^"]+)"', content)
                tname = tm.group(1) if tm else rs_file.stem
                _add_model(tname)
                for bm in re.finditer(
                    r'#\[sea_orm\([^\]]*belongs_to\s*=\s*"([^"]+)"[^\]]*from\s*=\s*"([^"]+)"[^\]]*to\s*=\s*"([^"]+)"',
                    content,
                ):
                    target = bm.group(1).split("::")[-2] if "::" in bm.group(1) else bm.group(1)
                    from_col = bm.group(2).split("::")[-1]
                    to_col = bm.group(3).split("::")[-1]
                    _add_rel(f"`{tname}.{from_col}` ➔ `{target}.{to_col}`")
            if "#[diesel(" in content:
                for dm in re.finditer(r'#\[diesel\(table_name\s*=\s*([a-zA-Z0-9_]+)\)\]', content):
                    tname = dm.group(1)
                    _add_model(tname)
                    for bm in re.finditer(r'#\[diesel\(belongs_to\(([A-Za-z0-9_]+)\)\)\]', content):
                        _add_rel(f"`{tname}` ➔ `{bm.group(1)}`")
        except Exception:
            pass

    # 6. Java / Kotlin (JPA / Hibernate @Entity)
    for jvm_file in _iter_project_files("**/*.java", limit=30) + _iter_project_files("**/*.kt", limit=30):
        try:
            content = jvm_file.read_text(encoding="utf-8", errors="ignore")
            if "@Entity" not in content and "@Table" not in content:
                continue
            cm = re.search(r'\bclass\s+([A-Za-z0-9_]+)', content)
            if not cm:
                continue
            cname = cm.group(1)
            _add_model(cname)
            pending_rel = False
            for line in content.splitlines():
                if re.search(r'@(?:ManyToOne|OneToOne|ManyToMany|JoinColumn)\b', line):
                    pending_rel = True
                    continue
                if pending_rel and not line.strip().startswith("@"):
                    # Java: private User user; or Kotlin: val user: User
                    jm = re.search(r'(?:private|protected|public)\s+([A-Za-z0-9_]+)\s+([a-zA-Z0-9_]+)\s*[;=]', line)
                    km = re.search(r'(?:val|var)\s+([a-zA-Z0-9_]+)\s*:\s*([A-Za-z0-9_]+)', line)
                    if jm:
                        _add_rel(f"`{cname}.{jm.group(2)}` ➔ `{jm.group(1)}`")
                        pending_rel = False
                    elif km:
                        _add_rel(f"`{cname}.{km.group(1)}` ➔ `{km.group(2)}`")
                        pending_rel = False
        except Exception:
            pass

    # 7. SQL DDL / Migrations (*.sql)
    for sql_file in _iter_project_files("**/*.sql", limit=30):
        try:
            content = sql_file.read_text(encoding="utf-8", errors="ignore")
            for ctm in re.finditer(
                r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([a-zA-Z0-9_.]+)["`]?\s*\(([\s\S]*?)\);',
                content,
                re.IGNORECASE,
            ):
                tname, tbody = ctm.group(1), ctm.group(2)
                _add_model(tname)
                for fkm in re.finditer(
                    r'FOREIGN\s+KEY\s*\(\s*["`]?([a-zA-Z0-9_]+)["`]?\s*\)\s*REFERENCES\s+["`]?([a-zA-Z0-9_.]+)["`]?\s*\(\s*["`]?([a-zA-Z0-9_]+)["`]?\s*\)',
                    tbody,
                    re.IGNORECASE,
                ):
                    _add_rel(f"`{tname}.{fkm.group(1)}` ➔ `{fkm.group(2)}.{fkm.group(3)}`")
                for inm in re.finditer(
                    r'^\s*["`]?([a-zA-Z0-9_]+)["`]?\s+[A-Za-z0-9_()]+[^,\n]*?\bREFERENCES\s+["`]?([a-zA-Z0-9_.]+)["`]?\s*\(\s*["`]?([a-zA-Z0-9_]+)["`]?\s*\)',
                    tbody,
                    re.IGNORECASE | re.MULTILINE,
                ):
                    if inm.group(1).upper() != "FOREIGN":
                        _add_rel(f"`{tname}.{inm.group(1)}` ➔ `{inm.group(2)}.{inm.group(3)}`")
        except Exception:
            pass

    return {
        "models": models,
        "relations": relations[:25],
        "unique_constraints": unique_constraints[:20],
    }


def generate_er_diagram(relations: list[str]) -> str:
    """Build a compact Mermaid erDiagram from extracted foreign-key relations."""
    if not relations:
        return ""
    edges: list[str] = []
    seen_edges: set[str] = set()
    for rel in relations[:18]:
        m = re.match(r'`([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)`\s*➔\s*`([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?`', rel)
        if not m:
            continue
        src_entity, src_field, dst_raw, _ = m.group(1), m.group(2), m.group(3), m.group(4)
        src_node = re.sub(r'[^A-Za-z0-9_]', '_', src_entity).upper()
        dst_node = re.sub(r'[^A-Za-z0-9_]', '_', dst_raw).upper()
        if dst_node.endswith("IES") and not src_node.endswith("IES"):
            dst_node = dst_node[:-3] + "Y"
        elif dst_node.endswith("ES") and any(dst_node.endswith(s) for s in ("SES", "XES", "ZES", "CHES", "SHES")):
            dst_node = dst_node[:-2]
        elif dst_node.endswith("S") and not dst_node.endswith("SS") and len(dst_node) > 3:
            dst_node = dst_node[:-1]
        if src_node.endswith("S") and not src_node.endswith("SS") and len(src_node) > 3 and src_entity.islower():
            src_node = src_node[:-1]
        edge_key = f"{dst_node}->{src_node}:{src_field}"
        if edge_key not in seen_edges:
            seen_edges.add(edge_key)
            edges.append(f'    {dst_node} ||--o{{ {src_node} : "{src_field}"')
    if not edges:
        return ""
    return "\n".join(["```mermaid", "erDiagram", *edges, "```"])


def scan_services_and_schedules(root: Path) -> dict[str, Any]:
    """Universally scan core domain service modules and background/scheduled tasks (Celery, APScheduler, node-cron, NestJS @Cron, Go cron, K8s CronJob)."""
    services: list[dict[str, str]] = []
    schedules: list[dict[str, str]] = []

    # 1. Core service / domain modules across any directory layout
    svc_files: list[Path] = []
    for sdir in (root / "server" / "server" / "services", root / "src" / "services", root / "services", root / "app" / "services"):
        if sdir.is_dir():
            svc_files.extend(sorted(sdir.glob("*.py")) + sorted(sdir.glob("*.ts")) + sorted(sdir.glob("*.go")))
    for cand in _iter_repo_files(root, "**/services/*.[ptg]*", limit=40) + _iter_repo_files(root, "**/*service*.[ptg]*", limit=30):
        if cand not in svc_files:
            svc_files.append(cand)

    seen_svc: set[Path] = set()
    for f in svc_files:
        if f in seen_svc or f.name.startswith("_") or ".test." in f.name or ".spec." in f.name or f.name.endswith("_test.go"):
            continue
        seen_svc.add(f)
        try:
            text = _read_code(f, max_chars=4000)
            doc = ""
            dm = re.match(r'^\s*(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')', text)
            if dm:
                doc = dm.group(1).strip().splitlines()[0].strip()
            else:
                cm = re.match(r'^\s*(?://+|#+|/\*\*?)\s*([^\n*]+)', text)
                if cm:
                    doc = cm.group(1).strip()
            services.append({
                "name": f.stem,
                "path": str(f.relative_to(root)),
                "summary": _sanitize_blueprint_text(doc[:110]) if doc else "Core domain service module",
            })
        except Exception:
            pass

    # 2. Scheduled background jobs across Python (Celery / APScheduler), TS (node-cron / @Cron), Go (cron)
    for py_f in _iter_repo_files(root, "**/*.py", limit=60):
        try:
            content = _read_code(py_f)
            if "beat_schedule" in content:
                for bm in re.finditer(
                    r'"([a-zA-Z0-9_-]+)"\s*:\s*\{\s*"task"\s*:\s*"([^"]+)"\s*,\s*"schedule"\s*:\s*([^\n]+)',
                    content,
                ):
                    schedules.append({
                        "name": bm.group(1),
                        "task": bm.group(2),
                        "schedule": bm.group(3).rstrip(",").strip(),
                    })
            if "add_job(" in content or "scheduled_job(" in content:
                for aj in re.finditer(r'(?:add_job|scheduled_job)\(\s*([a-zA-Z0-9_.]+)\s*,\s*["\']([^"\']+)["\']', content):
                    schedules.append({
                        "name": aj.group(1),
                        "task": f"{py_f.stem}.{aj.group(1)}",
                        "schedule": aj.group(2),
                    })
        except Exception:
            pass

    for ts_f in _iter_repo_files(root, "**/*.[tj]s", limit=50):
        try:
            content = _read_code(ts_f)
            if "cron.schedule" in content:
                for cm in re.finditer(r'cron\.schedule\(\s*["\']([^"\']+)["\']', content):
                    schedules.append({
                        "name": ts_f.stem,
                        "task": str(ts_f.relative_to(root)),
                        "schedule": f"cron({cm.group(1)})",
                    })
            if "@Cron" in content:
                for nm in re.finditer(r'@Cron\(\s*["\']([^"\']+)["\']\s*\)[\s\S]{1,120}?\b([a-zA-Z0-9_]+)\s*\(', content):
                    schedules.append({
                        "name": nm.group(2),
                        "task": f"{ts_f.stem}.{nm.group(2)}",
                        "schedule": f"@Cron({nm.group(1)})",
                    })
        except Exception:
            pass

    return {
        "services": services[:35],
        "schedules": schedules[:25],
    }


def scan_mcp_and_ws_protocols(root: Path) -> dict[str, Any]:
    """Universally scan MCP tools (TS & Python FastMCP), WebSocket events, gRPC Protobuf services, and GraphQL operations."""
    mcp_tools: list[dict[str, str]] = []
    ws_events: list[str] = []
    rpc_contracts: list[str] = []

    for mf in _iter_repo_files(root, "**/*.[tp][sy]", limit=60):
        try:
            content = _read_code(mf)
            if "registerTool" in content or "@mcp.tool" in content:
                for tm in re.finditer(
                    r'registerTool\(\s*["\']([a-zA-Z0-9_-]+)["\']\s*,\s*\{[\s\S]*?description:\s*\n?\s*["\']([^"\']+)["\']',
                    content,
                ):
                    mcp_tools.append({
                        "name": tm.group(1),
                        "description": tm.group(2).strip()[:100],
                    })
                for pm in re.finditer(r'@mcp\.tool\([^)]*\)\s*(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*(?:->[^:]+)?:\s*(?:"""([^"]+)""")?', content):
                    mcp_tools.append({
                        "name": pm.group(1),
                        "description": (pm.group(2) or "Python MCP tool").strip().splitlines()[0][:100],
                    })
            if "WebSocket" in content or "ws" in mf.stem.lower() or "socket.on(" in content or "@sio.on(" in content:
                for cm in re.finditer(r'(?:case|socket\.on\(|@sio\.on\()\s*["\']([a-zA-Z0-9_:-]+)["\']', content):
                    ev = cm.group(1)
                    if ev not in ws_events and len(ev) > 2:
                        ws_events.append(ev)
                for pm in re.finditer(r'msg_type\s*==\s*["\']([a-zA-Z0-9_:-]+)["\']', content):
                    ev = pm.group(1)
                    if ev not in ws_events:
                        ws_events.append(ev)
        except Exception:
            pass

    # gRPC .proto & GraphQL .graphql/.gql contracts
    for pf in _iter_repo_files(root, "**/*.proto", limit=20):
        try:
            content = pf.read_text(encoding="utf-8", errors="ignore")
            for sm in re.finditer(r'service\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}', content):
                sname = sm.group(1)
                for rm in re.finditer(r'rpc\s+([A-Za-z0-9_]+)\s*\(\s*(?:stream\s+)?([A-Za-z0-9_.]+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([A-Za-z0-9_.]+)\s*\)', sm.group(2)):
                    rpc_contracts.append(f"gRPC `{sname}.{rm.group(1)}({rm.group(2)}) ➔ {rm.group(3)}`")
        except Exception:
            pass

    for gf in _iter_repo_files(root, "**/*.graphql", limit=20) + _iter_repo_files(root, "**/*.gql", limit=20):
        try:
            content = gf.read_text(encoding="utf-8", errors="ignore")
            for tm in re.finditer(r'type\s+(Query|Mutation|Subscription)\s*\{([\s\S]*?)\}', content):
                kind = tm.group(1)
                for fm in re.finditer(r'^\s*([a-zA-Z0-9_]+)\s*(?:\([^)]*\))?\s*:\s*([A-Za-z0-9_\[\]!]+)', tm.group(2), re.MULTILINE):
                    rpc_contracts.append(f"GraphQL `{kind}.{fm.group(1)} ➔ {fm.group(2)}`")
        except Exception:
            pass

    return {
        "mcp_tools": mcp_tools[:25],
        "ws_events": ws_events[:25],
        "rpc_contracts": rpc_contracts[:20],
    }


def scan_cicd_and_deploy(root: Path) -> list[dict[str, str]]:
    """Scan GitHub Actions workflows and Kubernetes / Docker deployment manifests."""
    items: list[dict[str, str]] = []
    wf_dir = root / ".github" / "workflows"
    if wf_dir.is_dir():
        for wf in sorted(wf_dir.glob("*.y*ml")):
            try:
                content = _read_code(wf, 50_000)
                nm = re.search(r'^name:\s*(.+)$', content, re.MULTILINE)
                wname = nm.group(1).strip().strip("\"'") if nm else wf.stem
                jm = re.search(r'^jobs:\s*\n([\s\S]*)', content, re.MULTILINE)
                jobs = re.findall(r'^  ([a-zA-Z0-9_-]+):\s*(?:#.*)?$', jm.group(1), re.MULTILINE) if jm else []
                items.append({
                    "kind": "GitHub Actions",
                    "name": wname,
                    "path": str(wf.relative_to(root)),
                    "details": f"Jobs: {', '.join(jobs[:6])}" if jobs else "CI/CD pipeline",
                })
            except Exception:
                pass

    gitlab_ci = root / ".gitlab-ci.yml"
    if gitlab_ci.is_file():
        try:
            content = _read_code(gitlab_ci, 50_000)
            stages_m = re.search(r'^stages:\s*\n((?:\s*-\s*[^\n]+\n)+)', content, re.MULTILINE)
            stages = [s.strip().lstrip("-").strip() for s in stages_m.group(1).splitlines() if s.strip()] if stages_m else []
            items.append({
                "kind": "GitLab CI",
                "name": ".gitlab-ci.yml",
                "path": ".gitlab-ci.yml",
                "details": f"Stages: {', '.join(stages[:6])}" if stages else "GitLab CI/CD pipeline",
            })
        except Exception:
            pass

    for deploy_dir in (root / "deploy", root / "k8s"):
        if deploy_dir.is_dir():
            for ym in sorted(deploy_dir.glob("**/*.y*ml"))[:12]:
                try:
                    content = _read_code(ym, 30_000)
                    kinds = list(dict.fromkeys(re.findall(r'^kind:\s*([A-Za-z0-9]+)', content, re.MULTILINE)))
                    if kinds:
                        items.append({
                            "kind": "K8s / GitOps",
                            "name": ym.name,
                            "path": str(ym.relative_to(root)),
                            "details": f"Resources: {', '.join(kinds[:5])}",
                        })
                except Exception:
                    pass
    return items


def scan_hotspots_and_tests(root: Path) -> dict[str, Any]:
    """Identify high-frequency changed source files from git log and map test suites."""
    hotspots: list[dict[str, Any]] = []
    out = run_git_cmd(["log", "-n", "60", "--grep=\\[skip ci\\]", "--invert-grep", "--pretty=format:", "--name-only"], root)
    if out:
        counts: dict[str, int] = {}
        for line in out.splitlines():
            p = line.strip()
            if (
                not p
                or p in ("PROJECT_BLUEPRINT.md", "deploy/k8s/kustomization.yaml")
                or p.endswith((".lock", ".json", ".min.js", ".map", "pnpm-lock.yaml", "package-lock.json", "Cargo.lock", "uv.lock", "poetry.lock"))
            ):
                continue
            if any(part in IGNORED_DIRS for part in Path(p).parts):
                continue
            if not (root / p).is_file():
                continue
            counts[p] = counts.get(p, 0) + 1
        for path_str, cnt in sorted(counts.items(), key=lambda x: (-x[1], x[0]))[:10]:
            hotspots.append({"path": path_str, "commits": cnt})

    test_suites: list[dict[str, Any]] = []
    all_test_files = (
        _iter_repo_files(root, "**/test_*.py", limit=150)
        + _iter_repo_files(root, "**/*_test.py", limit=100)
        + _iter_repo_files(root, "**/*.test.[tj]s*", limit=150)
        + _iter_repo_files(root, "**/*.spec.[tj]s*", limit=100)
        + _iter_repo_files(root, "**/*_test.go", limit=100)
        + _iter_repo_files(root, "**/*Test.java", limit=100)
        + _iter_repo_files(root, "**/*Test.kt", limit=100)
    )
    grouped_tests: dict[str, list[str]] = {}
    for tf in dict.fromkeys(all_test_files):
        rel_dir = str(tf.parent.relative_to(root))
        grouped_tests.setdefault(rel_dir, []).append(tf.name)

    for rel_dir, tfiles in sorted(grouped_tests.items(), key=lambda x: (-len(x[1]), x[0]))[:10]:
        sfiles = sorted(set(tfiles))
        runner = "pytest" if any(n.endswith(".py") for n in sfiles) else (
            "go test" if any(n.endswith(".go") for n in sfiles) else (
                "JUnit" if any(n.endswith((".java", ".kt")) for n in sfiles) else "vitest / jest"
            )
        )
        test_suites.append({
            "suite": f"{rel_dir} ({runner})",
            "dir": rel_dir,
            "count": len(sfiles),
            "samples": ", ".join(f"`{n}`" for n in sfiles[:5]),
        })
    return {
        "hotspots": hotspots,
        "test_suites": test_suites,
    }


def scan_ast_call_graph_and_deps(root: Path) -> dict[str, list[str]]:
    """Build cross-module dependency and call graph using Python AST and TS/Go/Rust static import resolution."""
    pkg_edges: list[str] = []
    call_edges: list[str] = []

    # 1. Monorepo workspace package dependencies (package.json / Cargo.toml)
    workspace_pkgs: dict[str, str] = {}
    for pj in _iter_repo_files(root, "**/package.json", limit=40):
        if pj == root / "package.json":
            continue
        try:
            data = json.loads(pj.read_text(encoding="utf-8", errors="ignore"))
            pname = data.get("name")
            rel_dir = str(pj.parent.relative_to(root))
            if isinstance(pname, str) and pname:
                workspace_pkgs[pname] = rel_dir
        except Exception:
            pass

    for pj in _iter_repo_files(root, "**/package.json", limit=40):
        if pj == root / "package.json":
            continue
        try:
            data = json.loads(pj.read_text(encoding="utf-8", errors="ignore"))
            src_dir = str(pj.parent.relative_to(root))
            deps = {**(data.get("dependencies") or {}), **(data.get("devDependencies") or {})}
            for dep_name in deps:
                if dep_name in workspace_pkgs and workspace_pkgs[dep_name] != src_dir:
                    edge = f"`{src_dir}` ➔ `{workspace_pkgs[dep_name]}` (`{dep_name}`)"
                    if edge not in pkg_edges:
                        pkg_edges.append(edge)
        except Exception:
            pass

    # 2. Python AST cross-layer call & dependency graph (API / Tasks ➔ Services / DB)
    py_files = (
        _iter_repo_files(root, "**/api/*.py", limit=35)
        + _iter_repo_files(root, "**/tasks/*.py", limit=25)
        + _iter_repo_files(root, "**/routers/*.py", limit=25)
        + _iter_repo_files(root, "**/*.py", limit=40)
    )
    seen_py: set[Path] = set()
    for pf in py_files:
        if pf in seen_py or pf.name.startswith("_") or "test" in pf.parts:
            continue
        seen_py.add(pf)
        try:
            source = _read_code(pf)
            tree = ast.parse(source)
            src_label = f"{pf.parent.name}/{pf.stem}" if pf.parent != root else pf.stem
            imported_services: set[str] = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module:
                    mod = node.module
                    if "services" in mod or "db" in mod or "tasks" in mod:
                        parts = mod.split(".")
                        if parts[-1] in ("services", "db", "tasks", "models", "core"):
                            for alias in node.names:
                                target_mod = f"{parts[-1]}/{alias.name}"
                                edge = f"`{src_label}` ➔ `{target_mod}`"
                                if edge not in call_edges and src_label != target_mod:
                                    call_edges.append(edge)
                        else:
                            target_mod = "/".join(parts[-2:]) if len(parts) >= 2 else parts[-1]
                            for alias in node.names:
                                imported_services.add(f"{target_mod}.{alias.name}")
                            edge = f"`{src_label}` ➔ `{target_mod}`"
                            if edge not in call_edges and src_label != target_mod:
                                call_edges.append(edge)
        except Exception:
            pass

    # 3. TypeScript / Go internal module imports when Python edges are absent
    if len(call_edges) < 10:
        for tf in _iter_repo_files(root, "**/*.[tg][so]*", limit=45):
            if ".test." in tf.name or ".spec." in tf.name or tf.name.endswith("_test.go"):
                continue
            try:
                content = _read_code(tf)
                src_label = f"{tf.parent.name}/{tf.stem}"
                for im in re.finditer(r'from\s+["\'](?:\.\.?/|@/)([a-zA-Z0-9_/-]+)["\']', content):
                    target = im.group(1).rstrip("/")
                    edge = f"`{src_label}` ➔ `{target}`"
                    if edge not in call_edges and len(call_edges) < 25:
                        call_edges.append(edge)
            except Exception:
                pass

    return {
        "package_edges": pkg_edges[:15],
        "call_edges": call_edges[:20],
    }


def scan_openapi_and_dto_schemas(root: Path) -> list[dict[str, str]]:
    """Scan OpenAPI/Swagger specs as well as Pydantic BaseModel / TypeScript interface / Zod DTO schemas."""
    schemas: list[dict[str, str]] = []
    seen_schemas: set[tuple[str, str]] = set()

    # 1. OpenAPI / Swagger JSON files
    for oa_file in dict.fromkeys(_iter_repo_files(root, "**/*openapi*.json", limit=5) + _iter_repo_files(root, "**/*swagger*.json", limit=5)):
        try:
            data = json.loads(_read_code(oa_file, 100_000))
            comp_schemas = (data.get("components") or {}).get("schemas") or data.get("definitions") or {}
            src_rel = str(oa_file.relative_to(root))
            for sname, sdef in list(comp_schemas.items())[:15]:
                if isinstance(sdef, dict) and (sname, src_rel) not in seen_schemas:
                    seen_schemas.add((sname, src_rel))
                    props = list((sdef.get("properties") or {}).keys())[:6]
                    schemas.append({
                        "name": sname,
                        "kind": "OpenAPI Schema",
                        "source": src_rel,
                        "fields": ", ".join(f"`{p}`" for p in props) if props else "object",
                    })
        except Exception:
            pass

    # 2. Python Pydantic Request/Response DTOs ( via AST )
    for py_file in dict.fromkeys(_iter_repo_files(root, "**/api/*.py", limit=30) + _iter_repo_files(root, "**/schemas*.py", limit=20)):
        try:
            tree = ast.parse(_read_code(py_file))
            src_rel = str(py_file.relative_to(root))
            for node in tree.body:
                if isinstance(node, ast.ClassDef) and (node.name, src_rel) not in seen_schemas:
                    bases = [ast.unparse(b) if hasattr(ast, "unparse") else getattr(b, "id", "") for b in node.bases]
                    if any("BaseModel" in b or "Schema" in b for b in bases):
                        fields = []
                        for stmt in node.body:
                            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and not stmt.target.id.startswith("_"):
                                ftype = ast.unparse(stmt.annotation).replace("|", "\\|") if hasattr(ast, "unparse") and stmt.annotation else ""
                                fields.append(f"{stmt.target.id}: {ftype}" if ftype else stmt.target.id)
                        if fields:
                            seen_schemas.add((node.name, src_rel))
                            schemas.append({
                                "name": node.name,
                                "kind": "Pydantic DTO",
                                "source": src_rel,
                                "fields": ", ".join(f"`{f}`" for f in fields[:6]),
                            })
        except Exception:
            pass

    # 3. TypeScript exported interfaces / Zod schemas
    if len(schemas) < 20:
        for ts_file in dict.fromkeys(_iter_repo_files(root, "**/types*.ts", limit=15) + _iter_repo_files(root, "**/*dto*.ts", limit=15)):
            try:
                content = _read_code(ts_file)
                src_rel = str(ts_file.relative_to(root))
                if "interface " in content:
                    for im in re.finditer(r'export\s+interface\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}', content):
                        iname = im.group(1)
                        if (iname, src_rel) in seen_schemas:
                            continue
                        props = re.findall(r'^\s*([a-zA-Z0-9_]+)\??\s*:', im.group(2), re.MULTILINE)
                        if props:
                            seen_schemas.add((iname, src_rel))
                            schemas.append({
                                "name": iname,
                                "kind": "TS Interface",
                                "source": src_rel,
                                "fields": ", ".join(f"`{p}`" for p in props[:6]),
                            })
            except Exception:
                pass

    return schemas[:25]


def scan_cli_and_entrypoints(root: Path) -> list[dict[str, str]]:
    """Scan CLI binaries, pyproject scripts, Go cmd/*, Rust src/bin/*, and repository utility scripts."""
    entries: list[dict[str, str]] = []

    # 1. package.json bin entries
    for pj in _iter_repo_files(root, "**/package.json", limit=30):
        try:
            data = json.loads(pj.read_text(encoding="utf-8", errors="ignore"))
            bins = data.get("bin")
            if isinstance(bins, dict):
                for bname, bpath in bins.items():
                    entries.append({
                        "name": bname,
                        "kind": "Node CLI Binary",
                        "path": str((pj.parent / str(bpath)).relative_to(root)),
                    })
            elif isinstance(bins, str) and data.get("name"):
                entries.append({
                    "name": str(data["name"]),
                    "kind": "Node CLI Binary",
                    "path": str((pj.parent / bins).relative_to(root)),
                })
        except Exception:
            pass

    # 2. pyproject.toml [project.scripts]
    for pp in _iter_repo_files(root, "**/pyproject.toml", limit=15):
        try:
            content = pp.read_text(encoding="utf-8", errors="ignore")
            sm = re.search(r'\[project\.scripts\]([\s\S]*?)(?:\n\[|\Z)', content)
            if sm:
                for line in sm.group(1).splitlines():
                    if "=" in line and not line.strip().startswith("#"):
                        k, v = line.split("=", 1)
                        entries.append({
                            "name": k.strip(),
                            "kind": "Python CLI Script",
                            "path": v.strip().strip("\"'"),
                        })
        except Exception:
            pass

    # 3. Go cmd/*/main.go & Rust src/bin/*.rs
    for gm in _iter_repo_files(root, "cmd/*/main.go", limit=15):
        entries.append({"name": gm.parent.name, "kind": "Go Command", "path": str(gm.relative_to(root))})
    for rb in _iter_repo_files(root, "**/src/bin/*.rs", limit=15):
        entries.append({"name": rb.stem, "kind": "Rust Binary", "path": str(rb.relative_to(root))})

    # 4. Repository scripts/ directory
    scripts_dir = root / "scripts"
    if scripts_dir.is_dir():
        for sf in sorted(scripts_dir.iterdir()):
            if sf.is_file() and not sf.name.startswith("_") and sf.suffix in (".py", ".sh", ".mjs", ".ts", ".js"):
                entries.append({
                    "name": sf.name,
                    "kind": "Automation Script",
                    "path": str(sf.relative_to(root)),
                })

    return entries[:20]


def scan_external_infra(root: Path) -> list[str]:
    """Detect external databases, caches, queues, and object storage used by the project."""
    detected: list[str] = []
    manifest_texts = []
    for fname in ("docker-compose.yml", "docker-compose.yaml", ".env.example", "pyproject.toml", "package.json", "go.mod", "Cargo.toml"):
        p = root / fname
        if p.exists():
            try:
                manifest_texts.append(p.read_text(encoding="utf-8", errors="ignore").lower())
            except Exception:
                pass
    for sub_m in _iter_repo_files(root, "**/pyproject.toml", limit=10) + _iter_repo_files(root, "**/package.json", limit=15):
        try:
            manifest_texts.append(sub_m.read_text(encoding="utf-8", errors="ignore").lower())
        except Exception:
            pass

    blob = "\n".join(manifest_texts)
    infra_rules = [
        ("PostgreSQL", ("postgres", "asyncpg", "psycopg", "pgvector", '"pg"', "pgx")),
        ("pgvector (Vector DB)", ("pgvector",)),
        ("Redis", ("redis", "ioredis", "bullmq")),
        ("MySQL / MariaDB", ("mysql", "pymysql", "mariadb")),
        ("SQLite", ("sqlite", "aiosqlite", "better-sqlite3")),
        ("MongoDB", ("mongodb", "mongoose", "pymongo", "motor")),
        ("MinIO / S3 Object Storage", ("minio", "s3", "boto3", "@aws-sdk/client-s3")),
        ("Celery Task Queue", ("celery",)),
        ("Kafka", ("kafka", "confluent-kafka", "kafkajs")),
        ("RabbitMQ", ("rabbitmq", "amqp", "pika")),
        ("Elasticsearch / OpenSearch", ("elasticsearch", "opensearch")),
    ]
    for label, keywords in infra_rules:
        if any(kw in blob for kw in keywords):
            detected.append(label)
    return detected


def _sanitize_blueprint_text(text: str) -> str:
    """Mask private network IP ranges or sensitive internal addresses."""
    text = re.sub(r'192\.168\.\d{1,3}\.[a-zA-Z0-9_.-]+', '<internal-ip>', text)
    text = re.sub(r'10\.\d{1,3}\.\d{1,3}\.[a-zA-Z0-9_.-]+', '<internal-ip>', text)
    text = re.sub(r'172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.[a-zA-Z0-9_.-]+', '<internal-ip>', text)
    return text


def scan_env_variables(root: Path) -> list[dict[str, str]]:
    """Scan .env.example or deployment configs for declared environment variables."""
    vars_list: list[dict[str, str]] = []
    env_example = root / ".env.example"
    if not env_example.exists():
        env_example = root / ".env.sample"

    if env_example.exists():
        try:
            content = env_example.read_text(encoding="utf-8", errors="ignore")
            current_comment = ""
            for line in content.splitlines():
                sline = line.strip()
                if not sline:
                    current_comment = ""
                    continue
                if sline.startswith("#"):
                    cleaned_c = _sanitize_blueprint_text(sline.lstrip("#").strip())
                    if cleaned_c and not re.match(r'^[-=_─*#\s]+$', cleaned_c):
                        current_comment = cleaned_c
                    continue
                if "=" in sline:
                    k, v = sline.split("=", 1)
                    k = k.strip()
                    if k and not k.startswith("#"):
                        clean_val = _sanitize_blueprint_text(v.strip())
                        vars_list.append({
                            "name": k,
                            "default": clean_val or "(required secret)",
                            "description": current_comment or "Environment configuration",
                        })
                        current_comment = ""
        except Exception:
            pass

    return vars_list


GUIDANCE_FILES = (
    "CLAUDE.md",
    "AGENTS.md",
    "GEMINI.md",
    ".cursorrules",
    ".windsurfrules",
    ".clinerules",
    ".github/copilot-instructions.md",
)


def ensure_agent_guidance_anchor(root: Path) -> list[str]:
    """Add a "read the blueprint first" hint to the repo's own agent instruction files (only with --anchor:
    these files are usually tracked, and the resident profile already carries the same rule).
    Returns the files changed, recorded so uninstalling takes the hint back out."""
    anchor_snippet = (
        f"{ANCHOR_MARKER}\n"
        "> [!TIP]\n"
        "> **架构心智指引**：新会话或全局重构前，先读根目录活体代码蓝图 [PROJECT_BLUEPRINT.md](PROJECT_BLUEPRINT.md) 开头的「0. 速览与章节索引」，再按行号只读需要的章节，避免重复 grep 扫描。\n"
        f"{ANCHOR_MARKER}\n\n"
    )

    modified: list[str] = []
    for rel in GUIDANCE_FILES:
        gf = root / rel
        if not gf.exists():
            continue
        try:
            text = gf.read_text(encoding="utf-8", errors="ignore")
            if BLUEPRINT_FILE in text:
                continue
            lines = text.splitlines(keepends=True)
            if lines and lines[0].startswith("#"):
                new_text = lines[0] + "\n" + anchor_snippet + "".join(lines[1:])
            else:
                new_text = anchor_snippet + text
            _atomic_write(gf, new_text)
            modified.append(rel)
        except Exception:
            pass
    if modified:
        _record_state(root, anchors=modified)
    return modified


def remove_agent_guidance_anchor(root: Path, files: list[str]) -> None:
    """Take out the hint ensure_agent_guidance_anchor added (only from the files it recorded)."""
    snippet = rf"{re.escape(ANCHOR_MARKER)}\n[\s\S]*?{re.escape(ANCHOR_MARKER)}\n\n?"
    for rel in files:
        gf = root / rel
        try:
            text = gf.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if ANCHOR_MARKER not in text:
            continue
        # The exact inverse of the insert: after the first heading line and a blank line, or at the top
        cleaned, n = re.subn(rf"^(#[^\n]*\n)\n{snippet}", r"\1", text, count=1)
        if not n:
            cleaned, n = re.subn(rf"^{snippet}", "", text, count=1)
        if not n:
            cleaned = re.sub(snippet, "", text, count=1)
        _atomic_write(gf, cleaned)


def generate_mermaid_diagram(
    subsystems: list[dict[str, Any]],
    stack: dict[str, Any],
    infra: list[str] | None = None,
    pkg_edges: list[str] | None = None,
) -> str:
    """Generate a high-level architectural data flow diagram in Mermaid format."""
    lines = ["```mermaid", "flowchart TD"]

    has_web = any("apps/web" in s["name"] for s in subsystems)
    has_desktop = any("apps/desktop" in s["name"] for s in subsystems)
    has_daemon = any("packages/daemon" in s["name"] for s in subsystems)
    has_mcp = any("packages/mcp" in s["name"] for s in subsystems)
    has_server = any(s["name"] == "server" or "server/" in s["name"] for s in subsystems)
    has_emb = any("embedding" in s["name"] for s in subsystems)

    if not (has_web or has_desktop or has_daemon or has_mcp):
        # Dynamic layered architecture graph for general repositories using real roles, dependencies & infra
        lines.append('    subgraph Modules["项目核心模块与子系统"]')
        node_map: dict[str, str] = {}
        client_nodes: list[str] = []
        service_nodes: list[str] = []
        other_nodes: list[str] = []
        for idx, sub in enumerate(subsystems[:10]):
            nid = f"M{idx}"
            node_map[sub["path"]] = nid
            node_map[sub["name"]] = nid
            safe_label = sub["name"].replace('"', "'")
            lines.append(f'        {nid}["{safe_label} ({sub["type"]})"]')
            role_low = sub["type"].lower()
            if any(k in role_low for k in ("frontend", "client", "desktop", "web")):
                client_nodes.append(nid)
            elif any(k in role_low for k in ("backend", "api", "engine", "quant", "core", "transport")):
                service_nodes.append(nid)
            elif not any(k in role_low for k in ("doc", "test", "container", "kubernetes", "infrastructure")):
                other_nodes.append(nid)
        lines.append("    end")
        if infra:
            lines.append('    subgraph Infra["外部存储与中间件"]')
            for i_idx, inf in enumerate(infra[:6]):
                lines.append(f'        INF{i_idx}[("{inf}")]')
            lines.append("    end")
        added_real_edge = False
        for pe in (pkg_edges or []):
            m = re.match(r'`([^`]+)`\s*➔\s*`([^`]+)`', pe)
            if m and m.group(1) in node_map and m.group(2) in node_map:
                lines.append(f"    {node_map[m.group(1)]} --> {node_map[m.group(2)]}")
                added_real_edge = True
        if not added_real_edge:
            if client_nodes and service_nodes:
                for cn in client_nodes:
                    lines.append(f"    {cn} --> {service_nodes[0]}")
                for sn in service_nodes[1:]:
                    lines.append(f"    {service_nodes[0]} --> {sn}")
            elif len(service_nodes) >= 2:
                for sn in service_nodes[1:]:
                    lines.append(f"    {service_nodes[0]} --> {sn}")
            elif service_nodes and other_nodes:
                for on in other_nodes[:3]:
                    lines.append(f"    {service_nodes[0]} --> {on}")
        primary_service = service_nodes[0] if service_nodes else (client_nodes[0] if client_nodes else ("M0" if subsystems else ""))
        if infra and primary_service:
            for i_idx in range(min(len(infra), 6)):
                lines.append(f"    {primary_service} -.-> INF{i_idx}")
        lines.append("```")
        return "\n".join(lines)

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

    # 2. General Python project (root or backend/)
    pyproject = root / "pyproject.toml"
    has_python = pyproject.exists() or (root / "requirements.txt").exists() or (root / "setup.py").exists() or any(root.glob("*.py"))
    if has_python:
        if (root / "pytest.ini").exists() or (root / "tests").is_dir() or (root / "test").is_dir():
            commands.extend(["# Python Tests", "pytest"])
        if (root / "ruff.toml").exists() or (pyproject.exists() and "ruff" in _read_code(pyproject, 20_000)):
            commands.extend(["# Python Lint", "ruff check ."])
    elif (root / "backend").is_dir() and ((root / "backend" / "requirements.txt").exists() or (root / "backend" / "pyproject.toml").exists()):
        if (root / "backend" / "tests").is_dir() or (root / "backend" / "pytest.ini").exists():
            commands.extend(["# Backend Python Tests", "cd backend && pytest"])

    # 3. General Node / TypeScript project (root or frontend/ / desktop/ / client/)
    pjson_path = root / "package.json"
    if pjson_path.exists():
        try:
            pdata = json.loads(_read_code(pjson_path, 20_000))
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
    else:
        for sub_node in ("frontend", "desktop", "client", "web"):
            sub_pj = root / sub_node / "package.json"
            if sub_pj.exists():
                try:
                    pdata = json.loads(_read_code(sub_pj, 20_000))
                    scripts = pdata.get("scripts", {})
                    if "test" in scripts:
                        commands.extend([f"# {sub_node.capitalize()} Tests", f"cd {sub_node} && npm test"])
                    if "build" in scripts:
                        commands.extend([f"# {sub_node.capitalize()} Build", f"cd {sub_node} && npm run build"])
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
    _REPO_FILE_CACHE.pop(root.resolve(), None)
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
    if git_branch == "HEAD":
        tag_name = run_git_cmd(["describe", "--tags", "--exact-match"], root)
        contains_out = run_git_cmd(["branch", "--contains", "HEAD", "--format=%(refname:short)"], root)
        branch_lines = [b.strip() for b in contains_out.splitlines() if b.strip() and not b.strip().startswith("(")]
        git_branch = tag_name or (branch_lines[0] if branch_lines else "detached-HEAD")
    git_commit = run_git_cmd(["rev-parse", "--short", "HEAD"], root) or "unknown"
    git_date = run_git_cmd(["log", "-1", "--format=%as"], root) or "recent"

    stack = detect_tech_stack(root)
    about = detect_project_about(root)
    subsystems = scan_subsystems(root)
    frontend_routes = scan_frontend_routes(root)
    routes = scan_api_routes(root)
    models_data = scan_data_models(root)
    models = models_data.get("models", [])
    relations = models_data.get("relations", [])
    unique_constraints = models_data.get("unique_constraints", [])
    er_diagram = generate_er_diagram(relations)
    svc_sched = scan_services_and_schedules(root)
    services = svc_sched.get("services", [])
    schedules = svc_sched.get("schedules", [])
    protocols = scan_mcp_and_ws_protocols(root)
    mcp_tools = protocols.get("mcp_tools", [])
    ws_events = protocols.get("ws_events", [])
    rpc_contracts = protocols.get("rpc_contracts", [])
    cicd_items = scan_cicd_and_deploy(root)
    hot_tests = scan_hotspots_and_tests(root)
    hotspots = hot_tests.get("hotspots", [])
    test_suites = hot_tests.get("test_suites", [])
    ast_deps = scan_ast_call_graph_and_deps(root)
    pkg_edges = ast_deps.get("package_edges", [])
    call_edges = ast_deps.get("call_edges", [])
    dto_schemas = scan_openapi_and_dto_schemas(root)
    cli_entries = scan_cli_and_entrypoints(root)
    infra_list = scan_external_infra(root)
    env_vars = scan_env_variables(root)
    mermaid_diagram = generate_mermaid_diagram(subsystems, stack, infra=infra_list, pkg_edges=pkg_edges)
    evolution_list = get_git_evolution(root, limit=6)

    doc = [
        f"# Project Blueprint: {repo_name}",
        "",
        "> [!NOTE]",
        f"> **Living Blueprint Auto-Generated** · Branch: `{git_branch}` · Commit: `{git_commit}` · Updated: `{git_date}`",
        "> An architectural map of the codebase for AI coding agents (Claude Code, Codex, Antigravity, Cursor, ...).",
        "> Read section 0 first; open other sections by the line ranges it lists instead of reading the whole file.",
        "",
        "## 1. Project Overview & Tech Stack",
        "",
        *([f"- **About**: {about}"] if about else []),
        f"- **Project Type**: {stack['project_type']}",
        f"- **Core Languages**: {', '.join(stack['languages']) if stack['languages'] else 'Generic'}",
        f"- **Key Frameworks**: {', '.join(stack['frameworks']) if stack['frameworks'] else 'None detected'}",
        f"- **Infrastructure & Middleware**: {', '.join(infra_list) if infra_list else 'Standard local runtime'}",
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
    doc.append("")

    if frontend_routes or routes or models or relations or unique_constraints:
        doc.extend([
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
        doc.append("### Registered API Routers & Endpoints")
        doc.append("")
        for r in routes:
            rfile = r.get("file") or f"{r['name']}.py"
            doc.append(f"#### `{r['prefix']}` ({rfile})")
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

    if relations:
        doc.append("#### Key Entity Relationships (Foreign Keys)")
        doc.append("")
        if er_diagram:
            doc.append(er_diagram)
            doc.append("")
        for rel in relations:
            doc.append(f"- {rel}")
        doc.append("")

    if unique_constraints:
        doc.append("#### Deduplication & Uniqueness Constraints")
        doc.append("")
        for uq in unique_constraints:
            doc.append(f"- {uq}")
        doc.append("")

    if services or schedules:
        doc.extend([
            "## 5. Core Domain Services & Background Schedules",
            "",
        ])
        if schedules:
            doc.extend([
                "### Scheduled Background Jobs (Celery Beat / Cron)",
                "",
                "| Job Name | Target Task | Schedule |",
                "| :--- | :--- | :--- |",
            ])
            for sch in schedules:
                doc.append(f"| `{sch['name']}` | `{sch['task']}` | `{sch['schedule']}` |")
            doc.append("")
        if services:
            doc.extend([
                "### Core Service Layer Modules",
                "",
                "| Service Module | Path | Responsibility |",
                "| :--- | :--- | :--- |",
            ])
            for svc in services:
                doc.append(f"| `{svc['name']}` | [`{svc['path']}`]({svc['path']}) | {svc['summary']} |")
            doc.append("")

    if mcp_tools or ws_events or rpc_contracts:
        doc.extend([
            "## 6. MCP Tools, RPC Contracts & Real-Time WebSocket Protocols",
            "",
        ])
        if mcp_tools:
            doc.extend([
                "### Registered MCP Server Tools",
                "",
                "| Tool Name | Purpose |",
                "| :--- | :--- |",
            ])
            for mt in mcp_tools:
                doc.append(f"| `{mt['name']}` | {mt['description']} |")
            doc.append("")
        if rpc_contracts:
            doc.append("### gRPC & GraphQL Service Contracts")
            doc.append("")
            for rc in rpc_contracts:
                doc.append(f"- {rc}")
            doc.append("")
        if ws_events:
            doc.append("### WebSocket Control & Data Plane Events")
            doc.append("")
            doc.append(", ".join(f"`{ev}`" for ev in ws_events))
            doc.append("")

    if pkg_edges or call_edges or dto_schemas or cli_entries:
        doc.extend([
            "## 6.5. AST Call Graph, DTO Schemas & CLI Entrypoints",
            "",
        ])
        if pkg_edges:
            doc.append("### Workspace Package Dependency Graph")
            doc.append("")
            for pe in pkg_edges:
                doc.append(f"- {pe}")
            doc.append("")
        if call_edges:
            doc.append("### AST Cross-Layer Call & Import Graph (Entry ➔ Service / Store)")
            doc.append("")
            for ce in call_edges:
                doc.append(f"- {ce}")
            doc.append("")
        if dto_schemas:
            doc.extend([
                "### Key Request / Response DTO & OpenAPI Schemas",
                "",
                "| Schema Name | Type | Source File | Core Fields |",
                "| :--- | :--- | :--- | :--- |",
            ])
            for ds in dto_schemas:
                doc.append(f"| `{ds['name']}` | {ds['kind']} | [`{ds['source']}`]({ds['source']}) | {ds['fields']} |")
            doc.append("")
        if cli_entries:
            doc.extend([
                "### CLI Binaries & Automation Entrypoints",
                "",
                "| Command / Script | Category | Path / Target |",
                "| :--- | :--- | :--- |",
            ])
            for ce in cli_entries:
                doc.append(f"| `{ce['name']}` | {ce['kind']} | `{ce['path']}` |")
            doc.append("")

    if cicd_items or hotspots or test_suites:
        doc.extend([
            "## 7. CI/CD Pipelines, Code Hotspots & Test Suites",
            "",
        ])
        if cicd_items:
            doc.extend([
                "### CI/CD Workflows & Deployment Manifests",
                "",
                "| Category | Name | Path | Details |",
                "| :--- | :--- | :--- | :--- |",
            ])
            for ci in cicd_items:
                doc.append(f"| {ci['kind']} | `{ci['name']}` | [`{ci['path']}`]({ci['path']}) | {ci['details']} |")
            doc.append("")
        if test_suites:
            doc.extend([
                "### Automated Test Suite Matrix",
                "",
                "| Suite | Directory | Files | Sample Tests |",
                "| :--- | :--- | :--- | :--- |",
            ])
            for ts in test_suites:
                doc.append(f"| {ts['suite']} | [`{ts['dir']}`]({ts['dir']}) | {ts['count']} | {ts['samples']} |")
            doc.append("")
        if hotspots:
            doc.extend([
                "### Architectural Hotspots (Top Modified Files in Recent 40 Commits)",
                "",
            ])
            for hs in hotspots:
                doc.append(f"- [`{hs['path']}`]({hs['path']}) ({hs['commits']} commits)")
            doc.append("")

    doc.extend([
        "## 8. Development & Verification Commands",
        "",
        "```bash",
        *detect_verification_commands(root),
        "```",
        "",
        "## 9. Recent Architectural Evolutions",
        "",
    ])

    if evolution_list:
        doc.extend(evolution_list)
    else:
        doc.append("- Initial project baseline established.")

    if env_vars:
        doc.extend([
            "",
            "## 10. Key Environment Variables & Configuration",
            "",
            "| Variable | Default / Status | Description |",
            "| :--- | :--- | :--- |",
        ])
        for ev in env_vars[:20]:
            doc.append(f"| `{ev['name']}` | `{ev['default']}` | {ev['description']} |")

    doc.extend([
        "",
        "---",
        f"{GENERATED_MARK} (v{BLUEPRINT_SCRIPT_VERSION}) & `.git/hooks/(post-commit, post-merge, post-checkout)`. Updates automatically on code modifications, pulls, and branch switches._",
        "",
    ])

    summary = _quick_summary(
        stack, infra_list, subsystems, routes, frontend_routes, models, services, schedules,
        test_suites, detect_verification_commands(root), evolution_list, about=about,
    )
    return _with_summary_and_index(doc, summary)


def _quick_summary(
    stack: dict[str, Any],
    infra: list[str],
    subsystems: list[dict[str, Any]],
    routes: list[dict[str, Any]],
    frontend_routes: list[str],
    models: list[str],
    services: list[dict[str, Any]],
    schedules: list[dict[str, Any]],
    test_suites: list[dict[str, Any]],
    commands: list[str],
    evolution: list[str],
    about: str = "",
) -> list[str]:
    """The few lines that orient an agent without reading the rest."""
    langs = ", ".join(stack.get("languages") or []) or "Generic"
    frameworks = ", ".join((stack.get("frameworks") or [])[:8])
    lines = [
        *([f"- 简介 (About): {about}"] if about else []),
        f"- 类型 (Type): {stack.get('project_type') or 'Generic'}",
        f"- 技术栈 (Stack): {langs}" + (f" · {frameworks}" if frameworks else ""),
    ]
    if infra:
        lines.append(f"- 基础设施 (Infra): {', '.join(infra[:8])}")
    scale = [f"{len(subsystems)} 个子系统"]
    if routes:
        endpoints = sum(int(r.get("total") or 0) for r in routes)
        scale.append(f"{len(routes)} 组 API 路由 / {endpoints} 个接口")
    if frontend_routes:
        scale.append(f"{len(frontend_routes)} 个前端页面")
    if models:
        scale.append(f"{len(models)} 个数据模型")
    if services:
        scale.append(f"{len(services)} 个服务模块")
    if schedules:
        scale.append(f"{len(schedules)} 个定时任务")
    tests = sum(int(ts.get("count") or 0) for ts in test_suites)
    if tests:
        scale.append(f"{tests} 个测试文件")
    lines.append(f"- 规模 (Scale): {' · '.join(scale)}")
    names = [str(s.get("name")) for s in subsystems if s.get("name")][:12]
    if names:
        lines.append(f"- 子系统 (Subsystems): {', '.join(f'`{n}`' for n in names)}")
    runnable = [c.strip() for c in commands if c.strip() and not c.lstrip().startswith("#")][:4]
    if runnable:
        lines.append(f"- 自测命令 (Verify): {' ; '.join(f'`{c}`' for c in runnable)}")
    if evolution:
        lines.append(f"- 最近改动 (Latest): {evolution[0].lstrip('- ').strip()[:160]}")
    return lines


def _with_summary_and_index(doc: list[str], summary: list[str]) -> str:
    """Put section 0 (the summary and a line-numbered index of every other section) before section 1."""
    doc = "\n".join(doc).split("\n")  # diagrams are one entry spanning many lines
    first = next((i for i, line in enumerate(doc) if line.startswith("## ")), len(doc))
    headings = sum(1 for line in doc[first:] if line.startswith("## "))
    block = [
        "## 0. 速览与章节索引 (Quick Summary & Section Index)",
        "",
        "> 先读这一节定位全局；要细节时按下表行号只读对应章节（Read 的 offset/limit，或 `sed -n 'A,Bp' PROJECT_BLUEPRINT.md`），不必整份读入。",
        "",
        *summary,
        "",
        "| 章节 (Section) | 行号 (Lines) |",
        "| :--- | :--- |",
    ]
    rows_at = first + len(block)
    block.extend([""] * headings)
    block.append("")
    out = doc[:first] + block + doc[first:]
    starts = [i for i in range(rows_at + headings, len(out)) if out[i].startswith("## ")]
    footer = next((i for i in range(len(out) - 1, -1, -1) if out[i] == "---"), len(out))
    for n, start in enumerate(starts):
        end = (starts[n + 1] if n + 1 < len(starts) else footer) - 1
        while end > start and not out[end].strip():
            end -= 1
        title = re.sub(r"^##\s+", "", out[start])
        out[rows_at + n] = f"| {title} | L{start + 1}-L{end + 1} |"
    return "\n".join(out)


HOOK_MARKER_START = "# <<< Memento Blueprint Hook Start >>>"
HOOK_MARKER_END = "# <<< Memento Blueprint Hook End >>>"

# POSIX sh, appended to the end of the hook. It runs in a subshell and then restores the exit status
# of whatever ran before it, so a pre-commit check that failed still stops the commit.
HOOK_TEMPLATE = """__START__
# Keeps PROJECT_BLUEPRINT.md current on commit, merge, rebase and branch switch (managed by Memento)
__memento_rc=$?
(
    GIT_DIR_PATH=$(git rev-parse --git-dir 2>/dev/null) || exit 0
    if [ -d "$GIT_DIR_PATH/rebase-merge" ] || [ -d "$GIT_DIR_PATH/rebase-apply" ]; then
        exit 0
    fi
    HOOK_NAME=$(basename "$0")
    # post-checkout: only a branch switch ($3 = 1), not a file checkout
    if [ "$HOOK_NAME" = "post-checkout" ] && [ "$3" != "1" ]; then
        exit 0
    fi
    BP_SCRIPT=""
    if [ -f "scripts/project_blueprint.py" ]; then
        BP_SCRIPT="scripts/project_blueprint.py"
    elif [ -n "$MEMENTO_HOME" ] && [ -f "$MEMENTO_HOME/scripts/project_blueprint.py" ]; then
        BP_SCRIPT="$MEMENTO_HOME/scripts/project_blueprint.py"
    elif [ -f "$HOME/.memento/scripts/project_blueprint.py" ]; then
        BP_SCRIPT="$HOME/.memento/scripts/project_blueprint.py"
    elif [ -n "$USERPROFILE" ] && [ -f "$USERPROFILE/.memento/scripts/project_blueprint.py" ]; then
        BP_SCRIPT="$USERPROFILE/.memento/scripts/project_blueprint.py"
    fi
    [ -n "$BP_SCRIPT" ] || exit 0
    PYTHON_BIN=$(command -v python3 2>/dev/null || command -v python 2>/dev/null) || exit 0
    if git ls-files --error-unmatch PROJECT_BLUEPRINT.md >/dev/null 2>&1; then
        # Tracked: regenerated into the commit itself; afterwards only the HEAD it matches is recorded
        if [ "$HOOK_NAME" = "pre-commit" ]; then
            "$PYTHON_BIN" "$BP_SCRIPT" --root . --quiet >/dev/null 2>&1 && git add PROJECT_BLUEPRINT.md >/dev/null 2>&1
        else
            git rev-parse --short HEAD > "$GIT_DIR_PATH/.memento_blueprint_head" 2>/dev/null
        fi
    elif [ "$HOOK_NAME" != "pre-commit" ]; then
        # Untracked: refreshed in the background so the git command returns at once
        ("$PYTHON_BIN" "$BP_SCRIPT" --root . --quiet </dev/null >/dev/null 2>&1 &)
    fi
) || true
(exit $__memento_rc)
__END__""".replace("__START__", HOOK_MARKER_START).replace("__END__", HOOK_MARKER_END)

MANAGED_GIT_HOOKS = ["pre-commit", "post-commit", "post-merge", "post-checkout", "post-rewrite"]
_SH_SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "ash"}
_SHEBANG_ONLY = ("", "#!/bin/sh", "#!/bin/bash", "#!/usr/bin/env sh", "#!/usr/bin/env bash")


def _record_blueprint_head(root: Path) -> None:
    """Record the HEAD the blueprint matches, in the git dir, for the collector's staleness check."""
    git_dir = _git_path(root, "--git-dir")
    if not git_dir:
        return
    try:
        sha = run_git_cmd(["rev-parse", "--short", "HEAD"], root)
        if sha:
            _atomic_write(git_dir / HEAD_MARKER, sha.strip() + "\n")
    except Exception:
        pass


def _ensure_excluded(root: Path) -> bool:
    """Keep an untracked generated blueprint out of `git status`, through .git/info/exclude
    (local to this clone, unlike .gitignore). False when the user's own rules already ignore it."""
    common = _git_path(root, "--git-common-dir")
    if not common:
        return False
    exclude = common / "info" / "exclude"
    try:
        text = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
        if EXCLUDE_MARK in text:
            return True
        if _git_ok(["check-ignore", "-q", "--", BLUEPRINT_FILE], root):
            return False
        exclude.parent.mkdir(parents=True, exist_ok=True)
        sep = "" if not text or text.endswith("\n") else "\n"
        _atomic_write(exclude, f"{text}{sep}{EXCLUDE_MARK}\n/{BLUEPRINT_FILE}\n")
        return True
    except OSError:
        return False


def _remove_excluded(root: Path) -> None:
    common = _git_path(root, "--git-common-dir")
    exclude = common / "info" / "exclude" if common else None
    if not exclude or not exclude.is_file():
        return
    try:
        text = exclude.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    if EXCLUDE_MARK in text:
        _atomic_write(exclude, re.sub(rf"(?m)^{re.escape(EXCLUDE_MARK)}\n(?:/{re.escape(BLUEPRINT_FILE)}\n?)?", "", text))


def write_blueprint(root: Path, out_path: Path | None = None) -> tuple[Path, bool]:
    """Generate the blueprint and write it (atomically, only when it changed). Returns (path, changed).
    A hand-written PROJECT_BLUEPRINT.md of the same name is left as it is."""
    target = out_path or root / BLUEPRINT_FILE
    if out_path is None and target.is_file() and not _is_generated(target):
        return target, False
    changed = _atomic_write(target, build_blueprint_content(root))
    if target.resolve() == (root / BLUEPRINT_FILE).resolve():
        _record_blueprint_head(root)
        untracked = not _is_tracked(root)
        excluded = _ensure_excluded(root) if untracked else False
        _record_state(root, generated_untracked=untracked, **({"excluded": True} if excluded else {}))
    return target, changed


def _hook_is_shell(content: str) -> bool:
    """Whether a hook is a shell script our sh block can be appended to (not Python, Node, ...)."""
    stripped = content.lstrip("﻿")
    if not stripped.strip():
        return True
    first = stripped.splitlines()[0].strip()
    if not first.startswith("#!"):
        return True  # no interpreter line: git runs it with sh
    parts = first[2:].split()
    if not parts:
        return True
    prog = Path(parts[0]).name
    if prog == "env":
        args = [p for p in parts[1:] if not p.startswith("-")]
        prog = Path(args[0]).name if args else ""
    return prog in _SH_SHELLS


def _clean_hook_content(content: str) -> str:
    """The hook without our block (and the untagged lines very early versions wrote)."""
    cleaned = re.sub(
        rf"\n*{re.escape(HOOK_MARKER_START)}[\s\S]*?{re.escape(HOOK_MARKER_END)}\n?",
        "\n",
        content,
    )
    cleaned = re.sub(
        r"# Auto-update PROJECT_BLUEPRINT\.md[^\n]*\n(?:[^\n]*\n)*?python3[^\n]*project_blueprint\.py[^\n]*\n(?:fi\n)?",
        "",
        cleaned,
    )
    clean_lines = [
        line for line in cleaned.splitlines()
        if not ("project_blueprint.py" in line and "python" in line) and "# Auto-update PROJECT_BLUEPRINT.md" not in line
    ]
    non_trivial = [line for line in clean_lines if line.strip() and not line.strip().startswith("#!") and line.strip() != "fi"]
    if not non_trivial:
        return ""
    return "\n".join(clean_lines).strip()


def _sync_global_script() -> None:
    """Mirror this script to ~/.memento/scripts for hooks in repos that don't carry it (never downgrading)."""
    try:
        current_script = Path(__file__).resolve()
        global_script = Path.home() / ".memento" / "scripts" / "project_blueprint.py"
        if not current_script.is_file() or current_script == global_script.resolve():
            return
        cur_content = current_script.read_text(encoding="utf-8")
        existing = global_script.read_text(encoding="utf-8") if global_script.exists() else ""
        m = re.search(r"^BLUEPRINT_SCRIPT_VERSION\s*=\s*(\d+)", existing, re.MULTILINE)
        if existing == cur_content or (m and int(m.group(1)) > BLUEPRINT_SCRIPT_VERSION):
            return
        global_script.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(global_script, cur_content)
        global_script.chmod(0o755)
    except Exception:
        pass


def install_git_hook(root: Path) -> bool:
    """Append the refresh block to the repo's commit, merge, checkout and rewrite hooks.

    Left alone: repos whose hooks belong to another tool (core.hooksPath: husky, lefthook...),
    hooks written in another language, and symlinked hooks. The collector still refreshes
    those repos' blueprints when HEAD moves.
    """
    if not _git_ok(["rev-parse", "--git-dir"], root):
        print(f"Error: {root} is not a git repository.", file=sys.stderr)
        return False
    _sync_global_script()
    if run_git_cmd(["config", "--get", "core.hooksPath"], root):
        return True
    common = _git_path(root, "--git-common-dir")
    if not common:
        return False
    hooks_dir = common / "hooks"
    try:
        hooks_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False

    installed: list[str] = []
    all_ok = True
    for hname in MANAGED_GIT_HOOKS:
        hook_file = hooks_dir / hname
        if hook_file.is_symlink():
            continue
        try:
            existing = hook_file.read_text(encoding="utf-8", errors="ignore") if hook_file.exists() else ""
        except OSError:
            all_ok = False
            continue
        if not _hook_is_shell(existing):
            continue
        cleaned = _clean_hook_content(existing)
        if cleaned.strip() in _SHEBANG_ONLY:
            new_content = f"#!/bin/sh\n\n{HOOK_TEMPLATE}\n"
        else:
            new_content = f"{cleaned.rstrip()}\n\n{HOOK_TEMPLATE}\n"
        try:
            _atomic_write(hook_file, new_content)
            hook_file.chmod(0o755)
            installed.append(hname)
        except OSError:
            all_ok = False
    if installed:
        _record_state(root, hooks=installed)
    return all_ok


def uninstall_git_hook(root: Path) -> bool:
    """Take our block out of every managed hook; a hook left with nothing else in it is deleted."""
    common = _git_path(root, "--git-common-dir")
    hooks_dir = common / "hooks" if common else None
    if not hooks_dir or not hooks_dir.is_dir():
        return True
    all_ok = True
    for hname in MANAGED_GIT_HOOKS:
        hook_file = hooks_dir / hname
        if not hook_file.is_file() or hook_file.is_symlink():
            continue
        try:
            existing = hook_file.read_text(encoding="utf-8", errors="ignore")
            if HOOK_MARKER_START not in existing and "project_blueprint.py" not in existing:
                continue
            cleaned = _clean_hook_content(existing)
            if cleaned.strip() in _SHEBANG_ONLY:
                hook_file.unlink()
            else:
                _atomic_write(hook_file, cleaned.strip() + "\n")
                hook_file.chmod(0o755)
        except OSError:
            all_ok = False
    return all_ok


def _has_our_traces(root: Path) -> bool:
    if _state_file(root).exists():
        return True
    common = _git_path(root, "--git-common-dir")
    if not common:
        return False
    for hname in MANAGED_GIT_HOOKS:
        try:
            if HOOK_MARKER_START in (common / "hooks" / hname).read_text(encoding="utf-8", errors="ignore"):
                return True
        except OSError:
            pass
    try:
        return EXCLUDE_MARK in (common / "info" / "exclude").read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False


def uninstall_repo(root: Path) -> bool:
    """Take back everything this script did in one repo: hook blocks, the HEAD marker, the exclude
    line, hints it added to instruction files, and the generated file when git doesn't track it."""
    state = _load_state(root)
    ok = uninstall_git_hook(root)
    for d in {_git_path(root, "--git-dir"), _git_path(root, "--git-common-dir"), root / ".git"}:
        if d and (d / HEAD_MARKER).is_file():
            try:
                (d / HEAD_MARKER).unlink()
            except OSError:
                ok = False
    _remove_excluded(root)
    remove_agent_guidance_anchor(root, [str(f) for f in state.get("anchors") or []])
    bp = root / BLUEPRINT_FILE
    if bp.is_file() and not _is_tracked(root) and _is_generated(bp):
        try:
            bp.unlink()
        except OSError:
            ok = False
    try:
        _state_file(root).unlink(missing_ok=True)
        if not any(_state_dir().iterdir()):
            _state_dir().rmdir()
    except OSError:
        pass
    return ok


# Where the collector looks for repos (packages/daemon/src/blueprint-auto.ts discoverLocalGitRepositories)
DISCOVERY_BASES = ("dev", "Desktop/dev", "WorkBuddy", "projects", "workspace", "code", "repos")


def _discover_git_roots() -> set[Path]:
    home = Path.home()
    roots: set[Path] = set()

    def visit(d: Path, depth: int) -> None:
        if depth > 2 or d.name.startswith(".") or d.name in ("node_modules", "venv") or "worktree" in d.name.lower():
            return
        if (d / ".git").exists():
            roots.add(d.resolve())
            return
        if depth == 2:
            return
        try:
            for child in d.iterdir():
                if child.is_dir():
                    visit(child, depth + 1)
        except OSError:
            pass

    for rel in DISCOVERY_BASES:
        base = home / rel
        if not base.is_dir():
            continue
        try:
            for child in base.iterdir():
                if child.is_dir():
                    visit(child, 1)
        except OSError:
            pass
    return roots


def uninstall_all(quiet: bool = False) -> int:
    """uninstall_repo for every repo recorded in ~/.memento/blueprint_repos, plus any repo in the usual
    workspace folders that still carries our hook block or exclude line (written before the record existed)."""
    roots: set[Path] = set()
    state_dir = _state_dir()
    if state_dir.is_dir():
        for f in state_dir.glob("*.json"):
            try:
                root = json.loads(f.read_text(encoding="utf-8")).get("root")
            except (OSError, ValueError):
                root = None
            if isinstance(root, str) and Path(root).is_dir():
                roots.add(Path(root))
            else:
                f.unlink(missing_ok=True)
    roots |= {r for r in _discover_git_roots() if _has_our_traces(r)}
    failed = 0
    for r in sorted(roots):
        if uninstall_repo(r):
            if not quiet:
                print(f"Removed living blueprint & hooks from: {r}")
        else:
            failed += 1
            if not quiet:
                print(f"Could not fully clean {r}", file=sys.stderr)
    try:
        if state_dir.is_dir() and not any(state_dir.iterdir()):
            state_dir.rmdir()
    except OSError:
        pass
    return 1 if failed else 0


def bootstrap_discovered_projects(quiet: bool = False, anchor: bool = False) -> int:
    """Scan local AI instruction files and common dev workspaces to deploy living blueprints & hooks."""
    home = Path.home()
    roots: set[Path] = set()

    # 1. Extract scoped project directories from Memento resident profile files
    for pf in (
        home / ".claude" / "CLAUDE.md",
        home / ".codex" / "AGENTS.md",
        home / ".gemini" / "GEMINI.md",
        home / ".memento" / "mind_snapshot.json",
    ):
        if pf.exists():
            try:
                text = pf.read_text(encoding="utf-8", errors="ignore")
                for m in re.finditer(r'####\s+[^\s（(]+[（(]`([^`]+)`[）)]', text):
                    cand = Path(m.group(1).strip())
                    if (cand / ".git").exists():
                        roots.add(cand.resolve())
            except Exception:
                pass

    # 2. The workspace folders the collector scans
    roots |= _discover_git_roots()

    for r in sorted(roots):
        try:
            install_git_hook(r)
            if anchor:
                ensure_agent_guidance_anchor(r)
            write_blueprint(r)
            if not quiet:
                print(f"Bootstrapped living blueprint & hooks for: {r}")
        except Exception as e:
            if not quiet:
                print(f"Skipped {r}: {e}", file=sys.stderr)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate and maintain living PROJECT_BLUEPRINT.md for AI agents.")
    parser.add_argument("--root", type=str, default=".", help="Project root directory (default: current directory)")
    parser.add_argument("--output", type=str, default="", help="Output markdown path (default: <root>/PROJECT_BLUEPRINT.md)")
    parser.add_argument("--install-hook", action="store_true", help="Install the git hooks that keep the blueprint current")
    parser.add_argument("--uninstall-hook", action="store_true", help="Remove the git hooks only")
    parser.add_argument("--uninstall", action="store_true", help="Take back everything done in --root (hooks, markers, generated file)")
    parser.add_argument("--uninstall-all", action="store_true", help="--uninstall for every repo this script touched")
    parser.add_argument("--anchor", action="store_true", help="Also add a read-the-blueprint hint to the repo's CLAUDE.md / AGENTS.md / ...")
    parser.add_argument("--bootstrap-discovered", action="store_true", help="Discover and install blueprint & hooks across all local git projects")
    parser.add_argument("--check", action="store_true", help="Check if current PROJECT_BLUEPRINT.md is up-to-date")
    parser.add_argument("--quiet", action="store_true", help="Suppress stdout messages")

    args = parser.parse_args()
    if args.uninstall_all:
        return uninstall_all(quiet=args.quiet)
    if args.bootstrap_discovered:
        return bootstrap_discovered_projects(quiet=args.quiet, anchor=args.anchor)
    root = Path(args.root).resolve()
    out_path = Path(args.output).resolve() if args.output else None

    if args.uninstall:
        ok = uninstall_repo(root)
        if not args.quiet:
            print(f"Removed living blueprint & hooks from: {root}" if ok else f"Could not fully clean {root}")
        return 0 if ok else 1

    if args.uninstall_hook:
        ok = uninstall_git_hook(root)
        if not args.quiet:
            print("Git hooks uninstalled.")
        return 0 if ok else 1

    if args.check:
        target = out_path or root / BLUEPRINT_FILE
        if not target.exists():
            if not args.quiet:
                print(f"{target.name} is missing.")
            return 1
        current = target.read_text(encoding="utf-8", errors="ignore")
        if current.strip() != build_blueprint_content(root).strip():
            if not args.quiet:
                print(f"{target.name} is outdated.")
            return 1
        if not args.quiet:
            print(f"{target.name} is up to date.")
        return 0

    ok = True
    if args.install_hook:
        ok = install_git_hook(root)
    if args.anchor:
        ensure_agent_guidance_anchor(root)
    try:
        target, changed = write_blueprint(root, out_path)
    except Exception as e:
        print(f"Failed to generate blueprint for {root}: {e}", file=sys.stderr)
        return 1
    if not args.quiet:
        if args.install_hook:
            print("Git hooks installed." if ok else "Failed to install git hooks.")
        print(f"{'Generated' if changed else 'Unchanged'} living blueprint at: {target}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
