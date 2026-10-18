"use client";

/**
 * Universal Native Notification Service for Memento.
 * Supports:
 * 1. Electron Desktop App (Mac, Windows, Linux) via window.mementoDesktop.notify
 * 2. Standard Web Browser Notifications API (Notification.requestPermission + new Notification)
 * 3. Mobile App (iOS / Android) WebView Bridge via window.ReactNativeWebView.postMessage
 * 4. In-App Glass Toast Fallback (when system notifications are blocked or in Do Not Disturb)
 */

import { api } from "./api-client";

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";

export function getLocalNotificationPermission(): NotificationPermissionState {
  if (typeof window === "undefined") return "unsupported";

  // 1. Electron Desktop App always has native notification capability
  const desktop = (window as unknown as { mementoDesktop?: { notify?: unknown } }).mementoDesktop;
  if (desktop && typeof desktop.notify === "function") {
    return "granted";
  }

  // 2. Mobile App WebView Bridge
  const bridge = (window as unknown as { ReactNativeWebView?: { postMessage?: unknown } }).ReactNativeWebView;
  if (bridge && typeof bridge.postMessage === "function") {
    return "granted";
  }

  // 3. Web Notification API
  if ("Notification" in window) {
    return Notification.permission as NotificationPermissionState;
  }

  return "unsupported";
}

export async function requestLocalNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  const desktop = (window as unknown as { mementoDesktop?: { notify?: unknown } }).mementoDesktop;
  if (desktop && typeof desktop.notify === "function") {
    return true;
  }

  const bridge = (window as unknown as { ReactNativeWebView?: { postMessage?: unknown } }).ReactNativeWebView;
  if (bridge && typeof bridge.postMessage === "function") {
    return true;
  }

  if ("Notification" in window) {
    try {
      const res = await Notification.requestPermission();
      return res === "granted";
    } catch {
      return false;
    }
  }

  return false;
}

