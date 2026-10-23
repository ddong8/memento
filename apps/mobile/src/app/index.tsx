import Constants from "expo-constants";
import { Redirect } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  BackHandler,
  Keyboard,
  type KeyboardEvent,
  LayoutAnimation,
  Linking,
  Platform,
  Pressable,
  Settings,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent, type WebViewNavigation, type WebViewProps } from "react-native-webview";

import { Icon, type IconName } from "../components/Icon";
import { Button } from "../components/ui";
import { normalizeDeepLinkTarget, parseDeepLinkAction, subscribeDeepLinkTarget } from "../lib/deeplink";
import { isRecentlyNotified, markAsNotified, triggerLocalNotification } from "../lib/notifications";
import { loadLocalSnapshot, saveLocalSnapshot, SNAPSHOT_CONVOS_KEY, useSession } from "../lib/session";
import { useTheme } from "../lib/theme";

type TabId = "ask" | "memory" | "daily" | "inbox" | "profile";

const TABS: Array<{ id: TabId; label: string; icon: IconName; path: string }> = [
  { id: "ask", label: "AI 执事", icon: "message", path: "/ask" },
  { id: "memory", label: "认知大脑", icon: "brain", path: "/memory" },
  { id: "daily", label: "作息节律", icon: "clock", path: "/daily" },
  { id: "inbox", label: "工作待办", icon: "layers", path: "/inbox" },
  { id: "profile", label: "个人中心", icon: "user", path: "/profile" },
];

