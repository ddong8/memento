#!/usr/bin/env bash
# Memento — turn a Linux server into an executor: agents (Claude Code / Codex / Antigravity)
# run here on code that stays on your Mac or Windows. Re-running upgrades in place.
#
# Usage:  curl -fsSL https://mem.example.com/install/executor.sh | bash -s -- --token <collector token> [--agents claude,codex,agy]
#
# Options:
#   --token <t>           collector token (web: 设备 → 执行机, or 个人设置); or MEMENTO_TOKEN
#   --server <url>        Memento server (default: the server this script came from); or MEMENTO_SERVER
#   --agents <list>       install missing agent CLIs: claude, codex, agy (comma separated)
#   --no-low-priority     don't run agents at lower CPU / IO priority than other services on this host
# Environment:
#   MEMENTO_REF           git ref to build (default: main)
#   NODE_MIRROR           Node.js download mirror (default: nodejs.org, falls back to npmmirror)

if [ -z "${BASH_VERSION:-}" ]; then
    printf '%s\n' "Run with bash: curl -fsSL <server>/install/executor.sh | bash -s -- --token <token>" >&2
    exit 1
fi

set -euo pipefail

SERVER="${MEMENTO_SERVER:-__MEMENTO_SERVER__}"
TOKEN="${MEMENTO_TOKEN:-}"
AGENTS=""
LOW_PRIORITY=1
REF="${MEMENTO_REF:-main}"
REPO_URL="https://github.com/ddong8/memento.git"
NODE_MIN="22.18.0"

while [ $# -gt 0 ]; do
    case "$1" in
        --token) TOKEN="${2:-}"; shift 2 ;;
        --server) SERVER="${2:-}"; shift 2 ;;
        --agents) AGENTS="${2:-}"; shift 2 ;;
        --no-low-priority) LOW_PRIORITY=0; shift ;;
        -h|--help) sed -n '2,15p' "$0" 2>/dev/null || true; exit 0 ;;
        *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
done

if [ -t 1 ]; then
    RED=$'\033[31m'; GREEN=$'\033[32m'; CYAN=$'\033[36m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
    RED=""; GREEN=""; CYAN=""; BOLD=""; DIM=""; RST=""
fi
say()  { printf '%s %s\n' "${CYAN}·${RST}" "$*"; }
ok()   { printf '%s %s\n' "${GREEN}✓${RST}" "$*"; }
fail() { printf '%s %s\n' "${RED}✗${RST}" "$*" >&2; exit 1; }

case "$SERVER" in
    http://*|https://*) ;;
    *) fail "缺少服务器地址：加 --server https://你的服务器" ;;
esac
SERVER="${SERVER%/}"
[ -n "$TOKEN" ] || fail "缺少 collector token：加 --token <token>（网页「设备」页的执行机卡片里可复制整条命令）"
printf '%s\n' "${BOLD}Memento 执行机${RST}  ${DIM}$SERVER · $(uname -n)${RST}"

[ "$(uname -s)" = "Linux" ] || fail "这个脚本只用于 Linux；Mac / Windows 请装桌面客户端"
command -v systemctl >/dev/null 2>&1 || fail "需要 systemd（用户服务负责开机自启）"
MISSING=()
for c in git curl tar; do command -v "$c" >/dev/null 2>&1 || MISSING+=("$c"); done
if [ ${#MISSING[@]} -gt 0 ]; then
    SUDO=""; [ "$(id -u)" = "0" ] || SUDO="sudo -n"
    PM=""
    for m in apt-get dnf yum zypper pacman; do command -v "$m" >/dev/null 2>&1 && { PM="$m"; break; }; done
    if [ -n "$PM" ] && { [ -z "$SUDO" ] || sudo -n true 2>/dev/null; }; then
        say "安装缺少的 ${MISSING[*]}（$PM）"
        case "$PM" in
            apt-get) $SUDO apt-get update -qq </dev/null >/dev/null && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${MISSING[@]}" </dev/null >/dev/null ;;
            dnf|yum) $SUDO "$PM" install -y -q "${MISSING[@]}" </dev/null >/dev/null ;;
            zypper) $SUDO zypper -n install "${MISSING[@]}" </dev/null >/dev/null ;;
            pacman) $SUDO pacman -S --noconfirm --needed "${MISSING[@]}" </dev/null >/dev/null ;;
        esac || true
    fi
    for c in "${MISSING[@]}"; do
        command -v "$c" >/dev/null 2>&1 || fail "缺少 $c：sudo apt install -y $c 或 sudo dnf install -y $c 后重跑"
    done
