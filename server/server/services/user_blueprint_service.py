"""User Living Blueprint Service (个人全域认知与能力蓝图生成器)

Applies the same architectural philosophy as `PROJECT_BLUEPRINT.md` to the USER:
synthesizes all of the user's Project Blueprints (`PROJECT_BLUEPRINT.md`),
Resident Profile rules (`UserProfile`), Long-Term Memories (`UserMemory`),
Knowledge Graph entities (`KnowledgeEntity`), and active devices (`Machine`)
into a structured, auto-updating `USER_BLUEPRINT.md` covering:

  1. 学科交叉与专业背景 (Academic & Scientific Disciplines)
  2. 核心业务版图与场景 (Business Domains & Scenarios)
  3. 跨项目架构蓝图矩阵 (Project Blueprint Portfolio)
  4. 全域技术栈与工程底座雷达 (Technology & Infrastructure Radar)
  5. 个人全域认知拓扑图 (Mermaid Flowchart Topology)
  6. 工程哲学与核心准则摘要 (Engineering Philosophy & Tenets)
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import logging
from pathlib import Path
import re
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, KnowledgeEntity, Machine, Project, User, UserMemory
from .cache import cache_get, cache_set
from .profile_service import get_published_profile, split_profile_scopes

logger = logging.getLogger("server.user_blueprint_service")


# ---------------------------------------------------------------------------
# Taxonomy definitions for deterministic + evidence-driven classification
# ---------------------------------------------------------------------------

DISCIPLINE_RULES: list[dict[str, Any]] = [
    {
        "id": "cs_distributed",
        "name": "计算机科学与分布式系统",
        "en_name": "Computer Science & Distributed Systems",
        "keywords": [
            "fastapi", "typescript", "electron", "react", "nextjs", "postgresql", "redis",
            "kubernetes", "k8s", "docker", "websocket", "webrtc", "ast", "compiler", "daemon",
            "microservice", "celery", "sqlalchemy", "并发", "流式", "缓存", "容器化", "零停机",
        ],
        "description": "全栈系统工程、高并发流式架构、AST 静态代码分析、分布式状态同步与云原生容器编排",
    },
    {
        "id": "ai_cognitive",
        "name": "人工智能与多智能体认知科学",
        "en_name": "AI & Multi-Agent Cognitive Computing",
        "keywords": [
            "llm", "agent", "mcp", "claude", "codex", "antigravity", "gemini", "openai",
            "embedding", "bge-m3", "pgvector", "rag", "knowledge graph", "知识图谱", "向量检索",
            "大模型", "智能体", "数字孪生", "心领神会", "orchestrator", "modelscope", "oneapi",
        ],
        "description": "多智能体协同编排（MCP/A2A）、长期记忆与知识图谱构建、神经符号护栏与个人数字孪生自进化",
    },
    {
        "id": "cheminformatics",
        "name": "化学信息学与有机合成化学",
        "en_name": "Cheminformatics & Organic Retrosynthesis",
        "keywords": [
            "pubchem", "reaxys", "smiles", "cas", "rxn", "rxnsearch", "retrosynthesis",
            "逆合成", "化合物", "分子", "化学", "反应式", "格式试剂", "原料", "单步复核",
            "路线标注", "有机合成", "rdkit", "aiphacas",
        ],
        "description": "分子表征（SMILES/CAS）、计算机辅助逆合成路线规划（CASP）、化学反应分类与实验条件标准化",
    },
    {
        "id": "quant_finance",
        "name": "量化金融与金融工程",
        "en_name": "Quantitative Finance & Algorithmic Trading",
        "keywords": [
            "quant", "quant_future", "future", "trading", "algo-trading", "backtest",
            "strategy", "portfolio", "market-data", "tick", "kline", "ctp", "期货",
            "量化", "策略", "回测", "实盘", "风控", "持仓", "行情",
        ],
        "description": "期货与衍生品算法交易、高频行情接入、量化策略研发回测、组合持仓管理与实时风险控制",
    },
    {
        "id": "data_engineering",
        "name": "数据科学与知识工程",
        "en_name": "Data Engineering & Knowledge Mining",
        "keywords": [
            "scraper", "crawler", "etl", "pipeline", "dataset", "annotation", "dedup",
            "清洗", "去重", "唯一性口径", "统计口径", "数据抓取", "数据集", "标注", "溯源",
        ],
        "description": "大规模多源异构数据采集、实体对齐与去重归一化、可溯源数据资产治理与高质量语料构建",
    },
]

BUSINESS_DOMAIN_RULES: list[dict[str, Any]] = [
    {
        "id": "ai_memory_platform",
        "name": "全端 AI 记忆中枢与多智能体协同平台",
        "keywords": ["memento", "workbuddy", "claude", "codex", "antigravity", "mcp", "daemon", "心领神会", "数字孪生", "openclaw"],
        "project_keywords": ["memento", "workbuddy", "openclaw", "mcp", "agent"],
        "discipline_id": "ai_cognitive",
        "scenarios": "跨设备采集研发会话、沉淀长期记忆与活体代码蓝图、统一调度多机 AI 编程智能体协同作业",
    },
    {
        "id": "ai_chemistry_retrosynthesis",
        "name": "AI 化学逆合成规划与分子情报系统",
        "keywords": ["pubchem", "aiphacas", "reaxys", "smiles", "cas", "逆合成", "rxnsearch", "化合物", "路线标注"],
        "project_keywords": ["pubchem", "chem", "rxn", "reaxys", "smiles", "aiphacas"],
        "discipline_id": "cheminformatics",
        "scenarios": "化合物结构检索、AI 驱动的有机逆合成路线生成与重排、单步反应复核、实验条件与操作步骤生成",
    },
    {
        "id": "quant_trading_system",
        "name": "期货量化交易与策略研发平台",
        "keywords": ["quant_future", "quant", "algo-trading", "backtest", "strategy", "market-data", "期货", "量化", "tqsdk"],
        "project_keywords": ["quant", "tqsdk", "future", "backtest", "market-maker", "trading"],
        "discipline_id": "quant_finance",
        "scenarios": "期货行情实时订阅、量化交易策略回测与参数寻优、账户持仓监控、算法拆单执行与全链路风控",
    },
    {
        "id": "cloud_native_infra",
        "name": "云原生算力底座与研发工具链基础设施",
        "keywords": ["workspaces-images", "k8s", "kubernetes", "harbor", "docker", "oneapi", "modelscope", "devops", "kasmvnc"],
        "project_keywords": ["workspaces", "images", "kasmvnc", "docker", "k8s", "infra", "memento"],
        "discipline_id": "cs_distributed",
        "scenarios": "容器化开发环境镜像构建、K8s 零停机持续交付、内网 Harbor 镜像治理与多模型网关统一接入",
    },
    {
        "id": "content_social_automation",
        "name": "智能内容创作与多端应用生态",
        "keywords": ["wechat-publisher", "favorite_chat", "iptv", "公众号", "草稿", "润色", "工作台", "chat", "messaging"],
        "project_keywords": ["wechat", "publisher", "favorite", "chat", "iptv"],
        "discipline_id": "data_engineering",
        "scenarios": "多模态富媒体会话交互、工作台文档多次润色编辑、一键发布公众号草稿与跨端流媒体应用",
    },
]

TECH_RADAR_CATEGORIES: dict[str, tuple[str, list[tuple[str, list[str]]]]] = {
    "languages": (
        "编程语言 (Languages)",
        [
            ("Python", ["python", "pyproject.toml", "fastapi", "pytest", "sqlalchemy", "uv"]),
            ("TypeScript / JavaScript", ["typescript", "ts", "tsx", "nodejs", "node.js", "javascript", "esbuild"]),
            ("SQL", ["postgresql", "postgres", "sql", "pgvector", "sqlite"]),
            ("Shell / Bash", ["bash", "zsh", "sh", "shell"]),
            ("Go / Rust", ["golang", "cargo", "rust"]),
        ],
    ),
    "frontend_desktop": (
        "前端与桌面端 (Frontend & Desktop)",
        [
            ("React / Next.js", ["react", "next.js", "nextjs", "tsx"]),
            ("Electron", ["electron", "electron-builder", "asar"]),
            ("Tailwind CSS", ["tailwind", "tailwindcss"]),
            ("Three.js / WebGL", ["three", "webgl", "3d"]),
            ("Mermaid / 可视化", ["mermaid", "echarts", "chart"]),
        ],
    ),
    "backend_api": (
        "后端与通信协议 (Backend & Protocols)",
        [
            ("FastAPI / Uvicorn", ["fastapi", "uvicorn", "pydantic", "starlette"]),
            ("SQLAlchemy / Alembic", ["sqlalchemy", "alembic", "asyncpg"]),
            ("Celery / 异步任务", ["celery", " asyncio", "background"]),
            ("WebSocket / WebRTC", ["websocket", "ws", "webrtc", "node-datachannel", "sse"]),
            ("REST / OpenAPI / RPC", ["openapi", "rest", "grpc", "graphql"]),
        ],
    ),
    "data_storage": (
        "数据存储与检索 (Data & Storage)",
        [
            ("PostgreSQL + pgvector", ["postgresql", "postgres", "pgvector"]),
            ("Redis (Cache & Broker)", ["redis", "ioredis"]),
            ("MinIO / S3 对象存储", ["minio", "s3", "boto3"]),
            ("全文检索与知识图谱", ["tsvector", "fts", "knowledge_graph", "知识图谱"]),
        ],
    ),
    "ai_agent": (
        "AI 与智能体生态 (AI & Agent Stack)",
        [
            ("Claude Code / Anthropic", ["claude", "anthropic", "claude_code"]),
            ("Antigravity / Gemini", ["antigravity", "gemini", "agy"]),
            ("OpenAI / Codex", ["codex", "openai", "gpt"]),
            ("MCP (Model Context Protocol)", ["mcp", "modelcontextprotocol", "memento-memory"]),
            ("BGE-M3 / 向量重排", ["bge-m3", "embedding", "modelscope", "oneapi"]),
        ],
    ),
    "devops_infra": (
        "云原生与工程效能 (Cloud Native & DevOps)",
        [
            ("Docker / Compose", ["docker", "dockerfile", "docker-compose"]),
            ("Kubernetes (K8s / K3s)", ["k8s", "kubernetes", "kustomization", "pod", "harbor"]),
            ("Git Hooks & AST 分析", ["git", "post-commit", "project_blueprint", "ast"]),
            ("Pytest / Vitest / Ruff", ["pytest", "vitest", "ruff", "ci/cd"]),
        ],
    ),
}


def _parse_project_blueprint_markdown(md: str) -> dict[str, Any]:
    """Extract structured summary metrics from a PROJECT_BLUEPRINT.md document."""
    info: dict[str, Any] = {
        "tech_stack": [],
        "subsystems_count": 0,
        "models_count": 0,
        "routes_count": 0,
        "subsystems_preview": [],
        "branch": "",
    }
    if not md:
        return info

    for line in md.splitlines():
        s = line.strip()
        if any(
            s.startswith(prefix)
            for prefix in (
                "- **Core Languages**:",
                "- **Key Frameworks**:",
                "- **Infrastructure & Middleware**:",
                "- **Languages**:",
                "- **Frameworks & Libraries**:",
                "- **Infrastructure & Tooling**:",
            )
        ):
            val = s.split(":", 1)[-1].strip()
            for token in val.split(","):
                clean = token.strip().strip("`")
                if clean and clean.lower() != "none" and clean not in info["tech_stack"]:
                    info["tech_stack"].append(clean)
        elif "Branch:" in s or "**Active Branch**:" in s:
            m = re.search(r"Branch\*?\*?:\s*`([^`]+)`", s)
            if m:
                info["branch"] = m.group(1)

    # Count table rows in Subsystems (## 3.), Data Models (## 5.), and API Surface (## 6.)
    current_sec = ""
    for line in md.splitlines():
        s = line.strip()
        if "Subsystem Breakdown" in s or s.startswith("## 3."):
            current_sec = "subsystems"
            continue
        elif "Data Models" in s or s.startswith("## 5."):
            current_sec = "models"
            continue
        elif "API Surface" in s or s.startswith("## 6."):
            current_sec = "routes"
            continue
        elif s.startswith("## "):
            current_sec = ""
            continue

        if current_sec == "subsystems" and s.startswith("|") and ("`" in s):
            if "Subsystem / Path" in s or ":---" in s:
                continue
            info["subsystems_count"] += 1
            parts = [p.strip() for p in s.strip("|").split("|")]
            if len(parts) >= 3 and len(info["subsystems_preview"]) < 4:
                m_mod = re.search(r"`([^`]+)`", parts[0])
                mod_name = m_mod.group(1) if m_mod else parts[0]
                resp = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", parts[2]).strip("` ")
                info["subsystems_preview"].append(f"{mod_name} ({resp[:42]})")
        elif current_sec == "models" and s.startswith("| `"):
            info["models_count"] += 1
        elif current_sec == "routes" and s.startswith("| `"):
            info["routes_count"] += 1

    return info


def _scan_local_blueprints() -> dict[str, tuple[str, str]]:
    """Scan common local workspace directories for PROJECT_BLUEPRINT.md files.
    Returns mapping of normalized_project_name -> (project_path, markdown_content).
    """
    found: dict[str, tuple[str, str]] = {}
    home = Path.home()
    search_roots = [home / "dev", home / "Desktop" / "dev", home / "WorkBuddy"]
    for base in search_roots:
        if not base.is_dir():
            continue
        try:
            for child in base.iterdir():
                if not child.is_dir():
                    continue
                bp = child / "PROJECT_BLUEPRINT.md"
                if bp.is_file():
                    try:
                        found[child.name.lower()] = (str(child), bp.read_text(encoding="utf-8", errors="ignore"))
                    except Exception:
                        pass
                else:
                    for sub in child.iterdir():
                        if sub.is_dir() and (sub / "PROJECT_BLUEPRINT.md").is_file():
                            try:
                                found[sub.name.lower()] = (
                                    str(sub),
                                    (sub / "PROJECT_BLUEPRINT.md").read_text(encoding="utf-8", errors="ignore"),
                                )
                            except Exception:
                                pass
        except Exception:
            pass
    return found


def _sanitize_mermaid_id(raw: str, prefix: str = "N") -> str:
    clean = re.sub(r"[^a-zA-Z0-9_]", "_", raw)
    clean = re.sub(r"_+", "_", clean).strip("_")
    return f"{prefix}_{clean}" if clean else f"{prefix}_node"


def _build_user_mermaid_topology(
    user_name: str,
    disciplines: list[dict[str, Any]],
    domains: list[dict[str, Any]],
    projects: list[dict[str, Any]],
    tech_radar: dict[str, dict[str, Any]],
) -> str:
    """Generate a valid Mermaid flowchart LR visualizing the user's cross-disciplinary & project blueprint."""
    lines = [
        "```mermaid",
        "flowchart LR",
        f'    USER["{user_name} · 数字孪生全域蓝图"]',
    ]

    if disciplines:
        lines.append('    subgraph DISC["学科交叉 (Disciplines)"]')
        for d in disciplines[:5]:
            did = _sanitize_mermaid_id(d["id"], "D")
            lines.append(f'        {did}["{d["name"]}"]')
        lines.append("    end")
        for d in disciplines[:5]:
            did = _sanitize_mermaid_id(d["id"], "D")
            lines.append(f"    USER --> {did}")

    if domains:
        lines.append('    subgraph DOM["核心业务版图 (Business Domains)"]')
        for b in domains[:5]:
            bid = _sanitize_mermaid_id(b["id"], "B")
            lines.append(f'        {bid}["{b["name"]}"]')
        lines.append("    end")
        disc_ids = {d["id"]: _sanitize_mermaid_id(d["id"], "D") for d in disciplines[:5]}
        for idx, b in enumerate(domains[:5]):
            bid = _sanitize_mermaid_id(b["id"], "B")
            target_disc_id = b.get("discipline_id")
            if target_disc_id and target_disc_id in disc_ids:
                lines.append(f"    {disc_ids[target_disc_id]} --> {bid}")
            elif disciplines:
                did = _sanitize_mermaid_id(disciplines[min(idx, len(disciplines) - 1)]["id"], "D")
                lines.append(f"    {did} --> {bid}")
            else:
                lines.append(f"    USER --> {bid}")

    if projects:
        lines.append('    subgraph PROJ["核心工程项目 (Project Blueprints)"]')
        for p in projects[:8]:
            pid = _sanitize_mermaid_id(p["name"], "P")
            stack_hint = ", ".join(p.get("tech_stack", [])[:2])
            label = f'{p["name"]} ({stack_hint})' if stack_hint else p["name"]
            lines.append(f'        {pid}["{label}"]')
        lines.append("    end")

        # Link domains to matching projects
        linked_projects: set[str] = set()
        for b in domains[:5]:
            bid = _sanitize_mermaid_id(b["id"], "B")
            for pname in b.get("projects", [])[:4]:
                pid = _sanitize_mermaid_id(pname, "P")
                if any(_sanitize_mermaid_id(p["name"], "P") == pid for p in projects[:8]):
                    lines.append(f"    {bid} --> {pid}")
                    linked_projects.add(pid)

        for p in projects[:8]:
            pid = _sanitize_mermaid_id(p["name"], "P")
            if pid not in linked_projects:
                fallback_src = _sanitize_mermaid_id(domains[0]["id"], "B") if domains else "USER"
                lines.append(f"    {fallback_src} --> {pid}")

    # Top tech stack summary nodes
    top_tech: list[tuple[str, str]] = []
    for cat_key, cat_val in tech_radar.items():
        items = cat_val.get("items", [])
        if items:
            top_tech.append((cat_key, f'{cat_val["label"].split(" ")[0]}: {", ".join(items[:3])}'))
    if top_tech and projects:
        lines.append('    subgraph TECH["全域技术底座 (Tech & Infra)"]')
        for tkey, tlabel in top_tech[:4]:
            tid = _sanitize_mermaid_id(tkey, "T")
            lines.append(f'        {tid}["{tlabel}"]')
        lines.append("    end")
        lead_pid = _sanitize_mermaid_id(projects[0]["name"], "P")
        for tkey, _ in top_tech[:4]:
            tid = _sanitize_mermaid_id(tkey, "T")
            lines.append(f"    {lead_pid} -.-> {tid}")

    lines.append("```")
    return "\n".join(lines)


