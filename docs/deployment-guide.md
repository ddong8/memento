# Memento 完整自托管与生产部署指南

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

### 系统架构拓扑

```mermaid
graph TB
    subgraph Client["📱 终端设备 (Mac / Linux / Windows)"]
        direction LR
        IDE["AI 编程工具<br/>Claude Code / Codex / Antigravity / Cursor / WorkBuddy"]
        Desktop["Memento 桌面客户端<br/>内置 DaemonHost 守护进程<br/>本地监听 · 上传前脱敏"]
        IDE <--> Desktop
    end

    subgraph Stack["☁️ Memento 服务端 (自托管)"]
        direction TB
        Nginx["反向代理 / Ingress (HTTPS)"]
        Web["Memento Web UI (Next.js 16) :3001"]
        API["FastAPI 核心服务 :8001"]
        Worker["Celery Worker (异步任务 / AI 总结)"]
        Beat["Celery Beat (定时任务 / 每日简报)"]
        PG[("PostgreSQL 16 + pgvector")]
        Redis[("Redis 7 (Broker & 缓存)")]
        MinIO[("MinIO (S3 兼容存储)")]
        Emb["BGE-M3 嵌入模型服务 :8002"]

        Nginx --> Web
        Nginx --> API
        API <--> PG
        API <--> Redis
        API <--> MinIO
        API <--> Emb
        Worker <--> Redis
        Worker <--> PG
        Worker <--> MinIO
        Beat --> Redis
    end

    Desktop -->|"脱敏同步 (HTTP / WebSocket)"| API
```

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
  - Node.js 22.18+（运行初始化向导与服务自检；macOS / Windows 装了 Memento 桌面端时可直接用它自带的运行时）
  - 机器内存建议 ≥ 4GB（启用本地 BGE-M3 向量模型建议 ≥ 8GB）

### 2. 获取代码与一键安装向导

```bash
# 1. 克隆代码仓库
git clone https://github.com/ddong8/memento.git
cd memento

# 2. 运行一键安装向导 (macOS / Linux)
chmod +x install.sh
./install.sh
```
> **Windows 用户**：在 PowerShell 中运行 `.\install.ps1`（等同于 `node scripts/install.mts`）。

安装向导将全自动完成：
1. **配置文件生成**：自动生成包含强随机密钥的 `.env`；
2. **环境预检**：检查 Docker、端口占用与系统环境；
3. **编排启动**：自动拉起 Postgres、Redis、MinIO、API、Worker、Beat 与 Web 容器；
4. **健康探测**：等待核心接口 `/health` 准备就绪；
5. **初始化管理员**：引导设置首个管理员账号与凭据 Token。

---

### 3. 环境变量关键配置 (`.env`)

若需进一步定制，可参考以下配置说明：

```bash
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
```

---

### 4. 语义向量服务（BGE-M3 Embedding）

语义检索支持两种运行模式：

#### 模式 1：Docker 容器运行（CPU 模式，通用便携）
```bash
./install.sh embedding
# 或通过 Docker Profile 启动：
docker compose --profile embedding up -d --build embedding
```

#### 模式 2：宿主机原生运行（GPU / Apple Silicon MPS 加速）
若宿主机搭载 NVIDIA 显卡或 Apple M 系列芯片，原生运行可提供数倍的吞吐效率：
```bash
./install.sh embedding --native
```
原生服务监听宿主机 `8002` 端口，容器内部会自动映射访问。

---

### 5. 状态检查与服务自检

执行内置健康探测工具：
```bash
./install.sh doctor
```

各项组件正常运行时，即可打开浏览器访问：
- 🌐 **Web 控制台**：`http://localhost:3001`
- 🔌 **API 文档 (Swagger)**：`http://localhost:8001/docs`
- 🗄️ **MinIO 管理后台**：`http://localhost:9001`

---

## 四、方案 B：Kubernetes (k3s) GitOps 持续部署

适用于长期运行在家用 NAS（如 TrueNAS、群晖）或私有云服务器的高可用场景。Memento 官方采用了完全闭环的 **GitOps 交付流**：

```mermaid
sequenceDiagram
    autonumber
    actor Dev as 开发者
    participant GH as GitHub 仓库 (main)
    participant GHA as GitHub Actions
    participant GHCR as GHCR 容器仓库
    participant Fleet as k3s Rancher Fleet
    participant Pods as Kubernetes Pods (memento)

    Dev->>GH: git push origin main
    GH->>GHA: 触发 deploy.yml
    GHA->>GHCR: 构建 server / web 镜像并推送到 GHCR
    GHA->>GH: 自动回写 deploy/k8s/kustomization.yaml 镜像 Tag
    Fleet->>GH: 监听 GitOps 目录变更 (Pull 模式)
    Fleet->>Pods: 应用新清单并拉取镜像滚动发布
```

