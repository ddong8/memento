"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";
import { api, getApiBase, openServerSwitchModal } from "@/lib/api-client";
import { desktop } from "@/lib/desktop";
import { Btn, Chip, Glass, TopBar, SectionLabel, GhostInput } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import NotifySettings from "@/components/notify/NotifySettings";
import { DevicesView } from "@/components/devices/DevicesView";
import { CollectorView } from "@/components/collector/CollectorView";
import { StatusView } from "@/components/status/StatusView";
import { ProactiveAgentView } from "@/components/profile/ProactiveAgentView";
import { LifeRhythmView } from "@/components/life/LifeRhythmView";
import { LLMSettingsView } from "@/components/profile/LLMSettingsView";

type TabKey = "proactive" | "llm" | "life" | "account" | "devices" | "collector" | "health" | "admin";

type ImportSummary = {
  machine_id: string;
  counts: Record<string, number>;
  warnings: string[];
};

export default function ProfilePage() {
  return (
    <Suspense
      fallback={
        <div style={{ textAlign: "center", color: "var(--aurora-fg4)", marginTop: 80 }}>
          加载设置...
        </div>
      }
    >
      <ProfileContent />
    </Suspense>
  );
}

function ProfileContent() {
  const { user, token, logout, setUser } = useAuth();
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("memento_profile_tab") as TabKey | null;
      if (saved && ["proactive", "llm", "life", "account", "devices", "collector", "health", "admin"].includes(saved)) {
        return saved;
      }
    }
    return "account";
  });
  const [isDesktopEnv, setIsDesktopEnv] = useState(false);

  useEffect(() => {
    const d = desktop();
    if (d) setIsDesktopEnv(true);
  }, []);

  useEffect(() => {
    const paramTab = searchParams.get("tab") as TabKey | null;
    if (paramTab && ["proactive", "llm", "life", "account", "devices", "collector", "health", "admin"].includes(paramTab)) {
      setActiveTab(paramTab);
      if (typeof window !== "undefined") {
        localStorage.setItem("memento_profile_tab", paramTab);
      }
    } else if (typeof window !== "undefined") {
      const saved = localStorage.getItem("memento_profile_tab") as TabKey | null;
      if (saved && ["proactive", "llm", "life", "account", "devices", "collector", "health", "admin"].includes(saved)) {
        setActiveTab(saved);
      }
    }
  }, [searchParams]);

  const switchTab = (tab: TabKey) => {
    setActiveTab(tab);
    if (typeof window !== "undefined") {
      localStorage.setItem("memento_profile_tab", tab);
    }
    router.replace(`/profile?tab=${tab}`, { scroll: false });
  };

  const isAdmin = user?.role === "admin" || user?.role === "owner";

  if (!user) {
    return (
      <div style={{ textAlign: "center", color: "var(--aurora-fg4)", marginTop: 80 }}>
        {t.loading}
      </div>
    );
  }

  const TABS: { id: TabKey; label: string; icon: Parameters<typeof Icon>[0]["name"]; adminOnly?: boolean }[] = [
    { id: "proactive", label: "AI 执事", icon: "sparkles" },
    { id: "llm", label: "大模型配置", icon: "zap" },
    { id: "life", label: "作息与时间", icon: "clock" },
    { id: "account", label: t.profile.tabs?.account || "账号安全", icon: "user" },
    { id: "devices", label: t.profile.tabs?.devices || "我的设备", icon: "devices" },
    { id: "collector", label: t.profile.tabs?.collector || "采集配置", icon: "terminal" },
    { id: "health", label: t.profile.tabs?.health || "系统健康", icon: "activity" },
    ...(isAdmin ? [{ id: "admin" as TabKey, label: t.profile.tabs?.admin || "管理控制台", icon: "lock" as const }] : []),
  ];

  return (
    <div className="max-w-4xl mx-auto pb-16">
      <TopBar title={t.profile.title || "个人设置"} subtitle={t.profile.subtitle || "全天候智能执事、大模型底座、生活作息与终端运维"} />

      {/* Tabs navigation */}
      <div
        className="flex items-center gap-1.5 p-1 mb-6 rounded-2xl overflow-x-auto no-scrollbar"
        style={{
          background: "var(--aurora-card)",
          border: "1px solid var(--aurora-border)",
          boxShadow: "0 2px 10px rgba(0,0,0,0.03)",
        }}
      >
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-medium transition-all whitespace-nowrap cursor-pointer"
              style={{
                background: active ? "var(--aurora-accent-soft)" : "transparent",
                color: active ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                border: active ? "1px solid color-mix(in srgb, var(--aurora-accent) 30%, transparent)" : "1px solid transparent",
                fontWeight: active ? 600 : 450,
              }}
            >
              <Icon name={tab.icon} size={15} color={active ? "var(--aurora-accent)" : undefined} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Panels */}
      {activeTab === "proactive" && <ProactiveAgentView />}
      {activeTab === "llm" && <LLMSettingsView />}
      {activeTab === "life" && <LifeRhythmView />}
      {activeTab === "account" && <AccountTab />}
      {activeTab === "devices" && <DevicesView hideTopBar />}
      {activeTab === "collector" && <CollectorView hideTopBar />}
      {activeTab === "health" && <StatusView hideTopBar />}
      {activeTab === "admin" && <AdminPanelTab />}
    </div>
  );
}