def _render_user_blueprint_markdown(
    user_name: str,
    disciplines: list[dict[str, Any]],
    domains: list[dict[str, Any]],
    projects: list[dict[str, Any]],
    tech_radar: dict[str, dict[str, Any]],
    philosophy: dict[str, list[str]],
    devices: list[dict[str, Any]],
    mermaid_topology: str,
) -> str:
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines: list[str] = [
        f"# User Cognitive & Domain Blueprint: {user_name}",
        "",
        f"> **Auto-Generated Living User Blueprint** · **Updated**: `{now_str}` · **Projects Indexed**: `{len(projects)}` · **Disciplines**: `{len(disciplines)}` · **Business Domains**: `{len(domains)}`",
        "> *Synthesized automatically from cross-project `PROJECT_BLUEPRINT.md` files, Knowledge Graph entities, Long-Term Memories, and Resident Persona rules.*",
        "",
        "---",
        "",
        "## 1. 全域认知与能力拓扑 (Cognitive & Domain Topology)",
        "",
        mermaid_topology,
        "",
        "## 2. 学科交叉与专业领域 (Academic & Scientific Disciplines)",
        "",
        "| 学科领域 (Discipline) | 专业方向与核心内涵 (Scope & Focus) | 关联项目 (Projects) | 核心特征词 (Evidence) |",
        "| :--- | :--- | :--- | :--- |",
    ]

    for d in disciplines:
        projs = ", ".join(f"`{p}`" for p in d.get("projects", [])[:5]) or "-"
        ev = ", ".join(f"`{k}`" for k in d.get("evidence", [])[:6]) or "-"
        lines.append(f'| **{d["name"]}**<br/>*{d["en_name"]}* | {d["description"]} | {projs} | {ev} |')

    lines.extend([
        "",
        "## 3. 核心业务版图与应用场景 (Business Domains & Scenarios)",
        "",
        "| 业务板块 (Business Domain) | 核心业务场景与价值闭环 (Core Scenarios) | 承载项目 (Projects) |",
        "| :--- | :--- | :--- |",
    ])

    for b in domains:
        projs = ", ".join(f"`{p}`" for p in b.get("projects", [])[:6]) or "-"
        lines.append(f'| **{b["name"]}** | {b["scenarios"]} | {projs} |')

    lines.extend([
        "",
        "## 4. 跨项目架构蓝图矩阵 (Project Blueprint Portfolio)",
        "",
        "| 项目名称 (Project) | 核心技术栈 (Tech Stack) | 架构规模 (Subsystems / Models / Routes) | 核心子系统与职责摘要 (Architecture Summary) |",
        "| :--- | :--- | :--- | :--- |",
    ])

    for p in projects:
        stack_str = ", ".join(f"`{t}`" for t in p.get("tech_stack", [])[:6]) or "-"
        scale_str = f'{p.get("subsystems_count", 0)} 模块 / {p.get("models_count", 0)} 表 / {p.get("routes_count", 0)} 路由'
        summary_str = "; ".join(p.get("subsystems_preview", [])[:3]) or p.get("summary") or "-"
        lines.append(f'| **`{p["name"]}`** | {stack_str} | `{scale_str}` | {summary_str} |')

    lines.extend([
        "",
        "## 5. 全域技术栈与基础设施雷达 (Technology & Infrastructure Radar)",
        "",
        "| 技术维度 (Dimension) | 已验证掌握与高频使用的技术栈 (Verified Technologies) |",
        "| :--- | :--- |",
    ])

    for cat_val in tech_radar.values():
        items = cat_val.get("items", [])
        if items:
            tech_badges = ", ".join(f"`{it}`" for it in items)
            lines.append(f'| **{cat_val["label"]}** | {tech_badges} |')

    lines.extend([
        "",
        "## 6. 工程哲学与核心协作准则 (Engineering Philosophy & Tenets)",
        "",
    ])

    for sec_title, sec_items in philosophy.items():
        if sec_items:
            lines.append(f"### {sec_title}")
            for item in sec_items[:6]:
                lines.append(f"- {item}")
            lines.append("")

    if devices:
        lines.extend([
            "## 7. 算力终端与工作空间拓扑 (Active Compute Nodes)",
            "",
            "| 终端名称 (Device) | 平台 (Platform) | 状态 (Status) |",
            "| :--- | :--- | :--- |",
        ])
        for dev in devices:
            status_label = "在线 (Online)" if dev.get("online") else "离线 (Offline)"
            lines.append(f'| `{dev.get("name", "unknown")}` | `{dev.get("platform", "unknown")}` | {status_label} |')
        lines.append("")

    return "\n".join(lines).strip() + "\n"