### 1. 核心架构亮点
- **Pull 式单向同步**：Fleet 运行在内网集群内部主动拉取，不需要公网暴露集群 API 端口，穿透 NAT 极其稳定；
- **配置与凭据严格隔离**：公开 Git 仓库只存放 Kustomize 声明清单，所有敏感密钥统一保留在集群命名空间的 `memento-secret` 中。

---

### 2. 集群初始化与密钥配置

```bash
# 1. 创建命名空间
kubectl create namespace memento

# 2. 注入核心凭据 Secret (一次性操作)
kubectl -n memento create secret generic memento-secret \
  --from-literal=MEMENTO_SECRET_KEY="your_production_secret" \
  --from-literal=MEMENTO_COLLECTOR_TOKEN="your_collector_token" \
  --from-literal=POSTGRES_PASSWORD="your_db_password" \
  --from-literal=MINIO_ROOT_USER="minioadmin" \
  --from-literal=MINIO_ROOT_PASSWORD="your_minio_password" \
  --from-literal=MEMENTO_AI_API_KEY="sk-xxxxxx" \
  --from-literal=MEMENTO_DATABASE_URL="postgresql+asyncpg://postgres:your_db_password@memento-postgres:5432/memento" \
  --from-literal=MEMENTO_REDIS_URL="redis://memento-redis:6379/0"

# 3. (可选) 配置 GitHub OAuth 登录支持
kubectl -n memento patch secret memento-secret --type merge -p \
  '{"stringData":{"MEMENTO_GITHUB_CLIENT_ID":"your_id","MEMENTO_GITHUB_CLIENT_SECRET":"your_secret"}}'
```

---

### 3. 配置 Fleet 纳管 GitOps 仓库

在 Fleet 控制命名空间（通常为 `fleet-local`）中应用如下配置：

```yaml
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
```
```bash
kubectl apply -f fleet-repo.yaml
```

集群内的 Fleet 会自动部署并管理 `deploy/k8s/` 目录下的所有资源（API、Celery、Web、Ingress）。

---

## 五、连接终端：客户端与 MCP 记忆无缝接入

服务端部署完毕后，终端设备的接入流程极为轻量便捷：

### 1. 方式一：安装桌面客户端（最推荐，全自动静默托管）

Memento 桌面客户端已将采集守护进程（`DaemonHost`）原生打包集成。

1. **安装客户端**：
   - **macOS**：下载并安装 `Memento-macos-arm64.zip` 或 `.dmg`；
   - **Windows**：下载并运行 `Memento-windows-x64.zip`。
2. **连接服务端**：
   - 首次启动桌面端，在设置中填入你的自建服务端地址（如 `https://mem.yourdomain.com` 或内网 IP）；
   - 使用已创建的管理员账号登录。
3. **开箱即用，静默采集**：
   - 登录成功的瞬间，客户端**会自动为当前设备生成凭据、自动配置监听目录、自动拉起常驻采集子进程**；
   - 系统托盘实时显示：`● 采集运行中`；
   - 本地使用 Claude Code、Codex、Antigravity、Cursor、WorkBuddy 编写代码和对话时，所有上下文均自动脱敏并增量同步。

---

### 2. 方式二：纯终端 / 无图形界面服务器接入（Headless 独立模式）

