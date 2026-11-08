"""User Living Blueprint Service (个人全域认知与能力蓝图生成器)

Applies the same idea as `PROJECT_BLUEPRINT.md` to the USER: synthesizes the user's project
blueprints (synced from their devices), projects, published resident profile, long-term memories,
knowledge graph and devices into `USER_BLUEPRINT.md`:

  0. 速览 (Quick Summary)
  1. 个人全域认知拓扑图 (Mermaid Flowchart Topology)
  2. 学科交叉与专业背景 (Academic & Scientific Disciplines)
  3. 核心业务版图与场景 (Business Domains & Scenarios)
  4. 跨项目架构蓝图矩阵 (Project Blueprint Portfolio)
  5. 全域技术栈与工程底座雷达 (Technology & Infrastructure Radar)
  6. 工程哲学与核心准则摘要 (Engineering Philosophy & Tenets)
  7. 算力终端 (Active Compute Nodes)

Everything comes from the user's own rows: documents of the user's own machines (an admin
sees only their own here too), their memories, entities and profile. Nothing is read from the
server's disk. Fields and business domains come from a general taxonomy matched against what
the user's projects are about, so the result describes whoever the user is.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import lru_cache
import hashlib
import logging
import re
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    Document,
    KnowledgeEntity,
    KnowledgeObservation,
    KnowledgeRelation,
    Machine,
    Project,
    User,
    UserMemory,
)
from .cache import cache_get, cache_set
from .profile_service import get_published_profile, split_profile_scopes

logger = logging.getLogger("server.user_blueprint_service")

# Busted where profile, memories, entities or blueprint documents change (profile.py, memory.py,
# dreaming_service.py, ingest_service.py, projects.py); the TTL only bounds staleness otherwise.
CACHE_PREFIX = "user:blueprint:v3:"
# Busted when a blueprint, the profile, memories or the graph change; the TTL only bounds count drift
CACHE_TTL_SECONDS = 3600


def user_blueprint_cache_key(user_id: Any) -> str:
    return f"{CACHE_PREFIX}{user_id}"


# ---------------------------------------------------------------------------
# General taxonomy. A field is matched by its keywords in what a project is about;
# ASCII keywords match on word boundaries, Chinese ones as substrings.
# ---------------------------------------------------------------------------

FIELDS: list[dict[str, Any]] = [
    {
        "id": "software_engineering",
        "name": "软件工程与全栈开发",
        "en_name": "Software Engineering & Full-Stack Development",
        "description": "前后端与客户端应用开发、接口设计、工程化与自动化测试",
        "domain": "应用与平台研发",
        "keywords": [
            "fastapi", "django", "flask", "express", "nestjs", "spring boot", "react", "vue", "next.js",
            "nextjs", "angular", "svelte", "typescript", "node.js", "nodejs", "sqlalchemy", "prisma",
            "graphql", "grpc", "rest api", "openapi", "pytest", "vitest", "jest", "playwright", "monorepo",
            "vite", "webpack", "前端", "后端", "全栈", "接口设计",
        ],
    },
    {
        "id": "distributed_cloud",
        "name": "分布式系统与云原生",
        "en_name": "Distributed Systems & Cloud Native",
        "description": "容器化部署、集群编排、持续交付与高可用服务治理",
        "domain": "云原生基础设施与持续交付",
        "keywords": [
            "docker", "kubernetes", "k8s", "k3s", "rke2", "helm", "kustomize", "kustomization", "gitops",
            "argocd", "rancher", "github actions", "terraform", "ansible", "nginx", "traefik", "ingress",
            "microservice", "microservices", "harbor", "ray", "微服务", "容器化", "集群", "零停机",
            "滚动更新", "多副本", "负载均衡", "镜像仓库",
        ],
    },
    {
        "id": "ai_ml",
        "name": "人工智能与大模型应用",
        "en_name": "AI & LLM Applications",
        "description": "大模型接入与编排、智能体、检索增强生成、向量检索与模型训练推理",
        "domain": "AI 智能体与大模型应用",
        "keywords": [
            "llm", "llms", "gpt", "openai", "anthropic", "claude", "gemini", "mcp", "agent", "agents",
            "rag", "embedding", "embeddings", "pgvector", "langchain", "llamaindex", "transformers",
            "pytorch", "tensorflow", "ollama", "vllm", "huggingface", "modelscope", "fine-tune",
            "fastmcp", "大模型", "智能体", "向量检索", "知识图谱", "提示词", "微调", "模型训练", "推理服务",
            "ai 记忆", "ai记忆", "长期记忆", "记忆系统",
        ],
    },
    {
        "id": "data_engineering",
        "name": "数据工程与知识挖掘",
        "en_name": "Data Engineering & Knowledge Mining",
        "description": "多源数据采集、清洗去重、ETL 流水线与可溯源的数据治理",
        "domain": "数据采集与治理",
        "keywords": [
            "etl", "crawler", "crawlers", "scraper", "scrapy", "spider", "airflow", "spark", "kafka",
            "flink", "pandas", "dataset", "datasets", "data pipeline", "爬虫", "数据抓取", "抓取",
            "数据清洗", "去重", "数据集", "标注", "数据治理", "入库",
        ],
    },
    {
        "id": "databases",
        "name": "数据库与存储系统",
        "en_name": "Databases & Storage Systems",
        "description": "关系型与向量数据库、缓存、对象存储与查询性能优化",
        "domain": "数据存储与检索",
        "keywords": [
            "postgresql", "postgres", "mysql", "sqlite", "mongodb", "redis", "elasticsearch", "clickhouse",
            "minio", "pgvector", "tsvector", "数据库", "慢查询", "索引优化", "主从复制", "分库分表",
        ],
    },
    {
        "id": "chemistry",
        "name": "化学与化学信息学",
        "en_name": "Chemistry & Cheminformatics",
        "description": "分子表示、化合物检索、化学反应与合成路线分析",
        "domain": "化学信息与合成规划",
        "keywords": [
            "rdkit", "smiles", "inchi", "pubchem", "reaxys", "chembl", "retrosynthesis", "molecule",
            "molecules", "molecular", "compound", "compounds", "cheminformatics", "化合物", "分子",
            "逆合成", "有机合成", "化学反应", "反应式", "试剂", "催化剂", "cas号", "cas 号", "化学",
        ],
    },
    {
        "id": "biology_medicine",
        "name": "生物医学与生命科学",
        "en_name": "Biomedicine & Life Sciences",
        "description": "蛋白与基因数据分析、药物发现与医疗信息系统",
        "domain": "生物医学研究与应用",
        "keywords": [
            "protein", "proteins", "genome", "genomics", "bioinformatics", "alphafold", "clinical",
            "drug discovery", "蛋白", "基因", "测序", "药物", "临床", "医疗", "病历",
        ],
    },
    {
        "id": "finance",
        "name": "金融与量化交易",
        "en_name": "Finance & Quantitative Trading",
        "description": "行情数据接入、量化策略回测、交易执行与风险控制",
        "domain": "量化交易与金融系统",
        "keywords": [
            "quant", "quantitative", "trading", "backtest", "backtesting", "tqsdk", "ctp", "futures",
            "binance", "freqtrade", "hft", "market maker", "market-maker", "portfolio", "量化", "期货",
            "股票", "回测", "实盘", "行情", "交易所", "做市", "持仓",
        ],
    },
    {
        "id": "mobile_desktop",
        "name": "移动端与桌面端开发",
        "en_name": "Mobile & Desktop Apps",
        "description": "iOS / Android、跨平台桌面客户端与原生系统集成",
        "domain": "客户端应用",
        "keywords": [
            "ios", "android", "swift", "swiftui", "kotlin", "react native", "expo", "flutter", "electron",
            "xcode", "testflight", "apk", "手机端", "移动端", "桌面端", "客户端",
        ],
    },
    {
        "id": "security",
        "name": "信息安全",
        "en_name": "Information Security",
        "description": "身份认证与权限、漏洞分析、加密与安全审计",
        "domain": "安全与合规",
        "keywords": [
            "oauth", "jwt", "rbac", "sso", "xss", "csrf", "cve", "pentest", "encryption", "鉴权", "越权",
            "漏洞", "渗透测试", "加密", "脱敏",
        ],
    },
    {
        "id": "networking",
        "name": "计算机网络与实时通信",
        "en_name": "Networking & Real-Time Communication",
        "description": "网络代理与组网、实时通信协议与流媒体传输",
        "domain": "网络与实时通信",
        "keywords": [
            "websocket", "webrtc", "tcp", "udp", "quic", "vpn", "wireguard", "xray", "frp", "vps", "sse",
            "代理", "内网穿透", "组网", "长连接", "实时语音",
        ],
    },
    {
        "id": "graphics_media",
        "name": "图形学与多媒体",
        "en_name": "Graphics & Multimedia",
        "description": "3D 渲染、图像与音视频处理、数据可视化",
        "domain": "多媒体与可视化",
        "keywords": [
            "three.js", "threejs", "webgl", "opengl", "shader", "ffmpeg", "opencv", "iptv", "echarts",
            "d3", "3d", "渲染", "视频", "音频", "图像处理", "可视化", "直播", "剪辑",
        ],
    },
    {
        "id": "content_ops",
        "name": "内容创作与运营",
        "en_name": "Content Creation & Operations",
        "description": "图文写作润色、公众号与社媒发布、内容运营自动化",
        "domain": "内容创作与发布",
        "keywords": [
            "wechat", "newsletter", "blog", "seo", "公众号", "小红书", "抖音", "草稿", "润色", "推文",
            "排版", "博客", "文章",
        ],
    },
    {
        "id": "productivity_automation",
        "name": "效率工具与流程自动化",
        "en_name": "Productivity & Automation",
        "description": "个人知识管理、办公自动化、定时任务与工作流编排",
        "domain": "效率工具与自动化",
        "keywords": [
            "obsidian", "notion", "raycast", "launchd", "cron", "crontab", "n8n", "zapier", "automation",
            "workflow", "copilot", "自动化", "定时任务", "工作流", "日报", "笔记", "待办", "办公", "知识管理",
        ],
    },
    {
        "id": "math_stats",
        "name": "数学与统计建模",
        "en_name": "Mathematics & Statistical Modeling",
        "description": "统计分析、优化算法、数值计算与机器学习建模",
        "domain": "数据分析与建模",
        "keywords": [
            "numpy", "scipy", "statsmodels", "sklearn", "scikit-learn", "matlab", "jupyter", "regression",
            "bayesian", "monte carlo", "统计分析", "回归", "优化算法", "数值计算", "概率",
        ],
    },
    {
        "id": "iot_embedded",
        "name": "物联网与嵌入式",
        "en_name": "IoT & Embedded Systems",
        "description": "设备固件、传感器接入与智能家居集成",
        "domain": "物联网与硬件",
        "keywords": [
            "arduino", "esp32", "raspberry pi", "mqtt", "firmware", "embedded", "stm32", "modbus",
            "home assistant", "嵌入式", "单片机", "传感器", "固件", "智能家居",
        ],
    },
]
_FIELD_BY_ID = {f["id"]: f for f in FIELDS}

TECH_RADAR_CATEGORIES: dict[str, tuple[str, list[tuple[str, list[str]]]]] = {
    "languages": (
        "编程语言 (Languages)",
        [
            ("Python", ["python", "pyproject.toml", "fastapi", "django", "pytest", "uv"]),
            ("TypeScript / JavaScript", ["typescript", "javascript", "node.js", "nodejs", "tsx"]),
            ("Go", ["golang", "go.mod"]),
            ("Rust", ["rust", "cargo"]),
            ("Java / Kotlin", ["java", "kotlin", "spring boot", "maven"]),
            ("Swift", ["swift", "swiftui"]),
            ("C / C++", ["c++", "cpp", "cmake"]),
            ("SQL", ["sql", "postgresql", "mysql", "sqlite"]),
            ("Shell / Bash", ["bash", "zsh", "shell", "powershell"]),
        ],
    ),
    "frontend_desktop": (
        "前端与客户端 (Frontend & Clients)",
        [
            ("React", ["react", "tsx"]),
            ("Next.js", ["next.js", "nextjs"]),
            ("Vue", ["vue", "nuxt"]),
            ("Electron", ["electron", "electron-builder"]),
            ("Tailwind CSS", ["tailwind", "tailwindcss"]),
            ("Three.js / WebGL", ["three.js", "threejs", "webgl"]),
            ("iOS / Android", ["ios", "android", "testflight", "apk"]),
        ],
    ),
    "backend_api": (
        "后端与通信协议 (Backend & Protocols)",
        [
            ("FastAPI", ["fastapi", "uvicorn", "pydantic"]),
            ("Django / Flask", ["django", "flask"]),
            ("Node.js 服务", ["express", "nestjs", "koa", "fastify"]),
            ("SQLAlchemy / ORM", ["sqlalchemy", "alembic", "prisma", "orm"]),
            ("Celery / 异步任务", ["celery", "rq", "bullmq"]),
            ("WebSocket / WebRTC / SSE", ["websocket", "webrtc", "sse"]),
            ("gRPC / GraphQL", ["grpc", "graphql"]),
        ],
    ),
    "data_storage": (
        "数据存储与检索 (Data & Storage)",
        [
            ("PostgreSQL", ["postgresql", "postgres"]),
            ("pgvector / 向量检索", ["pgvector", "向量检索", "vector db"]),
            ("MySQL", ["mysql", "mariadb"]),
            ("SQLite", ["sqlite"]),
            ("Redis", ["redis", "ioredis"]),
            ("MongoDB", ["mongodb", "mongo"]),
            ("Elasticsearch", ["elasticsearch", "opensearch"]),
            ("MinIO / S3", ["minio", "s3"]),
        ],
    ),
    "ai_agent": (
        "AI 与智能体 (AI & Agents)",
        [
            ("Claude / Anthropic", ["claude", "anthropic"]),
            ("OpenAI / GPT / Codex", ["openai", "gpt", "codex"]),
            ("Gemini / Antigravity", ["gemini", "antigravity"]),
            ("MCP", ["mcp", "model context protocol"]),
            ("Embedding / RAG", ["embedding", "embeddings", "rag", "bge-m3"]),
            ("LangChain / LlamaIndex", ["langchain", "llamaindex"]),
            ("PyTorch / Transformers", ["pytorch", "transformers", "huggingface"]),
            ("本地推理 (Ollama / vLLM)", ["ollama", "vllm"]),
        ],
    ),
    "devops_infra": (
        "云原生与工程效能 (Cloud Native & DevOps)",
        [
            ("Docker", ["docker", "dockerfile", "docker-compose"]),
            ("Kubernetes", ["kubernetes", "k8s", "k3s", "rke2", "kustomization"]),
            ("GitOps / CI/CD", ["gitops", "fleet", "argocd", "github actions", "ci/cd"]),
            ("Nginx / 网关", ["nginx", "traefik", "ingress"]),
            ("Terraform / Ansible", ["terraform", "ansible"]),
            ("Prometheus / Grafana", ["prometheus", "grafana"]),
        ],
    ),
    "testing_quality": (
        "测试与代码质量 (Testing & Quality)",
        [
            ("pytest", ["pytest"]),
            ("Vitest / Jest", ["vitest", "jest"]),
            ("Playwright", ["playwright"]),
            ("Ruff / ESLint", ["ruff", "eslint"]),
        ],
    ),
}

_NOISE_TECH_TOKENS = {
    "none",
    "none detected",
    "generic",
    "standard local runtime",
    "unknown",
    "-",
}

# Coding-agent tool names the graph sometimes records as entities ("Read 工具", "Bash")
_AGENT_TOOL_NAMES = {
    "read", "edit", "write", "bash", "grep", "glob", "ls", "task", "agent", "skill", "todowrite",
    "multiedit", "notebookedit", "webfetch", "websearch", "exitplanmode", "askuserquestion",
    "toolsearch", "monitor", "shell", "apply_patch", "view_file", "run_command",
}
_TECH_ENTITY_TYPES = {"technology", "tool", "framework", "library"}

# The collector's own "no real project" names (kept in sync with ingest_service._IGNORE_PROJECT_NAMES)
_IGNORE_PROJECT_NAMES = {
    "-", "--", "...", "dev", "desktop", "tmp", "temp", "scratch", "projects", "workspace",
    "file:", "file", "untitled", "unknown", "none", "null", "main", "home", "src",
}
_HOME_DIR_RE = re.compile(r"^(?:/users/[^/]+|/home/[^/]+|/root|[a-z]:/users/[^/]+)/?$")
_SCRATCH_PATH_RE = re.compile(
    r"^(?:/tmp|/private/tmp|/private/var/folders|/var/folders)(?:/|$)"
    r"|/appdata/local/temp(?:/|$)"
    r"|/documents/codex/\d{4}-\d{2}-\d{2}(?:/|$)"
    r"|/(?:\.[^/]+)(?:/|$)"
)
_PATH_SLUG_TITLE_RE = re.compile(r"^(?:users-|[a-z]-dev-|private-)")

# Stripped from knowledge-graph summaries before they go into the blueprint (it's synced to every device)
_SENSITIVE_RES = (
    re.compile(r"https?://\S+"),
    re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b"),
    re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b"),
    # Absolute paths only: "paper/testnet/live" or "src/app" inside a sentence stay
    re.compile(r"(?<![\w.~])(?:[A-Za-z]:|~)?(?:[\\/][^\s\\/，。；、,;:：)）\]]+){2,}[\\/]?"),
    re.compile(r"`[^`]*`"),
    re.compile(r"[（(][^()（）]*[\\/][^()（）]*[)）]"),  # "(owner/repo)", "(proj 79/...)"
)
# Clauses of a graph summary that describe the checkout rather than the project
_NOISE_CLAUSE_RE = re.compile(
    r"未跟踪|未提交|分支|git\s*管理|篇文档|文档/对话|项目路径|命名空间|gitlab\s*项目|域名|proj\s*\d+|\bstars\b"
    r"|远程仓库|托管于|内网|公网|入口为|提交哈希|commit\s*[0-9a-f]{7}|\b[0-9a-f]{12,}\b|[为是在于：:]$|^(?:git\s*)?(?:代码)?(?:仓库|项目|仓库项目|开发项目)$",
    re.IGNORECASE,
)
_LOCATION_RE = re.compile(
    r"(?:位于|放在)\s*[^，。,；;]{0,24}?的(?=[^，。,；;]*(?:项目|仓库|工程|代码|程序))"
    r"|^(?:在\s*)?(?:mac\s*mini|macbook[\w ]{0,12}|imac|nas|windows[\w ]{0,12}|linux[\w ]{0,12})\s*上的\s*"
    r"|(?:从|根据)(?:目录名|名称|名字|项目名)推(?:测|断)(?:是|为)?\s*",
    re.IGNORECASE,
)
# Summaries that are really rules or pitfalls about the project, not what it is
_RULE_SUMMARY_RE = re.compile(r"^(?:避坑|不要|必须|禁止|避免|处理数据|使用\s*memento|请|先|要)|避坑指南|不要|不改|硬约束")
_DANGLING_STOPWORDS = {
    "a", "an", "the", "and", "or", "with", "for", "of", "in", "to", "on", "by", "from", "at", "as",
    "over", "local", "1", "2",
}
_DANGLING_CN_SUFFIXES = ("的", "和", "与", "及", "或", "在", "从", "对", "把", "将", "并")


def _truncate_clean(text: str, max_len: int = 68) -> str:
    """Truncate text cleanly at word/punctuation boundaries without cutting words or parentheses in half."""
    clean = " ".join(text.strip().split()).rstrip(".")
    if "。" in clean:
        clean = clean.split("。", 1)[0].strip()
    if len(clean) <= max_len:
        return clean.rstrip(" ,;:-(")
    cut = clean[:max_len]
    # Strip any unclosed parenthesis segment at the tail
    if cut.count("(") > cut.count(")"):
        cut = cut.rsplit("(", 1)[0].strip()
    if cut.count("（") > cut.count("）"):
        cut = cut.rsplit("（", 1)[0].strip()
    if not cut.isascii():
        # Prefer cutting at last Chinese comma/semicolon if reasonably long
        for sep in ("，", "；", "、"):
            if sep in cut and cut.rfind(sep) >= max_len // 2:
                cut = cut[: cut.rfind(sep)]
                break
        while len(cut) > 4 and cut.endswith(_DANGLING_CN_SUFFIXES):
            cut = cut[:-1].rstrip(" ，；、,;-")
        return cut.rstrip(" ，；、,;:-(")
    if " " in cut:
        cut = cut.rsplit(" ", 1)[0]
    words = cut.split()
    while len(words) > 2 and words[-1].lower().strip(".,;:-(/") in _DANGLING_STOPWORDS | {""}:
        words.pop()
    return " ".join(words).rstrip(" ,;:-(/.")


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
                if (
                    clean
                    and clean.lower() not in _NOISE_TECH_TOKENS
                    and clean not in info["tech_stack"]
                ):
                    info["tech_stack"].append(clean)
        elif "Branch:" in s or "**Active Branch**:" in s:
            m = re.search(r"Branch\*?\*?:\s*`([^`]+)`", s)
            if m:
                info["branch"] = m.group(1)

    current_sec = ""
    raw_subsystems: list[tuple[int, str]] = []
    support_mods = {"docs", "doc", "scripts", "script", "tests", "test", "docker", "deploy", "k8s", "ci-scripts", "ci"}
    for line in md.splitlines():
        s = line.strip()
        # Headings only: the "## 0." section index lists every section title in a table row
        if s.startswith("## ") and ("Subsystem Breakdown" in s or s.startswith("## 3.")):
            current_sec = "subsystems"
            continue
        elif s.startswith("### Core Database Models"):
            current_sec = "core_models"
            continue
        elif s.startswith("### Registered API Routers") or s.startswith("### Frontend Web Routes"):
            current_sec = "api_routes"
            continue
        elif "Data Models" in s and "Core Domain Services" not in s:
            current_sec = "legacy_models"
            continue
        elif "API Surface" in s:
            current_sec = "legacy_routes"
            continue
        elif s.startswith("## ") or (s.startswith("### ") and current_sec in ("core_models", "api_routes")):
            current_sec = ""
            continue
        elif s.startswith("#### Key Entity") or s.startswith("#### Deduplication"):
            if current_sec == "core_models":
                current_sec = ""
            continue

        if current_sec == "subsystems" and s.startswith("|") and ("`" in s):
            if "Subsystem / Path" in s or ":---" in s:
                continue
            info["subsystems_count"] += 1
            parts = [p.strip() for p in s.strip("|").split("|")]
            if len(parts) >= 3:
                m_mod = re.search(r"`([^`]+)`", parts[0])
                mod_name = m_mod.group(1) if m_mod else parts[0]
                cat_name = parts[1]
                resp = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", parts[2]).strip("` ")
                prio = (
                    2
                    if (
                        mod_name.lower() in support_mods
                        or "Docs" in cat_name
                        or "Test" in cat_name
                        or "Automation" in cat_name
                        or "Infrastructure" in cat_name
                        or "Container" in cat_name
                    )
                    else (
                        1
                        if (mod_name.lower() == "research" or resp.startswith("Root-level ") or resp.startswith("@"))
                        else 0
                    )
                )
                raw_subsystems.append((prio, f"{mod_name} ({_truncate_clean(resp, 68)})"))
        elif current_sec == "core_models" and s.startswith("`"):
            model_tokens = [
                m.strip()
                for m in re.findall(r"`([^`]+)`", s)
                if m.strip() and m.strip() not in {"Base", "Model", "DeclarativeBase"}
            ]
            info["models_count"] += len(model_tokens)
        elif current_sec == "api_routes":
            if s.startswith("- `"):
                info["routes_count"] += 1
            else:
                m_more = re.search(r"\((\d+)\s+more\s+(?:endpoints|routes)\)", s)
                if m_more:
                    info["routes_count"] += int(m_more.group(1))
        elif current_sec == "legacy_models" and s.startswith("| `"):
            info["models_count"] += 1
        elif current_sec == "legacy_routes" and s.startswith("| `"):
            info["routes_count"] += 1

    raw_subsystems.sort(key=lambda item: item[0])
    info["subsystems_preview"] = [text for _, text in raw_subsystems[:4]]
    return info




@lru_cache(maxsize=4096)
def _kw_regex(kw: str) -> re.Pattern[str] | None:
    k = kw.lower().strip()
    if not k or not k.isascii():
        return None
    return re.compile(rf"(?<![a-z0-9]){re.escape(k)}(?![a-z0-9])")


def _kw_matches_text(kw: str, text_lower: str) -> bool:
    """Match a keyword in lowercase text: ASCII keywords on word boundaries (so "cas" doesn't match
    "broadcast"), Chinese ones as substrings."""
    k = kw.lower().strip()
    if not k:
        return False
    rx = _kw_regex(k)
    return bool(rx.search(text_lower)) if rx else k in text_lower


def _field_hits(text_lower: str) -> dict[str, list[str]]:
    hits: dict[str, list[str]] = {}
    if not text_lower:
        return hits
    for f in FIELDS:
        matched = [kw for kw in f["keywords"] if _kw_matches_text(kw, text_lower)]
        if matched:
            hits[f["id"]] = matched
    return hits


def _sanitize_summary(text: str | None, max_len: int = 90) -> str:
    """What a project is, from its knowledge-graph summary: no paths, addresses, links, code spans or
    remarks about the checkout (branch, untracked files), cut cleanly. Empty for rules and pitfalls."""
    if not isinstance(text, str) or not text.strip():
        return ""
    clean = text
    for rx in _SENSITIVE_RES:
        clean = rx.sub(" ", clean)
    clean = _LOCATION_RE.sub("", clean)
    clean = re.sub(r"[（(]\s*[)）]", "", clean)
    clauses = [c.strip(" ~") for c in re.split(r"[，,；;。]", " ".join(clean.split()))]
    if clauses and _RULE_SUMMARY_RE.search(clauses[0]):
        return ""
    kept = [c for c in clauses if len(c) >= 4 and not _NOISE_CLAUSE_RE.search(c) and not _RULE_SUMMARY_RE.search(c)]
    if not kept:
        return ""
    clean = re.sub(r"\s+([，。；、,;:：])", r"\1", "，".join(kept))
    return _truncate_clean(clean, max_len)


def _norm_path(path: str | None) -> str:
    return (path or "").strip().replace("\\", "/").rstrip("/").lower()


def _project_key(name: str) -> str:
    return re.sub(r"[\s_\-]+", "-", (name or "").strip().lower())


def _is_noise_project(title: str, norm_path: str) -> bool:
    """Collector artifacts rather than projects: home folders, temp and scratch dirs, placeholder names."""
    t = (title or "").strip()
    tl = t.lower()
    if not t or tl in _IGNORE_PROJECT_NAMES or tl.startswith(".") or "worktree" in tl or tl.isdigit():
        return True
    if re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,}|[0-9a-f]{16,}", tl):
        return True  # a session or task id, not a project
    if _PATH_SLUG_TITLE_RE.match(tl):
        return True
    if norm_path:
        if not (norm_path.startswith("/") or re.match(r"^[a-z]:/", norm_path)):
            return True  # "main", "-private-tmp": not a path at all
        if _HOME_DIR_RE.match(norm_path) or _SCRATCH_PATH_RE.search(norm_path):
            return True
    return False


def _is_noise_entity(name: str) -> bool:
    n = (name or "").strip()
    nl = n.lower()
    return (
        not (2 <= len(n) <= 32)
        or nl in _AGENT_TOOL_NAMES
        or n.endswith("工具")
        or nl.removesuffix(" 工具").removesuffix("工具").strip() in _AGENT_TOOL_NAMES
        or "/" in n
        or "\\" in n
    )


def _blueprint_quick_summary(md: str) -> list[str]:
    """The bullet lines of a project blueprint's "## 0." section (generator 20261110+)."""
    out: list[str] = []
    in_sec = False
    for line in (md or "").splitlines():
        s = line.strip()
        if s.startswith("## "):
            if in_sec:
                break
            in_sec = s.startswith("## 0.")
            continue
        if in_sec and s.startswith("- "):
            out.append(s[2:].replace("**", "").strip())
    return out
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

    # The top disciplines, plus any a shown business domain grows out of
    wanted = {b.get("discipline_id") for b in domains[:5]}
    shown_disc = [d for i, d in enumerate(disciplines) if i < 5 or d["id"] in wanted]
    if shown_disc:
        lines.append('    subgraph DISC["学科交叉 (Disciplines)"]')
        for d in shown_disc:
            did = _sanitize_mermaid_id(d["id"], "D")
            lines.append(f'        {did}["{d["name"]}"]')
        lines.append("    end")
        for d in shown_disc:
            did = _sanitize_mermaid_id(d["id"], "D")
            lines.append(f"    USER --> {did}")

    if domains:
        lines.append('    subgraph DOM["核心业务版图 (Business Domains)"]')
        for b in domains[:5]:
            bid = _sanitize_mermaid_id(b["id"], "B")
            lines.append(f'        {bid}["{b["name"]}"]')
        lines.append("    end")
        disc_ids = {d["id"]: _sanitize_mermaid_id(d["id"], "D") for d in shown_disc}
        for b in domains[:5]:
            bid = _sanitize_mermaid_id(b["id"], "B")
            target_disc_id = b.get("discipline_id")
            # A domain without a matching discipline hangs off the user, not an unrelated discipline
            src_id = disc_ids.get(target_disc_id, "USER") if target_disc_id else "USER"
            lines.append(f"    {src_id} --> {bid}")

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
            for pname in b.get("projects", []):
                pid = _sanitize_mermaid_id(pname, "P")
                if any(_sanitize_mermaid_id(p["name"], "P") == pid for p in projects[:8]):
                    lines.append(f"    {bid} --> {pid}")
                    linked_projects.add(pid)

        for p in projects[:8]:
            pid = _sanitize_mermaid_id(p["name"], "P")
            if pid not in linked_projects:
                lines.append(f"    USER --> {pid}")

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
        for tkey, _ in top_tech[:4]:
            tid = _sanitize_mermaid_id(tkey, "T")
            lines.append(f"    PROJ -.-> {tid}")

    lines.append("```")
    return "\n".join(lines)


