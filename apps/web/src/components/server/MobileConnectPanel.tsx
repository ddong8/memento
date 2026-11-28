"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/aurora/Icon";
import { desktop, type MobileConnectStatus } from "@/lib/desktop";
import { encodeQrSvg } from "@/lib/qr-svg";

export interface MobileConnectPanelProps {
  onClose?: () => void;
}

export function MobileConnectPanel({ onClose }: MobileConnectPanelProps) {
  const bridge = desktop()?.mobileConnect;
  const [status, setStatus] = useState<MobileConnectStatus | null>(null);
  const [pairUrl, setPairUrl] = useState<string>("");
  const [countdown, setCountdown] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);

  const generatePair = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    setError("");
    try {
      const res = await bridge.createPair();
      if (res.status) setStatus(res.status);
      if (!res.ok || !res.pairUrl) {
        setPairUrl("");
        setCountdown(0);
        setError(res.error || "生成配对二维码失败");
        return;
      }
      setPairUrl(res.pairUrl);
      setCountdown(res.expiresIn ?? 90);
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成配对二维码失败");
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void generatePair();
  }, [generatePair]);

  // Countdown timer for the 90s one-time pairing code
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(t);
  }, [countdown]);

  // Poll live status while relay is connecting so user sees it flip to "已连接" automatically
  useEffect(() => {
    if (!bridge || !status || status.relayState !== "connecting") return;
    const t = setInterval(() => {
      void bridge.status().then((st) => setStatus(st)).catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [bridge, status]);

  const qrSvg = useMemo(() => {
    if (!pairUrl) return "";
    try {
      return encodeQrSvg(pairUrl, { ecc: "L", quietZone: 3, fg: "#14121E", bg: "#FFFFFF" });
    } catch {
      return "";
    }
  }, [pairUrl]);

  if (!bridge) return null;

  const toggleSetting = async (patch: { enabled?: boolean; lanEnabled?: boolean; relayEnabled?: boolean }) => {
    setBusyAction("toggle");
    setError("");
    try {
      const next = await bridge.update(patch);
      setStatus(next);
      if (next.enabled) {
        await generatePair();
      } else {
        setPairUrl("");
        setCountdown(0);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新连接配置失败");
    } finally {
      setBusyAction(null);
    }
  };

  const handleEnableTailscale = async () => {
    setBusyAction("tailscale");
    setError("");
    try {
      const res = await bridge.enableTailscale();
      setStatus(res.status);
      if (!res.ok) {
        setError(res.error || "启用 Tailscale Serve 失败");
      } else {
        await generatePair();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "启用 Tailscale Serve 失败");
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopy = async () => {
    if (!pairUrl) return;
    try {
      await navigator.clipboard.writeText(pairUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("复制失败，请手动重试");
    }
  };

  const relayStatusText =
    status?.relayState === "connected"
      ? "已就绪"
      : status?.relayState === "connecting"
        ? "正在建立隧道…"
        : status?.relayState === "error"
          ? status.relayError || "重连中"
          : "已关闭";

  const relayDotColor =
    status?.relayState === "connected" ? "#10B981" : status?.relayState === "connecting" ? "#D97706" : status?.relayState === "error" ? "#DC2626" : "var(--aurora-fg4)";

  return (
    <div
      data-testid="mobile-connect-panel"
      style={{
        padding: 14,
        borderRadius: 12,
        background: "var(--aurora-surface-solid, var(--aurora-card-bg))",
        border: "1px solid var(--aurora-border)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--aurora-fg1)" }}>
            连接手机 App（单机免建服）
          </div>
          <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 2, lineHeight: 1.5 }}>
            用 iPhone / Android 系统相机扫码即可直连；同 Wi-Fi 自动走局域网，出门自动切换无状态盲隧道。
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="收起手机连接面板"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--aurora-fg4)",
              padding: 4,
              borderRadius: 6,
            }}
          >
            <Icon name="close" size={15} />
          </button>
        )}
      </div>

      {error && (
        <div
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            fontSize: 12,
            color: "#DC2626",
            background: "rgba(220, 38, 38, 0.1)",
            border: "1px solid rgba(220, 38, 38, 0.24)",
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      )}

      {/* QR Code & Actions */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <div
          style={{
            width: 172,
            height: 172,
            borderRadius: 12,
            background: "#FFFFFF",
            border: "1px solid rgba(20, 18, 30, 0.12)",
            padding: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            flexShrink: 0,
          }}
        >
          {loading ? (
            <span style={{ fontSize: 12, color: "#64748B" }}>生成二维码…</span>
          ) : qrSvg ? (
            <>
              <div
                style={{ width: "100%", height: "100%", opacity: countdown === 0 ? 0.2 : 1, transition: "opacity 0.2s" }}
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
              {countdown === 0 && (
                <button
                  type="button"
                  onClick={() => void generatePair()}
                  style={{
                    position: "absolute",
                    padding: "6px 12px",
                    borderRadius: 8,
                    border: "none",
                    background: "var(--aurora-accent)",
                    color: "#FFFFFF",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  已过期 · 点击刷新
                </button>
              )}
            </>
          ) : (
            <span style={{ fontSize: 12, color: "#64748B", textAlign: "center", padding: 8 }}>
              {status?.enabled === false ? "手机连接已关闭" : "点击刷新生成二维码"}
            </span>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, color: "var(--aurora-fg2)", lineHeight: 1.6 }}>
            <div>1) 打开手机系统相机对准左侧二维码</div>
            <div>2) 点击弹出的「在 Memento 中打开」提示</div>
            <div>3) 自动完成配对与登录，数据全程留在你本机</div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
            <button
              type="button"
              onClick={() => void generatePair()}
              disabled={loading || busyAction !== null}
              style={actionBtn(false)}
            >
              刷新二维码{countdown > 0 ? ` (${countdown}s)` : ""}
            </button>
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={!pairUrl || countdown === 0}
              style={actionBtn(true)}
            >
              {copied ? "已复制配对链接" : "复制配对链接"}
            </button>
          </div>
        </div>
      </div>

      {/* Three Channels Status & Controls */}
      {status && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            paddingTop: 10,
            borderTop: "1px solid var(--aurora-border)",
          }}
        >
          {/* Channel 1: LAN */}
          <div style={channelRowStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={dot(status.lanRunning ? "#10B981" : "var(--aurora-fg4)")} />
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--aurora-fg1)" }}>局域网直连（同 Wi-Fi 优先）</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--aurora-fg3)", marginTop: 2, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {status.lanUrls[0] || (status.lanEnabled ? "等待获取局域网地址…" : "已关闭")}
              </div>
            </div>
            <label style={switchLabelStyle}>
              <input
                type="checkbox"
                checked={status.enabled && status.lanEnabled}
                disabled={busyAction !== null}
                onChange={(e) => void toggleSetting({ enabled: true, lanEnabled: e.target.checked })}
                style={{ accentColor: "var(--aurora-accent)", cursor: "pointer" }}
              />
              <span>开启</span>
            </label>
          </div>

          {/* Channel 2: Stateless Blind HTTPS Relay */}
          <div style={channelRowStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={dot(relayDotColor)} />
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--aurora-fg1)" }}>远程无状态盲隧道（出门 4G/5G 自动切换）</span>
                <span style={{ fontSize: 11, color: relayDotColor, fontWeight: 600 }}>{relayStatusText}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--aurora-fg3)", marginTop: 2, lineHeight: 1.45 }}>
                仅透传字节流，中转节点零数据库、不存储任何记忆与对话
              </div>
            </div>
            <label style={switchLabelStyle}>
              <input
                type="checkbox"
                checked={status.enabled && status.relayEnabled}
                disabled={busyAction !== null}
                onChange={(e) => void toggleSetting({ enabled: true, relayEnabled: e.target.checked })}
                style={{ accentColor: "var(--aurora-accent)", cursor: "pointer" }}
              />
              <span>开启</span>
            </label>
          </div>

          {/* Channel 3: Tailscale Serve (shown automatically if installed) */}
          {status.tailscale.installed && (
            <div style={channelRowStyle}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={dot(status.tailscale.serveUrl ? "#10B981" : "#D97706")} />
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--aurora-fg1)" }}>Tailscale Serve 私有直连</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--aurora-fg3)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                  {status.tailscale.serveUrl
                    ? status.tailscale.serveUrl
                    : status.tailscale.running
                      ? "已检测到 Tailscale，可一键启用私有 HTTPS 直连"
                      : "已安装 Tailscale（当前未登录运行）"}
                </div>
              </div>
              {status.tailscale.running && !status.tailscale.serveUrl && (
                <button
                  type="button"
                  onClick={() => void handleEnableTailscale()}
                  disabled={busyAction !== null}
                  style={actionBtn(false)}
                >
                  {busyAction === "tailscale" ? "配置中…" : "一键启用"}
                </button>
              )}
            </div>
          )}

          {status.enabled && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
              <button
                type="button"
                onClick={() => void toggleSetting({ enabled: false })}
                disabled={busyAction !== null}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--aurora-fg4)",
                  fontSize: 11.5,
                  cursor: "pointer",
                  padding: "2px 4px",
                }}
              >
                完全关闭手机远程访问
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const channelRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 9,
  background: "var(--aurora-chip)",
  border: "1px solid var(--aurora-border)",
};

const switchLabelStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 12,
  color: "var(--aurora-fg2)",
  cursor: "pointer",
  flexShrink: 0,
  userSelect: "none",
};

function dot(color: string): React.CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: 9999,
    background: color,
    flexShrink: 0,
  };
}

function actionBtn(primary: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: primary ? "none" : "1px solid var(--aurora-border)",
    background: primary ? "var(--aurora-accent)" : "var(--aurora-chip)",
    color: primary ? "#FFFFFF" : "var(--aurora-fg1)",
  };
}
