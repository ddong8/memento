"use client";

import { useEffect, useState } from "react";
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

/** Push notifications: Memento local desktop/web system notification, native mobile app and optional fallback (Bark / ntfy). */
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

  useEffect(() => {
    setLocalPermission(getLocalNotificationPermission());
    const stopPoller = startNotificationFeedPoller();

    api
      .getNotifySettings()
      .then(setSettings)
      .catch((e: Error) => setMessage({ text: e.message, error: true }));

    return () => stopPoller();
  }, []);

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
          "🎉 本机系统通知已就绪",
          "已成功开启 Memento 本机通知权限，您将在此实时接收日程与关键任务更新！"
        );
        setMessage({ text: "本机通知权限已开启并成功弹出测试通知！", error: false });
      } else {
        setMessage({
          text: "未能开启系统通知。若此前曾拒绝，请在浏览器或系统设置中允许 Memento 发送通知。",
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
      const isMobileApp =
        typeof window !== "undefined" &&
        !!(window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;

      // 1. 如果在桌面端或纯网页浏览器端，立即触发本机通知权限测试
      if (!isMobileApp) {
        await sendLocalNotification(
          "🔔 Memento 本机通知测试",
          "收到这条说明您当前这台设备的系统通知已完全通畅！危险操作与简报都将在此弹出。",
          "/profile?tab=account"
        );
        setLocalPermission(getLocalNotificationPermission());
      }

      // 2. 触发服务端测试通知（移动端 App 会通过原生通道接收并弹出，全终端设备同步）
      try {
        await api.sendTestNotification();
      } catch (e) {
        console.warn("Backend test notification dispatch returned:", e);
      }

      setMessage({ text: "✅ 测试通知已发送，正在同步至您的设备！", error: false });
    });

  const barkConfigured = settings?.bark_configured === true;
  const nativeConfigured = settings?.native_configured === true;
  const deviceCount = Number(settings?.device_tokens_count ?? 0);

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
      {/* 1. Local Device / Desktop Notification Channel */}
      <div className="mb-4 p-3.5 rounded-xl bg-[var(--aurora-chip)] border border-[var(--aurora-border)] leading-relaxed">
        <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
          <span className="text-sm font-semibold text-[var(--aurora-fg1)] flex items-center gap-1.5">
            💻 本机系统通知 (Desktop / Web Notifications)
          </span>
          <div className="flex items-center gap-2">
            <span
              className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${
                isLocalGranted
                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                  : "bg-amber-500/15 text-amber-500 border border-amber-500/30"
              }`}
            >
              {isLocalGranted ? "● 本机通知已就绪" : "待授权系统通知"}
            </span>
            {!isLocalGranted && (
              <button
                type="button"
                onClick={handleRequestPermission}
                disabled={requestingPerm}
                className="text-xs px-2.5 py-0.5 rounded-lg bg-[var(--aurora-accent)] text-white hover:opacity-90 transition-all cursor-pointer border-0 font-medium"
              >
                {requestingPerm ? "授权中..." : "一键开启本机通知"}
              </button>
            )}
          </div>
        </div>
        <p className="text-xs text-[var(--aurora-fg3)] m-0">
          支持 Mac、Windows、Linux 及主流浏览器原生横幅通知。无需安装任何第三方应用，只要处于开启状态，有新简报或高危操作提醒时将直接在屏幕右上角弹窗提示。
        </p>
      </div>

      {/* 2. Memento Native Mobile App Channel */}
      <div className="mb-4 p-3.5 rounded-xl bg-[var(--aurora-chip)] border border-[var(--aurora-border)] leading-relaxed">
        <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
          <span className="text-sm font-semibold text-[var(--aurora-fg1)] flex items-center gap-1.5">
            📱 {n.nativeTitle}
          </span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              nativeConfigured
                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                : "bg-[var(--aurora-border)] text-[var(--aurora-fg3)]"
            }`}
          >
            {nativeConfigured ? `已激活（${deviceCount} 台设备）` : "未连接移动端"}
          </span>
        </div>
        <p className="text-xs text-[var(--aurora-fg3)] m-0">
          {nativeConfigured
            ? "Memento 移动端（iOS / Android）已自动注册系统原生推送，危险操作、任务完成与 AI 建议将直接弹出锁屏通知与响铃。"
            : "Memento 移动端自带系统级原生通知！只需在手机端打开并登录 Memento，即可自动注册原生推送通道，无需下载 Bark 等任何第三方应用。"}
        </p>
      </div>

      {/* Test notification button */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Btn variant="glass" size="sm" disabled={busy} onClick={test} className="cursor-pointer font-medium">
          ⚡ 立即测试本机与全平台通知
        </Btn>
        <button
          type="button"
          onClick={() => setShowFallback((prev) => !prev)}
          className="text-xs text-[var(--aurora-accent)] hover:underline bg-transparent border-0 cursor-pointer p-0"
        >
          {showFallback ? "收起备用外部通道 (Bark/ntfy)" : "配置备用外部通道 (Bark/ntfy)..."}
        </button>
      </div>

      {/* 3. Optional Fallback Channel (Bark / ntfy) */}
      {(showFallback || barkConfigured) && (
        <div className="mb-4 p-3 rounded-xl border border-[var(--aurora-border-strong)] bg-[var(--aurora-surface-solid)]/40">
          <div className="text-xs font-semibold text-[var(--aurora-fg2)] mb-1.5 flex items-center gap-1">
            🔔 {n.fallbackTitle}
          </div>
          <div className="text-xs text-[var(--aurora-fg3)] mb-2 space-y-0.5">
            <div>如未安装 Memento 移动客户端，可选填 Bark (iOS) 或 ntfy (Android) 作为备用推送地址：</div>
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

      {/* Notification Category Switches */}
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
