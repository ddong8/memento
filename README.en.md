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

- 🧠 **Cross-device conversation sync** — Conversations from Claude Code / Codex / Cursor / Antigravity / WorkBuddy / Windsurf / Cline and your Obsidian notes on Mac / Linux / Windows, synced incrementally to your own server
- 🖥️ **Multimodal doc & media workbench** — In-app immersive viewing for Office (PPT / Word / Excel), PDF, code artifacts, and media; mobile 100vw × 100dvh fullscreen & 90° landscape presentation for 16:9 slides; windowed slicing pagination for large CSV / TSV datasets with instant millisecond response; one-click publishing to WeChat Official Account drafts with automatic 2.35:1 hero illustration sync; GPU 3D composite acceleration and explicit decoder context unbinding
- 🤖 **All-day AI Butler & interactive assistant** — Fullscreen responsive conversation flow, full-screen thinking mode with lightning indicator, multi-agent collaboration; flexible model switching in personal settings supporting latest Claude Code models, OpenAI, DeepSeek, and intelligent quota/health detection
- 🛰️ **Hand work to any device** — From the web or your phone, give a Claude Code / Codex / Antigravity / WorkBuddy task to any online device; it arrives at once over the device's WebSocket connection, progress and results stream back, and you can stop it any time. An offline device is reported on the spot instead of silently queueing (shell commands need `MEMENTO_REMOTE_EXEC=1` on the server)
- 🛎️ **Proactive butler** — A check every minute: multi-step background missions are planned step by step by the AI and run on online devices, with risky commands waiting for your approval; a device that has been down 5 minutes gets one alert per outage; a morning and an evening brief each day; quiet hours keep missions moving but push nothing
- 👤 **Persona & 3D digital twin** — Personalized persona onboarding with gender, cartoon avatar, and responsive 3D twin; deep customization for behavioral rules, coding preferences, and long-term memory that evolves across sessions
- ⚡ **Skills evolution & proactive pitfall prevention** — Nightly reviews turn multi-step procedures into reusable skills shipped to `~/.claude/skills`, `~/.agents/skills` and more; failures whose cause was found are recorded as pitfalls, and `memory_check_rule` intercepts potential issues before execution
- 📋 **Inbox & task lifecycle closure** — Action items mentioned in conversations automatically flow into `/inbox` with priorities, due alerts and one-click status sync
- 🌅 **Circadian rhythm & two-stage AI digest** — Circadian cognitive cycle with a nightly 23:30 two-stage summary: per-document summaries first, then aggregated cross-tool daily digest
- 🔍 **Hybrid retrieval** — BGE-M3 vectors + jieba-tokenized full-text index; high-precision retrieval across both English and Chinese
- 🕸️ **Knowledge graph** — LLM extracts entities (projects / tools / technologies / people / concepts), relations and observations from conversations; observations older than 7 days are auto-compacted into summaries
- 🔗 **Native MCP service** — Find, drill, write, and overview tools, plus pre-flight rule check (`memory_check_rule`), skills (`memory_skill`), pitfalls (`memory_pitfall`), and todos (`todo_list` / `todo_add` / `todo_update`); any AI IDE can inspect and update your memory directly
- ♻️ **Memory metabolism** — Tracks how often the AI uses each memory; duplicates and memories overturned by newer statements are marked superseded (the persona drops the old line too), and memories unused for 60 days are summarized into dormancy; only marked, never deleted, and can be woken any time
- 📏 **Retrieval evaluation** — A versioned question set generated from your own documents is scored weekly through the same retrieval Ask uses; drops in hit@5 / MRR raise an alert
- 🔒 **Sanitized before upload** — On your machine the daemon applies 15 rules to strip secrets (OpenAI / Anthropic / GitHub / Slack / Telegram / AWS / Bearer tokens / private keys / URL-embedded credentials / `password=…` …), drops inline base64 images, and blanks the values of JSON keys such as `token` / `password` / `api_key` — secrets never leave the machine
- 🌐 **Public sharing** — One-click share links for project timelines / daily digests, with GeoIP visitor stats, expiry, and instant revocation
- 🛡️ **100% self-hosted** — One-shot Docker Compose; Postgres + Redis + MinIO all on your own machine — your data never leaves
- 🔐 **Multi-tenant isolation** — Per-user namespaces with owner / admin / viewer roles + fine-grained per-resource grants + audit log
- ⚡ **Modern desktop app & daemon** — Native Electron app, no Python required, lives in system tray, supports minimize to tray on macOS, permanent login memory, zero-latency menu navigation; while offline it remembers how far each file was uploaded (`~/.memento/offsets.json`) and resumes from there when the network is back

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
        OBS["Obsidian Vault"]
        COL["Memento daemon<br/>in the desktop app / memento-daemon<br/>file watching · resumable upload<br/>sanitized before upload · runs dispatched tasks"]
        CC --- COL
        CDX --- COL
        CUR --- COL
        AG --- COL
        WB --- COL
        WS --- COL
        CL --- COL
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

        EMB["BGE-M3 Embedding<br/>:8002 (Docker / host)"]

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
    NGX -.->|"tasks over WebSocket"| COL
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
    class CC,CDX,CUR,AG,WB,WS,CL,OBS,COL device
    class API,WEB,CW,CB,PG,RD,S3,EMB,NGX server
    class MCC,MCDX,MCUR,MAG,MCP client
    class SHARE,GEO public
