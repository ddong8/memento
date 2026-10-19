"use client";

import React, { memo, useMemo } from "react";

interface Suggestion {
  id: string;
  icon: string;
  label: string;
  prompt: string;
  scenario: string;
}

const PRESET_MIND_SUGGESTIONS: Suggestion[] = [
  {
    id: "release",
    icon: "🚀",
    label: "发版三位一体预检与部署",
    prompt: "开始发版流程：严格检查 version.json、tag 与 package.json 版本三位一体一致性，构建并完成集群发布。",
    scenario: "发布交付",
  },
  {
    id: "pubchem",
    icon: "🧪",
    label: "PubChem 逆合成路线 AI 重排",
    prompt: "规划逆合成路线：基于 CAS 精准检索，避免不稳定格式试剂，路线步数经 AI 重排优化。",
    scenario: "化学研发",
  },
  {
    id: "harvest",
    icon: "📦",
    label: "WorkBuddy 化学数据整库备份",
    prompt: "使用 WorkBuddy 抓取数据：优先中文名与 CAS/SMILES 核心字段，整库 dump 到本地并生成可溯源登记。",
    scenario: "数据资产",
  },
  {
    id: "perf",
    icon: "⚡",
    label: "交互零延迟与思考过程全屏铺满",
    prompt: "前端性能调优：检查各组件渲染耗时，确保思考过程全屏拉伸铺满且流式交互零卡顿。",
    scenario: "性能体验",
  },
  {
    id: "evolution",
    icon: "🧠",
    label: "心领神会与常驻画像演进",
    prompt: "检查心领神会心智状态：感知各项目专属铁律、图谱热实体与近期避坑，持续演进画像。",
    scenario: "自进化底座",
  },
];

interface MindAnticipationProps {
  inputValue: string;
  onSelectPrompt: (prompt: string) => void;
  isFocused?: boolean;
}

export const MindAnticipation = memo(function MindAnticipation({
  inputValue,
  onSelectPrompt,
  isFocused = false,
}: MindAnticipationProps) {
  const trimmed = inputValue.trim().toLowerCase();

  const matchedSuggestions = useMemo(() => {
    if (!trimmed) {
      return isFocused ? PRESET_MIND_SUGGESTIONS.slice(0, 3) : [];
    }

    return PRESET_MIND_SUGGESTIONS.filter((s) => {
      const hay = `${s.label} ${s.prompt} ${s.scenario}`.toLowerCase();
      return (
        hay.includes(trimmed) ||
        (trimmed.includes("发版") && s.id === "release") ||
        (trimmed.includes("部署") && s.id === "release") ||
        (trimmed.includes("化学") && s.id === "pubchem") ||
        (trimmed.includes("逆合") && s.id === "pubchem") ||
        (trimmed.includes("爬") && s.id === "harvest") ||
        (trimmed.includes("抓") && s.id === "harvest") ||
        (trimmed.includes("卡") && s.id === "perf") ||
        (trimmed.includes("慢") && s.id === "perf") ||
        (trimmed.includes("记忆") && s.id === "evolution") ||
        (trimmed.includes("懂我") && s.id === "evolution")
      );
    });
  }, [trimmed, isFocused]);

  if (!matchedSuggestions.length) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        overflowX: "auto",
        padding: "4px 8px",
        marginBottom: "6px",
        scrollbarWidth: "none",
        animation: "fadeIn 0.15s ease-out",
      }}
    >
      <span
        style={{
          fontSize: "11px",
          color: "rgba(255, 255, 255, 0.4)",
          display: "flex",
          alignItems: "center",
          gap: "3px",
          userSelect: "none",
          flexShrink: 0,
        }}
      >
        <span>心领神会预判:</span>
      </span>
      {matchedSuggestions.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onSelectPrompt(s.prompt)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "3px 10px",
            borderRadius: "14px",
            fontSize: "12px",
            color: "rgba(255, 255, 255, 0.85)",
            background: "rgba(255, 255, 255, 0.06)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            cursor: "pointer",
            whiteSpace: "nowrap",
            transition: "all 0.15s ease",
            backdropFilter: "blur(8px)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(99, 102, 241, 0.2)";
            e.currentTarget.style.borderColor = "rgba(99, 102, 241, 0.4)";
            e.currentTarget.style.color = "#fff";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "rgba(255, 255, 255, 0.06)";
            e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.12)";
            e.currentTarget.style.color = "rgba(255, 255, 255, 0.85)";
          }}
          title={s.prompt}
        >
          <span>{s.icon}</span>
          <span>{s.label}</span>
        </button>
      ))}
    </div>
  );
});
