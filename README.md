<div align="center">

# Memento

**给你的 AI 工具建个共享大脑与多模态工作台**

跨设备、跨工具自动采集 AI 编程对话与记忆，自建后端汇总，内置全能文档与媒体视窗（Office/PPT 16:9 横屏放映、万行表格切片、音视频 GPU 加速），Web + MCP 统一查看、搜索、召回。

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Python ≥3.12](https://img.shields.io/badge/python-≥3.12-blue.svg)](#技术栈)
[![Next.js 16](https://img.shields.io/badge/next.js-16-black.svg)](#技术栈)

[快速开始](#-快速开始) · [架构](#️-架构) · [支持的工具](#-支持的-ai-工具) · [自部署](#-自托管部署) · [MCP 接入](#-mcp-记忆服务)

🌐 **Languages**: [中文](README.md) · [English](README.en.md)

</div>

---

## ✨ 它能做什么

- 🧠 **跨设备同步对话** — Mac / Linux / Windows 上 Claude Code / Codex / Cursor / Antigravity / WorkBuddy / Windsurf / Cline 的对话和 Obsidian 笔记，增量汇总到你自己的服务端
- 🖥️ **全能多模态文档与工作台视窗** — 应用内直接沉浸式预览 Office (PPT / Word / Excel)、PDF、代码产物与音视频；手机端与移动设备支持 100vw × 100dvh 全屏放映与 90° 横屏沉浸放映（专为 16:9 幻灯片打造）；万行 CSV / TSV 动态交互表格切片分页渲染，毫秒级即时响应；支持微信公众号草稿一键发布与 2.35:1 高清插图提取同步；GPU 3D 合成硬件加速与音视频硬件解码句柄安全解绑
- 🤖 **全天候 AI 执事与智能交互** — 全屏自适应会话流、带闪电标的深度思考过程全屏铺满、多智能体协同问答；个人设置中支持 Claude Code 最新模型、OpenAI、DeepSeek 等主流大模型自由配置切换，额度智能探测与失效即时告警
- 🛰️ **跨设备派活** — 在网页或手机上把 Claude Code / Codex / Antigravity / WorkBuddy 任务交给任一在线设备，经设备的 WebSocket 长连接即时送达，过程和结果实时回传、可随时停止；设备不在线当场告诉你，不会默默排队（shell 命令需服务端设 `MEMENTO_REMOTE_EXEC=1`）
- 🛎️ **主动执事** — 每分钟巡检一次：多步后台任务由 AI 逐步规划、派给在线设备执行，危险命令先等你批准；设备掉线 5 分钟推送一次提醒；每天早晚各一份简报；免打扰时段只推进任务、不推送
- 👤 **个人画像与 3D 数字分身** — 个人画像引导设置性别、卡通形象与 3D 响应式分身；沟通铁律、技术偏好与长期记忆深度定制，在所有跨设备对话中持续自进化
- ⚡ **技能进化与智能避坑系统** — 每晚复盘自动将完成的多步流程总结为技能（Skills）写入本地 `~/.claude/skills`、`~/.agents/skills` 等；查明原因的失败自动记为踩坑指南（Pitfalls）；动手前调用 `memory_check_rule` 自动前置校验拦截
- 📋 **工作待办闭环管理** — 会话中识别到的待办事项自动归集到工作待办（`/inbox`）；支持优先级、到期推送与一键状态同步，任务闭环
- 🌅 **作息节律与两阶段 AI 日报** — 昼夜节律认知循环，每天 23:30 自动跑两阶段：先对每篇文档生成摘要，再聚合成跨工具每日 digest，清晰掌握全天产出
- 🔍 **混合检索** — BGE-M3 语义向量 + jieba 分词的全文索引，中英文均能精准召回
- 🕸️ **知识图谱** — LLM 自动从对话抽实体(项目 / 工具 / 技术 / 人物 / 概念)、关系、观察；超过 7 天的老观察自动压缩成 summary
- 🔗 **MCP 原生服务** — 查、钻、写、总览之外，还有动手前的检查(`memory_check_rule`)、技能(`memory_skill`)、踩坑(`memory_pitfall`)和待办(`todo_list` / `todo_add` / `todo_update`)；任何 AI IDE 都能直接查、读、改你的记忆
- ♻️ **记忆新陈代谢** — 记录每条记忆被 AI 用到的次数；重复和被新说法推翻的旧记忆标记为"已取代"(画像同步删掉旧行)，60 天没用的自动总结转为"沉睡"；只打标记不删除，随时可唤醒
- 📏 **检索评测** — 从你的资料生成带版本号的固定题集，每周用问答同一套检索作答，前 5 命中率 / MRR 下降时告警
- 🔒 **上传前脱敏** — 守护进程在本机先用 15 条规则抹掉密钥(OpenAI / Anthropic / GitHub / Slack / Telegram / AWS / Bearer / 私钥 / URL 内嵌凭证 / `password=…` 等)并去掉内嵌的 base64 大图，JSON 里 `token` / `password` / `api_key` 等字段的值也一并抹掉，密钥不出本机
- 🌐 **公开分享** — 项目时间线 / 日报一键生成 share 链接，带 GeoIP 访客统计、有效期、随时撤销
- 🛡️ **完全自托管** — Docker Compose 一键起，Postgres + Redis + MinIO 全在你机器上，数据不出门
- 🔐 **多租户隔离** — 多用户独立空间，owner / admin / viewer 三级角色 + 细粒度授权 + 审计日志
- ⚡ **现代化桌面端与守护进程** — Electron 原生跨平台，免装 Python，系统托盘常驻，Mac 支持最小化到托盘，登录状态永久记住，切换功能零延迟；断网时记住每个文件传到哪里(`~/.memento/offsets.json`)，网络恢复后从断点续传

## 🏗️ 架构

```mermaid
graph TB
    subgraph DEV["📱 用户设备 Mac/Linux/Windows"]
        direction LR
        CC["Claude Code<br/>~/.claude"]
        CDX["Codex<br/>~/.codex"]
        CUR["Cursor<br/>~/.cursor"]
        AG["Antigravity<br/>~/.gemini/antigravity"]
        WB["WorkBuddy<br/>~/.workbuddy"]
        WS["Windsurf<br/>~/.codeium/windsurf"]
        CL["Cline<br/>VS Code globalStorage"]
        OBS["Obsidian Vault"]
        COL["Memento 守护进程<br/>桌面端内置 / memento-daemon<br/>文件监听 · 断点续传<br/>上传前脱敏 · 执行派来的任务"]
        CC --- COL
        CDX --- COL
        CUR --- COL
        AG --- COL
        WB --- COL
        WS --- COL
        CL --- COL
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

        EMB["BGE-M3 Embedding<br/>:8002 (Docker / 宿主)"]

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

    MCP["@memento/mcp<br/>MCP Server"]
    MCC --> MCP
    MCDX --> MCP
    MCUR --> MCP
    MAG --> MCP

    COL ==>|"HTTPS + collector token"| NGX
    NGX -.->|"WebSocket 下发任务"| COL
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
    class CC,CDX,CUR,AG,WB,WS,CL,OBS,COL device
    class API,WEB,CW,CB,PG,RD,S3,EMB,NGX server
    class MCC,MCDX,MCUR,MAG,MCP client
    class SHARE,GEO public
```

### 数据流(单条对话从产生到可搜)

```mermaid
sequenceDiagram
    participant T as AI 工具
    participant W as 本地文件
    participant C as 守护进程
    participant A as API
    participant P as Postgres
    participant E as Embedding
    participant M as MCP

    T->>W: 写 .jsonl 对话
    W->>C: fs.watch 文件事件
    C->>C: 从上次传到的字节位置读新增部分 + 脱敏
    C->>A: HTTPS POST(网络失败 2 秒起翻倍退避,最长 60 秒)
    A->>P: 写 documents / conversation_messages / document_search
    A-->>C: 确认收到
    C->>C: 记下新位置(~/.memento/offsets.json),断网后从这里续传
    A-->>E: 异步算 embedding
    E->>P: 写 document_embeddings (pgvector)
    A-->>P: LLM 抽 entities / relations
    Note over M: 用户在 Claude Code 里调 memory_search
    M->>A: GET /api/memory/semantic
    A->>E: 算 query embedding
    E->>P: cosine_distance 排序
    P-->>M: 返回相关 chunk
```

> 新改动的文档等它安静下来再算向量;失败时 `embedding_status` 写为 `failed`,Celery beat **每分钟**扫一次 `pending/failed`,失败的按退避重试,不会因为单次抖动丢向量。

## 🧰 支持的 AI 工具

| 工具 | 采集内容(目录) | 格式 |
|------|---------|------|
| **Claude Code** | 对话(含子智能体)`~/.claude/projects`、计划 `~/.claude/plans` | JSONL / Markdown |
| **Codex** | 会话 `~/.codex/sessions` | JSONL / JSON |
| **Antigravity** | 对话 `~/.gemini/antigravity/brain/<会话>/…/transcript.jsonl`(不带 base64 图片的那份) | JSONL |
| **WorkBuddy / CodeBuddy** | 会话 `~/.workbuddy/projects`、`~/.codebuddy/projects`(不含子智能体) | JSONL |
| **Cursor** | 会话 `~/.cursor/projects` | JSONL / JSON |
| **Windsurf** | Cascade 记录 `~/.codeium/windsurf/cascade` | JSON / Markdown |
| **Cline / Roo Code** | VS Code `globalStorage` 里的 `tasks` | JSON / Markdown |
| **Obsidian** | 从 Obsidian 自己的 `obsidian.json` 找到全部 vault 的笔记 | Markdown |

`~/.memento/collector.json` 的 `extra_watch_dirs` 可以再加要采集的 Markdown 目录。

OpenClaw、Hermes 不采集对话,只接收个人画像。画像会写进各工具的全局说明文件:Claude Code `~/.claude/CLAUDE.md`、Codex `~/.codex/AGENTS.md`、Antigravity / Gemini `~/.gemini/GEMINI.md`、WorkBuddy `~/.workbuddy/MEMORY.md`、OpenClaw `~/.openclaw/workspace/USER.md`、Hermes `~/.hermes/SOUL.md`。只改 `<!-- memento:begin -->` 到 `<!-- memento:end -->` 之间,写哪些工具在应用里按设备选。

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
5. 把本机配到这台服务器,本机有 Node.js 20+ 时从仓库构建采集守护进程并注册为系统服务(没有 Node 就装桌面端,它会自动读取这份配置)

可选参数:

| 命令 | 说明 |
|---|---|
| `./install.sh embedding` | 装 BGE-M3 嵌入服务(Docker 模式,~1.3 GB,语义搜索 / MCP 召回必需) |
| `./install.sh embedding --native` | 改用宿主 venv 安装(NVIDIA CUDA / Apple MPS GPU 加速场景) |
| `./install.sh doctor` | 检查所有服务状态 |
| `./install.sh update` | git pull + 重建 + 升级 |
| `./install.sh uninstall` | 停服务,保留数据和配置 |
| `./install.sh uninstall --purge` | 同上 + 清 Docker 数据卷 + `.env` |
| `./install.sh uninstall --all` | 核弹级:采集服务 / `~/.memento` / 写进 AI 工具的画像块、Stop 钩子和技能 / MCP 配置 / 模型缓存 / Docker 镜像与数据卷 全清 |
| `./install.sh uninstall-collector` | 只装了采集端的设备用:卸掉采集服务和它在本机留下的一切,不碰 Docker |

### 服务端口

| 端口 | 服务 |
|---|---|
| **8001** | API (Swagger: `/docs`) |
| **3001** | Web UI |
| 8002 / 18002 | Embedding:`--native` 模式在宿主 8002;Docker 模式映射到宿主 18002(`MEMENTO_EMBEDDING_HOST_PORT` 可改),容器之间走 `embedding:8002` |
| 5433 | PostgreSQL |
| 6380 | Redis |
| 9000 / 9001 | MinIO / 控制台 |

> 端口与常见项目错开,避免冲突。

## 💻 在额外设备上接入

把你日常用 AI 工具的每台 Mac / Windows / Linux 接到服务端，有两种方式：

### 方式一：桌面客户端（推荐）

不想折腾环境、追求最流畅桌面体验的，直接下载客户端 —— **基于 Electron 打造，内置采集守护进程与 MCP sidecar**（无需安装任何运行环境），系统托盘常驻，登录后自动开始采集，自动更新。

**[⬇️ 前往 GitHub Releases 下载最新版](https://github.com/ddong8/memento/releases/latest)**

| 平台 | 安装包 | 说明 |
|---|---|---|
| **macOS** (Apple Silicon) | `.dmg` | 拖进 Applications 即可，支持 Mac 最小化到系统托盘 |
| **Windows** (x64) | `.exe` | NSIS 安装版，支持任务栏托盘与开机自启 |
| **Linux** (x64) | `.AppImage` / `.tar.gz` | AppImage 赋予执行权限直接运行；tar.gz 解压后运行 `memento` |
| **Android** | `.apk` | Expo 外壳内嵌网页版，手机上看会话流、文档视窗与日报，给设备派活 |
| **iOS** | TestFlight | 同一个 Expo 外壳，目前通过 TestFlight 内测分发 |

**开箱即用体验**：
1. 原生独立窗口直接加载 Memento 工作台，登录状态**永久记住**，重启无需反复重新登录。
2. 首次打开在界面中直接登录或注册（或使用 GitHub 授权登录），客户端**全自动托管凭证与守护进程**，自动配齐本地 MCP 服务并启动后台采集，普通用户全程无需接触、复制或管理任何 Token。
3. 记住上次打开的菜单状态，切换功能零延迟；内置全格式多模态文档与音视频工作台。
4. 客户端会在新版本发布时自动检查并提示安装；下载的安装包先按发布元数据里的 SHA-512 校验，再安装。

> macOS 首次打开若提示“无法验证开发者”，右键图标 → 打开，或在终端执行 `xattr -dr com.apple.quarantine /Applications/Memento.app`。

### 方式二：命令行服务（Node.js 守护进程）

适合无头服务器、Linux VPS 或习惯 CLI 终端的环境，依赖 Node.js ≥ 20。守护进程与桌面端复用同一套核心逻辑（`packages/daemon`）：

```bash
git clone https://github.com/ddong8/memento.git && cd memento
npm ci --workspace @memento/daemon --workspace @memento/core --include-workspace-root
npm run build -w @memento/daemon

# 登录并注册为系统服务（自动开机自启）
node packages/daemon/dist/cli.js login <collector token> https://mem.ihasy.com
node packages/daemon/dist/cli.js install-service
```

常用管理命令：
```bash
node packages/daemon/dist/cli.js status              # 查看状态
node packages/daemon/dist/cli.js run                 # 前台调试运行
node packages/daemon/dist/cli.js install-service     # 登录后自动启动
node packages/daemon/dist/cli.js uninstall-service   # 取消自动启动
```

按操作系统自动适配：**macOS** launchd / **Linux** systemd user / **Windows** 启动项。桌面端与守护进程同一时间保证单实例运行（共用 `~/.memento`）。日志在 `~/.memento/daemon.log`。

## 🕸️ 知识图谱

LLM 自动从同步进来的对话和文档里抽:

- **实体** (`knowledge_entities`) — 项目 / 工具 / 技术 / 人物 / 概念,跨对话去重合并
- **关系** (`knowledge_relations`) — 实体之间的 `uses` / `creates` / `depends_on` / `discussed`
- **观察** (`observations`) — 关于某个实体的具体事实陈述,带时间戳和来源 doc

**自动压缩**:同一实体超过 7 天的累积观察会被 LLM 合并成一段更短的 summary,保语义、省空间。压缩窗口可通过 `MEMENTO_COMPACTION_AGE_DAYS` 调整。

通过 MCP 工具读写:写用 `memory_store`,读用 `memory_graph(entity_name)` 拿邻居 + 观察、`memory_context(project)` 拿项目级上下文、`memory_recall(category, days)` 拿时间序列。Web `/memory` 页可视化查看。

## 🧠 MCP 记忆服务

桌面端自带 MCP 服务(`@memento/mcp`),在「本机采集」页一键复制 Claude Code / Codex / 其他工具的配置(`mcpServers` JSON);没装桌面端的机器可以在仓库里 `npm ci && npm run build -w @memento/mcp` 后运行 `node packages/mcp/dist/cli.js`(读取 `~/.memento/collector.json` 的登录信息,也可以传 `--server URL --token TOKEN`)。各工具的配置位置:

| AI 工具 | MCP 配置文件 | 写入方式 |
|---|---|---|
| Claude Code | `~/.claude.json` | 运行复制的 `claude mcp add` 命令 |
| Cursor | `~/.cursor/mcp.json` | JSON `mcpServers.memento-memory` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | 同上 |
| Antigravity | 在 Antigravity 的 MCP 设置里打开配置文件(位置随版本变化,常见 `~/.gemini/antigravity/mcp_config.json`) | 同上 |
| Gemini CLI | `~/.gemini/settings.json` | 同上 |
| **Codex** | `~/.codex/config.toml` | TOML `[mcp_servers.memento-memory]` |

接入后在任何 AI IDE 里可以调:

| 工具 | 用途 |
|---|---|
| **查找** | |
| `memory_search(query, limit, tool_filter, days)` | 跨工具混合检索(BGE-M3 语义 + jieba 全文,语义接口不可用时退回全文),`days` 限定时间窗,`tool_filter` 限定工具 |
| `memory_recall(category, project, days, limit, date)` | 按类别召回最近 N 天(或指定日期)的记录 |
| `memory_context(project_name)` | 切换项目时拉相关上下文(项目元信息 + 整理过的文档全文 + 近期对话清单) |
| `memory_blueprint(project_name, recent_conversations, section)` | 传项目名:一次拿全项目蓝图(元信息 + 代码架构蓝图 + 文档 + 近期对话 + 图谱实体);传 `me` / `user`:个人全域蓝图。代码蓝图默认只给开头的速览与章节索引,`section` 传章节号(如 `3`、`4,6.5`)只取这几节,传 `all` 取全文 |
| `memory_project_map()` | 所有项目一览:名称、主要工具、文档数 |
| **钻取** | |
| `memory_open(doc_id)` | 拿一篇文档的全文(配合 search 用,先找到再"打开") |
| `memory_conversation(doc_id, limit, offset)` | 把对话展开成 role/content/timestamp 消息序列,支持分页 |
| `memory_graph(entity_name, limit)` | 知识图谱钻取:实体 summary + 出/入向关系 + 近期观察 |
| **写入** | |
| `memory_store(content, entity_name, entity_type)` | 主动保存观察到知识图谱 |
| **总览** | |
| `daily_summary(date_str)` | 某天的跨工具活动汇总 + AI 摘要 |
| `memory_core(category)` | 每晚复盘沉淀的长期核心记忆(MEMORY.md):规矩、架构决定、项目知识、踩坑 |
| `mind_resonance(query, project, action)` | 动手前对齐:当前场景的铁律、用户偏好、相关图谱实体和要避开的坑 |
| **动手前 / 学到的** | |
| `memory_check_rule(action_type, project_name, details)` | 部署、发版、迁移、改数据前调用:返回相关铁律、以前踩过的坑、可照做的技能 |
| `memory_skill(query)` | 取出一个已发布技能的完整步骤(不带参数列出全部) |
| `memory_pitfall(title, symptom, fix, cause, project)` | 查明原因并解决一个失败后记下来,下次同类操作前提醒 |
| `todo_list(project)` / `todo_add(title, detail, due, project)` / `todo_update(todo_id, status, title, due)` | 待办:列出、记下"以后再做"的事、完成或放弃 |

本机装了采集器时,MCP 服务不需要传 `--token`:自动读取 `~/.memento/collector.json` 里的服务地址和设备令牌,令牌轮换后也会自动换用新的。

以上共 18 个工具,外加 6 个 MCP **resources**(以 URI 形式暴露,IDE 可订阅):

| URI | 内容 |
|---|---|
| `memory://projects` | 所有项目列表 |
| `memory://projects/{name}` | 单个项目详情(对话 / 实体 / 观察) |
| `memory://identity/{tool}` | 指定工具的"身份卡"(用户偏好 / 长期记忆) |
| `memory://daily/{date}` | 某天的活动汇总 |
| `memory://core` | 长期核心记忆 MEMORY.md |
| `memory://resonance` | 当前的心领神会上下文(意图、场景铁律、图谱实体、要避开的坑) |

## 👥 用户与权限

| 角色 | 说明 |
|---|---|
| `owner` | 首个注册用户。可改任意用户 role/status,看全量数据 |
| `admin` | 可管理设备、看 audit log;`invite_only` 模式下还能审批 pending 用户 |
| `viewer` | 只读(默认)。只能看分给自己的 project/tool |
| `pending` | 仅出现在 `invite_only` 模式下还没拿到邀请码就自助注册的边角场景 |

**注册模式**(`MEMENTO_REGISTRATION_MODE`,默认 `open`):

| 模式 | 行为 |
|---|---|
| `open` | 任何人自助注册即激活,服务端直接发 collector token,无需 admin 介入 |
| `invite_only` | 必须带 `invite_code` 才能注册,否则拒绝;邀请码由 owner/admin 在 `/admin/invites` 创建 |
| `closed` | 注册接口完全关闭(给只有 owner 一个人用的部署) |

关键流程:

- **注册**:`/auth/register` — 首个用户自动 owner + active;之后按 `MEMENTO_REGISTRATION_MODE` 决定
- **桌面客户端**: 原生独立窗口直接打开 Memento 工作台，登录后内置守护进程与 MCP 服务自动静默配对启动，用户全程无需手动干预任何 Token
- **细粒度授权**:`/admin/permissions` 按 project / tool 给 viewer 发 read/write 权限
- **审计日志**:`access_logs` 表落库每次敏感操作(user_id / action / IP / metadata),便于事后追溯
- **会话保持与自动授权**: 桌面端自动维护登录态与静默授权，开机自动后台运行，全天候采集，断网后自动续传

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
| 采集守护进程 | Node.js ≥20, TypeScript, ws(随桌面端分发,也可单独运行) |
| MCP 记忆 | TypeScript, @modelcontextprotocol/sdk(stdio,调用服务端接口) |
| 服务端 | Python ≥3.12, FastAPI ≥0.115, SQLAlchemy 2.0 async, asyncpg, Celery |
| 数据库 | PostgreSQL 16 (+ pgvector + pg_trgm), Redis 7, MinIO (S3 兼容) |
| 前端 | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| 桌面端 | Electron + electron-updater(内置守护进程与 MCP 服务) |
| 手机端 | Expo(React Native)外壳 + react-native-webview,Android APK / iOS TestFlight |
| AI 摘要 / 图谱 | Anthropic Claude API + OpenAI 兼容端点(Kimi / DashScope...) |
| Embedding | BAAI/bge-m3:OpenAI 兼容接口(如硅基流动),或自建 BGE-M3 服务(Docker 容器;`--native` 跑宿主 venv,Linux 可用 CUDA) |
| GeoIP | MaxMind GeoLite2 / db-ip city-lite(离线 mmdb) |
| 部署 | Docker Compose(7 服务) |

## ⚙️ 后台任务

Celery beat 调度的定时任务(时间按 `Asia/Shanghai`):

| 任务 | 触发 | 作用 |
|---|---|---|
| `daily-digest` | 每天 23:30,次日 03:30 再跑一次 | 生成跨工具的每日 AI 活动汇总(逐 doc 摘要 → 聚合);03:30 补上跨零点才同步到的消息 |
| `review-sessions` | 每天 02:20 | 复盘已结束的会话:总结技能、踩坑、待办 |
| `nightly-dreaming` | 每天 03:00 | 夜间记忆整理,写长期核心记忆 MEMORY.md、发现新场景 |
| `memory-lifecycle` | 每天 04:10 | 合并重复记忆、标记被推翻的、60 天没用的转为沉睡 |
| `tsvector-backfill` | 每天 04:25 | 给还没有全文索引的文档补上(写入 `document_search`) |
| `embedding-retry` | 每分钟 | 给改动后安静下来的文档算向量,失败的按退避重试 |
| `merge-staged-deltas` | 每分钟 | 把大对话暂存的增量合并进正文 |
| `message-audit` | 每 5 分钟 | 核对有变化的对话,消息表和原文是否一致 |
| `knowledge-retry` | 每 15 分钟 | 重试抽图谱失败的文档 |
| `learn-corrections` / `learn-todos` | 每 10 分钟 | 从新对话里学纠正、识别"以后再做"和"做完了" |
| `close-stale-tasks` | 每 10 分钟 | 不会再有设备回报的派活任务标为超时 |
| `title-backfill` | 每小时 :07 | 给还挂着无意义标题的文档补真实标题 |
| `health-check` | 每 30 分钟 | AI 调用失败多或余额低时推送提醒 |
| `remind-todos` | 每天 09:05 | 推送今天到期和逾期的待办 |
| `weekly-db-backup` | 每周日 03:30 | 全表导出压缩后存到 MinIO,保留 8 周 |
| `evaluate-retrieval` / `evaluate-learning` | 每周一 04:40 / 04:50 | 检索评测、纠正学习评测 |

API 进程里另有三个循环:主动执事每分钟巡检一次、图谱观察压缩每天一次(超过 `MEMENTO_COMPACTION_AGE_DAYS` 天的观察合并成 summary),这两个多副本时只有一个副本在跑;每个副本每 10 分钟重新加载夜间学到的场景(进程内缓存,各副本各自刷新)。

## 📁 目录结构

```
memento/
├── packages/
│   ├── core/                 # @memento/core:接口类型、提问流、任务事件(各端共用)
│   ├── daemon/               # @memento/daemon:本机采集 + 派活执行 + 画像/技能写入
│   └── mcp/                  # @memento/mcp:MCP 记忆服务(随桌面端分发)
├── apps/
│   ├── desktop/              # Electron 桌面端(Memento)
│   ├── mobile/               # Expo 手机端外壳(内嵌网页版)
│   └── web/                  # Next.js 16 前端
│       ├── src/app/          # 35 个页面
│       └── src/components/   # Aurora 设计系统
├── server/                   # 后端 FastAPI
│   └── server/
│       ├── main.py           # 入口 + schema 迁移 + validate_production
│       ├── config.py         # MEMENTO_ 前缀 settings + fail-fast
│       ├── middleware/       # JWT + collector token (constant-time)
│       ├── api/              # REST + SSE
│       ├── db/               # 39 张表
│       ├── services/         # ingest / embedding / graph / 派活 / 主动执事 / 夜间复盘 …
│       └── tasks/            # Celery worker + beat
├── embedding/                # BGE-M3 宿主服务
├── scripts/                  # install.py 后端 + 工具脚本
├── deploy/bootstrap/         # curl 一键安装(install.sh / .ps1 / index.html)
├── docs/                     # project-architecture.md / typescript-migration.md
└── docker-compose.yml
```

## ⚙️ 环境变量

所有变量统一 `MEMENTO_` 前缀。

<details>
<summary><b>采集器(collector)</b></summary>

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_SERVER_URL` | https://mem.ihasy.com | 服务端地址;`~/.memento/collector.json` 里有 `server_url` 时以它为准 |
| `MEMENTO_SERVER_TOKEN` | — | collector token;collector.json 里有 `token` 时以它为准 |
| `MEMENTO_WEB_URL` | — | 网页端地址,和服务端地址不同时设置 |
| `MEMENTO_REMOTE_EXEC_KEY` | 自动领取 | 校验派来的 shell 任务的密钥;设备心跳时自动领取,存在 `~/.memento/remote_exec_key`,一般不用设 |
| `MEMENTO_INSECURE_TLS` | — | 设 `1` 时 WebSocket 不校验证书(只给自签证书的测试环境用) |
| `MEMENTO_DAEMON_PORT` | 随机空闲端口 | `cli.js run` 时本机 API 的端口 |

一般不用设这些:桌面端登录或 `cli.js login` 会写好 `~/.memento/collector.json`。

</details>

<details>
<summary><b>服务端(api / celery)</b></summary>

用 Docker Compose 部署时都写在仓库根目录的 `.env` 里:api 和两个 celery 容器整份读取它(`docker-compose.yml` 的 `env_file`),重跑 `./install.sh` 也会保留。数据库、Redis、MinIO 地址由 compose 按容器名接好,在 `.env` 里写了也不生效;值里有 `$` 时用单引号括起来。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_DATABASE_URL` | postgresql+asyncpg://postgres:postgres@localhost:5433/memento | Postgres 连接 |
| `MEMENTO_REDIS_URL` | redis://localhost:6380/0 | Redis broker + backend |
| `MEMENTO_COLLECTOR_TOKEN` | collector-dev-token | 兜底 collector token(dev 用) |
| `MEMENTO_SECRET_KEY` | change-me-in-production | JWT 签名密钥(生产必须覆盖) |
| `MEMENTO_S3_ENDPOINT` | http://localhost:9000 | MinIO/S3 端点 |
| `MEMENTO_S3_ACCESS_KEY` / `MEMENTO_S3_SECRET_KEY` | minioadmin | MinIO 凭据 |
| `MEMENTO_S3_BUCKET` | memento | 大文件 bucket |
| `MEMENTO_ANTHROPIC_API_KEY` | — | Claude API(AI 摘要);compose 部署在 `.env` 里写 `ANTHROPIC_API_KEY` |
| `MEMENTO_AI_API_KEY` / `_BASE_URL` / `_MODEL` | — / dashscope / kimi-k2.5 | 主 OpenAI 兼容 AI 端点 |
| `MEMENTO_AI_FALLBACK_API_KEY` / `_BASE_URL` / `_MODEL` | OneAPI / qwen3.8-27b | AI 自动故障转移端点 (Fallback) |
| `MEMENTO_AI_PROVIDERS` | — | JSON 数组形式的多级 AI 提供方列表 |
| `MEMENTO_AI_BACKGROUND_MODEL` | — | 后台任务(摘要、抽取、画像)先用的模型(走主 AI 端点),失败再用主模型;不设就直接用主模型 |
| `MEMENTO_AI_BALANCE_ALERT` | 10 | AI 账户余额低于它时每天提醒一次 |
| `MEMENTO_EMBEDDING_PROVIDER` | local | `local` 用自建 BGE-M3 服务;`openai` 用 OpenAI 兼容接口(如硅基流动) |
| `MEMENTO_EMBEDDING_API_URL` / `_API_KEY` / `_MODEL` | https://api.siliconflow.cn/v1 / — / BAAI/bge-m3 | `openai` 模式的接口地址、密钥、模型 |
| `MEMENTO_EMBEDDING_DIM` | 1024 | 向量维度 |
| `MEMENTO_EMBEDDING_SERVER_URL` | compose 里 http://embedding:8002 | `local` 模式的服务地址;`./install.sh embedding --native` 会把它写成 `http://host.docker.internal:8002`(不在 compose 里跑时这就是默认值) |
| `MEMENTO_COMPACTION_AGE_DAYS` | 7 | 图谱观察超过多少天合并成 summary |
| `MEMENTO_REGISTRATION_MODE` | open | 注册模式,见[用户与权限](#-用户与权限) |
| `MEMENTO_PUBLIC_URL` | — | 对外地址,用来拼 GitHub 登录回调 |
| `MEMENTO_CORS_ALLOW_ORIGIN_REGEX` | `.*` | 允许跨域访问的来源,生产建议只写你的域名 |
| `MEMENTO_REMOTE_EXEC` | — | 设 `1` 允许给设备派 shell 命令 |
| `MEMENTO_SHUTDOWN_DRAIN_SECONDS` | 600 | 发版时旧进程最多等进行中的回答多少秒再退出 |
| `MEMENTO_CLAUDE_AUTO_COMPACT_WINDOW` | 200000 | 经 Memento 跑 Claude Code 时,上下文到多少 token 自动压缩 |
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
| `MEMENTO_EMBEDDING_DEVICE` | 自动 | 强制使用的设备(如 `cpu` / `cuda` / `mps`) |

</details>

## 🌐 远程访问 / 自定义域名

- 前端 API 地址自动跟随 `window.location.hostname`(代码里 `getApiBase()`,不写死)
- Docker 端口映射自动支持 IPv4 + IPv6
- 跨域放行用 `.env` 里的 `MEMENTO_CORS_ALLOW_ORIGIN_REGEX`,默认 `.*`(任何来源);对外部署建议只放你的域名,例如:

  ```bash
  MEMENTO_CORS_ALLOW_ORIGIN_REGEX='https?://(localhost:\d+|mem\.example\.com)'
  ```

## 🗑️ 卸载

<details>
<summary><b>服务端(跑过 install.sh)</b></summary>

```bash
./install.sh uninstall          # 只停容器和采集服务,保留数据 / .env
./install.sh uninstall --purge  # 同上 + 删 Docker 数据卷 + .env
./install.sh uninstall --all    # 核弹级(加 -y 跳过二次确认)
```

`--all` 会清(先退出 Memento 桌面端,否则它会再写回来):
- 采集守护进程服务,以及旧版留下的 pip 包(memento-brain-* + 旧品牌 daily-report-*)
- 写进 AI 工具的内容:`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` 等文件里的画像块、Claude Code 和 Codex 的 Stop 钩子、同步过去的技能、`agy` 包装脚本;你手动改过的技能和标记之外的文字都保留
- `~/.memento`(含守护进程日志 `daemon.log`)+ `~/.daily-report`(旧路径)
- 旧版 Python 采集器的日志目录(macOS / Linux / Windows 各自路径)
- Embedding venv + HuggingFace 模型缓存(~1.3 GB)
- Docker 镜像 + 数据卷
- `.env` / `.env.local`
- AI 工具的 MCP `memento-memory` 条目

</details>

<details>
<summary><b>只装了采集守护进程的设备</b></summary>

在仓库目录里运行(需要 Python 3.11+):

```bash
./install.sh uninstall-collector     # macOS / Linux
.\install.ps1 uninstall-collector    # Windows
```

它会卸掉自启服务,撤回写进各 AI 工具的画像块、Stop 钩子、技能和 MCP 配置,再删 `~/.memento`(配置、续传位置和日志都在里面)。不走服务端安装、也不碰 Docker。

</details>

## 📄 License

本项目采用 [AGPL-3.0](LICENSE) 许可证。

简单说:个人使用、自托管、内部用、研究学习都免费。但如果你拿这份代码(或任何改动)对外提供网络服务(SaaS / 公开 host),按 AGPL 第 13 条,你**必须**把你修改后的完整源码也按 AGPL 公开。

商业授权(免除 AGPL 限制、闭源使用、SaaS 化等场景)请联系作者。
