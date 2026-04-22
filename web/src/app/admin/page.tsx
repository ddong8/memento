"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useI18n, fmt } from "@/lib/i18n";
import { getApiBase, authFetch } from "@/lib/api-client";
import { ToolGlyph, PlatformGlyph } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, TopBar, SectionLabel } from "@/components/aurora/primitives";
import { TokenDisplay } from "@/components/TokenDisplay";

// ──────────────────────────────────────────────────────────────────────────
// Shared types
// ──────────────────────────────────────────────────────────────────────────

interface AdminUser {
  id: string; email: string; name: string | null;
  role: string; status: string; created_at: string;
  collector_token?: string | null;
}
interface SyncStatus { tool_id: string; display_name: string; total_files: number; last_sync_at: string | null; latest_file: string | null; }
interface DeviceInfo { id: string; name: string; device_id: string; collector_version: string | null; last_heartbeat: string | null; created_at: string; document_count: number; tools: string[]; }
interface Invite { id: string; code: string; max_uses: number; use_count: number; expires_at: string | null; role_on_accept: string; note: string | null; created_at: string; created_by: string | null; }
interface Permission { id: string; user_id: string; project_id: string | null; tool_id: string | null; permission: string; created_at: string; }
interface AuditEntry { id: number; user_id: string | null; document_id: string | null; action: string; ip_address: string | null; created_at: string; }

type Tab = "users" | "devices" | "invites" | "perms" | "audit" | "sync";

// ──────────────────────────────────────────────────────────────────────────
// Root
// ──────────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { user, token } = useAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("users");
  const [banner, setBanner] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const flash = useCallback((tone: "ok" | "err", text: string) => {
    setBanner({ tone, text });
    setTimeout(() => setBanner(null), 4000);
  }, []);

  if (!user || !["admin", "owner"].includes(user.role)) {
    return <div style={{ textAlign: "center", color: "var(--aurora-fg4)", marginTop: 80 }}>{t.admin.requireAdmin}</div>;
  }

  const isOwner = user.role === "owner";
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  const tabs: { id: Tab; label: string }[] = [
    { id: "users", label: t.admin.tabUsers },
    { id: "devices", label: t.admin.tabDevices },
    { id: "invites", label: t.admin.tabInvites },
    { id: "perms", label: t.admin.tabPermissions },
    { id: "audit", label: t.admin.tabAudit },
    { id: "sync", label: t.admin.tabSync },
  ];

  return (
    <div className="max-w-5xl mx-auto">
      <TopBar title={t.admin.title} />

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 16, borderBottom: "1px solid var(--aurora-border)" }}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            style={{
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 500,
              background: "transparent",
              border: 0,
              borderBottom: "2px solid",
              borderBottomColor: tab === tb.id ? "var(--aurora-accent)" : "transparent",
              color: tab === tb.id ? "var(--aurora-fg1)" : "var(--aurora-fg3)",
              cursor: "pointer",
              letterSpacing: "-0.01em",
            }}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {/* Banner */}
      {banner && (
        <div style={{
          padding: 12, borderRadius: 12, marginBottom: 16, fontSize: 13,
          background: banner.tone === "ok" ? "rgba(16,185,129,0.10)" : "rgba(239,68,68,0.10)",
          color: banner.tone === "ok" ? "#047857" : "#B91C1C",
        }}>
          {banner.text}
        </div>
      )}

      {tab === "users" && <UsersTab headers={headers} flash={flash} isOwner={isOwner} selfId={user.id} />}
      {tab === "devices" && <DevicesTab headers={headers} flash={flash} />}
      {tab === "invites" && <InvitesTab headers={headers} flash={flash} />}
      {tab === "perms" && <PermissionsTab headers={headers} flash={flash} />}
      {tab === "audit" && <AuditTab headers={headers} />}
      {tab === "sync" && <SyncStatusTab headers={headers} flash={flash} />}
    </div>
  );
}

type Flash = (tone: "ok" | "err", text: string) => void;
type Headers = Record<string, string> | undefined;

