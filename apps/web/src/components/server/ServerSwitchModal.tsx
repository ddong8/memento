"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { desktop } from "@/lib/desktop";
import {
  DEFAULT_LOCAL_SERVER,
  DEFAULT_OFFICIAL_SERVER,
  getServerHistory,
  removeServerFromHistory,
  clearServerHistory,
  setCustomServerUrl,
  testServerConnection,
  type ServerHistoryItem,
  getApiBase,
  getCustomServerUrl,
} from "@/lib/api-client";
import { Btn, Chip, GhostInput, Glass } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";

export interface ServerSwitchModalProps {
  open?: boolean;
  onClose?: () => void;
}

interface LatencyState {
  loading: boolean;
  ok?: boolean;
  ms?: number;
  error?: string;
}

export function ServerSwitchModal({ open: externalOpen, onClose: externalClose }: ServerSwitchModalProps) {
  const { t } = useI18n();
  const s = t.serverSwitch;
  const isDesktop = Boolean(desktop());

  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = externalOpen !== undefined ? externalOpen : internalOpen;

  const [currentServer, setCurrentServer] = useState<string>(DEFAULT_OFFICIAL_SERVER);
  const [customInput, setCustomInput] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [resetAuth, setResetAuth] = useState(true);
  const [history, setHistory] = useState<ServerHistoryItem[]>([]);
  const [latencies, setLatencies] = useState<Record<string, LatencyState>>({});
  const [switching, setSwitching] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; tone: "success" | "error" } | null>(null);

  const close = useCallback(() => {
    if (externalClose) externalClose();
    else setInternalOpen(false);
    setStatusMsg(null);
  }, [externalClose]);

  // Listen to global open event
  useEffect(() => {
    const onOpenEvent = () => setInternalOpen(true);
    window.addEventListener("memento:open-server-switch", onOpenEvent);
    return () => {
      window.removeEventListener("memento:open-server-switch", onOpenEvent);
    };
  }, []);

  // Keyboard shortcut ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, close]);

  // Load current server & history on open
  useEffect(() => {
    if (!isOpen) return;
    setStatusMsg(null);
    setHistory(getServerHistory());

    const init = async () => {
      const d = desktop();
      if (d?.server?.get) {
        try {
          const info = await d.server.get();
          if (info.current) {
            setCurrentServer(info.current.replace(/\/+$/, ""));
            return;
          }
        } catch {}
      }
      const custom = getCustomServerUrl();
      if (custom) {
        setCurrentServer(custom.replace(/\/+$/, ""));
      } else {
        setCurrentServer(getApiBase().replace(/\/+$/, ""));
      }
    };

    void init();
  }, [isOpen]);

  // Ping a specific server URL
  const ping = useCallback(async (url: string) => {
    const clean = url.trim().replace(/\/+$/, "");
    if (!clean) return;
    setLatencies((prev) => ({ ...prev, [clean]: { loading: true } }));
    try {
      const res = await testServerConnection(clean);
      setLatencies((prev) => ({
        ...prev,
        [clean]: {
          loading: false,
          ok: res.ok,
          ms: res.latencyMs,
          error: res.error,
        },
      }));
    } catch (err: unknown) {
      setLatencies((prev) => ({
        ...prev,
        [clean]: {
          loading: false,
          ok: false,
          error: err instanceof Error ? err.message : "连接失败",
        },
      }));
    }
  }, []);

  // Ping current server on mount
  useEffect(() => {
    if (isOpen && currentServer) {
      void ping(currentServer);
    }
  }, [isOpen, currentServer, ping]);

  // Switch server handler
  const handleSwitch = async (targetUrl: string, label?: string) => {
    let clean = targetUrl.trim().replace(/\/+$/, "");
    if (!clean) return;

    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      clean = `https://${clean}`;
    }

    setSwitching(true);
    setStatusMsg(null);

    try {
      const d = desktop();
      if (d?.server?.set) {
        // Electron Desktop flow
        const res = await d.server.set({ url: clean, resetAuth });
        if (!res.ok) {
          setStatusMsg({ text: res.error || s.connectFailed, tone: "error" });
          setSwitching(false);
          return;
        }
        setStatusMsg({ text: s.connectSuccess, tone: "success" });
        return;
      }

      // Web flow
      setCustomServerUrl(clean);
      if (resetAuth) {
        try {
          localStorage.removeItem("dr_token");
        } catch {}
      }

      setStatusMsg({ text: s.connectSuccess, tone: "success" });

      setTimeout(() => {
        try {
          const targetOrigin = new URL(clean).origin;
          if (typeof window !== "undefined" && window.location.origin !== targetOrigin) {
            window.location.href = clean;
            return;
          }
        } catch {}
        window.location.reload();
      }, 500);
    } catch (err: unknown) {
      setSwitching(false);
      setStatusMsg({
        text: err instanceof Error ? err.message : s.connectFailed,
        tone: "error",
      });
    }
  };

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customInput.trim()) return;
    void handleSwitch(customInput, customLabel);
  };

  const handleDeleteHistory = (url: string) => {
    removeServerFromHistory(url);
    setHistory(getServerHistory());
  };

  const handleClearHistory = () => {
    clearServerHistory();
    setHistory([]);
  };

  if (!isOpen) return null;

  const currentLatency = latencies[currentServer];

  return (
    <div
      onClick={close}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0, 0, 0, 0.65)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540, width: "100%", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <Glass padding={26} radius={22} style={{ display: "flex", flexDirection: "column", gap: 18, overflowY: "auto" }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 12,
                  background: "var(--aurora-primary-grad)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 4px 14px -2px rgba(124, 58, 237, 0.4)",
                  color: "#fff",
                  flexShrink: 0,
                }}
              >
                <Icon name="server" size={19} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.02em" }}>
                  {s.title}
                </h3>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--aurora-fg3)" }}>
                  {s.subtitle}
                </p>
              </div>
            </div>

            <button
              onClick={close}
              aria-label="Close"
              style={{
                background: "transparent",
                border: 0,
                cursor: "pointer",
                padding: 6,
                borderRadius: 8,
                color: "var(--aurora-fg4)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all .15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--aurora-fg1)";
                e.currentTarget.style.background = "var(--aurora-chip)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--aurora-fg4)";
                e.currentTarget.style.background = "transparent";
              }}
            >
              <Icon name="close" size={18} />
            </button>
          </div>

          {/* Status feedback message */}
          {statusMsg && (
            <div
              style={{
                padding: "8px 14px",
                borderRadius: 10,
                fontSize: 12.5,
                fontWeight: 500,
                background: statusMsg.tone === "success" ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.14)",
                color: statusMsg.tone === "success" ? "#10B981" : "#DC2626",
                border: `1px solid ${statusMsg.tone === "success" ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.25)"}`,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Icon name={statusMsg.tone === "success" ? "check" : "close"} size={14} />
              <span>{statusMsg.text}</span>
            </div>
          )}

          {/* Current Active Server Card */}
          <div
            style={{
              padding: "14px 16px",
              borderRadius: 14,
              background: "var(--aurora-card-bg)",
              border: "1px solid var(--aurora-border)",
              boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 9999,
                    background: currentLatency?.ok ? "#10B981" : currentLatency?.error ? "#DC2626" : "#D97706",
                    boxShadow: currentLatency?.ok ? "0 0 8px #10B981" : "none",
                  }}
                />
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg3)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                  {s.currentServer}
                </span>
              </div>
              <Chip tone="accent">
                {isDesktop ? "客户端模式 (Electron)" : "网页模式 (Web)"}
              </Chip>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 4 }}>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--aurora-fg1)",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {currentServer}
              </span>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {currentLatency && (
                  <span
                    style={{
                      fontSize: 11.5,
                      fontFamily: "monospace",
                      color: currentLatency.ok ? "#10B981" : "#DC2626",
                    }}
                  >
                    {currentLatency.loading
                      ? s.pinging
                      : currentLatency.ok
                      ? `${currentLatency.ms}ms`
                      : currentLatency.error || s.connectFailed}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => ping(currentServer)}
                  disabled={currentLatency?.loading}
                  style={{
                    background: "var(--aurora-chip)",
                    border: "1px solid var(--aurora-border)",
                    borderRadius: 6,
                    padding: "3px 8px",
                    fontSize: 11,
                    color: "var(--aurora-fg2)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <Icon name="refresh" size={11} />
                  <span>{s.ping}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Preset Servers */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg3)", marginBottom: 8, letterSpacing: "0.02em" }}>
              快捷预设
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {/* Official Cloud */}
              <div
                onClick={() => handleSwitch(DEFAULT_OFFICIAL_SERVER)}
                style={{
                  padding: "12px 14px",
                  borderRadius: 14,
                  background: currentServer === DEFAULT_OFFICIAL_SERVER ? "var(--aurora-accent-soft)" : "var(--aurora-card-bg)",
                  border: `1px solid ${currentServer === DEFAULT_OFFICIAL_SERVER ? "var(--aurora-accent)" : "var(--aurora-border)"}`,
                  cursor: switching ? "not-allowed" : "pointer",
                  transition: "all .15s",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                      {s.officialCloud}
                    </span>
                    {currentServer === DEFAULT_OFFICIAL_SERVER && (
                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--aurora-accent)", color: "#fff", fontWeight: 600 }}>
                        {s.currentActive}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 3, fontFamily: "monospace" }}>
                    {DEFAULT_OFFICIAL_SERVER}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--aurora-fg3)", marginTop: 8 }}>
                  {s.officialCloudDesc}
                </div>
              </div>

              {/* Local Dev */}
              <div
                onClick={() => handleSwitch(DEFAULT_LOCAL_SERVER)}
                style={{
                  padding: "12px 14px",
                  borderRadius: 14,
                  background: currentServer === DEFAULT_LOCAL_SERVER ? "var(--aurora-accent-soft)" : "var(--aurora-card-bg)",
                  border: `1px solid ${currentServer === DEFAULT_LOCAL_SERVER ? "var(--aurora-accent)" : "var(--aurora-border)"}`,
                  cursor: switching ? "not-allowed" : "pointer",
                  transition: "all .15s",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                      {s.localDev}
                    </span>
                    {currentServer === DEFAULT_LOCAL_SERVER && (
                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--aurora-accent)", color: "#fff", fontWeight: 600 }}>
                        {s.currentActive}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 3, fontFamily: "monospace" }}>
                    {DEFAULT_LOCAL_SERVER}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--aurora-fg3)", marginTop: 8 }}>
                  {s.localDevDesc}
                </div>
              </div>
            </div>
          </div>

          {/* Custom Server Input */}
          <form onSubmit={handleCustomSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg3)", letterSpacing: "0.02em" }}>
              {s.customServer}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <GhostInput
                  icon="server"
                  type="text"
                  placeholder={s.serverUrlPlaceholder}
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  style={{ fontSize: 13, width: "100%" }}
                />
              </div>
              <Btn
                type="button"
                variant="glass"
                size="md"
                disabled={!customInput.trim() || latencies[customInput.trim()]?.loading}
                onClick={() => ping(customInput)}
                icon="refresh"
              >
                {latencies[customInput.trim()]?.loading ? s.pinging : s.ping}
              </Btn>
              <Btn
                type="submit"
                variant="primary"
                size="md"
                disabled={!customInput.trim() || switching}
                iconRight="arrow_right"
              >
                {switching ? s.switching : s.switchToThis}
              </Btn>
            </div>

            {/* Custom input test result */}
            {customInput.trim() && latencies[customInput.trim()] && (
              <div style={{ fontSize: 11.5, padding: "4px 8px", borderRadius: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 9999,
                    background: latencies[customInput.trim()].ok ? "#10B981" : "#DC2626",
                  }}
                />
                <span style={{ color: latencies[customInput.trim()].ok ? "#10B981" : "#DC2626" }}>
                  {latencies[customInput.trim()].ok
                    ? `连通正常 · 延迟 ${latencies[customInput.trim()].ms}ms`
                    : `连通异常: ${latencies[customInput.trim()].error || s.connectFailed}`}
                </span>
              </div>
            )}
          </form>

          {/* History List */}
          {history.length > 0 && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg3)", letterSpacing: "0.02em" }}>
                  {s.history}
                </span>
                <button
                  type="button"
                  onClick={handleClearHistory}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--aurora-fg4)",
                    fontSize: 11,
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  {s.clearHistory}
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 150, overflowY: "auto" }}>
                {history.map((item) => (
                  <div
                    key={item.url}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 12px",
                      borderRadius: 10,
                      background: "var(--aurora-card-bg)",
                      border: "1px solid var(--aurora-border)",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1, marginRight: 10 }}>
                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 500,
                          color: "var(--aurora-fg1)",
                          fontFamily: "monospace",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.url}
                      </div>
                      {item.label && (
                        <div style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>{item.label}</div>
                      )}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Btn
                        variant="glass"
                        size="sm"
                        disabled={switching || currentServer === item.url}
                        onClick={() => handleSwitch(item.url, item.label)}
                      >
                        {currentServer === item.url ? s.currentActive : s.switchToThis}
                      </Btn>
                      <button
                        type="button"
                        onClick={() => handleDeleteHistory(item.url)}
                        title={s.remove}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--aurora-fg4)",
                          cursor: "pointer",
                          padding: 4,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: 6,
                        }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reset Auth Option */}
          <div style={{ paddingTop: 8, borderTop: "1px solid var(--aurora-border)" }}>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--aurora-fg3)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={resetAuth}
                onChange={(e) => setResetAuth(e.target.checked)}
                style={{ cursor: "pointer", accentColor: "var(--aurora-accent)" }}
              />
              <span>{s.clearAuth}</span>
            </label>
          </div>
        </Glass>
      </div>
    </div>
  );
}

export default ServerSwitchModal;
