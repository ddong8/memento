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

export interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  kind: "timeline" | "daily";
  targetId: string;   // project UUID for timeline; YYYY-MM-DD for daily
  title?: string;     // human-readable label shown in modal header
}

export function ShareModal({ open, onClose, kind, targetId, title }: ShareModalProps) {
  const { t } = useI18n();
  const [existing, setExisting] = useState<CreatedShare | null>(null);
  const [expiresDays, setExpiresDays] = useState<number | "">(7);
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
          setExisting({ token: hit.token, expires_at: hit.expires_at, created_at: hit.created_at });
          setViewCount(hit.view_count || 0);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [open, kind, targetId]);

  const publicUrl = existing ? `${typeof window !== "undefined" ? window.location.origin : ""}/s/${existing.token}` : "";

  const handleCreate = async () => {
    setLoading(true);
    setNotice("");
    try {
      const r = await authFetch(`${getApiBase()}/api/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind, target_id: targetId, title,
          expires_in_days: expiresDays === "" ? null : Number(expiresDays),
        }),
      });
      const data = await r.json();
      setExisting({ token: data.token, expires_at: data.expires_at, created_at: data.created_at });
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

  const handleCopy = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setNotice(t.share.copied);
      setTimeout(() => setNotice(""), 1500);
    } catch {
      setNotice(t.share.copyFail);
    }
  };

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
            {kind === "timeline" ? t.share.targetTimeline : t.share.targetDaily}
            {title ? " · " : ""}
            <span style={{ color: "var(--aurora-fg1)", fontWeight: 500 }}>{title || targetId}</span>
          </div>

          {!existing ? (
            <div>
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
