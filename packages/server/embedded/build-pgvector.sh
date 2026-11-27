#!/usr/bin/env bash
# Build pgvector for embedded Postgres 16 on macOS or Linux. Output: out/<platform>/{lib,extension}/...
set -euo pipefail
VERSION="${PGVECTOR_VERSION:-0.8.1}"
here="$(cd "$(dirname "$0")" && pwd)"
os="$(uname -s)"; arch="$(uname -m)"
case "$os-$arch" in
  Darwin-arm64) plat=darwin-arm64 ;;
  Darwin-x86_64) plat=darwin-x64 ;;
  Linux-x86_64) plat=linux-x64 ;;
  Linux-aarch64) plat=linux-arm64 ;;
  *) echo "unsupported $os-$arch"; exit 1 ;;
esac
out="$here/out/$plat"; rm -rf "$out"; mkdir -p "$out/lib" "$out/extension"
work="$(mktemp -d)"
curl -fsSL "https://github.com/pgvector/pgvector/archive/refs/tags/v${VERSION}.tar.gz" | tar xz -C "$work"
src="$work/pgvector-${VERSION}"
if [ "$os" = Darwin ]; then
  brew list postgresql@16 >/dev/null 2>&1 || brew install postgresql@16
  # OPTFLAGS="": no -march=native, the binary runs on any Mac of this architecture
  make -C "$src" PG_CONFIG="$(brew --prefix postgresql@16)/bin/pg_config" OPTFLAGS=""
  cp "$src/vector.dylib" "$out/lib/"
else
  # Old glibc on purpose: a library built against a newer one won't load on older distributions
  docker run --rm -v "$src:/src" -w /src debian:bullseye bash -euc '
    apt-get update -qq && apt-get install -y -qq curl ca-certificates gnupg build-essential >/dev/null
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg
    echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bullseye-pgdg main" > /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq && apt-get install -y -qq postgresql-server-dev-16 >/dev/null
    make PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config OPTFLAGS=""
    ldd --version | head -1'
  cp "$src/vector.so" "$out/lib/"
fi
cp "$src/vector.control" "$out/extension/"
cp "$src"/sql/vector--*.sql "$out/extension/"
ls -la "$out/lib"
echo "built pgvector $VERSION for $plat"
