"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useNow } from "@/lib/use-now";
import { getApiBase, authFetch } from "@/lib/api-client";
import { ToolGlyph, PlatformGlyph, Icon } from "@/components/aurora/Icon";
import { Btn, Glass, TopBar } from "@/components/aurora/primitives";
import { directConnect } from "@/lib/direct-connect";

export interface Device {
  id: string;
  name: string;
  device_id: string;
  last_heartbeat: string | null;
  online?: boolean;
  created_at: string;
  document_count: number;
  tools: string[];
  is_archived?: boolean;
  archived_at?: string | null;
  direct_endpoints?: string[];
}

function useTimeAgo(t: ReturnType<typeof useI18n>["t"]) {
  return (iso: string | null) => {
    if (!iso) return t.never;
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return t.justNow;
    if (mins < 60) return `${mins}${t.mAgo}`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}${t.hAgo}`;
    return `${Math.floor(hrs / 24)}${t.dAgo}`;
  };
}

export function DevicesView({ hideTopBar = false }: { hideTopBar?: boolean }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [discoveries, setDiscoveries] = useState<Record<string, Record<string, { root?: string }>>>({});
  const { t, locale } = useI18n();
  const timeAgo = useTimeAgo(t);
  const now = useNow();

  const [showArchived, setShowArchived] = useState(false);
  const [modalTarget, setModalTarget] = useState<Device | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);

  const fetchDevices = (includeArch: boolean = showArchived) => {
    authFetch(`${getApiBase()}/api/devices?include_archived=${includeArch}`)
      .then((r) => r.json())
      .then((devs: Device[]) => {
        if (!Array.isArray(devs)) return;
        setDevices(devs);
        // Automatically feed discovered endpoints to direct-connect engine
        const allEndpoints: string[] = [];
        for (const d of devs) {
          if (Array.isArray(d.direct_endpoints)) {
            for (const ep of d.direct_endpoints) {
              if (ep && !allEndpoints.includes(ep)) allEndpoints.push(ep);
            }
          }
        }
        if (allEndpoints.length > 0) {
          directConnect.registerDeviceEndpoints(allEndpoints);
        }
        for (const d of devs) {
          if (!discoveries[d.id]) {
            authFetch(`${getApiBase()}/api/devices/${d.id}/discovery`)
              .then((r) => r.json())
              .then((disc) => setDiscoveries((prev) => ({ ...prev, [d.id]: disc.tools || {} })))
              .catch(() => {});
          }
        }
      })
      .catch(console.error);
  };

  useEffect(() => {
    fetchDevices(showArchived);
  }, [showArchived]);

  const handleUnbindKeepData = async (d: Device) => {
    setActionBusy(true);
    try {
      const res = await authFetch(`${getApiBase()}/api/devices/${d.id}?keep_data=true`, { method: "DELETE" });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `HTTP ${res.status}`);
      }
      if (showArchived) {
        setDevices((prev) => prev.map((x) => (x.id === d.id ? { ...x, is_archived: true, online: false } : x)));
      } else {
        setDevices((prev) => prev.filter((x) => x.id !== d.id));
      }
      setModalTarget(null);
    } catch (e: unknown) {
      alert(t.devices.deleteFailed + ": " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setActionBusy(false);
    }
  };

  const handlePurgeAllData = async (d: Device) => {
    setActionBusy(true);
    try {
      const res = await authFetch(`${getApiBase()}/api/devices/${d.id}?keep_data=false`, { method: "DELETE" });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `HTTP ${res.status}`);
      }
      setDevices((prev) => prev.filter((x) => x.id !== d.id));
      setModalTarget(null);
    } catch (e: unknown) {
      alert(t.devices.deleteFailed + ": " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setActionBusy(false);
    }
  };

  const handleRestoreDevice = async (d: Device) => {
    setBusyDeviceId(d.id);
    try {
      const res = await authFetch(`${getApiBase()}/api/devices/${d.id}/unarchive`, { method: "POST" });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `HTTP ${res.status}`);
      }
      setDevices((prev) => prev.map((x) => (x.id === d.id ? { ...x, is_archived: false } : x)));
    } catch (e: unknown) {
      alert(t.devices.deleteFailed + ": " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyDeviceId(null);
    }
  };

  return (
    <div className="w-full">
      {!hideTopBar && <TopBar title={t.devices.title} subtitle={t.devices.subtitle} />}

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <Btn
          size="sm"
          variant={showArchived ? "glass" : "ghost"}
          icon="box"
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? t.devices.hideArchived : t.devices.showArchived}
        </Btn>
      </div>

      {devices.length === 0 ? (
        <Glass padding={40} radius={22} style={{ textAlign: "center" }}>
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
            <Icon name="devices" size={26} style={{ color: "#fff" }} strokeWidth={2} />
          </div>
          <p style={{ fontSize: 15, fontWeight: 500, color: "var(--aurora-fg1)", marginBottom: 4 }}>
            {t.devices.noDevices}
          </p>
          <p style={{ fontSize: 13, color: "var(--aurora-fg4)", marginBottom: 14 }}>{t.devices.installHint}</p>
          <pre
            style={{
              display: "block",
              background: "#111827",
              color: "#34D399",
              borderRadius: 12,
              padding: 14,
              fontSize: 13,
              maxWidth: 540,
              margin: "0 auto",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              textAlign: "left",
              whiteSpace: "pre",
              overflow: "auto",
            }}
          >
{`pip install memento-brain-collector    # ${t.devices.snippetCollectorOnly}
# ${t.devices.snippetMetaOption}
pip install memento-brain

memento-collector setup`}
          </pre>
        </Glass>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {devices.map((d) => {
            const isArchived = Boolean(d.is_archived);
            const isOnline =
              !isArchived && (d.online ?? (!!d.last_heartbeat && now - new Date(d.last_heartbeat).getTime() < 180000));
            const toolsShown = d.tools.filter((tool) => tool !== "system");
            const isBusy = busyDeviceId === d.id;

            return (
              <Glass
                key={d.id}
                padding={22}
                radius={20}
                style={{
                  opacity: isArchived ? 0.75 : 1,
                  border: isArchived ? "1px dashed var(--aurora-border)" : undefined,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                  <PlatformGlyph name={d.name} size={48} />
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.02em" }}>
                        {d.name}
                      </h3>

                      {isArchived ? (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            fontSize: 11,
                            color: "var(--aurora-fg3)",
                            fontWeight: 500,
                            padding: "2px 8px",
                            borderRadius: 9999,
                            background: "rgba(148, 163, 184, 0.15)",
                            border: "1px solid rgba(148, 163, 184, 0.2)",
                          }}
                        >
                          {t.devices.archivedBadge}
                        </span>
                      ) : (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            fontSize: 11,
                            color: isOnline ? "#10B981" : "var(--aurora-fg4)",
                            fontWeight: 500,
                            padding: "2px 9px",
                            borderRadius: 9999,
                            background: isOnline ? "rgba(16,185,129,0.12)" : "var(--aurora-chip)",
                          }}
                        >
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 9999,
                              background: isOnline ? "#10B981" : "var(--aurora-fg4)",
                              boxShadow: isOnline ? "0 0 8px #10B981" : "none",
                            }}
                          />
                          {isOnline ? t.online : timeAgo(d.last_heartbeat)}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: "var(--aurora-fg3)", flexWrap: "wrap" }}>
                      <span>
                        <b style={{ color: "var(--aurora-fg1)" }}>{d.document_count}</b> {t.files}
                      </span>
                      <span style={{ color: "var(--aurora-fg5)" }}>·</span>
                      <span style={{ fontFamily: "ui-monospace,monospace", color: "var(--aurora-fg4)" }}>
                        {d.device_id.slice(0, 8)}
                      </span>
                      <span style={{ color: "var(--aurora-fg5)" }}>·</span>
                      <span>
                        {t.devices.registered}: {new Date(d.created_at).toLocaleDateString(locale)}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: "flex" }}>
                    {toolsShown.map((tid, j) => (
                      <div key={tid} style={{ marginLeft: j === 0 ? 0 : -10 }}>
                        <ToolGlyph id={tid} size={30} />
                      </div>
                    ))}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {isArchived && (
                      <Btn
                        size="sm"
                        variant="glass"
                        icon="refresh"
                        onClick={() => handleRestoreDevice(d)}
                        disabled={isBusy}
                      >
                        {isBusy ? "…" : t.devices.restoreBtn}
                      </Btn>
                    )}
                    <Btn
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      onClick={() => setModalTarget(d)}
                      disabled={isBusy}
                      title={t.devices.deleteHint}
                    >
                      {isBusy ? "…" : t.devices.delete}
                    </Btn>
                  </div>
                </div>

                {discoveries[d.id] && Object.keys(discoveries[d.id]).length > 0 && (
                  <div
                    style={{
                      borderTop: "1px solid var(--aurora-border)",
                      marginTop: 14,
                      paddingTop: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 5,
                    }}
                  >
                    {Object.entries(discoveries[d.id]).map(([tool, info]) => (
                      <div key={tool} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11 }}>
                        <span
                          style={{
                            fontWeight: 500,
                            color: "var(--aurora-fg2)",
                            minWidth: 100,
                            textTransform: "capitalize",
                          }}
                        >
                          {tool.replace("_", " ")}
                        </span>
                        <code
                          style={{
                            color: "var(--aurora-fg4)",
                            fontFamily: "ui-monospace,monospace",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {info.root}
                        </code>
                      </div>
                    ))}
                  </div>
                )}
              </Glass>
            );
          })}
        </div>
      )}

      {/* Unbind / Delete confirmation modal */}
      {modalTarget && (
        <div
          onClick={() => !actionBusy && setModalTarget(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 90,
            background: "rgba(10,8,20,0.65)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540, width: "100%" }}>
            <Glass padding={26} radius={22}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                  {t.devices.deleteModalTitle}
                </h3>
                <button
                  onClick={() => !actionBusy && setModalTarget(null)}
                  disabled={actionBusy}
                  aria-label="Close"
                  style={{ background: "transparent", border: 0, cursor: "pointer", padding: 4 }}
                >
                  <Icon name="close" size={18} style={{ color: "var(--aurora-fg3)" }} />
                </button>
              </div>

              <p style={{ fontSize: 13, color: "var(--aurora-fg3)", lineHeight: 1.6, marginBottom: 18 }}>
                {t.devices.deleteModalDesc
                  .replace("{name}", modalTarget.name)
                  .replace("{count}", String(modalTarget.document_count))}
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
                {/* Option 1: Unbind & keep data (Recommended) */}
                <div
                  style={{
                    padding: 16,
                    borderRadius: 14,
                    background: "rgba(124, 58, 237, 0.08)",
                    border: "1px solid rgba(124, 58, 237, 0.28)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 14, color: "var(--aurora-brand)" }}>
                      <Icon name="sparkles" size={16} />
                      <span>{t.devices.unbindKeepData}</span>
                    </div>
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: "var(--aurora-fg3)", lineHeight: 1.5 }}>
                    {t.devices.unbindKeepDataDesc}
                  </p>
                  <div style={{ alignSelf: "flex-end", marginTop: 4 }}>
                    <Btn
                      size="sm"
                      variant="primary"
                      onClick={() => handleUnbindKeepData(modalTarget)}
                      disabled={actionBusy}
                    >
                      {actionBusy ? "…" : t.devices.unbindKeepDataBtn}
                    </Btn>
                  </div>
                </div>

                {/* Option 2: Completely purge device & data */}
                <div
                  style={{
                    padding: 16,
                    borderRadius: 14,
                    background: "rgba(239, 68, 68, 0.05)",
                    border: "1px solid rgba(239, 68, 68, 0.2)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 14, color: "#EF4444" }}>
                    <Icon name="trash" size={16} />
                    <span>{t.devices.purgeAllData}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: "var(--aurora-fg4)", lineHeight: 1.5 }}>
                    {t.devices.purgeAllDataDesc}
                  </p>
                  <div style={{ alignSelf: "flex-end", marginTop: 4 }}>
                    <Btn
                      size="sm"
                      variant="ghost"
                      style={{ color: "#EF4444", borderColor: "rgba(239, 68, 68, 0.3)" }}
                      onClick={() => handlePurgeAllData(modalTarget)}
                      disabled={actionBusy}
                    >
                      {actionBusy ? "…" : t.devices.purgeAllDataBtn}
                    </Btn>
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Btn
                  size="sm"
                  variant="ghost"
                  onClick={() => !actionBusy && setModalTarget(null)}
                  disabled={actionBusy}
                >
                  {t.devices.cancel}
                </Btn>
              </div>
            </Glass>
          </div>
        </div>
      )}
    </div>
  );
}
