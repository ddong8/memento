# Memento — 项目架构文档

## 系统概览

Memento 是一个三层架构的个人 AI 编程记忆平台:自动采集 AI 编程工具的对话、记忆、配置等数据,存储到中心服务器,通过 Web 页面展示 + MCP 协议提供给任何 AI 工具调用。

```
┌─────────────────────────────────────────────────────────────────┐
│  AI IDE 工具（Claude Code / Cursor / Codex / Windsurf / ...）    │
│  ↕ 文件监听                                          ↕ MCP 协议  │
├─────────────────────┐  ┌─────────────────────────────────────────┤
│  Collector 采集器    │  │  MCP Memory Server                     │
│  (Python 守护进程)   │  │  (5 Tools + 4 Resources)               │
│  6 个工具 + SQLite 队列 │  │ 语义搜索 + 全文 + 知识图谱              │
├─────────────────────┘  └─────────────────────────────────────────┤
│                                                                   │
│                    FastAPI Server                                  │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐            │
│  │ Ingest  │ │ REST API │ │ SSE 实时  │ │ AI 总结   │            │
│  │ 接收文件 │ │ 30+ 端点 │ │ 事件推送  │ │ Celery    │            │
│  └────┬────┘ └────┬─────┘ └────┬─────┘ └─────┬─────┘            │
│       │           │            │              │                   │
│  ┌────┴───────────┴────────────┴──────────────┴─────┐            │
│  │  PostgreSQL (pgvector) + MinIO (S3) + Redis       │            │
│  │  16 张表 + 向量索引 + 知识图谱                      │            │
│  └──────────────────────────────────────────────────┘            │
│                                                                   │
│  ┌────────────────────────┐                                      │
│  │  Next.js 前端           │                                      │
│  │  18 个页面 (3001)       │                                      │
│  └────────────────────────┘                                      │
└─────────────────────────────────────────────────────────────────┘
          ↑ http://host.docker.internal:8002
┌──────────────────────────────┐
│  BGE-M3 Embedding (宿主机)    │  macOS MPS / Linux CUDA / CPU 回退
│  ThreadingHTTPServer          │  launchd / systemd --user / schtasks
└──────────────────────────────┘
```

## 服务架构

### Docker 容器 (docker compose)

```yaml
services:
  postgres      # pgvector/pgvector:pg16  :5433  数据库 + 向量搜索
  redis         # redis:7-alpine          :6380  缓存 + Celery 消息队列
  minio         # minio/minio             :9000  S3 兼容存储（大文件）
  api           # 自建镜像                :8001  FastAPI 服务端
  celery-worker # 同 api 镜像                    异步任务（AI 总结）
  celery-beat   # 同 api 镜像                    定时任务（每日摘要）
  web           # 自建镜像                :3001  Next.js 前端
```

### 宿主机服务

```
BGE-M3 Embedding Server    :8002  launchd / systemd --user / schtasks
                                  MPS (macOS) / CUDA (Linux+NV) / CPU
                                  ThreadingHTTPServer + threading.Lock
                                  POST /embed + GET /health
```

> **为什么 embedding 不在 Docker 里？**
> Docker 容器无法访问 Apple Silicon 的 MPS GPU。
> 宿主机运行可用 M4 GPU 加速（3.7x 快于 CPU），且不受 Docker 内存限制。
> MPS 非线程安全,`encode()` 用全局锁串行化避免 SIGSEGV。

## 目录结构

