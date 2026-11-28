"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { triggerHaptic } from "@/lib/haptics";

type TabKey = "table" | "office" | "media" | "wechat";

export function WorkbenchBlock() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<TabKey>("table");

  const tabs: { key: TabKey; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
    { key: "table", label: t.landing.workbench_tab_table, icon: "grid" },
    { key: "office", label: t.landing.workbench_tab_office, icon: "layers" },
    { key: "media", label: t.landing.workbench_tab_media, icon: "maximize" },
    { key: "wechat", label: t.landing.workbench_tab_wechat, icon: "share" },
  ];

  const fileNames: Record<TabKey, string> = {
    table: "eval_benchmark_results_2026.csv",
    office: "2026-Q4-智能体自进化全景规划.pptx",
    media: "circadian_mind_twin_demo.mp4",
    wechat: "打造跨设备自进化AI第二大脑.md",
  };

  const tabMeta: Record<TabKey, string> = {
    table: "100 行窗口切片 · 两级缓存",
    office: "16:9 横屏沉浸放映",
    media: "GPU 3D 硬件合成",
    wechat: "公众号草稿箱直发",
  };

  return (
    <section id="workbench" style={{ padding: "56px 20px", maxWidth: 1120, margin: "0 auto" }}>
      <div style={{ maxWidth: 680, marginBottom: 24 }}>
        <h2
          style={{
            margin: 0,
            fontSize: "clamp(24px, 3.2vw, 32px)",
            fontWeight: 700,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.03em",
            lineHeight: 1.18,
          }}
        >
          {t.landing.workbench_title}
        </h2>
        <p style={{ margin: "10px 0 0", fontSize: 15, color: "var(--aurora-fg3)", lineHeight: 1.55 }}>
          {t.landing.workbench_sub}
        </p>
      </div>

      {/* Segmented switcher */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 18,
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => {
                setActiveTab(tab.key);
                triggerHaptic();
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                padding: "8px 14px",
                borderRadius: 9,
                fontSize: 13.5,
                fontWeight: isActive ? 600 : 500,
                cursor: "pointer",
                transition: "background-color 160ms ease, border-color 160ms ease, color 160ms ease",
                border: isActive
                  ? "1px solid var(--aurora-accent-border, var(--aurora-accent))"
                  : "1px solid var(--aurora-border)",
                background: isActive
                  ? "var(--aurora-accent-soft)"
                  : "var(--aurora-surface-solid)",
                color: isActive
                  ? "var(--aurora-accent)"
                  : "var(--aurora-fg2)",
              }}
            >
              <Icon name={tab.icon} size={15} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Single architectural showcase container — no fake traffic lights, no nested card cages */}
      <div
        style={{
          borderRadius: 14,
          background: "var(--aurora-surface-solid)",
          border: "1px solid var(--aurora-border-strong)",
          boxShadow: "var(--aurora-card-shadow)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 10,
            padding: "12px 18px",
            borderBottom: "1px solid var(--aurora-border)",
            background: "var(--aurora-surface-mute)",
            fontSize: 13,
          }}
        >
          <span style={{ fontWeight: 600, color: "var(--aurora-fg1)", fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
            {fileNames[activeTab]}
          </span>
          <span style={{ fontSize: 12.5, color: "var(--aurora-fg3)" }}>
            {tabMeta[activeTab]}
          </span>
        </div>

        <div style={{ padding: 20 }}>
          {activeTab === "table" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ margin: 0, fontSize: 14, color: "var(--aurora-fg3)", lineHeight: 1.6 }}>
                {t.landing.workbench_table_desc}
              </p>

              <div style={{ overflowX: "auto", borderRadius: 10, border: "1px solid var(--aurora-border)" }}>
                <table style={{ width: "100%", minWidth: 540, borderCollapse: "collapse", fontSize: 13, textAlign: "left" }}>
                  <thead style={{ background: "var(--aurora-surface-mute)", borderBottom: "1px solid var(--aurora-border)" }}>
                    <tr>
                      <th style={{ padding: "10px 12px", width: 44, color: "var(--aurora-fg3)", fontWeight: 600 }}>#</th>
                      <th style={{ padding: "10px 12px", color: "var(--aurora-fg1)", fontWeight: 600 }}>测试样本</th>
                      <th style={{ padding: "10px 12px", color: "var(--aurora-fg1)", fontWeight: 600 }}>智能体工具</th>
                      <th style={{ padding: "10px 12px", color: "var(--aurora-fg1)", fontWeight: 600 }}>检索命中率</th>
                      <th style={{ padding: "10px 12px", color: "var(--aurora-fg1)", fontWeight: 600 }}>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { id: 1, caseName: "跨设备长期记忆联想", tool: "Claude Code", hit: "98.4%", status: "通过" },
                      { id: 2, caseName: "WorkBuddy PPT 产物唤起", tool: "WorkBuddy", hit: "100.0%", status: "通过" },
                      { id: 3, caseName: "大体积 TSV 窗口化切片", tool: "Memento Web", hit: "99.2%", status: "已加速" },
                      { id: 4, caseName: "Codex 本地技能自动灌入", tool: "Codex", hit: "97.8%", status: "通过" },
                    ].map((row, idx, arr) => (
                      <tr key={row.id} style={{ borderBottom: idx < arr.length - 1 ? "1px solid var(--aurora-border)" : "none" }}>
                        <td style={{ padding: "10px 12px", color: "var(--aurora-fg4)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{row.id}</td>
                        <td style={{ padding: "10px 12px", color: "var(--aurora-fg1)", fontWeight: 500 }}>{row.caseName}</td>
                        <td style={{ padding: "10px 12px", color: "var(--aurora-fg3)" }}>{row.tool}</td>
                        <td style={{ padding: "10px 12px", color: "var(--aurora-success)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{row.hit}</td>
                        <td style={{ padding: "10px 12px" }}>
                          <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 6, background: "var(--aurora-success-soft)", color: "var(--aurora-success)", fontWeight: 500 }}>
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 12.5, color: "var(--aurora-fg4)", fontVariantNumeric: "tabular-nums" }}>
                <span>第 1 – 100 行，共 12,480 条记录</span>
                <span>内存占用恒定 · 零主线程卡顿</span>
              </div>
            </div>
          )}

          {activeTab === "office" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ margin: 0, fontSize: 14, color: "var(--aurora-fg3)", lineHeight: 1.6 }}>
                {t.landing.workbench_office_desc}
              </p>
              <div
                style={{
                  borderRadius: 12,
                  minHeight: 240,
                  background: "var(--aurora-bg)",
                  border: "1px solid var(--aurora-border)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  padding: "20px 22px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 12.5, color: "var(--aurora-fg3)" }}>
                  <span style={{ fontWeight: 600, color: "var(--aurora-fg1)" }}>幻灯片第 1 页 / 共 24 页</span>
                  <span>支持 90° 横屏全屏与双指缩放</span>
                </div>
                <div style={{ textAlign: "center", padding: "28px 12px" }}>
                  <div style={{ fontSize: "clamp(18px, 2.6vw, 24px)", fontWeight: 700, color: "var(--aurora-fg1)", letterSpacing: "-0.025em" }}>
                    跨设备具身第二大脑与认知循环
                  </div>
                  <div style={{ fontSize: 14, color: "var(--aurora-fg3)", marginTop: 8 }}>
                    昼夜节律自进化 · 零延迟多端预览
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 12.5, color: "var(--aurora-fg4)" }}>
                  <span>键盘方向键与移动端手势翻页</span>
                  <span>原生 Office Web 渲染视窗</span>
                </div>
              </div>
            </div>
          )}

          {activeTab === "media" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ margin: 0, fontSize: 14, color: "var(--aurora-fg3)", lineHeight: 1.6 }}>
                {t.landing.workbench_media_desc}
              </p>
              <div
                style={{
                  borderRadius: 12,
                  minHeight: 240,
                  background: "#111218",
                  border: "1px solid var(--aurora-border)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  padding: "18px 20px",
                  color: "#F3F4F8",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 12.5 }}>
                  <span style={{ fontWeight: 600 }}>4K / 60FPS 硬件合成通道</span>
                  <span style={{ color: "#989DB2", fontVariantNumeric: "tabular-nums" }}>2.0x · 本地缓存已就绪</span>
                </div>
                <div style={{ margin: "24px auto", width: 52, height: 52, borderRadius: "50%", background: "var(--aurora-primary-grad)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon name="arrow_right" size={20} style={{ color: "#fff", marginLeft: 2 }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ height: 4, width: "100%", background: "rgba(255,255,255,0.16)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: "42%", background: "#818CF8" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#989DB2", fontVariantNumeric: "tabular-nums" }}>
                    <span>01:14 / 02:58</span>
                    <span>组件卸载自动释放解码器与显存</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "wechat" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ margin: 0, fontSize: 14, color: "var(--aurora-fg3)", lineHeight: 1.6 }}>
                {t.landing.workbench_wechat_desc}
              </p>
              <div
                style={{
                  borderRadius: 12,
                  padding: 18,
                  background: "var(--aurora-bg)",
                  border: "1px solid var(--aurora-border)",
                  display: "flex",
                  gap: 18,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <div
                  style={{
                    width: 140,
                    height: 84,
                    borderRadius: 10,
                    background: "#059669",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontWeight: 600,
                    fontSize: 12.5,
                    textAlign: "center",
                    padding: 10,
                    flexShrink: 0,
                  }}
                >
                  2.35:1 封面图自动生成
                </div>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)", marginBottom: 6 }}>
                    全知智能体时代：让所有 AI 编程工具拥有共享长期记忆
                  </div>
                  <div style={{ fontSize: 13.5, color: "var(--aurora-fg3)", lineHeight: 1.55 }}>
                    自动完成插图转存、代码高亮排版与架构图渲染，一键投递至微信公众号草稿箱。
                  </div>
                </div>
                <span style={{ padding: "6px 12px", borderRadius: 8, background: "var(--aurora-success-soft)", color: "var(--aurora-success)", fontSize: 12.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <Icon name="check" size={13} />
                  <span>已同步草稿箱</span>
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
