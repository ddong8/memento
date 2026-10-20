"use client";

import { useEffect, useState } from "react";
import { directConnect, DirectConnectConfig, DirectProbeResult } from "@/lib/direct-connect";
import { Btn, Glass, SectionLabel, GhostInput } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";

export function DirectConnectCard() {
  const [cfg, setCfg] = useState<DirectConnectConfig>(() => directConnect.getConfig());
  const [probeResult, setProbeResult] = useState<DirectProbeResult>(() => directConnect.getStatus());
  const [testing, setTesting] = useState<boolean>(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState<boolean>(false);

  useEffect(() => {
    const unsub = directConnect.subscribe((res) => {
      setProbeResult(res);
    });
    return unsub;
  }, []);

  const handleToggle = (enabled: boolean) => {
    const updated = directConnect.saveConfig({ enabled });
    setCfg(updated);
    setSavedNotice(enabled ? "已开启 IPv6 直连模式" : "已关闭 IPv6 直连模式");
    setTimeout(() => setSavedNotice(null), 3000);
  };

  const handleSaveHost = () => {
    const updated = directConnect.saveConfig({ directHost: cfg.directHost });
    setCfg(updated);
    setSavedNotice("直连地址已保存");
    setTimeout(() => setSavedNotice(null), 3000);
    handleTest(updated.directHost);
  };

  const handleTest = async (targetHost?: string) => {
    setTesting(true);
    try {
      const res = await directConnect.probe(targetHost || cfg.directHost, 2500);
      setProbeResult(res);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Glass
      style={{
        padding: "20px 24px",
        marginBottom: 24,
        borderRadius: 16,
        border: "1px solid var(--aurora-border-strong)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "rgba(16, 185, 129, 0.15)",
              color: "#10B981",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
            }}
          >
            ⚡
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: "var(--aurora-fg)" }}>
              IPv6 直连极速通道 (Happy Eyeballs)
            </div>
            <div style={{ fontSize: 12, color: "var(--aurora-fg4)", marginTop: 2 }}>
              优先通过家庭宽带公网 IPv6 跑满上行带宽秒开大文件，不可用时无缝降级回退至云端中继
            </div>
          </div>
        </div>

        {/* Switch Button */}
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
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--aurora-border)" }}>
          <div style={{ marginBottom: 14 }}>
            <SectionLabel>直连域名或公网 IPv6 地址 (需支持 HTTPS 协议)</SectionLabel>
            <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
              <div style={{ flex: 1 }}>
                <GhostInput
                  placeholder="例如 https://direct.ihasy.com:8443 或 https://[240e:...]:8443"
                  value={cfg.directHost}
                  onChange={(e) => setCfg((prev) => ({ ...prev, directHost: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveHost();
                  }}
                  style={{ width: "100%", fontFamily: "monospace", fontSize: 13 }}
                />
              </div>
              <Btn size="sm" variant="primary" onClick={handleSaveHost} disabled={testing}>
                保存并测速
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => handleTest()} disabled={testing || !cfg.directHost}>
                {testing ? "探测中…" : "单次测试"}
              </Btn>
            </div>
          </div>

          {/* Status Display Banner */}
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              background:
                probeResult.state === "connected"
                  ? "rgba(16, 185, 129, 0.08)"
                  : probeResult.state === "failed"
                  ? "rgba(239, 68, 68, 0.08)"
                  : "rgba(255, 255, 255, 0.04)",
              border:
                probeResult.state === "connected"
                  ? "1px solid rgba(16, 185, 129, 0.25)"
                  : probeResult.state === "failed"
                  ? "1px solid rgba(239, 68, 68, 0.25)"
                  : "1px solid var(--aurora-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
                      : probeResult.state === "failed"
                      ? "#EF4444"
                      : "#9CA3AF",
                }}
              />
              <span style={{ color: "var(--aurora-fg2)" }}>
                {probeResult.state === "connected" && (
                  <>
                    <span style={{ color: "#10B981", fontWeight: 600 }}>直连就绪</span>（往返延迟 RTT: {probeResult.rttMs}ms，媒体流将自动走高速直连通道）
                  </>
                )}
                {probeResult.state === "probing" && <span>正在对直连地址进行探测测速…</span>}
                {probeResult.state === "failed" && (
                  <>
                    <span style={{ color: "#EF4444" }}>直连探测失败</span>
                    <span style={{ color: "var(--aurora-fg4)", marginLeft: 6 }}>
                      ({probeResult.error || "网络不可达"}，已自动安全回退至云端中继)
                    </span>
                  </>
                )}
                {probeResult.state === "untested" && (
                  <span style={{ color: "var(--aurora-fg4)" }}>请输入有效的直连地址并点击“保存并测速”验证连通性</span>
                )}
              </span>
            </div>

            {probeResult.checkedAt > 0 && (
              <span style={{ fontSize: 11, color: "var(--aurora-fg4)", fontFamily: "monospace" }}>
                检查于 {new Date(probeResult.checkedAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          {savedNotice && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#10B981", textAlign: "right" }}>
              ✓ {savedNotice}
            </div>
          )}

          {/* Toggle Configuration Guide */}
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              onClick={() => setShowGuide((v) => !v)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--aurora-brand)",
                fontSize: 12,
                cursor: "pointer",
                padding: 0,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span>{showGuide ? "收起家庭宽带 IPv6 配置指引" : "查看家庭宽带 IPv6 配置指引 (光猫/防火墙/DDNS)"}</span>
              <span style={{ fontSize: 10 }}>{showGuide ? "▲" : "▼"}</span>
            </button>

            {showGuide && (
              <div
                style={{
                  marginTop: 10,
                  padding: 14,
                  borderRadius: 10,
                  background: "rgba(0, 0, 0, 0.25)",
                  border: "1px solid var(--aurora-border)",
                  fontSize: 12,
                  color: "var(--aurora-fg3)",
                  lineHeight: 1.6,
                }}
              >
                <div style={{ fontWeight: 600, color: "var(--aurora-fg)", marginBottom: 6 }}>
                  家庭宽带 IPv6 直连落地三步法：
                </div>
                <div>1) 光猫与主路由防火墙放行：家用路由器通常默认阻断外网入站 SYN。登录主路由（如 OpenWrt/华硕固件），在 IPv6 防火墙的 Traffic Rules 中添加一条允许外部入站访问 NAS/主机的端口转发或放行规则。</div>
                <div>2) 自动更新 DDNS (AAAA 记录)：家庭公网 IPv6 前缀通常 24~48 小时变动一次。可以在服务端宿主机运行我们提供的 <code>scripts/ddns_ipv6.sh</code>，通过 Cloudflare API 自动同步最新的 AAAA 记录至 direct.ihasy.com。</div>
                <div>3) 配置合法 HTTPS 证书：由于前端工作台运行在 HTTPS 安全上下文中，直连地址必须配置有效的 Let's Encrypt / ZeroSSL 证书（如配合 Nginx 反代或 Caddy 自动申请），否则浏览器会阻断跨域混合内容。</div>
              </div>
            )}
          </div>
        </div>
      )}
    </Glass>
  );
}