fi
[ "$(id -u)" != "0" ] || say "${DIM}正在用 root 运行；建议换成普通用户，智能体以这个用户的身份改代码${RST}"

BASE="$HOME/.memento"
SRC="$BASE/src/memento"
RUNTIME="$BASE/runtime/node"
LOGS="$BASE/logs"
mkdir -p "$BASE/src" "$BASE/runtime" "$LOGS" "$HOME/.local/bin"

# ── Node.js ≥ 22.18 ───────────────────────────────────────────
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
NODE=""
if command -v node >/dev/null 2>&1 && version_ge "$(node -v | sed 's/^v//')" "$NODE_MIN"; then
    NODE="$(command -v node)"
elif [ -x "$RUNTIME/bin/node" ] && version_ge "$("$RUNTIME/bin/node" -v | sed 's/^v//')" "$NODE_MIN"; then
    NODE="$RUNTIME/bin/node"
else
    case "$(uname -m)" in
        x86_64|amd64) ARCH=x64 ;;
        aarch64|arm64) ARCH=arm64 ;;
        *) fail "不支持的 CPU 架构：$(uname -m)" ;;
    esac
    say "下载 Node.js 22（系统没有 ≥ $NODE_MIN 的版本，装到 $RUNTIME，不动系统环境）"
    got=""
    for mirror in ${NODE_MIRROR:-} https://nodejs.org/dist https://npmmirror.com/mirrors/node; do
        ver="$(curl -fsSL --max-time 20 "$mirror/index.json" 2>/dev/null | grep -o '"version":"v22\.[0-9]*\.[0-9]*"' | head -1 | cut -d'"' -f4)" || true
        [ -n "$ver" ] || continue
        tmp="$(mktemp -d)"
        if curl -fsSL --max-time 300 "$mirror/$ver/node-$ver-linux-$ARCH.tar.gz" | tar -xz -C "$tmp" --strip-components=1; then
            rm -rf "$RUNTIME"; mv "$tmp" "$RUNTIME"; got="$ver"; break
        fi
        rm -rf "$tmp"
    done
    [ -n "$got" ] || fail "Node.js 下载失败；可设置 NODE_MIRROR 换下载源，或自己装 Node.js $NODE_MIN+ 后重跑"
    NODE="$RUNTIME/bin/node"
fi
export PATH="$(dirname "$NODE"):$HOME/.local/bin:$PATH"
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
ok "Node.js $(node -v)（$NODE）"

# ── Source: daemon runs from a shallow clone ──────────────────
if [ -d "$SRC/.git" ]; then
    say "更新守护进程源码（$REF）"
    git -C "$SRC" fetch --depth 1 --quiet origin "$REF" </dev/null
    git -C "$SRC" reset --hard --quiet FETCH_HEAD
else
    say "下载守护进程源码（$REF）"
    rm -rf "$SRC"
    git clone --depth 1 --branch "$REF" --quiet "$REPO_URL" "$SRC" </dev/null
fi
ok "源码 $(git -C "$SRC" rev-parse --short HEAD)"

say "安装依赖并构建守护进程和记忆 MCP 服务（首次约 1～3 分钟）"
# The daemon registers packages/mcp with Claude Code / Codex / Antigravity (mcp-register.ts)
(cd "$SRC" && npm ci --no-audit --no-fund --loglevel=error -w @memento/daemon -w @memento/core -w @memento/mcp --include-workspace-root </dev/null >/dev/null \
    && npm run build -w @memento/daemon -w @memento/mcp </dev/null >/dev/null)