```
memento/
├── server/                 # FastAPI 服务端
│   ├── server/
│   │   ├── main.py        # 应用入口，路由注册，启动迁移
│   │   ├── config.py      # 环境变量配置 (MEMENTO_ 前缀)
│   │   ├── api/           # 13 个路由模块
│   │   │   ├── auth.py        # 注册/登录/JWT/token-exchange
│   │   │   ├── admin.py       # 用户管理/权限/审计
│   │   │   ├── ingest.py      # 采集器文件接收（3 种上传方式）
│   │   │   ├── dashboard.py   # 首页仪表盘聚合数据
│   │   │   ├── tools.py       # 工具浏览
│   │   │   ├── projects.py    # 项目浏览 + 时间线
│   │   │   ├── documents.py   # 文档查看
│   │   │   ├── conversations.py # 对话消息解析
│   │   │   ├── daily.py       # 日报（时区感知）
│   │   │   ├── search.py      # 全文搜索
│   │   │   ├── devices.py     # 设备管理 + 命令队列
│   │   │   ├── hierarchy.py   # 设备→工具→项目层级
│   │   │   ├── memory.py      # 知识图谱可视化
│   │   │   ├── events.py      # SSE 实时推送
│   │   │   ├── mcp_mount.py   # MCP 远程端点挂载
│   │   │   ├── public.py      # 匿名可访问端点(首页统计等)
│   │   │   └── install_bootstrap.py  # /install.sh、/install.ps1 静态分发
│   │   ├── services/      # 业务逻辑层
│   │   │   ├── ingest_service.py      # 文件入库 + 后处理触发
│   │   │   ├── conversation_parser.py # JSONL 对话解析（6 种格式）
│   │   │   ├── embedding_service.py   # 调用 embedding 服务器
│   │   │   ├── embedding_server.py    # BGE-M3 独立 HTTP 服务
│   │   │   ├── graph_service.py       # LLM 知识图谱提取
│   │   │   ├── memory_compaction.py   # 记忆压缩（每 24h）
│   │   │   ├── ai_summary_service.py  # AI 日报总结（两阶段）
│   │   │   ├── user_filter.py         # 多租户数据隔离
│   │   │   ├── permission_service.py  # 权限检查
│   │   │   ├── device_service.py      # 设备注册/更新
│   │   │   └── sse_service.py         # SSE 事件广播
│   │   ├── db/
│   │   │   ├── models.py     # 16 张表定义
│   │   │   └── session.py    # 数据库连接池
│   │   └── middleware/
│   │       └── auth.py       # JWT + Collector Token 认证
│   ├── Dockerfile
│   └── pyproject.toml
│
├── collector/              # 采集器守护进程
│   ├── collector/
│   │   ├── main.py        # 主循环（心跳/命令轮询/自动更新）
│   │   ├── cli.py         # CLI 入口（setup/install/start/stop）
│   │   ├── config.py      # 跨平台配置（路径/设备标识）
│   │   ├── watcher.py     # Watchdog 文件监听 + 去抖
│   │   ├── queue.py       # SQLite 同步队列（WAL 模式）
│   │   ├── sync_client.py # HTTP 上传（JSON/multipart/分块）
│   │   ├── sanitizer.py   # 敏感数据过滤
│   │   ├── tools/         # 6 个工具采集器
│   │   │   ├── base.py            # 抽象基类 + 枚举定义
│   │   │   ├── claude_code.py     # Claude Code (~/.claude/)
│   │   │   ├── codex.py           # Codex (~/.codex/)
│   │   │   ├── antigravity.py     # Antigravity (~/.antigravity/ + ~/.gemini/antigravity/)
│   │   │   ├── cursor.py          # Cursor (~/.cursor/)
│   │   │   ├── openclaw.py        # OpenClaw (~/.openclaw/)
│   │   │   └── obsidian.py        # Obsidian (vault 自动发现)
│   │   └── parsers/       # 8 个解析器
│   │       ├── markdown.py
│   │       ├── jsonl.py
│   │       ├── json_parser.py
│   │       ├── toml_parser.py
│   │       ├── sqlite_parser.py
│   │       ├── antigravity_pb_decoder.py  # AES-256-GCM 解密 + Protobuf
│   │       ├── antigravity_export.py      # .pb 文件导出编排
│   │       └── antigravity_vscdb.py       # Antigravity VSCode SQLite 缓存抽取(标题/摘要)
│   ├── pyproject.toml     # PyPI: memento-brain-collector (CLI alias: memento-collector)
│   └── README.md
│
├── mcp_server/             # MCP Memory Server
│   ├── mcp_server/
│   │   ├── __main__.py    # 入口（--server/--token 或 --db-url）
│   │   ├── server.py      # FastMCP 实例 + 5 Tools + 4 Resources
│   │   ├── search.py      # 混合检索（语义+全文+图谱）
│   │   ├── graph.py       # 知识图谱查询 + 观察存储
│   │   ├── remote_client.py # HTTP 远程模式（JWT 自动续期）
│   │   └── db.py          # 数据库模型（独立，不依赖 server 包）
│   ├── pyproject.toml     # PyPI: memento-brain-memory (CLI alias: memento-memory)
│   └── README.md
│
├── embedding/              # BGE-M3 Embedding 服务（Docker 构建用，实际运行在宿主机）
│   ├── Dockerfile         # Docker 版本（供非 Apple Silicon 平台使用）
│   └── embedding_server.py # HTTP /embed + /health
│
├── web/                    # Next.js 前端
│   ├── src/
│   │   ├── app/           # 21 个页面
│   │   │   ├── page.tsx               # 产品落地页(未登录可访问)
│   │   │   ├── app/                   # Dashboard(登录后主面板)
│   │   │   ├── auth/login/            # 登录
│   │   │   ├── auth/register/         # 注册(首个用户 = owner,直显 token)
│   │   │   ├── profile/               # 个人资料 + token 管理(遮蔽/复制/重新生成)
│   │   │   ├── projects/              # 项目列表
│   │   │   ├── projects/[id]/         # 项目详情
│   │   │   ├── projects/[id]/timeline/           # 项目时间线
│   │   │   ├── projects/[id]/conversations/      # 项目对话
│   │   │   ├── tools/                 # 工具总览
│   │   │   ├── tools/[tool]/          # 工具详情
│   │   │   ├── daily/                 # 日历热力图(手机端响应式)
│   │   │   ├── daily/[date]/          # 每日详情
│   │   │   ├── devices/               # 设备管理
│   │   │   ├── devices/[deviceId]/tools/[toolId]/          # 设备下工具视图
│   │   │   ├── devices/[deviceId]/tools/[toolId]/projects/[projectId]/  # 设备/工具/项目
│   │   │   ├── conversations/[id]/    # 对话查看器
│   │   │   ├── documents/[id]/        # 文档查看器
│   │   │   ├── memory/                # 知识图谱可视化
│   │   │   ├── search/                # 搜索
│   │   │   └── admin/                 # 管理后台(用户审批 + 每行 token + 设备操作)
│   │   ├── components/
│   │   │   ├── layout/Header.tsx      # 顶栏（设备选择/语言切换）
│   │   │   ├── layout/Sidebar.tsx     # 侧边栏（设备树/导航）
│   │   │   ├── viewers/ConversationViewer.tsx  # 对话气泡渲染
│   │   │   ├── viewers/MarkdownViewer.tsx      # Markdown 渲染
│   │   │   └── viewers/ConfigViewer.tsx        # 配置/代码渲染
│   │   └── lib/
│   │       ├── api-client.ts          # authFetch + API 函数
│   │       ├── auth-context.tsx       # JWT 认证上下文
│   │       ├── device-context.tsx     # 设备选择上下文
│   │       ├── constants.ts           # 工具图标/颜色/工具函数
│   │       ├── use-sse.ts            # SSE 实时更新 Hook
│   │       └── i18n/                 # 中英文国际化
│   ├── Dockerfile
│   └── package.json
│
├── docs/                   # 文档
│   ├── collector-architecture.md  # 采集器架构详解
│   └── project-architecture.md    # 本文档
│
└── docker-compose.yml      # 7 个 Docker 服务 + 1 个宿主机 Embedding 服务
```

