# Memento MCP Server

Personal AI memory powered by your Memento data.

## Usage

```bash
pip install memento-brain-memory
memento-memory --db-url postgresql+asyncpg://user:pass@host:port/memento
```

## Claude Code Configuration

```json
{
  "mcpServers": {
    "memento-memory": {
      "command": "memento-memory",
      "args": ["--db-url", "postgresql+asyncpg://postgres:postgres@localhost:5433/memento"]
    }
  }
}
```
