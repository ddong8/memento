"use client";

import { useEffect, useState } from "react";
import {
  api,
  type LLMProfileResponse,
  type LLMSettingsData,
  type LLMPreset,
  type LLMTestResponse,
} from "@/lib/api-client";
import { Glass, Btn, SectionLabel } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import { AgentQuotaCard } from "@/components/quota/AgentQuotaCard";
import { AgentRunSettingsCard } from "@/components/profile/AgentRunSettingsCard";

export function LLMSettingsView() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Settings data
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState("custom");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [maskedKey, setMaskedKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [primaryModel, setPrimaryModel] = useState("");
  const [backgroundModel, setBackgroundModel] = useState("");
  const [fallbackModel, setFallbackModel] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(4096);

  // Presets & system info
  const [presets, setPresets] = useState<LLMPreset[]>([]);
  const [systemDefault, setSystemDefault] = useState<{
    base_url: string;
    model: string;
    provider: string;
  } | null>(null);

  // Connectivity Test State
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LLMTestResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      const res = (await api.getLLMSettings()) as any;
      const s = res?.settings || res || {};
      setEnabled(Boolean(s.custom_enabled));
      setProvider(s.provider || "custom");
      setBaseUrl(s.base_url || "");
      setMaskedKey(s.api_key_masked || "");
      setApiKey(s.api_key_masked ? s.api_key_masked : "");
      setPrimaryModel(s.primary_model || s.model || "");
      setBackgroundModel(s.background_model || "");
      setFallbackModel(s.fallback_model || "");
      setTemperature(s.temperature ?? 0.7);
      setMaxTokens(s.max_tokens ?? 4096);

      const presetList: LLMPreset[] = res.presets || [];
      setPresets(presetList);
      setSystemDefault(res.system_default || res.system_defaults || null);

      // 如果未配置 Base URL 且有预设，自动推荐第一个预设
      if (!s.base_url && presetList.length > 0) {
        const first = presetList[0];
        setProvider(first.id);
        setBaseUrl(first.base_url);
        setPrimaryModel(first.default_model);
        setBackgroundModel(first.default_background_model);
      }
    } catch (e) {
      console.error("Failed to load LLM settings:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSelectPreset = (p: LLMPreset) => {
    setProvider(p.id);
    if (p.base_url) setBaseUrl(p.base_url);
    if (p.default_model) setPrimaryModel(p.default_model);
    if (p.default_background_model) setBackgroundModel(p.default_background_model);
    // Clear test results on preset change
    setTestResult(null);
    setTestError(null);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const res = (await api.updateLLMSettings({
        custom_enabled: enabled,
        provider,
        base_url: baseUrl,
        api_key: apiKey,
        primary_model: primaryModel,
        background_model: backgroundModel,
        fallback_model: fallbackModel,
        temperature,
        max_tokens: maxTokens,
      })) as any;
      const savedSettings = res.settings || res;
      setMaskedKey(savedSettings.api_key_masked || "");
      setApiKey(savedSettings.api_key_masked || "");
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`保存失败: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (testing) return;
    try {
      setTesting(true);
      setTestResult(null);
      setTestError(null);

      const targetBase = baseUrl.trim();
      const targetModel = primaryModel.trim();

      if (!targetBase && !systemDefault?.base_url) {
        setTestError("请先填写 API 接口端点 (Base URL) 或点击上方服务商预设卡片");
        return;
      }

      const res = (await api.testLLMConnection({
        provider,
        base_url: targetBase,
        api_key: apiKey.trim(),
        primary_model: targetModel,
      })) as any;

      const isSuccess = Boolean(res.success ?? res.ok);
      setTestResult({
        ...res,
        success: isSuccess,
      });
      if (!isSuccess) {
        setTestError(res.error || "连接测试未通过，请检查密钥与网络端点");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setTestError(msg || "网络请求失败，请检查 Base URL 或网络连接");
    } finally {
      setTesting(false);
    }
  };

  const currentPreset = presets.find((p) => p.id === provider);

  if (loading) {
    return (
      <div className="py-20 text-center text-xs text-[var(--aurora-fg4)]">
        正在获取个人大模型配置...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Banner & Main Toggle Card */}
      <Glass className="p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 16,
                background: enabled
                  ? "linear-gradient(135deg, #8B5CF6 0%, #3B82F6 100%)"
                  : "var(--aurora-chip)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                boxShadow: enabled
                  ? "0 4px 16px -2px rgba(139,92,246,0.4)"
                  : "none",
                flexShrink: 0,
              }}
            >
              <Icon name="zap" size={24} />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-semibold text-[var(--aurora-fg1)]">
                  个人专属大模型配置 (BYOK)
                </h3>
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 9999,
                    fontWeight: 600,
                    background: enabled
                      ? "rgba(16,185,129,0.15)"
                      : "var(--aurora-chip)",
                    color: enabled ? "#10B981" : "var(--aurora-fg4)",
                    border: enabled
                      ? "1px solid rgba(16,185,129,0.3)"
                      : "1px solid var(--aurora-border)",
                  }}
                >
                  {enabled ? "● 专属大模型运行中" : "回退系统默认底座"}
                </span>
              </div>
              <p className="text-xs text-[var(--aurora-fg3)] mt-1.5 leading-relaxed max-w-xl">
                支持接入自定义 OpenAI 兼容接口（火山方舟、DeepSeek、阿里百炼、硅基流动、本地 Ollama）。开启后，对话问答、智能体调度、晨间简报与梦境复盘将优先走您的独立配置与模型配额。
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 self-end md:self-center">
            <button
              type="button"
              onClick={() => setEnabled(!enabled)}
              style={{
                width: 50,
                height: 28,
                borderRadius: 9999,
                background: enabled ? "var(--aurora-accent)" : "var(--aurora-border)",
                position: "relative",
                transition: "background .2s",
                cursor: "pointer",
                border: 0,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 3,
                  left: enabled ? 25 : 3,
                  width: 22,
                  height: 22,
                  borderRadius: 9999,
                  background: "#fff",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                  transition: "left .2s",
                }}
              />
            </button>
          </div>
        </div>
      </Glass>

      {/* Preset Providers */}
      <div>
        <div className="flex items-center justify-between mb-3 px-1">
          <SectionLabel>快捷服务商预设</SectionLabel>
          {currentPreset?.help_url && (
            <a
              href={currentPreset.help_url}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-[var(--aurora-accent)] hover:underline flex items-center gap-1"
            >
              <span>前往 {currentPreset.name} 控制台获取 API Key</span>
              <Icon name="external_link" size={12} />
            </a>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
          {presets.map((p) => {
            const isSelected = provider === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelectPreset(p)}
                className="p-3 rounded-xl text-left transition-all cursor-pointer flex flex-col justify-between"
                style={{
                  background: isSelected ? "var(--aurora-accent-soft)" : "var(--aurora-card)",
                  border: isSelected
                    ? "1px solid var(--aurora-accent)"
                    : "1px solid var(--aurora-border)",
                  boxShadow: isSelected
                    ? "0 4px 12px -2px rgba(124,58,237,0.15)"
                    : "0 1px 3px rgba(0,0,0,0.02)",
                }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-[var(--aurora-fg1)]">
                    {p.name}
                  </span>
                  {isSelected && (
                    <span className="text-[var(--aurora-accent)]">
                      <Icon name="check" size={14} />
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-[var(--aurora-fg4)] truncate">
                  默认: {p.default_model || "自定义"}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Endpoint & Key Form */}
      <Glass className="p-6 space-y-5">
        <SectionLabel>接口端点与凭证 (Credentials)</SectionLabel>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Base URL */}
          <div className="md:col-span-2">
            <label className="block text-xs font-semibold text-[var(--aurora-fg2)] mb-1.5">
              API 接口端点 (Base URL)
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="例如 https://api.deepseek.com/v1 或 http://localhost:11434/v1"
              className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-xl border focus:outline-none transition-all font-mono"
              style={{
                background: "var(--aurora-bg)",
                borderColor: "var(--aurora-border)",
                color: "var(--aurora-fg1)",
              }}
            />
            <p className="text-[11px] text-[var(--aurora-fg4)] mt-1">
              遵循 OpenAI 兼容规范的 Base URL（需包含 /v1 路径，请求时系统会自动追加 /chat/completions）。
            </p>
          </div>

          {/* API Key */}
          <div className="md:col-span-2">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-[var(--aurora-fg2)]">
                API 密钥 (API Key)
              </label>
              {maskedKey && (
                <span className="text-[11px] text-[var(--aurora-fg4)]">
                  已有安全密匙：{maskedKey}
                </span>
              )}
            </div>
            <div className="relative flex items-center">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={maskedKey ? "保持掩码不填则不更改现有密钥" : "sk-..."}
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 pr-20 rounded-xl border focus:outline-none transition-all font-mono"
                style={{
                  background: "var(--aurora-bg)",
                  borderColor: "var(--aurora-border)",
                  color: "var(--aurora-fg1)",
                }}
              />
              <div className="absolute right-2 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="p-1.5 text-[var(--aurora-fg4)] hover:text-[var(--aurora-fg2)] cursor-pointer"
                  title={showKey ? "隐藏密钥" : "显示密钥"}
                >
                  <Icon name="eye" size={14} />
                </button>
                {apiKey && (
                  <button
                    type="button"
                    onClick={() => setApiKey("")}
                    className="p-1.5 text-[var(--aurora-fg4)] hover:text-red-500 cursor-pointer"
                    title="清空"
                  >
                    <Icon name="close" size={14} />
                  </button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-[var(--aurora-fg4)] mt-1">
              本地私有化（如 Ollama）若无鉴权可填写任意字符（如 ollama）；云端密钥将脱敏保护。
            </p>
          </div>
        </div>

        {/* Model Selection */}
        <div className="pt-2 border-t border-[var(--aurora-border)] space-y-4">
          <SectionLabel>模型调度策略 (Model Routing)</SectionLabel>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Primary Model */}
            <div>
              <label className="block text-xs font-semibold text-[var(--aurora-fg2)] mb-1.5">
                主交互模型 (Primary Model)
              </label>
              <input
                type="text"
                value={primaryModel}
                onChange={(e) => setPrimaryModel(e.target.value)}
                placeholder="例如 deepseek-chat 或 glm-5.3"
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-xl border focus:outline-none transition-all font-mono"
                style={{
                  background: "var(--aurora-bg)",
                  borderColor: "var(--aurora-border)",
                  color: "var(--aurora-fg1)",
                }}
              />
              <div className="flex flex-wrap gap-1.5 mt-2">
                {currentPreset?.models?.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPrimaryModel(m)}
                    className="text-[10px] px-2 py-0.5 rounded-md border text-[var(--aurora-fg3)] hover:text-[var(--aurora-accent)] cursor-pointer transition-all"
                    style={{
                      background: primaryModel === m ? "var(--aurora-accent-soft)" : "transparent",
                      borderColor: primaryModel === m ? "var(--aurora-accent)" : "var(--aurora-border)",
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-[var(--aurora-fg4)] mt-1">
                日常即时问答、代码解释、深度推理优先使用该模型。
              </p>
            </div>

            {/* Background Model */}
            <div>
              <label className="block text-xs font-semibold text-[var(--aurora-fg2)] mb-1.5">
                后台快速模型 (Background Model)
              </label>
              <input
                type="text"
                value={backgroundModel}
                onChange={(e) => setBackgroundModel(e.target.value)}
                placeholder="例如 deepseek-v4.1-flash 或通义千问极速版"
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-xl border focus:outline-none transition-all font-mono"
                style={{
                  background: "var(--aurora-bg)",
                  borderColor: "var(--aurora-border)",
                  color: "var(--aurora-fg1)",
                }}
              />
              <p className="text-[11px] text-[var(--aurora-fg4)] mt-1">
                用于晨间简报、晚间梦境提炼、文档分类等后台批处理任务，推荐选用高并发、低延迟的轻量模型。
              </p>
            </div>

            {/* Fallback Model */}
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-[var(--aurora-fg2)] mb-1.5">
                备用容灾模型 (Fallback Model, 可选)
              </label>
              <input
                type="text"
                value={fallbackModel}
                onChange={(e) => setFallbackModel(e.target.value)}
                placeholder="例如 deepseek-reasoner 或 qwen-max"
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-xl border focus:outline-none transition-all font-mono"
                style={{
                  background: "var(--aurora-bg)",
                  borderColor: "var(--aurora-border)",
                  color: "var(--aurora-fg1)",
                }}
              />
              <p className="text-[11px] text-[var(--aurora-fg4)] mt-1">
                当主模型发生超时或触发 429 限流时自动无缝兜底重试。
              </p>
            </div>
          </div>
        </div>

        {/* Hyperparameters */}
        <div className="pt-2 border-t border-[var(--aurora-border)] space-y-4">
          <SectionLabel>超参数微调 (Hyperparameters)</SectionLabel>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Temperature */}
            <div className="p-3.5 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-bg)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-[var(--aurora-fg2)]">
                  采样温度 (Temperature)
                </span>
                <span className="text-xs font-mono font-bold text-[var(--aurora-accent)]">
                  {temperature}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="1.5"
                step="0.05"
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
                className="w-full accent-[var(--aurora-accent)] cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-[var(--aurora-fg4)] mt-1">
                <span>0.0 (严谨精准)</span>
                <span>0.7 (通用平衡)</span>
                <span>1.5 (发散创意)</span>
              </div>
            </div>

            {/* Max Tokens */}
            <div className="p-3.5 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-bg)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-[var(--aurora-fg2)]">
                  最大回复长度 (Max Tokens)
                </span>
                <span className="text-xs font-mono font-bold text-[var(--aurora-accent)]">
                  {maxTokens}
                </span>
              </div>
              <input
                type="range"
                min="1024"
                max="16384"
                step="512"
                value={maxTokens}
                onChange={(e) => setMaxTokens(parseInt(e.target.value, 10))}
                className="w-full accent-[var(--aurora-accent)] cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-[var(--aurora-fg4)] mt-1">
                <span>1024</span>
                <span>4096 (推荐)</span>
                <span>16384</span>
              </div>
            </div>
          </div>
        </div>

        {/* Connectivity Ping Test Card */}
        <div className="pt-2 border-t border-[var(--aurora-border)]">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
            <div>
              <div className="text-xs font-semibold text-[var(--aurora-fg1)]">
                连通性实时检测与测速
              </div>
              <p className="text-[11px] text-[var(--aurora-fg3)] mt-0.5">
                直接向当前配置的目标模型发送一次轻量级请求，测试网络时延与 API 鉴权。
              </p>
            </div>
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testing}
              className="px-4 py-2 rounded-xl text-xs font-medium cursor-pointer transition-all flex items-center justify-center gap-1.5 active:scale-95"
              style={{
                background: testing ? "var(--aurora-chip)" : "var(--aurora-accent-soft)",
                color: testing ? "var(--aurora-fg4)" : "var(--aurora-accent)",
                border: "1px solid color-mix(in srgb, var(--aurora-accent) 40%, transparent)",
                cursor: testing ? "not-allowed" : "pointer",
              }}
            >
              <Icon name="activity" size={14} />
              <span>{testing ? "正在测速..." : "⚡ 测试连通性"}</span>
            </button>
          </div>

          {/* Test Result Feedback */}
          {testResult && (
            <div
              className="p-3.5 rounded-xl border text-xs leading-relaxed space-y-1.5"
              style={{
                background: testResult.success ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)",
                borderColor: testResult.success ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.25)",
              }}
            >
              <div className="flex items-center justify-between font-semibold">
                <span className={testResult.success ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                  {testResult.success ? "✅ 模型握手成功 (Connection Verified)" : "❌ 连通性测试未通过"}
                </span>
                <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-black/5 dark:bg-white/10">
                  耗时: {testResult.latency_ms} ms
                </span>
              </div>
              {testResult.reply && (
                <div className="text-[11px] text-[var(--aurora-fg2)] font-mono bg-black/5 dark:bg-white/5 p-2 rounded">
                  模型返回样例：{testResult.reply}
                </div>
              )}
            </div>
          )}

          {testError && (
            <div className="p-3 rounded-xl border border-red-500/20 bg-red-500/10 text-xs text-red-600 dark:text-red-400 mt-2">
              {testError}
            </div>
          )}
        </div>
      </Glass>

      {/* AI 原生工具订阅与配额实时监控 */}
      <AgentQuotaCard />

      {/* Claude Code 运行时的上下文压缩 */}
      <AgentRunSettingsCard />

      {/* Save Action Bar & System Defaults Reference */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2">
        {systemDefault && (
          <div className="text-[11px] text-[var(--aurora-fg4)] flex items-center gap-1.5">
            <Icon name="brain" size={13} />
            <span>系统全局兜底底座：</span>
            <code className="px-1.5 py-0.5 rounded bg-[var(--aurora-chip)] font-mono text-[10px]">
              {systemDefault.model} ({systemDefault.provider})
            </code>
          </div>
        )}

        <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
          {saveSuccess && (
            <span className="text-xs text-emerald-600 font-medium flex items-center gap-1 animate-fadeIn">
              <Icon name="check" size={14} />
              大模型配置已生效
            </span>
          )}
          <Btn
            variant="primary"
            onClick={handleSave}
            disabled={saving}
            className="w-full sm:w-auto px-6 py-2.5 rounded-xl font-medium cursor-pointer"
          >
            {saving ? "正在应用..." : "保存大模型配置"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
