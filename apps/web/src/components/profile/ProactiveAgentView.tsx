"use client";

import { useEffect, useState } from "react";
import { api, type ProactiveSettings, type AgentMissionItem } from "@/lib/api-client";
import { Glass, Btn, SectionLabel } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import { sendLocalNotification } from "@/lib/native-notify";

export function ProactiveAgentView() {
  const [settings, setSettings] = useState<ProactiveSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [testingBrief, setTestingBrief] = useState(false);
  const [testingReflection, setTestingReflection] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const [missions, setMissions] = useState<AgentMissionItem[]>([]);
  const [missionsLoading, setMissionsLoading] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      const s = await api.getProactiveSettings();
      setSettings(s);
    } catch (e) {
      console.error("Failed to load proactive settings", e);
    } finally {
      setLoading(false);
    }

    try {
      setMissionsLoading(true);
      const m = await api.getMissions();
      setMissions(m);
    } catch (e) {
      console.error("Failed to load missions", e);
    } finally {
      setMissionsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleToggle = (key: keyof ProactiveSettings) => {
    if (!settings) return;
    setSettings({ ...settings, [key]: !settings[key] });
  };

  const handleChange = (key: keyof ProactiveSettings, val: unknown) => {
    if (!settings) return;
    setSettings({ ...settings, [key]: val });
  };

  const handleSave = async () => {
    if (!settings) return;
    try {
      setSaving(true);
      await api.updateProactiveSettings(settings);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch {
      alert("保存失败，请检查网络");
    } finally {
      setSaving(false);
    }
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
      await sendLocalNotification(
        "🌌 晚间梦境自进化完成",
        "今日工作沉淀已完成！已自动吸收碎片记忆，更新画像偏好与避坑规则。",
        "/profile?tab=proactive"
      );
      await api.testEveningReflection();
      setTestMessage("✅ 晚间梦境复盘已执行并触发推送！");
      setTimeout(() => setTestMessage(null), 4000);
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
      {/* Overview Banner */}
      <Glass className="p-6 relative overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 14,
                background: settings.enabled
                  ? "var(--aurora-brand-grad)"
                  : "var(--aurora-chip)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                boxShadow: settings.enabled
                  ? "0 4px 16px -2px rgba(124,58,237,0.4)"
                  : "none",
                flexShrink: 0,
              }}
            >
              <Icon name="sparkles" size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-[var(--aurora-fg1)]">
                  24/7 全天候个人智能执事
                </h3>
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    borderRadius: 9999,
                    fontWeight: 600,
                    background: settings.enabled
                      ? "rgba(16,185,129,0.15)"
                      : "var(--aurora-chip)",
                    color: settings.enabled ? "#10B981" : "var(--aurora-fg4)",
                    border: settings.enabled
                      ? "1px solid rgba(16,185,129,0.3)"
                      : "1px solid var(--aurora-border)",
                  }}
                >
                  {settings.enabled ? "● 全天候守护中" : "已暂停"}
                </span>
              </div>
              <p className="text-xs text-[var(--aurora-fg3)] mt-1.5 leading-relaxed max-w-xl">
                脱离浏览器窗口限制，在云端常驻跳动。自动执行晨间日程简报、夜间认知进化与梦境整理，并在设备异常或临期待办出现时主动向您的电脑与移动设备汇报。
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => handleToggle("enabled")}
              style={{
                width: 48,
                height: 26,
                borderRadius: 9999,
                background: settings.enabled ? "var(--aurora-accent)" : "var(--aurora-border)",
                position: "relative",
                transition: "background .2s",
                cursor: "pointer",
                border: 0,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 3,
                  left: settings.enabled ? 25 : 3,
                  width: 20,
                  height: 20,
                  borderRadius: 9999,
                  background: "#fff",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                  transition: "left .2s",
                }}
              />
            </button>
          </div>
        </div>
      </Glass>

      {/* Proactive Routine Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Morning Briefing Card */}
        <Glass className="p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">🌅</span>
                <span className="text-sm font-semibold text-[var(--aurora-fg1)]">晨间主动简报</span>
              </div>
              <input
                type="checkbox"
                checked={settings.morning_brief_enabled}
                onChange={() => handleToggle("morning_brief_enabled")}
                className="w-4 h-4 cursor-pointer accent-[var(--aurora-accent)]"
              />
            </div>
            <p className="text-xs text-[var(--aurora-fg4)] leading-relaxed mb-4">
              每天早晨自动拉取今日待办、研发项目进度与在线设备状态，由 AI 生成提纲挈领的早报推送。
            </p>
            <div className="flex items-center justify-between text-xs text-[var(--aurora-fg2)] bg-[var(--aurora-chip)] px-3 py-2 rounded-xl mb-4">
              <span>触发时间</span>
              <input
                type="time"
                value={settings.morning_brief_time}
                onChange={(e) => handleChange("morning_brief_time", e.target.value)}
                className="bg-transparent font-mono outline-none text-right cursor-pointer"
                style={{ color: "var(--aurora-accent)" }}
              />
            </div>
          </div>
          <div className="pt-2 border-t border-[var(--aurora-border)] flex justify-end">
            <Btn
              variant="glass"
              onClick={handleTestBrief}
              disabled={testingBrief}
              className="text-xs py-1.5"
            >
              {testingBrief ? "合成并推送中..." : "📱 立即测试推送"}
            </Btn>
          </div>
        </Glass>

        {/* Evening Reflection Card */}
        <Glass className="p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">🌌</span>
                <span className="text-sm font-semibold text-[var(--aurora-fg1)]">夜间梦境自进化复盘</span>
              </div>
              <input
                type="checkbox"
                checked={settings.evening_reflection_enabled}
                onChange={() => handleToggle("evening_reflection_enabled")}
                className="w-4 h-4 cursor-pointer accent-[var(--aurora-accent)]"
              />
            </div>
            <p className="text-xs text-[var(--aurora-fg4)] leading-relaxed mb-4">
              深夜离线整理今日碎片记忆、自动吸收避坑经验与用户习惯，更新常驻画像并生成认知日报。
            </p>
            <div className="flex items-center justify-between text-xs text-[var(--aurora-fg2)] bg-[var(--aurora-chip)] px-3 py-2 rounded-xl mb-4">
              <span>触发时间</span>
              <input
                type="time"
                value={settings.evening_reflection_time}
                onChange={(e) => handleChange("evening_reflection_time", e.target.value)}
                className="bg-transparent font-mono outline-none text-right cursor-pointer"
                style={{ color: "var(--aurora-accent)" }}
              />
            </div>
          </div>
          <div className="pt-2 border-t border-[var(--aurora-border)] flex justify-end">
            <Btn
              variant="glass"
              onClick={handleTestReflection}
              disabled={testingReflection}
              className="text-xs py-1.5"
            >
              {testingReflection ? "整理中..." : "🌌 立即测试复盘"}
            </Btn>
          </div>
        </Glass>
      </div>

      {testMessage && (
        <div
          className="p-3 text-xs rounded-xl text-center font-medium transition-all"
          style={{
            background: testMessage.startsWith("✅") ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)",
            color: testMessage.startsWith("✅") ? "#10B981" : "#EF4444",
            border: `1px solid ${testMessage.startsWith("✅") ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.25)"}`,
          }}
        >
          {testMessage}
        </div>
      )}

      {/* Safety & Quiet Hours Preferences */}
      <Glass className="p-5">
        <SectionLabel>安全策略与免打扰时间</SectionLabel>
        <div className="space-y-4 mt-4">
          <div className="flex items-center justify-between py-2 border-b border-[var(--aurora-border)]">
            <div>
              <div className="text-xs font-semibold text-[var(--aurora-fg1)]">低风险指令自动放行</div>
              <div className="text-[11px] text-[var(--aurora-fg4)] mt-0.5">
                对查询、状态拉取、只读检测等安全指令自动执行；高危指令（删除、代码强制推送）挂起并弹出系统审批提醒
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.auto_approve_safe}
              onChange={() => handleToggle("auto_approve_safe")}
              className="w-4 h-4 cursor-pointer accent-[var(--aurora-accent)]"
            />
          </div>

          <div className="flex items-center justify-between py-2 border-b border-[var(--aurora-border)]">
            <div>
              <div className="text-xs font-semibold text-[var(--aurora-fg1)]">终端设备掉线预警</div>
              <div className="text-[11px] text-[var(--aurora-fg4)] mt-0.5">
                当常驻执行的某台电脑或服务器意外离线超过 5 分钟，及时向本机电脑与移动终端推送告警
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.device_alert_enabled}
              onChange={() => handleToggle("device_alert_enabled")}
              className="w-4 h-4 cursor-pointer accent-[var(--aurora-accent)]"
            />
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-xs font-semibold text-[var(--aurora-fg1)]">夜间免打扰时段（Quiet Hours）</div>
              <div className="text-[11px] text-[var(--aurora-fg4)] mt-0.5">
                该时段内后台静默维护与沉淀，严禁向任何终端发送弹窗或声音打扰
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono">
              <input
                type="time"
                value={settings.quiet_hours_start}
                onChange={(e) => handleChange("quiet_hours_start", e.target.value)}
                className="bg-[var(--aurora-chip)] px-2 py-1 rounded-lg text-[var(--aurora-fg1)] outline-none border border-[var(--aurora-border)]"
              />
              <span className="text-[var(--aurora-fg4)]">至</span>
              <input
                type="time"
                value={settings.quiet_hours_end}
                onChange={(e) => handleChange("quiet_hours_end", e.target.value)}
                className="bg-[var(--aurora-chip)] px-2 py-1 rounded-lg text-[var(--aurora-fg1)] outline-none border border-[var(--aurora-border)]"
              />
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <Btn variant="primary" onClick={handleSave} disabled={saving} className="text-xs">
            {saving ? "保存中..." : saveSuccess ? "✓ 设置已更新" : "保存全天候策略"}
          </Btn>
        </div>
      </Glass>

      {/* Autonomous Background Missions (Active Jobs) */}
      <Glass className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Icon name="terminal" size={16} style={{ color: "var(--aurora-accent)" }} />
            <SectionLabel>全天候后台守护任务 (Active Missions)</SectionLabel>
          </div>
          <span className="text-xs text-[var(--aurora-fg4)]">
            共 {missions.length} 个后台任务
          </span>
        </div>

        {missionsLoading ? (
          <div className="py-6 text-center text-xs text-[var(--aurora-fg4)]">加载任务列表中...</div>
        ) : missions.length === 0 ? (
          <div className="py-8 text-center text-xs text-[var(--aurora-fg4)] border border-dashed border-[var(--aurora-border)] rounded-xl">
            暂无进行中的长周期后台任务。可在 AI 执事（/ask）中将长任务委托给助手在后台持续守护。
          </div>
        ) : (
          <div className="space-y-3">
            {missions.map((m) => (
              <div
                key={m.id}
                className="p-3.5 rounded-xl border transition-all text-xs"
                style={{
                  background: m.status === "waiting_approval" ? "rgba(245,158,11,0.06)" : "var(--aurora-chip)",
                  borderColor: m.status === "waiting_approval" ? "rgba(245,158,11,0.3)" : "var(--aurora-border)",
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[var(--aurora-fg1)]">{m.title}</span>
                      <span
                        style={{
                          fontSize: 9.5,
                          padding: "1px 6px",
                          borderRadius: 4,
                          fontWeight: 600,
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
                    <div className="text-[11px] text-[var(--aurora-fg4)] mt-1">{m.goal}</div>
                  </div>

                  <div className="text-[10px] text-[var(--aurora-fg4)] text-right">
                    步数: {m.current_step} 步
                  </div>
                </div>

                {/* If waiting for approval, show quick actions */}
                {m.status === "waiting_approval" && m.pending_action && (
                  <div className="mt-3 pt-3 border-t border-[var(--aurora-border)] flex items-center justify-between flex-wrap gap-2">
                    <div className="text-[11px] text-amber-500 font-mono">
                      拟执行命令: <code>{m.pending_action.command}</code>
                    </div>
                    <div className="flex items-center gap-2">
                      <Btn
                        variant="glass"
                        onClick={() => handleReject(m.id)}
                        className="text-[11px] py-1 text-red-500"
                      >
                        驳回
                      </Btn>
                      <Btn
                        variant="primary"
                        onClick={() => handleApprove(m.id)}
                        disabled={approvingId === m.id}
                        className="text-[11px] py-1 bg-emerald-600 hover:bg-emerald-500"
                      >
                        {approvingId === m.id ? "放行中..." : "✓ 允许放行"}
                      </Btn>
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