## 数据库模型（16 张表）

### 核心数据

| 表 | 说明 | 关键字段 |
|----|------|----------|
| **machines** | 采集器设备 | name, collector_token_hash, user_id, last_heartbeat |
| **tools** | AI 工具 | id (claude_code/codex/...), display_name, total_files |
| **projects** | 项目 | slug (unique), title, tool_id, source_path |
| **documents** | 所有采集的文件 | tool_id, project_id, machine_id, category, content, content_hash |
| **document_versions** | 文件版本历史 | document_id, content_hash, content_delta |
| **conversation_messages** | 解析后的对话消息 | document_id, role (user/assistant), content, timestamp |

### 记忆系统

| 表 | 说明 | 关键字段 |
|----|------|----------|
| **document_embeddings** | 文档向量 (pgvector) | document_id, chunk_index, chunk_text, embedding (vector 1024) |
| **knowledge_entities** | 知识实体 | user_id, name, entity_type, summary |
| **knowledge_relations** | 实体关系 | source_id, target_id, relation_type, strength |
| **knowledge_observations** | 实体观察 | entity_id, content, source_document_id |

### 用户与权限

| 表 | 说明 | 关键字段 |
|----|------|----------|
| **users** | 用户 | email, role (pending/viewer/admin/owner), collector_token |
| **permissions** | 权限 | user_id, project_id, tool_id, permission (read/write) |
| **access_logs** | 访问审计 | user_id, document_id, action, ip_address |

