#!/usr/bin/env bash
# 单机模式一键安装：在这台电脑上用 Docker 跑一份只给自己用的 memento（http://localhost:8770）。
#
#   curl -fsSL https://raw.githubusercontent.com/ddong8/memento/main/deploy/personal.sh | bash
#
# 装到 ~/memento-server（MEMENTO_HOME 可改）。之后的管理都用那里的 ./memento.sh（status / logs / backup / upgrade / down）。
# 已经装过再运行一次 = 更新管理脚本并升级到最新版本（.env 和数据不动）。
set -euo pipefail

REF="${MEMENTO_REF:-main}"
BASE="https://raw.githubusercontent.com/ddong8/memento/${REF}/deploy/enterprise"
HOME_DIR="${MEMENTO_HOME:-$HOME/memento-server}"

say() { printf '· %s\n' "$*"; }
ok()  { printf '✓ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "缺少 curl"
if ! command -v docker >/dev/null 2>&1; then
  die "缺少 Docker：macOS / Windows 装 Docker Desktop（https://www.docker.com/products/docker-desktop/），Linux 装 Docker Engine，然后重新运行"
fi
if ! docker info >/dev/null 2>&1; then
  if [ "$(uname -s)" = Darwin ] && [ -d /Applications/Docker.app ]; then
    say "启动 Docker Desktop…"
    open -a Docker
    for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
  fi
  docker info >/dev/null 2>&1 || die "Docker 没有在运行：先启动 Docker，再重新运行"
fi
docker compose version >/dev/null 2>&1 || die "缺少 docker compose 插件（Docker Desktop 自带；Linux 装 docker-compose-plugin）"

mkdir -p "$HOME_DIR"
cd "$HOME_DIR"
say "下载部署文件到 $HOME_DIR"
for f in docker-compose.yml Caddyfile .env.example personal.env memento.sh; do
  curl -fsSL "$BASE/$f" -o "$f.tmp" && mv "$f.tmp" "$f"
done
chmod +x memento.sh

if [ ! -f .env ]; then
  ./memento.sh init --personal
else
  say "已有 .env，保留原来的密码和数据"
fi
./memento.sh up
ok "打开 $(grep -E '^MEMENTO_PUBLIC_URL=' .env | cut -d= -f2-) 注册账号（第一个注册的就是你）；大模型在「个人设置」里填"
