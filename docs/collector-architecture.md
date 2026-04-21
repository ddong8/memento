# Memento Collector 采集器架构文档

## 系统概览

采集器（`memento-collector`）是一个跨平台后台守护进程，自动监控本机 AI 编程工具的数据文件，解析后同步到中心服务器。支持 macOS、Windows、Linux。

```
文件变更 → Watchdog 检测 → 去抖 → 分类 → 解析 → 入队 → 上传服务器
```

## 核心架构

### 数据流

```
┌─────────────────────────────────────────────────────────────────┐
│                         本机 AI 工具文件                          │
│  ~/.claude/  ~/.codex/  ~/.antigravity/ + ~/.gemini/antigravity/ │
│  ~/.cursor/  ~/.openclaw/  <Obsidian vault 自动发现>             │
└─────────────┬───────────────────────────────────────────────────┘
              │ watchdog (FSEvents / inotify / ReadDirectoryChangesW)
              ▼
┌─────────────────────────┐
│  _DebouncedHandler      │  0.3 秒去抖,合并连续写入
│  排除指定路径            │
└─────────────┬───────────┘
              │
              ▼
┌─────────────────────────┐
│  FileWatcher            │
│  ├─ 找到归属工具        │  tool_map: root_path → Tool
│  ├─ tool.classify_file  │  → FileClassification
│  ├─ 哈希变更检测        │  size + mtime + 前 256KB SHA-256
│  ├─ 入队前脱敏          │  sanitize_text / sanitize_json(防本地 SQLite 取证泄密)
│  ├─ 选择解析器          │  Markdown/JSONL/JSON/TOML/SQLite + Antigravity .pb/vscdb
│  └─ parser.parse()      │  → 内容 + 偏移量 + 元数据
└─────────────┬───────────┘
              │
              ▼
┌─────────────────────────┐
│  SyncQueue (SQLite)     │  WAL 模式，线程安全
│  ├─ queue 表            │  待同步项（content, hash, metadata）
│  └─ file_state 表       │  每文件的 hash + offset 记录
└─────────────┬───────────┘
              │
              ▼
┌─────────────────────────┐
│  SyncClient             │  后台线程 + 5 并发上传
│  ├─ < 1MB: JSON POST    │  /api/ingest/file
│  ├─ 1-2MB: multipart    │  /api/ingest/file/upload
│  └─ > 2MB: 分块上传     │  /api/ingest/file/chunk (2MB/块)
└─────────────┬───────────┘
              │ HTTP + X-Collector-Token
              ▼
┌─────────────────────────┐
│  中心服务器              │
│  /api/ingest/*           │
└─────────────────────────┘
```

### 同步策略

| 策略 | 说明 | 使用场景 |
|------|------|----------|
| **FULL** | 文件变更时上传全部内容，哈希不变则跳过 | 配置、身份、记忆、计划 |
| **DELTA** | 只上传新增的行（追踪偏移量），文件截断时重传 | history.jsonl、对话 JSONL |
| **POLL** | 不走文件监听，周期性轮询（60 秒） | SQLite 数据库 |
| **IGNORE** | 仅追踪不同步 | 保留 |

### 主循环

守护进程启动后，在主线程运行事件循环：

- **每 1 秒**：检查是否收到退出信号
- **每 30 秒**：心跳日志（待同步数量）
- **每 10 秒**：轮询服务器命令（resync / update）
- **每 1 小时**：检查 PyPI 是否有新版本，自动升级并重启

启动时的后台线程：
1. **工具发现**：上报本机安装的工具 → `/api/ingest/discovery`
2. **初始扫描**：全量扫描所有监控文件，入队变更项
3. **文件监听**：Watchdog Observer 实时监听
4. **同步客户端**：后台上传队列中的文件
5. **Antigravity 导出**：解密 .pb 文件（如果 Antigravity 可用）

---

## 各工具采集详情

### 1. Claude Code

**数据目录**：`~/.claude/`

| 监控路径 | 类别 | 内容类型 | 同步策略 | 说明 |
|----------|------|----------|----------|------|
| `settings.json` | config | JSON | FULL | 全局设置 |
| `plans/*.md` | plan | Markdown | FULL | AI 生成的计划文件 |
| `projects/**/*.jsonl` | conversation | JSONL | DELTA | 对话会话记录（含子代理） |
| `projects/**/*.meta.json` | conversation | JSON | FULL | 子代理元数据 |
| `projects/**/memory/*.md` | memory | Markdown | FULL | 项目级记忆文件 |
| `history.jsonl` | history | JSONL | DELTA | 命令历史 |

**特殊处理**：
- **项目路径解析**：从 JSONL 中提取 `cwd` 字段，将哈希路径（如 `-Users-xxx-dev-myproject`）映射到真实路径
- **子代理标记**：路径包含 `subagents/` 的文件标记 `is_subagent=True`
- **会话 ID**：取 JSONL 文件名作为 session_id

