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
    if py_manifests or py_files or (root / "server").is_dir() or (root / "backend").is_dir():
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
    if not stack and (_iter_repo_files(root, "**/*.sh", limit=5) or _iter_repo_files(root, "**/Dockerfile*", limit=5)):
        stack.append("Shell / Container Scripts")

    # 4. Docker / K8s
    if (
        (root / "Dockerfile").exists()
        or (root / "docker-compose.yml").exists()
        or (root / "docker-compose.yaml").exists()
        or _iter_repo_files(root, "**/Dockerfile*", limit=10)
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


def _infer_dir_role_and_desc(d: Path) -> tuple[str, str]:
    """Infer semantic category and human-readable description for a project subdirectory."""
    name_low = d.name.lower()
    role_map = {
        "backend": ("Backend API Service", "Backend API server, domain business logic, and data access layer"),
        "server": ("Backend API Service", "Backend service, HTTP/WebSocket handlers, and persistence"),
        "api": ("API Layer", "REST / RPC API routers and request handlers"),
        "frontend": ("Frontend Web App", "Web frontend user interface, state management, and components"),
        "web": ("Frontend Web App", "Browser web interface and client assets"),
        "client": ("Frontend Client", "Client-side application views and API integration"),
        "desktop": ("Desktop Application", "Cross-platform desktop client application (Electron / Tauri)"),
        "src-tauri": ("Rust Native Core", "Tauri Rust native backend, system tray, and OS integration"),
        "quant": ("Quant Trading Core", "Quantitative strategy execution, market data feed, and order routing"),
        "research": ("Quant Research & Alpha", "Factor mining, backtesting experiments, and quantitative research scripts"),
        "market_data": ("Market Data Pipeline", "Historical and real-time market quote ingestion and storage"),
        "engineio": ("Real-Time Transport", "Socket.IO / Engine.IO bidirectional real-time event transport"),
        "scripts": ("Automation & CLI Scripts", "Data loading, maintenance, operational CLI, and automation utilities"),
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
                    return role, sline[:120]

    for entry in ("main.py", "app.py", "server.py", "__init__.py", "app/main.py", "src/index.ts", "src/main.ts"):
        ep = d / entry
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

    skip_dirs = IGNORED_DIRS | {"backups", "uploads", "templates", "assets", "public", "static"}
    for d in sorted(root.iterdir()):
        if d.is_dir() and d.name not in skip_dirs and not d.name.startswith("."):
            role, desc = _infer_dir_role_and_desc(d)
            subsystems.append({
                "name": d.name,
                "path": d.name,
                "type": role,
                "description": desc,
            })

    for f in sorted(root.iterdir()):
        if f.is_file() and f.suffix in (".py", ".ts", ".js") and not f.name.startswith(("_", "test_")) and f.name not in ("setup.py", "conftest.py") and not f.name.endswith((".config.js", ".config.ts")):
            txt = _read_code(f, 3_000)
            doc = ""
            dm = re.match(r'^(?:#![^\n]*\n)?\s*(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')', txt)
            if dm and dm.group(1).strip():
                doc = dm.group(1).strip().splitlines()[0].strip()
            role = "Backend / Web Entrypoint" if f.stem in ("server", "app", "main", "api") else "Core Engine Module"
            subsystems.append({
                "name": f.name,
                "path": f.name,
                "type": role,
                "description": doc[:110] if doc else f"Root-level {role.lower()} ({f.name})",
            })

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
            prefix = m.group(1) if m else ("/" if name in ("server", "app", "main") else f"/{name}")

            endpoints: list[str] = []
            for em in re.finditer(r'@(?:router|app|bp|api)\.(get|post|put|delete|patch|route|websocket)\(\s*["\']([^"\']*)["\']', content):
                raw_m = em.group(1).upper()
                method = "WS" if raw_m == "WEBSOCKET" else raw_m
                subpath = em.group(2)
                full_p = f"{prefix.rstrip('/')}/{subpath.lstrip('/')}".rstrip('/') or "/"
                endpoints.append(f"`{method} {full_p}`")

            if endpoints:
                routes.append({
                    "name": name,
                    "prefix": prefix,
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
                        "prefix": prefix,
                        "endpoints": endpoints[:5],
                        "total": len(endpoints),
                    })
                except Exception:
                    pass

    # 3. Node/TS Express, Fastify, Hono & NestJS Controllers
    for ts_file in (
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
            content = go_file.read_text(encoding="utf-8", errors="ignore")
            endpoints = []
            for gm in re.finditer(r'\.\s*(GET|POST|PUT|DELETE|PATCH|HandleFunc)\(\s*"([^"]+)"', content):
                m_str = "ANY" if gm.group(1) == "HandleFunc" else gm.group(1)
                endpoints.append(f"`{m_str} {gm.group(2)}`")
            if endpoints:
                routes.append({
                    "name": go_file.stem,
                    "prefix": f"/{go_file.stem}",
                    "endpoints": endpoints[:5],
                    "total": len(endpoints),
                })
        except Exception:
            pass

    # 5. Java / Kotlin Spring Boot (@RestController) & Rust (Axum / Actix)
    for jk_file in _iter_repo_files(root, "**/*Controller.java", limit=25) + _iter_repo_files(root, "**/*Controller.kt", limit=25):
        try:
            content = jk_file.read_text(encoding="utf-8", errors="ignore")
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
                    "prefix": prefix,
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
        dst_entity = dst_raw.upper() if dst_raw.islower() else dst_raw
        src_node = re.sub(r'[^A-Za-z0-9_]', '_', src_entity)
        dst_node = re.sub(r'[^A-Za-z0-9_]', '_', dst_entity)
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
                content = wf.read_text(encoding="utf-8", errors="ignore")
                nm = re.search(r'^name:\s*(.+)$', content, re.MULTILINE)
                wname = nm.group(1).strip().strip("\"'") if nm else wf.stem
                jobs = re.findall(r'^  ([a-zA-Z0-9_-]+):\s*$', content, re.MULTILINE)
                items.append({
                    "kind": "GitHub Actions",
                    "name": wname,
                    "path": str(wf.relative_to(root)),
                    "details": f"Jobs: {', '.join(jobs[:6])}" if jobs else "CI/CD pipeline",
                })
            except Exception:
                pass

    deploy_dir = root / "deploy"
    if deploy_dir.is_dir():
        for ym in sorted(deploy_dir.glob("**/*.y*ml"))[:12]:
            try:
                content = ym.read_text(encoding="utf-8", errors="ignore")
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
            if not p or p in ("PROJECT_BLUEPRINT.md", "deploy/k8s/kustomization.yaml") or p.endswith(".lock") or p.endswith(".json"):
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

    # 1. OpenAPI / Swagger JSON files
    for oa_file in _iter_repo_files(root, "**/*openapi*.json", limit=5) + _iter_repo_files(root, "**/*swagger*.json", limit=5):
        try:
            data = json.loads(oa_file.read_text(encoding="utf-8", errors="ignore"))
            comp_schemas = (data.get("components") or {}).get("schemas") or data.get("definitions") or {}
            for sname, sdef in list(comp_schemas.items())[:15]:
                if isinstance(sdef, dict):
                    props = list((sdef.get("properties") or {}).keys())[:6]
                    schemas.append({
                        "name": sname,
                        "kind": "OpenAPI Schema",
                        "source": str(oa_file.relative_to(root)),
                        "fields": ", ".join(f"`{p}`" for p in props) if props else "object",
                    })
        except Exception:
            pass

    # 2. Python Pydantic Request/Response DTOs ( via AST )
    for py_file in _iter_repo_files(root, "**/api/*.py", limit=30) + _iter_repo_files(root, "**/schemas*.py", limit=20):
        try:
            tree = ast.parse(_read_code(py_file))
            for node in tree.body:
                if isinstance(node, ast.ClassDef):
                    bases = [ast.unparse(b) if hasattr(ast, "unparse") else getattr(b, "id", "") for b in node.bases]
                    if any("BaseModel" in b or "Schema" in b for b in bases):
                        fields = []
                        for stmt in node.body:
                            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and not stmt.target.id.startswith("_"):
                                ftype = ast.unparse(stmt.annotation).replace("|", "\\|") if hasattr(ast, "unparse") and stmt.annotation else ""
                                fields.append(f"{stmt.target.id}: {ftype}" if ftype else stmt.target.id)
                        if fields:
                            schemas.append({
                                "name": node.name,
                                "kind": "Pydantic DTO",
                                "source": str(py_file.relative_to(root)),
                                "fields": ", ".join(f"`{f}`" for f in fields[:6]),
                            })
        except Exception:
            pass

    # 3. TypeScript exported interfaces / Zod schemas
    if len(schemas) < 20:
        for ts_file in _iter_repo_files(root, "**/types*.ts", limit=15) + _iter_repo_files(root, "**/*dto*.ts", limit=15):
            try:
                content = _read_code(ts_file)
                if "interface " in content:
                    for im in re.finditer(r'export\s+interface\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}', content):
                        iname = im.group(1)
                        props = re.findall(r'^\s*([a-zA-Z0-9_]+)\??\s*:', im.group(2), re.MULTILINE)
                        if props:
                            schemas.append({
                                "name": iname,
                                "kind": "TS Interface",
                                "source": str(ts_file.relative_to(root)),
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
            if sf.is_file() and sf.suffix in (".py", ".sh", ".mjs", ".ts", ".js"):
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
                    if not sline.startswith("# ───"):
                        current_comment = _sanitize_blueprint_text(sline.lstrip("#").strip())
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


def ensure_agent_guidance_anchor(root: Path) -> bool:
    """Ensure agent instruction files in the project root have a blueprint reading hint for AI coding agents."""
    guidance_files = [
        root / "CLAUDE.md",
        root / "AGENTS.md",
        root / "GEMINI.md",
        root / ".cursorrules",
        root / ".windsurfrules",
        root / ".clinerules",
        root / ".github" / "copilot-instructions.md",
    ]
    anchor_marker = "<!-- memento:blueprint-anchor -->"
    anchor_snippet = (
        f"{anchor_marker}\n"
        "> [!TIP]\n"
        "> **架构心智指引**：新会话或全局重构前，请优先阅读根目录活体代码蓝图 [PROJECT_BLUEPRINT.md](PROJECT_BLUEPRINT.md) 快速建立全局架构全景，避免昂贵的重复 grep 扫描。\n"
        f"{anchor_marker}\n\n"
    )

    modified = False
    for gf in guidance_files:
        if not gf.exists():
            continue
        try:
            text = gf.read_text(encoding="utf-8", errors="ignore")
            if "PROJECT_BLUEPRINT.md" in text:
                continue
            lines = text.splitlines(keepends=True)
            if lines and lines[0].startswith("#"):
                new_text = lines[0] + "\n" + anchor_snippet + "".join(lines[1:])
            else:
                new_text = anchor_snippet + text
            gf.write_text(new_text, encoding="utf-8")
            modified = True
        except Exception:
            pass
    return modified


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
    git_commit = run_git_cmd(["rev-parse", "--short", "HEAD"], root) or "unknown"
    git_date = run_git_cmd(["log", "-1", "--format=%as"], root) or "recent"

    stack = detect_tech_stack(root)
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
        "> This document provides an instant, comprehensive architectural map of the codebase.",
        "> AI coding agents (Antigravity, Claude Code, Codex, Cursor, etc.) can read this blueprint",
        "> at the start of any session for instant global orientation without repetitive grep scans.",
        "",
        "## 1. Project Overview & Tech Stack",
        "",
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
        "_Auto-maintained by `scripts/project_blueprint.py` & `.git/hooks/(post-commit, post-merge, post-checkout)`. Updates automatically on code modifications, pulls, and branch switches._",
        "",
    ])

    return "\n".join(doc)


HOOK_MARKER_START = "# <<< Memento Blueprint Hook Start >>>"
HOOK_MARKER_END = "# <<< Memento Blueprint Hook End >>>"

HOOK_TEMPLATE = f"""{HOOK_MARKER_START}
# Auto-update PROJECT_BLUEPRINT.md upon commit, merge, rebase, or branch checkout (managed by Memento)
if [ -d ".git/rebase-merge" ] || [ -d ".git/rebase-apply" ]; then
    exit 0
fi

# If invoked as post-checkout, only run on actual branch switch ($3 == 1)
if [ -n "$3" ] && [ "$3" != "1" ]; then
    exit 0
fi

BP_SCRIPT=""
if [ -f "scripts/project_blueprint.py" ]; then
    BP_SCRIPT="scripts/project_blueprint.py"
elif [ -f "$HOME/.memento/scripts/project_blueprint.py" ]; then
    BP_SCRIPT="$HOME/.memento/scripts/project_blueprint.py"
fi

if [ -n "$BP_SCRIPT" ]; then
    HOOK_NAME=$(basename "$0")
    if [ "$HOOK_NAME" = "pre-commit" ]; then
        if git ls-files --error-unmatch PROJECT_BLUEPRINT.md >/dev/null 2>&1; then
            python3 "$BP_SCRIPT" --root . --quiet >/dev/null 2>&1 && git add PROJECT_BLUEPRINT.md >/dev/null 2>&1 || true
        fi
    elif git ls-files --error-unmatch PROJECT_BLUEPRINT.md >/dev/null 2>&1; then
        git rev-parse --short HEAD > .git/.memento_blueprint_head 2>/dev/null || true
    else
        python3 "$BP_SCRIPT" --root . --quiet >/dev/null 2>&1 || true
    fi
fi
{HOOK_MARKER_END}"""


def _record_blueprint_head(root: Path) -> None:
    """Record current git HEAD short SHA into .git/.memento_blueprint_head for staleness detection."""
    git_dir = root / ".git"
    if not git_dir.is_dir():
        return
    try:
        sha = run_git_cmd(["rev-parse", "--short", "HEAD"], root)
        if sha:
            (git_dir / ".memento_blueprint_head").write_text(sha.strip() + "\n", encoding="utf-8")
    except Exception:
        pass


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


MANAGED_GIT_HOOKS = ["pre-commit", "post-commit", "post-merge", "post-checkout", "post-rewrite"]


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


def bootstrap_discovered_projects(quiet: bool = False) -> int:
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

    # 2. Scan top-level git repos under ~/dev and ~/Desktop/dev
    for dev_dir in (home / "dev", home / "Desktop" / "dev"):
        if dev_dir.is_dir():
            for child in dev_dir.iterdir():
                if child.is_dir():
                    if (child / ".git").exists():
                        roots.add(child.resolve())
                    else:
                        for sub in child.iterdir():
                            if sub.is_dir() and (sub / ".git").exists():
                                roots.add(sub.resolve())

    count = 0
    for r in sorted(roots):
        try:
            install_git_hook(r)
            ensure_agent_guidance_anchor(r)
            content = build_blueprint_content(r)
            (r / "PROJECT_BLUEPRINT.md").write_text(content, encoding="utf-8")
            _record_blueprint_head(r)
            count += 1
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
    parser.add_argument("--install-hook", action="store_true", help="Install git post-commit hook for auto-syncing")
    parser.add_argument("--uninstall-hook", action="store_true", help="Uninstall git post-commit hook")
    parser.add_argument("--bootstrap-discovered", action="store_true", help="Discover and install blueprint & hooks across all local git projects")
    parser.add_argument("--check", action="store_true", help="Check if current PROJECT_BLUEPRINT.md is up-to-date")
    parser.add_argument("--quiet", action="store_true", help="Suppress stdout messages")

    args = parser.parse_args()
    if args.bootstrap_discovered:
        return bootstrap_discovered_projects(quiet=args.quiet)
    root = Path(args.root).resolve()

    if args.install_hook:
        ok = install_git_hook(root)
        try:
            ensure_agent_guidance_anchor(root)
            out_path = Path(args.output).resolve() if args.output else root / "PROJECT_BLUEPRINT.md"
            content = build_blueprint_content(root)
            out_path.write_text(content, encoding="utf-8")
            _record_blueprint_head(root)
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
    ensure_agent_guidance_anchor(root)

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
    _record_blueprint_head(root)
    if not args.quiet:
        print(f"Generated living blueprint at: {out_path} ({len(content)} bytes)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
