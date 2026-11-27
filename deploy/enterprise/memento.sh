#!/usr/bin/env bash
# memento 企业部署管理脚本（docker compose）。说明见 docs/enterprise.md。
#
#   ./memento.sh init --domain memento.example.com   生成 .env（随机密码与密钥、当前发布的镜像版本）
#   ./memento.sh init --personal                     单机模式：只给自己用，http://localhost:8770（见 personal.env）
#   ./memento.sh up                                  拉取镜像并启动（或应用 .env 的修改）
#   ./memento.sh status                              各服务状态和健康检查
#   ./memento.sh logs [服务]                          查看日志
#   ./memento.sh backup                              备份数据库、对象存储和 .env 到 backups/
#   ./memento.sh restore <备份目录>                   从备份恢复（先停服务，恢复后启动）
#   ./memento.sh upgrade [--server-tag X --web-tag Y] 先备份再升级到指定版本（默认仓库里当前发布的版本）
#   ./memento.sh bundle                              把所有镜像打成一个离线包（无外网的服务器用）
#   ./memento.sh load <离线包>                         在无外网的服务器上导入离线包
set -euo pipefail

cd "$(dirname "$0")"
DC=(docker compose)

# 单机模式（.env 里 DEPLOY_MODE=personal）：镜像都是公开的，docker 改用不带凭据存储的独立配置。
# Docker Desktop 的凭据助手（docker-credential-desktop）会卡在钥匙串上，拉取一直没有输出（2026-11-27 实测卡了一小时）
if grep -q '^DEPLOY_MODE=personal$' .env 2>/dev/null && [ -z "${DOCKER_CONFIG:-}" ] && command -v docker >/dev/null 2>&1; then
  docker_host="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)}"
  if [ -n "$docker_host" ]; then
    mkdir -p docker-config
    printf '{"cliPluginsExtraDirs":["%s","/Applications/Docker.app/Contents/Resources/cli-plugins","/usr/local/lib/docker/cli-plugins","/opt/homebrew/lib/docker/cli-plugins","/usr/libexec/docker/cli-plugins","/usr/lib/docker/cli-plugins"]}\n' "$HOME/.docker/cli-plugins" > docker-config/config.json
    export DOCKER_CONFIG="$PWD/docker-config" DOCKER_HOST="$docker_host"
  fi
fi
KUSTOMIZATION="../k8s/kustomization.yaml"

