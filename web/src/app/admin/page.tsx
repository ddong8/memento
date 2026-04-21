"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";
import { getApiBase, authFetch } from "@/lib/api-client";
import { Icon, ToolGlyph, PlatformGlyph } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, TopBar, SectionLabel } from "@/components/aurora/primitives";
import { TokenDisplay } from "@/components/TokenDisplay";

interface AdminUser { id: string; email: string; name: string | null; role: string; status: string; created_at: string; collector_token?: string | null; }
interface SyncStatus { tool_id: string; display_name: string; total_files: number; last_sync_at: string | null; latest_file: string | null; }
interface DeviceInfo { id: string; name: string; device_id: string; collector_version: string | null; last_heartbeat: string | null; created_at: string; document_count: number; tools: string[]; }

export default function AdminPage() {
  const { token, user } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [purging, setPurging] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const { t, locale } = useI18n();

  useEffect(() => {
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    authFetch(`${getApiBase()}/api/admin/users`, { headers }).then((r) => r.json()).then(setUsers).catch((e) => setError(e.message));
    authFetch(`${getApiBase()}/api/admin/sync/status`, { headers }).then((r) => r.json()).then(setSyncStatus).catch(() => {});
    authFetch(`${getApiBase()}/api/devices`).then((r) => r.json()).then(setDevices).catch(() => {});
  }, [token]);

  const approveUser = async (userId: string) => {
    const res = await authFetch(`${getApiBase()}/api/admin/users/${userId}/approve`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({} as { collector_token?: string; role?: string }));
    setUsers((prev) => prev.map((u) => u.id === userId ? {
      ...u,
      status: "active",
      role: data.role ?? (u.role === "pending" ? "viewer" : u.role),
      collector_token: data.collector_token ?? u.collector_token,
    } : u));
  };

  const deleteDevice = async (device: DeviceInfo) => {
    if (!confirm(t.admin.deleteConfirm.replace("{name}", device.name))) return;
    setPurging(device.id);
    setMessage("");
    try {
      const res = await authFetch(`${getApiBase()}/api/devices/${device.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      setMessage(t.admin.deleteSuccess.replace("{name}", device.name).replace("{count}", String(data.documents_deleted ?? 0)));
      setDevices((prev) => prev.filter((d) => d.id !== device.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setPurging(null);
    }
  };

  const resyncDevice = async (device: DeviceInfo) => {
    if (!confirm(t.admin.resyncConfirm)) return;
    setPurging(device.id);
    setMessage("");
    try {
      await authFetch(`${getApiBase()}/api/devices/${device.id}/purge`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      await authFetch(`${getApiBase()}/api/devices/${device.id}/command?action=resync`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      setMessage(t.admin.resyncSuccess.replace("{name}", device.name));
      setTimeout(() => window.location.reload(), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resync failed");
    } finally {
      setPurging(null);
    }
  };

  const updateDevice = async (device: DeviceInfo) => {
    await authFetch(`${getApiBase()}/api/devices/${device.id}/command?action=update`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    setMessage(t.admin.updateSuccess.replace("{name}", device.name));
  };

  if (!user || !["admin", "owner"].includes(user.role)) {
    return <div style={{ textAlign: "center", color: "var(--aurora-fg4)", marginTop: 80 }}>{t.admin.requireAdmin}</div>;
  }

  const dateFmt = locale === "zh-CN" ? "zh-CN" : "en-US";

  return (
    <div className="max-w-5xl mx-auto">
      <TopBar title={t.admin.title} />

      {error && (
        <div
          style={{
            padding: 12,
            borderRadius: 12,
            background: "rgba(239,68,68,0.10)",
            color: "#B91C1C",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}
      {message && (
        <div
          style={{
            padding: 12,
            borderRadius: 12,
            background: "rgba(16,185,129,0.10)",
            color: "#047857",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {message}
        </div>
      )}

      <SectionLabel>{t.admin.devices}</SectionLabel>
      <Glass padding={6} radius={20} style={{ marginBottom: 24 }}>
        {devices.map((d, i) => (
          <div
            key={d.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 14px",
              borderTop: i === 0 ? "none" : "1px solid var(--aurora-border)",
              flexWrap: "wrap",
            }}
          >
            <PlatformGlyph name={d.name} size={32} />
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: "var(--aurora-fg1)", letterSpacing: "-0.01em" }}>
                  {d.name}
                </span>
                {d.collector_version && <Chip tone="success">v{d.collector_version}</Chip>}
                <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
                  {t.admin.docsCount.replace("{count}", String(d.document_count))}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                {d.tools.map((tid) => (
                  <span
                    key={tid}
                    style={{
                      fontSize: 10.5,
                      padding: "1px 8px",
                      borderRadius: 9999,
                      background: "var(--aurora-chip)",
                      color: "var(--aurora-fg3)",
                      textTransform: "capitalize",
                    }}
                  >
                    {tid.replace("_", " ")}
                  </span>
                ))}
              </div>
            </div>
            <span
              style={{
                fontSize: 11,
                color: "var(--aurora-fg4)",
                whiteSpace: "nowrap",
              }}
            >
              {d.last_heartbeat ? new Date(d.last_heartbeat).toLocaleString(dateFmt) : t.admin.neverSynced}
            </span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn variant="glass" size="sm" icon="refresh" onClick={() => updateDevice(d)}>
                {t.admin.updateCollector}
              </Btn>
              <Btn size="sm" onClick={() => resyncDevice(d)} disabled={purging === d.id}>
                {purging === d.id ? "…" : t.admin.resync}
              </Btn>
              <Btn variant="danger" size="sm" icon="trash" onClick={() => deleteDevice(d)} disabled={purging === d.id}>
                {t.admin.deleteDevice}
              </Btn>
            </div>
          </div>
        ))}
        {devices.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--aurora-fg4)", fontSize: 13, padding: 24 }}>{t.devices.noDevices}</div>
        )}
      </Glass>

      <SectionLabel>{t.admin.syncStatus}</SectionLabel>
      <Glass padding={6} radius={20} style={{ marginBottom: 24 }}>
        {syncStatus.map((s, i) => (
          <div
            key={s.tool_id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 14px",
              borderTop: i === 0 ? "none" : "1px solid var(--aurora-border)",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <ToolGlyph id={s.tool_id} size={28} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: "var(--aurora-fg1)", textTransform: "capitalize" }}>
                  {s.display_name}
                </div>
                <div style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
                  {s.total_files} {t.files}
                </div>
              </div>
            </div>
            <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
              {s.last_sync_at ? new Date(s.last_sync_at).toLocaleString(dateFmt) : t.admin.neverSynced}
            </span>
          </div>
        ))}
      </Glass>

      <SectionLabel>{t.admin.users}</SectionLabel>
      <Glass padding={6} radius={20}>
        {users.map((u, i) => (
          <div
            key={u.id}
            style={{
              padding: "12px 14px",
              borderTop: i === 0 ? "none" : "1px solid var(--aurora-border)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  style={{
                    width: 32, height: 32, borderRadius: 9999,
                    background: "var(--aurora-primary-grad)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#fff", fontSize: 12, fontWeight: 700,
                  }}
                >
                  {(u.name || u.email)[0]?.toUpperCase()}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--aurora-fg1)" }}>
                    {u.name || u.email}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>{u.email}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Chip tone={u.status === "active" ? "success" : "warn"}>{u.status}</Chip>
                <Chip>{u.role}</Chip>
                {u.status === "pending" && (
                  <Btn size="sm" icon="check" onClick={() => approveUser(u.id)}>
                    {t.approve}
                  </Btn>
                )}
              </div>
            </div>
            {u.collector_token && (
              <div style={{ marginTop: 8, paddingLeft: 42 }}>
                <TokenDisplay token={u.collector_token} maskByDefault={true} compact />
              </div>
            )}
          </div>
        ))}
      </Glass>
    </div>
  );
}
