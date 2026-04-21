# Memento

> 给你的 AI 工具建个共享大脑。

自动采集多台设备上 AI 编程工具的对话、计划、记忆文件,实时同步到服务器,通过 Web 仪表板 + MCP 统一查看、搜索、召回。

## 支持的 AI 工具

| 工具 | 采集内容 | 格式 |
|------|---------|------|
| Claude Code | 对话、记忆、计划、历史 | JSONL / Markdown |
| OpenClaw | 对话会话、身份、记忆、学习、技能 | JSONL / Markdown |
| Codex | 对话、历史、技能、状态 | JSONL / TOML / SQLite |
| Antigravity | 完整对话（内置解密 `.pb`）、计划、代码快照 | Protobuf / Markdown |
| Obsidian | 所有笔记 | Markdown |
| Cursor | 对话、技能、MCP 配置 | JSONL / Markdown |

## 架构

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  设备 A       │     │              │     │              │
│  Collector   │────▶│   Server     │◀────│   Web UI     │
│  (Python)    │     │  (FastAPI)   │     │  (Next.js)   │
└──────────────┘     │              │     │              │
┌──────────────┐     │  PostgreSQL  │     │  设备→工具    │
│  设备 B       │────▶│  Redis       │     │  →项目→对话   │
│  Collector   │     │  Celery      │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
```

- **Collector** — macOS / Linux / Windows 守护进程,watchdog 跨平台文件监听(FSEvents / inotify / ReadDirectoryChangesW),实时同步
- **Server** — FastAPI + PostgreSQL(+ pgvector) + Redis + Celery + MinIO,REST API + SSE 实时推送
- **Web** — Next.js 16 + Tailwind,设备→工具→项目→对话层级导航,中英文国际化

## 快速开始

### 一键安装（推荐）

无需先 clone,从 `mem.ihasy.com` 直接起：

```bash
# macOS / Linux
curl -fsSL https://mem.ihasy.com/install.sh | sh

# Windows (PowerShell)
iwr https://mem.ihasy.com/install.ps1 -useb | iex
```

也可以浏览器打开 <https://mem.ihasy.com/install> 拿复制好的命令。

脚本会下载仓库到 `~/memento/`（可用 `MEMENTO_INSTALL_DIR` 覆盖），然后跑内置的 `./install.sh`。

如果你已经 clone 了仓库：

```bash
cd memento
./install.sh            # macOS / Linux
.\install.ps1           # Windows
```

自动完成:
1. 生成 `.env` 随机密钥(JWT / collector token / MinIO user+password / Postgres 密码)
2. `docker compose up -d --build` 起 7 个容器(postgres、redis、minio、api、celery-worker、celery-beat、web)
3. 探活 API `/health`
4. 交互提示创建第一个用户(自动 owner,拿 collector_token)
5. `pip install memento-brain-collector` + 非交互 setup + 注册为系统服务

可选参数:

```bash
./install.sh embedding   # 装宿主 embedding 服务 (BGE-M3，~1.3GB，用于语义搜索和 MCP 记忆)
./install.sh doctor      # 检查所有服务状态
./install.sh update      # git pull + 重建 + 升级
./install.sh uninstall           # 停服务,保留数据和配置
./install.sh uninstall --purge   # 同上 + 清 docker 数据卷 + .env
./install.sh uninstall --all     # 彻底卸载:pip 包、~/.memento 配置、
                                 # 日志、BGE-M3 模型缓存、docker 镜像、
                                 # Claude/Cursor/Codex 的 MCP 配置条目
                                 # (加 -y 跳过二次确认)