say()  { printf '· %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "缺少 $1，请先安装"; }

rand() { # url-safe random secret
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "${1:-32}"; else head -c "${1:-32}" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# The image versions production runs (CI writes them into the k8s kustomization after its checks pass)
released_tag() { # $1 = server | web
  [ -f "$KUSTOMIZATION" ] || return 0
  awk -v want="memento-$1" '
    $0 ~ "name: .*" want "$" { hit=1; next }
    hit && /newTag:/ { print $2; exit }
  ' "$KUSTOMIZATION"
}

set_env() { # set_env KEY VALUE (in .env)
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -q "^${key}=" .env; then
    # Through ENVIRON, not -v: awk -v would eat the backslashes of a regex value
    K="$key" V="$value" awk 'BEGIN{FS="="} $1==ENVIRON["K"] {print ENVIRON["K"] "=" ENVIRON["V"]; next} {print}' .env > "$tmp"
  else
    cat .env > "$tmp"; printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > .env; rm -f "$tmp"
}

get_env() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }

cmd_init() {
  local domain="" force=0 personal=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) domain="${2:-}"; shift 2 ;;
      --personal) personal=1; shift ;;
      --force) force=1; shift ;;
      *) die "不认识的参数 $1" ;;
    esac
  done
  [ -f .env ] && [ "$force" = 0 ] && die ".env 已存在（里面有已生成的密码）；确实要重新生成请加 --force"
  cp .env.example .env
  chmod 600 .env
  set_env POSTGRES_PASSWORD "$(rand 24)"
  set_env MINIO_ROOT_PASSWORD "$(rand 24)"
  set_env MEMENTO_SECRET_KEY "$(rand 32)"
  set_env MEMENTO_COLLECTOR_TOKEN "$(rand 32)"
  set_env MEMENTO_DATA_KEY "$(rand 32)"
  if [ "$personal" = 1 ]; then
    local key value
    while IFS='=' read -r key value; do
      case "$key" in ''|\#*) continue ;; esac
      set_env "$key" "$value"
    done < personal.env
    ok "已生成单机模式的 .env（只有你能读）"
    say "接下来：./memento.sh up，然后打开 $(get_env MEMENTO_PUBLIC_URL) 注册，第一个注册的就是你（所有者）"
    return 0
  fi
  local st wt
  st="$(released_tag server)"; wt="$(released_tag web)"
  [ -n "$st" ] && set_env MEMENTO_SERVER_TAG "$st"
  [ -n "$wt" ] && set_env MEMENTO_WEB_TAG "$wt"
  if [ -n "$domain" ]; then
    set_env MEMENTO_PUBLIC_URL "https://$domain"
    set_env MEMENTO_SITE "$domain"
    set_env MEMENTO_CORS_ALLOW_ORIGIN_REGEX "^https://$(printf '%s' "$domain" | sed 's/\./\\./g')\$"
  fi
  ok "已生成 .env（只有本机管理员可读）"
  [ -n "$st" ] || say "没读到发布的镜像版本：请在 .env 里填 MEMENTO_SERVER_TAG / MEMENTO_WEB_TAG"
  say "接下来：按需修改 .env（模型、单点登录等），然后执行 ./memento.sh up"
}

cmd_up() {
  need docker
  [ -f .env ] || die "还没有 .env，先运行 ./memento.sh init --domain <域名>"
  "${DC[@]}" pull --ignore-pull-failures || true
  "${DC[@]}" up -d --remove-orphans
  local url; url="$(get_env MEMENTO_PUBLIC_URL)"
  # First start runs the database migrations: wait until the api answers through the entrance
  if command -v curl >/dev/null 2>&1 && [ "${url#http://localhost}" != "$url" ]; then
    say "等服务就绪（第一次启动要建库，约一两分钟）…"
    local i
    for i in $(seq 1 150); do
      curl -fsS "$url/health" 2>/dev/null | grep -q '"ok"' && break
      sleep 2
    done
  fi
  ok "已启动。第一个注册或用企业账号登录的人是所有者（管理员）：$url"
}

cmd_status() {
  "${DC[@]}" ps
  local url; url="$(get_env MEMENTO_PUBLIC_URL)"
  if "${DC[@]}" exec -T api python -c "import urllib.request,sys;sys.stdout.write(urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=5).read().decode())" 2>/dev/null; then
    echo; ok "接口正常（对外地址 $url）"
  else
    die "接口没有响应：./memento.sh logs api 查看原因"
  fi
}

cmd_backup() {
  local dir="backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dir"
  chmod 700 backups "$dir"
  say "备份数据库…"
  "${DC[@]}" exec -T postgres pg_dump -U postgres -Fc memento > "$dir/memento.dump"
  say "备份对象存储…"
  local minio; minio="$("${DC[@]}" ps -q minio)"
  [ -n "$minio" ] || die "对象存储没有在运行"
  docker run --rm --volumes-from "$minio" alpine:3 tar czf - -C /data . > "$dir/minio.tar.gz"
  cp .env "$dir/env"; chmod 600 "$dir/env"
  # A dump that pg_restore can't list is no backup
  "${DC[@]}" exec -T postgres pg_restore --list < "$dir/memento.dump" >/dev/null || die "数据库备份校验失败：$dir/memento.dump"
  ok "备份完成：$dir（$(du -sh "$dir" | cut -f1)）。请定期复制到另一台机器或存储上"
}