def _quick_summary_lines(
    disciplines: list[dict[str, Any]],
    domains: list[dict[str, Any]],
    projects: list[dict[str, Any]],
    tech_radar: dict[str, dict[str, Any]],
    devices: list[dict[str, Any]],
) -> list[str]:
    lines: list[str] = []
    if disciplines:
        lines.append("学科领域: " + "、".join(d["name"] for d in disciplines[:6]))
    if domains:
        lines.append("业务版图: " + "；".join(
            f'{b["name"]}（{"、".join(b.get("projects", [])[:4])}）' for b in domains[:5]
        ))
    if projects:
        lines.append("主力项目: " + "、".join(
            f'{p["name"]}（{", ".join(p.get("tech_stack", [])[:3])}）' if p.get("tech_stack") else p["name"]
            for p in projects[:6]
        ))
    stack: list[str] = []
    for cat_id, cat in tech_radar.items():
        if cat_id != "knowledge_graph_emerging":
            stack.extend(cat.get("items", [])[:3])
    if stack:
        lines.append("技术底座: " + ", ".join(stack[:14]))
    if devices:
        online = sum(1 for d in devices if d.get("online"))
        lines.append(f"设备: {len(devices)} 台（{online} 台在线）")
    return lines or ["暂无足够数据：同步项目与会话后会自动补全"]


