# Memento Project - Agent Guidelines & Architecture Rules

## 桌面端发布与自动更新（铁律）

### 1. 两条更新通道
- 桌面端（Electron）用 electron-updater 的 generic 通道 `<服务器>/api/system/update`：`latest*.yml` 和安装包由 `server/server/api/updates.py` 的 `generic_updater_file` 提供（优先 `data/updates/` 里的本地文件，否则转到 GitHub Release）。
  - macOS：下载 `.zip` 后由 `apps/desktop/src/main.ts` 用 osascript 原地替换 `/Applications/Memento.app`。没有 Apple 开发者签名时 Squirrel 的 `quitAndInstall` 会静默失败，只作兜底。
  - Windows：NSIS 安装包；Linux：AppImage。
- 网页侧边栏的新版本提示走 `/api/system/update/check`，读 `data/updates/version.json`（或 GitHub Release）。这里 Windows、macOS 必须是 `.zip`，Linux 是 `.tar.gz` 或 `.deb`。

### 2. 发布元数据"三位一体"强制校验
以下三处必须完全一致，严禁人工猜测或填充假数据：
1. `data/updates/version.json` 中的 `asset_name`、`size`（精确到字节）、`sha256`。
2. GitHub Release 实际上传的 Release Assets 文件名与字节大小。
3. `server/server/api/updates.py` 的平台匹配优先级：Windows 首选 `.zip`（备选 `.exe`/`.msi`），macOS 首选 `.zip`（备选 `.dmg`），Linux 首选 `.tar.gz`。

`.github/workflows/desktop-release.yml` 发布后自动生成 version.json，并用 `scripts/verify_release_metadata.py --github-tag <tag>` 校验通过才提交。手动改 version.json 后也必须跑一遍这个脚本。

### 3. 版本号
- 发版 tag 必须等于 `apps/desktop/package.json` 的 `version`：应用运行时报告的版本和 `latest*.yml` 都取自它，而 version.json 的版本取自 tag。两者不一致时，网页会对已是最新版的客户端反复提示更新。