### 系统

| 表 | 说明 | 关键字段 |
|----|------|----------|
| **sync_state** | 同步状态 | machine_id, tool_id, relative_path, last_hash, last_offset |
| **daily_summaries** | AI 日报 | summary_date, tool_id, summary, highlights |

## 数据流

### 采集流程

```
本机 AI 工具文件变更
    ↓ Watchdog 检测 (0.3s 去抖)
Tool.classify_file() → FileClassification
    ↓
Parser.parse() → 内容 + 元数据
    ↓
SyncQueue.enqueue() → SQLite 队列
    ↓ SyncClient (5 并发, 指数退避)
POST /api/ingest/file → 服务端
    ↓
ingest_service.py
    ├─ 入库 Document + ConversationMessage
    ├─ 触发 embedding 生成 (→ embedding:8002)
    ├─ 触发知识图谱提取 (→ LLM API)
    └─ SSE 广播 file_synced 事件
```

### 认证体系

```
采集器:  X-Collector-Token → verify_collector_token() → User
         (constant-time 比对 legacy 全局 token;per-user token 走 SQL 索引查)
浏览器:  Authorization: Bearer JWT → get_current_user() → User
MCP:     collector_token → /api/auth/token-exchange → JWT → API 调用

角色: pending → viewer → admin → owner
首个注册用户自动成为 owner + active + 立即分配 collector_token
后续用户注册 = pending,需 admin 在 /admin 页审批 (审批时才生成 token)
```

**Token 生命周期**

| 操作 | 端点 | 权限 |
|---|---|---|
| 注册(首个用户)自动发 token | `POST /api/auth/register` | 匿名 |
| 查看自己的 token | `GET /api/auth/me` | 本人 JWT |
| 重新生成自己的 token | `POST /api/auth/me/rotate-collector-token` | 本人 JWT(需 active) |
| 批准 pending 用户并发 token | `POST /api/admin/users/{id}/approve` | admin/owner |
| 查看全体用户 + 各自 token | `GET /api/admin/users` | admin/owner |

rotate 后旧 token 立即失效(SQL 列直接改),所有使用旧 token 的 collector 下次心跳会被 401 拒,直到 `memento-collector setup` 重新配置。

### 多租户隔离

```
User ──owns──→ Machine ──has──→ Document
                                    ↓
                            user_machine_ids(db, user)
                            → admin/owner: None (看全部)
                            → viewer: [machine_id_1, machine_id_2]
                            → 所有 API 查询自动过滤
```

### MCP 记忆服务

```
AI 工具 ←→ MCP Protocol (stdio / Streamable HTTP)
    ↓
MCP Memory Server
    ├─ memory_search: 语义搜索 (BGE-M3) + 全文搜索 + 图谱匹配
    ├─ memory_recall: 按类别/项目/时间召回
    ├─ memory_context: 项目完整上下文
    ├─ memory_store: 存入新记忆
    └─ daily_summary: 日报摘要

两种运行模式:
  远程: --server URL --token TOKEN (通过 HTTP API)
  直连: --db-url postgresql://... (直接查 DB)
```