// The web app is the interface, elevated with iOS/Android native haptic feedback,
// fluid momentum scrolling, and custom micro-interactions to deliver a true native feel.
const INJECTED_CLIENT_HELPERS = `(() => {
  document.documentElement.classList.add("memento-native-shell");
  if (window.__memento_native_helpers_installed) return;
  window.__memento_native_helpers_installed = true;

  // 1. Theme tracking
  const postTheme = () => {
    const root = document.documentElement;
    const bg = getComputedStyle(document.body || root).backgroundColor;
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "theme", bg, dark: root.getAttribute("data-theme") === "dark" }));
    }
  };
  postTheme();
  new MutationObserver(postTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin"] });

  // 2. Apple Taptic Engine Native Haptics Bridge
  window.__memento_haptic = function(style) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: "haptic", style: style || "light" }));
      }
    } catch (e) {}
  };

  // 3. Native Share Bridge
  if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
    window.navigator.share = function(data) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: "share",
          url: (data && data.url) || "",
          title: (data && data.title) || "",
          text: (data && data.text) || "",
        }));
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    };
  }

  // 4. Global touch event delegation: automatically fire native haptic vibration on button / tab taps
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  window.addEventListener("touchstart", function(e) {
    if (e.touches && e.touches[0]) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
    }
  }, { passive: true });

  window.addEventListener("touchend", function(e) {
    const dt = Date.now() - touchStartTime;
    if (dt < 450 && e.changedTouches && e.changedTouches[0]) {
      const dx = Math.abs(e.changedTouches[0].clientX - touchStartX);
      const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
      if (dx < 12 && dy < 12) {
        const t = e.target;
        const el = t && t.closest ? t.closest("button, a, [role='button'], [role='tab'], input[type='checkbox'], input[type='radio'], input[type='submit'], select") : null;
        if (el) {
          const role = el.getAttribute("role");
          const isTab = role === "tab" || (el.className && typeof el.className === "string" && el.className.indexOf("tab") !== -1);
          window.__memento_haptic(isTab ? "selection" : "light");
        }
      }
    }
  }, { passive: true });

  // 5. Inject Ultra-Native iOS Styles to completely eliminate browser artifacts
  const nativeStyle = document.createElement("style");
  nativeStyle.innerHTML = \`
    *, *::before, *::after {
      -webkit-tap-highlight-color: transparent !important;
      -webkit-touch-callout: none !important;
    }
    html, body {
      background-color: #0b0f19 !important;
      color: #f1f5f9 !important;
      -webkit-font-smoothing: antialiased !important;
      -moz-osx-font-smoothing: grayscale !important;
      text-rendering: optimizeLegibility !important;
      overscroll-behavior-y: none !important;
      max-width: 100vw !important;
      width: 100% !important;
      overflow-x: hidden !important;
      -webkit-text-size-adjust: 100% !important;
    }
    input, textarea, select {
      font-size: 16px !important;
      max-width: 100% !important;
    }
    body {
      -webkit-user-select: none !important;
      user-select: none !important;
    }
    p, pre, code, [data-selectable], .selectable, .prose, input, textarea {
      -webkit-user-select: text !important;
      user-select: text !important;
      -webkit-touch-callout: default !important;
    }
    pre {
      background-color: #0b0f19 !important;
      color: #f1f5f9 !important;
      white-space: pre-wrap !important;
      word-break: break-word !important;
      padding: 16px !important;
      font-size: 13.5px !important;
      line-height: 1.6 !important;
    }
    button:active:not(:disabled),
    [role="button"]:active,
    .btn:active,
    nav a:active {
      transform: scale(0.975) !important;
      transition: transform 0.08s cubic-bezier(0.25, 1, 0.5, 1) !important;
      opacity: 0.9 !important;
    }
    ::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
    * {
      -webkit-overflow-scrolling: touch !important;
    }
  \`;
  (document.head || document.documentElement).appendChild(nativeStyle);

  // 6. Viewport scale lock: permanently prevent iOS keyboard auto-zoom
  let vMeta = document.querySelector('meta[name="viewport"]');
  if (!vMeta) {
    vMeta = document.createElement('meta');
    vMeta.name = 'viewport';
    (document.head || document.documentElement).appendChild(vMeta);
  }
  vMeta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';

  // 7. Route tracking for native TabBar synchronization
  const postRoute = () => {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "route", path: window.location.pathname }));
    }
  };
  postRoute();

  const wrapHistory = (method) => {
    const orig = history[method];
    return function(...args) {
      const ret = orig.apply(this, args);
      postRoute();
      return ret;
    };
  };
  history.pushState = wrapHistory("pushState");
  history.replaceState = wrapHistory("replaceState");
  window.addEventListener("popstate", postRoute);
  // 8. Robust Alert Fallback Bridge: never let alert() get silently swallowed
  window.alert = function(msg) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: "notify", title: "Memento 提示", body: String(msg) }));
      }
    } catch (e) {}
  };
})();
true;`;

type ShouldStartLoadRequest = Parameters<NonNullable<WebViewProps["onShouldStartLoadWithRequest"]>>[0];

const USER_AGENT_SUFFIX = `MementoMobile/${Constants.expoConfig?.version ?? "0"}`;

