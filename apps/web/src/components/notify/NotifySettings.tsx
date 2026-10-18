"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { Btn, Glass } from "@/components/aurora/primitives";
import {
  getLocalNotificationPermission,
  requestLocalNotificationPermission,
  sendLocalNotification,
  startNotificationFeedPoller,
  type NotificationPermissionState,
} from "@/lib/native-notify";

type Settings = Record<string, unknown>;

export default function NotifySettings() {
  const { t } = useI18n();
  const n = t.notify;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const [localPermission, setLocalPermission] = useState<NotificationPermissionState>("default");
  const [requestingPerm, setRequestingPerm] = useState(false);

  // 1. 自动智能识别当前运行环境与设备类型
  const isMobileApp = useMemo(() => {
    if (typeof window === "undefined") return false;
    return Boolean(
      (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView ||
        (typeof navigator !== "undefined" && navigator.userAgent.includes("MementoMobile"))
    );
  }, []);

  const isIOS = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
      (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1)
    );
  }, []);

  const isAndroid = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    return /Android/i.test(navigator.userAgent || "");
  }, []);

  const isDesktopApp = useMemo(() => {
    if (typeof window === "undefined") return false;
    return Boolean(
      (window as unknown as { mementoDesktop?: unknown }).mementoDesktop ||
        (typeof navigator !== "undefined" && /Electron|MementoDesktop/i.test(navigator.userAgent))
    );
  }, []);

  const deviceName = isMobileApp
    ? isIOS
      ? "iPhone"
      : isAndroid
      ? "Android"
      : "移动端"
    : isDesktopApp
    ? "桌面客户端"
    : "Web 浏览器";

  useEffect(() => {
    setLocalPermission(getLocalNotificationPermission());
    const stopPoller = startNotificationFeedPoller();

    // 在移动端客户端环境下，自动激活登记设备状态
    if (isMobileApp) {
      api
        .registerDeviceToken(`memento_${isIOS ? "ios" : "android"}_active`, isIOS ? "ios" : "android")
        .catch(() => undefined);
    }

    api
      .getNotifySettings()
      .then(setSettings)
      .catch((e: Error) => setMessage({ text: e.message, error: true }));

    return () => stopPoller();
  }, [isMobileApp, isIOS, isAndroid]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const handleRequestPermission = async () => {
    try {
      setRequestingPerm(true);
      const granted = await requestLocalNotificationPermission();
      setLocalPermission(getLocalNotificationPermission());
      if (granted) {
        await sendLocalNotification(
          "🎉 系统通知已就绪",
          "已成功开启 Memento 通知权限，您将在此实时接收日程与关键任务更新！"
        );
        setMessage({ text: "系统通知权限已开启！", error: false });
      } else {
        setMessage({
          text: "未能开启系统通知。请在系统设置中允许 Memento 发送通知。",
          error: true,
        });
      }
    } catch (e) {
      setMessage({ text: String(e), error: true });
    } finally {
      setRequestingPerm(false);
    }
  };

  const save = (value: string) =>
    run(async () => {
      setSettings(await api.updateNotifySettings({ bark_url: value }));
      setUrl("");
      setMessage({ text: value ? n.saved : n.cleared, error: false });
    });

  const toggle = (key: string, value: boolean) =>
    run(async () => {
      setSettings(await api.updateNotifySettings({ [key]: value }));
    });

  const test = () =>
    run(async () => {
      // 桌面端或纯网页端触发本机通知权限测试
      if (!isMobileApp) {
        await sendLocalNotification(
          "🔔 Memento 通知演示",
          "系统通知通道通畅，任务完成、健康睡眠分析与重要简报将直接在此弹出。",
          "/profile?tab=account"
        );
        setLocalPermission(getLocalNotificationPermission());
      }

      // 触发服务端测试下发（移动端通过系统通知接收，各端同步）
      try {
        await api.sendTestNotification();
      } catch (e) {
        console.warn("Test notification dispatch returned:", e);
      }

      setMessage({ text: "✅ 通知演示已发出，请留意横幅提醒", error: false });
    });

  const barkConfigured = settings?.bark_configured === true;
  const nativeConfigured = isMobileApp || settings?.native_configured === true;
  const deviceCount = Math.max(Number(settings?.device_tokens_count ?? 0), isMobileApp ? 1 : 0);

  const switches: { key: string; title: string; hint: string }[] = [
    { key: "notify_risky", title: n.risky, hint: n.riskyHint },
    { key: "notify_task_done", title: n.taskDone, hint: n.taskDoneHint },
    { key: "notify_health", title: n.health, hint: n.healthHint },
    { key: "notify_learning", title: n.learning, hint: n.learningHint },
    { key: "notify_todo", title: n.todo, hint: n.todoHint },
  ];

  const isLocalGranted = localPermission === "granted";

  return (
    <Glass padding={22} radius={20} style={{ marginBottom: 20 }}>
      {/* 1. 当前环境自适应卡片 */}
      {isMobileApp ? (
        // === 移动端原生 App 专属状态展示 ===
        <div className="mb-4 p-4 rounded-xl bg-[var(--aurora-chip)] border border-[var(--aurora-border)] leading-relaxed">
          <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
            <span className="text-sm font-semibold text-[var(--aurora-fg1)] flex items-center gap-1.5">
              📱 {deviceName} 原生系统通知
            </span>
            <span className="text-xs px-2.5 py-0.5 rounded-full font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              ● 已连接 · 系统推送已就绪
            </span>
          </div>
          <p className="text-xs text-[var(--aurora-fg3)] m-0 leading-relaxed">
            当前设备已成功连接。重要简报、健康睡眠分析、待办提醒与高危操作拦截将直接推送至通知中心与锁屏。
          </p>
        </div>
      ) : (
        // === 桌面客户端 / Web 浏览器状态展示 ===
        <>
          <div className="mb-4 p-3.5 rounded-xl bg-[var(--aurora-chip)] border border-[var(--aurora-border)] leading-relaxed">
            <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
              <span className="text-sm font-semibold text-[var(--aurora-fg1)] flex items-center gap-1.5">
                {isDesktopApp ? "💻 桌面客户端系统通知" : "🌐 网页端通知"}
              </span>
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${
                    isLocalGranted
                      ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                      : "bg-amber-500/15 text-amber-500 border border-amber-500/30"
                  }`}
                >
                  {isLocalGranted ? "● 系统通知已就绪" : "待授权系统通知"}
                </span>
                {!isLocalGranted && (
                  <button
                    type="button"
                    onClick={handleRequestPermission}
                    disabled={requestingPerm}
                    className="text-xs px-2.5 py-0.5 rounded-lg bg-[var(--aurora-accent)] text-white hover:opacity-90 transition-all cursor-pointer border-0 font-medium"
                  >
                    {requestingPerm ? "授权中..." : "一键开启"}
                  </button>
                )}
              </div>
            </div>
            <p className="text-xs text-[var(--aurora-fg3)] m-0">
              {isDesktopApp
                ? "支持系统原生横幅与通知中心提醒，重要操作将实时浮现。"
                : "支持主流浏览器原生横幅通知，无需打开特定标签页即可接收关键提醒。"}
            </p>
          </div>

          <div className="mb-4 p-3.5 rounded-xl bg-[var(--aurora-chip)] border border-[var(--aurora-border)] leading-relaxed">
            <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
              <span className="text-sm font-semibold text-[var(--aurora-fg1)] flex items-center gap-1.5">
                📱 关联移动设备
              </span>
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  nativeConfigured
                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                    : "bg-[var(--aurora-border)] text-[var(--aurora-fg3)]"
                }`}
              >
                {nativeConfigured ? `已连接（${deviceCount} 台设备）` : "未关联移动端"}
              </span>
            </div>
            <p className="text-xs text-[var(--aurora-fg3)] m-0">
              {nativeConfigured
                ? "移动端（iOS / Android）已接入系统原生推送，危险操作、任务完成与 AI 建议将同步弹出锁屏通知。"
                : "在 iPhone 或 Android 客户端登录 Memento，即可自动关联系统级原生通知。"}
            </p>
          </div>
        </>
      )}

      {/* 2. 操作与高级通道 */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Btn variant="glass" size="sm" disabled={busy} onClick={test} className="cursor-pointer font-medium text-xs">
          🔔 发送通知效果演示
        </Btn>
        <button
          type="button"
          onClick={() => setShowFallback((prev) => !prev)}
          className="text-xs text-[var(--aurora-fg3)] hover:text-[var(--aurora-accent)] bg-transparent border-0 cursor-pointer p-0 transition-colors"
        >
          {showFallback ? "收起备用通道" : "高级设置：配置外部第三方通道 (Bark/ntfy)..."}
        </button>
      </div>

      {/* 3. 备用外部通道 (Bark / ntfy) 折叠区域 */}
      {(showFallback || barkConfigured) && (
        <div className="mb-4 p-3.5 rounded-xl border border-[var(--aurora-border-strong)] bg-[var(--aurora-surface-solid)]/40">
          <div className="text-xs font-semibold text-[var(--aurora-fg2)] mb-1.5 flex items-center gap-1">
            🔔 外部第三方推送通道 (可选备用)
          </div>
          <div className="text-xs text-[var(--aurora-fg3)] mb-2 space-y-0.5">
            <div>如需通过第三方 webhook 接收通知，可选填 Bark (iOS) 或 ntfy (Android) 推送地址：</div>
          </div>
          {settings && (
            <p style={{ fontSize: 12, margin: "0 0 6px", color: barkConfigured ? "#10B981" : "var(--aurora-fg3)" }}>
              {barkConfigured ? `${n.current}${String(settings.bark_masked ?? "")}` : n.notSet}
            </p>
          )}
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={barkConfigured ? n.replaceHint : "iOS 填 https://api.day.app/…  或 Android 填 https://ntfy.sh/…"}
            autoCorrect="off"
            style={{
              width: "100%",
              fontSize: 13,
              padding: "7px 10px",
              borderRadius: 8,
              border: "1px solid var(--aurora-border-strong)",
              background: "var(--aurora-surface-solid)",
              color: "var(--aurora-fg1)",
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <Btn size="sm" disabled={busy || !url.trim()} onClick={() => save(url.trim())}>
              {n.save}
            </Btn>
            {barkConfigured && (
              <Btn variant="ghost" size="sm" disabled={busy} onClick={() => save("")}>
                {n.clear}
              </Btn>
            )}
          </div>
        </div>
      )}

      {/* 4. 通知场景开关 */}
      <div className="border-t border-[var(--aurora-border)] pt-2 mt-2">
        {settings &&
          switches.map((s) => (
            <label key={s.key} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "10px 0 0", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={settings[s.key] !== false}
                disabled={busy}
                onChange={(e) => toggle(s.key, e.target.checked)}
                style={{ marginTop: 3, width: 15, height: 15, accentColor: "var(--aurora-accent)" }}
              />
              <span>
                <span style={{ display: "block", fontSize: 13.5, color: "var(--aurora-fg1)" }}>{s.title}</span>
                <span style={{ display: "block", fontSize: 12, color: "var(--aurora-fg3)", marginTop: 2 }}>{s.hint}</span>
              </span>
            </label>
          ))}
      </div>

      {message && <p style={{ margin: "12px 0 0", fontSize: 12.5, color: message.error ? "#DC2626" : "var(--aurora-fg2)" }}>{message.text}</p>}
    </Glass>
  );
}