def _render_user_blueprint_markdown(
    user_name: str,
    disciplines: list[dict[str, Any]],
    domains: list[dict[str, Any]],
    projects: list[dict[str, Any]],
    tech_radar: dict[str, dict[str, Any]],
    philosophy: dict[str, list[str]],
    devices: list[dict[str, Any]],
    mermaid_topology: str,
    now: datetime | None = None,
) -> str:
    now_str = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%d %H:%M UTC")
    lines: list[str] = [
        f"# User Cognitive & Domain Blueprint: {user_name}",
        "",
        f"> **Auto-Generated Living User Blueprint** · **Updated**: `{now_str}` · **Projects Indexed**: `{len(projects)}` · **Disciplines**: `{len(disciplines)}` · **Business Domains**: `{len(domains)}`",
        "> *Synthesized from the user's own projects and their `PROJECT_BLUEPRINT.md`, knowledge graph, long-term memories and resident profile. Read section 0 first.*",
        "",
        "---",
        "",
        "## 0. 速览 (Quick Summary)",
        "",
    ]
    lines.extend(f"- {line}" for line in _quick_summary_lines(disciplines, domains, projects, tech_radar, devices))
    lines.extend([
        "",
        "## 1. 全域认知与能力拓扑 (Cognitive & Domain Topology)",
        "",
        mermaid_topology,
        "",
        "## 2. 学科交叉与专业领域 (Academic & Scientific Disciplines)",
        "",
        "| 学科领域 (Discipline) | 专业方向与核心内涵 (Scope & Focus) | 关联项目 (Projects) | 核心特征词 (Evidence) |",
        "| :--- | :--- | :--- | :--- |",
    ])

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
        if p.get("has_blueprint", True):
            scale_str = f'`{p.get("subsystems_count", 0)} 模块 / {p.get("models_count", 0)} 表 / {p.get("routes_count", 0)} 路由`'
        else:
            scale_str = "—"  # no project blueprint yet, so the size is unknown rather than zero
        summary_str = p.get("summary") or "; ".join(p.get("subsystems_preview", [])[:3]) or "-"
        summary_str = summary_str.replace("|", "/")
        lines.append(f'| **`{p["name"]}`** | {stack_str} | {scale_str} | {summary_str} |')

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




