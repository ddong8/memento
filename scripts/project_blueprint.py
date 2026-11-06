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
    """Scan backend routers across Python (FastAPI/Flask), Next.js Route Handlers, Node (Express/Hono), and Go (Gin/Echo)."""
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
                for em in re.finditer(r'@(?:router|app|bp)\.(get|post|put|delete|patch)\(\s*["\']([^"\']*)["\']', content):
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

    # Next.js App Router API Route Handlers (app/api/**/route.ts)
    for app_cand in (root / "apps" / "web" / "src" / "app" / "api", root / "src" / "app" / "api", root / "app" / "api"):
        if app_cand.is_dir():
            for route_file in sorted(app_cand.glob("**/route.[tj]s*")):
                try:
                    rel = route_file.parent.relative_to(app_cand.parent)
                    prefix = f"/{rel}"
                    content = route_file.read_text(encoding="utf-8", errors="ignore")
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
        out: list[Path] = []
        for p in root.glob(pattern):
            if any(ign in p.parts for ign in IGNORED_DIRS):
                continue
            out.append(p)
            if len(out) >= limit:
                break
        return sorted(out)

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
    """Scan core domain service modules and background/scheduled tasks (Celery beat, Cron, etc.)."""
    services: list[dict[str, str]] = []
    schedules: list[dict[str, str]] = []

    # 1. Core service modules
    svc_dirs = [
        root / "server" / "server" / "services",
        root / "src" / "services",
        root / "services",
    ]
    for sdir in svc_dirs:
        if not sdir.is_dir():
            continue
        for f in sorted(sdir.glob("*.py")) + sorted(sdir.glob("*.ts")):
            if f.name.startswith("_") or f.name.endswith(".test.ts"):
                continue
            try:
                text = f.read_text(encoding="utf-8", errors="ignore")
                doc = ""
                dm = re.match(r'^\s*(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')', text)
                if dm:
                    doc = dm.group(1).strip().splitlines()[0].strip()
                else:
                    cm = re.match(r'^\s*(?://+|#+|\*+)\s*(.+)', text)
                    if cm:
                        doc = cm.group(1).strip()
                services.append({
                    "name": f.stem,
                    "path": str(f.relative_to(root)),
                    "summary": _sanitize_blueprint_text(doc[:110]) if doc else "Core domain service module",
                })
            except Exception:
                pass

    # 2. Scheduled background jobs (Celery beat_schedule)
    celery_candidates = [
        root / "server" / "server" / "tasks" / "celery_app.py",
        root / "server" / "tasks" / "celery_app.py",
    ]
    for cfile in celery_candidates:
        if not cfile.exists():
            continue
        try:
            content = cfile.read_text(encoding="utf-8", errors="ignore")
            for bm in re.finditer(
                r'"([a-zA-Z0-9_-]+)"\s*:\s*\{\s*"task"\s*:\s*"([^"]+)"\s*,\s*"schedule"\s*:\s*([^\n]+)',
                content,
            ):
                sched_raw = bm.group(3).rstrip(",").strip()
                schedules.append({
                    "name": bm.group(1),
                    "task": bm.group(2),
                    "schedule": sched_raw,
                })
        except Exception:
            pass

    return {
        "services": services[:35],
        "schedules": schedules[:25],
    }


