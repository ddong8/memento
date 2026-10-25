<div align="center">

# Memento

**A shared brain and multimodal workbench for your AI coding tools**

Auto-collect AI coding conversations and memory across devices and tools, aggregate on your own backend, and view / search / recall through a unified Web UI + MCP — featuring built-in universal doc & media inspector (Office/PPT 16:9 presentation, high-perf CSV slicing, and GPU accelerated playback).

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Python ≥3.12](https://img.shields.io/badge/python-≥3.12-blue.svg)](#-tech-stack)
[![Next.js 16](https://img.shields.io/badge/next.js-16-black.svg)](#-tech-stack)

[Quick Start](#-quick-start) · [Architecture](#️-architecture) · [Supported Tools](#-supported-ai-tools) · [Self-host](#-quick-start) · [MCP](#-mcp-memory-service)

🌐 **Languages**: [中文](README.md) · [English](README.en.md)

</div>

---

## ✨ What it does

- 🧠 **Cross-device conversation sync** — Incremental sync across Mac / Linux / Windows with 10+ AI coding tools including Claude Code, Codex, Cursor, Antigravity, WorkBuddy, and Windsurf
- 🖥️ **Multimodal doc & media workbench** — In-app immersive viewing for Office (PPT / Word / Excel), PDF, code artifacts, and media; mobile 100vw × 100dvh fullscreen & 90° landscape presentation for 16:9 slides; windowed slicing pagination for large CSV / TSV datasets with instant millisecond response; one-click publishing to WeChat Official Account drafts with automatic 2.35:1 hero illustration sync; GPU 3D composite acceleration and explicit decoder context unbinding
- 🤖 **All-day AI Butler & interactive assistant** — Fullscreen responsive conversation flow, full-screen thinking mode with lightning indicator, multi-agent collaboration; flexible model switching supporting latest Claude Code models, OpenAI, DeepSeek, and intelligent quota/health detection
- 👤 **Persona & 3D digital twin** — Personalized persona onboarding with gender, cartoon avatar, and responsive 3D twin; deep customization for behavioral rules, coding preferences, and long-term memory that evolves across sessions
- ⚡ **Skills evolution & proactive pitfall prevention** — Nightly reviews turn multi-step procedures into reusable skills shipped to `~/.claude/skills` and `~/.agents/skills`; failures are recorded into pitfalls, and `memory_check_rule` intercepts potential issues before execution
- 📋 **Inbox & task lifecycle closure** — Unfinished work and action items mentioned in conversations automatically flow into `/inbox` with due alerts and task closure
- 🌅 **Circadian rhythm & two-stage AI digest** — Circadian cognitive cycle with a nightly 23:30 two-stage summary: per-document summaries first, then aggregated cross-tool daily digest
- 🔍 **Hybrid retrieval** — BGE-M3 vectors + jieba-tokenized full-text index; high-precision retrieval across both English and Chinese
- 🕸️ **Knowledge graph** — LLM extracts entities (projects / tools / technologies / people / concepts), relations and observations from conversations; observations older than 7 days are auto-compacted into summaries
- 🔗 **Native MCP service** — Find, drill, write, and overview tools, plus pre-flight rule check (`memory_check_rule`), skills (`memory_skill`), pitfalls (`memory_pitfall`), and todos (`todo_list` / `todo_add` / `todo_update`); any AI IDE can inspect and update your memory directly
- ♻️ **Memory metabolism** — Tracks usage frequency for each memory; outdated memories are marked superseded, and unused memories enter dormancy after 60 days without deletion
- 📏 **Retrieval evaluation** — A versioned question set generated from your own documents is scored weekly through the same retrieval Ask uses; drops in hit@5 / MRR raise an alert
- 🔒 **Sanitize-before-enqueue security** — The local daemon strips 14 classes of secrets locally (OpenAI / Anthropic / GitHub / Slack / Telegram / AWS / Bearer tokens / private keys / URL-embedded credentials …) so even the on-disk SQLite queue is safe
- 🌐 **Public sharing** — One-click share links for project timelines / daily digests, with GeoIP visitor stats, expiry, and instant revocation
- 🛡️ **100% self-hosted** — One-shot Docker Compose; Postgres + Redis + MinIO all on your own machine — your data never leaves
- 🔐 **Multi-tenant isolation** — Per-user namespaces with owner / admin / viewer roles + fine-grained per-resource grants + audit log
- ⚡ **Modern desktop app & daemon** — Native Electron app, no Python required, lives in system tray, supports minimize to tray on macOS, permanent login memory, zero-latency menu navigation, offline queue, and self-healing auto-retry

## 🏗️ Architecture

```mermaid
graph TB
    subgraph DEV["📱 User devices Mac/Linux/Windows"]
        direction LR
        CC["Claude Code<br/>~/.claude"]
        CDX["Codex<br/>~/.codex"]
        CUR["Cursor<br/>~/.cursor"]
        AG["Antigravity<br/>~/.gemini/antigravity"]
        WB["WorkBuddy<br/>~/.workbuddy"]
        WS["Windsurf<br/>~/.codeium/windsurf"]
        CL["Cline<br/>VS Code globalStorage"]
        OC["OpenClaw<br/>~/.openclaw"]
        HM["Hermes<br/>~/.hermes"]
        OBS["Obsidian Vault"]
        COL["Memento daemon<br/>in the desktop app / memento-daemon<br/>file watching · incremental upload<br/>sanitized before upload"]
        CC --- COL
        CDX --- COL
        CUR --- COL
        AG --- COL
        WB --- COL
        WS --- COL
        CL --- COL
        OC --- COL
        HM --- COL
        OBS --- COL
    end

    subgraph SRV["☁️ Self-hosted Memento server"]
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
            S3[("MinIO<br/>S3 compatible")]
        end

        EMB["BGE-M3 Embedding<br/>:8002 host process"]

        NGX --> API
        NGX --> WEB
        API <--> PG
        API <--> RD
        API <--> S3
        API -.calls.-> EMB
        CW <--> PG
        CW <--> RD
        CB --> CW
    end

    subgraph CLT["🤖 AI tools MCP clients"]
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
    MCP ==>|"HTTPS + JWT"| NGX

    subgraph PUB["🌍 Public access"]
        SHARE["Share link /s/&lt;token&gt;"]
        GEO["GeoIP DB<br/>visitor stats"]
    end
    NGX --> SHARE
    SHARE --> GEO

    classDef device fill:#fef3c7,stroke:#d97706,color:#92400e
    classDef server fill:#dbeafe,stroke:#2563eb,color:#1e40af
    classDef client fill:#fce7f3,stroke:#db2777,color:#831843
    classDef public fill:#dcfce7,stroke:#16a34a,color:#14532d
    class CC,CDX,CUR,AG,OC,HM,OBS,COL device
    class API,WEB,CW,CB,PG,RD,S3,EMB,NGX server
    class MCC,MCDX,MCUR,MAG,MCP client
    class SHARE,GEO public
```

### Data flow (a single conversation, from creation to searchable)

```mermaid
sequenceDiagram
    participant T as AI tool
    participant W as Local file
    participant C as Collector
    participant Q as SQLite queue
    participant A as API
    participant P as Postgres
    participant E as Embedding
    participant M as MCP

    T->>W: write .jsonl conversation
    W->>C: watchdog file event
    C->>C: parse + sanitize
    C->>Q: enqueue (offline-safe)
    Q->>A: HTTPS POST (retry on failure)
    A->>P: write documents / conversation_messages / content_tsv
    A-->>E: async embedding
    E->>P: write document_embeddings (pgvector)
    A-->>P: LLM extracts entities / relations
    Note over M: User calls memory_search inside Claude Code
    M->>A: GET /api/memory/semantic
    A->>E: embed query
    E->>P: cosine_distance ranking
    P-->>M: return relevant chunks
```

> When embedding fails, `embedding_status` is set to `failed`; Celery beat scans `pending/failed` rows **every 15 minutes** and retries — no vectors are lost to transient hiccups.

## 🧰 Supported AI tools

| Tool | What's collected | Format |
|------|------------------|--------|
| **Claude Code** | conversations, memory, plans, history | JSONL / Markdown |
| **OpenClaw** | conversation sessions, identity, memory, learnings, skills | JSONL / Markdown |
| **Codex** | conversations, history, skills, state | JSONL / TOML / SQLite |
| **Antigravity** | full conversations (built-in `.pb` decryption), plans, code snapshots | Protobuf / Markdown |
| **WorkBuddy** | agent tasks, multi-modal artifacts, doc & media workbench | Markdown / Office / Media |
| **Obsidian** | all notes | Markdown |
| **Cursor** | conversations, skills, MCP config | JSONL / Markdown |
| **Hermes** | full conversations (incl. tool calls), persona, skills, CLI history | JSON / Markdown / SQLite |
| **Windsurf** | conversations, rules | JSONL / Markdown |
| **VS Code** | settings, extensions, workspace rules | JSON / Markdown |

## 🚀 Quick start

### One-shot install (recommended)

```bash
# macOS / Linux
curl -fsSL https://mem.ihasy.com/install.sh | sh

# Windows (PowerShell)
iwr https://mem.ihasy.com/install.ps1 -useb | iex
```

Or open <https://mem.ihasy.com/install> in a browser to copy a ready-made command. The script clones the repo into `~/memento/` (override with `MEMENTO_INSTALL_DIR`) and runs the bundled `./install.sh`.

### From a cloned repo

```bash
git clone https://github.com/ddong8/memento.git && cd memento
./install.sh            # macOS / Linux
.\install.ps1           # Windows
```

`install.sh` does it all:

1. Generate `.env` with random secrets (JWT / collector token / MinIO / Postgres passwords)
2. `docker compose up -d --build` — boots 7 containers
3. Liveness probe on API `/health`
4. Interactive prompt to create the first user (auto-promoted to owner with a `collector_token`)
5. Point this machine at the server; with Node.js 20+ it builds the collector daemon from the checkout and registers it as a login service (without Node, install the desktop app — it reads the same config)

Optional commands:

| Command | Description |
|---|---|
| `./install.sh embedding` | Install BGE-M3 embedding server (Docker mode, ~1.3 GB; required for semantic search / MCP recall) |
| `./install.sh embedding --native` | Switch to host-venv install (use this if you have NVIDIA CUDA or Apple MPS GPU) |
| `./install.sh doctor` | Check status of all services |
| `./install.sh update` | git pull + rebuild + upgrade |
| `./install.sh uninstall` | Stop services; keep data and config |
| `./install.sh uninstall --purge` | Above + drop Docker volumes + `.env` |
| `./install.sh uninstall --all` | Nuclear: collector service + old pip packages / `~/.memento` / model cache / Docker images / MCP entries — wiped |

### Service ports

| Port | Service |
|---|---|
| **8001** | API (Swagger: `/docs`) |
| **3001** | Web UI |
| 8002 | Embedding (host port only in `--native` mode; Docker mode keeps it on the docker network at `embedding:8002` without host publish) |
| 5433 | PostgreSQL |
| 6380 | Redis |
| 9000 / 9001 | MinIO / console |

> Ports are deliberately offset from common defaults to avoid conflicts.

## 💻 Adding more devices

Connect every Mac / Windows / Linux box where you use AI tools. Two ways:

### Option 1: Desktop app (recommended)

For a seamless, GUI-first experience without environment setup: **built on Electron, bundling the background daemon and MCP sidecar** (no Python or Node.js required). Lives in the system tray, auto-collects upon login, and auto-updates.

**[⬇️ Download the latest release from GitHub](https://github.com/ddong8/memento/releases/latest)**

| Platform | Installer | Notes |
|---|---|---|
| **macOS** (Apple Silicon) | `.dmg` | Drag into Applications; supports minimize to system tray |
| **Windows** | `.exe` | Modern NSIS installer with system tray & auto-start |
| **Linux** | `.AppImage` / `.deb` | Executable AppImage or native `.deb` package |
| **Android** | `.apk` | Native mobile app for immersive conversation, document inspection, and daily digest on the go |

**Out-of-the-box Experience**:
1. Native application window directly loads the Memento workbench. Login state is **permanently remembered** across restarts.
2. Sign in or register directly within the app (or via GitHub OAuth). The app **silently manages credentials, the daemon, and local MCP servers** — users never need to see, copy, or manage tokens.
3. Remembers open tabs and menu states with zero-latency switching; includes the full multi-modal document & media workbench.
4. Auto-checks for new releases with minisign verification.

> If macOS says it "can't verify the developer", right-click the icon → Open, or run `xattr -dr com.apple.quarantine /Applications/Memento.app`.

### Option 2: Command line (Node.js daemon)

For servers, headless setups, or CLI enthusiasts; requires Node.js ≥ 20. Uses the same core daemon engine (`packages/daemon`):

```bash
git clone https://github.com/ddong8/memento.git && cd memento
npm ci --workspace @memento/daemon --workspace @memento/core --include-workspace-root
npm run build -w @memento/daemon

# Log in and install as a background system service (starts automatically at boot)
node packages/daemon/dist/cli.js login <collector token> https://mem.ihasy.com
node packages/daemon/dist/cli.js install-service
```

Common management commands:
```bash
node packages/daemon/dist/cli.js status              # show status
node packages/daemon/dist/cli.js run                 # run in foreground (debug)
node packages/daemon/dist/cli.js install-service     # install system service
node packages/daemon/dist/cli.js uninstall-service   # uninstall system service
```

Auto-detects platform: **macOS** launchd / **Linux** systemd user / **Windows** Run key. Mutual exclusion guarantees a single instance runs at a time (sharing `~/.memento`).

## 🕸️ Knowledge graph

The system extracts the following from every synced conversation / document via LLM:

- **Entities** (`knowledge_entities`) — projects / tools / technologies / people / concepts; deduplicated across conversations
- **Relations** (`knowledge_relations`) — `uses` / `creates` / `depends_on` / `discussed` between entities
- **Observations** (`observations`) — concrete factual statements about an entity, with timestamp and source document

**Auto-compaction**: observations on the same entity older than 7 days get merged by an LLM into a shorter summary — preserves semantics, saves space. The window is tunable via `MEMENTO_COMPACTION_AGE_DAYS`.

Read / write through MCP tools: write with `memory_store`; read with `memory_graph(entity_name)` for an entity's neighbors and observations, `memory_context(project)` for project-level context, or `memory_recall(category, days)` for a time-series view. Visualize at the Web `/memory` page.

## 🧠 MCP memory service

The desktop app ships the MCP server (`@memento/mcp`); its "This computer" page has ready-to-copy setup for Claude Code, Codex and other tools. On a machine without the desktop app, run `npm ci && npm run build -w @memento/mcp` in a checkout, then `node packages/mcp/dist/cli.js` (it reads the sign-in from `~/.memento/collector.json`, or pass `--server URL --token TOKEN`). Where each tool keeps its MCP config:

| AI tool | MCP config file | How it's written |
|---|---|---|
| Claude Code | `~/.claude.json` | `claude mcp add` CLI |
| Cursor | `~/.cursor/mcp.json` | JSON `mcpServers.memento-memory` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | same |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | same |
| **Codex** | `~/.codex/config.toml` | TOML `[mcp_servers.memento-memory]` |
| OpenClaw | `~/.openclaw/openclaw.json` | `openclaw mcp set` CLI |

After installation, AI IDEs can call:

| Tool | Purpose |
|---|---|
| **Find** | |
| `memory_search(q, limit, tool_filter, days)` | Hybrid BGE-M3 semantic + jieba full-text search; `days` bounds the time window, `tool_filter` restricts to one tool |
| `memory_recall(category, days, project, date)` | List recent files of a category (optionally for a specific date or project) |
| `memory_context(project_name)` | Pull project context (document list + project metadata) when switching projects |
| **Drill in** | |
| `memory_open(doc_id)` | Fetch the full content of a document (use after `memory_search` returns a snippet) |
| `memory_conversation(doc_id, limit, offset)` | Unfold a conversation document into role/content/timestamp messages, with pagination |
| `memory_graph(entity_name)` | Knowledge-graph drill-in: entity summary + incoming/outgoing relations + recent observations |
| **Write** | |
| `memory_store(content, entity_name, entity_type)` | Save an observation into the knowledge graph |
| **Overview** | |
| `daily_summary(date)` | Cross-tool activity digest + AI summary for a given day |
| **Before acting / learned** | |
| `memory_check_rule(action_type, project_name, details)` | Call before deploying, releasing, migrating or changing data: relevant rules, past pitfalls, skills to follow |
| `memory_skill(query)` | Full steps of a published skill (no argument lists them all) |
| `memory_pitfall(title, symptom, fix, cause, project)` | Record a failure whose cause you found and fixed, to be warned next time |
| `todo_list(project)` / `todo_add(title, detail, due, project)` / `todo_update(todo_id, status, title, due)` | Todos: list, record "do this later", close or drop |

On a machine running the collector the MCP server needs no `--token`: it reads the server URL and device token from `~/.memento/collector.json`, and picks up a rotated token by itself.

Plus 4 MCP **resources** exposed as URIs (subscribable from any IDE):

| URI | Content |
|---|---|
| `memory://projects` | list of all projects |
| `memory://projects/{name}` | single project detail (conversations / entities / observations) |
| `memory://identity/{tool}` | "identity card" for a tool (user preferences / long-term memory) |
| `memory://daily/{date}` | activity digest for a given day |

## 👥 Users and permissions

| Role | Description |
|---|---|
| `owner` | First registered user. Can change any user's role/status; sees all data |
| `admin` | Manages devices, reads audit log; approves pending users in `invite_only` mode |
| `viewer` | Read-only (default). Sees only projects/tools granted to them |
| `pending` | Edge case — only appears in `invite_only` mode for users who self-register without a valid code |

**Registration mode** (`MEMENTO_REGISTRATION_MODE`, defaults to `open`):

| Mode | Behavior |
|---|---|
| `open` | Anyone can self-register and is activated immediately with a collector token — no admin in the loop |
| `invite_only` | Must present an `invite_code` to register; otherwise rejected. Codes are created by owner/admin at `/admin/invites` |
| `closed` | The register endpoint refuses everyone (deployments meant for the owner alone) |

Key flows:

- **Register** — `/auth/register`. First user becomes owner + active automatically; later registrations follow `MEMENTO_REGISTRATION_MODE`.
- **Desktop client** — Opens the Memento workbench in a native window; signing in automatically links the daemon and local MCP servers. **Users never need to manage or copy tokens**.
- **Fine-grained grants** — `/admin/permissions` issues per-project / per-tool read/write grants to viewers.
- **Audit log** — Every sensitive action is recorded in `access_logs` (user_id / action / IP / metadata) for compliance and auditing.
- **Session persistence & silent authorization** — The desktop app maintains persistent authorization and background collection automatically across reboots.

## 🌐 Public sharing

Project timelines and daily digests can be shared publicly with one click:

- Open `/projects/<id>/timeline` or `/daily/<date>` and click **Share** (top right)
- Pick an expiry (or never), and a `/s/<token>` URL is generated
- Visitors view without logging in
- Backend records visitor IP + country / region / city (local GeoIP DB; no outbound calls)
- Revocable any time

## 🛠️ Tech stack

| Layer | Technology |
|------|------------|
| Collector daemon | Node.js ≥20, TypeScript, ws (ships with the desktop app, can run standalone) |
| MCP memory | TypeScript, @modelcontextprotocol/sdk (stdio, calls the server API) |
| Server | Python ≥3.12, FastAPI ≥0.115, SQLAlchemy 2.0 async, asyncpg, Celery |
| Database | PostgreSQL 16 (+ pgvector + pg_trgm), Redis 7, MinIO (S3-compatible) |
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| AI summary / graph | Anthropic Claude API + OpenAI-compatible endpoints (Kimi / DashScope...) |
| Embedding | BAAI/bge-m3 via an OpenAI-compatible API (e.g. SiliconFlow) or the self-hosted BGE-M3 service (Docker; `--native` runs a host venv, CUDA on Linux) |
| GeoIP | MaxMind GeoLite2 / db-ip city-lite (offline mmdb) |
| Deployment | Docker Compose (7 services) |

## ⚙️ Background tasks

Scheduled by Celery beat:

| Task | Trigger | Purpose |
|---|---|---|
| `daily_digest` | every day at 23:30 | Cross-tool daily activity digest (per-doc summaries → aggregation) |
| `embedding_retry` | every 15 minutes | Scan `embedding_status=pending/failed` and re-embed |
| `tsvector_backfill` | on startup | Backfill jieba-tokenized full-text index for legacy data |
| `memory_compaction` | manual / periodic | Merge accumulated observations older than 7 days into summaries |

## 📁 Directory layout

```
memento/
├── packages/
│   ├── core/                 # @memento/core: API types, ask stream, task events (shared)
│   ├── daemon/               # @memento/daemon: collection, dispatched tasks, profile/skills
│   └── mcp/                  # @memento/mcp: MCP memory server (ships with the desktop app)
├── apps/
│   ├── desktop/              # Electron desktop app (Memento)
│   ├── mobile/               # Expo mobile app (Memento)
│   └── web/                  # Next.js 16 frontend
│       ├── src/app/          # 18+ pages
│       └── src/components/   # Aurora design system
├── server/                   # Backend FastAPI
│   └── server/
│       ├── main.py           # entry + schema migrations + validate_production
│       ├── config.py         # MEMENTO_-prefixed settings + fail-fast
│       ├── middleware/       # JWT + collector token (constant-time)
│       ├── api/              # REST + SSE
│       ├── db/               # 16 tables
│       ├── services/         # ingest / embedding / graph / cache / geoip
│       └── tasks/            # Celery worker + beat
├── embedding/                # BGE-M3 host service
├── scripts/                  # install.py backend + utility scripts
├── deploy/bootstrap/         # curl one-shot installer (install.sh / .ps1 / index.html)
├── docs/                     # project-architecture.md / typescript-migration.md
└── docker-compose.yml
```

## ⚙️ Environment variables

All variables share the `MEMENTO_` prefix.

<details>
<summary><b>Collector</b></summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMENTO_SERVER_URL` | http://localhost:8001 | Server API URL |
| `MEMENTO_SERVER_TOKEN` | — | collector token |
| `MEMENTO_OBSIDIAN_VAULT_PATH` | auto-detected | Obsidian vault path |
| `MEMENTO_NONINTERACTIVE` | — | set `1` to skip prompts during setup |

</details>

<details>
<summary><b>Server (api / celery)</b></summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMENTO_DATABASE_URL` | postgresql+asyncpg://postgres:postgres@localhost:5433/memento | Postgres connection |
| `MEMENTO_REDIS_URL` | redis://localhost:6380/0 | Redis broker + backend |
| `MEMENTO_COLLECTOR_TOKEN` | collector-dev-token | Fallback collector token (dev only) |
| `MEMENTO_SECRET_KEY` | change-me-in-production | JWT signing key (must override in prod) |
| `MEMENTO_S3_ENDPOINT` | http://localhost:9000 | MinIO/S3 endpoint |
| `MEMENTO_S3_ACCESS_KEY` / `MEMENTO_S3_SECRET_KEY` | minioadmin | MinIO credentials |
| `MEMENTO_S3_BUCKET` | memento | bucket for large files |
| `MEMENTO_ANTHROPIC_API_KEY` | — | Claude API (AI summaries) |
| `MEMENTO_AI_API_KEY` / `_BASE_URL` / `_MODEL` | — / dashscope / kimi-k2.5 | Primary OpenAI-compatible endpoint |
| `MEMENTO_AI_FALLBACK_API_KEY` / `_BASE_URL` / `_MODEL` | OneAPI / qwen3.8-27b | Automated failover AI endpoint (Fallback) |
| `MEMENTO_AI_PROVIDERS` | — | JSON list of multiple AI providers for tiered fallback |
| `MEMENTO_EMBEDDING_SERVER_URL` | http://host.docker.internal:8002 | Host BGE-M3 service |
| `MEMENTO_GEOIP_DB` | /data/geoip/GeoLite2-City.mmdb | GeoIP database path |
| `MEMENTO_DEBUG` | `0` | set `1` to allow startup with dev defaults |
| `MEMENTO_PORT` | 8000 | API listen port |

</details>

<details>
<summary><b>Embedding service</b></summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMENTO_EMBEDDING_PORT` | 8002 | HTTP port |
| `MEMENTO_EMBEDDING_MODEL_NAME` | BAAI/bge-m3 | sentence-transformers model |

</details>

## 🌐 Remote access / custom domain

- The frontend's API base URL automatically follows `window.location.hostname` (see `getApiBase()`; never hardcoded)
- Docker port mappings work over both IPv4 and IPv6
- To allow another origin, edit `allow_origin_regex` in [server/server/main.py](server/server/main.py); default:

  ```python
  allow_origin_regex=r"(https?://localhost:\d+|https?://mem\.ihasy\.com)"
  ```

## 🗑️ Uninstall

<details>
<summary><b>Server (installed via install.sh)</b></summary>

```bash
./install.sh uninstall          # stop containers and the collector service; keep data / .env
./install.sh uninstall --purge  # above + drop Docker volumes + .env
./install.sh uninstall --all    # nuclear (add -y to skip confirmation)
```

`--all` removes:
- the collector daemon service, plus pip packages old installs left (memento-brain-* + legacy daily-report-*)
- `~/.memento` + `~/.daily-report` (legacy path)
- Collector logs (macOS / Linux / Windows paths)
- Embedding venv + HuggingFace model cache (~1.3 GB)
- Docker images + volumes
- `.env` / `.env.local`
- The `memento-memory` MCP entry from every AI tool

</details>

<details>
<summary><b>Daemon-only device</b></summary>

```bash
node packages/daemon/dist/cli.js uninstall-service           # uninstall background service
rm -rf ~/.memento                                             # remove local config and offline queue

# Logs (pick one):
rm -rf ~/Library/Logs/memento                                # macOS
rm -rf ~/.local/share/memento/logs                           # Linux
# Windows: Remove-Item -Recurse $env:LOCALAPPDATA\memento

# Manually remove the memento-memory block from each AI tool's MCP config
```

</details>

## 📄 License

This project is licensed under [AGPL-3.0](LICENSE).

In short: personal use, self-hosting, internal corporate use, and research are all free. But if you take this code (or any modifications) and offer it as a network service (SaaS / public hosting), AGPL §13 requires you to release your full modified source code under AGPL as well.

For commercial licensing (waiver of AGPL terms, closed-source use, SaaS deployment, etc.), please contact the author.
