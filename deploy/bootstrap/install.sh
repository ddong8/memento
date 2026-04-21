#!/usr/bin/env bash
# Memento — remote bootstrap installer.
#
# Usage:  curl -fsSL https://mem.ihasy.com/install.sh | sh
#
# Overrides:
#   MEMENTO_INSTALL_DIR   target dir (default: $HOME/memento)
#   MEMENTO_VERSION       git ref to download (default: main)
#   MEMENTO_REPO_URL      repo base URL (default: https://github.com/ddong8/memento)
#   MEMENTO_MIRROR_URL    fast mirror for tarball (default: https://mem.ihasy.com/install/latest.tar.gz)

set -euo pipefail

VERSION="${MEMENTO_VERSION:-main}"
TARGET_DIR="${MEMENTO_INSTALL_DIR:-$HOME/memento}"
REPO_URL="${MEMENTO_REPO_URL:-https://github.com/ddong8/memento}"
MIRROR_URL="${MEMENTO_MIRROR_URL:-https://mem.ihasy.com/install/latest.tar.gz}"

# ── ANSI colors (if stdout is a TTY) ──────────────────────────
if [ -t 1 ]; then
    RED=$'\033[31m'; GREEN=$'\033[32m'; CYAN=$'\033[36m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
    RED=""; GREEN=""; CYAN=""; BOLD=""; DIM=""; RST=""
fi
say()  { printf '%s %s\n' "${CYAN}·${RST}" "$*"; }
ok()   { printf '%s %s\n' "${GREEN}✓${RST}" "$*"; }
fail() { printf '%s %s\n' "${RED}✗${RST}" "$*" >&2; }

banner() {
    cat <<EOF
${BOLD}Memento${RST} — one-click installer
${DIM}$(date -u +'%Y-%m-%d %H:%M UTC')${RST}
target: $TARGET_DIR
version: $VERSION
EOF
}

require() {
    if ! command -v "$1" >/dev/null 2>&1; then
        fail "missing: $1"
        case "$1" in
            curl|tar) echo "  → install coreutils or your distro's equivalent" >&2 ;;
            docker)   echo "  → macOS/Windows: install Docker Desktop. Linux: sudo apt install docker.io" >&2 ;;
        esac
        return 1
    fi
}

check_prereqs() {
    local missing=0
    for c in curl tar docker; do
        require "$c" || missing=$((missing + 1))
    done
    if [ "$missing" -gt 0 ]; then
        fail "Please install missing prerequisites, then re-run."
        exit 1
    fi
    if ! docker info >/dev/null 2>&1; then
        fail "Docker daemon is not running."
        case "$(uname -s)" in
            Darwin*)  echo "  → Open Docker Desktop (Applications → Docker)" >&2 ;;
            Linux*)   echo "  → sudo systemctl start docker" >&2 ;;
        esac
        exit 1
    fi
    ok "prerequisites found (curl, tar, docker, daemon running)"
}

download_repo() {
    say "Downloading repository to $TARGET_DIR…"
    mkdir -p "$TARGET_DIR"
    local tmp
    tmp="$(mktemp -t memento-XXXXXX.tar.gz)"
    # Try fast mirror first, fall back to GitHub.
    if curl -fsSL --max-time 15 "$MIRROR_URL" -o "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
        ok "fetched from mirror"
    elif curl -fsSL "$REPO_URL/archive/refs/heads/$VERSION.tar.gz" -o "$tmp"; then
        ok "fetched from GitHub"
    else
        fail "could not download repository from either mirror or GitHub"
        exit 1
    fi
    tar xzf "$tmp" -C "$TARGET_DIR" --strip-components=1
    rm -f "$tmp"
    ok "extracted"
}

main() {
    banner
    echo
    check_prereqs

    # Idempotent re-run: if the target already looks like an install, run update.
    if [ -d "$TARGET_DIR" ] && [ -f "$TARGET_DIR/install.sh" ] && [ -f "$TARGET_DIR/docker-compose.yml" ]; then
        say "Existing installation detected at $TARGET_DIR — running update."
        cd "$TARGET_DIR"
        exec ./install.sh update
    fi

    download_repo
    say "Handing off to the local installer…"
    echo
    cd "$TARGET_DIR"
    chmod +x install.sh uninstall.sh 2>/dev/null || true
    exec ./install.sh "$@"
}

main "$@"
