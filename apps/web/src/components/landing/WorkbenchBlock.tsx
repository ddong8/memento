"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Glass, SectionLabel, Chip } from "@/components/aurora/primitives";
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

  return (
    <section id="workbench" style={{ padding: "48px 20px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <SectionLabel style={{ margin: 0, marginBottom: 8 }}>{t.landing.workbench_kicker}</SectionLabel>
        <h2
          style={{
            margin: 0,
            fontSize: "clamp(22px, 3.2vw, 30px)",
            fontWeight: 600,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.025em",
          }}
        >
          {t.landing.workbench_title}
        </h2>
        <p
          style={{
            margin: "12px auto 0",
            fontSize: 14,
            color: "var(--aurora-fg3)",
            maxWidth: 680,
            lineHeight: 1.6,
          }}
        >
          {t.landing.workbench_sub}
        </p>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 24,
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
                gap: 8,
                padding: "8px 16px",
                borderRadius: 12,
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                transition: "all .18s ease",
                border: isActive
                  ? "1px solid var(--aurora-accent)"
                  : "1px solid var(--aurora-border)",
                background: isActive
                  ? "var(--aurora-accent-soft)"
                  : "var(--aurora-surface)",
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

      {/* Showcase Card */}
      <Glass padding={0} radius={22} style={{ overflow: "hidden", border: "1px solid var(--aurora-border)" }}>
        {/* Top Header Bar of the Mock Window */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--aurora-border)",
            background: "var(--aurora-chip)",
            fontSize: 12,
            color: "var(--aurora-fg3)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#FF5F56", display: "inline-block" }} />
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#FFBD2E", display: "inline-block" }} />
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#27C93F", display: "inline-block" }} />
            </div>
            <span style={{ marginLeft: 6, fontWeight: 600, color: "var(--aurora-fg1)" }}>
              {activeTab === "table" && "eval_benchmark_results_2026.csv"}
              {activeTab === "office" && "2026-Q4-智能体自进化全景规划.pptx"}
              {activeTab === "media" && "circadian_mind_twin_demo.mp4"}
              {activeTab === "wechat" && "打造跨设备自进化AI第二大脑.md"}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Chip tone="accent">
              {activeTab === "table" && "千万单元格秒开"}
              {activeTab === "office" && "16:9 横屏满屏放映"}
              {activeTab === "media" && "GPU 3D 合成加速"}
              {activeTab === "wechat" && "微信公众号一键草稿"}
            </Chip>
          </div>
        </div>

        {/* Tab Specific Interactive Previews */}
        <div style={{ padding: 20 }}>
          {activeTab === "table" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 13, color: "var(--aurora-fg3)" }}>
                {t.landing.workbench_table_desc}
              </div>

              {/* Mock Search Bar */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: "var(--aurora-surface-solid)",
                  border: "1px solid var(--aurora-border)",
                  fontSize: 12,
                  color: "var(--aurora-fg2)",
                }}
              >
                <Icon name="search" size={14} style={{ color: "var(--aurora-fg4)" }} />
                <span>检索表格数据内容 (如：latency &lt; 50ms, model=claude-3-7)...</span>
              </div>

              {/* Mini Table Mock */}
              <div style={{ borderRadius: 12, border: "1px solid var(--aurora-border)", overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, textAlign: "left" }}>
                  <thead style={{ background: "var(--aurora-chip)", borderBottom: "1px solid var(--aurora-border)" }}>
                    <tr>
                      <th style={{ padding: "8px 12px", width: 44, color: "var(--aurora-fg4)", borderRight: "1px solid var(--aurora-border)" }}>#</th>
                      <th style={{ padding: "8px 12px", color: "var(--aurora-fg1)", borderRight: "1px solid var(--aurora-border)" }}>测试样本</th>
                      <th style={{ padding: "8px 12px", color: "var(--aurora-fg1)", borderRight: "1px solid var(--aurora-border)" }}>智能体工具</th>
                      <th style={{ padding: "8px 12px", color: "var(--aurora-fg1)", borderRight: "1px solid var(--aurora-border)" }}>检索命中率</th>
                      <th style={{ padding: "8px 12px", color: "var(--aurora-fg1)" }}>执行状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { id: 1, caseName: "跨设备长期记忆联想", tool: "Claude Code", hit: "98.4%", status: "PASSED" },
                      { id: 2, caseName: "WorkBuddy PPT产物唤起", tool: "WorkBuddy", hit: "100.0%", status: "PASSED" },
                      { id: 3, caseName: "大体积TSV窗口化切片", tool: "Memento Web", hit: "99.2%", status: "OPTIMIZED" },
                      { id: 4, caseName: "Codex本地技能自动灌入", tool: "Codex", hit: "97.8%", status: "PASSED" },
                    ].map((row) => (
                      <tr key={row.id} style={{ borderBottom: "1px solid var(--aurora-border)" }}>
                        <td style={{ padding: "8px 12px", color: "var(--aurora-fg4)", borderRight: "1px solid var(--aurora-border)", fontFamily: "monospace" }}>{row.id}</td>
                        <td style={{ padding: "8px 12px", color: "var(--aurora-fg2)", borderRight: "1px solid var(--aurora-border)", fontWeight: 500 }}>{row.caseName}</td>
                        <td style={{ padding: "8px 12px", color: "var(--aurora-fg3)", borderRight: "1px solid var(--aurora-border)" }}>{row.tool}</td>
                        <td style={{ padding: "8px 12px", color: "#10B981", borderRight: "1px solid var(--aurora-border)", fontWeight: 600 }}>{row.hit}</td>
                        <td style={{ padding: "8px 12px" }}>
                          <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(16,185,129,0.12)", color: "#10B981", fontWeight: 600 }}>
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Pagination Controls */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 14px",
                    background: "var(--aurora-chip)",
                    fontSize: 11,
                    color: "var(--aurora-fg3)",
                  }}
                >
                  <span>显示第 1 - 100 行 / 共 12,480 条数据 (两级缓存已启用)</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button type="button" style={{ padding: "2px 8px", borderRadius: 6, border: "1px solid var(--aurora-border)", background: "var(--aurora-surface)", color: "var(--aurora-fg2)" }}>首页</button>
                    <button type="button" style={{ padding: "2px 8px", borderRadius: 6, border: "1px solid var(--aurora-border)", background: "var(--aurora-surface)", color: "var(--aurora-fg2)" }}>上一页</button>
                    <span style={{ padding: "2px 8px", fontWeight: 600, color: "var(--aurora-fg1)" }}>1 / 125</span>
                    <button type="button" style={{ padding: "2px 8px", borderRadius: 6, border: "1px solid var(--aurora-border)", background: "var(--aurora-surface)", color: "var(--aurora-fg2)" }}>下一页</button>
                    <button type="button" style={{ padding: "2px 8px", borderRadius: 6, border: "1px solid var(--aurora-border)", background: "var(--aurora-surface)", color: "var(--aurora-fg2)" }}>末页</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "office" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 13, color: "var(--aurora-fg3)" }}>
                {t.landing.workbench_office_desc}
              </div>

              <div
                style={{
                  position: "relative",
                  borderRadius: 14,
                  aspectRatio: "16 / 9",
                  maxHeight: 320,
                  background: "radial-gradient(circle at 50% 40%, rgba(124,58,237,0.18), transparent 70%), var(--aurora-surface-solid)",
                  border: "1px solid var(--aurora-border)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  padding: 16,
                  overflow: "hidden",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 18 }}>📊</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--aurora-fg1)" }}>幻灯片放映视窗 (Slide 1 / 24)</span>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <span style={{ padding: "3px 8px", borderRadius: 6, background: "var(--aurora-accent-soft)", color: "var(--aurora-accent)", fontSize: 11, fontWeight: 600 }}>
                      16:9 沉浸放映
                    </span>
                    <span style={{ padding: "3px 8px", borderRadius: 6, background: "var(--aurora-chip)", color: "var(--aurora-fg2)", fontSize: 11 }}>
                      90° 旋转全屏
                    </span>
                  </div>
                </div>

                <div style={{ textAlign: "center", margin: "auto" }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "var(--aurora-fg1)", letterSpacing: "-0.02em" }}>
                    跨设备具身第二大脑与认知循环
                  </div>
                  <div style={{ fontSize: 13, color: "var(--aurora-fg3)", marginTop: 6 }}>
                    Circadian Mind Twin · 昼夜节律自进化 · 零延迟交互
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "var(--aurora-fg4)" }}>
                  <span>支持双指缩放、翻页快捷键与移动端原生全屏</span>
                  <span>渲染引擎：原生 Office Web 视窗</span>
                </div>
              </div>
            </div>
          )}

          {activeTab === "media" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 13, color: "var(--aurora-fg3)" }}>
                {t.landing.workbench_media_desc}
              </div>

              <div
                style={{
                  position: "relative",
                  borderRadius: 14,
                  aspectRatio: "16 / 9",
                  maxHeight: 320,
                  background: "#0c0d12",
                  border: "1px solid var(--aurora-border)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  padding: 16,
                  color: "#fff",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.9)" }}>
                    4K / 60FPS 极速渲染通道
                  </span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(16,185,129,0.25)", color: "#34D399", fontWeight: 600 }}>
                      GPU 3D 合成
                    </span>
                    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(255,255,255,0.12)", color: "#fff" }}>
                      2.0x 倍速
                    </span>
                  </div>
                </div>

                {/* Center Play Button Graphic */}
                <div style={{ margin: "auto", width: 56, height: 56, borderRadius: "50%", background: "var(--aurora-accent)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 8px 24px rgba(124,58,237,0.4)" }}>
                  <Icon name="arrow_right" size={20} style={{ color: "#fff", marginLeft: 2 }} />
                </div>

                {/* Bottom Timeline Mock */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ height: 4, width: "100%", background: "rgba(255,255,255,0.2)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: "42%", background: "var(--aurora-accent)" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,0.6)" }}>
                    <span>01:14 / 02:58</span>
                    <span>组件卸载时显存自动解绑 load()</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "wechat" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 13, color: "var(--aurora-fg3)" }}>
                {t.landing.workbench_wechat_desc}
              </div>

              <div
                style={{
                  borderRadius: 14,
                  padding: 18,
                  background: "var(--aurora-surface-solid)",
                  border: "1px solid var(--aurora-border)",
                  display: "flex",
                  gap: 16,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                {/* WeChat Article Cover Thumbnail */}
                <div
                  style={{
                    width: 130,
                    height: 80,
                    borderRadius: 10,
                    background: "linear-gradient(135deg, #10B981, #047857)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 12,
                    textAlign: "center",
                    padding: 8,
                    flexShrink: 0,
                  }}
                >
                  微信公众号 2.35:1 官方封面图
                </div>

                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", marginBottom: 4 }}>
                    全知智能体时代：让所有 AI 编程工具拥有共享长期记忆
                  </div>
                  <div style={{ fontSize: 12, color: "var(--aurora-fg3)", lineHeight: 1.5 }}>
                    自动提取高清插图、代码高亮渲染与 SVG 架构图，一键提交至公众平台草稿箱，无需二次排版。
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <span style={{ padding: "6px 12px", borderRadius: 8, background: "#07C160", color: "#fff", fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4 }}>
                    ✓ 已落库草稿箱
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </Glass>
    </section>
  );
}