### 记忆压缩

```
每 24 小时自动执行:
  1. 找到 7 天前的旧观察 (≥5 条/实体)
  2. LLM 合并为 1-3 条精炼摘要
  3. 更新实体 summary
  4. 删除弱关系 (strength < 1.5)
```

## 采集工具详情

| 工具 | 数据目录 | 采集内容 | 特殊处理 |
|------|---------|---------|---------|
| **Claude Code** | `~/.claude/` | 对话 JSONL, 记忆 MD, 计划 MD, 配置 | 项目路径从 cwd 提取, 子代理标记 |
| **Codex** | `~/.codex/` | 对话 JSONL (FULL), history.jsonl, state_5.sqlite | 线程元数据从 SQLite 增强, 用户历史注入 |
| **Antigravity** | `~/.gemini/antigravity/` | 加密 .pb 文件, 配置, 扩展 | AES-256-GCM 解密 + Protobuf 解析 |
| **Cursor** | `~/.cursor/` | 对话 JSONL, 记忆 MD, 配置 JSON | workspaceStorage 路径映射 |
| **OpenClaw** | `~/.openclaw/` | 对话 JSONL, 身份 MD, 技能 MD, 学习 MD | 多 agent 会话, 日期记忆 |
| **Obsidian** | vault 自动发现 | 所有 .md 笔记 | frontmatter 解析, vault 自动发现 |

## 前端页面

| 页面 | 功能 |
|------|------|
| **首页** `/` | 大英雄卡 + 4 统计卡 + 7 日活动柱图 + 工具卡片 + 最近对话 + 设备状态 |
| **项目** `/projects` | 按工具分组的项目列表, 文件数统计 |
| **时间线** `/projects/[id]/timeline` | 按时间顺序的对话流, 子代理折叠 |
| **对话** `/conversations/[id]` | 聊天气泡: 用户紫/橙渐变,AI 白玻璃卡,工具灰,系统琥珀 |
| **记忆** `/memory` | 知识图谱 SVG 可视化 + 实体详情 + 搜索 |
| **日报** `/daily` | 单月视图 + Prev/Next 翻月 + 2 列布局(日历 + Stats 面板) + 皮肤色 color-mix 热力 + 单元格底部工具 glyph |
| **搜索** `/search` | 全文搜索, 工具/设备过滤 |
| **设备** `/devices` | 在线状态, 版本号, 工具列表 |
| **个人资料** `/profile` | 账号信息 + collector token (遮蔽/显示/复制) + 一键重新生成 + 登出 |
| **管理** `/admin` (admin/owner) | 用户审批,用户行下挂可复制的 collector token;权限管理;同步状态;设备的更新/重采/彻底删除 |

### 主题系统

右上角皮肤切换器支持 **3 套皮肤 × 明暗** = 6 种组合,localStorage 持久化:

| 皮肤 | 视觉特征 | Accent |
|------|---------|--------|
| **Aurora** | 4 团动画光晕背景(紫/粉/青/琥珀)+ 噪点叠加 + glass backdrop-blur + 20px 大圆角 | `#6D28D9` 降饱和紫 |
| **Arc** | 纸色 `#FAFAF7` + 发丝线 + 紧 10px 圆角 + 无模糊 | `#C2410C` 编辑感朱砂橙 |
| **Baseline** | Tailwind `gray-50` + 深灰导航栏 + 经典 12px 卡片 | `#2563EB` 蓝 |

CSS 变量在 `globals.css` 里由 `[data-skin="X"][data-theme="Y"]` 选择器驱动,primitives (`Glass` / `Btn` / `Chip`) 只读 var,切换瞬时生效。浏览器 tab favicon 也会跟着皮肤切换(`favicon-aurora.svg` / `-arc.svg` / `-baseline.svg`)。

### 图标系统