# ---------------------------------------------------------------------------
# Loading: every query is limited to the user's own rows
# ---------------------------------------------------------------------------


@dataclass
class BlueprintSources:
    devices: list[dict[str, Any]] = field(default_factory=list)
    # (project_id, title, source_path, document_count, last_synced_at)
    project_rows: list[tuple[Any, str, str | None, int, datetime | None]] = field(default_factory=list)
    # (project_id, relative_path, content, synced_at), newest first
    blueprint_docs: list[tuple[Any, str, str | None, datetime | None]] = field(default_factory=list)
    memories: list[str] = field(default_factory=list)
    # (name, entity_type, observation_count), most observed first
    entities: list[tuple[str, str, int]] = field(default_factory=list)
    # project key -> (summary, related technologies)
    project_entities: dict[str, tuple[str | None, list[str]]] = field(default_factory=dict)
    profile_text: str = ""


_PLATFORM_SUFFIX_RE = re.compile(r"\((darwin|macos|windows|linux|ios|android)\)\s*$", re.IGNORECASE)
_PLATFORM_LABELS = {"darwin": "macOS", "macos": "macOS", "windows": "Windows", "linux": "Linux", "ios": "iOS", "android": "Android"}


def _device_platform(name: str | None) -> str:
    """Devices are named "<host> (Darwin)" by the collector; the platform isn't stored separately."""
    m = _PLATFORM_SUFFIX_RE.search(name or "")
    return _PLATFORM_LABELS[m.group(1).lower()] if m else "unknown"