官方参考：[Claude Code 认证](https://code.claude.com/docs/en/authentication)、[Codex 认证](https://developers.openai.com/codex/auth)、[Antigravity CLI 安装](https://antigravity.google/docs/getting-started?tab=cli) / [无界面模式](https://antigravity.google/docs/cli/headless) / [排障](https://antigravity.google/docs/cli/troubleshooting/)。

在没有桌面的 Linux 主机（云服务器、NAS、开发容器）上，守护进程用 Node.js 从仓库源码运行，不需要桌面端。它负责采集这台机器上的 AI 会话，并执行从网页或手机派到这台机器的任务：智能体在这台机器的项目目录里读写代码。

```bash
# 0. 需要 Node.js 22.18+ 和 git
git clone https://github.com/ddong8/memento.git ~/memento && cd ~/memento

# 1. 只构建守护进程（不装服务端）
npm ci -w @memento/daemon -w @memento/core --include-workspace-root
npm run build -w @memento/daemon

# 2. 绑定服务端：collector token 在网页「个人设置」或「本机采集」页复制
node packages/daemon/dist/cli.js login <collector_token> https://mem.yourdomain.com

# 3. 注册为 systemd 用户服务并立即启动；会顺带打开 linger，退出 ssh 后也不停、开机自启
node packages/daemon/dist/cli.js install-service
#    若提示没打开 linger，执行：sudo loginctl enable-linger $USER

# 4. 查看状态 / 日志
node packages/daemon/dist/cli.js status
journalctl --user -u memento-daemon -f
```

升级：`git pull` 后重跑第 1 步和 `install-service`。取消自启：`node packages/daemon/dist/cli.js uninstall-service`；彻底清理（服务、`~/.memento`、日志、写进各 AI 工具的配置）：`node scripts/install.mts uninstall-collector`。

`install-service` 要在这个用户自己的登录会话里运行（直接 ssh 登录），`su` / `sudo -u` 切过来的会话没有用户级 systemd，会报错提示。

智能体要先在这台机器上装好并登录一次，守护进程才能调用：

| 智能体 | 安装 | 无界面登录 |
|---|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash`（官方推荐，装到 `~/.local/bin/claude`；也可 `npm install -g @anthropic-ai/claude-code`，不要加 sudo） | 运行 `claude` 后 `/login`，按 `c` 复制登录链接到本地浏览器打开，把页面给的验证码贴回终端；或在有浏览器的机器上 `claude setup-token`，把令牌设为 `CLAUDE_CODE_OAUTH_TOKEN`；或设置 `ANTHROPIC_API_KEY`（按 API 计费，优先级最高） |
| Codex | `npm install -g @openai/codex`（或官方脚本 `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`） | 先在 ChatGPT 安全设置里打开设备码登录，再 `codex login --device-auth`；或 `printenv OPENAI_API_KEY \| codex login --with-api-key` |
| Antigravity | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`（装到 `~/.local/bin/agy`） | 在终端运行一次 `agy`，按提示在本地浏览器打开链接、把验证码贴回；或在 `~/.gemini/antigravity-cli/settings.json` 写 `{"modelProvider": "gemini"}` 并设置 `GEMINI_API_KEY` |

Antigravity 说明：有桌面的机器上，守护进程驱动 Antigravity 应用本身（会话在应用里能看到）；这台机器上没有运行中的 Antigravity 应用时，自动改用 Google 官方 `agy` 命令行的打印模式（`agy -p … --output-format stream-json`），工具步骤、回复和会话续接照常回传。账号登录方式下 agy 把令牌存在系统密钥环里，无界面机器要有 D-Bus 会话和密钥环服务，报 `secret keyring is locked` 时见官方排障文档；用 `GEMINI_API_KEY` 方式不涉及密钥环。`ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN`、`GEMINI_API_KEY` 这类变量写在 `~/.bashrc` / `~/.zshrc` 的 `export` 里即可，守护进程会读给智能体。

派任务：在网页或手机上选这台设备，工作目录填这台机器上的项目路径（如 `~/dev/myapp`），选 Claude Code / Codex / Antigravity 发送。智能体在这台机器上、在这个目录里执行，过程和结果实时回传，可随时停止。代码不在这台机器上（比如代码在 Mac、想让服务器跑智能体）时，见下面的「代码在另一台电脑」。

#### 一键把 Linux 服务器设为执行机

上面的步骤可以用一条命令做完：网页「设备」页底部的「把 Linux 服务器加为执行机」卡片里能复制带好 token 的整条命令，在服务器上用普通用户 ssh 登录后运行：

```bash
curl -fsSL https://mem.yourdomain.com/install/executor.sh | bash -s -- --token <collector_token> --agents claude,codex,agy
```

脚本做的事（重跑即升级，不重复安装）：

1) 检查 Linux、systemd、git、curl、tar；系统没有 Node.js 22.18+ 时下载官方 Node 22 到 `~/.memento/runtime/node`（`NODE_MIRROR` 可换下载源，失败自动改用 npmmirror），不动系统环境。
2) 把守护进程源码浅克隆到 `~/.memento/src/memento`（`MEMENTO_REF` 可指定版本），只构建守护进程。
3) 绑定服务端（默认就是下载脚本的这个服务端，`--server` 可改），注册为 systemd 用户服务并打开 linger。
4) `--agents` 里列的智能体没装就按官方方式装到 `~/.local/bin`，并把它和 Node 加进 `~/.bashrc` 的 PATH。
5) 默认以低优先级运行（`Nice=10`、`CPUWeight=50`、IO 空闲优先级），服务器上的其它服务不被抢资源；不想要就加 `--no-low-priority`。