// ──────────────────────────────────────────────────────────────────────────
// Users tab
// ──────────────────────────────────────────────────────────────────────────

function UsersTab({ headers, flash, isOwner, selfId }: { headers: Headers; flash: Flash; isOwner: boolean; selfId: string }) {
  const { t } = useI18n();
  const [users, setUsers] = useState<AdminUser[]>([]);

  const reload = useCallback(() => {
    authFetch(`${getApiBase()}/api/admin/users`, { headers }).then((r) => r.json()).then(setUsers).catch((e) => flash("err", e.message));
  }, [headers, flash]);

  useEffect(() => { reload(); }, [reload]);

  const approve = async (u: AdminUser) => {
    const res = await authFetch(`${getApiBase()}/api/admin/users/${u.id}/approve`, { method: "POST", headers });
    const d = await res.json().catch(() => ({} as { collector_token?: string; role?: string }));
    setUsers((prev) => prev.map((x) => x.id === u.id ? { ...x, status: "active", role: d.role ?? "viewer", collector_token: d.collector_token ?? x.collector_token } : x));
    flash("ok", fmt(t.admin.userUpdateSuccess, { email: u.email }));
  };

  const update = async (u: AdminUser, patch: { role?: string; status?: string }) => {
    try {
      const res = await authFetch(`${getApiBase()}/api/admin/users/${u.id}`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await res.text());
      setUsers((prev) => prev.map((x) => x.id === u.id ? { ...x, ...patch } : x));
      flash("ok", fmt(t.admin.userUpdateSuccess, { email: u.email }));
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "update failed");
    }
  };

  const resetToken = async (u: AdminUser) => {
    if (!confirm(fmt(t.admin.userResetTokenConfirm, { email: u.email }))) return;
    try {
      const res = await authFetch(`${getApiBase()}/api/admin/users/${u.id}/rotate-collector-token`, { method: "POST", headers });
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      setUsers((prev) => prev.map((x) => x.id === u.id ? { ...x, collector_token: d.collector_token } : x));
      flash("ok", fmt(t.admin.userResetTokenSuccess, { email: u.email }));
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "reset failed");
    }
  };

  const del = async (u: AdminUser) => {
    if (!confirm(fmt(t.admin.userDeleteConfirm, { email: u.email }))) return;
    try {
      const res = await authFetch(`${getApiBase()}/api/admin/users/${u.id}`, { method: "DELETE", headers });
      if (!res.ok) throw new Error(await res.text());
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
      flash("ok", fmt(t.admin.userDeleteSuccess, { email: u.email }));
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "delete failed");
    }
  };

  const transferOwner = async (u: AdminUser) => {
    if (!confirm(fmt(t.admin.userTransferOwnerConfirm, { email: u.email }))) return;
    try {
      const res = await authFetch(`${getApiBase()}/api/admin/users/${u.id}/transfer-ownership`, { method: "POST", headers });
      if (!res.ok) throw new Error(await res.text());
      flash("ok", fmt(t.admin.userTransferOwnerSuccess, { email: u.email }));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "transfer failed");
    }
  };

  const roles = ["viewer", "admin"];
  if (isOwner) roles.push("owner");

  return (
    <Glass padding={6} radius={20}>
      {users.map((u, i) => (
        <div
          key={u.id}
          style={{ padding: "14px 16px", borderTop: i === 0 ? "none" : "1px solid var(--aurora-border)" }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 9999,
                background: "var(--aurora-primary-grad)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: 12, fontWeight: 700,
              }}>
                {(u.name || u.email)[0]?.toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: "var(--aurora-fg1)" }}>
                  {u.name || u.email}
                  {u.id === selfId && <span style={{ marginLeft: 8, fontSize: 10, color: "var(--aurora-fg4)" }}>(you)</span>}
                </div>
                <div style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>{u.email}</div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {/* Role dropdown — disabled for self and for owner role (unless isOwner) */}
              {u.status !== "pending" && (
                <select
                  value={u.role}
                  disabled={u.id === selfId}
                  onChange={(e) => update(u, { role: e.target.value })}
                  style={{
                    fontSize: 11, padding: "4px 8px", borderRadius: 8,
                    border: "1px solid var(--aurora-border)",
                    background: "var(--aurora-chip)", color: "var(--aurora-fg2)",
                    cursor: u.id === selfId ? "not-allowed" : "pointer",
                  }}
                >
                  {/* Always include current role for correct display */}
                  {!roles.includes(u.role) && <option value={u.role}>{u.role}</option>}
                  {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              )}

              {/* Status chip — click to toggle active/disabled (only if not self) */}
              {u.status === "pending" ? (
                <Chip tone="warn">{u.status}</Chip>
              ) : (
                <button
                  disabled={u.id === selfId}
                  onClick={() => update(u, { status: u.status === "active" ? "disabled" : "active" })}
                  title={u.status === "active" ? "Disable" : "Re-enable"}
                  style={{
                    fontSize: 10, padding: "2px 8px", borderRadius: 9999, border: 0,
                    cursor: u.id === selfId ? "not-allowed" : "pointer",
                    background: u.status === "active" ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.12)",
                    color: u.status === "active" ? "#047857" : "#B91C1C",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {u.status}
                </button>
              )}

              {u.status === "pending" && (
                <Btn size="sm" icon="check" onClick={() => approve(u)}>{t.approve}</Btn>
              )}
              {u.status === "active" && u.id !== selfId && (
                <>
                  <Btn variant="glass" size="sm" icon="refresh" onClick={() => resetToken(u)}>
                    {t.admin.userResetToken}
                  </Btn>
                  {isOwner && u.role !== "owner" && (
                    <Btn variant="glass" size="sm" icon="arrow_up" onClick={() => transferOwner(u)}>
                      {t.admin.userTransferOwner}
                    </Btn>
                  )}
                  {isOwner && (
                    <Btn variant="danger" size="sm" icon="trash" onClick={() => del(u)}>
                      {t.admin.userDelete}
                    </Btn>
                  )}
                </>
              )}
            </div>
          </div>

          {u.collector_token && (
            <div style={{ marginTop: 8, paddingLeft: 42 }}>
              <TokenDisplay token={u.collector_token} maskByDefault compact />
            </div>
          )}
        </div>
      ))}
    </Glass>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Devices tab (unchanged logic, extracted)
// ──────────────────────────────────────────────────────────────────────────

function DevicesTab({ headers, flash }: { headers: Headers; flash: Flash }) {
  const { t, locale } = useI18n();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    authFetch(`${getApiBase()}/api/devices`, { headers }).then((r) => r.json()).then(setDevices).catch((e) => flash("err", e.message));
  }, [headers, flash]);

  const dateFmt = locale === "zh-CN" ? "zh-CN" : "en-US";

  const del = async (d: DeviceInfo) => {
    if (!confirm(fmt(t.admin.deleteConfirm, { name: d.name }))) return;
    setBusy(d.id);
    try {
      const res = await authFetch(`${getApiBase()}/api/devices/${d.id}`, { method: "DELETE", headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      flash("ok", fmt(t.admin.deleteSuccess, { name: d.name, count: data.documents_deleted ?? 0 }));
      setDevices((prev) => prev.filter((x) => x.id !== d.id));
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "delete failed");
    } finally { setBusy(null); }
  };

  const resync = async (d: DeviceInfo) => {
    if (!confirm(t.admin.resyncConfirm)) return;
    setBusy(d.id);
    try {
      await authFetch(`${getApiBase()}/api/devices/${d.id}/purge`, { method: "DELETE", headers });
      await authFetch(`${getApiBase()}/api/devices/${d.id}/command?action=resync`, { method: "POST", headers });
      flash("ok", fmt(t.admin.resyncSuccess, { name: d.name }));
      setTimeout(() => window.location.reload(), 1000);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "resync failed");
    } finally { setBusy(null); }
  };

  const update = async (d: DeviceInfo) => {
    await authFetch(`${getApiBase()}/api/devices/${d.id}/command?action=update`, { method: "POST", headers });
    flash("ok", fmt(t.admin.updateSuccess, { name: d.name }));
  };

  return (
    <Glass padding={6} radius={20}>
      {devices.map((d, i) => (
        <div key={d.id} style={{
          display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
          borderTop: i === 0 ? "none" : "1px solid var(--aurora-border)", flexWrap: "wrap",
        }}>
          <PlatformGlyph name={d.name} size={32} />
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: "var(--aurora-fg1)" }}>{d.name}</span>
              {d.collector_version && <Chip tone="success">v{d.collector_version}</Chip>}
              <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
                {fmt(t.admin.docsCount, { count: d.document_count })}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
              {d.tools.map((tid) => (
                <span key={tid} style={{
                  fontSize: 10.5, padding: "1px 8px", borderRadius: 9999,
                  background: "var(--aurora-chip)", color: "var(--aurora-fg3)",
                  textTransform: "capitalize",
                }}>{tid.replace("_", " ")}</span>
              ))}
            </div>
          </div>
          <span style={{ fontSize: 11, color: "var(--aurora-fg4)", whiteSpace: "nowrap" }}>
            {d.last_heartbeat ? new Date(d.last_heartbeat).toLocaleString(dateFmt) : t.admin.neverSynced}
          </span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="glass" size="sm" icon="refresh" onClick={() => update(d)}>{t.admin.updateCollector}</Btn>
            <Btn size="sm" onClick={() => resync(d)} disabled={busy === d.id}>
              {busy === d.id ? "…" : t.admin.resync}
            </Btn>
            <Btn variant="danger" size="sm" icon="trash" onClick={() => del(d)} disabled={busy === d.id}>
              {t.admin.deleteDevice}
            </Btn>
          </div>
        </div>
      ))}
      {devices.length === 0 && (
        <div style={{ textAlign: "center", color: "var(--aurora-fg4)", fontSize: 13, padding: 24 }}>
          {t.devices.noDevices}
        </div>
      )}
    </Glass>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Invites tab