async def _load_sources(db: AsyncSession, user: User) -> BlueprintSources:
    src = BlueprintSources()
    now = datetime.now(timezone.utc)

    machine_ids: list[Any] = []
    try:
        rows = (await db.execute(
            select(Machine.id, Machine.name, Machine.last_heartbeat, Machine.merged_into, Machine.is_archived)
            .where(Machine.user_id == user.id)
        )).all()
        for mid, name, heartbeat, merged_into, archived in rows:
            machine_ids.append(mid)  # merged and archived devices still own their documents
            if merged_into is None and not archived:
                src.devices.append({
                    "name": name,
                    "platform": _device_platform(name),
                    "online": bool(heartbeat and (now - heartbeat).total_seconds() < 180),
                })
    except Exception as e:
        logger.warning("user blueprint: machines failed for %s: %s", user.id, e)

    if machine_ids:
        try:
            src.project_rows = [tuple(r) for r in (await db.execute(
                select(Project.id, Project.title, Project.source_path, func.count(Document.id), func.max(Document.synced_at))
                .join(Document, Document.project_id == Project.id)
                .where(Document.machine_id.in_(machine_ids))
                .group_by(Project.id)
            )).all()]
        except Exception as e:
            logger.warning("user blueprint: projects failed for %s: %s", user.id, e)
        try:
            src.blueprint_docs = [tuple(r) for r in (await db.execute(
                select(Document.project_id, Document.relative_path, Document.content, Document.synced_at)
                .where(
                    Document.machine_id.in_(machine_ids),
                    Document.relative_path.ilike("%PROJECT_BLUEPRINT.md"),
                )
                .order_by(Document.synced_at.desc())
                .limit(60)
            )).all()]
        except Exception as e:
            logger.warning("user blueprint: blueprint documents failed for %s: %s", user.id, e)

    try:
        src.memories = [c for c in (await db.execute(
            select(UserMemory.content)
            .where(UserMemory.user_id == user.id, UserMemory.status == "active", UserMemory.is_folder.is_(False))
            .order_by(UserMemory.recall_count.desc(), UserMemory.confidence.desc(), UserMemory.updated_at.desc())
            .limit(120)
        )).scalars().all() if isinstance(c, str)]
    except Exception as e:
        logger.warning("user blueprint: memories failed for %s: %s", user.id, e)

    try:
        n_obs = func.count(KnowledgeObservation.id)
        src.entities = [tuple(r) for r in (await db.execute(
            select(KnowledgeEntity.name, KnowledgeEntity.entity_type, n_obs)
            .outerjoin(KnowledgeObservation, KnowledgeObservation.entity_id == KnowledgeEntity.id)
            .where(
                KnowledgeEntity.user_id == user.id,
                KnowledgeEntity.stale_at.is_(None),
                KnowledgeEntity.entity_type.notin_(("file", "person")),
            )
            .group_by(KnowledgeEntity.id)
            .order_by(n_obs.desc())
            .limit(150)
        )).all()]
    except Exception as e:
        logger.warning("user blueprint: entities failed for %s: %s", user.id, e)

    try:
        profile = await get_published_profile(db, user)
        content = getattr(profile, "content", None) if profile else None
        src.profile_text = content if isinstance(content, str) else ""
    except Exception as e:
        logger.warning("user blueprint: profile failed for %s: %s", user.id, e)

    names: set[str] = set()
    for _pid, title, *_ in src.project_rows:
        if isinstance(title, str) and title.strip():
            names.add(title.strip().lower())
            names.add(title.strip().lower().replace("_", "-"))
            names.add(title.strip().lower().replace("-", "_"))
    for _pid, rel, *_ in src.blueprint_docs:
        if isinstance(rel, str) and "/" in rel:
            names.add(rel.split("/", 1)[0].strip().lower())
    if src.profile_text:
        names.update(n.strip().lower() for n in split_profile_scopes(src.profile_text).projects)
    names.discard("")
    if names:
        try:
            ents = (await db.execute(
                select(KnowledgeEntity.id, KnowledgeEntity.name, KnowledgeEntity.summary)
                .where(
                    KnowledgeEntity.user_id == user.id,
                    KnowledgeEntity.entity_type == "project",
                    KnowledgeEntity.stale_at.is_(None),
                    func.lower(KnowledgeEntity.name).in_(sorted(names)[:500]),
                )
            )).all()
            by_id = {eid: _project_key(name) for eid, name, _ in ents}
            for eid, name, summary in ents:
                key = by_id[eid]
                if key not in src.project_entities or (summary and not src.project_entities[key][0]):
                    src.project_entities[key] = (summary, [])
            if by_id:
                target = KnowledgeEntity.__table__.alias("tech")
                rel_rows = (await db.execute(
                    select(KnowledgeRelation.source_id, target.c.name, func.max(KnowledgeRelation.strength))
                    .join(target, target.c.id == KnowledgeRelation.target_id)
                    .where(
                        KnowledgeRelation.source_id.in_(list(by_id)),
                        KnowledgeRelation.relation_type.in_(("uses", "depends_on")),
                        target.c.entity_type.in_(sorted(_TECH_ENTITY_TYPES)),
                        target.c.stale_at.is_(None),
                    )
                    .group_by(KnowledgeRelation.source_id, target.c.name)
                    .order_by(func.max(KnowledgeRelation.strength).desc())
                    .limit(800)
                )).all()
                for sid, tname, _strength in rel_rows:
                    key = by_id.get(sid)
                    if key and isinstance(tname, str) and not _is_noise_entity(tname):
                        techs = src.project_entities[key][1]
                        if tname not in techs and len(techs) < 8:
                            techs.append(tname)
        except Exception as e:
            logger.warning("user blueprint: project entities failed for %s: %s", user.id, e)
    return src


