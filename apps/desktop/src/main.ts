import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, MenuItem, nativeImage, nativeTheme, net, Notification, powerMonitor, protocol, shell, Tray } from "electron";
import { autoUpdater } from "electron-updater";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Lock application display name across macOS menu bar, dock and notification center
app.name = "Memento";
app.setName("Memento");

// Hardware accelerated rendering & smooth composite layers
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

import { loadConfig, saveConfig, type CollectorConfig } from "@memento/daemon";

import { DaemonHost, type DaemonMode } from "./daemon-host";

const UPDATE_CHECK_MS = 6 * 60 * 60_000;
const HIDDEN_ARG = "--hidden";

let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let config: CollectorConfig;
const daemon = new DaemonHost();

/** Where the web app is: the server's origin, or a separate web URL on self-hosted setups. */
const serverOrigin = () => new URL(config.webUrl || config.serverUrl).origin;
/** Whether an IPC call comes from memento's own page rather than another site shown in the window. */
const fromApp = (e: Electron.IpcMainInvokeEvent) => {
  try {
    return new URL(e.senderFrame?.url ?? "").origin === serverOrigin();
  } catch {
    return false;
  }
};

function modeLabel(mode: DaemonMode): string {
  switch (mode) {
    case "running":
      return "采集运行中";
    case "external":
      return "采集运行中（独立守护进程）";
    case "flutter":
      return "采集由旧版 Memento 负责";
    case "starting":
      return "采集启动中…";
    case "no-token":
      return "登录后开始采集";
    case "crashed":
      return "采集异常，正在重启";
    default:
      return "采集已停止";
  }
}

/**
 * Signs the window in with the device's collector token when it has one and
 * the web session is missing (token-exchange -> /auth/handoff).
 */
