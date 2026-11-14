// Assembling PROJECT_BLUEPRINT.md from the scans: the architecture diagram, every section in order,
// and section 0 (the quick summary with a line-numbered index) put in front.
import { clearRepoFileCache, exists, pjoin, pname, readTextIgnore, runGit } from "./files.js";
import { isDict, pyGet, pyLstrip, pySlice, pySplitlines, pyStrip, reMatch, reSub } from "./py.js";
import { loads } from "./pyjson.js";
import {
  detectProjectAbout,
  detectTechStack,
  detectVerificationCommands,
  generateErDiagram,
  getGitEvolution,
  scanApiRoutes,
  scanAstCallGraphAndDeps,
  scanCicdAndDeploy,
  scanCliAndEntrypoints,
  scanDataModels,
  scanEnvVariables,
  scanExternalInfra,
  scanFrontendRoutes,
  scanHotspotsAndTests,
  scanMcpAndWsProtocols,
  scanOpenapiAndDtoSchemas,
  scanServicesAndSchedules,
  scanSubsystems,
  type ApiRoute,
  type ScheduleInfo,
  type ServiceInfo,
  type Subsystem,
  type TechStack,
  type TestSuite,
} from "./scan.js";
import { BLUEPRINT_FILE, BLUEPRINT_SCRIPT_VERSION, BUSINESS_FILE, GENERATED_MARK } from "./meta.js";
import { checkBusinessBlueprint, projectBlueprintSection, summaryLine, type BusinessReport } from "./business.js";

export { BLUEPRINT_FILE, BLUEPRINT_SCRIPT_VERSION, GENERATED_MARK };