# ---------------------------------------------------------------------------
# Synthesis (pure: everything it needs is in BlueprintSources)
# ---------------------------------------------------------------------------

# Fields any codebase touches: they need more evidence to become a project's main field
_GENERIC_FIELDS = {"software_engineering", "databases", "distributed_cloud", "mobile_desktop"}


def _collect_projects(src: BlueprintSources, now: datetime) -> list[dict[str, Any]]:
    projects: dict[str, dict[str, Any]] = {}
    id_to_key: dict[Any, str] = {}
    for pid, title, source_path, count, last in src.project_rows:
        if not isinstance(title, str):
            continue
        norm = _norm_path(source_path)
        if _is_noise_project(title, norm):
            continue
        key = _project_key(title)
        id_to_key[pid] = key
        p = projects.setdefault(key, {
            "name": title.strip(), "docs": 0, "last": None, "paths": {}, "pinned": False,
            "blueprint": None, "scoped": [],
        })
        p["docs"] += int(count or 0)
        if last and (p["last"] is None or last > p["last"]):
            p["last"] = last
        if norm:
            p["paths"][norm] = (p["paths"].get(norm, (0, ""))[0] + int(count or 0), (source_path or "").strip())
        # The spelling with the most documents names the merged project
        if int(count or 0) > p.get("_name_docs", 0):
            p["name"], p["_name_docs"] = title.strip(), int(count or 0)

    # A folder inside another project (memento/server, ray_train/inference) is part of it
    all_paths = {path for p in projects.values() for path in p["paths"]}
    for key in list(projects):
        paths = projects[key]["paths"]
        if paths and all(any(path.startswith(other + "/") for other in all_paths if other != path) for path in paths):
            del projects[key]

    for pid, rel, content, _synced in src.blueprint_docs:
        if not isinstance(content, str) or "# Project Blueprint" not in content:
            continue
        key = id_to_key.get(pid) or (_project_key(rel.split("/", 1)[0]) if isinstance(rel, str) and "/" in rel else "")
        if not key:
            continue
        if key not in projects:
            m = re.search(r"^# Project Blueprint:\s*(.+)$", content, re.MULTILINE)
            name = (m.group(1).strip() if m else rel.split("/", 1)[0]).strip()
            if _is_noise_project(name, ""):
                continue
            projects[key] = {"name": name, "docs": 0, "last": _synced, "paths": {}, "pinned": False, "blueprint": None, "scoped": []}
        if projects[key]["blueprint"] is None:  # newest first
            projects[key]["blueprint"] = {
                **_parse_project_blueprint_markdown(content),
                "quick": _blueprint_quick_summary(content),
            }

    if src.profile_text:
        for scoped_name, scoped_lines in split_profile_scopes(src.profile_text).projects.items():
            key = _project_key(scoped_name)
            if not key or _is_noise_project(scoped_name, ""):
                continue
            p = projects.setdefault(key, {
                "name": scoped_name.strip(), "docs": 0, "last": None, "paths": {}, "pinned": False,
                "blueprint": None, "scoped": [],
            })
            p["pinned"] = True
            p["scoped"] = [line.lstrip("-* ").strip() for line in scoped_lines if line.strip()]

    out: list[dict[str, Any]] = []
    for key, p in projects.items():
        bp = p["blueprint"] or {}
        if not (p["docs"] >= 2 or bp or p["pinned"]):
            continue
        ent_summary, ent_tech = src.project_entities.get(key, (None, []))
        # The profile's lines for a project are rules about working on it, not what it is
        description = _sanitize_summary(ent_summary)
        tech_stack = [t for t in bp.get("tech_stack", []) if t.lower() not in _NOISE_TECH_TOKENS] or ent_tech[:6]
        about = " ".join([p["name"], description, _sanitize_summary(ent_summary, 400)]).lower()
        stack = " ".join([" ".join(tech_stack), " ".join(ent_tech), " ".join(bp.get("subsystems_preview", [])), " ".join(bp.get("quick", []))]).lower()
        # Working rules ("polish drafts before pushing to WeChat") only break ties: they say how the
        # user works on a project, not what it is
        rules = " ".join(p["scoped"]).lower()
        hits_about, hits_stack, hits_rules = _field_hits(about), _field_hits(stack), _field_hits(rules)
        weights: dict[str, float] = {}
        for fid in set(hits_about) | set(hits_stack) | set(hits_rules):
            w = 2 * len(hits_about.get(fid, [])) + len(hits_stack.get(fid, [])) + 0.5 * len(hits_rules.get(fid, []))
            weights[fid] = w * (0.5 if fid in _GENERIC_FIELDS else 1.0)
        primary = max(weights, key=lambda f: (weights[f], -list(_FIELD_BY_ID).index(f))) if weights else ""
        last = p["last"]
        recent = bool(last and (now - last) < timedelta(days=60))
        rank = (p["docs"] + (400 if bp else 0) + (300 if p["pinned"] else 0)) * (1.0 if recent or not last else 0.5)
        display_path = max(p["paths"].values())[1] if p["paths"] else ""
        out.append({
            "key": key,
            "name": p["name"],
            "path": display_path,
            "description": description,
            "tech_stack": tech_stack,
            "subsystems_count": bp.get("subsystems_count", 0),
            "models_count": bp.get("models_count", 0),
            "routes_count": bp.get("routes_count", 0),
            "subsystems_preview": bp.get("subsystems_preview", []),
            "branch": bp.get("branch", ""),
            "has_blueprint": bool(bp),
            "documents": p["docs"],
            "rank": rank,
            "field_weights": weights,
            "field_hits": {fid: sorted(set(hits_about.get(fid, [])) | set(hits_stack.get(fid, []))) for fid in weights},
            "primary_field": primary,
            "text": f"{about}\n{stack}",
        })
    out.sort(key=lambda x: (x["rank"], x["documents"]), reverse=True)
    return out[:40]