async function handoffUrl(next: string): Promise<string | undefined> {
  if (!config.token) return undefined;
  try {
    const res = await fetch(`${config.serverUrl}/api/auth/token-exchange`, {
      method: "POST",
      headers: { "X-Collector-Token": config.token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const { access_token } = (await res.json()) as { access_token?: string };
    return access_token ? `${serverOrigin()}/auth/handoff#token=${encodeURIComponent(access_token)}&next=${encodeURIComponent(next)}` : undefined;
  } catch {
    return undefined;
  }
}

/** The web session's JWT, once the user has signed in in the window. */
async function webToken(): Promise<string | null> {
  if (!win || win.isDestroyed()) return null;
  if (!win.webContents.getURL().startsWith(serverOrigin())) return null;
  try {
    return (await win.webContents.executeJavaScript('localStorage.getItem("dr_token")', true)) as string | null;
  } catch {
    return null;
  }
}

/** After a sign-in in the window, give the daemon the user's collector token. */
async function adoptWebLogin(): Promise<void> {
  if (config.token) return;
  const jwt = await webToken();
  if (!jwt) return;
  try {
    const res = await fetch(`${config.serverUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return;
    const me = (await res.json()) as { collector_token?: string };
    if (!me.collector_token) return;
    config = { ...config, token: me.collector_token };
    await saveConfig(config);
    await daemon.start();
  } catch {
    // try again on the next navigation
  }
}

async function adoptWebLoginAndRoute(): Promise<void> {
  await adoptWebLogin();
  if (!win || win.isDestroyed()) return;
  try {
    const route = (await win.webContents.executeJavaScript('localStorage.getItem("memento_last_route")', true)) as string | null;
    if (route && route !== config.lastRoute && route.startsWith("/") && !route.startsWith("/auth/")) {
      config = { ...config, lastRoute: route };
      void saveConfig(config);
    }
  } catch {}
}

async function loadApp(target?: string): Promise<void> {
  if (!win) return;
  const route = target || config.lastRoute || "/";
  const url = (await handoffUrl(route)) ?? `${serverOrigin()}${route}`;
  try {
    await win.loadURL(url);
  } catch {
    await win.loadFile(join(__dirname, "static", "offline.html"), { query: { server: serverOrigin() } });
  }
}

function getWindowIcon(): Electron.NativeImage | undefined {
  if (process.platform === "darwin") return undefined;
  const preferred = join(__dirname, "static", process.platform === "win32" ? "icon.ico" : "icon.png");
  const img = nativeImage.createFromPath(preferred);
  if (!img.isEmpty()) return img;
  const fallback = nativeImage.createFromPath(join(__dirname, "static", "icon.png"));
  return fallback.isEmpty() ? undefined : fallback;
}

function createWindow(show: boolean): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 520,
    show,
    title: "Memento",
    icon: getWindowIcon(),
    // Matches the page while it loads, so there's no dark flash in light mode.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0b12" : "#f6f5fb",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 18, y: 18 } : undefined,
    // Windows / Linux: the default File-Edit-View menu adds nothing to the web UI and its
    // bottom edge shows as a dark line under it. Hidden, it still answers Alt and its shortcuts.
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.webContents.session.clearCache().catch(() => {});

  // Native context menu for text copying, pasting, and selection in Desktop app
  win.webContents.on("context-menu", (_e, params) => {
    const menu = new Menu();
    if (params.selectionText) {
      menu.append(new MenuItem({ label: "复制", role: "copy" }));
      menu.append(new MenuItem({ type: "separator" }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ label: "撤销", role: "undo" }));
      menu.append(new MenuItem({ label: "重做", role: "redo" }));
      menu.append(new MenuItem({ type: "separator" }));
      menu.append(new MenuItem({ label: "剪切", role: "cut" }));
      menu.append(new MenuItem({ label: "复制", role: "copy" }));
      menu.append(new MenuItem({ label: "粘贴", role: "paste" }));
      menu.append(new MenuItem({ type: "separator" }));
    }
    menu.append(new MenuItem({ label: "全选", role: "selectAll" }));
    if (menu.items.length > 0) {
      menu.popup({ window: win });
    }
  });

  // Links to other sites open in the browser; GitHub sign-in stays in the window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const { origin, hostname } = new URL(url);
    if (origin === serverOrigin() || hostname === "github.com" || url.startsWith("file:")) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  win.webContents.on("did-navigate-in-page", () => void adoptWebLoginAndRoute());
  win.webContents.on("did-finish-load", () => void adoptWebLoginAndRoute());
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && url.startsWith(serverOrigin())) {
      void win?.loadFile(join(__dirname, "static", "offline.html"), { query: { server: serverOrigin() } });
    }
  });

  win.on("close", (event) => {
    // Closing the window keeps Memento in the tray; quit from the tray menu.
    if (!quitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  win.on("minimize", () => {
    // macOS: 点击黄色最小化按钮时直接隐藏至托盘菜单栏，符合“Mac 客户端要支持最小化到托盘”的铁律
    if (process.platform === "darwin") {
      win?.hide();
    }
  });

  win.on("focus", () => {
    // 切换回桌面端窗口时，立即向 web 发出应用激活与唤醒事件
    win?.webContents.executeJavaScript("window.dispatchEvent(new Event('memento_app_active')); window.dispatchEvent(new Event('memento_wake_stream')); true;").catch(() => {});
  });

  void loadApp();
}

async function navigateApp(path?: string): Promise<void> {
  const targetPath = path || config.lastRoute || "/";
  if (!win || win.isDestroyed()) {
    createWindow(true);
    await loadApp(targetPath);
    return;
  }
  win.show();
  win.focus();
  try {
    const cur = win.webContents.getURL();
    if (cur.startsWith(serverOrigin())) {
      const script = `(() => {
        if (typeof window.__memento_client_push === "function") {
          window.__memento_client_push(${JSON.stringify(targetPath)});
          return true;
        }
        return false;
      })()`;
      const ok = await win.webContents.executeJavaScript(script, true);
      if (ok) return;
    }
  } catch {
    // fallback to loadApp
  }
  await loadApp(targetPath);
}

function showWindow(path?: string): void {
  if (path) {
    void navigateApp(path);
  } else {
    // Restore window while preserving user's current view
    if (!win || win.isDestroyed()) {
      createWindow(true);
      return;
    }
    win.show();
    win.focus();
  }
}

function toggleButlerWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow(true);
    void navigateApp("/ask");
    return;
  }
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    win.show();
    win.focus();
    const cur = win.webContents.getURL();
    const isAlreadyAsk = cur.includes("/ask");
    if (!isAlreadyAsk) {
      void navigateApp("/ask");
    }
    win.webContents.executeJavaScript(`(() => {
      const focusPrompt = () => {
        const input = document.querySelector('textarea, input[type="text"]');
        if (input && typeof input.focus === "function") {
          input.focus();
          return true;
        }
        return false;
      };
      if (!focusPrompt()) {
        setTimeout(focusPrompt, 50);
        setTimeout(focusPrompt, 150);
      }
    })()`).catch(() => {});
  }
}

const recentDesktopNotifs = new Map<string, number>();

function isDuplicateDesktopNotification(title: string, body: string): boolean {
  const now = Date.now();
  for (const [k, ts] of recentDesktopNotifs.entries()) {
    if (now - ts > 120_000) recentDesktopNotifs.delete(k);
  }
  const cleanTitle = (title || "").trim();
  const cleanBody = (body || "").trim();
  const colonIdx = cleanBody.indexOf("：");
  const coreBody = colonIdx !== -1 ? cleanBody.slice(colonIdx + 1).trim() : cleanBody;
  const fullKey = `${cleanTitle}:${cleanBody}`;
  const coreKey = `${cleanTitle}:${coreBody}`;
  if (recentDesktopNotifs.has(fullKey) || (coreBody && recentDesktopNotifs.has(coreKey))) {
    return true;
  }
  recentDesktopNotifs.set(fullKey, now);
  if (coreBody) recentDesktopNotifs.set(coreKey, now);
  return false;
}

function showNotification(title: string, body: string, targetUrl?: string): void {
  if (isDuplicateDesktopNotification(title, body)) return;

  if (Notification.isSupported()) {
    try {
      const iconCandidates = [
        join(__dirname, "static", "icon@2x.png"),
        join(__dirname, "static", "icon.png"),
        join(__dirname, "static", "tray@2x.png"),
        join(__dirname, "static", "tray.png"),
      ];
      let icon = nativeImage.createEmpty();
      for (const candidate of iconCandidates) {
        if (existsSync(candidate)) {
          const loaded = nativeImage.createFromPath(candidate);
          if (!loaded.isEmpty()) {
            icon = loaded;
            break;
          }
        }
      }
      const notification = new Notification({
        title: title || "Memento · AI 执事",
        body,
        icon: icon.isEmpty() ? undefined : icon,
      });
      notification.on("click", () => {
        void navigateApp(targetUrl || "/ask");
      });
      notification.show();
      return;
    } catch {
      // fall through to platform CLI fallback
    }
  }

  if (process.platform === "darwin") {
    try {
      const { exec } = require("node:child_process");
      const cleanTitle = (title || "Memento · AI 执事").replace(/["\\]/g, "");
      const cleanBody = (body || "").replace(/["\\]/g, "");
      exec(`osascript -e 'display notification "${cleanBody}" with title "${cleanTitle}" sound name "default"'`);
    } catch {
      // ignore
    }
  } else if (process.platform === "linux") {
    try {
      const { exec } = require("node:child_process");
      const cleanTitle = (title || "Memento · AI 执事").replace(/["\\]/g, "");
      const cleanBody = (body || "").replace(/["\\]/g, "");
      exec(`notify-send "${cleanTitle}" "${cleanBody}"`);
    } catch {
      // ignore
    }
  }
}

let notifyPollTimer: NodeJS.Timeout | null = null;
const notifyStartedAt = new Date().toISOString();
let lastSeenNotifyTime = notifyStartedAt;
const notifiedDesktopIds = new Set<string>();
// Notifications are pushed over /api/events/stream; while that connection is up the feed poll only
// backs it up (every 10 minutes), and it catches up each time the connection comes back
let notifyLive = false;

interface FeedItem {
  id: string;
  title: string;
  body: string;
  url?: string;
  created_at: string;
}

function showFeedItem(item: FeedItem): boolean {
  if (!item?.id || notifiedDesktopIds.has(item.id)) return false;
  // The stream replays its recent events on connect: those from before this launch were shown already
  if (item.created_at && item.created_at <= notifyStartedAt) return false;
  notifiedDesktopIds.add(item.id);
  if (notifiedDesktopIds.size > 500) {
    const first = notifiedDesktopIds.values().next().value;
    if (first) notifiedDesktopIds.delete(first);
  }
  if (item.created_at > lastSeenNotifyTime) lastSeenNotifyTime = item.created_at;
  showNotification(item.title, item.body, item.url);
  return true;
}

async function startNotificationStream(onUp: () => void): Promise<void> {
  let delay = 2_000;
  for (;;) {
    const jwt = await webToken();
    if (!jwt) {
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    const ctrl = new AbortController();
    // The server sends a keepalive every 30 s: 75 s of silence means the connection is gone
    let watchdog: NodeJS.Timeout | null = null;
    const arm = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => ctrl.abort(), 75_000);
    };
    try {
      arm();
      const res = await fetch(`${serverOrigin()}/api/events/stream`, {
        headers: { Authorization: `Bearer ${jwt}`, Accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      delay = 2_000;
      notifyLive = true;
      onUp();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm();
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            const ev = JSON.parse(data) as { type?: string; data?: FeedItem };
            if (ev.type === "notification" && ev.data) showFeedItem(ev.data);
          } catch {
            // a malformed frame is skipped
          }
        }
      }
    } catch {
      // dropped or refused: retried below
    } finally {
      if (watchdog) clearTimeout(watchdog);
      notifyLive = false;
    }
    delay = Math.min(delay * 2, 60_000);
    await new Promise((r) => setTimeout(r, delay));
  }
}

async function startNotificationFeedPoller(): Promise<void> {
  if (notifyPollTimer) return;

  let currentDelay = 10_000;

  const scheduleNext = (delay: number) => {
    if (notifyPollTimer) clearTimeout(notifyPollTimer);
    notifyPollTimer = setTimeout(() => void poll(), delay);
  };

  const poll = async () => {
    let hasNewItems = false;
    try {
      const jwt = await webToken();
      if (!jwt) {
        scheduleNext(30_000);
        return;
      }
      const isVisibleAndFocused = win && win.isVisible() && !win.isMinimized() && win.isFocused();
      const base = serverOrigin();
      const res = await fetch(`${base}/api/notify/feed?since=${encodeURIComponent(lastSeenNotifyTime)}`, {
        headers: { Authorization: `Bearer ${jwt}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const items = (await res.json()) as FeedItem[];
        if (Array.isArray(items)) {
          for (const item of items) {
            if (showFeedItem(item)) hasNewItems = true;
          }
        }
      }

      if (notifyLive) {
        currentDelay = 600_000;
      } else if (hasNewItems) {
        currentDelay = 5_000;
      } else if (!isVisibleAndFocused) {
        currentDelay = 60_000;
      } else {
        currentDelay = Math.min(30_000, currentDelay + 5_000);
      }
    } catch {
      currentDelay = 30_000;
    }
    scheduleNext(currentDelay);
  };

  if (win) {
    win.on("focus", () => {
      if (notifyLive) return; // pushed: nothing to fetch on focus
      currentDelay = 10_000;
      scheduleNext(150);
    });
  }

  // Each time the stream comes (back) up, fetch what was sent while it was down
  void startNotificationStream(() => scheduleNext(0));
  void poll();
}

let appTrackerTimer: NodeJS.Timeout | null = null;
let appSyncTimer: NodeJS.Timeout | null = null;
// Store app seconds: { [dateStr: string]: { [appName: string]: number } }
const appUsageSecondsByDay: Record<string, Record<string, number>> = {};

function getTodayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeDesktopAppName(raw: string): string {
  const norm = raw.trim();
  const lower = norm.toLowerCase();

  if (
    !norm ||
    [
      "lockapp",
      "searchhost",
      "startmenuexperiencehost",
      "shellexperiencehost",
      "textinputhost",
      "loginwindow",
      "screensaverengine",
      "notification center",
    ].includes(lower)
  ) {
    return "";
  }

  if (lower.includes("cursor")) return "Cursor";
  if (lower.includes("antigravity")) return "Antigravity";
  if (lower.includes("workbuddy")) return "WorkBuddy";
  if (lower === "code" || lower === "vscode" || lower.includes("visual studio code")) return "VS Code";
  if (lower.includes("chrome")) return "Google Chrome";
  if (lower.includes("edge")) return "Microsoft Edge";
  if (lower.includes("firefox")) return "Firefox";
  if (lower.includes("safari")) return "Safari";
  if (lower.includes("wechat") || norm === "微信") return "微信";
  if (lower.includes("feishu") || lower.includes("lark") || norm === "飞书") return "飞书";
  if (lower.includes("dingtalk") || norm === "钉钉") return "钉钉";
  if (lower.includes("memento")) return "Memento";
  if (lower.includes("devenv")) return "Visual Studio";
  if (lower.includes("idea")) return "IntelliJ IDEA";
  if (lower.includes("pycharm")) return "PyCharm";
  if (lower.includes("webstorm")) return "WebStorm";
  if (lower.includes("goland")) return "GoLand";
  if (lower.includes("clion")) return "CLion";
  if (
    lower === "windowsterminal" ||
    lower.includes("terminal") ||
    lower === "iterm2" ||
    lower === "alacritty" ||
    lower === "kitty" ||
    lower === "konsole"
  ) {
    return norm;
  }
  return norm;
}

async function getFrontmostAppName(): Promise<string | null> {
  if (process.platform === "darwin") {
    try {
      const script = `tell application "System Events"
        set f to first application process whose frontmost is true
        return (name of f) & ":::" & (bundle identifier of f)
      end tell`;
      const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 3000 });
      const trimmed = (stdout || "").trim();
      if (!trimmed) return null;
      const [rawName, bundleId] = trimmed.split(":::");
      let name = (rawName || "").trim();
      if (bundleId === "com.google.antigravity" || name === "Antigravity") name = "Antigravity";
      else if (bundleId?.includes("workbuddy") || name.toLowerCase().includes("workbuddy")) name = "WorkBuddy";
      else if (bundleId === "com.microsoft.VSCode" || name === "Code") name = "VS Code";
      else if (bundleId === "com.google.Chrome") name = "Google Chrome";
      else if (bundleId === "com.tencent.xinWeChat") name = "微信";
      else if (bundleId === "com.apple.Terminal") name = "Terminal";
      else if (bundleId === "com.googlecode.iterm2") name = "iTerm2";
      else if (bundleId === "com.electron.memento" || bundleId === "com.ihasy.memento.desktop") name = "Memento";
      else if (bundleId === "com.apple.Safari") name = "Safari";
      else if (bundleId === "com.todesktop.230313mzl4w4u92" || name.toLowerCase().includes("cursor")) name = "Cursor";
      else if (bundleId === "com.electron.lark" || bundleId === "com.bytedance.feishu") name = "飞书";

      const res = normalizeDesktopAppName(name);
      return res || null;
    } catch {
      return null;
    }
  } else if (process.platform === "win32") {
    try {
      const ps = `Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Win32 {
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        }
"@
      $hwnd = [Win32]::GetForegroundWindow()
      $pid = 0
      [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
      (Get-Process -Id $pid).ProcessName`;
      const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", ps], { timeout: 3000 });
      const raw = (stdout || "").trim();
      return raw ? normalizeDesktopAppName(raw) || null : null;
    } catch {
      return null;
    }
  } else if (process.platform === "linux") {
    try {
      // 1. Try X11 / XWayland active window via xprop
      const script = `
        win_id=$(xprop -root _NET_ACTIVE_WINDOW 2>/dev/null | awk -F'# ' '{print $2}')
        if [ -n "$win_id" ] && [ "$win_id" != "0x0" ]; then
          xprop -id "$win_id" WM_CLASS 2>/dev/null | awk -F'"' '{print $(NF-1)}'
        fi
      `;
      const { stdout } = await execFileAsync("sh", ["-c", script], { timeout: 2000 });
      const raw = (stdout || "").trim();
      if (raw) {
        return normalizeDesktopAppName(raw) || null;
      }
      // 2. Fallback to xdotool
      const { stdout: xdoOut } = await execFileAsync("xdotool", ["getwindowfocus", "getwindowname"], { timeout: 1500 });
      const xdoRaw = (xdoOut || "").trim();
      return xdoRaw ? normalizeDesktopAppName(xdoRaw) || null : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function syncAppUsageToServer(): Promise<void> {
  const today = getTodayKey();
  const dayStats = appUsageSecondsByDay[today];
  if (!dayStats || Object.keys(dayStats).length === 0) return;

  const appUsages = Object.entries(dayStats)
    .filter(([_, sec]) => sec >= 10)
    .map(([name, sec]) => ({
      name,
      minutes: Math.max(1, Math.round(sec / 60)),
    }))
    .sort((a, b) => b.minutes - a.minutes);

  if (appUsages.length === 0) return;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const jwt = await webToken();
  if (jwt) {
    headers["Authorization"] = `Bearer ${jwt}`;
  } else if (config?.token) {
    headers["X-Collector-Token"] = config.token;
  } else {
    return;
  }

  const base = config?.serverUrl || serverOrigin();
  try {
    await fetch(`${base}/api/life/rhythm`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        log_date: today,
        app_usages: appUsages,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // ignore network errors
  }
}

function startActiveAppTracker(): void {
  if (appTrackerTimer) return;

  const tick = async () => {
    try {
      if (powerMonitor && typeof powerMonitor.getSystemIdleTime === "function") {
        const idleSec = powerMonitor.getSystemIdleTime();
        if (idleSec >= 120) return;
      }
      const appName = await getFrontmostAppName();
      if (!appName) return;

      const today = getTodayKey();
      if (!appUsageSecondsByDay[today]) {
        appUsageSecondsByDay[today] = {};
      }
      appUsageSecondsByDay[today][appName] = (appUsageSecondsByDay[today][appName] || 0) + 5;
    } catch {
      // ignore
    }
  };

  appTrackerTimer = setInterval(() => void tick(), 5000);
  appSyncTimer = setInterval(() => void syncAppUsageToServer(), 60000);

  try {
    powerMonitor.on("suspend", () => void syncAppUsageToServer());
  } catch {}
}


function setupDockMenu(): void {
  if (process.platform === "darwin" && app.dock) {
    const dockMenu = Menu.buildFromTemplate([
      { label: "AI 执事", click: () => void navigateApp("/ask") },
      { label: "认知大脑", click: () => void navigateApp("/memory") },
      { label: "作息节律", click: () => void navigateApp("/daily") },
      { label: "工作待办", click: () => void navigateApp("/inbox") },
      { type: "separator" },
      { label: "本机采集", click: () => void navigateApp("/collector") },
    ]);
    app.dock.setMenu(dockMenu);
  }
}

function setupAppMenu(): void {
  const isMac = process.platform === "darwin";
  if (isMac) {
    app.setAboutPanelOptions({
      applicationName: "Memento",
      applicationVersion: app.getVersion(),
      copyright: "Copyright © 2026 Memento",
    });
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "Memento",
            submenu: [
              { role: "about" as const, label: "关于 Memento" },
              { type: "separator" as const },
              { label: "首选项 / 个人设置", accelerator: "CmdOrCtrl+,", click: () => void navigateApp("/profile") },
              {
                label: "切换服务器...",
                accelerator: "CmdOrCtrl+Alt+S",
                click: () => {
                  if (win && !win.isDestroyed()) {
                    showWindow();
                    win.webContents.send("server:open-switch");
                  }
                },
              },
              { type: "separator" as const },
              { role: "services" as const, label: "服务" },
              { type: "separator" as const },
              { role: "hide" as const, label: "隐藏 Memento" },
              { role: "hideOthers" as const, label: "隐藏其他" },
              { role: "unhide" as const, label: "显示全部" },
              { type: "separator" as const },
              {
                label: "退出 Memento",
                accelerator: "CmdOrCtrl+Q",
                click: () => {
                  quitting = true;
                  app.quit();
                },
              },
            ],
          },
        ]
      : [
          {
            label: "文件",
            submenu: [
              { label: "首选项 / 个人设置", accelerator: "Ctrl+,", click: () => void navigateApp("/profile") },
              {
                label: "切换服务器...",
                accelerator: "Ctrl+Alt+S",
                click: () => {
                  if (win && !win.isDestroyed()) {
                    showWindow();
                    win.webContents.send("server:open-switch");
                  }
                },
              },
              { type: "separator" as const },
              {
                label: "退出 Memento",
                accelerator: "Ctrl+Q",
                click: () => {
                  quitting = true;
                  app.quit();
                },
              },
            ],
          },
        ]),
    {
      label: "编辑",
      submenu: [
        { role: "undo" as const, label: "撤销" },
        { role: "redo" as const, label: "重做" },
        { type: "separator" as const },
        { role: "cut" as const, label: "剪切" },
        { role: "copy" as const, label: "复制" },
        { role: "paste" as const, label: "粘贴" },
        { role: "selectAll" as const, label: "全选" },
      ],
    },
    {
      label: "执事与导航",
      submenu: [
        {
          label: "AI 执事",
          accelerator: "CmdOrCtrl+1",
          click: () => void navigateApp("/ask"),
        },
        {
          label: "认知大脑",
          accelerator: "CmdOrCtrl+2",
          click: () => void navigateApp("/memory"),
        },
        {
          label: "作息节律",
          accelerator: "CmdOrCtrl+3",
          click: () => void navigateApp("/daily"),
        },
        {
          label: "工作待办",
          accelerator: "CmdOrCtrl+4",
          click: () => void navigateApp("/inbox"),
        },
        {
          label: "运行看板",
          accelerator: "CmdOrCtrl+5",
          click: () => void navigateApp("/app"),
        },
        { type: "separator" as const },
        {
          label: "呼出 / 隐藏 AI 执事 (全局快捷键)",
          accelerator: "CmdOrCtrl+Shift+A",
          click: () => toggleButlerWindow(),
        },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" as const, label: "重新载入" },
        {
          label: "强制重新载入 (清空缓存)",
          accelerator: "CmdOrCtrl+Shift+R",
          click: async () => {
            if (win && !win.isDestroyed()) {
              await win.webContents.session.clearCache();
              win.webContents.reloadIgnoringCache();
            }
          },
        },
        { role: "forceReload" as const, label: "强制重新载入" },
        { role: "toggleDevTools" as const, label: "开发者工具" },
        { type: "separator" as const },
        { role: "resetZoom" as const, label: "实际大小" },
        { role: "zoomIn" as const, label: "放大" },
        { role: "zoomOut" as const, label: "缩小" },
        { type: "separator" as const },
        { role: "togglefullscreen" as const, label: "切换全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" as const, label: "最小化" },
        { role: "zoom" as const, label: "缩放" },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const, label: "前置所有窗口" },
            ]
          : [{ role: "close" as const, label: "关闭" }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getOpenAtLogin(): boolean {
  if (process.platform === "win32") {
    return app.getLoginItemSettings({
      path: process.execPath,
      args: [HIDDEN_ARG],
    }).openAtLogin;
  }
  return app.getLoginItemSettings().openAtLogin;
}

function setOpenAtLogin(open: boolean): boolean {
  app.setLoginItemSettings({
    openAtLogin: open,
    path: process.execPath,
    args: [HIDDEN_ARG],
  });
  refreshTray();
  return getOpenAtLogin();
}

function refreshTray(): void {
  if (!tray) return;
  const openAtLogin = getOpenAtLogin();
  tray.setToolTip(`Memento · AI 执事 · ${modeLabel(daemon.mode)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Memento", click: () => showWindow() },
      {
        label: "AI 执事",
        accelerator: "CmdOrCtrl+Shift+A",
        click: () => void navigateApp("/ask"),
      },
      {
        label: "认知大脑",
        click: () => void navigateApp("/memory"),
      },
      {
        label: "作息节律",
        click: () => void navigateApp("/daily"),
      },
      {
        label: "工作待办",
        click: () => void navigateApp("/inbox"),
      },
      { type: "separator" },
      { label: modeLabel(daemon.mode), enabled: false },
      { label: "本机采集", click: () => void navigateApp("/collector") },
      {
        label: "立即同步画像和技能",
        enabled: daemon.mode === "running" || daemon.mode === "external",
        click: () => void daemon.call("POST", "/sync-profile").catch(() => {}),
      },
      { type: "separator" },
      {
        label: "切换服务器...",
        click: () => {
          if (win && !win.isDestroyed()) {
            showWindow();
            win.webContents.send("server:open-switch");
          }
        },
      },
      {
        label: "开机自动启动",
        type: "checkbox",
        checked: openAtLogin,
        click: (item) => {
          setOpenAtLogin(item.checked);
        },
      },
      { label: "检查更新", enabled: app.isPackaged, click: () => void checkForUpdates(true) },
      { type: "separator" },
      {
        label: "退出 Memento",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  // macOS menu bar standard: native 16x16 pt Template image (*Template.png).
  // Windows system tray: multi-DPI .ico; Linux: high-DPI colored brand icon.
  const name = isMac ? "trayTemplate.png" : isWin ? "icon.ico" : "icon.png";
  const iconPath = join(__dirname, "static", name);
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(join(__dirname, "static", "tray.png"));
  }
  if (isMac && !icon.isEmpty()) {
    icon = icon.resize({ width: 16, height: 16 });
    icon.setTemplateImage(true);
  } else if (!isMac && !isWin && !icon.isEmpty()) {
    icon = icon.resize({ width: 32, height: 32, quality: "best" });
  }
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.on("click", () => showWindow());
  refreshTray();
}

async function checkForUpdates(manual: boolean): Promise<void> {
  if (!app.isPackaged) return;
  try {
    const baseUrl = (config?.serverUrl || "https://mem.ihasy.com").replace(/\/+$/, "");
    autoUpdater.setFeedURL({
      provider: "generic",
      url: `${baseUrl}/api/system/update`,
    });
    const result = await autoUpdater.checkForUpdates();
    if (manual && !result?.isUpdateAvailable) {
      void dialog.showMessageBox({ message: "已是最新版本", detail: `Memento ${app.getVersion()}` });
    }
  } catch (e) {
    if (manual) void dialog.showMessageBox({ type: "warning", message: "检查更新失败", detail: e instanceof Error ? e.message : String(e) });
  }
}

async function installMacUpdate(info: any): Promise<void> {
  const downloadedZip = info?.downloadedFile || join(app.getPath("home"), "Library/Caches/@mementodesktop-updater/update.zip");
  if (!existsSync(downloadedZip)) {
    autoUpdater.quitAndInstall();
    return;
  }

  // Target app bundle path, e.g. /Applications/Memento.app
  const targetApp = process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, "");

  // Extract update.zip to a temporary directory
  const tempExtractDir = join(app.getPath("temp"), `memento-update-${Date.now()}`);
  mkdirSync(tempExtractDir, { recursive: true });

  try {
    execFileSync("unzip", ["-q", downloadedZip, "-d", tempExtractDir]);

    let srcApp = join(tempExtractDir, "Memento.app");
    if (!existsSync(srcApp)) {
      const entries = readdirSync(tempExtractDir);
      const appEntry = entries.find((e) => e.endsWith(".app"));
      if (appEntry) srcApp = join(tempExtractDir, appEntry);
    }

    if (!existsSync(srcApp)) {
      throw new Error(`Extracted update does not contain .app bundle: ${tempExtractDir}`);
    }

    const shPath = join(tempExtractDir, "updater.sh");
    const shContent = `#!/bin/sh
TARGET_PID="$1"
SRC_APP="$2"
TARGET_APP="$3"
TEMP_DIR="$4"

COUNT=0
while kill -0 "$TARGET_PID" 2>/dev/null; do
    sleep 0.5
    COUNT=$((COUNT + 1))
    if [ "$COUNT" -ge 20 ]; then
        kill -9 "$TARGET_PID" 2>/dev/null
        break
    fi
done
sleep 1

if [ -n "$SRC_APP" ] && [ -d "$SRC_APP" ] && [ -n "$TARGET_APP" ]; then
    PARENT_DIR=$(dirname "$TARGET_APP")
    if [ ! -w "$PARENT_DIR" ] || ( [ -e "$TARGET_APP" ] && [ ! -w "$TARGET_APP" ] ); then
        osascript -e "do shell script \\"rm -rf \\\\\\"$TARGET_APP\\\\\\" && cp -R \\\\\\"$SRC_APP\\\\\\" \\\\\\"$TARGET_APP\\\\\\" && xattr -cr \\\\\\"$TARGET_APP\\\\\\"\\" with administrator privileges" 2>/dev/null || true
    else
        rm -rf "$TARGET_APP"
        cp -R "$SRC_APP" "$TARGET_APP"
        xattr -cr "$TARGET_APP" 2>/dev/null || true
    fi
    codesign --force --deep -s - -r='designated => identifier "com.ihasy.memento.desktop"' "$TARGET_APP" 2>/dev/null || true
fi

if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
fi

open "$TARGET_APP" || open -n "$TARGET_APP"
rm -f "$0"
`;
    writeFileSync(shPath, shContent, { mode: 0o755 });

    const child = spawn("/bin/sh", [shPath, process.pid.toString(), srcApp, targetApp, tempExtractDir], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    app.exit(0);
  } catch (err) {
    console.error("Failed to perform in-place Mac update, falling back to quitAndInstall:", err);
    autoUpdater.quitAndInstall();
  }
}

function setupUpdater(): void {
  // 解耦 autoDownload，将轻量版本比对与大文件下载分离，避免网络下载阻塞导致检查更新弹窗报错
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  let downloadedInfo: any = null;
  let lastPromptedVersion: string | null = null;
  let downloadingVersion: string | null = null;

  autoUpdater.on("update-available", async (info) => {
    if (downloadingVersion === info.version || downloadedInfo?.version === info.version) {
      return;
    }
    const releaseNotesText = typeof info.releaseNotes === "string" 
      ? info.releaseNotes 
      : Array.isArray(info.releaseNotes) 
      ? info.releaseNotes.map((n: any) => n?.note || "").filter(Boolean).join("\n") 
      : "";
    const detailMsg = releaseNotesText ? `${releaseNotesText}\n\n是否立即开始下载更新？` : "点击立即下载以获取最新功能与稳定性修复。";
    
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["立即下载", "稍后提醒"],
      defaultId: 0,
      cancelId: 1,
      message: `发现新版本 Memento ${info.version}`,
      detail: detailMsg,
    });
    if (response === 0) {
      downloadingVersion = info.version;
      showNotification("开始下载更新", `正在下载 Memento ${info.version}...`);
      void autoUpdater.downloadUpdate().catch(async (err) => {
        downloadingVersion = null;
        if (win && !win.isDestroyed()) {
          win.setProgressBar(-1);
        }
        refreshTray();
        const { response: errResp } = await dialog.showMessageBox({
          type: "warning",
          buttons: ["在浏览器中下载", "稍后重试"],
          defaultId: 0,
          cancelId: 1,
          message: "更新包下载未完成",
          detail: `下载遇到网络阻断或超时：${err instanceof Error ? err.message : String(err)}\n建议直接通过官网下载完整安装包。`,
        });
        if (errResp === 0) {
          const baseUrl = (config?.serverUrl || "https://mem.ihasy.com").replace(/\/+$/, "");
          void shell.openExternal(`${baseUrl}/download`);
        }
      });
    }
  });

  autoUpdater.on("download-progress", (progress) => {
    if (win && !win.isDestroyed()) {
      win.setProgressBar(Math.max(0, Math.min(1, (progress.percent || 0) / 100)));
    }
    if (tray) {
      tray.setToolTip(`Memento - 正在下载更新 ${Math.round(progress.percent || 0)}%`);
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("autoUpdater error:", err);
    downloadingVersion = null;
    if (win && !win.isDestroyed()) {
      win.setProgressBar(-1);
    }
    refreshTray();
  });

  autoUpdater.on("update-downloaded", async (info) => {
    downloadedInfo = info;
    downloadingVersion = null;
    if (win && !win.isDestroyed()) {
      win.setProgressBar(-1);
    }
    refreshTray();
    if (lastPromptedVersion === info.version) {
      return;
    }
    lastPromptedVersion = info.version;
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["现在重启", "稍后"],
      defaultId: 0,
      message: `Memento ${info.version} 已下载`,
      detail: "重启后生效；也可以稍后退出时自动安装。",
    });
    if (response === 0) {
      quitting = true;
      if (process.platform === "darwin") {
        await installMacUpdate(info);
      } else {
        autoUpdater.quitAndInstall();
      }
    }
  });

  app.on("before-quit", () => {
    if (downloadedInfo && process.platform === "darwin" && !quitting) {
      quitting = true;
      void installMacUpdate(downloadedInfo);
    }
  });

  void checkForUpdates(false);
  setInterval(() => void checkForUpdates(false), UPDATE_CHECK_MS);
}

/** Files that run when opened with their default app (scripts, installers, app bundles, shortcuts). */
const RUNNABLE =
  /\.(app|command|tool|terminal|sh|bash|zsh|csh|ksh|fish|py|rb|pl|php|scpt|scptd|applescript|workflow|pkg|mpkg|exe|bat|cmd|com|msi|msp|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|reg|scr|cpl|msc|jar|appimage|desktop|run|bin)$/i;

async function runsWhenOpened(filePath: string): Promise<boolean> {
  const clean = filePath.replace(/[\\/]+$/, "");
  if (RUNNABLE.test(clean)) return true;
  // With an extension the type decides (media on exFAT/NTFS drives carries the executable bit too).
  if (process.platform === "win32" || /\.[^\\/.]+$/.test(clean)) return false;
  try {
    // A bare Unix executable opens in a terminal and runs.
    const st = await stat(filePath);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function setupIpc(): void {
  // Every channel answers memento's own page only: the window also shows github.com during sign-in,
  // and nothing else loaded there may reach the daemon, local files, the login or the shell.
  const handle = (channel: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!fromApp(e)) throw new Error("not allowed");
      return fn(e, ...args);
    });
  handle("daemon:status", async () => {
    const base = { mode: daemon.mode, label: modeLabel(daemon.mode) };
    try {
      return { ...base, status: await daemon.call("GET", "/status") };
    } catch {
      return { ...base, status: null };
    }
  });
  handle("daemon:logs", async () => {
    try {
      return ((await daemon.call("GET", "/logs")) as { logs: string[] }).logs;
    } catch {
      return [...daemon.recentLogs];
    }
  });
  handle("daemon:action", async (_e, action: unknown) => {
    const paths: Record<string, string> = { resync: "/resync", rediscover: "/rediscover", "sync-profile": "/sync-profile" };
    const path = typeof action === "string" ? paths[action] : undefined;
    if (!path) throw new Error("unknown action");
    return daemon.call("POST", path);
  });
  handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    openAtLogin: getOpenAtLogin(),
    packaged: app.isPackaged,
    // How AI tools start the bundled MCP server: this app's binary as Node.
    mcp: {
      command: process.execPath,
      args: [join(__dirname, "mcp.mjs").replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    },
  }));
  handle("app:set-open-at-login", (_e, on: unknown) => {
    return setOpenAtLogin(on === true);
  });
  handle("app:check-updates", () => checkForUpdates(true));
  handle("app:notify", (_e, options: unknown) => {
    const opt = options as { title?: string; body?: string; url?: string } | undefined;
    if (opt?.title) {
      showNotification(opt.title, opt.body || "", opt.url);
      return true;
    }
    return false;
  });
  handle("server:get", () => ({
    current: config?.serverUrl || "https://mem.ihasy.com",
    webUrl: config?.webUrl,
    defaultUrl: "https://mem.ihasy.com",
  }));
  handle("server:test", async (_e, url: unknown) => {
    if (typeof url !== "string") return { ok: false, latencyMs: 0, error: "无效的 URL" };
    const clean = url.trim().replace(/\/+$/, "");
    const start = Date.now();
    try {
      // A memento server answers /health with {"status":"ok"}; any other site, or one that is down, doesn't.
      const res = await net.fetch(`${clean}/health`, { signal: AbortSignal.timeout(5000) });
      const latencyMs = Date.now() - start;
      const body = (await res.json().catch(() => null)) as { status?: string } | null;
      if (res.ok && body?.status === "ok") return { ok: true, latencyMs, status: res.status };
      return { ok: false, latencyMs, status: res.status, error: res.ok ? "不是 memento 服务器" : `HTTP ${res.status}` };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : "连接失败或超时";
      return { ok: false, latencyMs, error: errorMsg };
    }
  });
  handle("server:set", async (e, options: unknown) => {
    const opt = options as { url?: string; resetAuth?: boolean } | undefined;
    if (!opt?.url || typeof opt.url !== "string") {
      return { ok: false, error: "无效的服务器地址" };
    }
    const cleanUrl = opt.url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^/]/.test(cleanUrl) || !URL.canParse(cleanUrl)) {
      return { ok: false, error: "服务器地址必须以 http:// 或 https:// 开头" };
    }
    // The page asks; the user confirms here, where a script on the page can't click for them.
    const parent = BrowserWindow.fromWebContents(e.sender) ?? win;
    const ask = {
      type: "question" as const,
      buttons: ["切换", "取消"],
      defaultId: 1,
      cancelId: 1,
      message: `切换到 ${cleanUrl}？`,
      detail: opt.resetAuth
        ? "切换后需要在新服务器上重新登录，这台设备也会改为连接新服务器。"
        : "将保留当前登录：登录凭据会发给新服务器。只有新地址是同一台服务器的另一个地址时才应这样做。",
    };
    const { response } = parent ? await dialog.showMessageBox(parent, ask) : await dialog.showMessageBox(ask);
    if (response !== 0) return { ok: false, error: "已取消切换" };

    config.serverUrl = cleanUrl;
    config.webUrl = cleanUrl;
    if (opt.resetAuth) {
      config.token = "";
    }
    await saveConfig(config);

    try {
      if (daemon.mode === "running" || daemon.mode === "starting") {
        await daemon.stop();
      }
      if (config.token) {
        await daemon.start();
      } else {
        daemon.mode = "no-token";
      }
    } catch (err) {
      console.warn("Daemon restart on server switch error:", err);
    }
    refreshTray();

    if (win && !win.isDestroyed()) {
      try {
        if (opt.resetAuth) {
          await win.webContents.session.clearStorageData({
            storages: ["cookies", "localstorage"],
          });
        }
      } catch {}
      await loadApp("/");
    }
    return { ok: true };
  });
  handle("shell:open-external", (_e, url: unknown) => {
    if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:"))) {
      return shell.openExternal(url);
    }
  });
  handle("shell:open-path", async (_e, filePath: unknown) => {
    if (typeof filePath !== "string") return "无效的路径";
    if (await runsWhenOpened(filePath)) {
      shell.showItemInFolder(filePath);
      return "这是可执行文件，打开即会运行，已改为在文件夹中显示";
    }
    return shell.openPath(filePath);
  });
  handle("shell:show-item-in-folder", (_e, filePath: unknown) => {
    if (typeof filePath === "string") {
      shell.showItemInFolder(filePath);
    }
  });
  handle("fs:read-file", async (_e, filePath: unknown) => {
    if (typeof filePath !== "string") {
      return { error: "Invalid file path" };
    }
    let clean = filePath.trim();
    if (clean.startsWith("file://")) {
      try {
        clean = fileURLToPath(clean);
      } catch {
        clean = clean.replace(/^file:\/\//, "");
      }
    } else {
      try {
        clean = decodeURI(clean);
      } catch {}
    }
    if (process.platform === "win32" && clean.startsWith("/") && clean[2] === ":") {
      clean = clean.slice(1);
    }
    try {
      const st = await stat(clean);
      if (st.isDirectory()) {
        return { error: "Path is a directory" };
      }
      if (st.size > 10 * 1024 * 1024) {
        return { error: "文件过大，工作台暂不支持直接预览超过 10MB 的文本文件" };
      }
      const content = await readFile(clean, "utf-8");
      return { content };
    } catch (err: any) {
      return { error: err?.message || String(err) };
    }
  });
  handle("net:fetch-text", async (_e, targetUrl: unknown) => {
    if (typeof targetUrl !== "string" || !/^https?:\/\//i.test(targetUrl)) {
      return { error: "Invalid URL" };
    }
    try {
      const res = await net.fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          "Accept": "text/markdown, text/plain, text/html, */*",
        },
      });
      if (!res.ok) {
        return { error: `HTTP ${res.status}` };
      }
      const content = await res.text();
      return { content };
    } catch (err: any) {
      return { error: err?.message || String(err) };
    }
  });

  const forward = (channel: string) => (payload: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  daemon.on("status", forward("daemon:status-event"));
  daemon.on("log", forward("daemon:log-event"));
  daemon.on("mode", (mode: DaemonMode) => {
    refreshTray();
    forward("daemon:mode-event")({ mode, label: modeLabel(mode) });
  });
}

// Privileged scheme for streaming local media (video, audio) in Desktop window
protocol.registerSchemesAsPrivileged([
  {
    scheme: "memento-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", (event) => {
    try {
      globalShortcut.unregisterAll();
    } catch {}
    if (notifyPollTimer) {
      clearInterval(notifyPollTimer);
      notifyPollTimer = null;
    }
    if (appTrackerTimer) {
      clearInterval(appTrackerTimer);
      appTrackerTimer = null;
    }
    if (appSyncTimer) {
      clearInterval(appSyncTimer);
      appSyncTimer = null;
    }
    void syncAppUsageToServer();
    if (daemon.mode === "running" || daemon.mode === "starting") {
      event.preventDefault();
      void daemon.stop().finally(() => app.exit(0));
    }
  });
  app.on("activate", () => showWindow());

function getMediaMimeType(filePath: string): string {
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "mkv":
      return "video/x-matroska";
    case "avi":
      return "video/x-msvideo";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "vtt":
      return "text/vtt; charset=utf-8";
    case "srt":
      return "text/plain; charset=utf-8";
    case "pdf":
      return "application/pdf";
    case "json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function parseMementoMediaFilePath(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  let filePath: string;
  if (parsed.host === "local" || parsed.host === "") {
    filePath = decodeURIComponent(parsed.pathname);
  } else {
    // When memento-media:///Users/... is navigated, Chromium treats the first segment (e.g. "users") as the host
    filePath = "/" + decodeURIComponent(parsed.host + parsed.pathname);
  }
  if (process.platform === "win32" && filePath.startsWith("/")) {
    filePath = filePath.slice(1);
  }
  return filePath;
}

  void app.whenReady().then(async () => {
    // Enable local media stream handler with full HTTP 206 Range & CORS support
    protocol.handle("memento-media", async (request) => {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "*",
          },
        });
      }
      try {
        const filePath = parseMementoMediaFilePath(request.url);
        const st = statSync(filePath);
        if (!st.isFile()) {
          return new Response("Not a file", {
            status: 404,
            headers: { "Access-Control-Allow-Origin": "*" },
          });
        }
        const fileSize = st.size;
        const mimeType = getMediaMimeType(filePath);

        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "Accept-Ranges": "bytes",
              "Content-Length": fileSize.toString(),
              "Content-Type": mimeType,
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
              "Access-Control-Allow-Headers": "*",
            },
          });
        }

        const rangeHeader = request.headers.get("range");
        if (rangeHeader && rangeHeader.startsWith("bytes=")) {
          const parts = rangeHeader.replace(/bytes=/, "").split("-");
          const start = parts[0] ? parseInt(parts[0], 10) : 0;
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

          if (start > end || start >= fileSize) {
            return new Response(null, {
              status: 416,
              statusText: "Range Not Satisfiable",
              headers: {
                "Content-Range": `bytes */${fileSize}`,
                "Access-Control-Allow-Origin": "*",
              },
            });
          }

          const chunkSize = end - start + 1;
          const stream = createReadStream(filePath, { start, end });
          const webStream = new ReadableStream({
            start(controller) {
              stream.on("data", (chunk) => controller.enqueue(chunk));
              stream.on("end", () => controller.close());
              stream.on("error", (err) => controller.error(err));
            },
            cancel() {
              stream.destroy();
            },
          });

          return new Response(webStream, {
            status: 206,
            statusText: "Partial Content",
            headers: {
              "Content-Range": `bytes ${start}-${end}/${fileSize}`,
              "Accept-Ranges": "bytes",
              "Content-Length": chunkSize.toString(),
              "Content-Type": mimeType,
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
              "Access-Control-Allow-Headers": "*",
            },
          });
        }

        // Full file streaming
        const stream = createReadStream(filePath);
        const webStream = new ReadableStream({
          start(controller) {
            stream.on("data", (chunk) => controller.enqueue(chunk));
            stream.on("end", () => controller.close());
            stream.on("error", (err) => controller.error(err));
          },
          cancel() {
            stream.destroy();
          },
        });

        return new Response(webStream, {
          status: 200,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Length": fileSize.toString(),
            "Content-Type": mimeType,
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "*",
          },
        });
      } catch (err) {
        return new Response("Media not found: " + String(err), {
          status: 404,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    });

    if (process.platform === "win32") {
      app.setAppUserModelId("com.ihasy.memento.desktop");
    }
    config = await loadConfig();
    setupIpc();
    createTray();
    setupDockMenu();
    setupAppMenu();
    try {
      globalShortcut.register("CommandOrControl+Shift+A", () => toggleButlerWindow());
    } catch (e) {
      console.warn("Failed to register shortcut CommandOrControl+Shift+A", e);
    }
    try {
      globalShortcut.register("Alt+Space", () => toggleButlerWindow());
    } catch (e) {
      console.warn("Failed to register shortcut Alt+Space", e);
    }
    // Only start hidden if explicitly passed --hidden (e.g. silent auto-start at boot).
    // Avoid false positives from app.getLoginItemSettings().wasOpenedAtLogin on macOS.
    const hidden = process.argv.includes(HIDDEN_ARG);
    createWindow(!hidden);
    if (config.token) await daemon.start();
    else daemon.mode = "no-token";
    refreshTray();
    setupUpdater();
    void startNotificationFeedPoller();
    void startActiveAppTracker();
  });

}