```

### Data flow (a single conversation, from creation to searchable)

```mermaid
sequenceDiagram
    participant T as AI tool
    participant W as Local file
    participant C as Daemon
    participant A as API
    participant P as Postgres
    participant E as Embedding
    participant M as MCP

    T->>W: write .jsonl conversation
    W->>C: fs.watch file event
    C->>C: read what was added since the last uploaded byte + sanitize
    C->>A: HTTPS POST (on network errors back off from 2s, doubling, up to 60s)
    A->>P: write documents / conversation_messages / document_search
    A-->>C: acknowledged
    C->>C: save the new position (~/.memento/offsets.json); resume from here after an outage
    A-->>E: async embedding
    E->>P: write document_embeddings (pgvector)
    A-->>P: LLM extracts entities / relations
    Note over M: User calls memory_search inside Claude Code
    M->>A: GET /api/memory/semantic
    A->>E: embed query
    E->>P: cosine_distance ranking
    P-->>M: return relevant chunks
```

> A changed document is embedded once it has gone quiet; when embedding fails, `embedding_status` is set to `failed`. Celery beat scans `pending/failed` rows **every minute** and retries failures with backoff — no vectors are lost to transient hiccups.

## 🧰 Supported AI tools

| Tool | What's collected (directory) | Format |
|------|------------------|--------|
| **Claude Code** | conversations (incl. subagents) `~/.claude/projects`, plans `~/.claude/plans` | JSONL / Markdown |
| **Codex** | sessions `~/.codex/sessions` | JSONL / JSON |
| **Antigravity** | conversations `~/.gemini/antigravity/brain/<session>/…/transcript.jsonl` (the copy without base64 images) | JSONL |
| **WorkBuddy / CodeBuddy** | sessions `~/.workbuddy/projects`, `~/.codebuddy/projects` (no subagents) | JSONL |
| **Cursor** | sessions `~/.cursor/projects` | JSONL / JSON |
| **Windsurf** | Cascade records `~/.codeium/windsurf/cascade` | JSON / Markdown |
| **Cline / Roo Code** | `tasks` in VS Code `globalStorage` | JSON / Markdown |
| **Obsidian** | notes of every vault listed in Obsidian's own `obsidian.json` | Markdown |

`extra_watch_dirs` in `~/.memento/collector.json` adds more Markdown directories to collect.

OpenClaw and Hermes conversations are not collected; they only receive the persona. The persona is written into each tool's global instructions file: Claude Code `~/.claude/CLAUDE.md`, Codex `~/.codex/AGENTS.md`, Antigravity / Gemini `~/.gemini/GEMINI.md`, WorkBuddy `~/.workbuddy/MEMORY.md`, OpenClaw `~/.openclaw/workspace/USER.md`, Hermes `~/.hermes/SOUL.md`. Only the part between `<!-- memento:begin -->` and `<!-- memento:end -->` is touched; which tools get it is chosen per device in the app.

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
| `./install.sh uninstall --all` | Nuclear: collector service / `~/.memento` / the persona blocks, Stop hooks and skills written into AI tools / MCP entries / model cache / Docker images and volumes — wiped |
| `./install.sh uninstall-collector` | For a device that only runs the collector: removes the collector service and everything it left on this machine, without touching Docker |

### Service ports

| Port | Service |
|---|---|
| **8001** | API (Swagger: `/docs`) |
| **3001** | Web UI |
| 8002 / 18002 | Embedding: host port 8002 in `--native` mode; Docker mode publishes it on host port 18002 (change with `MEMENTO_EMBEDDING_HOST_PORT`), containers reach it at `embedding:8002` |
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
| **Windows** (x64) | `.exe` | NSIS installer with system tray & auto-start |
| **Linux** (x64) | `.AppImage` / `.tar.gz` | Make the AppImage executable and run it; or extract the tar.gz and run `memento` |
| **Android** | `.apk` | Expo shell around the web app: conversations, the document inspector and daily digests on your phone, and handing work to devices |
| **iOS** | TestFlight | The same Expo shell, currently distributed through TestFlight |

**Out-of-the-box Experience**:
1. Native application window directly loads the Memento workbench. Login state is **permanently remembered** across restarts.
2. Sign in or register directly within the app (or via GitHub OAuth). The app **silently manages credentials, the daemon, and local MCP servers** — users never need to see, copy, or manage tokens.
3. Remembers open tabs and menu states with zero-latency switching; includes the full multi-modal document & media workbench.
4. Checks for new releases and offers to install them; a downloaded installer is checked against the SHA-512 in the release metadata before it is installed.

> If macOS says it "can't verify the developer", right-click the icon → Open, or run `xattr -dr com.apple.quarantine /Applications/Memento.app`.

### Option 2: Command line (Node.js daemon)

For servers, headless setups, or CLI enthusiasts; requires Node.js ≥ 20. Uses the same core daemon engine (`packages/daemon`):

```bash
git clone https://github.com/ddong8/memento.git && cd memento
npm ci --workspace @memento/daemon --workspace @memento/core --workspace @memento/mcp --include-workspace-root
npm run build -w @memento/daemon -w @memento/mcp

