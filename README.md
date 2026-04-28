<div align="center">

# Memento

**给你的 AI 工具建个共享大脑**

跨设备、跨工具自动采集 AI 编程对话与记忆,自建后端汇总,Web + MCP 统一查看、搜索、召回。

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Python ≥3.10](https://img.shields.io/badge/python-≥3.10-blue.svg)](#技术栈)
[![Next.js 16](https://img.shields.io/badge/next.js-16-black.svg)](#技术栈)
[![PyPI - memento-brain](https://img.shields.io/pypi/v/memento-brain?label=memento-brain)](https://pypi.org/project/memento-brain/)
[![PyPI - memento-brain-collector](https://img.shields.io/pypi/v/memento-brain-collector?label=collector)](https://pypi.org/project/memento-brain-collector/)
[![PyPI - memento-brain-memory](https://img.shields.io/pypi/v/memento-brain-memory?label=mcp-memory)](https://pypi.org/project/memento-brain-memory/)

[快速开始](#-快速开始) · [架构](#️-架构) · [支持的工具](#-支持的-ai-工具) · [自部署](#-自托管部署) · [MCP 接入](#-mcp-记忆服务)

🌐 **Languages**: [中文](README.md) · [English](README.en.md)

</div>

---

## ✨ 它能做什么

- 🧠 **跨设备同步对话** — Mac / Linux / Windows 上的 Claude Code / Codex / Cursor / Antigravity 等工具,聊过的内容统一汇总
- 🔍 **混合检索** — BGE-M3 向量 + jieba 分词的全文索引,中英文都能搜
- 🔗 **MCP 接入** — 在任何 AI IDE 里通过 MCP 直接调 `memory_search` / `memory_recall` / `daily_summary`,Claude 自己就能查你过去做的事
- 📅 **AI 日报** — 每日自动汇总跨工具的活动 + LLM 摘要,记得自己今天干了什么
- 🌐 **公开分享** — 项目时间线 / 日报一键生成 share 链接,带 GeoIP 访客统计
- 🛡️ **完全自托管** — Docker Compose 一键起,Postgres + Redis + MinIO 全在你机器上,数据不出门
- 🔐 **多租户隔离** — 多用户独立空间,owner / admin / viewer 三级角色 + 细粒度授权
- ⚡ **守护进程级** — 设备上跑成 launchd / systemd / Task Scheduler,断网离线队列、自愈重试

## 🏗️ 架构

```mermaid
graph TB
    subgraph DEV["📱 用户设备 Mac/Linux/Windows"]
        direction LR
        CC["Claude Code<br/>~/.claude"]
        CDX["Codex<br/>~/.codex"]
        CUR["Cursor<br/>~/.cursor"]
        AG["Antigravity<br/>~/.gemini/antigravity"]
        OC["OpenClaw<br/>~/.openclaw"]
        OBS["Obsidian Vault"]
        COL["memento-brain-collector<br/>watchdog 监听<br/>SQLite 离线队列<br/>sanitizer 入队脱敏"]
        CC --- COL
        CDX --- COL
        CUR --- COL
        AG --- COL
        OC --- COL
        OBS --- COL
    end

    subgraph SRV["☁️ 自托管 Memento 服务端"]
        direction TB
        NGX["nginx<br/>HTTPS + gzip"]

        subgraph DK["Docker Compose"]
            direction LR
            API["FastAPI :8000"]
            WEB["Next.js Web :3000"]
            CW["Celery Worker"]
            CB["Celery Beat"]
            PG[("PostgreSQL 16<br/>+ pgvector")]
            RD[("Redis 7")]
            S3[("MinIO<br/>S3 兼容")]
        end

        EMB["BGE-M3 Embedding<br/>:8002 宿主进程"]

        NGX --> API
        NGX --> WEB
        API <--> PG
        API <--> RD
        API <--> S3
        API -.调用.-> EMB
        CW <--> PG
        CW <--> RD
        CB --> CW
    end

    subgraph CLT["🤖 AI 工具 MCP 客户端"]
        direction LR
        MCC["Claude Code"]
        MCDX["Codex"]
        MCUR["Cursor"]
        MAG["Antigravity"]
    end

    MCP["memento-brain-memory<br/>MCP Server"]
    MCC --> MCP
    MCDX --> MCP
    MCUR --> MCP
    MAG --> MCP

    COL ==>|"HTTPS + collector token"| NGX
    MCP ==>|"HTTPS + JWT"| NGX

    subgraph PUB["🌍 公开访问"]
        SHARE["分享链接 /s/&lt;token&gt;"]
        GEO["GeoIP DB<br/>访客统计"]
    end
    NGX --> SHARE
    SHARE --> GEO

    classDef device fill:#fef3c7,stroke:#d97706,color:#92400e
    classDef server fill:#dbeafe,stroke:#2563eb,color:#1e40af
    classDef client fill:#fce7f3,stroke:#db2777,color:#831843
    classDef public fill:#dcfce7,stroke:#16a34a,color:#14532d
    class CC,CDX,CUR,AG,OC,OBS,COL device
    class API,WEB,CW,CB,PG,RD,S3,EMB,NGX server
    class MCC,MCDX,MCUR,MAG,MCP client
    class SHARE,GEO public
```

### 数据流(单条对话从产生到可搜)

```mermaid
sequenceDiagram
    participant T as AI 工具
    participant W as 本地文件
    participant C as Collector
    participant Q as SQLite 队列
    participant A as API
    participant P as Postgres
    participant E as Embedding
    participant M as MCP

    T->>W: 写 .jsonl 对话
    W->>C: watchdog 文件事件
    C->>C: 解析 + 脱敏
    C->>Q: 入离线队列
    Q->>A: HTTPS POST(失败重试)
    A->>P: 写 documents / conversation_messages / content_tsv
    A-->>E: 异步算 embedding
    E->>P: 写 document_embeddings (pgvector)
    A-->>P: LLM 抽 entities / relations
    Note over M: 用户在 Claude Code 里调 memory_search
    M->>A: GET /api/memory/semantic
    A->>E: 算 query embedding
    E->>P: cosine_distance 排序
    P-->>M: 返回相关 chunk
```

## 🧰 支持的 AI 工具

| 工具 | 采集内容 | 格式 |
|------|---------|------|
| **Claude Code** | 对话、记忆、计划、历史 | JSONL / Markdown |
| **OpenClaw** | 对话会话、身份、记忆、学习、技能 | JSONL / Markdown |
| **Codex** | 对话、历史、技能、状态 | JSONL / TOML / SQLite |
| **Antigravity** | 完整对话(内置解密 `.pb`)、计划、代码快照 | Protobuf / Markdown |
| **Obsidian** | 所有笔记 | Markdown |
| **Cursor** | 对话、技能、MCP 配置 | JSONL / Markdown |

## 🚀 快速开始

### 一键安装(推荐)

```bash
# macOS / Linux
curl -fsSL https://mem.ihasy.com/install.sh | sh

# Windows (PowerShell)
iwr https://mem.ihasy.com/install.ps1 -useb | iex
```

也可以浏览器打开 <https://mem.ihasy.com/install> 拿复制好的命令。脚本会下载仓库到 `~/memento/`(可用 `MEMENTO_INSTALL_DIR` 覆盖),然后跑内置 `./install.sh`。

### 已 clone 仓库

```bash
git clone https://github.com/ddong8/memento.git && cd memento
./install.sh            # macOS / Linux
.\install.ps1           # Windows
```

`install.sh` 自动完成:

1. 生成 `.env` 随机密钥(JWT / collector token / MinIO / Postgres 密码)
2. `docker compose up -d --build` 起 7 个容器
3. 探活 API `/health`
4. 交互提示创建第一个用户(自动 owner,拿 collector_token)
5. `pip install memento-brain-collector` + setup + 注册系统服务

可选参数:

| 命令 | 说明 |
|---|---|
| `./install.sh embedding` | 装宿主 BGE-M3 服务(~1.3 GB,语义搜索 / MCP 召回必需) |
| `./install.sh doctor` | 检查所有服务状态 |
| `./install.sh update` | git pull + 重建 + 升级 |
| `./install.sh uninstall` | 停服务,保留数据和配置 |
| `./install.sh uninstall --purge` | 同上 + 清 Docker 数据卷 + `.env` |
| `./install.sh uninstall --all` | 核弹级:pip 包 / `~/.memento` / 模型缓存 / Docker 镜像 / MCP 配置 全清 |

### 服务端口

| 端口 | 服务 |
|---|---|
| **8001** | API (Swagger: `/docs`) |
| **3001** | Web UI |
| 8002 | Embedding(宿主) |
| 5433 | PostgreSQL |
| 6380 | Redis |
| 9000 / 9001 | MinIO / 控制台 |

> 端口与常见项目错开,避免冲突。

## 💻 在额外设备上接入

```bash
pip install memento-brain-collector   # 只装采集器
# 或 pip install memento-brain         # 一并装齐 collector + MCP memory
memento-collector setup                # 交互式填 URL + token
```

> PyPI 包名 `memento-brain-collector` / `memento-brain-memory`(短名 `memento-memory` 被占了),CLI 保留短别名 `memento-collector` / `memento-memory`。

**怎么拿 token?**

- **跑过 `./install.sh`** → 末尾会打印,同时存到 `.env.local`
- **Web 注册** → `/auth/register` 第一个用户自动 owner + 显示 token;之后任意时刻头像 → 个人资料

### 守护进程

```bash
memento-collector status    # 查看状态
memento-collector start     # 启动服务
memento-collector stop      # 停止服务
memento-collector run       # 前台运行(调试)
```

按平台自动适配:**macOS** launchd / **Linux** systemd user / **Windows** Task Scheduler。

## 🧠 MCP 记忆服务

装齐 `memento-brain` 后,所有 AI IDE 会自动配置 MCP 接入(由 `memento-collector setup` 完成):

| AI 工具 | MCP 配置文件 | 写入方式 |
|---|---|---|
| Claude Code | `~/.claude.json` | `claude mcp add` CLI |
| Cursor | `~/.cursor/mcp.json` | JSON `mcpServers.memento-memory` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | 同上 |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | 同上 |
| **Codex** | `~/.codex/config.toml` | TOML `[mcp_servers.memento-memory]` |
| OpenClaw | `~/.openclaw/openclaw.json` | `openclaw mcp set` CLI |

接入后在任何 AI IDE 里可以调:

| 工具 | 用途 |
|---|---|
| `memory_search(q)` | 跨工具语义检索过去对话 |
| `memory_recall(category, days)` | 按类别召回最近 N 天的记录 |
| `memory_context(project_name)` | 切换项目时拉相关上下文 |
| `daily_summary(date)` | 看某天的活动汇总 |
| `memory_store(content, entity_name)` | 主动保存观察 |

## 👥 用户与权限

| 角色 | 说明 |
|---|---|
| `owner` | 首个注册用户。可改任意用户 role/status,看全量数据 |
| `admin` | 可审批 pending 用户、管理设备、看 audit log |
| `viewer` | 只读(默认)。只能看分给自己的 project/tool |
| `pending` | 新注册未激活,需 admin 批准 |

关键流程:

- **注册**:`/auth/register` — 首个用户自动 owner + active,之后注册需要 admin 批准
- **token 自助管理**:右上角头像 → 个人资料,查看/复制/重新生成 collector token
- **批准用户**:owner/admin 进 `/admin`,pending 用户旁有按钮,批准后 token 立即出现可复制
- **细粒度授权**:`/admin/permissions` 按 project / tool 给 viewer 发 read/write 权限

## 🌐 公开分享

项目时间线和日报可以一键生成公开分享链接:

- 进 `/projects/<id>/timeline` 或 `/daily/<date>`,右上角 **分享** 按钮
- 选有效期(可永久),生成 `/s/<token>` URL
- 访客无需登录直接查看
- 后台记录访客 IP + 国家/地区/城市(本地 GeoIP DB,无外发请求)
- 随时可撤销

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 采集器 | Python ≥3.10, watchdog, httpx, pydantic-settings |
| MCP 记忆 | Python ≥3.10, mcp ≥1.26, asyncpg, pgvector |
| 服务端 | Python ≥3.12, FastAPI ≥0.115, SQLAlchemy 2.0 async, asyncpg, Celery |
| 数据库 | PostgreSQL 16 (+ pgvector + pg_trgm), Redis 7, MinIO (S3 兼容) |
| 前端 | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| AI 摘要 / 图谱 | Anthropic Claude API + OpenAI 兼容端点(Kimi / DashScope...) |
| Embedding | BGE-M3 宿主运行(macOS MPS / Linux CUDA / CPU 回退) |
| GeoIP | MaxMind GeoLite2 / db-ip city-lite(离线 mmdb) |
| 部署 | Docker Compose(7 服务) |

## 📁 目录结构

```
memento/
├── collector/                # 本地采集器 — PyPI: memento-brain-collector
│   └── collector/
│       ├── main.py           # 守护进程入口
│       ├── cli.py            # setup / install / start / stop / uninstall
│       ├── watcher.py        # watchdog 跨平台监听 + 去抖
│       ├── queue.py          # SQLite WAL 离线队列
│       ├── sync_client.py    # HTTPS 同步(分片上传 / 离线重试)
│       ├── sanitizer.py      # 入队前脱敏(API key / 私钥 / OAuth)
│       ├── parsers/          # 8 个解析器
│       └── tools/            # 6 个工具定义
├── mcp_server/               # MCP 记忆 — PyPI: memento-brain-memory
├── memento_brain/            # Meta — PyPI: memento-brain(一键装齐)
├── server/                   # 后端 FastAPI
│   └── server/
│       ├── main.py           # 入口 + schema 迁移 + validate_production
│       ├── config.py         # MEMENTO_ 前缀 settings + fail-fast
│       ├── middleware/       # JWT + collector token (constant-time)
│       ├── api/              # REST + SSE + MCP 挂载
│       ├── db/               # 16 张表
│       ├── services/         # ingest / embedding / graph / cache / geoip
│       └── tasks/            # Celery worker + beat
├── web/                      # Next.js 16 前端
│   ├── src/app/              # 18+ 页面
│   └── src/components/       # Aurora 设计系统
├── embedding/                # BGE-M3 宿主服务
├── scripts/                  # install.py 后端 + 工具脚本
├── deploy/bootstrap/         # curl 一键安装(install.sh / .ps1 / index.html)
├── docs/                     # project-architecture.md / collector-architecture.md
└── docker-compose.yml
```

## ⚙️ 环境变量

所有变量统一 `MEMENTO_` 前缀。

<details>
<summary><b>采集器(collector)</b></summary>

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_SERVER_URL` | http://localhost:8001 | 服务端 API 地址 |
| `MEMENTO_SERVER_TOKEN` | — | collector token |
| `MEMENTO_OBSIDIAN_VAULT_PATH` | 自动发现 | Obsidian vault 路径 |
| `MEMENTO_NONINTERACTIVE` | — | setup 时设 `1` 跳过 prompt |

</details>

<details>
<summary><b>服务端(api / celery)</b></summary>

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_DATABASE_URL` | postgresql+asyncpg://postgres:postgres@localhost:5433/memento | Postgres 连接 |
| `MEMENTO_REDIS_URL` | redis://localhost:6380/0 | Redis broker + backend |
| `MEMENTO_COLLECTOR_TOKEN` | collector-dev-token | 兜底 collector token(dev 用) |
| `MEMENTO_SECRET_KEY` | change-me-in-production | JWT 签名密钥(生产必须覆盖) |
| `MEMENTO_S3_ENDPOINT` | http://localhost:9000 | MinIO/S3 端点 |
| `MEMENTO_S3_ACCESS_KEY` / `MEMENTO_S3_SECRET_KEY` | minioadmin | MinIO 凭据 |
| `MEMENTO_S3_BUCKET` | memento | 大文件 bucket |
| `MEMENTO_ANTHROPIC_API_KEY` | — | Claude API(AI 摘要) |
| `MEMENTO_AI_API_KEY` / `_BASE_URL` / `_MODEL` | — / dashscope / kimi-k2.5 | OpenAI 兼容备用 |
| `MEMENTO_EMBEDDING_SERVER_URL` | http://host.docker.internal:8002 | 宿主 BGE-M3 服务 |
| `MEMENTO_GEOIP_DB` | /data/geoip/GeoLite2-City.mmdb | GeoIP 数据库路径 |
| `MEMENTO_DEBUG` | `0` | 设 `1` 允许 dev 默认值启动 |
| `MEMENTO_PORT` | 8000 | API 监听端口 |

</details>

<details>
<summary><b>Embedding 服务</b></summary>

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_EMBEDDING_PORT` | 8002 | HTTP 端口 |
| `MEMENTO_EMBEDDING_MODEL_NAME` | BAAI/bge-m3 | sentence-transformers 模型 |

</details>

## 🌐 远程访问 / 自定义域名

- 前端 API 地址自动跟随 `window.location.hostname`(代码里 `getApiBase()`,不写死)
- Docker 端口映射自动支持 IPv4 + IPv6
- 放行域名改 [server/server/main.py](server/server/main.py) 里的 `allow_origin_regex`,默认:

  ```python
  allow_origin_regex=r"(https?://localhost:\d+|https?://mem\.ihasy\.com)"
  ```

## 🗑️ 卸载

<details>
<summary><b>服务端(跑过 install.sh)</b></summary>

```bash
./install.sh uninstall          # 只停容器,保留数据 / .env / pip 包
./install.sh uninstall --purge  # 同上 + 删 Docker 数据卷 + .env
./install.sh uninstall --all    # 核弹级(加 -y 跳过二次确认)
```

`--all` 会清:
- pip 包(memento-brain-* + 旧品牌 daily-report-*)
- `~/.memento` + `~/.daily-report`(旧路径)
- Collector 日志(macOS / Linux / Windows 各自路径)
- Embedding venv + HuggingFace 模型缓存(~1.3 GB)
- Docker 镜像 + 数据卷
- `.env` / `.env.local`
- AI 工具的 MCP `memento-memory` 条目

</details>

<details>
<summary><b>只装了采集器的设备</b></summary>

```bash
memento-collector uninstall                                  # 摘掉 launchd/systemd/Task
pip uninstall -y memento-brain-collector memento-brain-memory memento-brain
rm -rf ~/.memento

# 日志(选一)
rm -rf ~/Library/Logs/memento                                # macOS
rm -rf ~/.local/share/memento/logs                           # Linux
# Windows: Remove-Item -Recurse $env:LOCALAPPDATA\memento

# AI 工具 MCP 条目手动删掉 memento-memory 块
```

</details>

## 📄 License

本项目采用 [AGPL-3.0](LICENSE) 许可证。

简单说:个人使用、自托管、内部用、研究学习都免费。但如果你拿这份代码(或任何改动)对外提供网络服务(SaaS / 公开 host),按 AGPL 第 13 条,你**必须**把你修改后的完整源码也按 AGPL 公开。

商业授权(免除 AGPL 限制、闭源使用、SaaS 化等场景)请联系作者。