/** A high-level architectural data flow diagram in Mermaid format. */
export function generateMermaidDiagram(subsystems: Subsystem[], _stack: TechStack, infra: string[] = [], pkgEdges: string[] = []): string {
  const lines = ["```mermaid", "flowchart TD"];

  const hasWeb = subsystems.some((s) => s.name.includes("apps/web"));
  const hasDesktop = subsystems.some((s) => s.name.includes("apps/desktop"));
  const hasDaemon = subsystems.some((s) => s.name.includes("packages/daemon"));
  const hasMcp = subsystems.some((s) => s.name.includes("packages/mcp"));
  const hasServer = subsystems.some((s) => s.name === "server" || s.name.includes("server/"));
  const hasEmb = subsystems.some((s) => s.name.includes("embedding"));

  if (!(hasWeb || hasDesktop || hasDaemon || hasMcp)) {
    // Dynamic layered architecture graph for general repositories using real roles, dependencies & infra
    lines.push('    subgraph Modules["项目核心模块与子系统"]');
    const nodeMap = new Map<string, string>();
    const clientNodes: string[] = [];
    const serviceNodes: string[] = [];
    const otherNodes: string[] = [];
    subsystems.slice(0, 10).forEach((sub, idx) => {
      const nid = `M${idx}`;
      nodeMap.set(sub.path, nid);
      nodeMap.set(sub.name, nid);
      const safeLabel = sub.name.split('"').join("'");
      lines.push(`        ${nid}["${safeLabel} (${sub.type})"]`);
      const roleLow = sub.type.toLowerCase();
      if (["frontend", "client", "desktop", "web"].some((k) => roleLow.includes(k))) clientNodes.push(nid);
      else if (["backend", "api", "engine", "quant", "core", "transport"].some((k) => roleLow.includes(k))) serviceNodes.push(nid);
      else if (!["doc", "test", "container", "kubernetes", "infrastructure"].some((k) => roleLow.includes(k))) otherNodes.push(nid);
    });
    lines.push("    end");
    if (infra.length) {
      lines.push('    subgraph Infra["外部存储与中间件"]');
      infra.slice(0, 6).forEach((inf, i) => lines.push(`        INF${i}[("${inf}")]`));
      lines.push("    end");
    }
    let addedRealEdge = false;
    for (const pe of pkgEdges) {
      const m = reMatch("`([^`]+)`\\s*➔\\s*`([^`]+)`", pe);
      const src = m ? nodeMap.get(m.g(1)) : undefined;
      const dst = m ? nodeMap.get(m.g(2)) : undefined;
      if (src !== undefined && dst !== undefined) {
        lines.push(`    ${src} --> ${dst}`);
        addedRealEdge = true;
      }
    }
    if (!addedRealEdge) {
      if (clientNodes.length && serviceNodes.length) {
        for (const cn of clientNodes) lines.push(`    ${cn} --> ${serviceNodes[0]}`);
        for (const sn of serviceNodes.slice(1)) lines.push(`    ${serviceNodes[0]} --> ${sn}`);
      } else if (serviceNodes.length >= 2) {
        for (const sn of serviceNodes.slice(1)) lines.push(`    ${serviceNodes[0]} --> ${sn}`);
      } else if (serviceNodes.length && otherNodes.length) {
        for (const on of otherNodes.slice(0, 3)) lines.push(`    ${serviceNodes[0]} --> ${on}`);
      }
    }
    const primaryService = serviceNodes[0] ?? clientNodes[0] ?? (subsystems.length ? "M0" : "");
    if (infra.length && primaryService) {
      for (let i = 0; i < Math.min(infra.length, 6); i++) lines.push(`    ${primaryService} -.-> INF${i}`);
    }
    lines.push("```");
    return lines.join("\n");
  }

  lines.push('    subgraph Clients["终端与接入层"]');
  if (hasWeb) lines.push('        WEB["Web 前端 (Next.js / React)"]');
  if (hasDesktop) lines.push('        DESK["桌面客户端 (Electron)"]');
  if (hasMcp) lines.push('        MCP["Memento MCP Server (Claude/Antigravity/Codex)"]');
  lines.push("    end", "");

  if (hasDaemon) {
    lines.push('    subgraph Devices["物理设备守护层"]', '        DAEMON["@memento/daemon (节点执行器 / 文件与会话采集)"]', "    end", "");
  }

  if (hasServer || hasEmb) {
    lines.push('    subgraph CoreBackend["后端中枢与智能计算"]');
    if (hasServer) {
      lines.push('        API["FastAPI 异步主服务 (REST / SSE / WS)"]', '        CELERY["Celery 异步 Worker (会话整理 / 梦境提炼 / 任务收割)"]');
    }
    if (hasEmb) lines.push('        EMB["向量推理服务 (Embedding Pipeline)"]');
    lines.push("    end", "");
  }

  lines.push(
    '    subgraph Storage["数据持久化与缓存集群"]',
    '        PG[("PostgreSQL 向量与全量知识库 (JSONB + pgvector)")]',
    '        REDIS[("Redis 缓存 / 分布式锁 / 任务总线")]',
    "    end",
    "",
  );

  // Relationships
  if (hasWeb && hasServer) lines.push("    WEB -->|HTTP / SSE / WebSocket| API");
  if (hasDesktop && hasServer) lines.push("    DESK -->|HTTP / 自动更新通道| API");
  if (hasMcp && hasServer) lines.push("    MCP -->|API RPC 查询 / 蓝图与规则注入| API");
  if (hasDaemon && hasServer) lines.push("    DAEMON -->|长连接心跳 / 采集数据流推入 / 远程任务回传| API");
  if (hasServer) {
    lines.push(
      "    API -->|读写会话、实体、向量| PG",
      "    API -->|缓存会话字典、租约分发| REDIS",
      "    CELERY -->|异步任务编排| REDIS",
      "    CELERY -->|离线提炼、梦境知识归纳| PG",
    );
  }
  if (hasServer && hasEmb) lines.push("    API -->|文本向量化| EMB", "    CELERY -->|离线图嵌入| EMB");

  lines.push("```");
  return lines.join("\n");
}

/** The repo's display name: package.json's name without its scope, else the directory name. */
function repoName(root: string): string {
  let name = pname(root);
  const pjson = pjoin(root, "package.json");
  if (exists(pjson)) {
    try {
      const data = loads(readTextIgnore(pjson));
      if (!isDict(data)) throw new TypeError("'get' on a non-dict");
      const n = pyGet(data, "name");
      if (typeof n === "string" && n) {
        const parts = n.split("/");
        name = parts[parts.length - 1]!;
      }
    } catch {
      // not a readable manifest
    }
  }
  return name;
}