def synthesize_user_blueprint(user_name: str, src: BlueprintSources, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    all_projects = _collect_projects(src, now)
    scopes = split_profile_scopes(src.profile_text) if src.profile_text else None
    entity_names = [n for n, _t, _c in src.entities if isinstance(n, str) and not _is_noise_entity(n)]
    corpus = "\n".join([
        scopes.general if scopes else "",
        *src.memories,
        " ".join(entity_names),
        *(p["text"] for p in all_projects),
    ]).lower()

    # Fields: evidence in everything the user does, plus the projects that are mainly about them
    disciplines: list[dict[str, Any]] = []
    corpus_hits = _field_hits(corpus)
    for f in FIELDS:
        evidence = corpus_hits.get(f["id"], [])
        primary_projects = [p["name"] for p in all_projects if p["primary_field"] == f["id"]]
        related = primary_projects + [
            p["name"] for p in all_projects
            if p["primary_field"] != f["id"] and p["field_weights"].get(f["id"], 0) >= 2
        ]
        if len(evidence) < 2 and not primary_projects:
            continue
        disciplines.append({
            "id": f["id"],
            "name": f["name"],
            "en_name": f["en_name"],
            "description": f["description"],
            "evidence": evidence[:8],
            "projects": related[:6],
            "score": len(evidence) + 3 * len(primary_projects) + len(related),
        })
    disciplines.sort(key=lambda d: d["score"], reverse=True)
    disciplines = disciplines[:8]

    # Business domains: the projects grouped by what they're mainly about
    domains: list[dict[str, Any]] = []
    for f in FIELDS:
        members = [p for p in all_projects if p["primary_field"] == f["id"]]
        if not members:
            continue
        described = [p for p in members if p["description"]][:3]
        scenarios = "；".join(f'{p["name"]}：{_truncate_clean(p["description"], 48)}' for p in described) or f["description"]
        evidence: list[str] = []
        for p in members:
            for kw in p["field_hits"].get(f["id"], []):
                if kw not in evidence:
                    evidence.append(kw)
        domains.append({
            "id": f"domain_{f['id']}",
            "name": f["domain"],
            "discipline_id": f["id"],
            "scenarios": scenarios,
            "projects": [p["name"] for p in members[:6]],
            "evidence": evidence[:6],
            "score": round(sum(p["rank"] for p in members), 1),
        })
    domains.sort(key=lambda b: b["score"], reverse=True)
    domains = domains[:6]

    # Technology radar: how many projects use each technology, plus what the user keeps talking about
    tech_names_lower = " ".join(n for n, t, _c in src.entities if isinstance(n, str) and t in _TECH_ENTITY_TYPES).lower()
    memories_lower = "\n".join(src.memories).lower()
    tech_radar: dict[str, dict[str, Any]] = {}
    known_tokens: set[str] = set()
    for cat_id, (label, defs) in TECH_RADAR_CATEGORIES.items():
        scored: list[tuple[int, int, str]] = []
        for idx, (tech_name, tokens) in enumerate(defs):
            known_tokens.update(t.lower() for t in tokens)
            known_tokens.add(tech_name.lower())
            in_projects = sum(1 for p in all_projects if any(_kw_matches_text(t, p["text"]) for t in tokens))
            elsewhere = sum(
                1 for text in (tech_names_lower, memories_lower) if any(_kw_matches_text(t, text) for t in tokens)
            )
            if in_projects + elsewhere:
                scored.append((in_projects * 2 + elsewhere, -idx, tech_name))
        scored.sort(reverse=True)
        tech_radar[cat_id] = {"label": label, "items": [name for *_s, name in scored]}

    emerging: list[str] = []
    project_keys = {p["key"] for p in all_projects}
    for name, etype, _count in src.entities:
        if not isinstance(name, str) or etype not in _TECH_ENTITY_TYPES or _is_noise_entity(name):
            continue
        if _project_key(name) in project_keys:
            continue
        clean = name.strip()
        low = clean.lower()
        if low in known_tokens or any(_kw_matches_text(t, low) for t in known_tokens if len(t) > 2):
            continue
        if clean not in emerging:
            emerging.append(clean)
        if len(emerging) >= 10:
            break
    if emerging:
        tech_radar["knowledge_graph_emerging"] = {"label": "知识图谱高频实体 (Knowledge Graph Entities)", "items": emerging}

    philosophy: dict[str, list[str]] = {"核心铁律与工程底线": [], "架构与技术偏好": [], "工作流与交付准则": []}
    if scopes and scopes.general:
        heading = ""
        for line in scopes.general.splitlines():
            s = line.strip()
            if s.startswith("### "):
                heading = s.lstrip("# ").strip()
            elif s.startswith("- "):
                rule_text = s[2:].strip()
                if "铁律" in heading:
                    philosophy["核心铁律与工程底线"].append(rule_text)
                elif "技术" in heading:
                    philosophy["架构与技术偏好"].append(rule_text)
                elif "工作" in heading or "沟通" in heading:
                    philosophy["工作流与交付准则"].append(rule_text)

    clean_projects = [
        {
            "name": p["name"],
            "path": p["path"],
            "summary": p["description"],
            "primary_field": p["primary_field"],
            "tech_stack": p["tech_stack"],
            "subsystems_count": p["subsystems_count"],
            "models_count": p["models_count"],
            "routes_count": p["routes_count"],
            "subsystems_preview": p["subsystems_preview"],
            "branch": p["branch"],
            "has_blueprint": p["has_blueprint"],
        }
        for p in all_projects[:15]
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
        devices=src.devices,
        mermaid_topology=mermaid_topology,
        now=now,
    )
    return {
        "user_name": user_name,
        "hash": hashlib.sha256(markdown.encode("utf-8")).hexdigest()[:16],
        "generated_at": now.isoformat(),
        "disciplines": disciplines,
        "business_domains": domains,
        "projects": clean_projects,
        "tech_radar": tech_radar,
        "philosophy": philosophy,
        "devices": src.devices,
        "mermaid_topology": mermaid_topology,
        "markdown": markdown,
    }


async def build_user_blueprint(
    db: AsyncSession,
    user: User,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Synthesize the user's `USER_BLUEPRINT.md` (cached per user)."""
    key = user_blueprint_cache_key(user.id)
    if not force_refresh:
        try:
            cached = await cache_get(key)
            if isinstance(cached, dict) and cached.get("markdown"):
                return cached
        except Exception:
            pass

    user_name = getattr(user, "name", None) or getattr(user, "email", None) or "Developer"
    result = synthesize_user_blueprint(user_name, await _load_sources(db, user))
    try:
        await cache_set(key, result, ttl_seconds=CACHE_TTL_SECONDS)
    except Exception:
        pass
    return result


async def cached_user_blueprint(user_id: Any) -> dict[str, Any] | None:
    """The cached blueprint, or None; never builds."""
    try:
        cached = await cache_get(user_blueprint_cache_key(user_id))
    except Exception:
        return None
    return cached if isinstance(cached, dict) and cached.get("markdown") else None


# Builds in flight on this replica; losing it only costs a duplicate build
_warming: set[str] = set()
_warm_tasks: set[asyncio.Task] = set()


def warm_user_blueprint(user: User) -> None:
    """Build and cache the user's blueprint in the background, on its own session, so a caller that
    found the cache empty doesn't wait for it."""
    key = str(user.id)
    if key in _warming:
        return
    _warming.add(key)

    async def _run() -> None:
        try:
            from ..db.session import async_session_factory

            async with async_session_factory() as session:
                fresh = await session.get(User, user.id)
                if fresh is not None:
                    await build_user_blueprint(session, fresh)
        except Exception as e:
            logger.debug("warming user blueprint for %s failed: %s", user.id, e)
        finally:
            _warming.discard(key)

    try:
        task = asyncio.get_running_loop().create_task(_run())
    except RuntimeError:
        _warming.discard(key)
        return
    _warm_tasks.add(task)
    task.add_done_callback(_warm_tasks.discard)
