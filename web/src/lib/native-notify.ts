"use client";

/**
 * Universal Native Notification Service for Memento.
 * Supports:
 * 1. Electron Desktop App (Mac, Windows, Linux) via window.mementoDesktop.notify
 * 2. Standard Web Browser Notifications API (Notification.requestPermission + new Notification)
 * 3. Mobile App (iOS / Android) WebView Bridge via window.ReactNativeWebView.postMessage
 * 4. In-App Glass Toast Fallback (when system notifications are blocked or in Do Not Disturb)
 */

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
        if (typeof (window as any).__memento_navigate === "function") {
          (window as any).__memento_navigate(url);
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

export async function sendLocalNotification(title: string, body: string, url?: string): Promise<boolean> {
  if (typeof window === "undefined") return false;

  const dedupKey = `${title}:${body}`;
  if (_recentLocalNotifications.has(dedupKey)) {
    return true;
  }
  _recentLocalNotifications.add(dedupKey);
  setTimeout(() => {
    _recentLocalNotifications.delete(dedupKey);
  }, 4000);

  let delivered = false;

  // 1. Electron Desktop App
  const desktop = (window as unknown as { mementoDesktop?: { notify?: (opts: { title: string; body: string; url?: string }) => Promise<boolean> | void } }).mementoDesktop;
  if (desktop && typeof desktop.notify === "function") {
    try {
      await desktop.notify({ title, body, url });
      delivered = true;
    } catch (e) {
      console.warn("Electron native notify failed:", e);
    }
  }

  // 2. Mobile App (iOS / Android) WebView Bridge
  const bridge = (window as unknown as { ReactNativeWebView?: { postMessage: (msg: string) => void } }).ReactNativeWebView;
  if (bridge && typeof bridge.postMessage === "function") {
    try {
      bridge.postMessage(JSON.stringify({ type: "notify", title, body, url, data: { url } }));
      delivered = true;
    } catch (e) {
      console.warn("ReactNative WebView bridge notify failed:", e);
    }
  }

  // 3. Web Notification API (Chrome / Safari / Edge on Mac & PC, only if not already delivered by native bridge)
  if (!delivered && "Notification" in window) {
    const handleNotificationClick = () => {
      window.focus();
      if (url) {
        if (typeof (window as any).__memento_navigate === "function") {
          (window as any).__memento_navigate(url);
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
          tag: `memento-${Date.now()}`,
        });
        notif.onclick = handleNotificationClick;
        delivered = true;
      } catch (e) {
        console.warn("Web Notification instantiation failed:", e);
      }
    } else if (Notification.permission === "default") {
      // Auto-prompt permission if user just clicked an action
      try {
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
          const notif = new Notification(title, {
            body,
            icon: "/favicon.png",
            tag: `memento-${Date.now()}`,
          });
          notif.onclick = handleNotificationClick;
          delivered = true;
        }
      } catch {
        // user declined or ignored
      }
    }
  }

  // Always show in-app toast for visual confirmation and instant mobile tapping
  showInAppToast(title, body, url);

  return delivered;
}

const _recentLocalNotifications = new Set<string>();
let _pollerTimer: ReturnType<typeof setInterval> | null = null;
let _lastSeenTime = new Date().toISOString();
const _seenIds = new Set<string>();

export function startNotificationFeedPoller(): () => void {
  if (typeof window === "undefined") return () => {};
  // 在移动端 App (ReactNativeWebView) 与桌面端 (mementoDesktop) 中由原生层主进程直接管理后台通知拉取与系统弹窗，Web 层无需重复轮询
  if (
    (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView ||
    (window as unknown as { mementoDesktop?: unknown }).mementoDesktop
  ) {
    return () => {};
  }
  if (_pollerTimer) return () => {};

  const poll = async () => {
    try {
      const { api } = await import("./api-client");
      const items = await api.getNotificationFeed(_lastSeenTime);
      if (Array.isArray(items) && items.length > 0) {
        for (const item of items) {
          if (!item.id || _seenIds.has(item.id)) continue;
          _seenIds.add(item.id);
          if (item.created_at && item.created_at > _lastSeenTime) {
            _lastSeenTime = item.created_at;
          }
          await sendLocalNotification(item.title, item.body, item.url);
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

