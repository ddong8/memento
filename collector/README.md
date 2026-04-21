# memento-collector

Cross-platform agent that automatically collects AI coding tool memory files and syncs them to a central [Memento](https://github.com/ddong8/memento) server (a shared brain for your AI coding tools).

## Supported AI Tools

| Tool | Data Collected |
|------|---------------|
| **Claude Code** | Conversations, memory, plans, history |
| **OpenClaw** | Sessions, identity, memory, learnings, skills |
| **Codex** | Sessions (active + archived), history, skills |
| **Antigravity** | Full conversations (built-in `.pb` decryption — AES-256-GCM + protobuf), brain plans, code snapshots |
| **Obsidian** | All markdown notes in your vault |
| **Cursor** | Agent transcripts, skills, MCP config |

## Install

```bash
pip install memento-brain-collector
```

Antigravity support (decrypting encrypted `.pb` conversation files) is built in —
no extras needed. The `cryptography` library is already a required dependency.

## Quick Start

```bash
# Interactive setup (first time)
memento-collector setup

# Or run directly
memento-collector run
```

The setup wizard will:
1. Detect your platform (macOS / Linux / Windows)
2. Auto-discover installed AI tools and Obsidian vaults
3. Configure the server URL and auth token
4. Optionally install as a system service (auto-start on boot)

## Commands

```bash
memento-collector setup      # Interactive setup wizard
memento-collector run        # Run in foreground
memento-collector install    # Install as system service
memento-collector start      # Start the service
memento-collector stop       # Stop the service
memento-collector status     # Show collector status
memento-collector uninstall  # Remove system service
```

## How It Works

1. **File Watching** — Uses `watchdog` (FSEvents on macOS, inotify on Linux, ReadDirectoryChanges on Windows) to detect file changes in real-time
2. **Parsing** — Supports Markdown, JSONL, JSON, TOML, SQLite formats
3. **Sanitization** — Automatically redacts API keys, tokens, passwords, private keys before upload
4. **Queuing** — Local SQLite queue for offline resilience (syncs when server is reachable)
5. **Syncing** — HTTP upload to server, with chunked upload for files > 2MB (tested with 37MB files)
6. **Device Identity** — Each device gets a persistent unique ID, all data tagged with device info

## Configuration

Environment variables (or set via `memento-collector setup`):

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMENTO_SERVER_URL` | `http://localhost:8001` | Server API URL |
| `MEMENTO_SERVER_TOKEN` | | Collector auth token |
| `MEMENTO_OBSIDIAN_VAULT_PATH` | Auto-detected | Obsidian vault path |

Config file: `~/.memento/config.json`

## System Service

| Platform | Service Type | Config Location |
|----------|-------------|-----------------|
| macOS | LaunchAgent | `~/Library/LaunchAgents/com.memento.collector.plist` |
| Linux | systemd user | `~/.config/systemd/user/memento-collector.service` |
| Windows | Task Scheduler | `MementoCollector` scheduled task |

## License

MIT