function gitBranch(root: string): string {
  let branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], root) || "main";
  if (branch === "HEAD") {
    const tagName = runGit(["describe", "--tags", "--exact-match"], root);
    const containsOut = runGit(["branch", "--contains", "HEAD", "--format=%(refname:short)"], root);
    const branchLines = pySplitlines(containsOut)
      .filter((b) => pyStrip(b) && !pyStrip(b).startsWith("("))
      .map((b) => pyStrip(b));
    branch = tagName || (branchLines[0] ?? "detached-HEAD");
  }
  return branch;
}

/** The complete PROJECT_BLUEPRINT.md document. `root` is resolved. */
export function buildBlueprintContent(root: string): string {
  clearRepoFileCache(root);
  const name = repoName(root);
  const branch = gitBranch(root);
  const commit = runGit(["rev-parse", "--short", "HEAD"], root) || "unknown";
  const date = runGit(["log", "-1", "--format=%as"], root) || "recent";

  const stack = detectTechStack(root);
  const about = detectProjectAbout(root);
  const subsystems = scanSubsystems(root);
  const frontendRoutes = scanFrontendRoutes(root);
  const routes = scanApiRoutes(root);
  const { models, relations, unique_constraints: uniqueConstraints } = scanDataModels(root);
  const erDiagram = generateErDiagram(relations);
  const { services, schedules } = scanServicesAndSchedules(root);
  const { mcp_tools: mcpTools, ws_events: wsEvents, rpc_contracts: rpcContracts } = scanMcpAndWsProtocols(root);
  const cicdItems = scanCicdAndDeploy(root);
  const { hotspots, test_suites: testSuites } = scanHotspotsAndTests(root);
  const { package_edges: pkgEdges, call_edges: callEdges } = scanAstCallGraphAndDeps(root);
  const dtoSchemas = scanOpenapiAndDtoSchemas(root);
  const cliEntries = scanCliAndEntrypoints(root);
  const infraList = scanExternalInfra(root);
  const envVars = scanEnvVariables(root);
  const mermaidDiagram = generateMermaidDiagram(subsystems, stack, infraList, pkgEdges);
  const evolutionList = getGitEvolution(root, 6);

  const doc: string[] = [
    `# Project Blueprint: ${name}`,
    "",
    "> [!NOTE]",
    `> **Living Blueprint Auto-Generated** · Branch: \`${branch}\` · Commit: \`${commit}\` · Updated: \`${date}\``,
    "> An architectural map of the codebase for AI coding agents (Claude Code, Codex, Antigravity, Cursor, ...).",
    "> Read section 0 first; open other sections by the line ranges it lists instead of reading the whole file.",
    "",
    "## 1. Project Overview & Tech Stack",
    "",
    ...(about ? [`- **About**: ${about}`] : []),
    `- **Project Type**: ${stack.project_type}`,
    `- **Core Languages**: ${stack.languages.length ? stack.languages.join(", ") : "Generic"}`,
    `- **Key Frameworks**: ${stack.frameworks.length ? stack.frameworks.join(", ") : "None detected"}`,
    `- **Infrastructure & Middleware**: ${infraList.length ? infraList.join(", ") : "Standard local runtime"}`,
    "",
    "## 2. High-Level Architecture Topology",
    "",
    mermaidDiagram,
    "",
    "## 3. Subsystem Breakdown & Responsibilities",
    "",
    "| Subsystem / Path | Category | Role & Purpose |",
    "| :--- | :--- | :--- |",
  ];

  for (const s of subsystems) doc.push(`| [\`${s.name}\`](${s.path}) | ${s.type} | ${s.description} |`);
  doc.push("");

  if (frontendRoutes.length || routes.length || models.length || relations.length || uniqueConstraints.length) {
    doc.push("## 4. Key Entry Points & API Endpoints", "");
  }

  if (frontendRoutes.length) {
    doc.push("### Frontend Pages & App Router", "");
    for (const f of frontendRoutes) doc.push(`- \`${f}\``);
    doc.push("");
  }

  if (routes.length) {
    doc.push("### Registered API Routers & Endpoints", "");
    for (const r of routes) {
      const rfile = r.file || `${r.name}.py`;
      doc.push(`#### \`${r.prefix}\` (${rfile})`);
      if (r.endpoints.length) {
        doc.push("");
        for (const ep of r.endpoints) doc.push(`- ${ep}`);
        if (r.total > r.endpoints.length) doc.push(`- _... (${r.total - r.endpoints.length} more endpoints)_`);
      }
      doc.push("");
    }
  }

  if (models.length) {
    doc.push("### Core Database Models (`models.py`)", "", models.map((m) => `\`${m}\``).join(", "), "");
  }

  if (relations.length) {
    doc.push("#### Key Entity Relationships (Foreign Keys)", "");
    if (erDiagram) doc.push(erDiagram, "");
    for (const rel of relations) doc.push(`- ${rel}`);
    doc.push("");
  }

  if (uniqueConstraints.length) {
    doc.push("#### Deduplication & Uniqueness Constraints", "");
    for (const uq of uniqueConstraints) doc.push(`- ${uq}`);
    doc.push("");
  }

  if (services.length || schedules.length) {
    doc.push("## 5. Core Domain Services & Background Schedules", "");
    if (schedules.length) {
      doc.push("### Scheduled Background Jobs (Celery Beat / Cron)", "", "| Job Name | Target Task | Schedule |", "| :--- | :--- | :--- |");
      for (const sch of schedules) doc.push(`| \`${sch.name}\` | \`${sch.task}\` | \`${sch.schedule}\` |`);
      doc.push("");
    }
    if (services.length) {
      doc.push("### Core Service Layer Modules", "", "| Service Module | Path | Responsibility |", "| :--- | :--- | :--- |");
      for (const svc of services) doc.push(`| \`${svc.name}\` | [\`${svc.path}\`](${svc.path}) | ${svc.summary} |`);
      doc.push("");
    }
  }

  if (mcpTools.length || wsEvents.length || rpcContracts.length) {
    doc.push("## 6. MCP Tools, RPC Contracts & Real-Time WebSocket Protocols", "");
    if (mcpTools.length) {
      doc.push("### Registered MCP Server Tools", "", "| Tool Name | Purpose |", "| :--- | :--- |");
      for (const mt of mcpTools) doc.push(`| \`${mt.name}\` | ${mt.description} |`);
      doc.push("");
    }
    if (rpcContracts.length) {
      doc.push("### gRPC & GraphQL Service Contracts", "");
      for (const rc of rpcContracts) doc.push(`- ${rc}`);
      doc.push("");
    }
    if (wsEvents.length) {
      doc.push("### WebSocket Control & Data Plane Events", "", wsEvents.map((ev) => `\`${ev}\``).join(", "), "");
    }
  }

  if (pkgEdges.length || callEdges.length || dtoSchemas.length || cliEntries.length) {
    doc.push("## 6.5. AST Call Graph, DTO Schemas & CLI Entrypoints", "");
    if (pkgEdges.length) {
      doc.push("### Workspace Package Dependency Graph", "");
      for (const pe of pkgEdges) doc.push(`- ${pe}`);
      doc.push("");
    }
    if (callEdges.length) {
      doc.push("### AST Cross-Layer Call & Import Graph (Entry ➔ Service / Store)", "");
      for (const ce of callEdges) doc.push(`- ${ce}`);
      doc.push("");
    }
    if (dtoSchemas.length) {
      doc.push(
        "### Key Request / Response DTO & OpenAPI Schemas",
        "",
        "| Schema Name | Type | Source File | Core Fields |",
        "| :--- | :--- | :--- | :--- |",
      );
      for (const ds of dtoSchemas) doc.push(`| \`${ds.name}\` | ${ds.kind} | [\`${ds.source}\`](${ds.source}) | ${ds.fields} |`);
      doc.push("");
    }
    if (cliEntries.length) {
      doc.push("### CLI Binaries & Automation Entrypoints", "", "| Command / Script | Category | Path / Target |", "| :--- | :--- | :--- |");
      for (const ce of cliEntries) doc.push(`| \`${ce.name}\` | ${ce.kind} | \`${ce.path}\` |`);
      doc.push("");
    }
  }

  if (cicdItems.length || hotspots.length || testSuites.length) {
    doc.push("## 7. CI/CD Pipelines, Code Hotspots & Test Suites", "");
    if (cicdItems.length) {
      doc.push("### CI/CD Workflows & Deployment Manifests", "", "| Category | Name | Path | Details |", "| :--- | :--- | :--- | :--- |");
      for (const ci of cicdItems) doc.push(`| ${ci.kind} | \`${ci.name}\` | [\`${ci.path}\`](${ci.path}) | ${ci.details} |`);
      doc.push("");
    }
    if (testSuites.length) {
      doc.push("### Automated Test Suite Matrix", "", "| Suite | Directory | Files | Sample Tests |", "| :--- | :--- | :--- | :--- |");
      for (const ts of testSuites) doc.push(`| ${ts.suite} | [\`${ts.dir}\`](${ts.dir}) | ${ts.count} | ${ts.samples} |`);
      doc.push("");
    }
    if (hotspots.length) {
      doc.push("### Architectural Hotspots (Top Modified Files in Recent 40 Commits)", "");
      for (const hs of hotspots) doc.push(`- [\`${hs.path}\`](${hs.path}) (${hs.commits} commits)`);
      doc.push("");
    }
  }

  doc.push(
    "## 8. Development & Verification Commands",
    "",
    "```bash",
    ...detectVerificationCommands(root),
    "```",
    "",
    "## 9. Recent Architectural Evolutions",
    "",
  );

  if (evolutionList.length) doc.push(...evolutionList);
  else doc.push("- Initial project baseline established.");

  if (envVars.length) {
    doc.push("", "## 10. Key Environment Variables & Configuration", "", "| Variable | Default / Status | Description |", "| :--- | :--- | :--- |");
    for (const ev of envVars.slice(0, 20)) doc.push(`| \`${ev.name}\` | \`${ev.default}\` | ${ev.description} |`);
  }

  // The business blueprint, when the repo has one: how its rules hold against this code
  const business = checkBusinessBlueprint(root);
  if (business) doc.push("", ...projectBlueprintSection(business));

  doc.push(
    "",
    "---",
    `${GENERATED_MARK} (v${BLUEPRINT_SCRIPT_VERSION}) & \`.git/hooks/(post-commit, post-merge, post-checkout)\`. Updates automatically on code modifications, pulls, and branch switches._`,
    "",
  );

  const summary = quickSummary({
    stack,
    infra: infraList,
    subsystems,
    routes,
    frontendRoutes,
    models,
    services,
    schedules,
    testSuites,
    commands: detectVerificationCommands(root),
    evolution: evolutionList,
    about,
    business,
  });
  return withSummaryAndIndex(doc, summary);
}

