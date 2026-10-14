"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { authFetch, getApiBase } from "@/lib/api-client";
import { Btn, Chip, Glass } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";

interface CreatedShare {
  token: string;
  expires_at: string | null;
  created_at: string;
  target_user_id: string | null;
  target_user_label: string | null;
}

interface ViewRow {
  id: number;
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  user_agent: string;
  viewed_at: string;
}

interface Recipient {
  id: string;
  email: string;
  name: string | null;
  role: string;
  label: string;
}

export interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  kind: "timeline" | "daily" | "memory" | "conversation";
  targetId: string;   // project UUID for timeline; YYYY-MM-DD for daily; "all" for memory; conv UUID(s) for conversation
  title?: string;     // human-readable label shown in modal header
}

type Audience = "public" | "user";

export function ShareModal({ open, onClose, kind, targetId, title }: ShareModalProps) {
  const { t } = useI18n();
  const [existing, setExisting] = useState<CreatedShare | null>(null);
  const [expiresDays, setExpiresDays] = useState<number | "">(7);
  const [audience, setAudience] = useState<Audience>("public");
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [recipientsTried, setRecipientsTried] = useState(false);
  const [recipientsAvailable, setRecipientsAvailable] = useState(true);
  const [targetUserId, setTargetUserId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [viewCount, setViewCount] = useState(0);
  const [views, setViews] = useState<ViewRow[]>([]);
  const [showViews, setShowViews] = useState(false);
  const [notice, setNotice] = useState("");

  // Look for an existing share on this target when modal opens.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    authFetch(`${getApiBase()}/api/share`)
      .then((r) => r.json())
      .then((rows: Array<CreatedShare & { kind: string; target_id: string; revoked_at: string | null; view_count: number }>) => {
        if (!alive) return;
        const hit = rows.find((r) => r.kind === kind && r.target_id === targetId && !r.revoked_at);
        if (hit) {
          setExisting({
            token: hit.token,
            expires_at: hit.expires_at,
            created_at: hit.created_at,
            target_user_id: hit.target_user_id,
            target_user_label: hit.target_user_label,
          });
          setViewCount(hit.view_count || 0);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [open, kind, targetId]);

  // Lazy-load recipients the first time the user picks "user" audience.
  // /api/share/recipients is admin/owner-only — for other roles we silently
  // hide the user-mode option.
  useEffect(() => {
    if (!open || audience !== "user" || recipientsTried) return;
    let alive = true;
    setRecipientsTried(true);
    authFetch(`${getApiBase()}/api/share/recipients`)
      .then(async (r) => {
        if (!alive) return;
        if (!r.ok) {
          setRecipientsAvailable(false);
          setAudience("public");
          return;
        }
        const data: Recipient[] = await r.json();
        setRecipients(data);
        if (data.length > 0 && !targetUserId) setTargetUserId(data[0].id);
      })
      .catch(() => { setRecipientsAvailable(false); setAudience("public"); });
    return () => { alive = false; };
  }, [open, audience, recipientsTried, targetUserId]);

  const publicUrl = existing ? `${typeof window !== "undefined" ? window.location.origin : ""}/s/${existing.token}` : "";
  const isDirected = !!existing?.target_user_id;

  const handleCreate = async () => {
    if (audience === "user" && !targetUserId) {
      setNotice(t.share.pickRecipient);
      return;
    }
    setLoading(true);
    setNotice("");
    try {
      const r = await authFetch(`${getApiBase()}/api/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind, target_id: targetId, title,
          expires_in_days: expiresDays === "" ? null : Number(expiresDays),
          target_user_id: audience === "user" ? targetUserId : null,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setExisting({
        token: data.token,
        expires_at: data.expires_at,
        created_at: data.created_at,
        target_user_id: data.target_user_id,
        target_user_label: data.target_user_label,
      });
      setViewCount(0);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "create failed");
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (!existing) return;
    if (!confirm(t.share.revokeConfirm)) return;
    setLoading(true);
    try {
      await authFetch(`${getApiBase()}/api/share/${existing.token}`, { method: "DELETE" });
      setExisting(null);
      setViewCount(0);
      setViews([]);
      setShowViews(false);
    } finally {
      setLoading(false);
    }
  };

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  if (typeof document !== "undefined") {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.left = "-9999px";
      el.style.top = "-9999px";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      if (ok) return true;
    } catch {}
  }
  return false;
}

  const handleCopy = async () => {
    if (!publicUrl) return;
    const ok = await copyTextToClipboard(publicUrl);
    if (typeof window !== "undefined" && (window as any).__memento_haptic) {
      try { (window as any).__memento_haptic("selection"); } catch {}
    }
    if (ok) {
      setNotice(t.share.copied);
      setTimeout(() => setNotice(""), 1500);
    } else {
      setNotice(t.share.copyFail);
    }
  };

  const handleSystemShare = async () => {
    if (!publicUrl) return;

    // Trigger haptic feedback
    if (typeof window !== "undefined" && (window as any).__memento_haptic) {
      try { (window as any).__memento_haptic("medium"); } catch {}
    }

    // Always copy URL to clipboard as guaranteed fallback
    await copyTextToClipboard(publicUrl);

    // 1. Native app bridge
    if (typeof window !== "undefined" && (window as any).ReactNativeWebView?.postMessage) {
      try {
        (window as any).ReactNativeWebView.postMessage(JSON.stringify({
          type: "share",
          url: publicUrl,
          title: title || "Memento",
        }));
      } catch {}
      setNotice((t.share as any).systemShareTriggered || "已发起分享（链接已复制到剪贴板）");
      setTimeout(() => setNotice(""), 3000);
      return;
    }

    // 2. Web Share API (Safari iOS / macOS / Chrome)
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: title || "Memento",
          url: publicUrl,
        });
        return;
      } catch (err: any) {
        if (err && err.name === "AbortError") {
          return;
        }
      }
    }

    setNotice(t.share.copied);
    setTimeout(() => setNotice(""), 1500);
  };

  const canSystemShare =
    typeof window !== "undefined" &&
    (!!(window as any).ReactNativeWebView?.postMessage || (typeof navigator !== "undefined" && typeof navigator.share === "function"));

  const handleLoadViews = async () => {
    if (!existing) return;
    setShowViews(true);
    try {
      const r = await authFetch(`${getApiBase()}/api/share/${existing.token}/views`);
      const data = await r.json();
      setViews(data);
    } catch {
      setNotice(t.share.viewsLoadFail);
    }
  };

  if (!open) return null;

  const targetDescription =
    kind === "timeline" ? t.share.targetTimeline :
    kind === "daily" ? t.share.targetDaily :
    kind === "conversation" ? ((t.share as any).targetConversation || "对话分享") :
    t.share.targetMemory;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 80,
        background: "rgba(10,8,20,0.5)",
        backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, width: "100%" }}>
        <Glass padding={24} radius={20}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--aurora-fg1)" }}>
              {t.share.title}
            </h3>
            <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: 0, cursor: "pointer" }}>
              <Icon name="close" size={18} style={{ color: "var(--aurora-fg3)" }} />
            </button>
          </div>

          <div style={{ fontSize: 12, color: "var(--aurora-fg3)", marginBottom: 18 }}>
            {targetDescription}
            {title ? " · " : ""}
            <span style={{ color: "var(--aurora-fg1)", fontWeight: 500 }}>{title || targetId}</span>
          </div>

          {!existing ? (
            <div>
              {/* Audience picker — only shown if recipients endpoint is reachable */}
              {recipientsAvailable && (
                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  <AudienceTab active={audience === "public"} onClick={() => setAudience("public")}>
                    {t.share.audiencePublic}
                  </AudienceTab>
                  <AudienceTab active={audience === "user"} onClick={() => setAudience("user")}>
                    {t.share.audienceUser}
                  </AudienceTab>
                </div>
              )}

              {audience === "user" && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 12, color: "var(--aurora-fg3)", display: "block", marginBottom: 6 }}>
                    {t.share.recipient}
                  </label>
                  <select
                    value={targetUserId}
                    onChange={(e) => setTargetUserId(e.target.value)}
                    style={{
                      width: "100%", padding: "8px 10px", fontSize: 13,
                      background: "var(--aurora-surface)",
                      border: "1px solid var(--aurora-border)",
                      borderRadius: 8, color: "var(--aurora-fg1)",
                    }}
                  >
                    {recipients.length === 0 && <option value="">{t.share.noRecipients}</option>}
                    {recipients.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.label} ({u.email}) · {u.role}
                      </option>
                    ))}
                  </select>
                  <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 6 }}>
                    {t.share.recipientHint}
                  </div>
                </div>
              )}

              <label style={{ fontSize: 12, color: "var(--aurora-fg3)", display: "block", marginBottom: 6 }}>
                {t.share.expiresLabel}
              </label>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
                <input
                  type="number"
                  min={0}
                  value={expiresDays}
                  onChange={(e) => setExpiresDays(e.target.value === "" ? "" : Number(e.target.value))}
                  placeholder="7"
                  style={{
                    width: 100, padding: "6px 10px", fontSize: 13,
                    background: "var(--aurora-surface)",
                    border: "1px solid var(--aurora-border)",
                    borderRadius: 8, color: "var(--aurora-fg1)",
                  }}
                />
                <span style={{ fontSize: 12, color: "var(--aurora-fg3)" }}>{t.share.days}</span>
                <span style={{ fontSize: 11, color: "var(--aurora-fg4)", marginLeft: "auto" }}>
                  {t.share.expiresHint}
                </span>
              </div>
              <Btn size="sm" icon="link" onClick={handleCreate} disabled={loading}>
                {loading ? "…" : t.share.create}
              </Btn>
            </div>
          ) : (
            <div>
              {isDirected && (
                <div style={{
                  marginBottom: 10, padding: "8px 10px", borderRadius: 8,
                  fontSize: 12, color: "var(--aurora-fg2)",
                  background: "rgba(59,130,246,0.10)",
                  border: "1px solid rgba(59,130,246,0.25)",
                }}>
                  {t.share.directedTo} <strong>{existing.target_user_label}</strong> · {t.share.directedHint}
                </div>
              )}
              <div style={{
                display: "flex", gap: 6, alignItems: "center",
                padding: "8px 10px", border: "1px solid var(--aurora-border)",
                background: "var(--aurora-surface)", borderRadius: 10,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12, color: "var(--aurora-fg2)",
                wordBreak: "break-all", marginBottom: 10,
              }}>
                {publicUrl}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {canSystemShare && (
                  <Btn variant="primary" size="sm" icon="share" onClick={handleSystemShare}>
                    {(t.share as any).systemShare || "系统分享"}
                  </Btn>
                )}
                <Btn size="sm" icon="copy" onClick={handleCopy}>{t.share.copy}</Btn>
                <a href={publicUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                  <Btn variant="glass" size="sm" icon="external_link">{t.share.openInTab}</Btn>
                </a>
                <Chip tone="accent">
                  {t.share.viewCount}: {viewCount}
                </Chip>
                {existing.expires_at && (
                  <Chip>
                    {t.share.expiresAt}: {new Date(existing.expires_at).toLocaleString()}
                  </Chip>
                )}
                <div style={{ flex: 1 }} />
                <Btn variant="ghost" size="sm" icon="trash" onClick={handleRevoke} disabled={loading}>
                  {t.share.revoke}
                </Btn>
              </div>

              <div style={{ marginTop: 16 }}>
                {!showViews ? (
                  <Btn variant="glass" size="sm" icon="eye" onClick={handleLoadViews}>
                    {t.share.loadViews}
                  </Btn>
                ) : views.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--aurora-fg4)", padding: "10px 0" }}>
                    {t.share.noViews}
                  </div>
                ) : (
                  <div style={{
                    maxHeight: 260, overflow: "auto",
                    border: "1px solid var(--aurora-border)", borderRadius: 10,
                    marginTop: 6,
                  }}>
                    <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ background: "var(--aurora-chip)", color: "var(--aurora-fg3)", textAlign: "left" }}>
                          <th style={{ padding: "6px 10px" }}>{t.share.when}</th>
                          <th style={{ padding: "6px 10px" }}>{t.share.from}</th>
                          <th style={{ padding: "6px 10px" }}>{t.share.ipAddr}</th>
                          <th style={{ padding: "6px 10px" }}>UA</th>
                        </tr>
                      </thead>
                      <tbody>
                        {views.map((v) => (
                          <tr key={v.id} style={{ borderTop: "1px solid var(--aurora-border)" }}>
                            <td style={{ padding: "6px 10px", whiteSpace: "nowrap", color: "var(--aurora-fg2)" }}>
                              {new Date(v.viewed_at).toLocaleString()}
                            </td>
                            <td style={{ padding: "6px 10px", color: "var(--aurora-fg2)" }}>
                              {[v.country, v.region, v.city].filter(Boolean).join(" / ") || "—"}
                            </td>
                            <td style={{ padding: "6px 10px", fontFamily: "monospace", color: "var(--aurora-fg3)" }}>
                              {v.ip || "—"}
                            </td>
                            <td style={{ padding: "6px 10px", color: "var(--aurora-fg4)", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={v.user_agent}>
                              {v.user_agent}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {notice && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--aurora-accent)" }}>
              {notice}
            </div>
          )}
        </Glass>
      </div>
    </div>
  );
}

function AudienceTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "8px 12px",
        fontSize: 12,
        fontWeight: 500,
        background: active ? "var(--aurora-chip)" : "transparent",
        color: active ? "var(--aurora-fg1)" : "var(--aurora-fg3)",
        border: "1px solid",
        borderColor: active ? "var(--aurora-accent)" : "var(--aurora-border)",
        borderRadius: 8,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