每个工具有**真实品牌 logo**(`BrandMark.tsx`,按官方几何重建):
Claude 四角星、OpenAI 六边形结、Obsidian 宝石、Cursor 楔形、Windsurf 叠波、VS Code 折角、Antigravity 轨道、Openclaw。
- Aurora 皮肤:彩色渐变方块 + 白色品牌 mark + 顶部高光
- Arc / Baseline:白底 + 品牌色 10% tint + 品牌色 mark

## 部署

### 一键安装（推荐）

从 `mem.ihasy.com` 起源,无需先 clone:

```bash
# macOS / Linux
curl -fsSL https://mem.ihasy.com/install.sh | sh

# Windows (PowerShell)
iwr https://mem.ihasy.com/install.ps1 -useb | iex
```

脚本（`install.sh` / `install.ps1`）会:
1. 检查 Docker / curl / tar / Python 3.11+
2. 下载仓库到 `~/memento/`(或 `$MEMENTO_INSTALL_DIR`)
3. 生成 `.env` 随机密钥(`MEMENTO_SECRET_KEY` / `MEMENTO_COLLECTOR_TOKEN` / `POSTGRES_PASSWORD` / `MINIO_*`,幂等)
4. `docker compose up -d --build` 起 7 个容器(postgres/redis/minio/api/celery-worker/celery-beat/web)
5. 交互提示创建第一个用户(auto-owner,拿 `collector_token`)
6. `pip install memento-brain-collector` + 非交互 setup 注册为系统服务

实现细节:`install.sh` 是薄 launcher,只负责找 Python;`scripts/install.py` 是主逻辑;`scripts/install_lib/*` 分 6 个模块:`platform_utils` / `env_gen` / `docker_up` / `bootstrap_user` / `collector_setup` / `embedding_host`。跨平台服务安装(launchd / systemd / Scheduled Task)复用 `collector/collector/cli.py` 里现成的 `_install_launchd` / `_install_systemd` / `_install_windows_task` 模板写法。

### 子命令

```bash
./install.sh                    # 全流程安装 (不含 embedding)
./install.sh embedding          # 单独装 BGE-M3 宿主服务 (venv + torch + 模型 ~1.3GB)
./install.sh doctor             # 服务状态表
./install.sh update             # git pull + 重建 + pip -U
./install.sh uninstall          # 停服务, 保留数据
./install.sh uninstall --purge  # + 删 docker 卷 + .env
./install.sh uninstall --all    # 彻底: pip 包 / ~/.memento / 日志 / 模型缓存 /
                                #       docker 镜像 / MCP 条目 (Claude/Cursor/Codex)
```

### 手动部署（开发者）

```bash
# 1. Docker 栈
docker compose up -d --build

# 2. 宿主 embedding (可选, 语义搜索 + MCP 记忆依赖它)
launchctl load ~/Library/LaunchAgents/com.memento.embedding.plist   # macOS
# Linux:   systemctl --user enable --now memento-embedding
# Windows: schtasks /Run /TN MementoEmbedding
```

### 端口映射

| 服务 | 端口 | 运行位置 |
|------|------|---------|
| API | 8001 (→8000) | Docker |
| Web | 3001 (→3000) | Docker |
| PostgreSQL | 5433 (→5432) | Docker |
| Redis | 6380 (→6379) | Docker |
| MinIO | 9000/9001 | Docker |
| Embedding | 8002 | **宿主机** (M4 MPS GPU) |

### 新用户使用