cmd_restore() {
  local dir="${1:-}"
  [ -n "$dir" ] && [ -f "$dir/memento.dump" ] || die "用法：./memento.sh restore backups/<时间>"
  printf '将用 %s 覆盖当前数据库和对象存储。输入 yes 继续：' "$dir"
  read -r answer; [ "$answer" = "yes" ] || die "已取消"
  say "先给当前数据做一次备份…"
  cmd_backup
  "${DC[@]}" stop api celery-worker celery-beat web proxy
  say "恢复数据库…"
  "${DC[@]}" exec -T postgres pg_restore -U postgres -d memento --clean --if-exists --no-owner < "$dir/memento.dump"
  if [ -f "$dir/minio.tar.gz" ]; then
    say "恢复对象存储…"
    local minio; minio="$("${DC[@]}" ps -q minio)"
    "${DC[@]}" stop minio
    docker run --rm -i --volumes-from "$minio" alpine:3 sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -r {} + ; tar xzf - -C /data' < "$dir/minio.tar.gz"
  fi
  "${DC[@]}" up -d
  ok "已恢复并启动"
}

cmd_upgrade() {
  local st="" wt=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --server-tag) st="${2:-}"; shift 2 ;;
      --web-tag) wt="${2:-}"; shift 2 ;;
      *) die "不认识的参数 $1" ;;
    esac
  done
  [ -n "$st" ] || st="$(released_tag server)"
  [ -n "$wt" ] || wt="$(released_tag web)"
  [ -n "$st" ] && [ -n "$wt" ] || die "请用 --server-tag / --web-tag 指定版本（或先 git pull 更新本仓库）"
  say "升级前先备份…"
  cmd_backup
  set_env MEMENTO_SERVER_TAG "$st"
  set_env MEMENTO_WEB_TAG "$wt"
  cmd_up
  ok "已升级到 server $st、web $wt。有问题可用 ./memento.sh restore 回到升级前的备份"
}

images() {
  local s w
  s="$(get_env MEMENTO_SERVER_IMAGE)"; s="${s:-ghcr.io/ddong8/memento-server}:$(get_env MEMENTO_SERVER_TAG)"
  w="$(get_env MEMENTO_WEB_IMAGE)"; w="${w:-ghcr.io/ddong8/memento-web}:$(get_env MEMENTO_WEB_TAG)"
  printf '%s\n' "$s" "$w" "${POSTGRES_IMAGE:-pgvector/pgvector:pg16}" "${REDIS_IMAGE:-redis:7-alpine}" \
    "${MINIO_IMAGE:-cgr.dev/chainguard/minio:latest}" "${CADDY_IMAGE:-caddy:2-alpine}" "alpine:3"
}

cmd_bundle() {
  need docker
  [ -f .env ] || die "先运行 ./memento.sh init 确定版本"
  local out; out="memento-images-$(get_env MEMENTO_SERVER_TAG).tar.gz"
  mapfile -t list < <(images)
  for i in "${list[@]}"; do say "拉取 $i"; docker pull "$i" >/dev/null; done
  docker save "${list[@]}" | gzip > "$out"
  ok "离线包：$out（$(du -h "$out" | cut -f1)）。复制到服务器后执行 ./memento.sh load $out"
}

cmd_load() {
  local f="${1:-}"
  [ -f "$f" ] || die "用法：./memento.sh load memento-images-<版本>.tar.gz"
  gunzip -c "$f" | docker load
  ok "已导入；./memento.sh up 启动（离线环境不会再去拉取）"
}

case "${1:-}" in
  init) shift; cmd_init "$@" ;;
  up) cmd_up ;;
  status) cmd_status ;;
  logs) shift; "${DC[@]}" logs -f --tail 200 "$@" ;;
  backup) cmd_backup ;;
  restore) shift; cmd_restore "$@" ;;
  upgrade) shift; cmd_upgrade "$@" ;;
  bundle) cmd_bundle ;;
  load) shift; cmd_load "$@" ;;
  down) "${DC[@]}" down ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