**排除目录**：telemetry, backups, cache, ide, debug, tool-results, sessions, shell-snapshots, downloads, plugins, file-history 等

---

### 2. Codex (OpenAI)

**数据目录**：`~/.codex/`

| 监控路径 | 类别 | 内容类型 | 同步策略 | 说明 |
|----------|------|----------|----------|------|
| `config.toml` | config | TOML | FULL | 模型、推理级别、个性设置 |
| `AGENTS.md` | identity | Markdown | FULL | Agent 指令 |
| `history.jsonl` | history | JSONL | DELTA | 所有会话的用户输入历史 |
| `sessions/**/*.jsonl` | conversation | JSONL | **FULL** | 活跃会话（FULL 避免丢失头部的 user_message） |
| `archived_sessions/*.jsonl` | conversation | JSONL | **FULL** | 归档会话 |
| `logs_1.sqlite` | state | SQLite | POLL | 结构化日志 |
| `state_5.sqlite` | state | SQLite | POLL | 线程和任务状态 |

**特殊处理**：
- **线程元数据增强**：
  - 从 `state_5.sqlite` 的 `threads` 表读取 title 和 first_user_message
  - 从 `history.jsonl` 读取会话的所有用户输入（含时间戳）
  - 两者注入到 metadata，服务端用于补全对话中缺失的用户消息
- **项目路径提取**：从 session_meta 的 cwd 字段获取，过滤通用目录名
- **线程 ID 提取**：先尝试读 session_meta 中的 payload.id，失败则从文件名中匹配 UUID

**排除**：auth.json, cache, tmp, log, shell_snapshots, vendor_imports

---

### 3. Antigravity (Google 的 AI IDE)

**数据目录**：`~/.antigravity/` + `~/.gemini/antigravity/`

| 监控路径 | 类别 | 内容类型 | 同步策略 | 说明 |
|----------|------|----------|----------|------|
| `argv.json` | config | JSON | FULL | 启动配置 |
| `extensions/extensions.json` | extension | JSON | FULL | 已安装扩展列表 |
| `~/.gemini/GEMINI.md` | identity | Markdown | FULL | Gemini 身份文件 |
| `conversations/*.pb` | conversation | JSONL | FULL | **加密的对话文件**,内置解密(无需外部工具) |

**加密解密流程**（最复杂的工具,全部内置在 `parsers/antigravity_pb_decoder.py`）：

```
.pb 文件 (AES-256-GCM 加密)
    │ 密钥: safeCodeiumworldKeYsecretBalloon
    │ 格式: nonce(12) || ciphertext || tag(16)
    ▼
Protobuf 明文 (Trajectory)
    │ field 6: cascade_id (会话 UUID)
    │ field 7: workspace (file:// URI)
    │ field 2: Steps (事件序列)
    ▼
步骤解析
    ├─ Type 14 USER_INPUT → field 19 → 用户文本
    ├─ Type 15 PLANNER_RESPONSE → field 20
    │   ├─ field 1: AI 可见评论（进行中解释）
    │   └─ field 3: 内部思考过程
    └─ Type 82 NOTIFY_USER → field 94
        ├─ field 2: AI 正式回复
        └─ field 1: 引用的计划文件 URI
    ▼
JSONL 输出
    session_meta + user/assistant 消息
```

**标题来源**：
1. 优先：vscdb 的 `trajectorySummaries` 缓存
2. 备选：第一条用户消息，截断到 80 字符

**排除**：extensions/dist, extensions/bundled, node_modules, code_tracker, brain, browser_recordings 等

---

### 4. Cursor

**数据目录**：`~/.cursor/`

| 监控路径 | 类别 | 内容类型 | 同步策略 | 说明 |
|----------|------|----------|----------|------|
| `argv.json` | config | JSON | FULL | 启动配置 |
| `extensions/extensions.json` | extension | JSON | FULL | 已安装扩展 |
| `projects/**/*.jsonl` | conversation | JSONL | DELTA | Agent 对话记录 |
| `projects/**/*.md` | memory | Markdown | FULL | MCP 指令和项目规则 |
| `projects/**/*.json` | config | JSON | FULL | 项目和 MCP 元数据 |
| `ai-tracking/*.db` | state | SQLite | POLL | AI 代码追踪数据库 |

**特殊处理**：
- **项目路径解析**：读取 `~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/workspace.json`，获取 `folder` URI 映射
- **备选方案**：从 JSONL 中提取 cwd 字段
- **子代理标记**：路径含 `subagents` 标记 `is_subagent=True`

**排除**：skills-cursor/（内置技能模板）

---

### 5. OpenClaw

**数据目录**：`~/.openclaw/`

