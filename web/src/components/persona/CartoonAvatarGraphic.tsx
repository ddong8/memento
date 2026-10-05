"use client";

import React from "react";
import { getPresetById } from "./avatarPresets";

interface CartoonAvatarGraphicProps {
  presetId?: string;
  customPhotoUrl?: string | null;
  size?: number; // 像素宽高
  themeColor?: string;
  className?: string;
  showGlow?: boolean;
}

export default function CartoonAvatarGraphic({
  presetId = "geek_male",
  customPhotoUrl,
  size = 120,
  themeColor,
  className = "",
  showGlow = true,
}: CartoonAvatarGraphicProps) {
  const preset = getPresetById(presetId);
  const color = themeColor || preset.themeColor;

  if (customPhotoUrl) {
    return (
      <div
        className={`relative rounded-full overflow-hidden flex items-center justify-center shrink-0 ${className}`}
        style={{
          width: size,
          height: size,
          border: `2px solid ${color}`,
          boxShadow: showGlow ? `0 0 24px ${color}40, 0 0 10px ${color}20` : undefined,
          background: `radial-gradient(circle, ${color}20 0%, #090A10 100%)`,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={customPhotoUrl}
          alt="Custom User Avatar"
          className="w-full h-full object-cover rounded-full"
        />
        <div
          className="absolute inset-0 pointer-events-none rounded-full"
          style={{
            boxShadow: `inset 0 0 12px ${color}60`,
          }}
        />
      </div>
    );
  }

  // 根据 presetId 渲染专属高精细度内联矢量立绘
  return (
    <div
      className={`relative rounded-full overflow-hidden flex items-center justify-center shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        border: `2px solid ${color}`,
        boxShadow: showGlow ? `0 0 24px ${color}35, 0 0 12px ${color}20` : undefined,
        background: `radial-gradient(circle, ${color}25 0%, #0B0D17 100%)`,
      }}
    >
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        className="w-full h-full select-none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id={`bg-${presetId}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={color} stopOpacity="0.4" />
            <stop offset="100%" stopColor="#0B0D17" stopOpacity="0.8" />
          </linearGradient>
          <linearGradient id={`suit-${presetId}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={preset.outfitColor} />
            <stop offset="100%" stopColor="#0F172A" />
          </linearGradient>
          <filter id={`glow-${presetId}`}>
            <feGaussianBlur stdDeviation="2" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* 1. 背景光环与全息科技线 */}
        <circle cx="50" cy="50" r="48" fill={`url(#bg-${presetId})`} />
        <circle
          cx="50"
          cy="50"
          r="46"
          fill="none"
          stroke={color}
          strokeWidth="0.8"
          strokeDasharray="4 3"
          opacity="0.6"
        />

        {/* 2. 差异化角色特征绘制 */}
        {presetId === "geek_male" && (
          // ── 极客男：短发、黑框眼镜、科技连帽卫衣 ──
          <g>
            {/* 卫衣身体 */}
            <path d="M22 92 C24 72, 38 68, 50 68 C62 68, 76 72, 78 92 Z" fill={`url(#suit-${presetId})`} />
            <path d="M42 70 L50 82 L58 70 Z" fill="#1E293B" />
            <circle cx="50" cy="74" r="1.5" fill={color} />
            {/* 脖子 */}
            <rect x="44" y="58" width="12" height="12" rx="3" fill="#FBCFE8" opacity="0.9" />
            {/* 脸部 */}
            <ellipse cx="50" cy="46" rx="17" ry="19" fill="#FED7AA" />
            {/* 极客短发 */}
            <path d="M30 42 C30 28, 42 22, 50 22 C62 22, 70 28, 70 42 C66 32, 60 30, 50 30 C40 30, 34 33, 30 42 Z" fill="#1E1B4B" />
            <path d="M32 36 C38 28, 48 26, 68 34 C64 28, 56 24, 46 25 Z" fill="#312E81" />
            {/* 眼睛与知性黑框眼镜 */}
            <rect x="36" y="42" width="11" height="8" rx="2.5" fill="none" stroke="#0F172A" strokeWidth="1.8" />
            <rect x="53" y="42" width="11" height="8" rx="2.5" fill="none" stroke="#0F172A" strokeWidth="1.8" />
            <line x1="47" y1="46" x2="53" y2="46" stroke="#0F172A" strokeWidth="1.8" />
            <circle cx="41.5" cy="46" r="1.5" fill="#0F172A" />
            <circle cx="58.5" cy="46" r="1.5" fill="#0F172A" />
            {/* 嘴巴微笑 */}
            <path d="M46 56 Q50 59 54 56" fill="none" stroke="#9A3412" strokeWidth="1.2" strokeLinecap="round" />
            {/* 全息代码环 */}
            <circle cx="50" cy="50" r="38" fill="none" stroke={color} strokeWidth="1" strokeDasharray="3 4" opacity="0.8" />
          </g>
        )}

        {presetId === "cyber_male" && (
          // ── 赛博男：霓虹目镜、高领机能、战术短发 ──
          <g>
            {/* 机能装 */}
            <path d="M20 92 C22 70, 36 66, 50 66 C64 66, 78 70, 80 92 Z" fill="#0F172A" />
            <path d="M38 68 L50 78 L62 68 Z" fill={color} opacity="0.3" />
            {/* 高领 */}
            <path d="M42 56 L58 56 L56 68 L44 68 Z" fill="#1E293B" stroke={color} strokeWidth="0.8" />
            {/* 脸部 */}
            <ellipse cx="50" cy="46" rx="16" ry="18" fill="#FDE68A" />
            {/* 凌厉短发与电光挑染 */}
            <path d="M32 40 C32 26, 44 20, 56 22 C68 24, 70 34, 68 44 C65 32, 58 28, 48 28 Z" fill="#18181B" />
            <path d="M40 24 L48 34 L54 26 Z" fill={color} />
            {/* 赛博战术目镜 */}
            <rect x="33" y="42" width="34" height="7" rx="3.5" fill={color} filter={`url(#glow-${presetId})`} opacity="0.9" />
            <line x1="36" y1="45.5" x2="64" y2="45.5" stroke="#FFFFFF" strokeWidth="1.2" opacity="0.8" />
            {/* 嘴角坚毅 */}
            <line x1="46" y1="56" x2="54" y2="56" stroke="#78350F" strokeWidth="1.4" strokeLinecap="round" />
          </g>
        )}

        {presetId === "elite_male" && (
          // ── 精英男：科技西服领带、偏分发型 ──
          <g>
            {/* 西服 */}
            <path d="M22 92 C24 72, 38 68, 50 68 C62 68, 76 72, 78 92 Z" fill="#1E293B" />
            <polygon points="50,68 44,82 50,92 56,82" fill={color} />
            {/* 脸与发型 */}
            <rect x="44" y="58" width="12" height="12" fill="#FED7AA" />
            <ellipse cx="50" cy="46" rx="16" ry="18" fill="#FED7AA" />
            <path d="M32 42 C32 26, 44 22, 66 24 C68 34, 62 44, 62 44 C60 30, 50 28, 40 32 Z" fill="#292524" />
            {/* 眉目 */}
            <path d="M37 40 L45 39" stroke="#1C1917" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M55 39 L63 40" stroke="#1C1917" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="41" cy="45" r="1.8" fill="#1C1917" />
            <circle cx="59" cy="45" r="1.8" fill="#1C1917" />
            <path d="M46 56 Q50 58 54 56" fill="none" stroke="#9A3412" strokeWidth="1.4" strokeLinecap="round" />
          </g>
        )}

        {presetId === "vitality_male" && (
          // ── 元气男：活力微卷短发、运动连帽 ──
          <g>
            <path d="M22 92 C24 70, 38 66, 50 66 C62 66, 76 70, 78 92 Z" fill="#EA580C" />
            <circle cx="50" cy="46" r="17" fill="#FFEDD5" />
            <path d="M30 40 C30 24, 46 20, 68 26 C72 36, 68 46, 66 46 C60 32, 48 30, 36 36 Z" fill="#7C2D12" />
            <path d="M42 22 Q48 16 54 24" stroke={color} strokeWidth="3" fill="none" strokeLinecap="round" />
            <circle cx="42" cy="45" r="2" fill="#431407" />
            <circle cx="58" cy="45" r="2" fill="#431407" />
            <path d="M44 55 Q50 61 56 55" fill="none" stroke="#C2410C" strokeWidth="1.8" strokeLinecap="round" />
          </g>
        )}

        {presetId === "geek_female" && (
          // ── 算法姬：知性平光镜、及肩短发、休闲卫衣 ──
          <g>
            <path d="M24 92 C26 72, 38 68, 50 68 C62 68, 74 72, 76 92 Z" fill={`url(#suit-${presetId})`} />
            <ellipse cx="50" cy="47" rx="15" ry="17" fill="#FEE2E2" />
            {/* 知性短发 */}
            <path d="M30 46 C28 30, 40 22, 50 22 C60 22, 72 30, 70 46 C74 58, 68 64, 66 64 C64 48, 62 32, 50 32 C38 32, 36 48, 34 64 C32 64, 26 58, 30 46 Z" fill="#4A044E" />
            {/* 秀气黑框眼镜 */}
            <circle cx="42" cy="45" r="5" fill="none" stroke="#581C87" strokeWidth="1.4" />
            <circle cx="58" cy="45" r="5" fill="none" stroke="#581C87" strokeWidth="1.4" />
            <line x1="47" y1="45" x2="53" y2="45" stroke="#581C87" strokeWidth="1.4" />
            <circle cx="42" cy="45" r="1.5" fill="#3B0764" />
            <circle cx="58" cy="45" r="1.5" fill="#3B0764" />
            {/* 甜美微笑 */}
            <path d="M46 56 Q50 59 54 56" fill="none" stroke="#E11D48" strokeWidth="1.2" strokeLinecap="round" />
          </g>
        )}

        {presetId === "cyber_female" && (
          // ── 赛博特工女：粉紫挑染、高领机能风衣、全域感知耳麦 ──
          <g>
            <path d="M22 92 C24 70, 36 66, 50 66 C64 66, 76 70, 78 92 Z" fill="#18181B" />
            <path d="M44 56 L56 56 L54 68 L46 68 Z" fill="#BE185D" />
            <ellipse cx="50" cy="46" rx="15" ry="17" fill="#FCE7F3" />
            {/* 挑染短发 */}
            <path d="M28 44 C28 26, 42 20, 54 22 C68 24, 72 38, 70 54 C66 40, 58 30, 48 30 C36 30, 32 40, 30 52 Z" fill="#831843" />
            <path d="M32 38 C34 48, 36 56, 38 60 C36 52, 34 44, 32 38 Z" fill={color} filter={`url(#glow-${presetId})`} />
            {/* 科技耳麦 */}
            <rect x="25" y="42" width="4" height="8" rx="2" fill={color} />
            <path d="M27 46 Q34 54 40 54" stroke={color} strokeWidth="1" fill="none" />
            {/* 眼睛 */}
            <circle cx="42" cy="45" r="1.8" fill="#831843" />
            <circle cx="58" cy="45" r="1.8" fill="#831843" />
            <path d="M47 55 L53 55" stroke="#BE185D" strokeWidth="1.3" strokeLinecap="round" />
          </g>
        )}

        {presetId === "elite_female" && (
          // ── 精英女：干练及肩短发、质感职业装 ──
          <g>
            <path d="M24 92 C26 72, 38 68, 50 68 C62 68, 74 72, 76 92 Z" fill="#064E3B" />
            <polygon points="50,68 45,80 50,88 55,80" fill={color} />
            <ellipse cx="50" cy="46" rx="15" ry="17" fill="#FEF3C7" />
            {/* 及肩利落发型 */}
            <path d="M30 42 C30 26, 44 20, 58 22 C70 24, 72 36, 70 60 C66 44, 60 30, 48 30 C36 30, 32 44, 30 60 Z" fill="#1C1917" />
            <circle cx="42" cy="45" r="1.8" fill="#1C1917" />
            <circle cx="58" cy="45" r="1.8" fill="#1C1917" />
            <path d="M46 56 Q50 58 54 56" fill="none" stroke="#047857" strokeWidth="1.3" strokeLinecap="round" />
          </g>
        )}

        {presetId === "vitality_female" && (
          // ── 元气灵动女：猫耳发光耳机、未来运动双马尾 ──
          <g>
            <path d="M24 92 C26 72, 38 68, 50 68 C62 68, 74 72, 76 92 Z" fill="#E11D48" />
            {/* 猫耳耳机 */}
            <polygon points="34,26 28,14 42,22" fill={color} filter={`url(#glow-${presetId})`} />
            <polygon points="66,26 72,14 58,22" fill={color} filter={`url(#glow-${presetId})`} />
            <ellipse cx="50" cy="46" rx="15" ry="17" fill="#FFF1F2" />
            {/* 灵动发型 */}
            <path d="M28 42 C28 26, 42 22, 56 24 C68 26, 72 38, 70 54 C66 38, 58 30, 48 30 C38 30, 34 38, 30 52 Z" fill="#9F1239" />
            <circle cx="41" cy="45" r="2.2" fill="#881337" />
            <circle cx="59" cy="45" r="2.2" fill="#881337" />
            <circle cx="42" cy="44" r="0.8" fill="#FFFFFF" />
            <circle cx="60" cy="44" r="0.8" fill="#FFFFFF" />
            <path d="M45 55 Q50 60 55 55" fill="none" stroke="#E11D48" strokeWidth="1.6" strokeLinecap="round" />
          </g>
        )}

        {presetId === "ai_sentinel" && (
          // ── 智能体哨兵：重装机甲浮空头盔、猩红单眼 ──
          <g>
            <path d="M22 92 L36 68 L64 68 L78 92 Z" fill="#18181B" stroke="#EF4444" strokeWidth="1.2" />
            {/* 机械头部装甲 */}
            <polygon points="50,22 68,36 64,62 36,62 32,36" fill="#27272A" stroke="#EF4444" strokeWidth="1.5" />
            {/* 核心猩红防御光眼 */}
            <rect x="38" y="44" width="24" height="6" rx="3" fill="#EF4444" filter={`url(#glow-${presetId})`} />
            <circle cx="50" cy="47" r="2.5" fill="#FFFFFF" />
            <circle cx="50" cy="50" r="38" fill="none" stroke="#EF4444" strokeWidth="1" strokeDasharray="6 3" />
          </g>
        )}

        {presetId === "ai_synthesizer" && (
          // ── 智能体量子超体：多维能量球、光子跃迁环 ──
          <g>
            {/* 能量流体身躯 */}
            <path d="M28 92 Q50 64 72 92 Z" fill={`url(#suit-${presetId})`} opacity="0.8" />
            {/* 核心能量光球 */}
            <circle cx="50" cy="48" r="18" fill={color} filter={`url(#glow-${presetId})`} opacity="0.95" />
            <circle cx="50" cy="48" r="10" fill="#FFFFFF" />
            {/* 双重轨道环 */}
            <ellipse cx="50" cy="48" rx="30" ry="12" fill="none" stroke="#FACC15" strokeWidth="1.4" transform="rotate(-25 50 48)" />
            <ellipse cx="50" cy="48" rx="30" ry="12" fill="none" stroke="#38BDF8" strokeWidth="1.4" transform="rotate(35 50 48)" />
          </g>
        )}
      </svg>
    </div>
  );
}
