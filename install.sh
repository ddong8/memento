#!/usr/bin/env bash
# One-click installer launcher (macOS / Linux).
# Delegates to scripts/install.py — this file only locates a suitable Python.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PY=""
for candidate in \
    "${MEMENTO_INSTALL_PYTHON:-}" \
    python3.13 python3.12 python3.11 \
    /opt/homebrew/opt/python@3.11/bin/python3.11 \
    /usr/local/opt/python@3.11/bin/python3.11 \
    python3 python
do
    [ -z "$candidate" ] && continue
    if command -v "$candidate" >/dev/null 2>&1; then
        # verify >= 3.11
        if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null; then
            PY="$candidate"
            break
        fi
    fi
done

if [ -z "$PY" ]; then
    cat >&2 <<'EOF'
Error: Python 3.11 or newer is required but was not found.

Install options:
  macOS:   brew install python@3.11
  Linux:   sudo apt install python3.11 python3.11-venv
  Other:   https://www.python.org/downloads/

Or set MEMENTO_INSTALL_PYTHON to the path of your Python 3.11+ interpreter.
EOF
    exit 1
fi

exec "$PY" scripts/install.py "$@"