ok "守护进程和记忆 MCP 服务已构建"

CLI="$SRC/packages/daemon/dist/cli.js"
"$NODE" "$CLI" login "$TOKEN" "$SERVER" </dev/null >/dev/null
ok "已绑定 $SERVER"

# Agents and the node above must be on the PATH agents' login shells see.
MARK="# memento executor PATH"
for rc in "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$rc" ] || [ "$rc" = "$HOME/.bashrc" ] || continue
    [ -f "$rc" ] && sed -i "/$MARK/d" "$rc"
    printf 'export PATH="%s:$HOME/.local/bin:$PATH"  %s\n' "$(dirname "$NODE")" "$MARK" >> "$rc"
done

# ── Agent CLIs (official installers) ──────────────────────────
has() { command -v "$1" >/dev/null 2>&1 || [ -x "$HOME/.local/bin/$1" ]; }
IFS=',' read -r -a WANT <<< "$AGENTS"
for a in ${WANT[@]+"${WANT[@]}"}; do
    a="$(echo "$a" | tr -d ' ')"
    case "$a" in
        "") ;;
        claude)
            if has claude; then ok "Claude Code 已安装"; else
                say "安装 Claude Code（官方安装脚本）"; curl -fsSL https://claude.ai/install.sh | bash >"$LOGS/install-claude.log" 2>&1 && ok "Claude Code 已安装" || say "${RED}Claude Code 安装失败，见 $LOGS/install-claude.log${RST}"
            fi ;;
        codex)
            if has codex; then ok "Codex 已安装"; else
                say "安装 Codex（npm @openai/codex）"
                npm install -g --prefix "$HOME/.local" --no-audit --no-fund --loglevel=error @openai/codex </dev/null >"$LOGS/install-codex.log" 2>&1 && ok "Codex 已安装" || say "${RED}Codex 安装失败，见 $LOGS/install-codex.log${RST}"
            fi ;;
        agy|antigravity)
            if has agy; then ok "Antigravity CLI 已安装"; else
                say "安装 Antigravity CLI（官方安装脚本）"; curl -fsSL https://antigravity.google/cli/install.sh | bash >"$LOGS/install-agy.log" 2>&1 && ok "Antigravity CLI 已安装" || say "${RED}Antigravity CLI 安装失败，见 $LOGS/install-agy.log${RST}"
            fi ;;
        *) say "${DIM}跳过不认识的智能体：$a（可选 claude, codex, agy）${RST}" ;;
    esac
done

# ── systemd user service ──────────────────────────────────────
FLAGS=()
[ "$LOW_PRIORITY" = "1" ] && FLAGS+=(--low-priority)
WAS_RUNNING=0
systemctl --user is-active --quiet memento-daemon.service 2>/dev/null && WAS_RUNNING=1
"$NODE" "$CLI" install-service ${FLAGS[@]+"${FLAGS[@]}"} </dev/null
# enable --now leaves an already running daemon on the old build
[ "$WAS_RUNNING" = "1" ] && systemctl --user restart memento-daemon.service </dev/null
ok "守护进程已注册为开机自启的用户服务$([ "$WAS_RUNNING" = "1" ] && echo "，已重启到新版本")"

cat <<EOF

${BOLD}完成。${RST}还差一步：智能体要用你自己的账号登录一次。
最省事：网页「设备」页这台机器那一行点「智能体登录」，打开链接登录、把验证码贴回页面即可。
也可以在这台机器的终端里登录：
  claude auth login   → 复制链接到本地浏览器打开，把验证码贴回
  codex login --device-auth   （先在 ChatGPT 安全设置里打开设备码登录）
  agy             → 按提示在本地浏览器打开链接，把验证码贴回

然后在网页或手机上提问时：设备选 $(uname -n)，「代码在」选你的 Mac / Windows，
智能体在这里跑，改动自动带回那台电脑的项目（冲突时放到 memento/ 开头的分支）。

  状态：node $CLI status
  日志：journalctl --user-unit memento-daemon -f
  升级：重跑这条命令
EOF
