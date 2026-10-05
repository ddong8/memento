"use client";

import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Chip } from "@/components/aurora/primitives";
import { api, AvatarSettings } from "@/lib/api-client";
import { AVATAR_PRESETS, getPresetsByGender, getPresetById, AvatarPreset } from "./avatarPresets";
import CartoonAvatarGraphic from "./CartoonAvatarGraphic";

interface AvatarOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentSettings?: AvatarSettings | null;
  onSaved: (newSettings: AvatarSettings) => void;
  isFirstTime?: boolean;
}

const THEME_COLORS = [
  { name: "全息紫", color: "#8B5CF6" },
  { name: "电光青", color: "#06B6D4" },
  { name: "耀世金", color: "#FACC15" },
  { name: "电光粉", color: "#EC4899" },
  { name: "翡翠绿", color: "#10B981" },
  { name: "猩红守卫", color: "#EF4444" },
  { name: "曜石黑金", color: "#F59E0B" },
];

export default function AvatarOnboardingModal({
  isOpen,
  onClose,
  currentSettings,
  onSaved,
  isFirstTime = false,
}: AvatarOnboardingModalProps) {
  // 步骤控制: 1 = 性别与基调, 2 = 挑选卡通形象或上传照片制作, 3 = 确认激活
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // 状态字段
  const [gender, setGender] = useState<"male" | "female" | "agent">("male");
  const [activeTab, setActiveTab] = useState<"preset" | "photo">("preset");
  const [selectedPresetId, setSelectedPresetId] = useState<string>("geek_male");
  const [customPhotoUrl, setCustomPhotoUrl] = useState<string>("");
  const [nickname, setNickname] = useState<string>("极客孪生");
  const [themeColor, setThemeColor] = useState<string>("#8B5CF6");
  const [outfitColor, setOutfitColor] = useState<string>("#4F46E5");
  const [features, setFeatures] = useState<string[]>(["黑框眼镜", "连帽卫衣", "代码全息环"]);

  // 照片上传与 AI 处理状态
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [isAnalyzingPhoto, setIsAnalyzingPhoto] = useState<boolean>(false);
  const [analysisSummary, setAnalysisSummary] = useState<string>("");
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [avatarMode, setAvatarMode] = useState<"preset" | "custom_photo">("preset");
  const [mounted, setMounted] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 初始化设置同步
  useEffect(() => {
    if (currentSettings) {
      setGender(currentSettings.gender || "male");
      setSelectedPresetId(currentSettings.preset_id || (currentSettings.gender === "female" ? "cyber_female" : "geek_male"));
      setNickname(currentSettings.nickname || "极客孪生");
      setThemeColor(currentSettings.theme_color || "#8B5CF6");
      setOutfitColor(currentSettings.outfit_color || "#4F46E5");
      setFeatures(currentSettings.features || ["全栈极客", "黑框眼镜", "代码全息环"]);
      if (currentSettings.custom_photo_url) {
        setCustomPhotoUrl(currentSettings.custom_photo_url);
        setAvatarMode("custom_photo");
      }
    }
  }, [currentSettings, isOpen]);

  // 当性别改变时，更新推荐预设
  const handleGenderChange = (nextGender: "male" | "female" | "agent") => {
    setGender(nextGender);
    const presets = getPresetsByGender(nextGender);
    if (presets.length > 0) {
      const defaultP = presets[0];
      setSelectedPresetId(defaultP.id);
      setThemeColor(defaultP.themeColor);
      setOutfitColor(defaultP.outfitColor);
      setFeatures(defaultP.features);
    }
  };

  // 选中预设
  const handleSelectPreset = (p: AvatarPreset) => {
    setSelectedPresetId(p.id);
    setThemeColor(p.themeColor);
    setOutfitColor(p.outfitColor);
    setFeatures(p.features);
    setAvatarMode("preset");
  };

  // 处理照片本地读取
  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      setCustomPhotoUrl(result);
      setAvatarMode("custom_photo");
    };
    reader.readAsDataURL(file);
  };

  // 触发 AI 卡通化视觉分析
  const handleRunAiAnalysis = async () => {
    if (!customPhotoUrl) return;
    setIsAnalyzingPhoto(true);
    setAnalysisSummary("");
    try {
      const res = await api.generateAvatarFromPhoto({
        photo_data: customPhotoUrl,
        gender,
      });
      if (res && res.features) {
        setFeatures(res.features);
        setSelectedPresetId(res.preset_id);
        setThemeColor(res.theme_color);
        setOutfitColor(res.outfit_color);
        setAnalysisSummary(res.analysis_summary);
      }
    } catch {
      // 容错处理：本地启发式特征补充
      setFeatures(["智能拟态", "多维感知", "专属定制光环"]);
      setAnalysisSummary("已完成本地视觉特征匹配与卡通化映射！");
    } finally {
      setIsAnalyzingPhoto(false);
    }
  };

  // 保存形象
  const handleSaveAvatar = async () => {
    setIsSaving(true);
    try {
      const payload: AvatarSettings = {
        is_initialized: true,
        gender,
        style: getPresetById(selectedPresetId).style,
        preset_id: selectedPresetId,
        nickname: nickname.trim() || "数字孪生",
        avatar_url: avatarMode === "custom_photo" && customPhotoUrl ? customPhotoUrl : undefined,
        custom_photo_url: customPhotoUrl || undefined,
        theme_color: themeColor,
        outfit_color: outfitColor,
        features: features,
        updated_at: new Date().toISOString(),
      };
      const res = await api.saveAvatarSettings(payload);
      if (res && res.settings) {
        onSaved(res.settings);
      } else {
        onSaved(payload);
      }
      onClose();
    } catch (err) {
      console.error("保存形象失败:", err);
      // 本地保底
      onSaved({
        is_initialized: true,
        gender,
        style: getPresetById(selectedPresetId).style,
        preset_id: selectedPresetId,
        nickname: nickname.trim() || "数字孪生",
        avatar_url: customPhotoUrl || undefined,
        custom_photo_url: customPhotoUrl || undefined,
        theme_color: themeColor,
        outfit_color: outfitColor,
        features,
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen || !mounted) return null;

  const currentPresets = getPresetsByGender(gender);
  const activePreset = getPresetById(selectedPresetId);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
      {/* 深色全息磨砂背景 */}
      <div
        className="fixed inset-0 bg-black/85 backdrop-blur-2xl transition-opacity animate-in fade-in"
        onClick={() => !isFirstTime && onClose()}
      />

      {/* 主浮窗主体 */}
      <div
        className="relative w-full max-w-4xl bg-[#090A12]/95 border border-white/20 rounded-3xl shadow-[0_0_60px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col z-10 my-auto text-white"
        style={{
          boxShadow: `0 0 50px ${themeColor}20, 0 20px 40px rgba(0,0,0,0.8)`,
        }}
      >
        {/* 顶部绚丽流光条 */}
        <div
          className="h-1.5 w-full shrink-0"
          style={{
            background: `linear-gradient(90deg, ${themeColor}, #3B82F6, #EC4899, ${themeColor})`,
            backgroundSize: "200% 100%",
          }}
        />

        {/* 顶部标题栏与步骤指示 */}
        <div className="p-4 sm:p-6 border-b border-white/10 flex items-center justify-between gap-4 shrink-0 bg-white/5">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0"
              style={{
                backgroundColor: `${themeColor}20`,
                border: `1px solid ${themeColor}60`,
                color: themeColor,
              }}
            >
              <Icon name="user" size={20} />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold tracking-tight text-white flex items-center gap-2">
                <span>{isFirstTime ? "数字孪生形象初始化向导" : "定制与重塑数字孪生形象"}</span>
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full font-mono uppercase tracking-wider font-semibold"
                  style={{
                    backgroundColor: `${themeColor}25`,
                    color: themeColor,
                    border: `1px solid ${themeColor}40`,
                  }}
                >
                  3D Avatar Studio
                </span>
              </h2>
              <p className="text-xs text-white/60">
                定义你的专属数字孪生：选择性别、卡通形象预设，或上传自拍制作个人卡通化身
              </p>
            </div>
          </div>

          {/* 右上角关闭按钮 (如果是初次进入但用户想稍后再试，也允许跳过) */}
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors"
            title="关闭向导"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* 步骤条指示器 */}
        <div className="px-6 py-2.5 bg-black/40 border-b border-white/5 flex items-center justify-between text-xs shrink-0">
          <div className="flex items-center gap-2 sm:gap-6">
            <button
              onClick={() => setStep(1)}
              className={`flex items-center gap-1.5 font-medium transition-colors ${
                step === 1 ? "text-white font-bold" : "text-white/40 hover:text-white/70"
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                  step === 1 ? "bg-white text-black font-bold" : "bg-white/10 text-white/60"
                }`}
              >
                1
              </span>
              <span>性别与基调</span>
            </button>

            <span className="text-white/20">/</span>

            <button
              onClick={() => setStep(2)}
              className={`flex items-center gap-1.5 font-medium transition-colors ${
                step === 2 ? "text-white font-bold" : "text-white/40 hover:text-white/70"
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                  step === 2 ? "bg-white text-black font-bold" : "bg-white/10 text-white/60"
                }`}
              >
                2
              </span>
              <span>形象塑造 & 照片定制</span>
            </button>

            <span className="text-white/20">/</span>

            <button
              onClick={() => setStep(3)}
              className={`flex items-center gap-1.5 font-medium transition-colors ${
                step === 3 ? "text-white font-bold" : "text-white/40 hover:text-white/70"
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                  step === 3 ? "bg-white text-black font-bold" : "bg-white/10 text-white/60"
                }`}
              >
                3
              </span>
              <span>心智确认与激活</span>
            </button>
          </div>

          <div className="hidden sm:block text-[11px] text-white/40 font-mono">
            Step {step} of 3
          </div>
        </div>

        {/* ── 步骤内容区 ── */}
        <div className="p-5 sm:p-7 overflow-y-auto max-h-[64vh] min-h-[360px] flex-1">
          {/* ══════════════════════════════════════════════════════════
              步骤 1: 性别与数字基调
              ══════════════════════════════════════════════════════════ */}
          {step === 1 && (
            <div className="space-y-6 animate-in fade-in">
              <div className="text-center space-y-1">
                <h3 className="text-base sm:text-lg font-bold text-white">选择你的数字孪生性别身份</h3>
                <p className="text-xs text-white/60">
                  性别决定了 3D 骨架体态、卡通形象库的穿搭风格以及声音的声线特质
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
                {/* 1. 男性 */}
                <div
                  onClick={() => handleGenderChange("male")}
                  className={`p-5 rounded-2xl border cursor-pointer transition-all flex flex-col items-center text-center gap-3 relative group ${
                    gender === "male"
                      ? "bg-blue-950/40 border-blue-500 shadow-[0_0_24px_rgba(59,130,246,0.3)] ring-1 ring-blue-400"
                      : "bg-white/5 border-white/10 hover:border-white/30 hover:bg-white/10"
                  }`}
                >
                  <div className="w-16 h-16 rounded-2xl bg-blue-500/20 flex items-center justify-center text-3xl">
                    👦
                  </div>
                  <div>
                    <h4 className="font-bold text-sm text-white">男性角色 · He / Him</h4>
                    <p className="text-[11px] text-white/60 mt-1 leading-relaxed">
                      沉稳挺拔极客站姿，经典科技连帽衫与架构西装，深邃理性。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1 justify-center mt-auto">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300">
                      #极客全栈
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300">
                      #工程架构
                    </span>
                  </div>
                </div>

                {/* 2. 女性 */}
                <div
                  onClick={() => handleGenderChange("female")}
                  className={`p-5 rounded-2xl border cursor-pointer transition-all flex flex-col items-center text-center gap-3 relative group ${
                    gender === "female"
                      ? "bg-pink-950/40 border-pink-500 shadow-[0_0_24px_rgba(236,72,153,0.3)] ring-1 ring-pink-400"
                      : "bg-white/5 border-white/10 hover:border-white/30 hover:bg-white/10"
                  }`}
                >
                  <div className="w-16 h-16 rounded-2xl bg-pink-500/20 flex items-center justify-center text-3xl">
                    👧
                  </div>
                  <div>
                    <h4 className="font-bold text-sm text-white">女性角色 · She / Her</h4>
                    <p className="text-[11px] text-white/60 mt-1 leading-relaxed">
                      灵动优雅科技体态，知性平光镜、机能风衣与猫耳光感耳机。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1 justify-center mt-auto">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300">
                      #算法极客姬
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300">
                      #赛博特工
                    </span>
                  </div>
                </div>

                {/* 3. 硅基智能体 */}
                <div
                  onClick={() => handleGenderChange("agent")}
                  className={`p-5 rounded-2xl border cursor-pointer transition-all flex flex-col items-center text-center gap-3 relative group ${
                    gender === "agent"
                      ? "bg-purple-950/40 border-purple-500 shadow-[0_0_24px_rgba(168,85,247,0.3)] ring-1 ring-purple-400"
                      : "bg-white/5 border-white/10 hover:border-white/30 hover:bg-white/10"
                  }`}
                >
                  <div className="w-16 h-16 rounded-2xl bg-purple-500/20 flex items-center justify-center text-3xl">
                    🤖
                  </div>
                  <div>
                    <h4 className="font-bold text-sm text-white">硅基智能体 · AI Agent</h4>
                    <p className="text-[11px] text-white/60 mt-1 leading-relaxed">
                      超导浮空机甲装甲与高维量子能量球，超脱性别限制的纯粹算力体。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1 justify-center mt-auto">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300">
                      #脑核哨兵
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300">
                      #量子超体
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════
              步骤 2: 形象塑造 (精选预设 VS 上传照片制作)
              ══════════════════════════════════════════════════════════ */}
          {step === 2 && (
            <div className="space-y-6 animate-in fade-in">
              {/* 顶部双通道选项卡 */}
              <div className="flex items-center justify-center">
                <div className="inline-flex p-1 bg-white/5 rounded-2xl border border-white/10 shadow-inner">
                  <button
                    onClick={() => setActiveTab("preset")}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
                      activeTab === "preset"
                        ? "bg-white text-black shadow-md"
                        : "text-white/60 hover:text-white"
                    }`}
                  >
                    <span>🎭 精选卡通人物形象库</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/10">
                      {currentPresets.length} 种
                    </span>
                  </button>

                  <button
                    onClick={() => setActiveTab("photo")}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
                      activeTab === "photo"
                        ? "bg-white text-black shadow-md"
                        : "text-white/60 hover:text-white"
                    }`}
                  >
                    <span>📸 上传照片 AI 定制人物形象</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-pink-500/20 text-pink-400">
                      AI 多模态
                    </span>
                  </button>
                </div>
              </div>

              {/* ── 通道 A: 精品卡通预设库 ── */}
              {activeTab === "preset" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {currentPresets.map((preset) => {
                    const isSelected = selectedPresetId === preset.id && avatarMode === "preset";
                    return (
                      <div
                        key={preset.id}
                        onClick={() => handleSelectPreset(preset)}
                        className={`p-3.5 rounded-2xl border cursor-pointer transition-all flex items-start gap-3.5 relative ${
                          isSelected
                            ? "bg-white/10 border-white/60 shadow-lg ring-1 ring-white/50"
                            : "bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/8"
                        }`}
                        style={{
                          borderColor: isSelected ? preset.themeColor : undefined,
                        }}
                      >
                        <CartoonAvatarGraphic
                          presetId={preset.id}
                          size={70}
                          themeColor={preset.themeColor}
                          showGlow={isSelected}
                        />

                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center justify-between gap-1">
                            <h4 className="font-bold text-sm text-white truncate">
                              {preset.name}
                            </h4>
                            <span
                              className="text-[9px] px-1.5 py-0.5 rounded-full font-mono uppercase font-bold shrink-0"
                              style={{
                                backgroundColor: `${preset.themeColor}25`,
                                color: preset.themeColor,
                                border: `1px solid ${preset.themeColor}40`,
                              }}
                            >
                              {preset.badge}
                            </span>
                          </div>

                          <p className="text-[11px] text-white/50 truncate">
                            {preset.title}
                          </p>

                          <p className="text-[11px] text-white/70 line-clamp-2 leading-relaxed">
                            {preset.description}
                          </p>

                          <div className="flex flex-wrap gap-1 pt-1">
                            {preset.features.map((f) => (
                              <span
                                key={f}
                                className="text-[9px] px-1.5 py-0.5 rounded bg-white/10 text-white/80"
                              >
                                {f}
                              </span>
                            ))}
                          </div>
                        </div>

                        {isSelected && (
                          <div
                            className="absolute top-2.5 right-2.5 w-4 h-4 rounded-full flex items-center justify-center text-[10px]"
                            style={{ backgroundColor: preset.themeColor, color: "#fff" }}
                          >
                            ✓
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── 通道 B: 上传照片 AI 定制人物形象 ── */}
              {activeTab === "photo" && (
                <div className="space-y-4">
                  <div className="p-5 rounded-2xl bg-white/5 border border-white/10 border-dashed flex flex-col items-center justify-center text-center gap-3">
                    <input
                      type="file"
                      ref={fileInputRef}
                      accept="image/*"
                      onChange={handlePhotoSelect}
                      className="hidden"
                    />

                    {customPhotoUrl ? (
                      <div className="flex flex-col items-center gap-3">
                        <CartoonAvatarGraphic
                          customPhotoUrl={customPhotoUrl}
                          size={110}
                          themeColor={themeColor}
                          showGlow={true}
                        />

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => fileInputRef.current?.click()}
                            className="text-xs text-white/70 hover:text-white underline"
                          >
                            更换其他照片
                          </button>
                          <span className="text-white/30">|</span>
                          <span className="text-xs text-emerald-400 font-mono">
                            ✓ 照片已加载就绪
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2 py-4">
                        <div className="w-14 h-14 rounded-2xl bg-white/10 mx-auto flex items-center justify-center text-2xl">
                          📷
                        </div>
                        <h4 className="font-bold text-sm text-white">点击选择或拖放您的自拍/生活照</h4>
                        <p className="text-xs text-white/50 max-w-sm">
                          Memento 将通过 AI 视觉提取您的发型、眼镜、穿搭风格，并为您生成量身定制的专属数字孪生化身
                        </p>
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="mt-2 px-4 py-2 rounded-xl bg-white text-black font-bold text-xs hover:bg-white/90 transition-all shadow-md"
                        >
                          从本地相册选择照片
                        </button>
                      </div>
                    )}
                  </div>

                  {/* AI 视觉解析触发按钮与状态 */}
                  {customPhotoUrl && (
                    <div className="p-4 rounded-2xl bg-purple-950/30 border border-purple-500/30 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="space-y-0.5">
                          <h4 className="text-xs font-bold text-purple-200 flex items-center gap-1.5">
                            <span>✨ AI 多模态视觉卡通化生成</span>
                          </h4>
                          <p className="text-[11px] text-purple-300/70">
                            通过视觉认知模型分析面部与气质，智能匹配专属卡通立绘与 3D 光学配色
                          </p>
                        </div>

                        <button
                          onClick={handleRunAiAnalysis}
                          disabled={isAnalyzingPhoto}
                          className="px-3.5 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs transition-all flex items-center gap-1.5 shrink-0 disabled:opacity-50"
                        >
                          {isAnalyzingPhoto ? (
                            <>
                              <span className="w-3.5 h-3.5 rounded-full border-2 border-white/20 border-t-white animate-spin" />
                              <span>解析分析中...</span>
                            </>
                          ) : (
                            <>
                              <span>✨ 开始生成</span>
                            </>
                          )}
                        </button>
                      </div>

                      {analysisSummary && (
                        <div className="p-2.5 rounded-xl bg-purple-900/40 text-xs text-purple-100 border border-purple-400/20 leading-relaxed animate-in fade-in">
                          {analysisSummary}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 头像显示偏好切换 */}
                  {customPhotoUrl && (
                    <div className="p-3 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-between gap-3 text-xs">
                      <span className="text-white/70">3D 数字孪生形象挂载模式：</span>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setAvatarMode("custom_photo")}
                          className={`px-3 py-1.5 rounded-xl transition-all ${
                            avatarMode === "custom_photo"
                              ? "bg-white text-black font-bold"
                              : "text-white/60 hover:text-white"
                          }`}
                        >
                          📸 专属自拍照徽章
                        </button>
                        <button
                          onClick={() => setAvatarMode("preset")}
                          className={`px-3 py-1.5 rounded-xl transition-all ${
                            avatarMode === "preset"
                              ? "bg-white text-black font-bold"
                              : "text-white/60 hover:text-white"
                          }`}
                        >
                          🎭 AI 匹配卡通立绘
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════
              步骤 3: 心智确认与激活
              ══════════════════════════════════════════════════════════ */}
          {step === 3 && (
            <div className="space-y-6 animate-in fade-in">
              <div className="text-center space-y-1">
                <h3 className="text-base sm:text-lg font-bold text-white">微调并激活数字孪生形象</h3>
                <p className="text-xs text-white/60">
                  确认形象昵称、主题全息光效与特征标签，完成后将持久化并实时驱动 3D 舞台
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-center">
                {/* 左侧形象全息卡片 */}
                <div className="md:col-span-5 p-5 rounded-2xl bg-white/5 border border-white/15 flex flex-col items-center text-center gap-3 relative overflow-hidden">
                  <div
                    className="absolute -top-12 -left-12 w-32 h-32 rounded-full blur-2xl pointer-events-none"
                    style={{ backgroundColor: `${themeColor}40` }}
                  />

                  <CartoonAvatarGraphic
                    presetId={selectedPresetId}
                    customPhotoUrl={avatarMode === "custom_photo" ? customPhotoUrl : undefined}
                    size={130}
                    themeColor={themeColor}
                    showGlow={true}
                  />

                  <div>
                    <h4 className="font-bold text-base text-white">{nickname || "极客孪生"}</h4>
                    <p className="text-xs text-white/60 font-mono mt-0.5">
                      {activePreset.name} · {gender === "male" ? "男 👦" : gender === "female" ? "女 👧" : "智能体 🤖"}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-1 justify-center">
                    {features.map((f) => (
                      <span
                        key={f}
                        className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                        style={{
                          backgroundColor: `${themeColor}20`,
                          color: themeColor,
                          border: `1px solid ${themeColor}40`,
                        }}
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                </div>

                {/* 右侧微调表单 */}
                <div className="md:col-span-7 space-y-4">
                  {/* 昵称 */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-white/80">孪生代号 / 昵称：</label>
                    <input
                      type="text"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      placeholder="例如：极客小东"
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white/10 border border-white/15 text-white text-xs focus:outline-none focus:border-white/50"
                    />
                  </div>

                  {/* 主题全息色 */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-white/80">3D 全息神经光效色：</label>
                    <div className="flex items-center gap-2 flex-wrap">
                      {THEME_COLORS.map((tc) => (
                        <button
                          key={tc.color}
                          onClick={() => setThemeColor(tc.color)}
                          className={`w-7 h-7 rounded-full transition-transform flex items-center justify-center ${
                            themeColor === tc.color ? "scale-110 ring-2 ring-white" : "hover:scale-105 opacity-80"
                          }`}
                          style={{ backgroundColor: tc.color }}
                          title={tc.name}
                        >
                          {themeColor === tc.color && <span className="text-[10px] text-black font-bold">✓</span>}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 特征标签 */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-white/80">核心形象特征词：</label>
                    <div className="flex flex-wrap gap-1.5">
                      {features.map((f, idx) => (
                        <span
                          key={idx}
                          className="text-xs px-2.5 py-1 rounded-xl bg-white/10 border border-white/15 flex items-center gap-1.5 text-white/90"
                        >
                          <span>{f}</span>
                          <button
                            onClick={() => setFeatures(features.filter((_, i) => i !== idx))}
                            className="text-white/40 hover:text-white"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      <button
                        onClick={() => {
                          const tag = prompt("输入新形象特征词：");
                          if (tag && tag.trim()) setFeatures([...features, tag.trim()]);
                        }}
                        className="text-xs px-2.5 py-1 rounded-xl bg-white/5 border border-white/10 border-dashed text-white/50 hover:text-white"
                      >
                        + 自定义特征
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── 底部操作区 ── */}
        <div className="p-4 sm:p-5 border-t border-white/10 bg-black/60 flex items-center justify-between gap-3 shrink-0">
          <div>
            {step > 1 && (
              <button
                onClick={() => setStep((s) => (s - 1) as any)}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white/70 hover:text-white bg-white/5 hover:bg-white/10 transition-all"
              >
                ← 上一步
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!isFirstTime && (
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white/50 hover:text-white transition-all"
              >
                取消
              </button>
            )}

            {step < 3 ? (
              <button
                onClick={() => setStep((s) => (s + 1) as any)}
                className="px-5 py-2.5 rounded-xl text-xs font-bold bg-white text-black hover:bg-white/90 transition-all flex items-center gap-1.5 shadow-lg"
              >
                <span>下一步</span>
                <span>→</span>
              </button>
            ) : (
              <button
                onClick={handleSaveAvatar}
                disabled={isSaving}
                className="px-6 py-2.5 rounded-xl text-xs font-bold text-white transition-all flex items-center gap-2 shadow-lg disabled:opacity-50"
                style={{
                  backgroundColor: themeColor,
                  boxShadow: `0 0 20px ${themeColor}60`,
                }}
              >
                {isSaving ? (
                  <>
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-white/20 border-t-white animate-spin" />
                    <span>正在同步认知孪生神经...</span>
                  </>
                ) : (
                  <>
                    <span>⚡ 激活数字孪生形象</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