# Log in and install as a background system service (starts automatically at boot)
node packages/daemon/dist/cli.js login <collector token> https://mem.ihasy.com
node packages/daemon/dist/cli.js install-service
```

Common management commands:
```bash
node packages/daemon/dist/cli.js status              # show status
node packages/daemon/dist/cli.js run                 # run in foreground (debug)
node packages/daemon/dist/cli.js install-service     # start automatically after login
node packages/daemon/dist/cli.js uninstall-service   # stop starting automatically
```

Auto-detects platform: **macOS** launchd / **Linux** systemd user / **Windows** Run key. The desktop app and the daemon make sure only one instance runs at a time (they share `~/.memento`). Logs go to `~/.memento/daemon.log`.

## 🕸️ Knowledge graph

The system extracts the following from every synced conversation / document via LLM:

- **Entities** (`knowledge_entities`) — projects / tools / technologies / people / concepts; deduplicated across conversations
- **Relations** (`knowledge_relations`) — `uses` / `creates` / `depends_on` / `discussed` between entities
- **Observations** (`observations`) — concrete factual statements about an entity, with timestamp and source document

**Auto-compaction**: observations on the same entity older than 7 days get merged by an LLM into a shorter summary — preserves semantics, saves space. The window is tunable via `MEMENTO_COMPACTION_AGE_DAYS`.

Read / write through MCP tools: write with `memory_store`; read with `memory_graph(entity_name)` for an entity's neighbors and observations, `memory_context(project)` for project-level context, or `memory_recall(category, days)` for a time-series view. Visualize at the Web `/memory` page.

## 🧠 MCP memory service

The desktop app ships the MCP server (`@memento/mcp`), and its config needs no token: the server reads this device's sign-in (`~/.memento/collector.json`), so signing in again or switching accounts never touches the config. Every 5 minutes the desktop app checks the `memento-memory` entry of Claude Code, Codex, Antigravity and Cursor: one still on an old launcher (the Python server, the removed sidecar, a hardcoded token) is pointed at the bundled server, a tool chosen for the resident profile gets one when it has none, each change is backed up to `~/.memento/backups/mcp` first, and the devices page shows how each tool stands. For other tools, the "This computer" page has ready-to-copy setup (`mcpServers` JSON). On a machine without the desktop app, run `npm ci && npm run build -w @memento/mcp` in a checkout, then `node packages/mcp/dist/cli.js` (it reads the sign-in from `~/.memento/collector.json`, or pass `--server URL --token TOKEN`). Where each tool keeps its MCP config:

| AI tool | MCP config file | How it's written |
|---|---|---|
| Claude Code | `~/.claude.json` | run the copied `claude mcp add` command |
| Cursor | `~/.cursor/mcp.json` | JSON `mcpServers.memento-memory` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | same |
| Antigravity | `~/.gemini/config/mcp_config.json` (shared by the app, the IDE and the agy CLI; older versions used `~/.gemini/antigravity/mcp_config.json`, which is no longer read once they move) | same |
| Gemini CLI | `~/.gemini/settings.json` | same |
| **Codex** | `~/.codex/config.toml` | TOML `[mcp_servers.memento-memory]` |

After installation, AI IDEs can call:

| Tool | Purpose |
|---|---|
| **Find** | |
| `memory_search(query, limit, tool_filter, days)` | Cross-tool hybrid search (BGE-M3 semantic + jieba full-text; falls back to full-text when the semantic endpoint is unavailable); `days` bounds the time window, `tool_filter` restricts to one tool |
| `memory_recall(category, project, days, limit, date)` | Recall a category's records from the last N days (or a given date) |
| `memory_context(project_name)` | Pull context when switching projects (project metadata + full text of curated docs + list of recent conversations) |
| `memory_blueprint(project_name, recent_conversations, section)` | With a project name: the whole project blueprint in one call (metadata + codebase architecture blueprint + docs + recent conversations + graph entities); with `me` / `user`: the personal cross-project blueprint. The codebase blueprint comes as its quick summary and section index by default; `section` takes section numbers (`3`, `4,6.5`) for just those, or `all` for the whole file |
| `memory_project_map()` | All projects at a glance: name, main tool, document count |
| **Drill in** | |
| `memory_open(doc_id)` | Fetch the full content of a document (use after `memory_search` returns a snippet) |
| `memory_conversation(doc_id, limit, offset)` | Unfold a conversation document into role/content/timestamp messages, with pagination |
| `memory_graph(entity_name, limit)` | Knowledge-graph drill-in: entity summary + incoming/outgoing relations + recent observations |
| **Write** | |
| `memory_store(content, entity_name, entity_type)` | Save an observation into the knowledge graph |
| **Overview** | |
| `daily_summary(date_str)` | Cross-tool activity digest + AI summary for a given day |
| `memory_core(category)` | Long-term core memory (MEMORY.md) distilled by the nightly review: rules, architecture decisions, project knowledge, pitfalls |
| `mind_resonance(query, project, action)` | Align before acting: the current scenario's rules, user preferences, related graph entities and pitfalls to avoid |
| **Before acting / learned** | |
| `memory_check_rule(action_type, project_name, details)` | Call before deploying, releasing, migrating or changing data: relevant rules, past pitfalls, skills to follow |
| `memory_skill(query)` | Full steps of a published skill (no argument lists them all) |
| `memory_pitfall(title, symptom, fix, cause, project)` | Record a failure whose cause you found and fixed, to be warned next time |
| `todo_list(project)` / `todo_add(title, detail, due, project)` / `todo_update(todo_id, status, title, due)` | Todos: list, record "do this later", close or drop |

On a machine running the collector the MCP server needs no `--token`: it reads the server URL and device token from `~/.memento/collector.json`, and picks up a rotated token by itself.

That is 18 tools in all, plus 6 MCP **resources** exposed as URIs (subscribable from any IDE):

| URI | Content |
|---|---|
| `memory://projects` | list of all projects |
| `memory://projects/{name}` | single project detail (conversations / entities / observations) |
| `memory://identity/{tool}` | "identity card" for a tool (user preferences / long-term memory) |
| `memory://daily/{date}` | activity digest for a given day |
| `memory://core` | long-term core memory MEMORY.md |
| `memory://resonance` | the current mind-resonance context (intent, scenario rules, graph entities, pitfalls to avoid) |

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
- **Session persistence & silent authorization** — The desktop app keeps you signed in and authorized, starts in the background at boot, collects around the clock, and resumes uploading after an outage.

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
| Desktop | Electron + electron-updater (bundles the daemon and the MCP server) |
| Mobile | Expo (React Native) shell + react-native-webview, Android APK / iOS TestFlight |
| AI summary / graph | Anthropic Claude API + OpenAI-compatible endpoints (Kimi / DashScope...) |
| Embedding | BAAI/bge-m3 via an OpenAI-compatible API (e.g. SiliconFlow) or the self-hosted BGE-M3 service (Docker; `--native` runs a host venv, CUDA on Linux) |
| GeoIP | MaxMind GeoLite2 / db-ip city-lite (offline mmdb) |
| Deployment | Docker Compose (7 services) |