// ──────────────────────────────────────────────────────────────────────────

function InvitesTab({ headers, flash }: { headers: Headers; flash: Flash }) {
  const { t } = useI18n();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [form, setForm] = useState({ max_uses: 1, expires_days: "", role_on_accept: "viewer", note: "" });

  const reload = useCallback(() => {
    authFetch(`${getApiBase()}/api/admin/invites`, { headers }).then((r) => r.json()).then(setInvites).catch((e) => flash("err", e.message));
  }, [headers, flash]);
  useEffect(() => { reload(); }, [reload]);

  const create = async () => {
    const body: Record<string, unknown> = {
      max_uses: form.max_uses,
      role_on_accept: form.role_on_accept,
      note: form.note || null,
    };
    if (form.expires_days) body.expires_days = Number(form.expires_days);
    try {
      const res = await authFetch(`${getApiBase()}/api/admin/invites`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      reload();
      setForm({ max_uses: 1, expires_days: "", role_on_accept: "viewer", note: "" });
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "create failed");
    }
  };

  const revoke = async (id: string) => {
    if (!confirm(t.admin.inviteRevokeConfirm)) return;
    try {
      const res = await authFetch(`${getApiBase()}/api/admin/invites/${id}`, { method: "DELETE", headers });
      if (!res.ok) throw new Error(await res.text());
      setInvites((prev) => prev.filter((x) => x.id !== id));
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "revoke failed");
    }
  };

  return (
    <>
      <p style={{ fontSize: 13, color: "var(--aurora-fg3)", marginBottom: 14 }}>{t.admin.invitesSubtitle}</p>

      {/* Create form */}
      <Glass padding={16} radius={16} style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label={t.admin.inviteMaxUses}>
            <input type="number" min={1} max={1000} value={form.max_uses}
                   onChange={(e) => setForm({ ...form, max_uses: Number(e.target.value) })}
                   style={fieldInputStyle(70)} />
          </Field>
          <Field label={t.admin.inviteExpiresDays}>
            <input type="number" min={1} placeholder={t.admin.inviteNeverExpires}
                   value={form.expires_days}
                   onChange={(e) => setForm({ ...form, expires_days: e.target.value })}
                   style={fieldInputStyle(100)} />
          </Field>
          <Field label={t.admin.inviteRoleOnAccept}>
            <select value={form.role_on_accept}
                    onChange={(e) => setForm({ ...form, role_on_accept: e.target.value })}
                    style={fieldInputStyle(100)}>
              <option value="viewer">viewer</option>
              <option value="admin">admin</option>
            </select>
          </Field>
          <Field label={t.admin.inviteNote} grow>
            <input type="text" value={form.note}
                   onChange={(e) => setForm({ ...form, note: e.target.value })}
                   style={fieldInputStyle()} />
          </Field>
          <Btn icon="plus" onClick={create}>{t.admin.inviteCreate}</Btn>
        </div>
      </Glass>

      {/* List */}
      <Glass padding={6} radius={20}>
        {invites.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--aurora-fg4)", fontSize: 13, padding: 24 }}>
            {t.admin.invitesEmpty}
          </div>
        )}
        {invites.map((inv, i) => {
          const expired = inv.expires_at ? new Date(inv.expires_at) < new Date() : false;
          const exhausted = inv.use_count >= inv.max_uses;
          return (
            <div key={inv.id} style={{
              padding: "12px 14px",
              borderTop: i === 0 ? "none" : "1px solid var(--aurora-border)",
              display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            }}>
              <div style={{ flex: 1, minWidth: 180, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <TokenDisplay token={inv.code} maskByDefault={false} compact />
                <Chip>{inv.role_on_accept}</Chip>
                <Chip tone={exhausted ? "warn" : "neutral"}>
                  {fmt(t.admin.inviteUsage, { used: inv.use_count, max: inv.max_uses })}
                </Chip>
                {inv.expires_at && (
                  <Chip tone={expired ? "warn" : "neutral"}>
                    {expired ? "expired" : new Date(inv.expires_at).toLocaleDateString()}
                  </Chip>
                )}
                {inv.note && <span style={{ fontSize: 12, color: "var(--aurora-fg4)" }}>{inv.note}</span>}
              </div>
              <Btn variant="danger" size="sm" icon="trash" onClick={() => revoke(inv.id)}>
                {t.admin.inviteRevoke}
              </Btn>
            </div>
          );
        })}
      </Glass>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Permissions tab
// ──────────────────────────────────────────────────────────────────────────

function PermissionsTab({ headers, flash }: { headers: Headers; flash: Flash }) {
  const { t } = useI18n();
  const [perms, setPerms] = useState<Permission[]>([]);
  const [form, setForm] = useState({ user_id: "", project_id: "", tool_id: "", permission: "read" });

  const reload = useCallback(() => {
    authFetch(`${getApiBase()}/api/admin/permissions`, { headers }).then((r) => r.json()).then(setPerms).catch((e) => flash("err", e.message));
  }, [headers, flash]);
  useEffect(() => { reload(); }, [reload]);

  const grant = async () => {
    try {
      const body: Record<string, unknown> = {
        user_id: form.user_id,
        permission: form.permission,
      };
      if (form.project_id) body.project_id = form.project_id;
      if (form.tool_id) body.tool_id = form.tool_id;
      const res = await authFetch(`${getApiBase()}/api/admin/permissions/grant`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      reload();
      setForm({ user_id: "", project_id: "", tool_id: "", permission: "read" });
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "grant failed");
    }
  };

  const revoke = async (id: string) => {
    if (!confirm(t.admin.permsRevokeConfirm)) return;
    try {
      const res = await authFetch(`${getApiBase()}/api/admin/permissions/${id}`, { method: "DELETE", headers });
      if (!res.ok) throw new Error(await res.text());
      setPerms((prev) => prev.filter((x) => x.id !== id));
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "revoke failed");
    }
  };

  return (
    <>
      <p style={{ fontSize: 13, color: "var(--aurora-fg3)", marginBottom: 14 }}>{t.admin.permsSubtitle}</p>

      <Glass padding={16} radius={16} style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="user_id" grow>
            <input type="text" value={form.user_id} placeholder="uuid"
                   onChange={(e) => setForm({ ...form, user_id: e.target.value })}
                   style={fieldInputStyle()} />
          </Field>
          <Field label="project_id">
            <input type="text" value={form.project_id} placeholder={t.admin.permsGrantPlaceholderProject}
                   onChange={(e) => setForm({ ...form, project_id: e.target.value })}
                   style={fieldInputStyle(180)} />
          </Field>
          <Field label="tool_id">
            <input type="text" value={form.tool_id} placeholder={t.admin.permsGrantPlaceholderTool}
                   onChange={(e) => setForm({ ...form, tool_id: e.target.value })}
                   style={fieldInputStyle(140)} />
          </Field>
          <Field label={t.admin.permsPermission}>
            <select value={form.permission}
                    onChange={(e) => setForm({ ...form, permission: e.target.value })}
                    style={fieldInputStyle(100)}>
              <option value="read">read</option>
              <option value="write">write</option>
            </select>
          </Field>
          <Btn icon="plus" onClick={grant}>{t.admin.permsGrant}</Btn>
        </div>
      </Glass>

      <Glass padding={6} radius={20}>
        {perms.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--aurora-fg4)", fontSize: 13, padding: 24 }}>
            {t.admin.permsEmpty}
          </div>
        )}
        {perms.map((p, i) => (
          <div key={p.id} style={{
            padding: "12px 14px",
            borderTop: i === 0 ? "none" : "1px solid var(--aurora-border)",
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          }}>
            <div style={{ flex: 1, minWidth: 180, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <code style={codeStyle}>user: {p.user_id.slice(0, 8)}…</code>
              {p.project_id && <code style={codeStyle}>project: {p.project_id.slice(0, 8)}…</code>}
              {p.tool_id && <Chip>{p.tool_id}</Chip>}
              <Chip tone={p.permission === "write" ? "accent" : "neutral"}>{p.permission}</Chip>
              <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
                {new Date(p.created_at).toLocaleDateString()}
              </span>
            </div>
            <Btn variant="danger" size="sm" icon="trash" onClick={() => revoke(p.id)}>
              {t.admin.permsRevoke}
            </Btn>
          </div>
        ))}
      </Glass>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Audit tab
// ──────────────────────────────────────────────────────────────────────────

function AuditTab({ headers }: { headers: Headers }) {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [filterUser, setFilterUser] = useState("");
  const [filterAction, setFilterAction] = useState("");
  const LIMIT = 50;
  const dateFmt = locale === "zh-CN" ? "zh-CN" : "en-US";

  const load = useCallback((append: boolean, off: number) => {
    const params = new URLSearchParams({ limit: String(LIMIT), offset: String(off) });
    if (filterUser) params.set("user_id", filterUser);
    if (filterAction) params.set("action", filterAction);
    authFetch(`${getApiBase()}/api/admin/audit-log?${params}`, { headers })
      .then((r) => r.json())
      .then((d: { items: AuditEntry[] }) => {
        const rows = d.items || [];
        setItems((prev) => append ? [...prev, ...rows] : rows);
        setHasMore(rows.length === LIMIT);
      })
      .catch(() => {});
  }, [headers, filterUser, filterAction]);

  useEffect(() => { setOffset(0); load(false, 0); }, [load]);

  return (
    <>
      <p style={{ fontSize: 13, color: "var(--aurora-fg3)", marginBottom: 14 }}>{t.admin.auditSubtitle}</p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <input type="text" placeholder={t.admin.auditFilterUser}
               value={filterUser}
               onChange={(e) => setFilterUser(e.target.value)}
               style={fieldInputStyle(220)} />
        <input type="text" placeholder={t.admin.auditFilterAction}
               value={filterAction}
               onChange={(e) => setFilterAction(e.target.value)}
               style={fieldInputStyle(140)} />
      </div>

      <Glass padding={6} radius={20}>
        {items.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--aurora-fg4)", fontSize: 13, padding: 24 }}>
            {t.admin.auditEmpty}
          </div>
        )}
        {items.map((row, i) => (
          <div key={row.id} style={{
            padding: "10px 14px",
            borderTop: i === 0 ? "none" : "1px solid var(--aurora-border)",
            display: "grid", gridTemplateColumns: "1fr 1fr 1.5fr 1fr 1fr",
            gap: 8, fontSize: 12, alignItems: "center",
          }}>
            <span style={{ color: "var(--aurora-fg4)" }} title={row.created_at}>
              {new Date(row.created_at).toLocaleString(dateFmt)}
            </span>
            <code style={codeStyle}>{row.user_id ? row.user_id.slice(0, 8) + "…" : "—"}</code>
            <Chip>{row.action}</Chip>
            <code style={codeStyle}>{row.document_id ? row.document_id.slice(0, 8) + "…" : "—"}</code>
            <span style={{ color: "var(--aurora-fg4)", fontFamily: "ui-monospace, monospace" }}>{row.ip_address || "—"}</span>
          </div>
        ))}
        {hasMore && items.length >= LIMIT && (
          <div style={{ textAlign: "center", padding: 12, borderTop: "1px solid var(--aurora-border)" }}>
            <Btn variant="ghost" size="sm" onClick={() => { const n = offset + LIMIT; setOffset(n); load(true, n); }}>
              {t.admin.auditLoadMore}
            </Btn>
          </div>
        )}
      </Glass>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Sync status tab
// ──────────────────────────────────────────────────────────────────────────

function SyncStatusTab({ headers, flash }: { headers: Headers; flash: Flash }) {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<SyncStatus[]>([]);
  const [vacuuming, setVacuuming] = useState(false);
  const dateFmt = locale === "zh-CN" ? "zh-CN" : "en-US";

  useEffect(() => {
    authFetch(`${getApiBase()}/api/admin/sync/status`, { headers }).then((r) => r.json()).then(setRows).catch(() => {});
  }, [headers]);

  const handleVacuum = async () => {
    if (!confirm(t.admin.memoryVacuumConfirm)) return;
    setVacuuming(true);
    try {
      const r = await authFetch(`${getApiBase()}/api/memory/vacuum`, { method: "POST", headers });
      const d = await r.json();
      flash("ok", fmt(t.admin.memoryVacuumSuccess, {
        ents: String(d.entities_deleted ?? 0),
        rels: String(d.relations_deleted ?? 0),
      }));
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "vacuum failed");
    } finally {
      setVacuuming(false);
    }
  };

  return (
    <>
      <Glass padding={16} radius={20} style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: "var(--aurora-fg1)" }}>
              {t.admin.memoryVacuum}
            </div>
            <div style={{ fontSize: 12, color: "var(--aurora-fg4)", marginTop: 4, lineHeight: 1.5 }}>
              {t.admin.memoryVacuumHint}
            </div>
          </div>
          <Btn size="sm" icon="refresh" onClick={handleVacuum} disabled={vacuuming}>
            {vacuuming ? "…" : t.admin.memoryVacuum}
          </Btn>
        </div>
      </Glass>
    <Glass padding={6} radius={20}>
      {rows.map((s, i) => (
        <div key={s.tool_id} style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 14px", gap: 10, flexWrap: "wrap",
          borderTop: i === 0 ? "none" : "1px solid var(--aurora-border)",
        }}>
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
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Small helpers
// ──────────────────────────────────────────────────────────────────────────

function Field({ label, children, grow }: { label: string; children: React.ReactNode; grow?: boolean }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: grow ? "1 1 120px" : "0 0 auto" }}>
      <span style={{ fontSize: 10, color: "var(--aurora-fg4)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function fieldInputStyle(width?: number): React.CSSProperties {
  return {
    padding: "7px 10px",
    borderRadius: 8,
    border: "1px solid var(--aurora-border)",
    background: "var(--aurora-chip)",
    color: "var(--aurora-fg1)",
    fontSize: 13,
    fontFamily: "inherit",
    width: width ? `${width}px` : "100%",
    minWidth: 0,
  };
}

const codeStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "var(--aurora-fg3)",
  background: "var(--aurora-surface-mute)",
  padding: "2px 6px",
  borderRadius: 4,
};