async def build_user_blueprint(
    db: AsyncSession,
    user: User,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Synthesize the complete User Cognitive & Domain Blueprint (`USER_BLUEPRINT.md`)."""
    cache_key = f"user:blueprint:v1:{user.id}"
    if not force_refresh:
        try:
            cached = await cache_get(cache_key)
            if isinstance(cached, dict) and cached.get("markdown"):
                return cached
        except Exception:
            pass

    user_name = getattr(user, "name", None) or getattr(user, "email", None) or "Developer"

    # 1. Fetch user's machines, projects, blueprint docs, profile, memories, and knowledge entities
    machines: list[Machine] = []
    projects_db: list[Project] = []
    bp_docs: list[Document] = []
    memories: list[UserMemory] = []
    entities: list[KnowledgeEntity] = []
    published_profile = None

    try:
        machines = list((await db.execute(
            select(Machine).where(
                Machine.user_id == user.id,
                Machine.merged_into.is_(None),
                Machine.is_archived.is_(False),
            )
        )).scalars().all())
    except Exception:
        pass

    machine_ids = [m.id for m in machines]

    try:
        proj_q = select(Project).order_by(Project.created_at.desc()).limit(100)
        projects_db = list((await db.execute(proj_q)).scalars().all())
    except Exception:
        pass

    try:
        bp_q = (
            select(Document)
            .where(Document.relative_path.ilike("%PROJECT_BLUEPRINT.md"))
            .order_by(Document.synced_at.desc())
            .limit(50)
        )
        if machine_ids:
            bp_q = bp_q.where(or_(Document.machine_id.in_(machine_ids), Document.machine_id.is_(None)))
        bp_docs = list((await db.execute(bp_q)).scalars().all())
    except Exception:
        pass

    try:
        published_profile = await get_published_profile(db, user)
    except Exception:
        pass

    try:
        mem_q = (
            select(UserMemory)
            .where(UserMemory.user_id == user.id, UserMemory.is_active.is_(True))
            .order_by(UserMemory.importance.desc())
            .limit(100)
        )
        memories = list((await db.execute(mem_q)).scalars().all())
    except Exception:
        pass

    try:
        ent_q = (
            select(KnowledgeEntity)
            .where(KnowledgeEntity.user_id == user.id)
            .order_by(KnowledgeEntity.mention_count.desc())
            .limit(80)
        )
        entities = list((await db.execute(ent_q)).scalars().all())
    except Exception:
        pass

    # 2. Merge local filesystem PROJECT_BLUEPRINT.md files with DB-synced PROJECT_BLUEPRINT.md docs
    local_bps = _scan_local_blueprints()
    project_map: dict[str, dict[str, Any]] = {}

    # Seed from DB blueprint docs first
    for doc in bp_docs:
        rel = getattr(doc, "relative_path", None)
        if not isinstance(rel, str) or not rel:
            continue
        pname = rel.split("/")[0].strip() if "/" in rel else ""
        if not pname or pname.startswith("."):
            continue
        key = pname.lower()
        doc_content = getattr(doc, "content", None)
        if key not in project_map and isinstance(doc_content, str) and doc_content:
            parsed = _parse_project_blueprint_markdown(doc_content)
            meta = getattr(doc, "metadata_", None)
            project_map[key] = {
                "name": pname,
                "path": meta.get("project_path", "") if isinstance(meta, dict) else "",
                **parsed,
                "raw_excerpt": doc_content[:3000],
            }

    # Enrich/override with fresh local filesystem blueprints if present
    for key, (p_path, md_content) in local_bps.items():
        pname = Path(p_path).name
        if pname.startswith(".") or "worktree" in key:
            continue
        parsed = _parse_project_blueprint_markdown(md_content)
        project_map[key] = {
            "name": pname,
            "path": p_path,
            **parsed,
            "raw_excerpt": md_content[:3000],
        }

    # Also include scoped projects from published profile and DB projects if not yet in project_map
    raw_prof_content = getattr(published_profile, "content", None) if published_profile else None
    profile_text = raw_prof_content if isinstance(raw_prof_content, str) else ""
    if not profile_text:
        for pf in (Path.home() / ".claude" / "CLAUDE.md", Path.home() / ".codex" / "AGENTS.md"):
            if pf.is_file():
                try:
                    profile_text = pf.read_text(encoding="utf-8", errors="ignore")
                    break
                except Exception:
                    pass
    scopes = split_profile_scopes(profile_text) if profile_text else None
    if scopes:
        for scoped_proj, scoped_lines in scopes.projects.items():
            key = scoped_proj.lower().strip()
            if key not in project_map:
                project_map[key] = {
                    "name": scoped_proj,
                    "path": "",
                    "tech_stack": [],
                    "subsystems_count": 0,
                    "models_count": 0,
                    "routes_count": 0,
                    "subsystems_preview": [line.lstrip("-* ").strip()[:48] for line in scoped_lines[:2]],
                    "branch": "main",
                    "raw_excerpt": "\n".join(scoped_lines),
                }
            else:
                project_map[key]["raw_excerpt"] = (
                    project_map[key].get("raw_excerpt", "") + "\n" + "\n".join(scoped_lines)
                )

    for p in projects_db:
        raw_title = getattr(p, "title", None) or getattr(p, "slug", None)
        if not isinstance(raw_title, str):
            continue
        title = raw_title.strip()
        if not title or title.startswith(".") or "worktree" in title.lower():
            continue
        key = title.lower()
        if key not in project_map and len(project_map) < 20:
            src_path = getattr(p, "source_path", None)
            project_map[key] = {
                "name": title,
                "path": src_path if isinstance(src_path, str) else "",
                "tech_stack": [],
                "subsystems_count": 0,
                "models_count": 0,
                "routes_count": 0,
                "subsystems_preview": [],
                "branch": "",
                "raw_excerpt": title,
            }

    projects_list = sorted(
        project_map.values(),
        key=lambda x: (
            x.get("subsystems_count", 0) + x.get("models_count", 0) + x.get("routes_count", 0),
            len(x.get("tech_stack", [])),
        ),
        reverse=True,
    )[:15]

    # Build combined corpus for discipline, business domain, and tech radar extraction
    corpus_parts: list[str] = [profile_text]
    for m in memories:
        mc = getattr(m, "content", None)
        if isinstance(mc, str) and mc:
            corpus_parts.append(mc)
    for e in entities:
        en = getattr(e, "name", None)
        et = getattr(e, "entity_type", None)
        if isinstance(en, str) and en:
            corpus_parts.append(f"{en} {et if isinstance(et, str) else ''}")
    for p in projects_list:
        corpus_parts.append(p.get("name", ""))
        corpus_parts.append(" ".join(p.get("tech_stack", [])))
        corpus_parts.append(p.get("raw_excerpt", ""))

    full_corpus_lower = "\n".join(corpus_parts).lower()

    # 3. Infer Academic & Scientific Disciplines
    disciplines: list[dict[str, Any]] = []
    for rule in DISCIPLINE_RULES:
        matched_kw = [kw for kw in rule["keywords"] if kw.lower() in full_corpus_lower]
        if matched_kw:
            matched_projs = [
                p["name"]
                for p in projects_list
                if any(
                    kw.lower()
                    in (p["name"] + " " + " ".join(p.get("tech_stack", [])) + " " + p.get("raw_excerpt", "")).lower()
                    for kw in rule["keywords"]
                )
            ]
            disciplines.append({
                "id": rule["id"],
                "name": rule["name"],
                "en_name": rule["en_name"],
                "description": rule["description"],
                "evidence": matched_kw[:8],
                "projects": matched_projs[:6],
                "score": len(matched_kw),
            })
    disciplines.sort(key=lambda d: d["score"], reverse=True)

    # 4. Infer Business Domains
    domains: list[dict[str, Any]] = []
    for b_rule in BUSINESS_DOMAIN_RULES:
        matched_kw = [kw for kw in b_rule["keywords"] if kw.lower() in full_corpus_lower]
        if matched_kw:
            p_kws = b_rule.get("project_keywords", b_rule["keywords"])
            matched_projs = [
                p["name"]
                for p in projects_list
                if any(
                    kw.lower()
                    in (p["name"] + " " + " ".join(p.get("subsystems_preview", []))).lower()
                    for kw in p_kws
                )
            ]
            domains.append({
                "id": b_rule["id"],
                "name": b_rule["name"],
                "discipline_id": b_rule.get("discipline_id", ""),
                "scenarios": b_rule["scenarios"],
                "projects": matched_projs[:6],
                "evidence": matched_kw[:6],
                "score": len(matched_kw),
            })
    domains.sort(key=lambda b: b["score"], reverse=True)

    # 5. Build Technology & Infrastructure Radar
    tech_radar: dict[str, dict[str, Any]] = {}
    for cat_id, (cat_label, tech_defs) in TECH_RADAR_CATEGORIES.items():
        matched_items: list[str] = []
        for tech_name, tokens in tech_defs:
            if any(tok.lower() in full_corpus_lower for tok in tokens):
                matched_items.append(tech_name)
        tech_radar[cat_id] = {
            "label": cat_label,
            "items": matched_items,
        }

    # 6. Extract Engineering Philosophy from Resident Profile
    philosophy: dict[str, list[str]] = {
        "核心铁律与工程底线": [],
        "架构与技术偏好": [],
        "工作流与交付准则": [],
    }
    if scopes and scopes.general:
        cur_heading = ""
        for line in scopes.general.splitlines():
            s = line.strip()
            if s.startswith("### "):
                cur_heading = s.lstrip("# ").strip()
            elif s.startswith("- "):
                rule_text = s[2:].strip()
                if "铁律" in cur_heading:
                    philosophy["核心铁律与工程底线"].append(rule_text)
                elif "技术" in cur_heading:
                    philosophy["架构与技术偏好"].append(rule_text)
                elif "工作" in cur_heading or "沟通" in cur_heading:
                    philosophy["工作流与交付准则"].append(rule_text)

    # Clean project list for output (strip raw_excerpt)
    clean_projects = [
        {
            "name": p["name"],
            "path": p.get("path", ""),
            "tech_stack": p.get("tech_stack", []),
            "subsystems_count": p.get("subsystems_count", 0),
            "models_count": p.get("models_count", 0),
            "routes_count": p.get("routes_count", 0),
            "subsystems_preview": p.get("subsystems_preview", []),
            "branch": p.get("branch", ""),
        }
        for p in projects_list
    ]

    now = datetime.now(timezone.utc)
    devices_summary = [
        {
            "name": m.name,
            "platform": m.platform or "unknown",
            "online": bool(m.last_heartbeat and (now - m.last_heartbeat).total_seconds() < 180),
        }
        for m in machines
    ]

    mermaid_topology = _build_user_mermaid_topology(
        user_name=user_name,
        disciplines=disciplines,
        domains=domains,
        projects=clean_projects,
        tech_radar=tech_radar,
    )

    markdown = _render_user_blueprint_markdown(
        user_name=user_name,
        disciplines=disciplines,
        domains=domains,
        projects=clean_projects,
        tech_radar=tech_radar,
        philosophy=philosophy,
        devices=devices_summary,
        mermaid_topology=mermaid_topology,
    )

    bp_hash = hashlib.sha256(markdown.encode("utf-8")).hexdigest()[:16]

    result = {
        "user_name": user_name,
        "hash": bp_hash,
        "generated_at": now.isoformat(),
        "disciplines": disciplines,
        "business_domains": domains,
        "projects": clean_projects,
        "tech_radar": tech_radar,
        "philosophy": philosophy,
        "devices": devices_summary,
        "mermaid_topology": mermaid_topology,
        "markdown": markdown,
    }

    try:
        await cache_set(cache_key, result, ttl_seconds=120)
    except Exception:
        pass

    return result