跑完按提示把智能体各登录一次即可（上表的无界面登录方式）。

#### 代码在另一台电脑（跨设备工作区）

代码留在 Mac / Windows 上，智能体在服务器上跑：提问时设备选服务器，旁边的「代码在」选你的电脑（只有选了具体设备、有多台设备时出现）。

1) 发送时，服务器上的守护进程经 memento 向你的电脑要一份 git bundle：包含当前分支和所有未提交、未跟踪的改动（`.gitignore` 忽略的文件不带），用临时索引打快照，不碰你的暂存区。第二次起只传增量，代码没变就不传。
2) 服务器上的副本在 `~/.memento/workspaces/<编号>/<仓库名>`，`node_modules` 这类被忽略的文件保留，下次不用重装；同一项目同时跑多个任务各用一份副本。
3) 智能体跑完，把它的改动（包括它自己做的提交）打成补丁带回你的电脑：你的电脑上的代码在运行期间没变就直接写回工作区；变了就不覆盖，改动放到 `memento/<任务号>` 分支上，自己合并。任务失败或被停止时补丁只保存到 `.git/memento/patches/`，不写回。
4) 带回时你的电脑不在线，补丁先存在服务器上，你的电脑上线后自动补交（7 天内）。
5) 两边的守护进程都要是支持这个功能的版本（v1.0.105+）；代码所在目录必须是 git 仓库且至少有一个提交。任务详情里能看到同步、写回、冲突分支和改动的文件。

---

### 3. 为各大 AI 工具接入 MCP 记忆大脑

MCP 服务随桌面端分发：用桌面端自己的可执行文件以 Node 模式启动 `mcp.mjs`，登录信息读 `~/.memento/collector.json`。桌面端「本机采集」页会按当前系统生成各工具的完整配置，一键复制即可。下面以 macOS 为例。

#### 接入 Claude Code
```bash
claude mcp add memento-memory -s user -e ELECTRON_RUN_AS_NODE=1 -- \
  "/Applications/Memento.app/Contents/MacOS/Memento" \
  "/Applications/Memento.app/Contents/Resources/app.asar.unpacked/dist/mcp.mjs"
```

#### 接入 Cursor / Windsurf / Antigravity
在对应的 MCP 配置文件里加：
```json
{
  "mcpServers": {
    "memento-memory": {
      "command": "/Applications/Memento.app/Contents/MacOS/Memento",
      "args": ["/Applications/Memento.app/Contents/Resources/app.asar.unpacked/dist/mcp.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

没装桌面端的机器：在仓库里 `npm ci && npm run build -w @memento/mcp`，然后把 command 换成 `node`、args 换成 `["<仓库>/packages/mcp/dist/cli.js", "--server", "https://mem.yourdomain.com", "--token", "your_collector_token"]`。

接入后，AI 即可在对话中主动调用：
- `memory_search`：语义搜索过往记忆、架构决策与踩坑记录；
- `memory_recall`：分类快速召回规矩和偏好；
- `todo_list` / `todo_add`：沉淀当前会话的后续待办。

---

## 六、生产运维与调优最佳实践

### 1. 数据库防挂死调优（PostgreSQL 16）
长期运行大量异步总结与嵌入更新时，容易出现未释放的事务持有行级锁。必须显式设置：
```sql
-c max_connections=200
-c idle_in_transaction_session_timeout=60000   -- 超过 60 秒空闲未提交的事务强制释放
-c statement_timeout=120000                   -- 慢查询 120 秒超时拦截
-c log_lock_waits=on                          -- 打印排队死锁日志
```

### 2. 容器异常自动拉起
为关键容器（`api`、`celery-worker`、`web`）显式添加 `restart: unless-stopped`，防止大批量日志解析发生 OOM（Exit 137）时服务意外停机。

### 3. 自动化冷备归档
- **PostgreSQL 数据库**：通过 `docker exec memento_postgres pg_dump` 导出冷备；
- **MinIO 对象存储**：每日通过 Celery 计划任务将全量快照自动加密归档至外部 S3 存储桶。

---

## 七、总结

通过自部署 Memento，你彻底掌控了个人与团队的代码上下文资产。无论是单机 Docker 轻量运行，还是 Kubernetes GitOps 生产集群，Memento 都能为你的智能体编程工作流提供稳定可靠的记忆基石。