interface SummaryInput {
  stack: TechStack;
  infra: string[];
  subsystems: Subsystem[];
  routes: ApiRoute[];
  frontendRoutes: string[];
  models: string[];
  services: ServiceInfo[];
  schedules: ScheduleInfo[];
  testSuites: TestSuite[];
  commands: string[];
  evolution: string[];
  about: string;
  business: BusinessReport | null;
}

/** The few lines that orient an agent without reading the rest. */
function quickSummary(x: SummaryInput): string[] {
  const langs = x.stack.languages.join(", ") || "Generic";
  const frameworks = x.stack.frameworks.slice(0, 8).join(", ");
  const lines = [
    ...(x.about ? [`- 简介 (About): ${x.about}`] : []),
    `- 类型 (Type): ${x.stack.project_type || "Generic"}`,
    `- 技术栈 (Stack): ${langs}` + (frameworks ? ` · ${frameworks}` : ""),
  ];
  if (x.infra.length) lines.push(`- 基础设施 (Infra): ${x.infra.slice(0, 8).join(", ")}`);
  const scale = [`${x.subsystems.length} 个子系统`];
  if (x.routes.length) {
    const endpoints = x.routes.reduce((n, r) => n + (r.total || 0), 0);
    scale.push(`${x.routes.length} 组 API 路由 / ${endpoints} 个接口`);
  }
  if (x.frontendRoutes.length) scale.push(`${x.frontendRoutes.length} 个前端页面`);
  if (x.models.length) scale.push(`${x.models.length} 个数据模型`);
  if (x.services.length) scale.push(`${x.services.length} 个服务模块`);
  if (x.schedules.length) scale.push(`${x.schedules.length} 个定时任务`);
  const tests = x.testSuites.reduce((n, ts) => n + (ts.count || 0), 0);
  if (tests) scale.push(`${tests} 个测试文件`);
  lines.push(`- 规模 (Scale): ${scale.join(" · ")}`);
  const names = x.subsystems
    .filter((s) => s.name)
    .map((s) => s.name)
    .slice(0, 12);
  if (names.length) lines.push(`- 子系统 (Subsystems): ${names.map((n) => `\`${n}\``).join(", ")}`);
  const runnable = x.commands
    .filter((c) => pyStrip(c) && !pyLstrip(c).startsWith("#"))
    .map((c) => pyStrip(c))
    .slice(0, 4);
  if (runnable.length) lines.push(`- 自测命令 (Verify): ${runnable.map((c) => `\`${c}\``).join(" ; ")}`);
  if (x.evolution.length) lines.push(`- 最近改动 (Latest): ${pySlice(pyStrip(pyLstrip(x.evolution[0]!, "- ")), 0, 160)}`);
  if (x.business) {
    const b = x.business;
    const touched = [...new Set(b.impact.slice(0, 3).flatMap((it) => it.ids))].slice(0, 8);
    lines.push(
      `- 业务蓝图 (Business): \`${BUSINESS_FILE}\` · ${summaryLine(b)}${b.fails ? ` · ❌ ${b.fails} 条失效/违规` : ""}` +
        (touched.length ? ` · 最近提交碰到 ${touched.map((id) => `\`${id}\``).join(", ")}` : ""),
    );
  }
  return lines;
}

/** Put section 0 (the summary and a line-numbered index of every other section) before section 1. */
function withSummaryAndIndex(docLines: string[], summary: string[]): string {
  const doc = docLines.join("\n").split("\n"); // diagrams are one entry spanning many lines
  let first = doc.findIndex((line) => line.startsWith("## "));
  if (first < 0) first = doc.length;
  const headings = doc.slice(first).filter((line) => line.startsWith("## ")).length;
  const block = [
    "## 0. 速览与章节索引 (Quick Summary & Section Index)",
    "",
    "> 先读这一节定位全局；要细节时按下表行号只读对应章节（Read 的 offset/limit，或 `sed -n 'A,Bp' PROJECT_BLUEPRINT.md`），不必整份读入。",
    "",
    ...summary,
    "",
    "| 章节 (Section) | 行号 (Lines) |",
    "| :--- | :--- |",
  ];
  const rowsAt = first + block.length;
  for (let i = 0; i < headings; i++) block.push("");
  block.push("");
  const out = [...doc.slice(0, first), ...block, ...doc.slice(first)];
  const starts: number[] = [];
  for (let i = rowsAt + headings; i < out.length; i++) if (out[i]!.startsWith("## ")) starts.push(i);
  let footer = out.lastIndexOf("---");
  if (footer < 0) footer = out.length;
  starts.forEach((start, n) => {
    let end = (n + 1 < starts.length ? starts[n + 1]! : footer) - 1;
    while (end > start && !pyStrip(out[end]!)) end--;
    const title = reSub("^##\\s+", "", out[start]!);
    out[rowsAt + n] = `| ${title} | L${start + 1}-L${end + 1} |`;
  });
  return out.join("\n");
}
