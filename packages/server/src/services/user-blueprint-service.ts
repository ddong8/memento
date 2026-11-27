// User Living Blueprint synthesizer (USER_BLUEPRINT.md) (server/server/services/user_blueprint_service.py).
import { createHash } from "node:crypto";

import { and, desc, eq, inArray, isNull, like, notInArray, or, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import { cacheGet, cacheSet } from "../cache";
import type { Db } from "../db/client";
import {
  documents,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  machines,
  projects,
  userMemories,
  users,
} from "../db/pulled/schema";
import { deviceOs } from "./agent-ids";
import { blueprintCopy, CODE_BLUEPRINT_TITLES, codeBlueprintPath, codeBlueprintTitle, isFresher, type BlueprintCopy } from "./blueprint-pick";
import { BUSINESS_FILE, checkSummary, parseEntries } from "./business-blueprint";
import { cluster } from "./cluster";
import { getPublishedProfile } from "./profile-read";
import { splitProfileScopes } from "./profile-scopes";

export const CACHE_PREFIX = "user:blueprint:v4:";
export const CACHE_TTL_SECONDS = 3600;

export function userBlueprintCacheKey(userId: string): string {
  return `${CACHE_PREFIX}${userId}`;
}

interface FieldDef {
  id: string;
  name: string;
  en_name: string;
  description: string;
  domain: string;
  keywords: string[];
}

const FIELDS: FieldDef[] = [
  { id: "software_engineering", name: "软件工程与全栈开发", en_name: "Software Engineering & Full-Stack Development", description: "前后端与客户端应用开发、接口设计、工程化与自动化测试", domain: "应用与平台研发", keywords: ["fastapi", "django", "flask", "express", "nestjs", "spring boot", "react", "vue", "next.js", "nextjs", "angular", "svelte", "typescript", "node.js", "nodejs", "sqlalchemy", "prisma", "graphql", "grpc", "rest api", "openapi", "pytest", "vitest", "jest", "playwright", "monorepo", "vite", "webpack", "前端", "后端", "全栈", "接口设计"] },
  { id: "distributed_cloud", name: "分布式系统与云原生", en_name: "Distributed Systems & Cloud Native", description: "容器化部署、集群编排、持续交付与高可用服务治理", domain: "云原生基础设施与持续交付", keywords: ["docker", "kubernetes", "k8s", "k3s", "rke2", "helm", "kustomize", "kustomization", "gitops", "argocd", "rancher", "github actions", "terraform", "ansible", "nginx", "traefik", "ingress", "microservice", "microservices", "harbor", "ray", "微服务", "容器化", "集群", "零停机", "滚动更新", "多副本", "负载均衡", "镜像仓库"] },
  { id: "ai_ml", name: "人工智能与大模型应用", en_name: "AI & LLM Applications", description: "大模型接入与编排、智能体、检索增强生成、向量检索与模型训练推理", domain: "AI 智能体与大模型应用", keywords: ["llm", "llms", "gpt", "openai", "anthropic", "claude", "gemini", "mcp", "agent", "agents", "rag", "embedding", "embeddings", "pgvector", "langchain", "llamaindex", "transformers", "pytorch", "tensorflow", "ollama", "vllm", "huggingface", "modelscope", "fine-tune", "fastmcp", "大模型", "智能体", "向量检索", "知识图谱", "提示词", "微调", "模型训练", "推理服务", "ai 记忆", "ai记忆", "长期记忆", "记忆系统"] },
  { id: "data_engineering", name: "数据工程与知识挖掘", en_name: "Data Engineering & Knowledge Mining", description: "多源数据采集、清洗去重、ETL 流水线与可溯源的数据治理", domain: "数据采集与治理", keywords: ["etl", "crawler", "crawlers", "scraper", "scrapy", "spider", "airflow", "spark", "kafka", "flink", "pandas", "dataset", "datasets", "data pipeline", "爬虫", "数据抓取", "抓取", "数据清洗", "去重", "数据集", "标注", "数据治理", "入库"] },
  { id: "databases", name: "数据库与存储系统", en_name: "Databases & Storage Systems", description: "关系型与向量数据库、缓存、对象存储与查询性能优化", domain: "数据存储与检索", keywords: ["postgresql", "postgres", "mysql", "sqlite", "mongodb", "redis", "elasticsearch", "clickhouse", "minio", "pgvector", "tsvector", "数据库", "慢查询", "索引优化", "主从复制", "分库分表"] },
  { id: "chemistry", name: "化学与化学信息学", en_name: "Chemistry & Cheminformatics", description: "分子表示、化合物检索、化学反应与合成路线分析", domain: "化学信息与合成规划", keywords: ["rdkit", "smiles", "inchi", "pubchem", "reaxys", "chembl", "retrosynthesis", "molecule", "molecules", "molecular", "compound", "compounds", "cheminformatics", "化合物", "分子", "逆合成", "有机合成", "化学反应", "反应式", "试剂", "催化剂", "cas号", "cas 号", "化学"] },
  { id: "biology_medicine", name: "生物医学与生命科学", en_name: "Biomedicine & Life Sciences", description: "蛋白与基因数据分析、药物发现与医疗信息系统", domain: "生物医学研究与应用", keywords: ["protein", "proteins", "genome", "genomics", "bioinformatics", "alphafold", "clinical", "drug discovery", "蛋白", "基因", "测序", "药物", "临床", "医疗", "病历"] },
  { id: "finance", name: "金融与量化交易", en_name: "Finance & Quantitative Trading", description: "行情数据接入、量化策略回测、交易执行与风险控制", domain: "量化交易与金融系统", keywords: ["quant", "quantitative", "trading", "backtest", "backtesting", "tqsdk", "ctp", "futures", "binance", "freqtrade", "hft", "market maker", "market-maker", "portfolio", "量化", "期货", "股票", "回测", "实盘", "行情", "交易所", "做市", "持仓"] },
  { id: "mobile_desktop", name: "移动端与桌面端开发", en_name: "Mobile & Desktop Apps", description: "iOS / Android、跨平台桌面客户端与原生系统集成", domain: "客户端应用", keywords: ["ios", "android", "swift", "swiftui", "kotlin", "react native", "expo", "flutter", "electron", "xcode", "testflight", "apk", "手机端", "移动端", "桌面端", "客户端"] },
  { id: "security", name: "信息安全", en_name: "Information Security", description: "身份认证与权限、漏洞分析、加密与安全审计", domain: "安全与合规", keywords: ["oauth", "jwt", "rbac", "sso", "xss", "csrf", "cve", "pentest", "encryption", "鉴权", "越权", "漏洞", "渗透测试", "加密", "脱敏"] },
  { id: "networking", name: "计算机网络与实时通信", en_name: "Networking & Real-Time Communication", description: "网络代理与组网、实时通信协议与流媒体传输", domain: "网络与实时通信", keywords: ["websocket", "webrtc", "tcp", "udp", "quic", "vpn", "wireguard", "xray", "frp", "vps", "sse", "代理", "内网穿透", "组网", "长连接", "实时语音"] },
  { id: "graphics_media", name: "图形学与多媒体", en_name: "Graphics & Multimedia", description: "3D 渲染、图像与音视频处理、数据可视化", domain: "多媒体与可视化", keywords: ["three.js", "threejs", "webgl", "opengl", "shader", "ffmpeg", "opencv", "iptv", "echarts", "d3", "3d", "渲染", "视频", "音频", "图像处理", "可视化", "直播", "剪辑"] },
  { id: "content_ops", name: "内容创作与运营", en_name: "Content Creation & Operations", description: "图文写作润色、公众号与社媒发布、内容运营自动化", domain: "内容创作与发布", keywords: ["wechat", "newsletter", "blog", "seo", "公众号", "小红书", "抖音", "草稿", "润色", "推文", "排版", "博客", "文章"] },
  { id: "productivity_automation", name: "效率工具与流程自动化", en_name: "Productivity & Automation", description: "个人知识管理、办公自动化、定时任务与工作流编排", domain: "效率工具与自动化", keywords: ["obsidian", "notion", "raycast", "launchd", "cron", "crontab", "n8n", "zapier", "automation", "workflow", "copilot", "自动化", "定时任务", "工作流", "日报", "笔记", "待办", "办公", "知识管理"] },
  { id: "math_stats", name: "数学与统计建模", en_name: "Mathematics & Statistical Modeling", description: "统计分析、优化算法、数值计算与机器学习建模", domain: "数据分析与建模", keywords: ["numpy", "scipy", "statsmodels", "sklearn", "scikit-learn", "matlab", "jupyter", "regression", "bayesian", "monte carlo", "统计分析", "回归", "优化算法", "数值计算", "概率"] },
  { id: "iot_embedded", name: "物联网与嵌入式", en_name: "IoT & Embedded Systems", description: "设备固件、传感器接入与智能家居集成", domain: "物联网与硬件", keywords: ["arduino", "esp32", "raspberry pi", "mqtt", "firmware", "embedded", "stm32", "modbus", "home assistant", "嵌入式", "单片机", "传感器", "固件", "智能家居"] },
];

const TECH_RADAR_CATEGORIES: Record<string, [string, [string, string[]][]]> = {
  languages: ["编程语言 (Languages)", [["Python", ["python", "pyproject.toml", "fastapi", "django", "pytest", "uv"]], ["TypeScript / JavaScript", ["typescript", "javascript", "node.js", "nodejs", "tsx"]], ["Go", ["golang", "go.mod"]], ["Rust", ["rust", "cargo"]], ["Java / Kotlin", ["java", "kotlin", "spring boot", "maven"]], ["Swift", ["swift", "swiftui"]], ["C / C++", ["c++", "cpp", "cmake"]], ["SQL", ["sql", "postgresql", "mysql", "sqlite"]], ["Shell / Bash", ["bash", "zsh", "shell", "powershell"]]]],
  frontend_desktop: ["前端与客户端 (Frontend & Clients)", [["React", ["react", "tsx"]], ["Next.js", ["next.js", "nextjs"]], ["Vue", ["vue", "nuxt"]], ["Electron", ["electron", "electron-builder"]], ["Tailwind CSS", ["tailwind", "tailwindcss"]], ["Three.js / WebGL", ["three.js", "threejs", "webgl"]], ["iOS / Android", ["ios", "android", "testflight", "apk"]]]],
  backend_api: ["后端与通信协议 (Backend & Protocols)", [["FastAPI", ["fastapi", "uvicorn", "pydantic"]], ["Django / Flask", ["django", "flask"]], ["Node.js 服务", ["express", "nestjs", "koa", "fastify", "hono"]], ["SQLAlchemy / ORM", ["sqlalchemy", "alembic", "prisma", "drizzle", "orm"]], ["Celery / 异步任务", ["celery", "rq", "bullmq"]], ["WebSocket / WebRTC / SSE", ["websocket", "webrtc", "sse"]], ["gRPC / GraphQL", ["grpc", "graphql"]]]],
  data_storage: ["数据存储与检索 (Data & Storage)", [["PostgreSQL", ["postgresql", "postgres"]], ["pgvector / 向量检索", ["pgvector", "向量检索", "vector db"]], ["MySQL", ["mysql", "mariadb"]], ["SQLite", ["sqlite"]], ["Redis", ["redis", "ioredis"]], ["MongoDB", ["mongodb", "mongo"]], ["Elasticsearch", ["elasticsearch", "opensearch"]], ["MinIO / S3", ["minio", "s3"]]]],
  ai_agent: ["AI 与智能体 (AI & Agents)", [["Claude / Anthropic", ["claude", "anthropic"]], ["OpenAI / GPT / Codex", ["openai", "gpt", "codex"]], ["Gemini / Antigravity", ["gemini", "antigravity"]], ["MCP", ["mcp", "model context protocol"]], ["Embedding / RAG", ["embedding", "embeddings", "rag", "bge-m3"]], ["LangChain / LlamaIndex", ["langchain", "llamaindex"]], ["PyTorch / Transformers", ["pytorch", "transformers", "huggingface"]], ["本地推理 (Ollama / vLLM)", ["ollama", "vllm"]]]],
  devops_infra: ["云原生与工程效能 (Cloud Native & DevOps)", [["Docker", ["docker", "dockerfile", "docker-compose"]], ["Kubernetes", ["kubernetes", "k8s", "k3s", "rke2", "kustomization"]], ["GitOps / CI/CD", ["gitops", "fleet", "argocd", "github actions", "ci/cd"]], ["Nginx / 网关", ["nginx", "traefik", "ingress"]], ["Terraform / Ansible", ["terraform", "ansible"]], ["Prometheus / Grafana", ["prometheus", "grafana"]]]],
  testing_quality: ["测试与代码质量 (Testing & Quality)", [["pytest", ["pytest"]], ["Vitest / Jest", ["vitest", "jest"]], ["Playwright", ["playwright"]], ["Ruff / ESLint", ["ruff", "eslint"]]]],
};

const NOISE_TECH = new Set(["none", "none detected", "generic", "standard local runtime", "unknown", "-"]);
const AGENT_TOOLS = new Set(["read", "edit", "write", "bash", "grep", "glob", "ls", "task", "agent", "skill", "todowrite", "multiedit", "notebookedit", "webfetch", "websearch", "exitplanmode", "askuserquestion", "toolsearch", "monitor", "shell", "apply_patch", "view_file", "run_command"]);
const TECH_ENTITY_TYPES = new Set(["technology", "tool", "framework", "library"]);
const IGNORE_PROJECTS = new Set(["-", "--", "...", "dev", "desktop", "tmp", "temp", "projects", "workspace", "file:", "file", "untitled", "unknown", "none", "null", "main", "home", "src"]);
const GENERIC_FIELDS = new Set(["software_engineering", "databases", "distributed_cloud", "mobile_desktop"]);
const PLATFORM_LABELS: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux", ios: "iOS", android: "Android" };

const kwReCache = new Map<string, RegExp | null>();
function kwMatchesText(kw: string, textLower: string): boolean {
  const k = kw.toLowerCase().trim();
  if (!k) return false;
  if (!/^[\x00-\x7f]+$/.test(k)) return textLower.includes(k);
  let rx = kwReCache.get(k);
  if (rx === undefined) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rx = new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`);
    kwReCache.set(k, rx);
  }
  return rx ? rx.test(textLower) : textLower.includes(k);
}

function fieldHits(textLower: string): Record<string, string[]> {
  const hits: Record<string, string[]> = {};
  if (!textLower) return hits;
  for (const f of FIELDS) {
    const matched = f.keywords.filter((kw) => kwMatchesText(kw, textLower));
    if (matched.length) hits[f.id] = matched;
  }
  return hits;
}

function projectKey(name: string): string {
  return (name || "").trim().toLowerCase().replace(/[\s_-]+/g, "-");
}

function isNoiseProject(title: string, normPath: string): boolean {
  const t = (title || "").trim();
  const tl = t.toLowerCase();
  if (!t || IGNORE_PROJECTS.has(tl) || tl.startsWith(".") || tl.includes("worktree") || /^\d+$/.test(tl)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,}$|^[0-9a-f]{16,}$/.test(tl)) return true;
  if (/^(?:users-|[a-z]-dev-|private-)/.test(tl)) return true;
  if (normPath) {
    if (!normPath.startsWith("/") && !/^[a-z]:\//.test(normPath)) return true;
    if (/^(?:\/users\/[^/]+|\/home\/[^/]+|\/root|[a-z]:\/users\/[^/]+)\/?$/.test(normPath)) return true;
    if (/^(?:\/tmp|\/private\/tmp|\/private\/var\/folders|\/var\/folders)(?:\/|$)|\/appdata\/local\/temp(?:\/|$)/.test(normPath)) return true;
  }
  return false;
}

function isNoiseEntity(name: string): boolean {
  const n = (name || "").trim();
  const nl = n.toLowerCase();
  return n.length < 2 || n.length > 32 || AGENT_TOOLS.has(nl) || n.endsWith("工具") || n.includes("/") || n.includes("\\");
}

function truncateClean(text: string, maxLen = 68): string {
  let clean = (text || "").trim().replace(/\s+/g, " ").replace(/\.$/, "");
  if (clean.includes("。")) clean = clean.split("。", 1)[0]!.trim();
  if (clean.length <= maxLen) return clean.replace(/[ ,;:\-(]+$/, "");
  let cut = clean.slice(0, maxLen);
  if ((cut.match(/\(/g)?.length ?? 0) > (cut.match(/\)/g)?.length ?? 0)) cut = cut.slice(0, cut.lastIndexOf("(")).trim();
  if ((cut.match(/（/g)?.length ?? 0) > (cut.match(/）/g)?.length ?? 0)) cut = cut.slice(0, cut.lastIndexOf("（")).trim();
  return cut.replace(/[ ，；、,;:\-(]+$/, "");
}

function sanitizeSummary(text: string | null | undefined, maxLen = 90): string {
  if (!text || !text.trim()) return "";
  let clean = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, " ")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, " ")
    .replace(/`[^`]*`/g, " ");
  clean = clean.replace(/\s+/g, " ").trim();
  if (/^(?:避坑|不要|必须|禁止|避免|请|先|要)|避坑指南|硬约束/.test(clean)) return "";
  return truncateClean(clean, maxLen);
}

function parseProjectBlueprintMd(md: string) {
  const info = { tech_stack: [] as string[], subsystems_count: 0, models_count: 0, routes_count: 0, subsystems_preview: [] as string[], branch: "", about: "", quick: [] as string[] };
  if (!md) return info;
  let inSec0 = false;
  let currentSec = "";
  for (const line of md.split("\n")) {
    const s = line.trim();
    if (s.startsWith("## ")) {
      inSec0 = s.startsWith("## 0.");
      currentSec = s.includes("Subsystem Breakdown") || s.startsWith("## 3.") ? "subsystems" : "";
    } else if (s.startsWith("### Core Database Models")) {
      currentSec = "core_models";
    } else if (s.startsWith("### Registered API Routers") || s.startsWith("### Frontend Web Routes")) {
      currentSec = "api_routes";
    } else if (s.startsWith("### ")) {
      currentSec = "";
    }
    if (inSec0 && s.startsWith("- ")) {
      const plain = s.slice(2).replaceAll("**", "").trim();
      if (plain.startsWith("简介 (About):") || plain.startsWith("About:")) info.about = plain.split(":").slice(1).join(":").trim();
      else info.quick.push(plain);
    }
    if (["- **Core Languages**:", "- **Key Frameworks**:", "- **Infrastructure & Middleware**:", "- **Languages**:", "- **Frameworks & Libraries**:", "- **Infrastructure & Tooling**:"].some((p) => s.startsWith(p))) {
      for (const tok of s.split(":").slice(1).join(":").split(",")) {
        const clean = tok.trim().replace(/^`+|`+$/g, "");
        if (clean && !NOISE_TECH.has(clean.toLowerCase()) && !info.tech_stack.includes(clean)) info.tech_stack.push(clean);
      }
    } else if (s.includes("Branch:")) {
      const m = /Branch\*?\*?:\s*`([^`]+)`/.exec(s);
      if (m) info.branch = m[1]!;
    }
    if (currentSec === "subsystems" && s.startsWith("|") && s.includes("`") && !s.includes("Subsystem / Path") && !s.includes(":---")) {
      info.subsystems_count++;
      const parts = s.replace(/^\||\|$/g, "").split("|").map((p) => p.trim());
      if (parts.length >= 3 && info.subsystems_preview.length < 4) {
        const mm = /`([^`]+)`/.exec(parts[0]!);
        const modName = mm ? mm[1]! : parts[0]!;
        const resp = parts[2]!.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^[` ]+|[` ]+$/g, "");
        info.subsystems_preview.push(`${modName} (${truncateClean(resp, 68)})`);
      }
    } else if (currentSec === "core_models" && s.startsWith("`")) {
      const toks = [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim()).filter((t) => t && !["Base", "Model", "DeclarativeBase"].includes(t));
      info.models_count += toks.length;
    } else if (currentSec === "api_routes") {
      if (s.startsWith("- `")) info.routes_count++;
      else {
        const mm = /\((\d+)\s+more\s+(?:endpoints|routes)\)/.exec(s);
        if (mm) info.routes_count += Number(mm[1]);
      }
    }
  }
  return info;
}