| 监控路径 | 类别 | 内容类型 | 同步策略 | 说明 |
|----------|------|----------|----------|------|
| `openclaw.json` | config | JSON | FULL | 主配置文件 |
| `workspace/*.md` (核心文件) | identity | Markdown | FULL | AGENTS.md, SOUL.md, MEMORY.md, IDENTITY.md, USER.md, HEARTBEAT.md, TOOLS.md |
| `workspace/memory/*.md` | memory | Markdown | FULL | 日期命名的每日记忆（YYYY-MM-DD.md） |
| `workspace/.learnings/*.md` | learning | Markdown | FULL | ERRORS.md, LEARNINGS.md, FEATURE_REQUESTS.md |
| `workspace/skills/**/*.md` | skill | Markdown | FULL | Agent 技能文件（自我改进框架） |
| `agents/*/sessions/*.jsonl` | conversation | JSONL | DELTA | 聊天会话（所有 agent） |

**元数据增强**：
- 身份文件：`identity_type` = 文件名（AGENTS, SOUL 等）
- 每日记忆：`date_hint` = 文件名日期
- 学习文件：`learning_type` = 文件名类型
- 会话：`agent_name` = 路径中的 agent 名称（main, research 等）

**排除**：credentials, logs, hooks, media, canvas, subagents, tasks, flows, memory(根级), completions, delivery-queue, extensions, devices, identity, telegram, qqbot

---

### 6. Obsidian

**数据目录**：用户的 Vault 路径（自动发现或配置）

| 监控路径 | 类别 | 内容类型 | 同步策略 | 说明 |
|----------|------|----------|----------|------|
| `**/*.md` | note | Markdown | FULL | 所有 Markdown 笔记（递归） |

**Vault 发现**：
1. 读取 `obsidian.json`（Obsidian 自身配置），获取已打开的 vault 路径
2. 回退到 `~/Documents/Obsidian`

**元数据**：
- `vault_name`：Vault 目录名
- `folder`：笔记所在的顶级文件夹

**排除**：.obsidian/（配置目录）, .trash/（回收站）

---

## 变更检测机制

### 快速哈希

```python
hash = SHA-256(file_size + ":" + mtime_ns + first_256KB_content)
```

不读取完整文件，256KB 足以捕获绝大多数实际变更。对于大型 JSONL（几十 MB）显著提升性能。

### 去抖（Debouncing）

编辑器保存文件时通常会产生多次写入事件（临时文件 → 重命名、多次 flush）。去抖器收集 0.3 秒内的所有事件，合并后只处理一次。

### DELTA 偏移追踪

对于 JSONL 等追加写入的文件：
- 首次：从头读取，记录文件大小作为 offset
- 后续：从 offset 位置开始读取新内容
- 文件缩小（截断）：从头重新读取

---

## 上传策略

| 文件大小 | 上传方式 | 端点 |
|----------|----------|------|
| < 1 MB | JSON 请求体 | `POST /api/ingest/file` |
| 1-2 MB | multipart 表单 | `POST /api/ingest/file/upload` |
| > 2 MB | 2MB 分块上传 | `POST /api/ingest/file/chunk` |

每个上传请求携带以下 Header：
- `X-Collector-Token`：用户的采集器认证 token
- `X-Device-Id`：设备唯一标识（持久化 UUID）
- `X-Device-Name`：设备名称 + 平台（如 "MacBook-Pro (Darwin)"）
- `X-Device-Platform`：操作系统（Darwin / Windows / Linux）
- `X-Collector-Version`：采集器版本号

失败重试：指数退避（1s → 30s），最多 10 次后标记为 dead。

---

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMENTO_SERVER_URL` | `http://localhost:8001` | 服务器地址 |
| `MEMENTO_SERVER_TOKEN` | `""` | 采集器认证 token |
| `MEMENTO_OBSIDIAN_VAULT_PATH` | 自动发现 | Obsidian vault 路径 |
| `MEMENTO_NONINTERACTIVE` | `""` | 设为 `1` 跳过 setup 所有 prompt(配合上面的 URL/TOKEN 做脚本化安装) |

### 持久化配置

`~/.memento/config.json`：
```json
{
  "server_url": "https://mem.ihasy.com",
  "server_token": "your-collector-token"
}
```

### 数据目录

- `~/.memento/device_id`：设备唯一标识（首次启动生成）
- `~/.memento/sync_queue.db`：同步队列数据库
- `~/.memento/config.json`：保存的服务器配置

---

## 安装与使用

```bash
# 安装
pip install memento-brain-collector

# 首次设置（交互式配置服务器地址和 token）
memento-collector setup

# 非交互模式（脚本化部署用）
MEMENTO_SERVER_URL=https://mem.ihasy.com \
MEMENTO_SERVER_TOKEN=your-token \
MEMENTO_NONINTERACTIVE=1 \
memento-collector setup

# 前台运行
memento-collector

# 或设置为系统服务后台运行
```

Windows 用户：安装后可通过 `pythonw` 后台运行，避免显示命令行窗口。