export function showInAppToast(title: string, body: string, url?: string): void {
  if (typeof document === "undefined") return;

  const id = "memento-in-app-toast-container";
  let container = document.getElementById(id);
  if (!container) {
    container = document.createElement("div");
    container.id = id;
    container.style.position = "fixed";
    container.style.top = "20px";
    container.style.right = "20px";
    container.style.zIndex = "999999";
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "10px";
    container.style.pointerEvents = "none";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.style.pointerEvents = "auto";
  toast.style.minWidth = "280px";
  toast.style.maxWidth = "400px";
  toast.style.padding = "14px 18px";
  toast.style.borderRadius = "16px";
  toast.style.background = "rgba(18, 18, 28, 0.92)";
  toast.style.backdropFilter = "blur(20px)";
  (toast.style as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter = "blur(20px)";
  toast.style.border = "1px solid rgba(255, 255, 255, 0.18)";
  toast.style.boxShadow = "0 12px 36px -4px rgba(0, 0, 0, 0.55)";
  toast.style.color = "#fff";
  toast.style.fontFamily = "system-ui, -apple-system, sans-serif";
  toast.style.transition = "all 0.3s cubic-bezier(0.16, 1, 0.3, 1)";
  toast.style.transform = "translateX(50px)";
  toast.style.opacity = "0";

  if (url) {
    toast.style.cursor = "pointer";
  }

  const actionLink = url
    ? `<div style="font-size:11px;color:#34d399;font-weight:600;margin-top:6px;display:flex;align-items:center;gap:4px;">
        <span>点击查看详情</span>
        <span style="font-size:12px;">→</span>
       </div>`
    : "";

  toast.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:10px;">
      <div style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#7C3AED,#3B82F6);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px;">
        🔔
      </div>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:600;margin-bottom:3px;color:#fff;">${title}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.75);line-height:1.4;">${body}</div>
        ${actionLink}
      </div>
    </div>
  `;

  if (url) {
    toast.onclick = (e) => {
      e.stopPropagation();
      toast.remove();
      if (typeof window !== "undefined") {
        const win = window as unknown as { __memento_navigate?: (u: string) => void };
        if (typeof win.__memento_navigate === "function") {
          win.__memento_navigate(url);
        } else if (url.startsWith("/")) {
          window.location.href = url;
        } else {
          window.location.assign(url);
        }
      }
    };
  }

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.transform = "translateX(0)";
    toast.style.opacity = "1";
  });

  setTimeout(() => {
    toast.style.transform = "translateX(50px)";
    toast.style.opacity = "0";
    setTimeout(() => {
      toast.remove();
      if (container && container.childNodes.length === 0) {
        container.remove();
      }
    }, 300);
  }, 5000);
}

const DEDUP_WINDOW_MS = 120_000;
const _recentLocalNotifications = new Map<string, number>();

function extractCoreBody(body: string): string {
  let core = (body || "").trim();
  const colonIdx = core.indexOf("：");
  if (colonIdx !== -1) {
    core = core.slice(colonIdx + 1).trim();
  }
  const alertIdx = core.indexOf("（期间 ");
  if (alertIdx !== -1) {
    core = core.slice(0, alertIdx).trim();
  }
  return core;
}

function isDuplicateLocalNotification(title: string, body: string, url?: string): boolean {
  const now = Date.now();
  for (const [k, ts] of _recentLocalNotifications.entries()) {
    if (now - ts > DEDUP_WINDOW_MS) {
      _recentLocalNotifications.delete(k);
    }
  }
  const cleanTitle = (title || "").trim();
  const cleanBody = (body || "").trim();
  const coreBody = extractCoreBody(cleanBody);
  const fullKey = `${cleanTitle}:${cleanBody}`;
  const coreKey = `${cleanTitle}:${coreBody}`;
  const urlKey = url ? `${cleanTitle}:url:${url}` : "";

  if (
    _recentLocalNotifications.has(fullKey) ||
    (coreBody && _recentLocalNotifications.has(coreKey)) ||
    (urlKey && _recentLocalNotifications.has(urlKey))
  ) {
    return true;
  }

  _recentLocalNotifications.set(fullKey, now);
  if (coreBody) _recentLocalNotifications.set(coreKey, now);
  if (urlKey) _recentLocalNotifications.set(urlKey, now);
  return false;
}

export interface LocalNotificationOptions {
  skipInAppToast?: boolean;
  serverBacked?: boolean;
}

export async function sendLocalNotification(
  title: string,
  body: string,
  url?: string,
  options?: LocalNotificationOptions
): Promise<boolean> {
  if (typeof window === "undefined") return false;

  if (isDuplicateLocalNotification(title, body, url)) {
    return true;
  }

  let delivered = false;
  const desktop = (window as unknown as { mementoDesktop?: { notify?: (opts: { title: string; body: string; url?: string }) => Promise<boolean> | void } }).mementoDesktop;
  const bridge = (window as unknown as { ReactNativeWebView?: { postMessage: (msg: string) => void } }).ReactNativeWebView;

  // When serverBacked is true (e.g. task_done), Electron main.ts and Mobile native shell
  // already receive the notification via their native /api/notify/feed poller or APNs.
  // Calling desktop.notify or bridge.postMessage here as well would trigger a duplicate native popup.
  if (desktop && typeof desktop.notify === "function") {
    if (options?.serverBacked) {
      delivered = true;
    } else {
      try {
        await desktop.notify({ title, body, url });
        delivered = true;
      } catch (e) {
        console.warn("Electron native notify failed:", e);
      }
    }
  }

  if (!delivered && bridge && typeof bridge.postMessage === "function") {
    if (options?.serverBacked) {
      delivered = true;
    } else {
      try {
        bridge.postMessage(JSON.stringify({ type: "notify", title, body, url, data: { url } }));
        delivered = true;
      } catch (e) {
        console.warn("ReactNative WebView bridge notify failed:", e);
      }
    }
  }

  // 3. Web Notification API (Chrome / Safari / Edge on Mac & PC, only if not already handled by native bridge)
  if (!delivered && "Notification" in window) {
    const notifTag = url ? `memento-${url}` : `memento-${extractCoreBody(body) || Date.now()}`;
    const handleNotificationClick = () => {
      window.focus();
      if (url) {
        const win = window as unknown as { __memento_navigate?: (u: string) => void };
        if (typeof win.__memento_navigate === "function") {
          win.__memento_navigate(url);
        } else if (url.startsWith("/")) {
          window.location.href = url;
        } else {
          window.location.assign(url);
        }
      }
    };

    if (Notification.permission === "granted") {
      try {
        const notif = new Notification(title, {
          body,
          icon: "/favicon.png",
          badge: "/favicon.png",
          tag: notifTag,
        });
        notif.onclick = handleNotificationClick;
        delivered = true;
      } catch (e) {
        console.warn("Web Notification instantiation failed:", e);
      }
    } else if (Notification.permission === "default") {
      try {
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
          const notif = new Notification(title, {
            body,
            icon: "/favicon.png",
            tag: notifTag,
          });
          notif.onclick = handleNotificationClick;
          delivered = true;
        }
      } catch {
        // user declined or ignored
      }
    }
  }

  // Only show fallback in-app toast if neither native notification was delivered nor caller suppressed it
  if (!delivered && !options?.skipInAppToast) {
    showInAppToast(title, body, url);
  }

  return delivered;
}

let _pollerTimer: ReturnType<typeof setInterval> | null = null;
let _lastSeenTime = new Date().toISOString();
const _seenIds = new Set<string>();

export function startNotificationFeedPoller(): () => void {
  if (typeof window === "undefined") return () => {};
  // Both Electron desktop (main.ts) and Mobile app (index.tsx) already run their own native
  // /api/notify/feed pollers + APNs. Do not run a redundant poller inside their embedded WebView.
  const hasDesktopMainPoller = Boolean((window as unknown as { mementoDesktop?: unknown }).mementoDesktop);
  const hasMobileNativePoller = Boolean((window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView);
  if (hasDesktopMainPoller || hasMobileNativePoller) {
    return () => {};
  }
  if (_pollerTimer) return () => {};

  const poll = async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    try {
      const items = await api.getNotificationFeed(_lastSeenTime);
      if (Array.isArray(items) && items.length > 0) {
        for (const item of items) {
          if (!item.id || _seenIds.has(item.id)) continue;
          _seenIds.add(item.id);
          if (_seenIds.size > 1000) {
            const first = _seenIds.values().next().value;
            if (first) _seenIds.delete(first);
          }
          if (item.created_at && item.created_at > _lastSeenTime) {
            _lastSeenTime = item.created_at;
          }
          // If the user is actively viewing /ask in the foreground, suppress task_done popups
          const isWatchingAsk =
            window.location.pathname === "/ask" &&
            typeof document !== "undefined" &&
            document.visibilityState === "visible" &&
            (typeof document.hasFocus !== "function" || document.hasFocus());
          if (isWatchingAsk && (item.kind === "task_done" || item.title.includes("任务完成"))) {
            isDuplicateLocalNotification(item.title, item.body, item.url);
            continue;
          }
          await sendLocalNotification(item.title, item.body, item.url, {
            skipInAppToast: true,
            serverBacked: true,
          });
        }
      }
    } catch {
      // ignore network errors
    }
  };

  void poll();
  _pollerTimer = setInterval(() => void poll(), 6000);

  return () => {
    if (_pollerTimer) {
      clearInterval(_pollerTimer);
      _pollerTimer = null;
    }
  };
}

