#!/usr/bin/env bash
# One-click installer launcher (macOS / Linux).
# Delegates to scripts/install.mts — this file only locates a runtime that runs TypeScript directly:
# Node.js 22.18+, or the Node inside the Memento app.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# Whether this runtime strips TypeScript types by default (Node 22.18+ / 23.6+)
runs_ts() {
    "$@" -e 'process.exit(process.features.typescript ? 0 : 1)' >/dev/null 2>&1
}

RUNTIME=()
for candidate in "${MEMENTO_INSTALL_NODE:-}" node; do
    [ -z "$candidate" ] && continue
    if command -v "$candidate" >/dev/null 2>&1 && runs_ts "$candidate"; then
        RUNTIME=("$candidate")
        break
    fi
done

# No suitable Node.js: the Memento app's own runtime (macOS installs it at a fixed place), run as plain Node
if [ ${#RUNTIME[@]} -eq 0 ]; then
    for app in \
        /Applications/Memento.app/Contents/MacOS/Memento \
        "$HOME/Applications/Memento.app/Contents/MacOS/Memento"
    do
        if [ -x "$app" ] && ELECTRON_RUN_AS_NODE=1 runs_ts "$app"; then
            RUNTIME=(env ELECTRON_RUN_AS_NODE=1 "$app")
            break
        fi
    done
fi

if [ ${#RUNTIME[@]} -eq 0 ]; then
    cat >&2 <<'EOF'
Error: Node.js 22.18 or newer is required but was not found.

Install options:
  macOS:   brew install node
  Linux:   https://nodejs.org/en/download (or your distro's nodejs 22+ package)
  Other:   https://nodejs.org/en/download

Or set MEMENTO_INSTALL_NODE to the path of your Node.js 22.18+ binary.
(The native GPU embedding install, `./install.sh embedding --native`, also needs Python 3.11+.)
EOF
    exit 1
fi

exec "${RUNTIME[@]}" scripts/install.mts "$@"
