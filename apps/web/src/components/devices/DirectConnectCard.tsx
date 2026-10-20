"use client";

import { useEffect, useState } from "react";
import { directConnect, DirectConnectConfig, DirectProbeResult } from "@/lib/direct-connect";
import { Btn, Glass, SectionLabel, GhostInput } from "@/components/aurora/primitives";

export function DirectConnectCard() {
  const [cfg, setCfg] = useState<DirectConnectConfig>(() => directConnect.getConfig());
  const [probeResult, setProbeResult] = useState<DirectProbeResult>(() => directConnect.getStatus());
  const [testing, setTesting] = useState<boolean>(false);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [customInput, setCustomInput] = useState<string>(cfg.customHost || "");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const unsub = directConnect.subscribe((res) => {
      setProbeResult(res);
    });
    return unsub;
  }, []);

  const handleToggle = (enabled: boolean) => {
    const updated = directConnect.saveConfig({ enabled });
    setCfg(updated);
    setNotice(enabled ? "已开启智能直连" : "已切换为纯云端中继模式");
    setTimeout(() => setNotice(null), 3000);
  };

  const handleAutoProbe = async () => {
    setTesting(true);
    try {
      const res = await directConnect.probe(undefined, 2000);
      setProbeResult(res);
      if (res.state === "connected") {
        setNotice(`直连已连通（时延 ${res.rttMs}ms）`);
      } else {
        setNotice("暂未探通直连节点，已平滑保持云端通道");
      }
      setTimeout(() => setNotice(null), 3500);
    } finally {
      setTesting(false);
    }
  };

  const handleSaveCustom = () => {
    const updated = directConnect.saveConfig({ customHost: customInput });
    setCfg(updated);
    setNotice("自定义直连节点已更新");
    setTimeout(() => setNotice(null), 3000);
    handleAutoProbe();
  };

  return (
    <Glass
      style={{
        padding: "18px 22px",
        marginBottom: 20,
        borderRadius: 16,
        border: "1px solid var(--aurora-border-strong)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: cfg.enabled ? "rgba(16, 185, 129, 0.15)" : "rgba(255, 255, 255, 0.08)",
              color: cfg.enabled ? "#10B981" : "var(--aurora-fg4)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
            }}
          >
            ⚡
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: "var(--aurora-fg)", display: "flex", alignItems: "center", gap: 8 }}>
              <span>全自动极速直连 (零配置双轨自适应)</span>
              {cfg.enabled && (
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 99,
                    background: "rgba(16, 185, 129, 0.15)",
                    color: "#10B981",
                    fontWeight: 500,
                  }}
                >
                  免配置开箱即用
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--aurora-fg4)", marginTop: 2 }}>
              无需手动配置防火墙或域名，系统自动嗅探家庭设备的 IPv6 / 局域网通道；可用时秒开原画，不可用时全自动透明走云端
            </div>
          </div>
        </div>

        {/* Global Switch */}
        <label style={{ display: "inline-flex", alignItems: "center", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => handleToggle(e.target.checked)}
            style={{ display: "none" }}
          />
          <div
            style={{
              width: 44,
              height: 24,
              borderRadius: 12,
              background: cfg.enabled ? "#10B981" : "rgba(255, 255, 255, 0.15)",
              position: "relative",
              transition: "background 0.2s",
            }}
          >
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: "#ffffff",
                position: "absolute",
                top: 3,
                left: cfg.enabled ? 23 : 3,
                transition: "left 0.2s",
                boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
              }}
            />
          </div>
        </label>
      </div>

      {cfg.enabled && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--aurora-border)" }}>
          {/* Smart Status Bar */}
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              background:
                probeResult.state === "connected"
                  ? "rgba(16, 185, 129, 0.08)"
                  : "rgba(255, 255, 255, 0.04)",
              border:
                probeResult.state === "connected"
                  ? "1px solid rgba(16, 185, 129, 0.25)"
                  : "1px solid var(--aurora-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background:
                    probeResult.state === "connected"
                      ? "#10B981"
                      : probeResult.state === "probing"
                      ? "#F59E0B"
                      : "#9CA3AF",
                  flexShrink: 0,
                }}
              />
              <div style={{ fontSize: 12, color: "var(--aurora-fg2)", lineHeight: 1.4 }}>
                {probeResult.state === "connected" && (
                  <div>
                    <span style={{ color: "#10B981", fontWeight: 600 }}>直连通道已连通</span>
                    <span style={{ color: "var(--aurora-fg3)", marginLeft: 6 }}>
                      (延迟 {probeResult.rttMs}ms，命中节点：{probeResult.activeEndpoint})
                    </span>
                    <div style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
                      播放大视频与下载将直接通过家庭百兆上行高速传输，不消耗服务器带宽
                    </div>
                  </div>
                )}
                {probeResult.state === "probing" && (
                  <span>正在并发探活家庭设备直连通道 (Happy Eyeballs 竞速中)…</span>
                )}
                {probeResult.state !== "connected" && probeResult.state !== "probing" && (
                  <div>
                    <span style={{ fontWeight: 500, color: "var(--aurora-fg2)" }}>云端安全中继模式</span>
                    <span style={{ color: "var(--aurora-fg4)", marginLeft: 6 }}>
                      (当前网络无直连条件，所有服务与播放已全自动安全走云端专线)
                    </span>
                  </div>
                )}
              </div>
            </div>

            <Btn size="sm" variant="ghost" onClick={handleAutoProbe} disabled={testing}>
              {testing ? "探活中…" : "一键自检/重测"}
            </Btn>
          </div>

          {notice && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#10B981", textAlign: "right" }}>
              ✓ {notice}
            </div>
          )}

          {/* Advanced Accordion (Folded by default) */}
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--aurora-fg4)",
                fontSize: 11,
                cursor: "pointer",
                padding: 0,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span>{showAdvanced ? "收起高级自定义设置" : "高级选项 (可选填自定义 DDNS 域名)"}</span>
              <span style={{ fontSize: 9 }}>{showAdvanced ? "▲" : "▼"}</span>
            </button>

            {showAdvanced && (
              <div
                style={{
                  marginTop: 10,
                  padding: 12,
                  borderRadius: 10,
                  background: "rgba(0, 0, 0, 0.2)",
                  border: "1px solid var(--aurora-border)",
                }}
              >
                <SectionLabel>自定义专属直连域名 (仅高级用户需要，留空则完全全自动)</SectionLabel>
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <div style={{ flex: 1 }}>
                    <GhostInput
                      placeholder="留空即全自动。如需要可填 https://direct.example.com"
                      value={customInput}
                      onChange={(e) => setCustomInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveCustom();
                      }}
                      style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
                    />
                  </div>
                  <Btn size="sm" variant="primary" onClick={handleSaveCustom}>
                    保存
                  </Btn>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Glass>
  );
}
