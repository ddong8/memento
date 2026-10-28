"use client";

import { useEffect, useRef, useState } from "react";
import { api, type ProactiveSettings, type AgentMissionItem } from "@/lib/api-client";
import { Glass, Btn, SectionLabel } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import { sendLocalNotification } from "@/lib/native-notify";

// Module-level in-memory cache to ensure zero-latency tab switching
let _cachedSettingsSnapshot: ProactiveSettings | null = null;
let _cachedMissionsSnapshot: AgentMissionItem[] | null = null;

// Smooth modern iOS/Aurora style toggle switch
function SmoothToggle({
  checked,
  onChange,
  disabled = false,
  size = "md",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const isSm = size === "sm";
  const w = isSm ? 38 : 46;
  const h = isSm ? 22 : 26;
  const dot = isSm ? 16 : 20;
  const off = 3;
  const on = w - dot - 3;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      className="relative shrink-0 transition-all duration-300 outline-none select-none cursor-pointer"
      style={{
        width: w,
        height: h,
        borderRadius: 9999,
        background: checked
          ? "linear-gradient(135deg, #7C3AED 0%, #6366F1 100%)"
          : "var(--aurora-chip, rgba(0, 0, 0, 0.08))",
        boxShadow: checked
          ? "0 3px 10px -2px rgba(124, 58, 237, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.3)"
          : "inset 0 1px 2px rgba(0, 0, 0, 0.08)",
        border: checked ? "1px solid rgba(255, 255, 255, 0.2)" : "1px solid var(--aurora-border, rgba(0,0,0,0.08))",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: (h - dot) / 2 - 1,
          left: checked ? on - 1 : off - 1,
          width: dot,
          height: dot,
          borderRadius: 9999,
          background: "#FFFFFF",
          boxShadow: "0 2px 5px rgba(0, 0, 0, 0.18), 0 0 1px rgba(0, 0, 0, 0.15)",
          transition: "left 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)",
        }}
      />
    </button>
  );
}

// Modern time-picker badge that triggers native system clock wheel on tap
function TimePickerBadge({
  value,
  onChange,
  label = "触发时间",
}: {
  value: string;
  onChange: (val: string) => void;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const openPicker = () => {
    if (inputRef.current) {
      if (typeof (inputRef.current as any).showPicker === "function") {
        try {
          (inputRef.current as any).showPicker();
          return;
        } catch {}
      }
      inputRef.current.focus();
      inputRef.current.click();
    }
  };

  return (
    <div
      onClick={openPicker}
      className="flex items-center justify-between px-3.5 py-2.5 rounded-xl cursor-pointer transition-all duration-200 group"
      style={{
        background: "var(--aurora-surface, rgba(255, 255, 255, 0.55))",
        border: "1px solid var(--aurora-border)",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.02)",
      }}
    >
      <div className="flex items-center gap-2 text-xs text-[var(--aurora-fg2)]">
        <Icon name="clock" size={13} style={{ color: "var(--aurora-fg3)" }} />
        <span className="font-medium">{label}</span>
      </div>
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--aurora-chip)] border border-[var(--aurora-border)] text-xs font-mono font-semibold text-[var(--aurora-accent)] group-hover:border-[var(--aurora-accent)] transition-colors">
        <span>{value || "--:--"}</span>
        <span className="text-[10px] text-[var(--aurora-fg4)]">▼</span>
        <input
          ref={inputRef}
          type="time"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="sr-only"
        />
      </div>
    </div>
  );
}