function businessDigest(text: string) {
  const entries = parseEntries(text);
  const terms = entries.filter((e) => e.kind === "term").map((e) => e.title);
  const flows = entries.filter((e) => e.kind === "flow").map((e) => e.title);
  const words = [
    ...entries.filter((e) => e.kind === "term" || e.kind === "flow").map((e) => e.title),
    ...entries.filter((e) => e.kind === "term").flatMap((e) => e.texts),
  ]
    .join(" ")
    .slice(0, 4000);
  return {
    terms: terms.slice(0, 12),
    flows: flows.slice(0, 8),
    rules: entries.filter((e) => e.kind === "rule").length,
    check: checkSummary(text),
    text: words,
  };
}

function sanitizeMermaidId(raw: string, prefix = "N"): string {
  const clean = raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return clean ? `${prefix}_${clean}` : `${prefix}_node`;
}

export async function buildUserBlueprint(db: Db, redis: Redis | null, user: UserRow, forceRefresh = false): Promise<Record<string, unknown>> {
  const key = userBlueprintCacheKey(user.id);
  if (!forceRefresh) {
    const cached = await cacheGet(redis, key);
    if (cached && typeof cached === "object" && (cached as Record<string, unknown>).markdown) {
      return cached as Record<string, unknown>;
    }
  }

  const now = new Date();
  const nowMs = now.getTime();
  const machineRows = await db
    .select({ id: machines.id, name: machines.name, lastHeartbeat: machines.lastHeartbeat, mergedInto: machines.mergedInto, isArchived: machines.isArchived })
    .from(machines)
    .where(eq(machines.userId, user.id));
  const machineIds = machineRows.map((m) => m.id);
  const deviceList = machineRows
    .filter((m) => !m.mergedInto && !m.isArchived)
    .map((m) => {
      const hb = m.lastHeartbeat ? Date.parse(m.lastHeartbeat.includes("T") ? m.lastHeartbeat : m.lastHeartbeat.replace(" ", "T")) : 0;
      const os = deviceOs(m.name);
      return { name: m.name, platform: os ? (PLATFORM_LABELS[os] ?? "unknown") : "unknown", online: Boolean(hb && nowMs - hb < 180_000) };
    });

  const projectMap = new Map<string, Record<string, unknown>>();
  const idToKey = new Map<string, string>();
  if (machineIds.length) {
    const workCond = sql`NOT (${codeBlueprintPath(documents.relativePath)} OR ${documents.relativePath} LIKE ${`%/${BUSINESS_FILE}`})`;
    const projRows = await db
      .select({
        id: projects.id,
        title: projects.title,
        sourcePath: projects.sourcePath,
        cnt: sql<number>`count(${documents.id}) filter (where ${workCond})`.mapWith(Number),
        last: sql<string | null>`max(${documents.syncedAt}) filter (where ${workCond})`,
      })
      .from(projects)
      .innerJoin(documents, eq(documents.projectId, projects.id))
      .where(inArray(documents.machineId, machineIds))
      .groupBy(projects.id);

    for (const r of projRows) {
      const normPath = (r.sourcePath || "").trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
      if (isNoiseProject(r.title, normPath)) continue;
      const k = projectKey(r.title);
      idToKey.set(r.id, k);
      const prev = projectMap.get(k) ?? { name: r.title.trim(), docs: 0, last: 0, path: "", pinned: false, blueprint: null, business: null, scoped: [] as string[] };
      prev.docs = Number(prev.docs) + Number(r.cnt || 0);
      const lastMs = r.last ? Date.parse(String(r.last).includes("T") ? String(r.last) : String(r.last).replace(" ", "T")) : 0;
      if (lastMs > Number(prev.last)) prev.last = lastMs;
      if (r.sourcePath && !prev.path) prev.path = r.sourcePath.trim();
      projectMap.set(k, prev);
    }

    const bpDocs = await db
      .select({ projectId: documents.projectId, relativePath: documents.relativePath, content: documents.content, syncedAt: documents.syncedAt })
      .from(documents)
      .where(and(inArray(documents.machineId, machineIds), codeBlueprintPath(documents.relativePath)))
      .orderBy(desc(documents.syncedAt))
      .limit(1000);
    const chosen = new Map<string, BlueprintCopy>();
    for (const d of bpDocs) {
      if (!d.content || !CODE_BLUEPRINT_TITLES.some((t) => d.content!.includes(t))) continue;
      const k = (d.projectId ? idToKey.get(d.projectId) : null) || (d.relativePath.includes("/") ? projectKey(d.relativePath.split("/", 1)[0]!) : "");
      if (!k) continue;
      if (!projectMap.has(k)) {
        const name = (codeBlueprintTitle(d.content) || d.relativePath.split("/", 1)[0]!).trim();
        if (isNoiseProject(name, "")) continue;
        projectMap.set(k, { name, docs: 0, last: 0, path: "", pinned: false, blueprint: null, business: null, scoped: [] as string[] });
      }
      const copy = blueprintCopy(d.content, d.syncedAt);
      const prevCopy = chosen.get(k);
      if (prevCopy && !isFresher(copy, prevCopy)) continue;
      chosen.set(k, copy);
      const p = projectMap.get(k)!;
      p.blueprint = parseProjectBlueprintMd(d.content);
      if (copy.date) {
        const ms = Date.parse(`${copy.date}T00:00:00Z`);
        if (Number.isFinite(ms)) p.codeLast = ms;
      }
    }

    const bizDocs = await db
      .select({ projectId: documents.projectId, relativePath: documents.relativePath, content: documents.content })
      .from(documents)
      .where(and(inArray(documents.machineId, machineIds), like(documents.relativePath, `%/${BUSINESS_FILE}`)))
      .orderBy(desc(documents.syncedAt))
      .limit(500);
    for (const d of bizDocs) {
      if (!d.content) continue;
      const k = (d.projectId ? idToKey.get(d.projectId) : null) || (d.relativePath.includes("/") ? projectKey(d.relativePath.split("/", 1)[0]!) : "");
      const p = k ? projectMap.get(k) : null;
      if (!p || p.business) continue;
      p.business = businessDigest(d.content);
    }
  }

  const [mems, ents, profileRow] = await Promise.all([
    db
      .select({ content: userMemories.content })
      .from(userMemories)
      .where(and(eq(userMemories.userId, user.id), eq(userMemories.status, "active"), eq(userMemories.isFolder, false)))
      .orderBy(desc(userMemories.recallCount), desc(userMemories.confidence), desc(userMemories.updatedAt))
      .limit(120),
    db
      .select({
        name: knowledgeEntities.name,
        entityType: knowledgeEntities.entityType,
        summary: knowledgeEntities.summary,
        n: sql<number>`count(${knowledgeObservations.id})`.mapWith(Number),
      })
      .from(knowledgeEntities)
      .leftJoin(knowledgeObservations, eq(knowledgeObservations.entityId, knowledgeEntities.id))
      .where(and(eq(knowledgeEntities.userId, user.id), isNull(knowledgeEntities.staleAt), notInArray(knowledgeEntities.entityType, ["file", "person"])))
      .groupBy(knowledgeEntities.id)
      .orderBy(desc(sql`count(${knowledgeObservations.id})`))
      .limit(150),
    getPublishedProfile(db, user),
  ]);

  const profileText = profileRow?.content ?? "";
  const scopes = profileText ? splitProfileScopes(profileText) : null;
  if (scopes) {
    for (const [sName, sLines] of Object.entries(scopes.projects)) {
      const k = projectKey(sName);
      if (!k || isNoiseProject(sName, "")) continue;
      const p = projectMap.get(k) ?? { name: sName.trim(), docs: 0, last: 0, path: "", pinned: false, blueprint: null, business: null, scoped: [] as string[] };
      p.pinned = true;
      p.scoped = sLines.map((l) => l.replace(/^[-*\s]+/, "").trim()).filter(Boolean);
      projectMap.set(k, p);
    }
  }

  const projEntitySummaries = new Map<string, string>();
  for (const e of ents) {
    if (e.entityType === "project" && e.summary) {
      const k = projectKey(e.name);
      if (!projEntitySummaries.has(k)) projEntitySummaries.set(k, e.summary);
    }
  }

  const allProjects: Record<string, unknown>[] = [];
  for (const [k, p] of projectMap.entries()) {
    const bp = (p.blueprint as ReturnType<typeof parseProjectBlueprintMd> | null) ?? null;
    const lastMs = Math.max(Number(p.last ?? 0), Number(p.codeLast ?? 0));
    const recent = lastMs > 0 && nowMs - lastMs < 60 * 86400_000;
    if (!(Number(p.docs) >= 2 || Boolean(p.pinned) || (bp && recent))) continue;
    const description = sanitizeSummary(bp?.about) || sanitizeSummary(projEntitySummaries.get(k));
    const techStack = (bp?.tech_stack ?? []).filter((t) => !NOISE_TECH.has(t.toLowerCase()));
    const about = `${p.name} ${sanitizeSummary(bp?.about, 400)} ${sanitizeSummary(projEntitySummaries.get(k), 400)}`.toLowerCase();
    const stack = `${techStack.join(" ")} ${(bp?.subsystems_preview ?? []).join(" ")} ${(bp?.quick ?? []).join(" ")}`.toLowerCase();
    const rulesText = (p.scoped as string[]).join(" ").toLowerCase();
    const biz = p.business as ReturnType<typeof businessDigest> | null;
    const bizText = (biz?.text ?? "").toLowerCase();
    const hAbout = fieldHits(about);
    const hStack = fieldHits(stack);
    const hRules = fieldHits(rulesText);
    const hBiz = bizText ? fieldHits(bizText) : {};
    const fids = new Set([...Object.keys(hAbout), ...Object.keys(hStack), ...Object.keys(hRules), ...Object.keys(hBiz)]);
    const weights: Record<string, number> = {};
    const mergedHits: Record<string, string[]> = {};
    for (const fid of fids) {
      const w = 2 * (hAbout[fid]?.length ?? 0) + (hStack[fid]?.length ?? 0) + 0.5 * (hRules[fid]?.length ?? 0) + 1.5 * (hBiz[fid]?.length ?? 0);
      weights[fid] = w * (GENERIC_FIELDS.has(fid) ? 0.5 : 1.0);
      mergedHits[fid] = [...new Set([...(hAbout[fid] ?? []), ...(hStack[fid] ?? [])])].sort();
    }
    const primary = [...fids].sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0))[0] ?? "";
    const rank = (Number(p.docs) + (bp ? 400 : 0) + (p.pinned ? 300 : 0)) * (recent || !lastMs ? 1.0 : 0.5);
    allProjects.push({
      key: k,
      name: p.name,
      path: p.path,
      summary: description,
      primary_field: primary,
      tech_stack: techStack,
      subsystems_count: bp?.subsystems_count ?? 0,
      models_count: bp?.models_count ?? 0,
      routes_count: bp?.routes_count ?? 0,
      subsystems_preview: bp?.subsystems_preview ?? [],
      branch: bp?.branch ?? "",
      has_blueprint: Boolean(bp),
      business: biz ? { terms: biz.terms, flows: biz.flows, rules: biz.rules, check: biz.check } : null,
      scoped_rules: (p.scoped as string[]).length,
      rank,
      docs: Number(p.docs),
      field_weights: weights,
      field_hits: mergedHits,
      text: `${about}\n${stack}\n${bizText}`,
    });
  }
  allProjects.sort((a, b) => Number(b.rank) - Number(a.rank) || Number(b.docs) - Number(a.docs));
  const topProjects = allProjects.slice(0, 40);

  const memTexts = mems.map((m) => m.content).filter(Boolean);
  const entNames = ents.map((e) => e.name).filter((n) => !isNoiseEntity(n));
  const corpus = [scopes?.general ?? "", ...memTexts, entNames.join(" "), ...topProjects.map((p) => String(p.text))].join("\n").toLowerCase();
  const corpusHits = fieldHits(corpus);

  const disciplines = FIELDS.map((f) => {
    const ev = corpusHits[f.id] ?? [];
    const primaryProjs = topProjects.filter((p) => p.primary_field === f.id).map((p) => String(p.name));
    const related = [
      ...primaryProjs,
      ...topProjects
        .filter((p) => p.primary_field !== f.id && Number((p.field_weights as Record<string, number>)[f.id] ?? 0) >= 2)
        .map((p) => String(p.name)),
    ];
    if (ev.length < 2 && !primaryProjs.length) return null;
    return {
      id: f.id,
      name: f.name,
      en_name: f.en_name,
      description: f.description,
      evidence: ev.slice(0, 8),
      projects: related.slice(0, 6),
      score: ev.length + 3 * primaryProjs.length + related.length,
    };
  })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const domains = FIELDS.map((f) => {
    const members = topProjects.filter((p) => p.primary_field === f.id);
    if (!members.length) return null;
    const described = members.filter((p) => Boolean(p.summary)).slice(0, 3);
    const scenarios = described.map((p) => `${p.name}：${truncateClean(String(p.summary), 48)}`).join("；") || f.description;
    const ev: string[] = [];
    for (const p of members) {
      for (const kw of ((p.field_hits as Record<string, string[]>)[f.id] ?? [])) if (!ev.includes(kw)) ev.push(kw);
    }
    return {
      id: `domain_${f.id}`,
      name: f.domain,
      discipline_id: f.id,
      scenarios,
      projects: members.slice(0, 6).map((p) => String(p.name)),
      evidence: ev.slice(0, 6),
      score: Math.round(members.reduce((acc, p) => acc + Number(p.rank), 0) * 10) / 10,
    };
  })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const techNamesLower = ents.filter((e) => TECH_ENTITY_TYPES.has(e.entityType)).map((e) => e.name).join(" ").toLowerCase();
  const memoriesLower = memTexts.join("\n").toLowerCase();
  const techRadar: Record<string, { label: string; items: string[] }> = {};
  for (const [catId, [label, defs]] of Object.entries(TECH_RADAR_CATEGORIES)) {
    const scored: [number, number, string][] = [];
    defs.forEach(([techName, tokens], idx) => {
      const inProjs = topProjects.filter((p) => tokens.some((t) => kwMatchesText(t, String(p.text)))).length;
      const elsewhere = [techNamesLower, memoriesLower].filter((txt) => tokens.some((t) => kwMatchesText(t, txt))).length;
      if (inProjs + elsewhere) scored.push([inProjs * 2 + elsewhere, -idx, techName]);
    });
    scored.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    techRadar[catId] = { label, items: scored.map(([, , name]) => name) };
  }

  const philosophy: Record<string, string[]> = { 核心铁律与工程底线: [], 架构与技术偏好: [], 工作流与交付准则: [] };
  if (scopes?.general) {
    let heading = "";
    for (const line of scopes.general.split("\n")) {
      const s = line.trim();
      if (s.startsWith("### ")) heading = s.replace(/^#+\s*/, "").trim();
      else if (s.startsWith("- ")) {
        const ruleText = s.slice(2).trim();
        if (heading.includes("铁律")) philosophy["核心铁律与工程底线"]!.push(ruleText);
        else if (heading.includes("技术")) philosophy["架构与技术偏好"]!.push(ruleText);
        else if (heading.includes("工作") || heading.includes("沟通")) philosophy["工作流与交付准则"]!.push(ruleText);
      }
    }
  }

  const cleanProjects = topProjects.slice(0, 15).map((p) => ({
    name: p.name,
    path: p.path,
    summary: p.summary,
    primary_field: p.primary_field,
    tech_stack: p.tech_stack,
    subsystems_count: p.subsystems_count,
    models_count: p.models_count,
    routes_count: p.routes_count,
    subsystems_preview: p.subsystems_preview,
    branch: p.branch,
    has_blueprint: p.has_blueprint,
    business: p.business,
    scoped_rules: p.scoped_rules,
  }));

  const userName = user.name || user.email || "Developer";
  const mLines = ["```mermaid", "flowchart LR", `    USER["${userName} · 数字孪生全域蓝图"]`];
  if (disciplines.length) {
    mLines.push('    subgraph DISC["学科交叉 (Disciplines)"]');
    for (const d of disciplines.slice(0, 5)) mLines.push(`        ${sanitizeMermaidId(d.id, "D")}["${d.name}"]`);
    mLines.push("    end");
    for (const d of disciplines.slice(0, 5)) mLines.push(`    USER --> ${sanitizeMermaidId(d.id, "D")}`);
  }
  if (cleanProjects.length) {
    mLines.push('    subgraph PROJ["核心工程项目 (Code Blueprints)"]');
    for (const p of cleanProjects.slice(0, 8)) mLines.push(`        ${sanitizeMermaidId(String(p.name), "P")}["${p.name}"]`);
    mLines.push("    end");
  }
  mLines.push("```");
  const mermaidTopology = mLines.join("\n");

  const nowStr = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const mdLines = [
    `# User Cognitive & Domain Blueprint: ${userName}`,
    "",
    `> Auto-Generated Living User Blueprint · Updated: \`${nowStr}\` · Projects Indexed: \`${cleanProjects.length}\` · Disciplines: \`${disciplines.length}\` · Business Domains: \`${domains.length}\``,
    "",
    "## 0. 速览 (Quick Summary)",
    "",
    ...(disciplines.length ? [`- 学科领域: ${disciplines.slice(0, 6).map((d) => d.name).join("、")}`] : []),
    ...(domains.length ? [`- 业务版图: ${domains.slice(0, 5).map((b) => `${b.name}（${b.projects.slice(0, 4).join("、")}）`).join("；")}`] : []),
    ...(cleanProjects.length ? [`- 主力项目: ${cleanProjects.slice(0, 6).map((p) => String(p.name)).join("、")}`] : []),
    ...(deviceList.length ? [`- 设备: ${deviceList.length} 台（${deviceList.filter((d) => d.online).length} 台在线）`] : []),
    "",
    "## 1. 全域认知与能力拓扑 (Cognitive & Domain Topology)",
    "",
    mermaidTopology,
    "",
  ];
  const markdown = `${mdLines.join("\n").trim()}\n`;

  const result = {
    user_name: userName,
    hash: createHash("sha256").update(markdown, "utf8").digest("hex").slice(0, 16),
    generated_at: now.toISOString().replace("Z", "+00:00"),
    disciplines,
    business_domains: domains,
    projects: cleanProjects,
    tech_radar: techRadar,
    philosophy,
    devices: deviceList,
    mermaid_topology: mermaidTopology,
    markdown,
  };
  await cacheSet(redis, key, result, CACHE_TTL_SECONDS).catch(() => {});
  return result;
}

export async function cachedUserBlueprint(redis: Redis | null, userId: string): Promise<Record<string, unknown> | null> {
  try {
    const cached = await cacheGet(redis, userBlueprintCacheKey(userId));
    if (cached && typeof cached === "object" && (cached as Record<string, unknown>).markdown) {
      return cached as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return null;
}

const warming = new Set<string>();
export function warmUserBlueprint(db: Db, redis: () => Redis | null, user: Pick<UserRow, "id">): void {
  if (warming.has(user.id)) return;
  warming.add(user.id);
  cluster.spawn(async () => {
    try {
      const [fresh] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      if (fresh) await buildUserBlueprint(db, redis(), fresh);
    } catch {
      /* ignore */
    } finally {
      warming.delete(user.id);
    }
  });
}

// Unused import guard for knowledgeRelations kept clean
void knowledgeRelations;