```

服务端口（避免与其他项目冲突）:
- **API**: http://localhost:8001 （Swagger: http://localhost:8001/docs）
- **Web**: http://localhost:3001
- **Embedding**: http://localhost:8002 （宿主，可选）
- **PostgreSQL**: 5433
- **Redis**: 6380
- **MinIO**: 9000（控制台 9001）

### 在额外设备上安装采集器

```bash
pip install memento-brain-collector   # 只装采集器
# 或 pip install memento-brain         # 一键装齐 collector + MCP memory server
memento-collector setup                # 交互式填 URL + token
```

> PyPI 包名是 `memento-brain-collector` / `memento-brain-memory`(别人占了 `memento-memory` 短名),CLI 保留短别名 `memento-collector` / `memento-memory`。

Setup 向导会:
1. 检测当前平台（macOS / Linux / Windows）
2. 生成唯一设备 ID
3. 自动发现 Obsidian vault
4. 配置服务器地址和 token
5. 安装为系统服务（可选）

**从哪拿到 token?** 两条路,取决于你是怎么起的服务端:

- **一键安装 (`./install.sh`)** → 首次运行末尾会打印 `MEMENTO_COLLECTOR_TOKEN`,同时保存到 `.env.local`
- **Web 注册** → 打开 http://localhost:3001/auth/register,第一个注册的用户自动成为 owner,注册成功页直接显示 token(有复制按钮);之后也可随时在右上角头像 → 个人资料页看到/重新生成

### 管理采集器

```bash
memento-collector status    # 查看状态
memento-collector start     # 启动服务
memento-collector stop      # 停止服务
memento-collector run       # 前台运行（调试）
```

服务管理方式按平台自动适配：
- **macOS**: launchd (LaunchAgent)
- **Linux**: systemd (user service)
- **Windows**: Task Scheduler

### 完全卸载

分两种场景 —— **服务端机器**(跑过 `./install.sh` 的)和**只装了采集器的设备**。

#### 1) 服务端:用 `./install.sh` 分级卸载

```bash
./install.sh uninstall          # 只停容器,保留数据卷 / .env / pip 包 / 配置
./install.sh uninstall --purge  # 同上 + 删 docker 数据卷 (Postgres/MinIO 里所有同步的数据丢失) + .env
./install.sh uninstall --all    # 核弹级 (加 -y 跳过二次确认)
```

`--all` 会连带清掉:
- pip 包 `memento-brain-collector` / `memento-brain-memory` / `memento-brain` (+ 旧品牌 `memento-collector` / `memento-memory` / `daily-report-*`)
- `~/.memento`(设备 ID、离线队列 SQLite、config.json) + `~/.daily-report`(旧路径,兼容清理)
- Collector 日志:`~/Library/Logs/memento`(macOS)/`~/.local/share/memento/logs`(Linux)/`%LOCALAPPDATA%\memento\logs`(Windows) + 旧路径
- Embedding venv + HuggingFace 模型缓存(~1.3GB)
- Docker 镜像 `memento-api` / `memento-web` / `memento-celery-worker` / `memento-celery-beat`
- Docker 数据卷 `memento_pgdata` / `memento_miniodata`
- `.env` / `.env.local`
- Claude Code / Cursor / Windsurf / Antigravity 的 MCP 配置里 `memento-memory` 条目 + Codex `config.toml` 里 `[mcp_servers.memento-memory]` 块

#### 2) 只装了采集器的设备

没有 `./install.sh` 的机器,按下列顺序手动清:

```bash
# a. 停服务(launchd / systemd / Task Scheduler 自动识别并摘掉)
memento-collector uninstall

# b. 卸 pip 包(三个都卸干净,新老名称都覆盖)
pip uninstall -y memento-brain-collector memento-brain-memory memento-brain \
                 memento-collector memento-memory

# c. 删设备状态目录(配置 + 离线队列)
rm -rf ~/.memento

# d. 删日志(按平台选一条)
rm -rf ~/Library/Logs/memento                            # macOS
rm -rf ~/.local/share/memento/logs                       # Linux
# Windows (PowerShell):  Remove-Item -Recurse $env:LOCALAPPDATA\memento