## ⚙️ Background tasks

Scheduled by Celery beat (times in `Asia/Shanghai`):

| Task | Trigger | Purpose |
|---|---|---|
| `daily-digest` | every day at 23:30, again at 03:30 the next day | Cross-tool daily AI activity digest (per-doc summaries → aggregation); the 03:30 run picks up messages that synced after midnight |
| `review-sessions` | every day at 02:20 | Review finished sessions: distill skills, pitfalls, todos |
| `nightly-dreaming` | every day at 03:00 | Nightly memory consolidation: writes the long-term core memory MEMORY.md, discovers new scenarios |
| `memory-lifecycle` | every day at 04:10 | Merge duplicate memories, mark overturned ones, move memories unused for 60 days into dormancy |
| `tsvector-backfill` | every day at 04:25 | Add the full-text index for documents that lack it (written to `document_search`) |
| `embedding-retry` | every minute | Embed documents that have gone quiet after a change; retry failures with backoff |
| `merge-staged-deltas` | every minute | Merge staged increments of large conversations into the body |
| `message-audit` | every 5 minutes | Check changed conversations: does the message table match the raw file |
| `knowledge-retry` | every 15 minutes | Retry documents whose graph extraction failed |
| `learn-corrections` / `learn-todos` | every 10 minutes | Learn corrections from new conversations; spot "do this later" and "done" |
| `close-stale-tasks` | every 10 minutes | Mark dispatched tasks that no device will report on as timed out |
| `title-backfill` | every hour at :07 | Give documents still carrying a meaningless title their real title |
| `health-check` | every 30 minutes | Push an alert when AI calls fail a lot or the balance is low |
| `remind-todos` | every day at 09:05 | Push todos due today and overdue |
| `weekly-db-backup` | Sundays at 03:30 | Export every table, compress and store in MinIO, keep 8 weeks |
| `evaluate-retrieval` / `evaluate-learning` | Mondays at 04:40 / 04:50 | Retrieval evaluation, correction-learning evaluation |