function sameOrigin(url: string, origin: string): boolean {
  return url.startsWith(origin) && /^(?:[/?#]|$)/.test(url.slice(origin.length));
}

function isLoginPage(url: string, origin: string): boolean {
  return sameOrigin(url, origin) && /^\/auth\/login(?:[/?#]|$)/.test(url.slice(origin.length));
}

export default function WebShell() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { ready, server, token, signOut, switchServer } = useSession();
  const web = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const pendingUrlRef = useRef<string | null>(null);
  const [page, setPage] = useState<{ bg: string; dark: boolean } | null>(null);
  const [activeTab, setActiveTab] = useState<TabId | null>("ask");
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [offlineSnapshot, setOfflineSnapshot] = useState<Array<{ id: string; title: string; time?: string }> | null>(null);

  useEffect(() => {
    void (async () => {
      const cached = await loadLocalSnapshot<Array<{ id: string; title: string; time?: string }>>(SNAPSHOT_CONVOS_KEY);
      if (cached && Array.isArray(cached) && cached.length > 0) {
        setOfflineSnapshot(cached);
      }
    })();
  }, []);

  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvt, (e: KeyboardEvent) => {
      if (Platform.OS === "ios") {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      }
      setKeyboardVisible(true);
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => {
      if (Platform.OS === "ios") {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      }
      setKeyboardVisible(false);
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const origin = useMemo(() => server.match(/^https?:\/\/[^/]+/i)?.[0] ?? server, [server]);
  // Sign the page in with the app's token, then land directly on the Command Center (/ask).
  const start = useMemo(() => (token ? `${origin}/auth/handoff#token=${encodeURIComponent(token)}&next=%2Fask` : null), [origin, token]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!canGoBack.current) return false;
      web.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, []);

  const handleUrl = useCallback(
    (rawTarget?: string | null) => {
      const actionData = parseDeepLinkAction(rawTarget);
      if (actionData?.action === "cancel" && actionData.conversationId && token) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        const base = origin.replace(/\/+$/, "");
        fetch(`${base}/api/ask/conversations/${actionData.conversationId}/cancel`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => undefined);
        web.current?.injectJavaScript(`
          try {
            if (typeof window.__memento_stop_task === 'function') {
              window.__memento_stop_task(${JSON.stringify(actionData.conversationId)});
            }
          } catch(e) {}
          true;
        `);
      }

      const target = normalizeDeepLinkTarget(rawTarget);
      if (!target || target === "/") return;
      const fullUrl = target.startsWith("http") ? target : `${origin}${target.startsWith("/") ? "" : "/"}${target}`;
      const path = target.startsWith("http") ? new URL(target).pathname : target.split("?")[0];
      const matched = TABS.find((tab) => path === tab.path || path.startsWith(tab.path + "/"));
      if (matched) setActiveTab(matched.id);

      if (web.current && initialLoaded) {
        const js = `
          if (typeof window.__memento_navigate === 'function') {
            window.__memento_navigate(${JSON.stringify(fullUrl)});
          } else {
            window.location.assign(${JSON.stringify(fullUrl)});
          }
          true;
        `;
        web.current.injectJavaScript(js);
        try {
          web.current.postMessage(JSON.stringify({ type: "deep_link", url: fullUrl, timestamp: Date.now() }));
        } catch {}
      } else {
        pendingUrlRef.current = fullUrl;
      }
    },
    [origin, initialLoaded],
  );

  // Open destination URL when a native push notification or Dynamic Island deep link is tapped
  useEffect(() => {

    const unsubDeepLink = subscribeDeepLinkTarget((targetPath) => {
      handleUrl(targetPath);
    });

    void Linking.getInitialURL().then((initialUrl) => {
      if (initialUrl) handleUrl(initialUrl);
    });

    const linkSub = Linking.addEventListener("url", (event) => {
      if (event?.url) handleUrl(event.url);
    });

    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        const c = response.notification.request.content;
        markAsNotified(c.title, c.body, response.notification.request.identifier);
        const target = (c.data?.url || (c as any)?.url) as string | undefined;
        handleUrl(target);
      }
    });

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      if (response) {
        const c = response.notification.request.content;
        markAsNotified(c.title, c.body, response.notification.request.identifier);
        const target = (c.data?.url || (c as any)?.url) as string | undefined;
        handleUrl(target);
      }
    });

    return () => {
      unsubDeepLink();
      linkSub.remove();
      sub.remove();
    };
  }, [handleUrl]);

  const onNavigation = useCallback(
    (nav: WebViewNavigation) => {
      canGoBack.current = nav.canGoBack;
      // The page signed out or its token expired: sign in again natively.
      if (isLoginPage(nav.url, origin)) void signOut();
    },
    [origin, signOut],
  );

  const onShouldStart = useCallback(
    (req: ShouldStartLoadRequest) => {
      if (req.isTopFrame === false) return true;
      const { url } = req;
      if (sameOrigin(url, origin)) {
        if (isLoginPage(url, origin)) {
          void signOut();
          return false;
        }
        return true;
      }
      if (/^(about|data|blob):/i.test(url)) return true;
      void Linking.openURL(url).catch(() => undefined);
      return false;
    },
    [origin, signOut],
  );

  const onOpenWindow = useCallback(
    (url: string) => {
      if (sameOrigin(url, origin)) web.current?.injectJavaScript(`window.location.assign(${JSON.stringify(url)}); true;`);
      else void Linking.openURL(url).catch(() => undefined);
    },
    [origin],
  );

  // Real-time server notification synchronization & instant native popups
  useEffect(() => {
    if (!ready || !token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let lastSeen = new Date().toISOString();

    const fetchFeed = async () => {
      try {
        const base = origin.replace(/\/+$/, "");
        const res = await fetch(`${base}/api/notify/feed?since=${encodeURIComponent(lastSeen)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const items = (await res.json()) as Array<{
            id: string;
            title: string;
            body: string;
            url?: string;
            created_at: string;
          }>;
          if (Array.isArray(items) && items.length > 0) {
            for (const item of items) {
              if (item.created_at > lastSeen) {
                lastSeen = item.created_at;
              }
              if (isRecentlyNotified(item.title, item.body, item.id)) {
                continue;
              }
              markAsNotified(item.title, item.body, item.id);
              await triggerLocalNotification(item.title, item.body, { url: item.url });
            }
          }
        }
      } catch {
        // silent on network error
      }
    };

    const startTimer = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        if (!cancelled && AppState.currentState === "active") {
          void fetchFeed();
        }
      }, 15_000);
    };

    if (AppState.currentState === "active") {
      void fetchFeed();
      startTimer();
    }

    const appStateSub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (cancelled) return;
      if (state === "active") {
        // App entered active foreground: advance lastSeen so notifications delivered by APNs while backgrounded aren't replayed
        lastSeen = new Date().toISOString();
        void fetchFeed();
        startTimer();
        // Immediately wake any sleeping streams or background polling in WebView
        web.current?.injectJavaScript("window.dispatchEvent(new Event('memento_app_active')); window.dispatchEvent(new Event('memento_wake_stream')); true;");
        if (pendingUrlRef.current) {
          const u = pendingUrlRef.current;
          pendingUrlRef.current = null;
          handleUrl(u);
        }
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      appStateSub.remove();
    };
  }, [ready, token, origin, handleUrl]);

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as {
        type?: string;
        bg?: string;
        dark?: boolean;
        title?: string;
        body?: string;
        url?: string;
        text?: string;
        data?: Record<string, unknown>;
      };
      if (msg.type === "theme" && msg.bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(msg.bg)) {
        setPage({ bg: msg.bg, dark: !!msg.dark });
      } else if (msg.type === "route") {
        const path = (msg as { path?: string }).path || "";
        const matched = TABS.find((tab) => path === tab.path || path.startsWith(tab.path + "/"));
        setActiveTab(matched ? matched.id : null);
      } else if (msg.type === "haptic") {
        const style = (msg as { style?: string }).style || "light";
        if (style === "selection") {
          void Haptics.selectionAsync();
        } else if (style === "medium") {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        } else if (style === "heavy") {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        } else if (style === "success") {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else if (style === "warning") {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        } else if (style === "error") {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        } else {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
      } else if (msg.type === "notify" && msg.title) {
        if (!isRecentlyNotified(msg.title, msg.body || "")) {
          markAsNotified(msg.title, msg.body || "");
          const notifData = { url: (msg as any).url, ...((msg as any).data || {}) };
          void triggerLocalNotification(msg.title, msg.body || "", notifData);
        }
      } else if (msg.type === "share" && (msg.url || (msg as any).text)) {
        const targetUrl = msg.url || "";
        const targetTitle = msg.title || "Memento";
        const shareContent: { url?: string; message: string; title?: string } = {
          title: targetTitle,
          message: Platform.OS === "ios" ? (targetTitle ? `${targetTitle}\n` : "") : (targetUrl ? `${targetTitle}\n${targetUrl}` : targetTitle),
        };
        if (Platform.OS === "ios" && targetUrl) {
          shareContent.url = targetUrl;
        }
        void Share.share(shareContent).catch(() => undefined);
      } else if (msg.type === "live_activity" && Platform.OS === "ios") {
        try {
          Settings.set({
            memento_live_activity_cmd: JSON.stringify({
              ...msg,
              ts: Date.now(),
            }),
          });
        } catch {}
      } else if (msg.type === "server:switch" && (msg as { server?: string }).server) {
        // Only memento's own page may ask, and the user confirms natively, where a script on the page can't tap for them.
        const from = (e.nativeEvent.url || "").match(/^https?:\/\/[^/]+/i)?.[0]?.toLowerCase();
        const target = String((msg as { server: string }).server).trim().replace(/\/+$/, "");
        const reset = (msg as { resetAuth?: boolean }).resetAuth !== false;
        if (from === origin.toLowerCase() && /^https?:\/\/[^/]/i.test(target)) {
          Alert.alert(
            `切换到 ${target}？`,
            reset
              ? "切换后需要在新服务器上重新登录。"
              : "将保留当前登录：登录凭据会发给新服务器。只有新地址是同一台服务器的另一个地址时才应这样做。",
            [
              { text: "取消", style: "cancel" },
              { text: "切换", onPress: () => void switchServer(target, reset) },
            ],
          );
        }
      } else if (msg.type === "snapshot" && (msg.data || (msg as any).conversations)) {
        const payload = msg.data || (msg as any).conversations;
        const key = (msg as { key?: string }).key || SNAPSHOT_CONVOS_KEY;
        void saveLocalSnapshot(key, payload);
        if (Array.isArray(payload)) {
          setOfflineSnapshot(payload as Array<{ id: string; title: string; time?: string }>);
        }
      }
    } catch {
      // not ours
    }
  }, [origin, switchServer]);

  if (!ready) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  if (!token || !start) return <Redirect href="/login" />;

  const bg = page?.bg ?? t.bg;
  const dark = page ? page.dark : t.scheme === "dark";

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <StatusBar style={dark ? "light" : "dark"} />
      <View style={{ height: insets.top, backgroundColor: bg }} />
      <View style={{ flex: 1, marginBottom: Platform.OS === "ios" ? keyboardHeight : 0 }}>
        <WebView
          ref={web}
          source={{ uri: start }}
          style={{ flex: 1, backgroundColor: bg }}
          applicationNameForUserAgent={USER_AGENT_SUFFIX}
          injectedJavaScript={INJECTED_CLIENT_HELPERS}
          injectedJavaScriptBeforeContentLoaded={INJECTED_CLIENT_HELPERS}
          onMessage={onMessage}
          onNavigationStateChange={onNavigation}
          onShouldStartLoadWithRequest={onShouldStart}
          onOpenWindow={(e) => onOpenWindow(e.nativeEvent.targetUrl)}
          onContentProcessDidTerminate={() => web.current?.reload()}
          onRenderProcessGone={() => web.current?.reload()}
          allowsBackForwardNavigationGestures
          pullToRefreshEnabled={true}
          bounces={true}
          overScrollMode="never"
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          dataDetectorTypes="none"
          decelerationRate="normal"
          textZoom={100}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView={true}
          allowsInlineMediaPlayback={true}
          mediaCapturePermissionGrantType="grant"
          webviewDebuggingEnabled={__DEV__}
          onLoadEnd={(e) => {
            const loadedUrl = e.nativeEvent?.url || "";
            if (loadedUrl.includes("/auth/handoff")) return;
            setInitialLoaded(true);
            if (pendingUrlRef.current && web.current) {
              const fullUrl = pendingUrlRef.current;
              pendingUrlRef.current = null;
              const js = `
                (function() {
                  if (typeof window.__memento_navigate === 'function') {
                    window.__memento_navigate(${JSON.stringify(fullUrl)});
                  } else {
                    setTimeout(function() {
                      if (typeof window.__memento_navigate === 'function') {
                        window.__memento_navigate(${JSON.stringify(fullUrl)});
                      } else {
                        window.location.assign(${JSON.stringify(fullUrl)});
                      }
                    }, 80);
                  }
                })();
                true;
              `;
              web.current.injectJavaScript(js);
            }
          }}
          renderLoading={() => (
            <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", backgroundColor: bg }]}>
              <ActivityIndicator color={t.accent} />
            </View>
          )}
          renderError={() => (
            <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", gap: 14, padding: 24, backgroundColor: t.bg }]}>
              <View style={{ alignItems: "center", gap: 6, marginBottom: 4 }}>
                <Text style={{ fontSize: 16, fontWeight: "600", color: t.fg1 }}>
                  {offlineSnapshot && offlineSnapshot.length > 0 ? "连不上 Memento（离线状态）" : "连不上 Memento"}
                </Text>
                <Text style={{ fontSize: 13, color: t.fg3, textAlign: "center" }}>
                  {offlineSnapshot && offlineSnapshot.length > 0 ? "网络暂时断开，已载入最近本地快照：" : `检查网络后重试（${origin}）`}
                </Text>
              </View>

              {offlineSnapshot && offlineSnapshot.length > 0 ? (
                <View style={{ width: "100%", maxHeight: 220, backgroundColor: t.surface, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, padding: 8, gap: 6 }}>
                  {offlineSnapshot.slice(0, 5).map((item, idx) => (
                    <View key={item.id || idx} style={{ paddingVertical: 6, paddingHorizontal: 8, borderBottomWidth: idx < Math.min(offlineSnapshot.length - 1, 4) ? StyleSheet.hairlineWidth : 0, borderBottomColor: t.border }}>
                      <Text style={{ fontSize: 13, color: t.fg1, fontWeight: "500" }} numberOfLines={1}>{item.title || "未命名会话"}</Text>
                      {item.time ? <Text style={{ fontSize: 11, color: t.fg3, marginTop: 2 }}>{item.time}</Text> : null}
                    </View>
                  ))}
                </View>
              ) : null}

              <Button onPress={() => web.current?.reload()}>重新连接</Button>
            </View>
          )}
        />
      </View>
      {!keyboardVisible ? (
        <View
          style={{
            backgroundColor: dark ? t.surface : "#FFFFFF",
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: t.border,
            paddingBottom: insets.bottom,
          }}
        >
          <View
            style={{
              height: 52,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-around",
              paddingHorizontal: 8,
            }}
          >
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const color = isActive ? t.accent : t.fg3;
              return (
                <Pressable
                  key={tab.id}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setActiveTab(tab.id);
                    const script = `(() => {
                      let targetPath = ${JSON.stringify(tab.path)};
                      if (targetPath === "/ask") {
                        if (window.location.pathname.startsWith("/ask")) {
                          return;
                        }
                        const lastId = localStorage.getItem("memento_last_ask_conv_id");
                        if (lastId) targetPath = "/ask?id=" + encodeURIComponent(lastId);
                      }
                      if (typeof window.__memento_client_push === "function") {
                        window.__memento_client_push(targetPath);
                      } else {
                        window.location.assign(${JSON.stringify(origin)} + targetPath);
                      }
                    })(); true;`;
                    web.current?.injectJavaScript(script);
                  }}
                  style={({ pressed }) => [
                    styles.tabItem,
                    { opacity: pressed ? 0.6 : 1, transform: [{ scale: pressed ? 0.92 : 1 }] },
                  ]}
                  hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
                >
                  <Icon name={tab.icon} size={22} color={color} strokeWidth={isActive ? 2.2 : 1.8} />
                  <Text style={[styles.tabLabel, { color, fontWeight: isActive ? "600" : "500" }]}>
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tabItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    paddingVertical: 4,
  },
  tabLabel: {
    fontSize: 10,
    letterSpacing: -0.2,
  },
});