export function ProactiveAgentView() {
  const [settings, setSettings] = useState<ProactiveSettings | null>(() => _cachedSettingsSnapshot);
  const [loading, setLoading] = useState<boolean>(() => !_cachedSettingsSnapshot);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [testingBrief, setTestingBrief] = useState(false);
  const [testingReflection, setTestingReflection] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const [missions, setMissions] = useState<AgentMissionItem[]>(() => _cachedMissionsSnapshot || []);
  const [missionsLoading, setMissionsLoading] = useState<boolean>(() => !_cachedMissionsSnapshot);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const loadData = async (silent: boolean = false) => {
    if (!silent && !_cachedSettingsSnapshot) {
      setLoading(true);
      setMissionsLoading(true);
    }
    try {
      const [settingsRes, missionsRes] = await Promise.allSettled([
        api.getProactiveSettings(),
        api.getMissions(),
      ]);
      if (settingsRes.status === "fulfilled") {
        setSettings(settingsRes.value);
        _cachedSettingsSnapshot = settingsRes.value;
      } else {
        console.error("Failed to load proactive settings", settingsRes.reason);
      }
      if (missionsRes.status === "fulfilled") {
        setMissions(missionsRes.value);
        _cachedMissionsSnapshot = missionsRes.value;
      } else {
        console.error("Failed to load missions", missionsRes.reason);
      }
    } finally {
      setLoading(false);
      setMissionsLoading(false);
    }
  };

  useEffect(() => {
    loadData(Boolean(_cachedSettingsSnapshot));
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, []);

  const persistSettings = async (newSettings: ProactiveSettings) => {
    try {
      setSaving(true);
      _cachedSettingsSnapshot = newSettings;
      await api.updateProactiveSettings(newSettings);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch {
      console.error("Auto-sync proactive settings failed");
    } finally {
      setSaving(false);
    }
  };

  const scheduleAutoSave = (newSettings: ProactiveSettings) => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      persistSettings(newSettings);
    }, 400);
  };

  const handleToggle = (key: keyof ProactiveSettings) => {
    if (!settings) return;
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next);
    scheduleAutoSave(next);
  };

  const handleChange = (key: keyof ProactiveSettings, val: unknown) => {
    if (!settings) return;
    const next = { ...settings, [key]: val };
    setSettings(next);
    scheduleAutoSave(next);
  };

  const handleSave = async () => {
    if (!settings) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    await persistSettings(settings);
  };

  const handleTestBrief = async () => {
    try {
      setTestingBrief(true);
      setTestMessage(null);
      // Immediately trigger local native notification popup on this computer / device
      await sendLocalNotification(
        "🌅 早上好！今日晨间简报",
        "今日待办与在线设备状态已同步，AI 执事全天候为您就绪！",
        "/profile?tab=proactive"
      );
      await api.testMorningBrief();
      setTestMessage("✅ 晨间简报已成功合成并触发推送！");
      setTimeout(() => setTestMessage(null), 4000);
    } catch (e: unknown) {
      console.error("Test brief failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      setTestMessage(`❌ 推送异常: ${msg || "请检查网络连接"}`);
    } finally {
      setTestingBrief(false);
    }
  };

  const handleTestReflection = async () => {
    try {
      setTestingReflection(true);
      setTestMessage(null);
      const res = await api.testEveningReflection();
      if (res.status === "ok") {
        await sendLocalNotification("🌙 今日复盘", res.message, "/daily");
        setTestMessage(`✅ 已推送：${res.message}`);
      } else {
        setTestMessage(`ℹ️ ${res.message}`);
      }
      setTimeout(() => setTestMessage(null), 8000);
    } catch (e: unknown) {
      console.error("Test reflection failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      setTestMessage(`❌ 复盘执行异常: ${msg || "网络错误"}`);
    } finally {
      setTestingReflection(false);
    }
  };

  const handleApprove = async (id: string) => {
    try {
      setApprovingId(id);
      await api.approveMission(id);
      await loadData();
    } catch (e) {
      alert("审批失败");
    } finally {
      setApprovingId(null);
    }
  };

  const handleReject = async (id: string) => {
    try {
      await api.rejectMission(id, "用户在控制台驳回");
      await loadData();
    } catch (e) {
      alert("驳回失败");
    }
  };

  if (loading || !settings) {
    return (
      <div className="py-12 text-center text-sm text-[var(--aurora-fg4)]">
        加载全天候助手配置...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Overview Banner - Modern Executive Hero Card */}
      <Glass
        className="p-6 relative overflow-hidden transition-all duration-300"
        style={{
          borderRadius: 22,
          boxShadow: settings.enabled
            ? "0 10px 30px -10px rgba(124, 58, 237, 0.16), 0 2px 8px -2px rgba(15, 15, 40, 0.04)"
            : "0 4px 18px -4px rgba(0, 0, 0, 0.04)",
          border: settings.enabled
            ? "1px solid color-mix(in srgb, var(--aurora-accent) 25%, var(--aurora-border))"
            : "1px solid var(--aurora-border)",
        }}
      >
        <div className="flex flex-col gap-5">
          {/* Top row: Brand Icon + Title & Live Badge + Action Switch */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3.5 min-w-0">
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 16,
                  background: settings.enabled
                    ? "linear-gradient(135deg, #6D28D9 0%, #EC4899 50%, #06B6D4 100%)"
                    : "var(--aurora-chip)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                  boxShadow: settings.enabled
                    ? "0 6px 20px -3px rgba(124, 58, 237, 0.42), inset 0 1px 1px rgba(255, 255, 255, 0.4)"
                    : "none",
                  flexShrink: 0,
                  transition: "all 0.3s ease",
                }}
              >
                <Icon name="sparkles" size={22} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base sm:text-lg font-semibold text-[var(--aurora-fg1)] tracking-tight">
                    24/7 全天候个人智能执事
                  </h3>
                  <span
                    className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10.5px] font-semibold transition-colors"
                    style={{
                      background: settings.enabled
                        ? "rgba(16, 185, 129, 0.12)"
                        : "var(--aurora-chip)",
                      color: settings.enabled ? "#10B981" : "var(--aurora-fg4)",
                      border: settings.enabled
                        ? "1px solid rgba(16, 185, 129, 0.28)"
                        : "1px solid var(--aurora-border)",
                    }}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${settings.enabled ? "bg-emerald-500 animate-pulse" : "bg-neutral-400"}`}
                    />
                    {settings.enabled ? "全天候实时守护中" : "已休眠待命"}
                  </span>
                </div>
              </div>
            </div>

            {/* Main Toggle Switch always pinned neatly at the top right */}
            <SmoothToggle
              checked={settings.enabled}
              onChange={() => handleToggle("enabled")}
              size="md"
            />
          </div>

          {/* Description text */}
          <p className="text-xs text-[var(--aurora-fg3)] leading-relaxed max-w-2xl">
            脱离浏览器窗口限制，在云端与设备端常驻跳动。自动执行晨间日程简报、夜间认知进化与梦境整理，并在设备异常或临时待办出现时主动向您的电脑与移动终端智能汇报。
          </p>

          {/* Feature Highlight Tags */}
          <div className="flex items-center gap-2 flex-wrap">
            {[
              { icon: "🌅", label: "晨间主动简报" },
              { icon: "🌌", label: "夜间认知整理" },
              { icon: "⚡", label: "零延迟自保活" },
              { icon: "🚨", label: "跨设备掉线告警" },
            ].map((tag, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
                style={{
                  background: "var(--aurora-surface, rgba(255, 255, 255, 0.6))",
                  border: "1px solid var(--aurora-border)",
                  color: "var(--aurora-fg2)",
                  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.02)",
                }}
              >
                <span>{tag.icon}</span>
                <span>{tag.label}</span>
              </span>
            ))}
          </div>

          {/* Status micro-bar */}
          <div
            className="pt-3.5 border-t border-[var(--aurora-border)] flex items-center justify-between text-[11px] text-[var(--aurora-fg3)] flex-wrap gap-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-[var(--aurora-accent)]">⚡</span>
              <span>极光长程保活机制已就绪 · 云端会话与长期记忆持续在线</span>
            </div>
            <div>
              {saving ? (
                <span className="inline-flex items-center gap-1.5 text-blue-500 font-medium animate-pulse">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                  配置同步中...
                </span>
              ) : saveSuccess ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-500 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  已实时保存生效
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[var(--aurora-fg4)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  零延迟云端同步
                </span>
              )}
            </div>
          </div>
        </div>
      </Glass>

      {/* Proactive Routine Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Morning Briefing Card */}
        <Glass
          className="p-5 flex flex-col justify-between transition-all duration-300"
          style={{
            borderRadius: 18,
            border: settings.morning_brief_enabled
              ? "1px solid color-mix(in srgb, #F59E0B 25%, var(--aurora-border))"
              : "1px solid var(--aurora-border)",
            opacity: settings.morning_brief_enabled ? 1 : 0.76,
          }}
        >
          <div>
            <div className="flex items-center justify-between mb-3.5">
              <div className="flex items-center gap-2.5">
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    background: "linear-gradient(135deg, #F59E0B 0%, #EF4444 100%)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 3px 10px -2px rgba(245, 158, 11, 0.4)",
                    color: "#fff",
                    fontSize: 15,
                  }}
                >
                  🌅
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-[var(--aurora-fg1)]">晨间主动简报</h4>
                  <span className="text-[10px] text-[var(--aurora-fg4)]">定时生成今日待办与全局研发全景</span>
                </div>
              </div>
              <SmoothToggle
                checked={settings.morning_brief_enabled}
                onChange={() => handleToggle("morning_brief_enabled")}
                size="sm"
              />
            </div>

            <p className="text-xs text-[var(--aurora-fg3)] leading-relaxed mb-4">
              每天早晨自动拉取今日待办、研发项目进度与在线设备状态，由 AI 生成提纲挈领的早报推送，让您一天工作胸有成竹。
            </p>

            {/* Time Picker Badge */}
            <div className="mb-4">
              <TimePickerBadge
                label="每日早报触发时间"
                value={settings.morning_brief_time}
                onChange={(val) => handleChange("morning_brief_time", val)}
              />
            </div>
          </div>

          <div className="pt-3 border-t border-[var(--aurora-border)] flex items-center justify-between">
            <span className="text-[11px] text-[var(--aurora-fg4)]">支持多终端即时通告</span>
            <button
              type="button"
              onClick={handleTestBrief}
              disabled={testingBrief}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all duration-200 cursor-pointer select-none"
              style={{
                background: "var(--aurora-surface, rgba(255, 255, 255, 0.7))",
                border: "1px solid color-mix(in srgb, #F59E0B 35%, var(--aurora-border))",
                color: "var(--aurora-fg1)",
                boxShadow: "0 2px 6px -1px rgba(0, 0, 0, 0.04)",
              }}
            >
              <span>{testingBrief ? "⚡" : "📱"}</span>
              <span>{testingBrief ? "合成并推送中..." : "立即测试推送"}</span>
            </button>
          </div>
        </Glass>

        {/* Evening Reflection Card */}
        <Glass
          className="p-5 flex flex-col justify-between transition-all duration-300"
          style={{
            borderRadius: 18,
            border: settings.evening_reflection_enabled
              ? "1px solid color-mix(in srgb, #6366F1 25%, var(--aurora-border))"
              : "1px solid var(--aurora-border)",
            opacity: settings.evening_reflection_enabled ? 1 : 0.76,
          }}
        >
          <div>
            <div className="flex items-center justify-between mb-3.5">
              <div className="flex items-center gap-2.5">
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    background: "linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 3px 10px -2px rgba(99, 102, 241, 0.4)",
                    color: "#fff",
                    fontSize: 15,
                  }}
                >
                  🌌
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-[var(--aurora-fg1)]">晚间认知复盘</h4>
                  <span className="text-[10px] text-[var(--aurora-fg4)]">沉淀一日所得、提炼避坑经验</span>
                </div>
              </div>
              <SmoothToggle
                checked={settings.evening_reflection_enabled}
                onChange={() => handleToggle("evening_reflection_enabled")}
                size="sm"
              />
            </div>

            <p className="text-xs text-[var(--aurora-fg3)] leading-relaxed mb-4">
              按设定时间推送今天的会话沉淀、新记忆、避坑反思与明日待办；凌晨自动梳理长效记忆，更新心智画像。
            </p>

            {/* Time Picker Badge */}
            <div className="mb-4">
              <TimePickerBadge
                label="每日晚间复盘时间"
                value={settings.evening_reflection_time}
                onChange={(val) => handleChange("evening_reflection_time", val)}
              />
            </div>
          </div>

          <div className="pt-3 border-t border-[var(--aurora-border)] flex items-center justify-between">
            <span className="text-[11px] text-[var(--aurora-fg4)]">自动沉淀至认知大脑</span>
            <button
              type="button"
              onClick={handleTestReflection}
              disabled={testingReflection}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all duration-200 cursor-pointer select-none"
              style={{
                background: "var(--aurora-surface, rgba(255, 255, 255, 0.7))",
                border: "1px solid color-mix(in srgb, #6366F1 35%, var(--aurora-border))",
                color: "var(--aurora-fg1)",
                boxShadow: "0 2px 6px -1px rgba(0, 0, 0, 0.04)",
              }}
            >
              <span>{testingReflection ? "⚡" : "✨"}</span>
              <span>{testingReflection ? "整理沉淀中..." : "立即测试复盘"}</span>
            </button>
          </div>
        </Glass>
      </div>

      {testMessage && (
        <div
          className="p-3.5 text-xs rounded-xl text-center font-medium transition-all duration-300 shadow-sm"
          style={{
            background: testMessage.startsWith("✅") ? "rgba(16,185,129,0.12)" : testMessage.startsWith("❌") ? "rgba(239,68,68,0.12)" : "rgba(148,163,184,0.12)",
            color: testMessage.startsWith("✅") ? "#10B981" : testMessage.startsWith("❌") ? "#EF4444" : "var(--aurora-fg2)",
            border: `1px solid ${testMessage.startsWith("✅") ? "rgba(16,185,129,0.28)" : testMessage.startsWith("❌") ? "rgba(239,68,68,0.28)" : "rgba(148,163,184,0.25)"}`,
          }}
        >
          {testMessage}
        </div>
      )}

      {/* Safety & Quiet Hours Preferences */}
      <Glass className="p-6" style={{ borderRadius: 20 }}>
        <div className="flex items-center gap-2 mb-1">
          <Icon name="lock" size={17} style={{ color: "var(--aurora-accent)" }} />
          <SectionLabel>安全策略与免打扰时间</SectionLabel>
        </div>
        <p className="text-xs text-[var(--aurora-fg4)] mb-4">
          细粒度守护设备执行安全性，保障您的作息不受非紧急通告打扰
        </p>

        <div className="space-y-3 mt-3">
          <div
            className="flex items-center justify-between p-3.5 rounded-xl transition-all duration-200"
            style={{
              background: "var(--aurora-surface, rgba(255, 255, 255, 0.55))",
              border: "1px solid var(--aurora-border)",
            }}
          >
            <div className="pr-4 min-w-0">
              <div className="text-xs font-semibold text-[var(--aurora-fg1)]">低风险指令自动放行</div>
              <div className="text-[11px] text-[var(--aurora-fg3)] mt-0.5 leading-relaxed">
                对查询、状态拉取、只读检测等安全指令自动执行；高危指令（删除、代码强制推送）自动挂起并弹出审批提醒
              </div>
            </div>
            <SmoothToggle
              checked={settings.auto_approve_safe}
              onChange={() => handleToggle("auto_approve_safe")}
              size="sm"
            />
          </div>

          <div
            className="flex items-center justify-between p-3.5 rounded-xl transition-all duration-200"
            style={{
              background: "var(--aurora-surface, rgba(255, 255, 255, 0.55))",
              border: "1px solid var(--aurora-border)",
            }}
          >
            <div className="pr-4 min-w-0">
              <div className="text-xs font-semibold text-[var(--aurora-fg1)]">终端设备掉线预警</div>
              <div className="text-[11px] text-[var(--aurora-fg3)] mt-0.5 leading-relaxed">
                当常驻执行的某台电脑或服务器意外离线超过 5 分钟，及时向本机电脑与移动终端推送告警
              </div>
            </div>
            <SmoothToggle
              checked={settings.device_alert_enabled}
              onChange={() => handleToggle("device_alert_enabled")}
              size="sm"
            />
          </div>

          <div
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl transition-all duration-200"
            style={{
              background: "var(--aurora-surface, rgba(255, 255, 255, 0.55))",
              border: "1px solid var(--aurora-border)",
            }}
          >
            <div>
              <div className="text-xs font-semibold text-[var(--aurora-fg1)]">夜间免打扰时段 (Quiet Hours)</div>
              <div className="text-[11px] text-[var(--aurora-fg3)] mt-0.5 leading-relaxed">
                该时段内后台静默维护与沉淀，严禁向任何终端发送弹窗或声音打扰
              </div>
            </div>
            <div
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl self-start sm:self-auto"
              style={{
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border)",
              }}
            >
              <input
                type="time"
                value={settings.quiet_hours_start}
                onChange={(e) => handleChange("quiet_hours_start", e.target.value)}
                className="bg-transparent text-xs font-mono font-semibold text-[var(--aurora-fg1)] outline-none cursor-pointer text-center"
              />
              <span className="text-[11px] text-[var(--aurora-fg4)]">至</span>
              <input
                type="time"
                value={settings.quiet_hours_end}
                onChange={(e) => handleChange("quiet_hours_end", e.target.value)}
                className="bg-transparent text-xs font-mono font-semibold text-[var(--aurora-fg1)] outline-none cursor-pointer text-center"
              />
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white transition-all duration-200 cursor-pointer shadow-sm disabled:opacity-50"
            style={{
              background: "linear-gradient(135deg, #7C3AED 0%, #6366F1 100%)",
              boxShadow: "0 4px 14px -3px rgba(124, 58, 237, 0.4)",
            }}
          >
            <span>{saving ? "⚡" : saveSuccess ? "✓" : "💾"}</span>
            <span>{saving ? "实时同步中..." : saveSuccess ? "设置已生效" : "立即手动保存"}</span>
          </button>
        </div>
      </Glass>

      {/* Autonomous Background Missions (Active Jobs) */}
      <Glass className="p-6" style={{ borderRadius: 20 }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Icon name="terminal" size={17} style={{ color: "var(--aurora-accent)" }} />
            <SectionLabel>全天候后台守护任务 (Active Missions)</SectionLabel>
          </div>
          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-[var(--aurora-chip)] text-[var(--aurora-fg3)] border border-[var(--aurora-border)]">
            共 {missions.length} 个任务
          </span>
        </div>

        {missionsLoading ? (
          <div className="py-8 text-center text-xs text-[var(--aurora-fg4)]">加载任务列表中...</div>
        ) : missions.length === 0 ? (
          <div
            className="py-10 px-4 text-center rounded-2xl flex flex-col items-center justify-center gap-2"
            style={{
              background: "var(--aurora-surface, rgba(255, 255, 255, 0.4))",
              border: "1px dashed var(--aurora-border)",
            }}
          >
            <span className="text-2xl mb-1">🛡️</span>
            <span className="text-xs font-semibold text-[var(--aurora-fg2)]">暂无进行中的长周期后台任务</span>
            <p className="text-[11px] text-[var(--aurora-fg4)] max-w-md">
              当您在 AI 执事（/ask）中发起长时间运行的大型任务或跨设备排查时，可委托给执事在后台持续守护执行。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {missions.map((m) => (
              <div
                key={m.id}
                className="p-4 rounded-xl border transition-all duration-200 text-xs"
                style={{
                  background: m.status === "waiting_approval"
                    ? "rgba(245, 158, 11, 0.08)"
                    : "var(--aurora-surface, rgba(255, 255, 255, 0.6))",
                  borderColor: m.status === "waiting_approval"
                    ? "rgba(245, 158, 11, 0.35)"
                    : "var(--aurora-border)",
                  boxShadow: "0 2px 8px -2px rgba(0, 0, 0, 0.03)",
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-[var(--aurora-fg1)]">{m.title}</span>
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                        style={{
                          background:
                            m.status === "waiting_approval"
                              ? "rgba(245,158,11,0.2)"
                              : m.status === "running"
                              ? "rgba(16,185,129,0.15)"
                              : "var(--aurora-border)",
                          color:
                            m.status === "waiting_approval"
                              ? "#F59E0B"
                              : m.status === "running"
                              ? "#10B981"
                              : "var(--aurora-fg3)",
                        }}
                      >
                        {m.status === "waiting_approval"
                          ? "⚠️ 待您授权"
                          : m.status === "running"
                          ? "● 正在执行"
                          : m.status === "succeeded"
                          ? "✓ 已完成"
                          : m.status}
                      </span>
                    </div>
                    <div className="text-[11.5px] text-[var(--aurora-fg3)] mt-1.5 leading-relaxed">{m.goal}</div>
                  </div>

                  <div className="text-[11px] font-mono text-[var(--aurora-fg4)] shrink-0">
                    步数: {m.current_step} 步
                  </div>
                </div>

                {/* If waiting for approval, show quick actions */}
                {m.status === "waiting_approval" && m.pending_action && (
                  <div className="mt-3.5 pt-3.5 border-t border-[var(--aurora-border)] flex items-center justify-between flex-wrap gap-2">
                    <div className="text-[11px] text-amber-600 dark:text-amber-400 font-mono">
                      拟执行命令: <code>{m.pending_action.command}</code>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleReject(m.id)}
                        className="px-3 py-1 rounded-lg text-xs font-medium text-red-500 bg-red-500/10 hover:bg-red-500/20 transition-colors"
                      >
                        驳回
                      </button>
                      <button
                        type="button"
                        onClick={() => handleApprove(m.id)}
                        disabled={approvingId === m.id}
                        className="px-3.5 py-1 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 shadow-sm transition-all"
                      >
                        {approvingId === m.id ? "放行中..." : "✓ 允许放行"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Glass>
    </div>
  );
}