# e. 从 AI 工具里摘 MCP 记忆条目(如果装过)
# - Claude Code:  ~/.claude.json 里删掉 "memento-memory" 块
# - Cursor:       ~/.cursor/mcp.json 里同上
# - Windsurf:     ~/.config/windsurf/mcp.json 里同上
# - Antigravity:  ~/Library/Application Support/antigravity/mcp.json 里同上
# - Codex:        ~/.codex/config.toml 里删 [mcp_servers.memento-memory] 块
```

验证清干净:
```bash
which memento-collector                # 应显示 not found
ls ~/.memento 2>&1                     # 应 No such file
launchctl list | grep -i memento       # macOS,应无输出
systemctl --user list-units | grep memento   # Linux,应无输出
pip list | grep -i memento             # 应空
```

#### 3) 服务端上只想重置数据,保留 schema/配置

```bash
docker compose down -v      # 停栈 + 删 Postgres/MinIO 数据卷
./install.sh                # 重起,.env 不变,从零创建 DB + bucket + 第一个用户
```

### Antigravity 完整对话

Antigravity 的 `.pb` 对话文件是 AES-256-GCM 加密 + Protobuf 编码的,**Memento 采集器内置解密逻辑**([collector/collector/parsers/antigravity_pb_decoder.py](collector/collector/parsers/antigravity_pb_decoder.py)),不依赖任何外部工具,主包 `memento-brain-collector` 已包含 `cryptography` 依赖,装主包就够,无需额外 extras。

- **启动时**:扫一次 `~/.antigravity/` 和 `~/.gemini/antigravity/conversations/*.pb`,全量导出一次
- **运行中**:watchdog 监听 `.pb` 文件写入事件,变更即重新解密入队(事件驱动,非定时轮询)

### 本机高还原导出 Codex 对话（可选）

如果你要把某台机器上的 Codex 本地对话记录完整导出出来做备份、迁移或离线分析，可以直接跑仓库内置导出脚本：

```bash
python3 collector/scripts/export_codex_local.py \
  --codex-home ~/.codex \
  --output-dir ./dist/codex-export
```

默认会产出三类内容：

- `raw/.codex/`：原始 `sessions` / `archived_sessions` / `state_5.sqlite` / `logs_2.sqlite` 等证据文件
- `normalized/threads.jsonl`、`normalized/events.jsonl`、`normalized/index.sqlite`：标准化索引，便于二次处理
- `markdown/*.md`：每个 thread 一份可读 transcript

注意：

- `reasoning.encrypted_content` 属于加密推理内容，脚本会保留事件并标注为已省略，但不能解密成明文
- 若要尽量带上 shell 环境快照，可额外加 `--include-shell-snapshots`
- 最稳妥的导出方式仍然是先退出 Codex，再执行导出，避免 SQLite 正在写入时只拿到部分 WAL

## 多设备分布式

在任何设备上安装采集器，填入服务器地址即可：

```bash
pip install memento-brain-collector
memento-collector setup
# Server URL: http://your-server:8001
# Collector token: your-token
```

所有设备的数据自动汇总到同一个服务器，前端按 **设备 → 工具 → 项目 → 对话** 层级展示。

## 用户与权限

四种角色:

| 角色 | 说明 |
|---|---|
| `owner` | 首个注册用户自动获得。可改任意用户 role/status,看全量数据 |
| `admin` | 可审批 pending 用户、管理设备与权限、看 audit log |
| `viewer` | 只读(批准后默认)。只能看分给自己的 project/tool |
| `pending` | 新注册未激活。登录会被拒绝,需 admin 批准 |

关键操作:

- **注册**:http://localhost:3001/auth/register
  - 首个用户 → 自动 owner + active,注册成功页直接显示 collector token
  - 后续用户 → pending,等 admin 到 `/admin` 页点批准,批准后会分配 token
- **查看 / 重新生成自己的 token**:右上角头像 → 个人资料页
  - 重新生成后,老 token 立即失效,所有用此 token 的 collector 需要重新 `memento-collector setup`
- **批准新用户**:owner/admin 打开 `/admin`,pending 用户旁有批准按钮。批准后该用户的 collector token 会立刻出现在行下,可复制给对方
- **改角色**(仅 owner):`PUT /api/admin/users/{id}`,body `{role, status}`。前端暂未做 UI,走 Swagger 或 curl
- **细粒度授权**:`/api/admin/permissions/grant`,按 project_id / tool_id 给 viewer 发 `read`/`write` 权限

API 摘要:

- `POST /api/auth/register` — 注册
- `POST /api/auth/login` — 拿 JWT
- `GET  /api/auth/me` — 查自己(含 collector_token)
- `POST /api/auth/me/rotate-collector-token` — 自己重新生成 token
- `GET  /api/admin/users` / `POST /api/admin/users/{id}/approve` / `PUT /api/admin/users/{id}` — owner/admin 专用

## 前端功能

- **Dashboard** — 设备卡片，每个设备下显示工具图标和文件数
- **工具详情** — 左侧分类过滤 + 项目列表，右侧文件浏览
- **对话查看** — 聊天气泡 UI，用户/AI/工具调用分角色着色
- **文档查看** — Markdown 渲染 / JSON 语法高亮
- **搜索** — 全文搜索，支持工具和设备过滤
- **日报** — 按日期聚合，热力图日历
- **设备管理** — 查看/删除设备
- **个人资料** — `/profile` 查看账号信息 + collector token(遮蔽/显示/复制) + 一键重新生成
- **管理** — `/admin`(admin/owner 可见)用户审批、设备管理、同步状态,用户行下带可复制 token
- **国际化** — 中文 / English 切换
- **响应式** — 手机端可折叠侧边栏

## 技术栈

| 层级 | 技术 |
|------|------|
| 采集器 | Python ≥3.10, watchdog, httpx, pydantic-settings |
| MCP 记忆 | Python ≥3.10, mcp ≥1.26, asyncpg, pgvector |
| 服务端 | Python ≥3.12, FastAPI ≥0.115, SQLAlchemy 2.0 async, asyncpg, Celery |
| 数据库 | PostgreSQL 16 (+ pgvector), Redis 7, MinIO (S3 兼容) |
| 前端 | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| AI 摘要 / 图谱 | Anthropic Claude API + OpenAI 兼容端点(Kimi/DashScope...) |
| Embedding | BGE-M3 宿主运行(macOS MPS / Linux CUDA / CPU 回退) |
| 部署 | Docker Compose(7 服务) |

## 目录结构

```
memento/
├── collector/                  # 本地采集器(Python) — PyPI: memento-brain-collector
│   ├── collector/
│   │   ├── main.py             # 守护进程入口(心跳 + 自动更新)
│   │   ├── cli.py               # setup / install / start / stop / status / uninstall
│   │   ├── watcher.py           # watchdog 跨平台监听 + 去抖
│   │   ├── queue.py             # SQLite WAL 离线队列
│   │   ├── sync_client.py       # HTTP 同步(支持分片上传 / 离线重试)
│   │   ├── sanitizer.py         # 入队前脱敏(API key / 私钥 / OAuth token)
│   │   ├── parsers/             # 8 个解析器(markdown/jsonl/json/toml/sqlite + antigravity 三件套)
│   │   └── tools/               # 6 个工具定义(claude_code/codex/cursor/openclaw/antigravity/obsidian)
│   └── pyproject.toml
├── mcp_server/                 # MCP 记忆服务 — PyPI: memento-brain-memory
├── memento_brain/              # Meta 包 — PyPI: memento-brain(一键装齐)
├── server/                     # 后端 FastAPI
│   ├── server/
│   │   ├── main.py             # 应用入口 + 启动期 schema 迁移 + validate_production
│   │   ├── config.py            # Settings(MEMENTO_ 前缀)+ fail-fast
│   │   ├── middleware/auth.py   # JWT + collector token (constant-time 比对)
│   │   ├── api/                 # REST + SSE + MCP 挂载(auth/admin/ingest/dashboard/daily/...)
│   │   ├── db/                  # SQLAlchemy 16 张表
│   │   ├── services/            # ingest/embedding/graph/sse/memory_compaction/ai_summary
│   │   └── tasks/               # Celery worker + beat
│   └── Dockerfile
├── web/                        # Next.js 16 前端
│   ├── src/app/                # 18 个页面(含 /auth/register /profile /admin /daily /memory ...)
│   ├── src/components/          # Aurora 设计系统原语 + TokenDisplay
│   └── Dockerfile
├── embedding/                  # BGE-M3 宿主服务(Docker 版 + launchd plist)
├── scripts/                    # install.sh 的 Python 后端 + migrate_rebrand.py
├── deploy/bootstrap/           # curl 一键安装脚本 (install.sh / install.ps1 / index.html)
├── docs/                       # project-architecture.md / collector-architecture.md
└── docker-compose.yml
```

## 环境变量

所有环境变量统一用 `MEMENTO_` 前缀(历史遗留的 `DR_*` 已通过 `scripts/migrate_rebrand.py` 迁移完毕)。

### 采集器(collector)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_SERVER_URL` | http://localhost:8001 | 服务端 API 地址 |
| `MEMENTO_SERVER_TOKEN` | — | collector token(也叫 `MEMENTO_COLLECTOR_TOKEN` 在服务端侧) |
| `MEMENTO_OBSIDIAN_VAULT_PATH` | 自动发现 | Obsidian vault 路径 |
| `MEMENTO_NONINTERACTIVE` | — | setup 时设为 `1` 跳过所有 prompt |

### 服务端(api / celery)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_DATABASE_URL` | postgresql+asyncpg://postgres:postgres@localhost:5433/memento | Postgres 连接 |
| `MEMENTO_REDIS_URL` | redis://localhost:6380/0 | Redis broker + backend |
| `MEMENTO_COLLECTOR_TOKEN` | collector-dev-token | 兜底的全局 collector token(dev 用,生产请依赖每用户 token) |
| `MEMENTO_SECRET_KEY` | change-me-in-production | JWT 签名密钥(生产下必须覆盖,否则 api 启动 fail-fast) |
| `MEMENTO_S3_ENDPOINT` | http://localhost:9000 | MinIO/S3 端点 |
| `MEMENTO_S3_ACCESS_KEY` / `MEMENTO_S3_SECRET_KEY` | minioadmin / minioadmin | MinIO 凭据(生产下必须覆盖) |
| `MEMENTO_S3_BUCKET` | memento | 大文件存储 bucket |
| `MEMENTO_ANTHROPIC_API_KEY` | — | Claude API(AI 摘要) |
| `MEMENTO_AI_API_KEY` / `MEMENTO_AI_BASE_URL` / `MEMENTO_AI_MODEL` | — / dashscope / kimi-k2.5 | OpenAI 兼容备用端点(用于图谱提取 + 日报摘要) |
| `MEMENTO_EMBEDDING_SERVER_URL` | http://host.docker.internal:8002 | 宿主 BGE-M3 服务 |
| `MEMENTO_DEBUG` | `0` | 设 `1` 允许 dev 默认值启动(跳过 validate_production) |
| `MEMENTO_PORT` | 8000 | API 监听端口(容器内,外部映射 8001) |

### Embedding 服务

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_EMBEDDING_PORT` | 8002 | HTTP 监听端口 |
| `MEMENTO_EMBEDDING_MODEL_NAME` | BAAI/bge-m3 | sentence-transformers 模型 |

## DDNS / 远程访问

支持通过域名 + IPv6 DDNS 远程访问:

- 前端 API 地址自动跟随 `window.location.hostname`(代码里是 `getApiBase()`,不写死)
- Docker 端口映射自动支持 IPv4 + IPv6

放行域名需要改 [server/server/main.py](server/server/main.py) 里的 `allow_origin_regex` — 当前默认:
```python
allow_origin_regex=r"(https?://localhost:\d+|https?://mem\.ihasy\.com)"
```
改成你自己的正则即可(比如加上 `|https?://memento\.example\.com`)。

## License

MIT
