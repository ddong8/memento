# Memento Mobile (Flutter 客户端)

Memento 的跨平台移动端客户端（iOS & Android），采用 **Flutter 3+** 与 **Aurora Dark** 设计系统开发。

---

## ✨ 核心特性

- **跨设备终端控制 (Ask AI)**：在手机端向连线的 Mac / PC 下发 Shell 命令，实时接收标准输出与错误日志（带实时状态药丸、代码块高亮及一键复制）。
- **AI 深度思考折叠**：完整解析并流式呈现大模型的 Thinking 思考过程。
- **全局记忆检索 (Memory Search)**：支持语义检索（BGE-M3 向量嵌入）与传统全文检索，查看跨设备代码片段与文档。
- **在线设备看板 (Devices)**：实时监控在线电脑的连接状态、IP 地址及心跳活跃度。
- **每日工作总结 (Daily Summary)**：日历式查看 AI 归纳的每日开发进度与总结。
- **自托管节点配置**：支持自由输入自建服务器地址（默认 `https://mem.ihasy.com` 或私网 `http://192.168.x.x:8001`）。

---

## 🚀 快速上手与运行

### 1. 安装 Flutter SDK（若尚未安装）

在 Mac 终端中通过 Homebrew 一键安装：
```bash
brew install --cask flutter
```
安装完成后执行环境自检：
```bash
flutter doctor
```

### 2. 获取依赖

在 `mobile/` 目录下执行：
```bash
cd mobile
flutter pub get
```

---

## 📱 安卓客户端构建 (.apk)

安卓打包**完全不需要任何开发者账号，生成的 APK 可在任意安卓手机上直接安装**：

### 打包 Release APK
```bash
flutter build apk --release
```
- **输出安装包路径**：
  `mobile/build/app/outputs/flutter-apk/app-release.apk`
- **安装方法**：将生成的 `app-release.apk` 通过微信、QQ 或网盘发送到安卓手机，点击即可直接安装。

---

## 🍏 苹果 iOS 客户端安装（无付费开发者账号）

无需支付每年 $99 的苹果开发者账号费用，使用你平时的**普通 Apple ID 免费自签**即可安装到真机：

### 步骤指引：
1. **安装 Xcode**：从 Mac App Store 下载安装 Xcode。
2. **打开 iOS 工程**：
   ```bash
   cd mobile
   open ios/Runner.xcworkspace
   ```
3. **配置免费证书**：
   - 在 Xcode 左侧选中 `Runner` -> 进入 `Signing & Capabilities` 标签。
   - 勾选 `Automatically manage signing`。
   - 在 `Team` 下拉菜单中点击 `Add Account...`，登录你的普通个人 Apple ID。
   - 将 `Bundle Identifier`（如 `com.ihasy.memento`）改为唯一的标识（例如加你的名字拼音 `com.ihasy.memento.myname`）。
4. **连接真机运行**：
   - 用数据线将 iPhone 连接至 Mac。
   - iPhone 上打开：`设置 -> 隐私与安全性 -> 开发者模式` 并开启（iOS 16+ 需要重启手机）。
   - 在 Xcode 顶部设备栏选中你的 iPhone，点击 **运行按钮（或按 Command + R）**。
   - 应用将自动编译并安装到你的 iPhone 上。
5. **首次信任**：
   - 手机安装后首次打开若提示“不受信任的开发者”，前往 iPhone `设置 -> 通用 -> VPN 与设备管理`，点击你的 Apple ID 信任即可。

> **免越狱长久使用建议**：
> 免费个人证书签名的 App 有 7 天有效期。若不想每 7 天连一次电脑，可搭配免费开源工具 **SideStore** 或 **AltStore**，利用局域网 WiFi 在后台自动为你刷新这 7 天签名，实现永久使用。
