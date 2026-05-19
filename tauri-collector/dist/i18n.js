// Minimal vanilla-JS i18n.
//
// Each language file is a flat key→string dict. The active language is
// picked from navigator.language (falling back to en-US). DOM elements
// opt in via `data-i18n="key"` (textContent) or
// `data-i18n-attr="placeholder:key"` (attribute).

const STRINGS = {
  "en-US": {
    "status.running": "running",
    "status.idle": "idle",
    "status.error": "error",
    "tab.server": "Server",
    "tab.dashboard": "Dashboard",
    "tab.tools": "Tools",
    "tab.logs": "Logs",
    "tab.about": "About",
    "warn.legacy.title": "Legacy install detected.",
    "warn.legacy.body": "A pip-installed collector is registered as a system service. Run",
    "warn.legacy.after": "before using this app to avoid double-syncing.",
    "warn.sidecar.title": "Sidecar binary not bundled.",
    "warn.sidecar.body": "The frozen collector hasn't been built for this platform yet. From a terminal, run",
    "warn.sidecar.after": "and restart this app.",
    "field.serverUrl": "Server URL",
    "field.serverUrl.placeholder": "https://mem.ihasy.com",
    "field.serverUrl.hint": "Paste the Memento URL you use in the browser. If your install uses separate ports (e.g. http://host:3001 for the web UI), the app will auto-route the collector to the API port (8001).",
    "field.token": "Collector Token",
    "field.token.placeholder": "paste an existing token",
    "field.token.hint": "Already have a token (e.g. someone shared one)? Paste it here instead of signing in.",
    "field.obsidian": "Obsidian Vault Path",
    "field.obsidian.optional": "(optional)",
    "field.obsidian.placeholder": "leave empty to disable Obsidian sync",
    "btn.browse": "Browse…",
    "toggle.autoStart": "Auto-start collector when the app launches",
    "toggle.autoLaunch": "Launch Memento at system startup",
    "btn.save": "Save",
    "btn.start": "Start collector",
    "btn.stop": "Stop",
    "tools.hint": "Disable any tool you don't want the collector to watch. Changes take effect after the daemon is restarted.",
    "btn.saveTools": "Save",
    "btn.clear": "Clear",
    "toggle.autoscroll": "Auto-scroll",
    "about.title": "Memento",
    "about.desc": "Cross-device memory for your AI coding tools — collects, indexes and surfaces conversations + memory files from Claude Code, Codex, Cursor, Obsidian, Antigravity, Hermes and OpenClaw.",
    "about.version": "Desktop version",
    "about.daemon": "Collector daemon",
    "about.daemonChecking": "checking…",
    "about.project": "Project",
    "about.license": "License",
    "dashboard.empty": "Configure the server URL on the Server tab, then come back here to see the dashboard.",
    "dashboard.toServer": "⚙ Go to Server settings",
    "dashboard.back": "⚙ Settings",
    "auth.account": "Account",
    "auth.advanced": "Advanced",
    "auth.email": "Email",
    "auth.password": "Password",
    "auth.invite": "Invite code (optional)",
    "auth.register": "Register",
    "auth.login": "Sign in",
    "auth.hint": "Sign in or register and syncing starts automatically — nothing else to set up.",
    "auth.working": "Working…",
    "auth.needUrl": "Enter the Server URL first.",
    "auth.needCreds": "Email and password are required.",
    "auth.okRegistered": "Registered — starting to sync…",
    "auth.okLoggedIn": "Signed in — starting to sync…",
    "update.text": "New version",
    "update.available": "available.",
    "update.upToDate": "You're on the latest version.",
    "update.btn": "Install",
    "save.ok": "Saved.",
    "save.mcpConfigured": "MCP configured for:",
    "msg.startSent": "Collector starting…",
    "msg.stopped": "Stopped.",
    "msg.pickRecipient": "Pick a recipient",
  },

  "zh-CN": {
    "status.running": "运行中",
    "status.idle": "空闲",
    "status.error": "错误",
    "tab.server": "服务器",
    "tab.dashboard": "仪表板",
    "tab.tools": "工具",
    "tab.logs": "日志",
    "tab.about": "关于",
    "warn.legacy.title": "检测到旧安装。",
    "warn.legacy.body": "系统服务里注册了 pip 安装的 collector,请先运行",
    "warn.legacy.after": "再使用本 app,避免重复同步。",
    "warn.sidecar.title": "Sidecar 未打包。",
    "warn.sidecar.body": "该平台的冻结 collector 还没构建出来,请在终端执行",
    "warn.sidecar.after": "然后重启 app。",
    "field.serverUrl": "服务器地址",
    "field.serverUrl.placeholder": "https://mem.ihasy.com",
    "field.serverUrl.hint": "粘贴你浏览器里访问 Memento 的 URL。如果是分端口部署(比如 http://host:3001),app 会自动把 collector 转到 API 端口(8001)。",
    "field.token": "Collector Token",
    "field.token.placeholder": "粘贴已有 token",
    "field.token.hint": "已经有 token(比如别人发给你的)?可以直接填这里,不用登录。",
    "field.obsidian": "Obsidian 仓库路径",
    "field.obsidian.optional": "(可选)",
    "field.obsidian.placeholder": "留空则禁用 Obsidian 同步",
    "btn.browse": "浏览…",
    "toggle.autoStart": "启动 app 时自动跑 collector",
    "toggle.autoLaunch": "开机自动启动 Memento",
    "btn.save": "保存",
    "btn.start": "启动 collector",
    "btn.stop": "停止",
    "tools.hint": "勾掉不想被采集的工具。修改在 collector 重启后生效。",
    "btn.saveTools": "保存",
    "btn.clear": "清空",
    "toggle.autoscroll": "自动滚动",
    "about.title": "Memento",
    "about.desc": "你所有 AI 编程工具的跨设备记忆 —— 采集、索引并展示 Claude Code、Codex、Cursor、Obsidian、Antigravity、Hermes、OpenClaw 的对话和记忆文件。",
    "about.version": "桌面端版本",
    "about.daemon": "Collector 守护进程",
    "about.daemonChecking": "检查中…",
    "about.project": "项目",
    "about.license": "开源协议",
    "dashboard.empty": "先在 Server 标签里配好服务器地址,再回到这里查看仪表板。",
    "dashboard.toServer": "⚙ 去 Server 配置",
    "dashboard.back": "⚙ 设置",
    "auth.account": "账号",
    "auth.advanced": "高级",
    "auth.email": "邮箱",
    "auth.password": "密码",
    "auth.invite": "邀请码(可选)",
    "auth.register": "注册",
    "auth.login": "登录",
    "auth.hint": "登录或注册后自动开始采集,无需其它设置。",
    "auth.working": "处理中…",
    "auth.needUrl": "请先填服务器地址。",
    "auth.needCreds": "邮箱和密码不能为空。",
    "auth.okRegistered": "注册成功,开始采集…",
    "auth.okLoggedIn": "登录成功,开始采集…",
    "update.text": "新版本",
    "update.available": "可用。",
    "update.upToDate": "已是最新版本。",
    "update.btn": "安装",
    "save.ok": "已保存。",
    "save.mcpConfigured": "MCP 已配置:",
    "msg.startSent": "Collector 启动中…",
    "msg.stopped": "已停止。",
    "msg.pickRecipient": "请选择接收人",
  },
};

function pickLocale() {
  const nav = (navigator.language || "en-US").toLowerCase();
  if (nav.startsWith("zh")) return "zh-CN";
  return "en-US";
}

const ACTIVE = pickLocale();

export function t(key) {
  return STRINGS[ACTIVE][key] ?? STRINGS["en-US"][key] ?? key;
}

export function apply() {
  // Set <html lang> for ARIA + browser hints.
  document.documentElement.setAttribute("lang", ACTIVE);

  // Text content: <span data-i18n="key">…</span>
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key);
  });
  // Attributes: data-i18n-attr="placeholder:key;title:other_key"
  document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    const spec = el.getAttribute("data-i18n-attr") || "";
    for (const pair of spec.split(";")) {
      const [attr, key] = pair.split(":").map((x) => x.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });
}

export const locale = ACTIVE;