**第 1 步:拿到 collector token**
- 自己部署的 server,跑 `./install.sh` 时终端已打印 `MEMENTO_COLLECTOR_TOKEN`
- 或者打开 Web (http://localhost:3001/auth/register) 注册。首个用户 → 自动 owner,注册成功页直接显示 token;后续用户 → pending,待 owner/admin 在 `/admin` 审批,token 审批时发

**第 2 步:在每台设备上装采集器**

```bash
# 1. 安装采集器 + MCP 记忆服务
pip install memento-brain-collector

# 2. 交互式配置（自动注入 5 个 AI IDE 的 MCP 条目:Claude Code/Cursor/Windsurf/Antigravity/Codex）
memento-collector setup
# → 提示填入 Server URL 和第 1 步拿到的 token

# 3. 开始采集
memento-collector start
```

Token 丢了、需要轮换、或某台设备被泄露想吊销全量 → Web `/profile` 点"重新生成",然后每台设备 `memento-collector setup` 重填新 token。

### 环境变量

所有 key 用 `MEMENTO_` 前缀(历史 `DR_*` 已通过 `scripts/migrate_rebrand.py` 迁移)。

#### 服务端核心

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_DATABASE_URL` | postgresql+asyncpg://postgres:postgres@localhost:5433/memento | Postgres 连接 |
| `MEMENTO_REDIS_URL` | redis://localhost:6380/0 | Redis broker + backend |
| `MEMENTO_SECRET_KEY` | change-me-in-production | JWT 签名密钥(生产下必须覆盖) |
| `MEMENTO_COLLECTOR_TOKEN` | collector-dev-token | legacy 全局 collector token(生产下必须覆盖) |
| `MEMENTO_S3_ENDPOINT` / `MEMENTO_S3_ACCESS_KEY` / `MEMENTO_S3_SECRET_KEY` / `MEMENTO_S3_BUCKET` | http://localhost:9000 / minioadmin / minioadmin / memento | MinIO 凭据(生产下 access/secret 必须覆盖) |
| `MEMENTO_DEBUG` | `0` | `1` 时跳过 `validate_production()` 的 fail-fast |
| `MEMENTO_PORT` | 8000 | API 容器内端口 |

启动时 `validate_production()` 会检查 `SECRET_KEY` / `COLLECTOR_TOKEN` / `S3_*` 是否仍是默认值,如是且 `DEBUG=0` 则拒绝启动。

#### AI 后端

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_ANTHROPIC_API_KEY` | — | Claude API(主 AI 摘要后端) |
| `MEMENTO_AI_BASE_URL` | https://coding.dashscope.aliyuncs.com/v1 | OpenAI 兼容备用端点 |
| `MEMENTO_AI_API_KEY` | — | 备用端点 key |
| `MEMENTO_AI_MODEL` | kimi-k2.5 | 备用端点模型名 |
| `MEMENTO_COMPACTION_AGE_DAYS` | `7` | 记忆压缩触发阈值 |

#### Embedding

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_EMBEDDING_SERVER_URL` | http://host.docker.internal:8002 | 服务端调宿主 embedding 的 URL |
| `MEMENTO_EMBEDDING_DIM` | 1024 | 向量维度(BGE-M3 = 1024) |
| `MEMENTO_EMBEDDING_PORT` | 8002 | 宿主 embedding 监听端口 |
| `MEMENTO_EMBEDDING_MODEL_NAME` | BAAI/bge-m3 | sentence-transformers 模型 |

#### 采集器(collector 侧)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_SERVER_URL` | http://localhost:8001 | 中心服务 URL(由 collector 侧读) |
| `MEMENTO_SERVER_TOKEN` | — | collector token |
| `MEMENTO_OBSIDIAN_VAULT_PATH` | 自动发现 | Obsidian vault 覆盖 |
| `MEMENTO_NONINTERACTIVE` | — | `1` 时 setup 跳过所有 prompt |

## 技术栈

| 层 | 技术 |
|----|------|
| **后端** | Python ≥3.12, FastAPI ≥0.115, SQLAlchemy 2.0 async, asyncpg, Celery 5.4 |
| **前端** | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| **数据库** | PostgreSQL 16 + pgvector, Redis 7 |
| **存储** | MinIO (S3 兼容) |
| **采集器** | Python ≥3.10, watchdog, httpx, cryptography(内置 Antigravity .pb 解密) |
| **MCP 记忆** | Python ≥3.10, mcp ≥1.26, pgvector, sqlalchemy[asyncio] |
| **AI/ML** | BGE-M3 sentence-transformers(宿主 GPU)+ Anthropic Claude SDK + OpenAI 兼容(Kimi/DashScope 等) |
| **协议** | MCP(stdio + Streamable HTTP), SSE, JWT |
| **部署** | Docker Compose, PyPI(memento-brain / memento-brain-collector / memento-brain-memory) |