The API process runs three more loops: the proactive butler checks every minute and graph observation compaction runs daily (observations older than `MEMENTO_COMPACTION_AGE_DAYS` days are merged into a summary) — with several replicas only one replica runs these two; every replica reloads the scenarios learned overnight every 10 minutes (an in-process cache each replica refreshes on its own).

## 📁 Directory layout

```
memento/
├── packages/
│   ├── core/                 # @memento/core: API types, ask stream, task events (shared)
│   ├── daemon/               # @memento/daemon: collection, dispatched tasks, profile/skills
│   └── mcp/                  # @memento/mcp: MCP memory server (ships with the desktop app)
├── apps/
│   ├── desktop/              # Electron desktop app (Memento)
│   ├── mobile/               # Expo mobile shell (wraps the web app)
│   └── web/                  # Next.js 16 frontend
│       ├── src/app/          # 35 pages
│       └── src/components/   # Aurora design system
├── server/                   # Backend FastAPI
│   └── server/
│       ├── main.py           # entry + schema migrations + validate_production
│       ├── config.py         # MEMENTO_-prefixed settings + fail-fast
│       ├── middleware/       # JWT + collector token (constant-time)
│       ├── api/              # REST + SSE
│       ├── db/               # 39 tables
│       ├── services/         # ingest / embedding / graph / dispatch / proactive butler / nightly review …
│       └── tasks/            # Celery worker + beat
├── embedding/                # BGE-M3 host service
├── scripts/                  # installer (install.mts + install/), release metadata and other tools (TypeScript)
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
| `MEMENTO_SERVER_URL` | https://mem.ihasy.com | Server URL; `server_url` in `~/.memento/collector.json` wins when present |
| `MEMENTO_SERVER_TOKEN` | — | collector token; `token` in collector.json wins when present |
| `MEMENTO_WEB_URL` | — | Web app URL, when it differs from the server URL |
| `MEMENTO_REMOTE_EXEC_KEY` | fetched automatically | Key that verifies dispatched shell tasks; the device fetches it with its heartbeat and keeps it in `~/.memento/remote_exec_key`, so it rarely needs setting |
| `MEMENTO_INSECURE_TLS` | — | Set `1` to skip certificate checks on the WebSocket (self-signed test setups only) |
| `MEMENTO_DAEMON_PORT` | a random free port | Port of the local API under `cli.js run` |

You rarely need these: signing in to the desktop app or `cli.js login` writes `~/.memento/collector.json`.

</details>

<details>
<summary><b>Server (api / celery)</b></summary>

With Docker Compose, put them all in `.env` at the repo root: the api and both celery containers read the whole file (`env_file` in `docker-compose.yml`), and re-running `./install.sh` keeps them. The database, Redis and MinIO addresses are wired by compose to the container names, so setting them in `.env` has no effect; wrap values containing `$` in single quotes.

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMENTO_DATABASE_URL` | postgresql+asyncpg://postgres:postgres@localhost:5433/memento | Postgres connection |
| `MEMENTO_REDIS_URL` | redis://localhost:6380/0 | Redis broker + backend |
| `MEMENTO_COLLECTOR_TOKEN` | collector-dev-token | Fallback collector token (dev only) |
| `MEMENTO_SECRET_KEY` | change-me-in-production | JWT signing key (must override in prod) |
| `MEMENTO_S3_ENDPOINT` | http://localhost:9000 | MinIO/S3 endpoint |
| `MEMENTO_S3_ACCESS_KEY` / `MEMENTO_S3_SECRET_KEY` | minioadmin | MinIO credentials |
| `MEMENTO_S3_BUCKET` | memento | bucket for large files |
| `MEMENTO_ANTHROPIC_API_KEY` | — | Claude API (AI summaries); with compose, write `ANTHROPIC_API_KEY` in `.env` |
| `MEMENTO_AI_API_KEY` / `_BASE_URL` / `_MODEL` | — / dashscope / kimi-k2.5 | Primary OpenAI-compatible endpoint |
| `MEMENTO_AI_FALLBACK_API_KEY` / `_BASE_URL` / `_MODEL` | OneAPI / qwen3.8-27b | Automated failover AI endpoint (Fallback) |
| `MEMENTO_AI_PROVIDERS` | — | JSON list of multiple AI providers for tiered fallback |
| `MEMENTO_AI_BACKGROUND_MODEL` | — | Model background jobs (summaries, extraction, persona) try first on the primary endpoint, falling back to the main model; unset means the main model |
| `MEMENTO_AI_BALANCE_ALERT` | 10 | Daily alert when the AI account balance drops below this |
| `MEMENTO_EMBEDDING_PROVIDER` | local | `local` uses the self-hosted BGE-M3 service; `openai` an OpenAI-compatible API (e.g. SiliconFlow) |
| `MEMENTO_EMBEDDING_API_URL` / `_API_KEY` / `_MODEL` | https://api.siliconflow.cn/v1 / — / BAAI/bge-m3 | Endpoint, key and model for `openai` mode |
| `MEMENTO_EMBEDDING_DIM` | 1024 | Vector dimension |
| `MEMENTO_EMBEDDING_SERVER_URL` | http://embedding:8002 under compose | Service address for `local` mode; `./install.sh embedding --native` sets it to `http://host.docker.internal:8002` (also the default outside compose) |
| `MEMENTO_COMPACTION_AGE_DAYS` | 7 | Age in days after which graph observations are merged into a summary |
| `MEMENTO_REGISTRATION_MODE` | open | Registration mode, see [Users and permissions](#-users-and-permissions) |
| `MEMENTO_PUBLIC_URL` | — | Public base URL, used to build the GitHub login callback |
| `MEMENTO_CORS_ALLOW_ORIGIN_REGEX` | `.*` | Origins allowed cross-origin access; in production list only your domain |
| `MEMENTO_REMOTE_EXEC` | — | Set `1` to allow dispatching shell commands to devices |
| `MEMENTO_SHUTDOWN_DRAIN_SECONDS` | 600 | During a release, how long the old process waits for in-flight answers before exiting |
| `MEMENTO_CLAUDE_AUTO_COMPACT_WINDOW` | 200000 | Token count at which Claude Code run through Memento compacts its context |
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
| `MEMENTO_EMBEDDING_DEVICE` | auto | Force a device (e.g. `cpu` / `cuda` / `mps`) |

</details>

## 🌐 Remote access / custom domain

- The frontend's API base URL automatically follows `window.location.hostname` (see `getApiBase()`; never hardcoded)
- Docker port mappings work over both IPv4 and IPv6
- Cross-origin access is controlled by `MEMENTO_CORS_ALLOW_ORIGIN_REGEX` in `.env`, default `.*` (any origin); for a public deployment allow only your domain, for example:

  ```bash
  MEMENTO_CORS_ALLOW_ORIGIN_REGEX='https?://(localhost:\d+|mem\.example\.com)'
  ```

## 🗑️ Uninstall

<details>
<summary><b>Server (installed via install.sh)</b></summary>

```bash
./install.sh uninstall          # stop containers and the collector service; keep data / .env
./install.sh uninstall --purge  # above + drop Docker volumes + .env
./install.sh uninstall --all    # nuclear (add -y to skip confirmation)
```

`--all` removes (quit the Memento desktop app first, or it writes them back):
- the collector daemon service, plus pip packages old installs left (memento-brain-* + legacy daily-report-*)
- what was written into AI tools: the persona block in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` and the like, the Claude Code and Codex Stop hooks, synced skills, the `agy` wrapper script; skills you edited and any text outside the markers are kept
- `~/.memento` (including the daemon log `daemon.log`) + `~/.daily-report` (legacy path)
- log directories of the old Python collector (macOS / Linux / Windows paths)
- Embedding venv + HuggingFace model cache (~1.3 GB)
- Docker images + volumes
- `.env` / `.env.local`
- The `memento-memory` MCP entry from every AI tool

</details>

<details>
<summary><b>Daemon-only device</b></summary>

Run in the repo directory (needs Node.js 22.18+, or the Memento desktop app installed):

```bash
./install.sh uninstall-collector     # macOS / Linux
.\install.ps1 uninstall-collector    # Windows
```

It removes the login service, takes back the persona blocks, Stop hooks, skills and MCP entries written into each AI tool, then deletes `~/.memento` (config, upload positions and logs live there). It skips the server install and does not touch Docker.

</details>

## 📄 License

This project is licensed under [AGPL-3.0](LICENSE).

In short: personal use, self-hosting, internal corporate use, and research are all free. But if you take this code (or any modifications) and offer it as a network service (SaaS / public hosting), AGPL §13 requires you to release your full modified source code under AGPL as well.

For commercial licensing (waiver of AGPL terms, closed-source use, SaaS deployment, etc.), please contact the author.