function AccountTab() {
  const { user, token, logout, setUser } = useAuth();
  const { t } = useI18n();

  const [name, setName] = useState(user?.name || "");
  const [savingName, setSavingName] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [errMsg, setErrMsg] = useState<string>("");
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [currentServerUrl, setCurrentServerUrl] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    const initServer = async () => {
      const d = desktop();
      if (d?.server?.get) {
        try {
          const info = await d.server.get();
          if (info.current) {
            setCurrentServerUrl(info.current.replace(/\/+$/, ""));
            return;
          }
        } catch {}
      }
      setCurrentServerUrl(getApiBase().replace(/\/+$/, ""));
    };
    void initServer();
  }, []);

  useEffect(() => {
    if (user?.name !== undefined) {
      setName(user?.name || "");
    }
  }, [user?.name]);

  if (!user) return null;

  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !token) return;
    if (file.size > 2 * 1024 * 1024) {
      setProfileMsg({ type: "error", text: "头像文件大小不能超过 2MB" });
      return;
    }
    setProfileMsg(null);
    setUploadingAvatar(true);
    try {
      const updated = await api.uploadAvatar(token, file);
      setUser(updated);
      setProfileMsg({ type: "success", text: t.profile.saveSuccess });
    } catch (err: unknown) {
      setProfileMsg({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setUploadingAvatar(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  };

  const handleRemoveAvatar = async () => {
    if (!token) return;
    setProfileMsg(null);
    setUploadingAvatar(true);
    try {
      const updated = await api.deleteAvatar(token);
      setUser(updated);
      setProfileMsg({ type: "success", text: t.profile.saveSuccess });
    } catch (err: unknown) {
      setProfileMsg({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSaveProfile = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!token) return;
    setProfileMsg(null);
    setSavingName(true);
    try {
      const updated = await api.updateProfile(token, { name: name.trim() });
      setUser(updated);
      setProfileMsg({ type: "success", text: t.profile.saveSuccess });
    } catch (err: unknown) {
      setProfileMsg({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSavingName(false);
    }
  };

  const handleExport = async () => {
    if (!token) return;
    setErrMsg("");
    setExporting(true);
    try {
      const { blob, filename } = await api.exportData(token, includeLogs);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    if (!token || !importFile) return;
    setErrMsg("");
    setImportSummary(null);
    setImporting(true);
    try {
      const result = await api.importData(token, importFile);
      setImportSummary(result);
      setImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="w-full">
      <SectionLabel>{t.profile.basicInfo || "基本信息"}</SectionLabel>
      <Glass padding={22} radius={20} style={{ marginBottom: 20 }}>
        {/* Avatar & Photo Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 20, paddingBottom: 20, borderBottom: "1px solid var(--aurora-border)" }}>
          <div
            style={{
              position: "relative",
              width: 76,
              height: 76,
              borderRadius: 9999,
              overflow: "hidden",
              background: "var(--aurora-primary-grad)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              fontWeight: 600,
              flexShrink: 0,
              boxShadow: "0 4px 16px -4px rgba(124, 58, 237, 0.4)",
              border: "2px solid var(--aurora-border)",
            }}
          >
            {user.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatar_url}
                alt={user.name || user.email}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              (user.name || user.email)[0]?.toUpperCase() || "?"
            )}
            {uploadingAvatar && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(0,0,0,0.5)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                  fontSize: 11,
                }}
              >
                <Icon name="refresh" size={18} style={{ animation: "spin 1s linear infinite" }} />
              </div>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={handleAvatarFile}
                style={{ display: "none" }}
              />
              <Btn
                type="button"
                size="sm"
                variant="glass"
                icon="camera"
                onClick={() => avatarInputRef.current?.click()}
                disabled={uploadingAvatar}
              >
                {uploadingAvatar ? t.profile.uploadingAvatar : t.profile.changeAvatar}
              </Btn>
              {user.avatar_url && (
                <Btn
                  type="button"
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  onClick={handleRemoveAvatar}
                  disabled={uploadingAvatar}
                  style={{ color: "#DC2626" }}
                >
                  {t.profile.removeAvatar}
                </Btn>
              )}
            </div>
            <p style={{ margin: 0, fontSize: 12, color: "var(--aurora-fg4)" }}>
              {t.profile.avatarHint}
            </p>
          </div>
        </div>

        {/* Nickname row */}
        <form onSubmit={handleSaveProfile} style={{ padding: "14px 0", borderBottom: "1px solid var(--aurora-border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 13, color: "var(--aurora-fg3)", width: 70, flexShrink: 0 }}>
              {t.profile.name}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <GhostInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.profile.nicknamePlaceholder}
                maxLength={50}
              />
            </div>
            <Btn
              type="submit"
              size="sm"
              icon="check"
              disabled={savingName || name === (user.name || "")}
            >
              {savingName ? t.profile.savingProfile : t.profile.saveProfile}
            </Btn>
          </div>
        </form>

        <Row label={t.profile.email} value={user.email} />
        <Row label={t.profile.role} valueNode={<Chip>{user.role}</Chip>} />
        <Row
          label={t.profile.status}
          valueNode={<Chip tone={user.status === "active" ? "success" : "warn"}>{user.status}</Chip>}
        />

        {profileMsg && (
          <div
            style={{
              marginTop: 14,
              padding: "8px 12px",
              borderRadius: 8,
              fontSize: 12,
              background: profileMsg.type === "success" ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)",
              color: profileMsg.type === "success" ? "#10B981" : "#DC2626",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Icon name={profileMsg.type === "success" ? "check" : "close"} size={14} />
            {profileMsg.text}
          </div>
        )}
      </Glass>

      <SectionLabel>服务器与网络连接</SectionLabel>
      <Glass padding={20} radius={20} style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", marginBottom: 3 }}>
              当前连接服务器节点
            </div>
            <div style={{ fontSize: 12, color: "var(--aurora-fg3)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {currentServerUrl || getApiBase()}
            </div>
          </div>
          <Btn variant="primary" size="sm" icon="server" onClick={() => openServerSwitchModal()}>
            切换服务器
          </Btn>
        </div>
      </Glass>

      <SectionLabel>{t.notify.title}</SectionLabel>
      <NotifySettings />

      <SectionLabel>{t.profile.backup}</SectionLabel>
      <Glass padding={22} radius={20} style={{ marginBottom: 20 }}>
        <p style={{ fontSize: 13, color: "var(--aurora-fg3)", margin: "0 0 14px" }}>
          {t.profile.backupDesc}
        </p>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--aurora-fg3)", marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={includeLogs}
            onChange={(e) => setIncludeLogs(e.target.checked)}
          />
          {t.profile.includeLogs}
        </label>
        <Btn size="sm" icon="arrow_down" onClick={handleExport} disabled={exporting}>
          {exporting ? t.profile.exporting : t.profile.exportBtn}
        </Btn>

        <hr style={{ border: 0, borderTop: "1px solid var(--aurora-border)", margin: "18px 0" }} />

        <p style={{ fontSize: 13, color: "var(--aurora-fg3)", margin: "0 0 12px" }}>
          {t.profile.restoreDesc}
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
          style={{ fontSize: 12, marginBottom: 12, display: "block" }}
        />
        <Btn size="sm" icon="arrow_up" onClick={handleImport} disabled={!importFile || importing}>
          {importing ? t.profile.importing : t.profile.importBtn}
        </Btn>

        {importSummary && (
          <div
            style={{
              marginTop: 14,
              padding: "10px 12px",
              borderRadius: 10,
              background: "rgba(16,185,129,0.10)",
              color: "var(--aurora-fg2)",
              fontSize: 12,
            }}
          >
            <strong>{t.profile.importSuccess}</strong>
            <ul style={{ margin: "6px 0 0 18px", padding: 0, lineHeight: 1.7 }}>
              {Object.entries(importSummary.counts).map(([k, v]) => (
                <li key={k}>
                  <code>{k}</code>: {v}
                </li>
              ))}
            </ul>
            {importSummary.warnings.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", color: "var(--aurora-fg3)" }}>
                  {t.profile.importWarnings} ({importSummary.warnings.length})
                </summary>
                <ul style={{ margin: "6px 0 0 18px" }}>
                  {importSummary.warnings.map((w, i) => (
                    <li key={i} style={{ color: "var(--aurora-fg4)" }}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {errMsg && (
          <div
            style={{
              marginTop: 14,
              padding: "10px 12px",
              borderRadius: 10,
              background: "rgba(239,68,68,0.10)",
              color: "#B91C1C",
              fontSize: 12,
            }}
          >
            {errMsg}
          </div>
        )}
      </Glass>

      {/* Danger Zone: Account Deletion (App Store Compliance) */}
      <div
        style={{
          marginTop: 28,
          marginBottom: 20,
          padding: "18px 20px",
          borderRadius: 16,
          border: "1px solid rgba(239, 68, 68, 0.25)",
          background: "rgba(239, 68, 68, 0.04)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#EF4444", marginBottom: 3 }}>
              注销账号与清除全部数据 (Delete Account)
            </div>
            <div style={{ fontSize: 12, color: "var(--aurora-fg4)" }}>
              物理永久删除您的账号及全部记忆、会话、设备绑定与知识图谱数据，此操作不可逆。
            </div>
          </div>
          <Btn
            variant="danger"
            size="sm"
            icon="trash"
            onClick={() => {
              setShowDeleteModal(true);
              setDeleteConfirmation("");
              setDeleteError("");
            }}
          >
            注销账户
          </Btn>
        </div>
      </div>

      {showDeleteModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: 16,
          }}
        >
          <div
            style={{
              background: "var(--aurora-card, #12121A)",
              border: "1px solid rgba(239, 68, 68, 0.4)",
              borderRadius: 20,
              padding: 24,
              maxWidth: 440,
              width: "100%",
              boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#EF4444", marginBottom: 12 }}>
              <Icon name="trash" size={24} />
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>永久注销账户确认</h3>
            </div>
            <p style={{ fontSize: 13, color: "var(--aurora-fg2)", lineHeight: 1.6, marginBottom: 16 }}>
              您即将彻底注销账户 <strong>{user.email}</strong>。注销后，您的所有个人知识图谱、长期记忆规则、大模型配置和设备绑定数据将被<strong>永久物理抹除</strong>，无法恢复。
            </p>
            <p style={{ fontSize: 12, color: "var(--aurora-fg4)", marginBottom: 8 }}>
              请输入您的账号邮箱 <strong>{user.email}</strong> 以确认操作：
            </p>
            <GhostInput
              placeholder={user.email}
              value={deleteConfirmation}
              onChange={(e) => setDeleteConfirmation(e.target.value)}
              style={{ marginBottom: 16 }}
            />
            {deleteError && (
              <div style={{ color: "#EF4444", fontSize: 12, marginBottom: 14 }}>
                {deleteError}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <Btn
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteModal(false)}
                disabled={isDeletingAccount}
              >
                取消
              </Btn>
              <Btn
                variant="danger"
                size="sm"
                onClick={async () => {
                  if (deleteConfirmation.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
                    setDeleteError(`请输入正确的账号邮箱「${user.email}」进行确认`);
                    return;
                  }
                  setIsDeletingAccount(true);
                  setDeleteError("");
                  try {
                    await api.deleteAccount(deleteConfirmation.trim());
                    setShowDeleteModal(false);
                    logout();
                    router.push("/");
                  } catch (err: unknown) {
                    setDeleteError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setIsDeletingAccount(false);
                  }
                }}
                disabled={isDeletingAccount}
                icon="trash"
              >
                {isDeletingAccount ? "正在抹除数据..." : "确认永久注销"}
              </Btn>
            </div>
          </div>
        </div>
      )}

      <div style={{ textAlign: "right" }}>
        <Btn variant="ghost" size="sm" icon="log_out" onClick={logout}>
          {t.profile.logout}
        </Btn>
      </div>
    </div>
  );
}

function AdminPanelTab() {
  return (
    <Glass padding={28} radius={20} style={{ textAlign: "center" }}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          margin: "0 auto 16px",
          background: "var(--aurora-brand-grad)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 12px 40px -10px rgba(124,58,237,0.5)",
        }}
      >
        <Icon name="lock" size={26} style={{ color: "#fff" }} strokeWidth={2} />
      </div>
      <h3 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 600, color: "var(--aurora-fg1)" }}>
        管理员控制中心
      </h3>
      <p style={{ margin: "0 auto 20px", maxWidth: 440, fontSize: 13.5, color: "var(--aurora-fg3)", lineHeight: 1.6 }}>
        您拥有管理员权限，可以在管理控制台进行多用户账号审核、全量设备监管、系统同步状态分析与全局资源调配。
      </p>
      <Link href="/admin">
        <Btn icon="external_link" size="md">
          进入管理控制台 &rarr;
        </Btn>
      </Link>
    </Glass>
  );
}

function Row({
  label,
  value,
  valueNode,
}: {
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "10px 0",
        borderBottom: "1px solid var(--aurora-border)",
        gap: 12,
      }}
    >
      <span style={{ fontSize: 13, color: "var(--aurora-fg3)" }}>{label}</span>
      {valueNode ?? (
        <span style={{ fontSize: 13, color: "var(--aurora-fg1)", fontWeight: 500 }}>{value}</span>
      )}
    </div>
  );
}
