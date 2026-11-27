# 内嵌 Postgres 与 pgvector（单安装包用，docs/ts-server-migration.md P0 / P7）

npm 的 `embedded-postgres`（PG16，和线上同一大版本）不带 pgvector，这里按平台自己编译，CI（.github/workflows/embedded-pg.yml）
在 Mac（Apple 芯片 / Intel）、Linux（x64 / arm64）、Windows x64 上编译并在内嵌库里实际加载验证，产物作为 Actions artifact。

- `build-pgvector.sh`：Mac 用 Homebrew 的 postgresql@16 头文件；Linux 在 Rocky Linux 8 容器里编（glibc 2.28，新旧发行版都能加载；Debian bullseye 2026 年已归档、安全源 404）。
- `build-pgvector.ps1`：Windows 用 PostgreSQL 16 的头文件，pgvector 官方的 `nmake /F Makefile.win`。
- `verify.mjs`：把编好的扩展放进内嵌库的 lib/postgresql 和 share/postgresql/extension，UTF8 初始化（默认 SQL_ASCII 时中文进不了全文索引），
  建 vector 列 + HNSW 索引 + 中文 tsvector，查询结果对了才算通过。
