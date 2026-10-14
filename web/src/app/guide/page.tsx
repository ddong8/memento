"use client";

import { useState } from "react";
import Link from "next/link";
import { Glass, Btn, Chip } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";

type DocTab = "all" | "desktop" | "docker" | "mcp" | "k8s" | "ops";

const QUICK_SNIPPETS = {
  installScript: `# 一键自动化安装向导 (macOS / Linux)
chmod +x install.sh
./install.sh`,
  dockerCompose: `# 极速单机启动核心服务
docker compose up -d --build`,
  claudeMcp: `{
  "mcpServers": {
    "memento-memory": {
      "command": "uvx",
      "args": [
        "memento-brain-memory",
        "--server-url", "https://mem.yourdomain.com",
        "--token", "your_collector_token"
      ]
    }
  }
}`,
  cursorMcp: `Command: uvx
Args: ["memento-brain-memory", "--server-url", "https://mem.yourdomain.com", "--token", "your_collector_token"]`,
};

const DOCS_MARKDOWN = `# Memento 完整自托管与生产部署指南

> **作者**：董海星（ddong8）  
> **开源地址**：[https://github.com/ddong8/memento](https://github.com/ddong8/memento)  
> **适用版本**：Memento 1.0+

---

## 一、项目概述与架构设计

**Memento** 是一个专为 AI 时代设计的**个人记忆网络与智能体编排工作台**。它能在本地自动监听并增量采集各大 AI 编程工具（Claude Code、OpenAI Codex、Google Antigravity、Cursor、WorkBuddy 等）的对话与交互过程，经本地脱敏后同步至自建服务端，提供：
- 🔍 **双通道混合检索**：基于 BGE-M3 Dense 语义向量 + 全文分词的混合检索；
- 🕸️ **自动化知识图谱**：提取实体、关系、反思与经验画像；
- 🔗 **全协议 MCP 支持**：通过标准 Model Context Protocol，让所有 AI IDE 具备个人长短期记忆读写能力；
- 📊 **智能体原生配额监控**：实时探测本地各 AI 订阅计划、滑动限流窗口与模型额度。

---

## 二、部署方案选型

Memento 支持两种主流部署形态，可按需选择：

| 方案 | 适用场景 | 复杂度 | 核心技术栈 |
| :--- | :--- | :--- | :--- |
| **方案 A：Docker Compose 一键单机部署** | 个人开发机、局域网私有云、云服务器单机 | ⭐ 简单快捷 | Docker Compose, Postgres 16, Redis 7, MinIO |
| **方案 B：Kubernetes (k3s) GitOps 持续部署** | 家用 NAS 集群、高可用生产环境、公开域名访问 | ⭐⭐⭐ 生产级 | k3s, Rancher Fleet, GHCR, Kustomize |

---

## 三、方案 A：Docker Compose 极速单机部署（推荐）

适合绝大多数个人开发者及私有单机环境，全套基础设施开箱即用。

### 1. 环境准备
- **操作系统**：macOS / Linux / Windows WSL2
- **依赖软件**：
  - Docker 24.0+ 与 Docker Compose v2.20+
  - Python 3.11+（用于执行初始化向导与服务自检）
  - 机器内存建议 ≥ 4GB（启用本地 BGE-M3 向量模型建议 ≥ 8GB）

### 2. 获取代码与一键安装向导

\`\`\`bash
# 1. 克隆代码仓库
git clone https://github.com/ddong8/memento.git
cd memento

# 2. 运行一键安装向导 (macOS / Linux)
chmod +x install.sh
./install.sh
\`\`\`
> **Windows 用户**：在 PowerShell 中直接运行 \`python scripts/install.py\` 即可。

安装向导将全自动完成：
1. **配置文件生成**：自动生成包含强随机密钥的 \`.env\`；
2. **环境预检**：检查 Docker、端口占用与系统环境；
3. **编排启动**：自动拉起 Postgres、Redis、MinIO、API、Worker、Beat 与 Web 容器；
4. **健康探测**：等待核心接口 \`/health\` 准备就绪；
5. **初始化管理员**：引导设置首个管理员账号与凭据 Token。

---

### 3. 环境变量关键配置 (\`.env\`)

若需进一步定制，可参考以下配置说明：

\`\`\`bash
# ------------------------------
# 基础服务与数据库
# ------------------------------
POSTGRES_PASSWORD=your_secure_password
MEMENTO_SECRET_KEY=generate_a_random_32_byte_secret_key
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=your_secure_minio_password

# ------------------------------
# 采集端安全通信
# ------------------------------
MEMENTO_COLLECTOR_TOKEN=your_device_collector_token

# ------------------------------
# 大模型配置（用于会话反思、知识抽取与每日总结）
# ------------------------------
MEMENTO_AI_BASE_URL=https://api.openai.com/v1     # 兼容通义千问、Kimi、DeepSeek 等 OpenAI 格式接口
MEMENTO_AI_API_KEY=sk-xxxxxx
MEMENTO_AI_MODEL=kimi-k2.5                       # 推荐 qwen-plus / kimi-k2.5 / glm-4-plus / gpt-4o

# ------------------------------
# 语义向量模型端点
# ------------------------------
MEMENTO_EMBEDDING_SERVER_URL=http://embedding:8002
\`\`\`

---

### 4. 语义向量服务（BGE-M3 Embedding）

语义检索支持两种运行模式：

#### 模式 1：Docker 容器运行（CPU 模式，通用便携）
\`\`\`bash
./install.sh embedding
# 或通过 Docker Profile 启动：
docker compose --profile embedding up -d --build embedding
\`\`\`

#### 模式 2：宿主机原生运行（GPU / Apple Silicon MPS 加速）
若宿主机搭载 NVIDIA 显卡或 Apple M 系列芯片，原生运行可提供数倍的吞吐效率：
\`\`\`bash
./install.sh embedding --native
\`\`\`
原生服务监听宿主机 \`8002\` 端口，容器内部会自动映射访问。

---

### 5. 状态检查与服务自检

执行内置健康探测工具：
\`\`\`bash
./install.sh doctor
\`\`\`

各项组件正常运行时，即可打开浏览器访问：
- 🌐 **Web 控制台**：\`http://localhost:3001\`
- 🔌 **API 文档 (Swagger)**：\`http://localhost:8001/docs\`
- 🗄️ **MinIO 管理后台**：\`http://localhost:9001\`

---

## 四、方案 B：Kubernetes (k3s) GitOps 持续部署

适用于长期运行在家用 NAS（如 TrueNAS、群晖）或私有云服务器的高可用场景。Memento 官方采用了完全闭环的 **GitOps 交付流**：

### 1. 核心架构亮点
- **Pull 式单向同步**：Fleet 运行在内网集群内部主动拉取，不需要公网暴露集群 API 端口，穿透 NAT 极其稳定；
- **配置与凭据严格隔离**：公开 Git 仓库只存放 Kustomize 声明清单，所有敏感密钥统一保留在集群命名空间的 \`memento-secret\` 中。

---

### 2. 集群初始化与密钥配置

\`\`\`bash
# 1. 创建命名空间
kubectl create namespace memento

# 2. 注入核心凭据 Secret (一次性操作)
kubectl -n memento create secret generic memento-secret \\
  --from-literal=MEMENTO_SECRET_KEY="your_production_secret" \\
  --from-literal=MEMENTO_COLLECTOR_TOKEN="your_collector_token" \\
  --from-literal=POSTGRES_PASSWORD="your_db_password" \\
  --from-literal=MINIO_ROOT_USER="minioadmin" \\
  --from-literal=MINIO_ROOT_PASSWORD="your_minio_password" \\
  --from-literal=MEMENTO_AI_API_KEY="sk-xxxxxx" \\
  --from-literal=MEMENTO_DATABASE_URL="postgresql+asyncpg://postgres:your_db_password@memento-postgres:5432/memento" \\
  --from-literal=MEMENTO_REDIS_URL="redis://memento-redis:6379/0"

# 3. (可选) 配置 GitHub OAuth 登录支持
kubectl -n memento patch secret memento-secret --type merge -p \\
  '{"stringData":{"MEMENTO_GITHUB_CLIENT_ID":"your_id","MEMENTO_GITHUB_CLIENT_SECRET":"your_secret"}}'
\`\`\`

---

### 3. 配置 Fleet 纳管 GitOps 仓库

在 Fleet 控制命名空间（通常为 \`fleet-local\`）中应用如下配置：

\`\`\`yaml
# fleet-repo.yaml
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: memento
  namespace: fleet-local
spec:
  repo: https://github.com/ddong8/memento.git
  branch: main
  paths:
    - deploy/k8s
  targetNamespace: memento
\`\`\`
\`\`\`bash
kubectl apply -f fleet-repo.yaml
\`\`\`

集群内的 Fleet 会自动部署并管理 \`deploy/k8s/\` 目录下的所有资源（API、Celery、Web、Ingress）。

---

## 五、连接终端：客户端与 MCP 记忆无缝接入

服务端部署完毕后，终端设备的接入流程极为轻量便捷：

### 1. 方式一：安装桌面客户端（最推荐，全自动静默托管）

Memento 桌面客户端已将采集守护进程（\`DaemonHost\`）原生打包集成。

1. **安装客户端**：
   - **macOS**：下载并安装 \`Memento-macos-arm64.zip\` 或 \`.dmg\`；
   - **Windows**：下载并运行 \`Memento-windows-x64.zip\`。
2. **连接服务端**：
   - 首次启动桌面端，在设置中填入你的自建服务端地址（如 \`https://mem.yourdomain.com\` 或内网 IP）；
   - 使用已创建的管理员账号登录。
3. **开箱即用，静默采集**：
   - 登录成功的瞬间，客户端**会自动为当前设备生成凭据、自动配置监听目录、自动拉起常驻采集子进程**；
   - 系统托盘实时显示：\`● 采集运行中\`；
   - 本地使用 Claude Code、Codex、Antigravity、Cursor、WorkBuddy 编写代码和对话时，所有上下文均自动脱敏并增量同步。

---

### 2. 方式二：纯终端 / 无图形界面服务器接入（Headless 独立模式）

在无桌面界面的远程 Linux 主机或远程开发容器（DevContainer）中：

\`\`\`bash
# 1. 全局安装轻量守护进程
npm install -g @memento/daemon

# 2. 配置并绑定服务端
memento-daemon configure \\
  --server https://mem.yourdomain.com \\
  --token your_collector_token

# 3. 启动后台常驻监听（自动注册为系统 systemd / launchd 服务）
memento-daemon start
\`\`\`

---

### 3. 为各大 AI 工具接入 MCP 记忆大脑

#### 接入 Claude Code
在 \`~/.claude/claude_desktop_config.json\` 或项目级 \`.claude.json\` 中添加：
\`\`\`json
{
  "mcpServers": {
    "memento-memory": {
      "command": "uvx",
      "args": [
        "memento-brain-memory",
        "--server-url", "https://mem.yourdomain.com",
        "--token", "your_collector_token"
      ]
    }
  }
}
\`\`\`

#### 接入 Cursor / Windsurf / Antigravity
在 IDE 的 MCP 配置面板中新增 Command：
- **Command**: \`uvx\`
- **Args**: \`["memento-brain-memory", "--server-url", "https://mem.yourdomain.com", "--token", "your_collector_token"]\`

接入后，AI 即可在对话中主动调用：
- \`memory_search\`：语义搜索过往记忆、架构决策与踩坑记录；
- \`memory_recall\`：分类快速召回规矩和偏好；
- \`todo_list\` / \`todo_add\`：沉淀当前会话的后续待办。

---

## 六、生产运维与调优最佳实践

### 1. 数据库防挂死调优（PostgreSQL 16）
长期运行大量异步总结与嵌入更新时，容易出现未释放的事务持有行级锁。必须显式设置：
\`\`\`sql
-c max_connections=200
-c idle_in_transaction_session_timeout=60000   -- 超过 60 秒空闲未提交的事务强制释放
-c statement_timeout=120000                   -- 慢查询 120 秒超时拦截
-c log_lock_waits=on                          -- 打印排队死锁日志
\`\`\`

### 2. 容器异常自动拉起
为关键容器（\`api\`、\`celery-worker\`、\`web\`）显式添加 \`restart: unless-stopped\`，防止大批量日志解析发生 OOM（Exit 137）时服务意外停机。

### 3. 自动化冷备归档
- **PostgreSQL 数据库**：通过 \`docker exec memento_postgres pg_dump\` 导出冷备；
- **MinIO 对象存储**：每日通过 Celery 计划任务将全量快照自动加密归档至外部 S3 存储桶。
`;

