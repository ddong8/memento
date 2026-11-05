"use client";

import React from "react";
import CartoonAvatarGraphic from "./CartoonAvatarGraphic";
import { Icon } from "@/components/aurora/Icon";
import type { AvatarSettings } from "@/lib/api-client";

interface CartoonPersonaStageProps {
  activeDimension: string;
  onSelectDimension: (dim: string) => void;
  activeSynapse: string | null;
  evolutionLevel: number;
  evolutionExp: number;
  evolutionStage: string;
  onSparkEvolution?: () => void;
  ruleStats: {
    ironLaws: number;
    communication: number;
    tech: number;
    execution: number;
    project: number;
  };
  isPanelCollapsed: boolean;
  onToggleCollapse?: () => void;
  onToggleFullscreen?: () => void;
  avatarSettings: AvatarSettings | null;
  onOpenAvatarCustomizer?: () => void;
  onToggle3D: () => void;
  className?: string;
}

export default function CartoonPersonaStage({
  activeDimension,
  onSelectDimension,
  ruleStats,
  isPanelCollapsed,
  onToggleCollapse,
  onToggleFullscreen,
  avatarSettings,
  evolutionLevel = 1,
  onOpenAvatarCustomizer,
  onSparkEvolution,
  onToggle3D,
  className = "",
}: CartoonPersonaStageProps) {
  const presetId = avatarSettings?.preset_id || "geek_male";
  const customPhotoUrl = avatarSettings?.custom_photo_url || null;
  const themeColor = avatarSettings?.theme_color || "#8B5CF6";

  return (
    <div
      className={`relative w-full h-full min-h-[300px] sm:min-h-[440px] rounded-3xl overflow-hidden select-none border border-[var(--aurora-border)] bg-[radial-gradient(ellipse_at_50%_0%,#181a36_0%,#080912_55%,#030308_100%)] shadow-2xl flex flex-col justify-between ${className}`}
    >
      {/* 沉浸式动态粒子与环境光晕 (纯 CSS 零 GPU 负担) */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
        <div
          className="absolute -top-[20%] left-1/2 -translate-x-1/2 w-[340px] sm:w-[520px] h-[340px] sm:h-[520px] rounded-full blur-3xl opacity-25 animate-pulse"
          style={{ background: `radial-gradient(circle, ${themeColor} 0%, transparent 70%)` }}
        />
        <div className="absolute inset-0 bg-[radial-gradient(#ffffff08_1px,transparent_1px)] [background-size:24px_24px] opacity-40" />
      </div>

      {/* 顶部状态栏与模式控制 Dock */}
      <div className="relative z-10 p-3 sm:p-4 flex items-center justify-between gap-2 pointer-events-auto">
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenAvatarCustomizer}
            className="px-2.5 py-1 rounded-xl text-xs font-semibold backdrop-blur-md border border-white/20 bg-white/10 hover:bg-white/20 text-white flex items-center gap-1.5 transition-all shadow-md active:scale-95"
            title="定制个人专属卡通立绘与性格特征"
          >
            <span>🎭</span>
            <span>{avatarSettings?.nickname || "心智立绘"}</span>
            <span className="text-[10px] opacity-60">Lv.{evolutionLevel || 1}</span>
          </button>
        </div>

        {/* 右侧功能控制集群 */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* 3D / 2D 极速渲染模式切换开关 */}
          <button
            onClick={onToggle3D}
            className="px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-semibold transition-all backdrop-blur-md border bg-[#3186FF]/20 hover:bg-[#3186FF]/35 text-[#60A5FA] border-[#3186FF]/40 flex items-center gap-1 shadow-md active:scale-95"
            title="开启 3D WebGL 深度全息舞台（消耗更多 GPU）"
          >
            <span>🧊</span>
            <span className="hidden sm:inline">3D 全息</span>
          </button>

          {onSparkEvolution && (
            <button
              onClick={onSparkEvolution}
              title="激发今日心智进化共鸣"
              className="px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-medium transition-all backdrop-blur-md border bg-gradient-to-r from-[#F59E0B]/20 to-[#EC4899]/20 hover:from-[#F59E0B]/35 hover:to-[#EC4899]/35 text-[#F59E0B] border-[#F59E0B]/40 hover:scale-102 flex items-center gap-1 shadow-md"
            >
              <span>⚡</span>
              <span className="hidden sm:inline">共鸣</span>
            </button>
          )}

          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              className="px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-semibold bg-black/65 hover:bg-black/90 backdrop-blur-md border border-white/20 text-white flex items-center gap-1 shadow-md transition-all active:scale-95"
              title={isPanelCollapsed ? "打开右侧管理面板" : "让卡通形象铺满整屏"}
            >
              <span>{isPanelCollapsed ? "⧉" : "⛶"}</span>
              <span className="hidden sm:inline">{isPanelCollapsed ? "打开侧边面板" : "铺满整屏"}</span>
            </button>
          )}

          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="p-1 rounded-xl text-white/80 bg-black/65 hover:bg-black/90 backdrop-blur-md border border-white/20 hover:text-white shadow-md transition-all"
              title="显示器物理全屏"
            >
              <Icon name="command" size={12} />
            </button>
          )}
        </div>
      </div>

      {/* 中央主视窗：自适应立绘动画与呼吸光效 */}
      <div className="relative z-5 flex-1 flex flex-col items-center justify-center p-3 sm:p-6 min-h-0">
        <div className="relative flex items-center justify-center transition-all duration-300">
          {/* 外环呼吸光环 */}
          <div
            className="absolute -inset-4 sm:-inset-6 rounded-full border border-dashed opacity-40 animate-spin"
            style={{
              borderColor: `${themeColor}60`,
              animationDuration: "25s",
            }}
          />
          <div
            className="absolute -inset-1.5 sm:-inset-2 rounded-full border opacity-60"
            style={{
              borderColor: `${themeColor}80`,
              boxShadow: `0 0 35px ${themeColor}40`,
            }}
          />

          {/* 核心立绘组件 (移动端自适应完整显示) */}
          <div className="relative z-10 max-h-[30vh] sm:max-h-[42vh] flex items-center justify-center">
            <CartoonAvatarGraphic
              presetId={presetId}
              customPhotoUrl={customPhotoUrl}
              size={typeof window !== "undefined" && window.innerWidth < 640 ? 150 : 210}
              themeColor={themeColor}
              showGlow={true}
              className="transition-transform duration-300 hover:scale-105"
            />
          </div>
        </div>

        {/* 形象标签与签名 */}
        <div className="mt-3 sm:mt-4 text-center z-10 max-w-sm px-2">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-white/80">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
            <span>2D 极速轻量渲染模式 (零发热/省电)</span>
          </div>
        </div>
      </div>

      {/* 底部五维心智神经特征快捷锚点 (点击下钻至对应心智分类) */}
      <div className="relative z-10 p-2 sm:p-3 flex items-center justify-center gap-1.5 sm:gap-2 flex-wrap bg-black/40 backdrop-blur-md border-t border-white/10">
        {[
          { id: "brain", label: "脑核铁律", icon: "🧠", count: ruleStats.ironLaws, color: "#EF4444" },
          { id: "communication", label: "沟通风格", icon: "💬", count: ruleStats.communication, color: "#06B6D4" },
          { id: "tech", label: "架构心核", icon: "⚡", count: ruleStats.tech, color: "#F59E0B" },
          { id: "execution", label: "工作习惯", icon: "🛠️", count: ruleStats.execution, color: "#10B981" },
          { id: "project", label: "项目专属", icon: "🎯", count: ruleStats.project, color: "#8B5CF6" },
        ].map((item) => {
          const isSelected = activeDimension === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectDimension(item.id)}
              className={`px-2 sm:px-2.5 py-1 rounded-xl text-[10px] sm:text-[11px] font-medium transition-all flex items-center gap-1 border ${
                isSelected
                  ? "bg-white/20 border-white text-white font-bold shadow-md scale-105"
                  : "bg-white/5 border-white/10 text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
              <span className="opacity-60 text-[9px]">({item.count})</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