def scan_mcp_and_ws_protocols(root: Path) -> dict[str, Any]:
    """Scan MCP Server registered tools and WebSocket message event types."""
    mcp_tools: list[dict[str, str]] = []
    ws_events: list[str] = []

    mcp_files = [
        root / "packages" / "mcp" / "src" / "server.ts",
        root / "src" / "mcp" / "server.ts",
    ]
    for mf in mcp_files:
        if not mf.exists():
            continue
        try:
            content = mf.read_text(encoding="utf-8", errors="ignore")
            for tm in re.finditer(
                r'registerTool\(\s*["\']([a-zA-Z0-9_-]+)["\']\s*,\s*\{[\s\S]*?description:\s*\n?\s*["\']([^"\']+)["\']',
                content,
            ):
                mcp_tools.append({
                    "name": tm.group(1),
                    "description": tm.group(2).strip()[:100],
                })
        except Exception:
            pass

    ws_files = [
        root / "packages" / "daemon" / "src" / "ws-client.ts",
        root / "server" / "server" / "api" / "ws.py",
    ]
    for wf in ws_files:
        if not wf.exists():
            continue
        try:
            content = wf.read_text(encoding="utf-8", errors="ignore")
            for cm in re.finditer(r'case\s+["\']([a-zA-Z0-9_]+)["\']\s*:', content):
                ev = cm.group(1)
                if ev not in ws_events:
                    ws_events.append(ev)
            for pm in re.finditer(r'msg_type\s*==\s*["\']([a-zA-Z0-9_]+)["\']', content):
                ev = pm.group(1)
                if ev not in ws_events:
                    ws_events.append(ev)
        except Exception:
            pass

    return {
        "mcp_tools": mcp_tools[:25],
        "ws_events": ws_events[:25],
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
    suite_dirs = [
        ("Backend (pytest)", root / "server" / "tests", "test_*.py"),
        ("Daemon (vitest)", root / "packages" / "daemon" / "test", "*.test.ts"),
        ("Web (vitest)", root / "apps" / "web" / "test", "*.test.ts*"),
        ("Desktop (vitest)", root / "apps" / "desktop" / "test", "*.test.ts*"),
        ("MCP (vitest)", root / "packages" / "mcp" / "test", "*.test.ts"),
    ]
    for label, tdir, pat in suite_dirs:
        if tdir.is_dir():
            files = sorted(f.name for f in tdir.glob(pat))
            if files:
                test_suites.append({
                    "suite": label,
                    "dir": str(tdir.relative_to(root)),
                    "count": len(files),
                    "samples": ", ".join(f"`{n}`" for n in files[:5]),
                })
    return {
        "hotspots": hotspots,
        "test_suites": test_suites,
    }


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
    """Ensure CLAUDE.md / AGENTS.md in the project root has a blueprint reading hint for AI coding agents."""
    guidance_files = [root / "CLAUDE.md", root / "AGENTS.md"]
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


def generate_mermaid_diagram(subsystems: list[dict[str, Any]], stack: dict[str, Any]) -> str:
    """Generate a high-level architectural data flow diagram in Mermaid format."""
    lines = ["```mermaid", "flowchart TD"]

    has_web = any("apps/web" in s["name"] for s in subsystems)
    has_desktop = any("apps/desktop" in s["name"] for s in subsystems)
    has_daemon = any("packages/daemon" in s["name"] for s in subsystems)
    has_mcp = any("packages/mcp" in s["name"] for s in subsystems)
    has_server = any(s["name"] == "server" or "server/" in s["name"] for s in subsystems)
    has_emb = any("embedding" in s["name"] for s in subsystems)

    if not (has_web or has_desktop or has_daemon or has_mcp or has_server):
        # Dynamic architecture graph for general non-Memento repositories
        lines.append('    subgraph Modules["项目核心模块与子系统"]')
        for idx, sub in enumerate(subsystems[:10]):
            safe_label = sub["name"].replace('"', "'")
            lines.append(f'        M{idx}["{safe_label} ({sub["type"]})"]')
        lines.append("    end")
        if len(subsystems) >= 2:
            for idx in range(1, min(len(subsystems), 10)):
                lines.append(f"    M0 --> M{idx}")
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
    cicd_items = scan_cicd_and_deploy(root)
    hot_tests = scan_hotspots_and_tests(root)
    hotspots = hot_tests.get("hotspots", [])
    test_suites = hot_tests.get("test_suites", [])
    env_vars = scan_env_variables(root)
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

    if mcp_tools or ws_events:
        doc.extend([
            "## 6. MCP Tools & Real-Time WebSocket Protocols",
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
        if ws_events:
            doc.append("### WebSocket Control & Data Plane Events")
            doc.append("")
            doc.append(", ".join(f"`{ev}`" for ev in ws_events))
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
# Auto-update PROJECT_BLUEPRINT.md upon commit, merge, or branch checkout (managed by Memento)
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
            ensure_agent_guidance_anchor(root)
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
    if not args.quiet:
        print(f"Generated living blueprint at: {out_path} ({len(content)} bytes)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
