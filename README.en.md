<div align="center">

# Memento

**A shared brain for your AI coding tools**

Auto-collect AI coding conversations and memory across devices and tools, aggregate on your own backend, and view / search / recall through a unified Web UI + MCP.

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Python ≥3.10](https://img.shields.io/badge/python-≥3.10-blue.svg)](#-tech-stack)
[![Next.js 16](https://img.shields.io/badge/next.js-16-black.svg)](#-tech-stack)
[![PyPI - memento-brain](https://img.shields.io/pypi/v/memento-brain?label=memento-brain)](https://pypi.org/project/memento-brain/)
[![PyPI - memento-brain-collector](https://img.shields.io/pypi/v/memento-brain-collector?label=collector)](https://pypi.org/project/memento-brain-collector/)
[![PyPI - memento-brain-memory](https://img.shields.io/pypi/v/memento-brain-memory?label=mcp-memory)](https://pypi.org/project/memento-brain-memory/)

[Quick Start](#-quick-start) · [Architecture](#️-architecture) · [Supported Tools](#-supported-ai-tools) · [Self-host](#-quick-start) · [MCP](#-mcp-memory-service)

🌐 **Languages**: [中文](README.md) · [English](README.en.md)

</div>

---

## ✨ What it does

- 🧠 **Cross-device conversation sync** — Claude Code / Codex / Cursor / Antigravity etc. on Mac / Linux / Windows, all aggregated in one place
- 🔍 **Hybrid retrieval** — BGE-M3 vectors + jieba-tokenized full-text index; works for both English and Chinese
- 🕸️ **Knowledge graph** — LLM extracts entities (projects / tools / technologies / people / concepts), relations and observations from conversations; observations older than 7 days are auto-compacted into summaries
- 🔗 **MCP integration** — Call `memory_search` / `memory_recall` / `daily_summary` directly inside any AI IDE; Claude can look up what you've done
- 📅 **AI daily digest** — Celery runs a two-stage job at 23:30 every day: per-document summaries first, then aggregated into a cross-tool digest
- 🔒 **Sanitize-before-enqueue** — The collector strips 14 classes of secrets locally (OpenAI / Anthropic / GitHub / Slack / Telegram / AWS / Bearer tokens / private keys / URL-embedded credentials …) so even the on-disk SQLite queue is safe
- 🌐 **Public sharing** — One-click share links for project timelines / daily digests, with GeoIP visitor stats, expiry, revoke any time
- 🛡️ **Fully self-hosted** — One-shot Docker Compose; Postgres + Redis + MinIO all on your own machine — data never leaves
- 🔐 **Multi-tenant isolation** — Per-user namespaces with owner / admin / viewer roles + fine-grained per-resource grants + audit log
- ⚡ **Daemon-grade** — Runs as launchd / systemd / Task Scheduler; offline queue and self-healing retry when network drops

## 🏗️ Architecture

```mermaid
graph TB
    subgraph DEV["📱 User devices Mac/Linux/Windows"]
        direction LR
        CC["Claude Code<br/>~/.claude"]
        CDX["Codex<br/>~/.codex"]
        CUR["Cursor<br/>~/.cursor"]
        AG["Antigravity<br/>~/.gemini/antigravity"]
        OC["OpenClaw<br/>~/.openclaw"]
        HM["Hermes<br/>~/.hermes"]
        OBS["Obsidian Vault"]
        COL["memento-brain-collector<br/>watchdog listener<br/>SQLite offline queue<br/>sanitizer on enqueue"]
        CC --- COL
        CDX --- COL
        CUR --- COL
        AG --- COL
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

    MCP["memento-brain-memory<br/>MCP Server"]
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
| **Obsidian** | all notes | Markdown |
| **Cursor** | conversations, skills, MCP config | JSONL / Markdown |
| **Hermes** | full conversations (incl. tool calls), persona, skills, CLI history | JSON / Markdown / SQLite |

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
5. `pip install memento-brain-collector` + setup + register the system service

Optional commands:

| Command | Description |
|---|---|
| `./install.sh embedding` | Install host BGE-M3 service (~1.3 GB; required for semantic search / MCP recall) |
| `./install.sh doctor` | Check status of all services |
| `./install.sh update` | git pull + rebuild + upgrade |
| `./install.sh uninstall` | Stop services; keep data and config |
| `./install.sh uninstall --purge` | Above + drop Docker volumes + `.env` |
| `./install.sh uninstall --all` | Nuclear: pip packages / `~/.memento` / model cache / Docker images / MCP entries — wiped |

### Service ports

| Port | Service |
|---|---|
| **8001** | API (Swagger: `/docs`) |
| **3001** | Web UI |
| 8002 | Embedding (host) |
| 5433 | PostgreSQL |
| 6380 | Redis |
| 9000 / 9001 | MinIO / console |

> Ports are deliberately offset from common defaults to avoid conflicts.

## 💻 Adding more devices

```bash
pip install memento-brain-collector   # collector only
# or pip install memento-brain         # bundles collector + MCP memory together
memento-collector setup                # interactive: server URL + token
```

> PyPI packages are `memento-brain-collector` / `memento-brain-memory` (the short names were taken). CLIs keep the short aliases `memento-collector` / `memento-memory`.

**How to get a token?**

- **Ran `./install.sh`** → printed at the end and stored in `.env.local`
- **Web register** → `/auth/register`; the first user is auto-owner and the token is shown immediately. Later you can grab it from the avatar menu → Profile.

### Daemon control

```bash
memento-collector status    # show status
memento-collector start     # start service
memento-collector stop      # stop service
memento-collector run       # run in foreground (debug)
```

Auto-detects platform: **macOS** launchd / **Linux** systemd user / **Windows** Task Scheduler.

## 🕸️ Knowledge graph

The system extracts the following from every synced conversation / document via LLM:

- **Entities** (`knowledge_entities`) — projects / tools / technologies / people / concepts; deduplicated across conversations
- **Relations** (`knowledge_relations`) — `uses` / `creates` / `depends_on` / `discussed` between entities
- **Observations** (`observations`) — concrete factual statements about an entity, with timestamp and source document

**Auto-compaction**: observations on the same entity older than 7 days get merged by an LLM into a shorter summary — preserves semantics, saves space. The window is tunable via `MEMENTO_COMPACTION_AGE_DAYS`.

Read / write through MCP tools `memory_recall` / `memory_context` / `memory_store`; visualize at the Web `/memory` page.

## 🧠 MCP memory service

After installing `memento-brain`, `memento-collector setup` automatically wires MCP into every AI IDE it finds:

| AI tool | MCP config file | How it's written |
|---|---|---|
| Claude Code | `~/.claude.json` | `claude mcp add` CLI |
| Cursor | `~/.cursor/mcp.json` | JSON `mcpServers.memento-memory` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | same |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | same |
| **Codex** | `~/.codex/config.toml` | TOML `[mcp_servers.memento-memory]` |
| OpenClaw | `~/.openclaw/openclaw.json` | `openclaw mcp set` CLI |

Tools available inside any AI IDE:

| Tool | Purpose |
|---|---|
| `memory_search(q)` | semantic search across past conversations from all tools |
| `memory_recall(category, days)` | recall recent entries by category |
| `memory_context(project_name)` | pull relevant context when switching projects |
| `daily_summary(date)` | get the activity digest for a given day |
| `memory_store(content, entity_name)` | save an observation explicitly |

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
| `admin` | Approves pending users, manages devices, reads audit log |
| `viewer` | Read-only (default). Sees only projects/tools granted to them |
| `pending` | Newly registered, not yet activated; awaits admin approval |

Key flows:

- **Register** — `/auth/register`. The first user becomes owner + active automatically; subsequent users need admin approval.
- **Self-service token** — Avatar menu → Profile to view / copy / regenerate the collector token.
- **Approve users** — owner/admin go to `/admin`; pending users have an Approve button. The token is revealed immediately after approval.
- **Fine-grained grants** — `/admin/permissions` issues per-project / per-tool read/write grants to viewers.
- **Audit log** — every sensitive action is recorded in `access_logs` (user_id / action / IP / metadata) for after-the-fact review.

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
| Collector | Python ≥3.10, watchdog, httpx, pydantic-settings |
| MCP memory | Python ≥3.10, mcp ≥1.26, asyncpg, pgvector |
| Server | Python ≥3.12, FastAPI ≥0.115, SQLAlchemy 2.0 async, asyncpg, Celery |
| Database | PostgreSQL 16 (+ pgvector + pg_trgm), Redis 7, MinIO (S3-compatible) |
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| AI summary / graph | Anthropic Claude API + OpenAI-compatible endpoints (Kimi / DashScope...) |
| Embedding | BGE-M3 host process (macOS MPS / Linux CUDA / CPU fallback) |
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
├── collector/                # Local collector — PyPI: memento-brain-collector
│   └── collector/
│       ├── main.py           # daemon entry
│       ├── cli.py            # setup / install / start / stop / uninstall
│       ├── watcher.py        # cross-platform watchdog + debounce
│       ├── queue.py          # SQLite WAL offline queue
│       ├── sync_client.py    # HTTPS sync (chunked upload / offline retry)
│       ├── sanitizer.py      # sanitize on enqueue (API keys / private keys / OAuth)
│       ├── parsers/          # 8 parsers
│       └── tools/            # 6 tool definitions
├── mcp_server/               # MCP memory — PyPI: memento-brain-memory
├── memento_brain/            # Meta — PyPI: memento-brain (one-shot install)
├── server/                   # Backend FastAPI
│   └── server/
│       ├── main.py           # entry + schema migrations + validate_production
│       ├── config.py         # MEMENTO_-prefixed settings + fail-fast
│       ├── middleware/       # JWT + collector token (constant-time)
│       ├── api/              # REST + SSE + MCP mount
│       ├── db/               # 16 tables
│       ├── services/         # ingest / embedding / graph / cache / geoip
│       └── tasks/            # Celery worker + beat
├── web/                      # Next.js 16 frontend
│   ├── src/app/              # 18+ pages
│   └── src/components/       # Aurora design system
├── embedding/                # BGE-M3 host service
├── scripts/                  # install.py backend + utility scripts
├── deploy/bootstrap/         # curl one-shot installer (install.sh / .ps1 / index.html)
├── docs/                     # project-architecture.md / collector-architecture.md
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
| `MEMENTO_AI_API_KEY` / `_BASE_URL` / `_MODEL` | — / dashscope / kimi-k2.5 | OpenAI-compatible fallback |
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
./install.sh uninstall          # stop containers; keep data / .env / pip packages
./install.sh uninstall --purge  # above + drop Docker volumes + .env
./install.sh uninstall --all    # nuclear (add -y to skip confirmation)
```

`--all` removes:
- pip packages (memento-brain-* + legacy daily-report-*)
- `~/.memento` + `~/.daily-report` (legacy path)
- Collector logs (macOS / Linux / Windows paths)
- Embedding venv + HuggingFace model cache (~1.3 GB)
- Docker images + volumes
- `.env` / `.env.local`
- The `memento-memory` MCP entry from every AI tool

</details>

<details>
<summary><b>Collector-only device</b></summary>

```bash
memento-collector uninstall                                  # drop launchd/systemd/Task entry
pip uninstall -y memento-brain-collector memento-brain-memory memento-brain
rm -rf ~/.memento

# Logs (pick one)
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
