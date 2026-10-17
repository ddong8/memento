# 客户端迁移到 TypeScript

目标：客户端和工具链统一成 TypeScript，参考 [Paseo](https://github.com/getpaseo/paseo) 的做法（守护进程 + 多端客户端 + 共享协议包）。服务端和向量服务继续用 Python（语言统一的主要好处——共享类型——从服务端的 OpenAPI 生成即可拿到；向量模型只能跑在 Python 里）。

迁移期间 Flutter 版照常可用，新版功能对齐、验证通过后再切换。

## 目标结构

```
package.json            npm workspaces 根
packages/core           @memento/core：从 OpenAPI 生成的类型、API 客户端、提问 SSE 流、任务事件
packages/daemon         @memento/daemon：本机守护进程（采集、派活执行、画像/技能注入、MCP）
apps/desktop            Electron 桌面端：拉起守护进程，窗口里是网页端界面
apps/mobile             Expo 手机端（iOS / Android）
web                     Next.js 网页端（同时是桌面端的界面）
server、embedding       Python，不动
```

## 阶段

### 阶段 1：共享包与工程基础
- [x] 根目录 npm workspaces；网页镜像改成以仓库根为构建上下文
- [x] `@memento/core`：从服务端 OpenAPI 生成类型（`npm run gen:api`），手写的任务事件、提问流事件类型
- [x] 跨端 API 客户端（openapi-fetch）和提问 SSE 流（断线按 last-event-id 续接、空闲 30 秒判定断线、未送达的发送用同一个 request_id 重试，与 Flutter 版一致）
- [x] CI：core 类型检查与测试、网页类型检查与构建

### 阶段 2：守护进程 + Electron 桌面端
守护进程（移植 Flutter 里的采集端，约 6 千行 Dart）：
- [x] 配置与设备注册（沿用 `~/.memento/collector.json`，老用户无感切换）
- [x] 工具发现、文件监听、脱敏、增量上传
- [x] 画像注入、技能注入
- [x] 派活执行：Claude stream-json / Codex --json 结构化事件、中途插话、独立分支、危险操作 hook
- [x] P2P 媒体服务、开机自启（`memento-daemon install-service`：launchd / systemd / Windows 启动项）
- [x] 本机接口：给桌面端界面查看状态、日志、控制采集（`~/.memento/daemon.json` 里是端口和令牌）
- [x] 与 Flutter 版共存：守护进程写 `~/.memento/collector.pid`，Flutter 桌面版看到它就不再启动自带采集

网页端补齐 Flutter 版已有、网页没有的功能：
- [x] 系统健康、学习效果（`/health`，含检索评测）
- [x] 纠正学习（画像页「刚学到的」）、技能（`/skills`）、待办（日报页）
- [x] 任务过程时间线、中途插话、独立分支开关（问答页）
- [x] 推送设置（个人页）、做梦分层与梦境日记、唤醒沉睡记忆（记忆页「做梦」）
- [x] 本机采集页 `/collector`（只在桌面端显示，通过预加载桥访问守护进程）

Electron 桌面端：
- [x] 主进程在 utilityProcess 里跑守护进程、托盘、预加载桥（`window.mementoDesktop`）
- [x] 登录互通：设备已有 collector token 时窗口自动登录（token-exchange → /auth/handoff）；在窗口里登录后自动取 collector token 启动采集
- [x] 自动更新（electron-updater，GitHub Releases）、CI 打包 macOS（dmg/zip，ad-hoc 签名固定 designated requirement）/ Windows（NSIS）/ Linux（AppImage），与 Flutter 版同一个 tag 发布
- [x] 与 Flutter 桌面版共存：检测到旧版在运行就不启动第二份采集（`MEMENTO_DAEMON_FORCE=1` 可强制）；应用名统一为「Memento」

### 阶段 3：MCP 服务改 TS
- [x] 用官方 TS MCP SDK 移植 `mcp_server` 的远程模式：17 个工具、5 个资源全部对齐（`packages/mcp`，顺带修好了 Python 版里报错的 `memory_project_map`）
- [x] 分发方式：随桌面端提供（`ELECTRON_RUN_AS_NODE=1 "<Memento>" ".../mcp.mjs"`），「本机采集」页给出 Claude Code / Codex / 其他工具的配置一键复制；也可 `memento-mcp` 独立运行
- [x] 直连数据库模式已删除（没有在用的地方：服务端那段挂载从未生效）

### 阶段 4：Expo 手机端
- [x] ~~原生写的 5 个页面（提问、记忆、设备、日报待办、我的）~~：2026-09-30 用户反馈和桌面版差距太大，改成和桌面版一样加载网页（react-native-webview）。原生只保留登录和钥匙串里的令牌：每次启动刷新令牌，再通过网页的 `/auth/handoff` 交给网页；网页跳到 `/auth/login`（退出或令牌失效）时回到原生登录；外站链接用系统浏览器打开；状态栏颜色跟随网页的皮肤和主题；UA 带 `MementoMobile/<版本>`。网页更新后手机上直接生效，不用重装
- [x] Android 由 CI 构建 APK（`expo prebuild` + Gradle，随 v* tag 发布）
- [x] iOS 用免费 Apple ID 在装了 Xcode 的 Mac 上装到真机（签名 7 天有效，过期重跑最后一条）：`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer && sudo xcodebuild -license accept`，Xcode 里登录 Apple ID 并生成 Apple Development 证书，手机连线信任、打开开发者模式；然后**在 `apps/mobile` 目录下**（在仓库根目录运行会找错入口）`npx expo prebuild --platform ios` → `npx expo run:ios --device --configuration Release`
- [x] 图标统一用网页的 Memento 标志（`scripts/brand-icons.mjs` 生成；Flutter 版用的是 Flutter 默认图标）
- [ ] 真机/模拟器上走一遍（本机没有模拟器和 Android SDK，目前只验证了类型检查和两端 JS 打包）

### 收尾
- [x] 清理不再使用的代码（2026-09-29 用户确认）：删除旧 Python 采集器 `collector/`、打包壳 `memento_brain/` 和它的架构文档；Python MCP 去掉直连数据库模式（远程模式保留，现有 `memento-memory` 配置照常可用）；服务端删掉从未生效的 `/mcp` 挂载和 PyPI 采集器版本接口，镜像不再安装 mcp_server；管理页去掉「更新采集器」按钮（新旧采集都不处理这个命令）；CI 和 PyPI 发布只保留 memento-brain-memory；自建安装脚本改为从仓库构建 Node 守护进程（没有 Node 就提示装桌面端）
- [x] 再次清理冗余（2026-10-17）：服务端删掉没有任何客户端调用的接口（分片/表格上传、HTTP 轮询派活、文档原文与历史、记忆压缩与重置、按采集器 id 发命令、微信 OAuth 登录等）和它们留下的辅助函数、未使用的导入与依赖（alembic、passlib）；P2P 媒体直连只有已下线的 Flutter 手机端用过，网页端一直走服务器中转，守护进程不再在公网 IPv6 上开媒体端口
- [ ] Flutter 版下线说明

## 进度记录

| 日期 | 阶段 | 内容 |
|---|---|---|
| 2026-09-28 | — | 定下方案 |
| 2026-09-28 | 1 | workspaces + @memento/core（9 个测试）；网页镜像按新方式在本地模拟构建并启动验证 |
| 2026-09-29 | 1 | 修正：上一次提交漏了大部分文件；根 lockfile 以网页原 lockfile 为底重建，补齐 linux 原生包（lightningcss、tailwind oxide） |
| 2026-09-29 | 发版 | v1.0.63：Flutter 三端照常发布，同时发布 Memento Desktop（mac dmg/zip、Windows 安装包、Linux AppImage，含自动更新元数据）和 Memento Mobile Android APK |
| 2026-09-29 | 4 | apps/mobile（Expo SDK 57）：expo-doctor 21/21 通过，Android/iOS JS 打包通过；整个仓库只保留一份 React 19.2.3 |
| 2026-09-30 | 4 | iOS 真机构建通过后 `expo run:ios` 启动开发服务器时崩溃（`Cannot find module 'expo-router/_ctx-shared'`）：expo-router 被 npm 留在 apps/mobile/node_modules，根目录的 @expo/cli 找不到它。原因是它的可选同伴依赖 react-server-dom-webpack 要求 react-dom ≥ 19.2.4，和根目录钉住的 19.2.3 冲突。修复：根目录声明 expo-router、用 overrides 把 reanimated/worklets/gesture-handler 对齐 SDK 57（原来自动装成了 4.7/0.13/3.3），expo 升到 57.0.26；CI 加了解析检查 |
| 2026-09-30 | 4 | iOS 27 真机打开即闪退（`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`，SIGTRAP）：用 Xcode 27 / iOS 27 SDK 构建的应用必须采用 UIScene 生命周期，SDK 57 模板还是 AppDelegate 自己管窗口。修复：装 expo-build-properties，打开官方的 `ios.enableSceneSupport`（要求 expo ≥ 57.0.23；升级到 SDK 58 后可以去掉） |
| 2026-09-30 | 4 | 手机端改为加载网页（同桌面版），去掉原生页面和不再使用的依赖（@memento/core、expo-clipboard、expo-crypto、react-native-marked） |
| 2026-09-29 | 3 | @memento/mcp：6 个测试（含内存传输的 MCP 客户端、令牌轮换、按前缀关待办）；stdio 对线上只读调用验证通过 |
| 2026-09-29 | 2 | Electron 桌面端 apps/desktop：本机打包 mac 版并冒烟通过（守护进程、上传、任务、退出清理） |
| 2026-09-29 | 2 | 网页端补齐 Flutter 独有功能：健康、技能、纠正、待办、推送、做梦、任务时间线/插话/独立分支 |
| 2026-09-29 | 2 | @memento/daemon：采集端全部移植（42 个测试，含假 Claude 端到端：结构化步骤、中途插话、worktree）；对本地模拟服务器冒烟通过 |
