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
  # Old glibc on purpose (Rocky Linux 8: 2.28, maintained until 2029): a library built against a newer one won't
  # load on older distributions. (Debian bullseye went to the archive in 2026 and its security mirror 404s.)
  docker run --rm -v "$src:/src" -w /src rockylinux:8 bash -euc '
    dnf -q -y install "https://download.postgresql.org/pub/repos/yum/reporpms/EL-8-$(uname -m)/pgdg-redhat-repo-latest.noarch.rpm" >/dev/null
    dnf -q -y module disable postgresql >/dev/null
    dnf -q -y install dnf-plugins-core >/dev/null && dnf config-manager --set-enabled powertools
    # The image ships an older libgcc than appstream'"'"'s gcc wants (x86_64 mirrors, 2026-11-27): bring it up first
    dnf -q -y upgrade libgcc libgomp >/dev/null || true
    dnf -q -y install --nobest gcc make redhat-rpm-config postgresql16-devel >/dev/null
    # with_llvm=no: no JIT bitcode (needs clang, and the embedded server has no JIT anyway)
    make PG_CONFIG=/usr/pgsql-16/bin/pg_config OPTFLAGS="" with_llvm=no
    ldd --version | head -1'
  cp "$src/vector.so" "$out/lib/"
fi
cp "$src/vector.control" "$out/extension/"
cp "$src"/sql/vector--*.sql "$out/extension/"
ls -la "$out/lib"
echo "built pgvector $VERSION for $plat"