export default function DocsPage() {
  const [activeTab, setActiveTab] = useState<DocTab>("all");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    }).catch(() => {});
  };

  return (
    <div className="w-full max-w-5xl mx-auto pb-20 px-4 sm:px-6">
      {/* Top Banner & Header */}
      <div className="mb-8 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
          <div className="flex items-center gap-3">
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                background: "linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(168, 85, 247, 0.2))",
                border: "1px solid var(--aurora-border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--aurora-accent)",
              }}
            >
              <Icon name="book" size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl sm:text-2xl font-bold text-[var(--aurora-fg1)]">
                  Memento 部署与接入文档中心
                </h1>
                <Chip tone="accent">v1.0 官方指南</Chip>
              </div>
              <p className="text-xs sm:text-sm text-[var(--aurora-fg3)] mt-0.5">
                覆盖服务端自托管、桌面客户端自动采集托管以及全平台 AI 工具 MCP 记忆网络接入
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/profile?tab=devices"
              className="text-xs px-3 py-1.5 rounded-lg bg-[var(--aurora-chip)] border border-[var(--aurora-border)] text-[var(--aurora-fg2)] hover:text-[var(--aurora-fg1)] hover:border-[var(--aurora-accent)] transition-all flex items-center gap-1.5"
            >
              <Icon name="devices" size={13} />
              <span>查看我的设备</span>
            </Link>
          </div>
        </div>

        {/* Quick Snippet Cards Banner */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
          <Glass padding="14px" radius={14} className="flex flex-col justify-between">
            <div>
              <div className="text-xs font-semibold text-[var(--aurora-fg1)] flex items-center gap-1.5 mb-1">
                <Icon name="rocket" size={13} style={{ color: "#38BDF8" }} />
                <span>一键安装命令</span>
              </div>
              <div className="text-[11px] text-[var(--aurora-fg4)] font-mono truncate">
                ./install.sh
              </div>
            </div>
            <button
              type="button"
              onClick={() => copyToClipboard(QUICK_SNIPPETS.installScript, "install")}
              className="mt-3 text-[11px] py-1 px-2 rounded bg-[var(--aurora-chip)] hover:bg-[var(--aurora-accent-soft)] hover:text-[var(--aurora-accent)] text-[var(--aurora-fg3)] border border-[var(--aurora-border)] transition-all flex items-center justify-between"
            >
              <span>{copiedKey === "install" ? "✓ 已复制" : "复制命令"}</span>
              <Icon name="copy" size={11} />
            </button>
          </Glass>

          <Glass padding="14px" radius={14} className="flex flex-col justify-between">
            <div>
              <div className="text-xs font-semibold text-[var(--aurora-fg1)] flex items-center gap-1.5 mb-1">
                <Icon name="cube" size={13} style={{ color: "#10B981" }} />
                <span>Docker 极速启动</span>
              </div>
              <div className="text-[11px] text-[var(--aurora-fg4)] font-mono truncate">
                docker compose up -d
              </div>
            </div>
            <button
              type="button"
              onClick={() => copyToClipboard(QUICK_SNIPPETS.dockerCompose, "docker")}
              className="mt-3 text-[11px] py-1 px-2 rounded bg-[var(--aurora-chip)] hover:bg-[var(--aurora-accent-soft)] hover:text-[var(--aurora-accent)] text-[var(--aurora-fg3)] border border-[var(--aurora-border)] transition-all flex items-center justify-between"
            >
              <span>{copiedKey === "docker" ? "✓ 已复制" : "复制命令"}</span>
              <Icon name="copy" size={11} />
            </button>
          </Glass>

          <Glass padding="14px" radius={14} className="flex flex-col justify-between">
            <div>
              <div className="text-xs font-semibold text-[var(--aurora-fg1)] flex items-center gap-1.5 mb-1">
                <Icon name="sparkles" size={13} style={{ color: "#D97706" }} />
                <span>Claude Code MCP 配置</span>
              </div>
              <div className="text-[11px] text-[var(--aurora-fg4)] truncate">
                ~/.claude.json
              </div>
            </div>
            <button
              type="button"
              onClick={() => copyToClipboard(QUICK_SNIPPETS.claudeMcp, "claude")}
              className="mt-3 text-[11px] py-1 px-2 rounded bg-[var(--aurora-chip)] hover:bg-[var(--aurora-accent-soft)] hover:text-[var(--aurora-accent)] text-[var(--aurora-fg3)] border border-[var(--aurora-border)] transition-all flex items-center justify-between"
            >
              <span>{copiedKey === "claude" ? "✓ 已复制" : "复制 JSON"}</span>
              <Icon name="copy" size={11} />
            </button>
          </Glass>

          <Glass padding="14px" radius={14} className="flex flex-col justify-between">
            <div>
              <div className="text-xs font-semibold text-[var(--aurora-fg1)] flex items-center gap-1.5 mb-1">
                <Icon name="terminal" size={13} style={{ color: "#818CF8" }} />
                <span>Cursor / Windsurf MCP</span>
              </div>
              <div className="text-[11px] text-[var(--aurora-fg4)] truncate">
                uvx memento-brain-memory
              </div>
            </div>
            <button
              type="button"
              onClick={() => copyToClipboard(QUICK_SNIPPETS.cursorMcp, "cursor")}
              className="mt-3 text-[11px] py-1 px-2 rounded bg-[var(--aurora-chip)] hover:bg-[var(--aurora-accent-soft)] hover:text-[var(--aurora-accent)] text-[var(--aurora-fg3)] border border-[var(--aurora-border)] transition-all flex items-center justify-between"
            >
              <span>{copiedKey === "cursor" ? "✓ 已复制" : "复制配置"}</span>
              <Icon name="copy" size={11} />
            </button>
          </Glass>
        </div>
      </div>

      {/* Main Documentation Viewer Container */}
      <Glass padding="24px" radius={20} className="relative shadow-xl">
        {/* Markdown Document Stream / Viewer */}
        <div className="prose prose-sm sm:prose max-w-none text-[var(--aurora-fg2)]">
          <MarkdownViewer content={DOCS_MARKDOWN} />
        </div>
      </Glass>
    </div>
  );
}
