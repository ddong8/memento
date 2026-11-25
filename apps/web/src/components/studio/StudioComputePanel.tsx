"use client";

import { useCallback, useEffect, useState } from "react";
import {
  studioApi,
  type ColabSessionItem,
  type StudioColabAccount,
  type StudioComputeConfig,
  type StudioComputeState,
} from "@/lib/studio-api";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Chip, Glass } from "@/components/aurora/primitives";

interface Props {
  compute: StudioComputeState | null;
  account: StudioColabAccount | null;
  onComputeChange: (next: StudioComputeState) => void;
  onAccountChange: (next: StudioColabAccount) => void;
  onNotify: (ok: boolean, text: string) => void;
}

const fieldStyle = {
  width: "100%",
  maxWidth: "100%",
  minWidth: 0,
  background: "var(--aurora-chip)",
  border: "1px solid var(--aurora-border)",
  borderRadius: 10,
  padding: "9px 10px",
  color: "var(--aurora-fg1)",
  fontSize: 13,
  outline: "none",
} as const;

const MODEL_PRESETS = [
  { id: "h3_bf16,h3_ref2va_bf16,seedvr2_fp16", label: "MiniMax-H3 BF16 高精 + ref2va BF16 + Qwen3-VL INT8 + SeedVR2 FP16（80G/96G 旗舰推荐）" },
  { id: "h3_bf16,h3_ref2va_bf16", label: "仅 MiniMax-H3 BF16 高精 + ref2va BF16（原生 768P 先确认剧情）" },
  { id: "h3,h3_ref2va,seedvr2_fp16", label: "MiniMax-H3 INT8 速出 + ref2va 声纹锁 + SeedVR2 7B FP16（省时/双路）" },
  { id: "h3,h3_ref2va", label: "仅 MiniMax-H3 INT8 + 声纹锁（轻量速出剧情版）" },
  { id: "seedvr2_fp16", label: "仅 SeedVR2 7B FP16 最高画质超分（~14G，约 1.5 分钟速启）" },
  { id: "h3,seedvr2", label: "MiniMax-H3 INT8 + SeedVR2 7B INT8（24G L4 均衡版）" },
  { id: "seedvr2", label: "仅 SeedVR2 7B INT8 超分（~8.2G，速启）" },
];

const GPU_PRESETS = [
  { id: "G4,A100,H100", label: "大显存优先 (G4 96G -> A100 -> H100)" },
  { id: "G4", label: "仅 G4 (96GB Blackwell 双路推荐)" },
  { id: "A100,G4,H100", label: "A100 优先 (A100 -> G4 -> H100)" },
  { id: "L4,T4", label: "轻量调试 (L4 22G -> T4)" },
];

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

function shortGpuName(raw: string): string {
  if (!raw) return "--";
  if (/RTX\s*PRO\s*6000|Blackwell/i.test(raw)) return "G4 (RTX PRO 6000)";
  const m = raw.match(/(A100|H100|G4|L4|T4|V100|4090|A6000)/i);
  return m ? m[1].toUpperCase() : raw.slice(0, 22);
}

const DEFAULT_CONFIG: StudioComputeConfig = {
  compute_provider: "auto",
  compute_colab_gpus: "G4,A100,H100",
  compute_colab_high_mem: true,
  compute_colab_session: "filmkit",
  compute_models: "h3_bf16,h3_ref2va_bf16,seedvr2_fp16",
  compute_auto_shutdown_min: 15,
  compute_dual_worker: true,
  compute_gdrive_cache: true,
  compute_hourly_cu_rate: 12,
  h3_precision: "bf16",
  h3_resolution: "768p",
  h3_steps: 24,
};

export function StudioComputePanel({
  compute,
  account,
  onComputeChange,
  onAccountChange,
  onNotify,
}: Props) {
  const [config, setConfig] = useState<StudioComputeConfig>(DEFAULT_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [copiedUrl, setCopiedUrl] = useState("");
  const [showBind, setShowBind] = useState(false);
  const [bindComfyUrl, setBindComfyUrl] = useState("");
  const [bindCtrlUrl, setBindCtrlUrl] = useState("");
  const [bindCtrlToken, setBindCtrlToken] = useState("");

  const fetchAccount = useCallback(
    async (refresh = false) => {
      if (refresh) setBusy("refresh");
      try {
        const res = await studioApi.computeAccount(refresh);
        onAccountChange(res.account);
        onComputeChange(res.compute);
        if (res.config && (!configLoaded || refresh)) {
          setConfig(res.config);
          setConfigLoaded(true);
        }
        if (refresh) {
          onNotify(true, "已从 Google Colab 实时同步最新额度与实例状态");
        }
      } catch (e) {
        if (refresh) onNotify(false, `刷新算力状态失败：${(e as Error).message}`);
      } finally {
        if (refresh) setBusy("");
      }
    },
    [configLoaded, onAccountChange, onComputeChange, onNotify]
  );

  useEffect(() => {
    void fetchAccount(false);
  }, [fetchAccount]);

  // 面板打开时定期刷新运行态（运行中/启动中 3 秒一次，空闲 15 秒一次）
  useEffect(() => {
    const active = compute && compute.status !== "offline" && compute.status !== "error";
    const interval = active ? 3000 : 15000;
    const timer = setInterval(async () => {
      try {
        const res = await studioApi.computeStatus();
        onComputeChange(res.compute);
      } catch {
        // ignore transient errors
      }
    }, interval);
    return () => clearInterval(timer);
  }, [compute?.status, onComputeChange]);

  const st = compute?.status || "offline";
  const isReady = st === "ready";
  const isTransitional = st === "connecting" || st === "awaiting_gpu" || st === "booting" || st === "stopping";
  const vramTotal = compute?.vram_total_gb || 0;
  const vramFree = compute?.vram_free_gb || 0;
  const vramUsed = Math.max(0, vramTotal - vramFree);
  const vramPct = vramTotal > 0 ? Math.min(100, Math.round((vramUsed / vramTotal) * 100)) : 0;

  const activeCount = account?.active_assignments ?? 0;
  const burnRate = account?.usage_rate_per_hr ?? 0;
  const hasOrphanCloudBilling = activeCount > 0 && st === "offline";

  const statusMeta: Record<string, { label: string; tone: "neutral" | "accent" | "success" | "warn" | "danger" }> = {
    offline: { label: "已关闭 · 0 计费", tone: "neutral" },
    connecting: { label: "申请 GPU 中", tone: "warn" },
    awaiting_gpu: { label: "等待切换 GPU", tone: "warn" },
    booting: { label: "装机拉模型中", tone: "accent" },
    ready: { label: "运行就绪", tone: "success" },
    stopping: { label: "释放核实中", tone: "warn" },
    error: { label: "启动异常", tone: "danger" },
  };
  const stBadge = hasOrphanCloudBilling
    ? { label: `云端计费中 (${activeCount} 台未绑定)`, tone: "warn" as const }
    : statusMeta[st] || statusMeta.offline;

  const flatPrimaryBtnStyle = {
    background: "var(--aurora-accent)",
    backgroundImage: "none",
    color: "#fff",
    border: "1px solid transparent",
  } as const;
  const flatDangerBtnStyle = {
    background: "var(--aurora-danger)",
    backgroundImage: "none",
    color: "#fff",
    border: "1px solid transparent",
  } as const;

  const handleSaveConfig = async () => {
    setBusy("save");
    try {
      await studioApi.updateSettings({
        compute_provider: config.compute_provider,
        compute_colab_gpus: config.compute_colab_gpus.trim() || "G4,A100,H100",
        compute_colab_high_mem: config.compute_colab_high_mem,
        compute_colab_session: config.compute_colab_session.trim() || "filmkit",
        compute_models: config.compute_models,
        compute_auto_shutdown_min: Math.max(0, Number(config.compute_auto_shutdown_min) || 0),
        compute_dual_worker: config.compute_dual_worker,
        compute_gdrive_cache: config.compute_gdrive_cache,
        h3_precision: config.h3_precision || "bf16",
        h3_resolution: config.h3_resolution || "768p",
        h3_steps: Math.max(12, Math.min(30, Number(config.h3_steps) || 24)),
      });
      onNotify(true, "算力默认配置已保存");
    } catch (e) {
      onNotify(false, `保存算力配置失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleStart = async () => {
    setBusy("start");
    try {
      await studioApi.updateSettings({
        compute_provider: config.compute_provider,
        compute_colab_gpus: config.compute_colab_gpus.trim() || "G4,A100,H100",
        compute_colab_high_mem: config.compute_colab_high_mem,
        compute_models: config.compute_models,
        compute_auto_shutdown_min: Math.max(0, Number(config.compute_auto_shutdown_min) || 0),
        compute_dual_worker: config.compute_dual_worker,
        compute_gdrive_cache: config.compute_gdrive_cache,
        h3_precision: config.h3_precision || "bf16",
        h3_resolution: config.h3_resolution || "768p",
        h3_steps: Math.max(12, Math.min(30, Number(config.h3_steps) || 24)),
      });
      const res = await studioApi.computeStart(config.compute_models, config.compute_colab_gpus);
      onComputeChange(res.compute);
      onNotify(true, `已按顺序 (${config.compute_colab_gpus}) 触发 Colab 云算力启动`);
    } catch (e) {
      onNotify(false, `启动算力失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleStop = async () => {
    setBusy("stop");
    try {
      const res = await studioApi.computeStop();
      onComputeChange(res.compute);
      await fetchAccount(true);
      if (res.compute.error) {
        onNotify(false, res.compute.error);
      } else {
        onNotify(true, "已释放 Colab 云算力并核实停止计费");
      }
    } catch (e) {
      onNotify(false, `释放算力失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleExtend = async () => {
    setBusy("extend");
    try {
      const res = await studioApi.computeExtend(15);
      onComputeChange(res.compute);
      onNotify(true, "已顺延闲置自动关机时间 15 分钟");
    } catch (e) {
      onNotify(false, `顺延失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleStopCloudSession = async (sess: ColabSessionItem) => {
    const key = `stop-sess-${sess.endpoint || sess.name}`;
    setBusy(key);
    try {
      const res = await studioApi.computeStopSession({ name: sess.name, endpoint: sess.endpoint });
      onComputeChange(res.compute);
      onAccountChange(res.account);
      if (res.ok) {
        onNotify(true, `已核实释放云端实例 ${sess.name || sess.endpoint}`);
      } else {
        onNotify(false, `实例 ${sess.name || sess.endpoint} 未确认释放，请再次刷新或前往 Colab 检查`);
      }
    } catch (e) {
      onNotify(false, `释放实例失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleBind = async () => {
    if (!bindComfyUrl.trim()) return;
    setBusy("bind");
    try {
      const res = await studioApi.computeBind({
        comfy_url: bindComfyUrl.trim(),
        control_url: bindCtrlUrl.trim(),
        control_token: bindCtrlToken.trim(),
      });
      onComputeChange(res.compute);
      setShowBind(false);
      onNotify(true, "已手动绑定外部 ComfyUI 隧道并接入监控");
    } catch (e) {
      onNotify(false, `绑定隧道失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const copyText = (txt: string) => {
    navigator.clipboard?.writeText(txt).then(() => {
      setCopiedUrl(txt);
      setTimeout(() => setCopiedUrl(""), 1800);
    });
  };

  return (
    <div className="space-y-4 min-w-0 max-w-full overflow-x-hidden">
      {/* 1. 顶部实时额度与状态总览（4 卡） */}
      <Glass padding="14px 16px" radius={16} className="min-w-0 max-w-full overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3" style={{ borderBottom: "1px solid var(--aurora-border)" }}>
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <Icon name="server" size={16} style={{ color: "var(--aurora-accent)" }} />
            <span className="text-sm font-semibold" style={{ color: "var(--aurora-fg1)" }}>
              Colab Pro 算力与额度控制台
            </span>
            <Chip tone={stBadge.tone}>{stBadge.label}</Chip>
            {account && (
              <Chip tone={account.cli_authorized ? "success" : "warn"}>
                {account.cli_authorized ? "官方 CLI 已授权" : "CLI 未授权"}
              </Chip>
            )}
          </div>
          <div className="flex items-center gap-2">
            {account?.checked_at ? (
              <span className="text-[11px] tabular-nums" style={{ color: "var(--aurora-fg4)" }}>
                同步于 {new Date(account.checked_at * 1000).toLocaleTimeString()}
              </span>
            ) : null}
            <Btn
              size="sm"
              variant="ghost"
              icon="refresh"
              onClick={() => void fetchAccount(true)}
              disabled={busy === "refresh"}
            >
              {busy === "refresh" ? "同步中…" : "刷新实时额度"}
            </Btn>
          </div>
        </div>

        {/* 异常提醒：Colab 服务端有计费实例但演播台未托管 */}
        {hasOrphanCloudBilling && (
          <div
            className="mb-3 rounded-xl px-3.5 py-2.5 text-xs flex flex-wrap items-center justify-between gap-2"
            style={{
              background: "var(--aurora-warn-soft)",
              border: "1px solid var(--aurora-warn)",
              color: "var(--aurora-fg1)",
            }}
          >
            <span className="font-medium">
              检测到 Colab 服务端仍有 {activeCount} 台计费中的云端实例（当前消耗 {burnRate.toFixed(2)} CU/时），可在下方实例列表一键释放停表。
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
          <div
            className="rounded-xl p-2.5 sm:p-3 min-w-0"
            style={{ background: "var(--aurora-chip)", border: "1px solid var(--aurora-border)" }}
          >
            <div className="text-[11px]" style={{ color: "var(--aurora-fg3)" }}>
              Colab 计算单元余额
            </div>
            <div className="mt-1 text-base sm:text-lg font-semibold tabular-nums truncate" style={{ color: "var(--aurora-fg1)" }}>
              {account?.balance_cu != null ? `${account.balance_cu.toFixed(2)} CU` : "--"}
            </div>
            <div className="mt-0.5 text-[11px] tabular-nums truncate" style={{ color: burnRate > 0 ? "var(--aurora-warn)" : "var(--aurora-success)" }}>
              速率：{account?.usage_rate_per_hr != null ? `${burnRate.toFixed(2)} CU/时` : "待同步"}
            </div>
          </div>

          <div
            className="rounded-xl p-2.5 sm:p-3 min-w-0"
            style={{ background: "var(--aurora-chip)", border: "1px solid var(--aurora-border)" }}
          >
            <div className="text-[11px]" style={{ color: "var(--aurora-fg3)" }}>
              云端计费实例数
            </div>
            <div className="mt-1 text-base sm:text-lg font-semibold tabular-nums" style={{ color: activeCount > 0 ? "var(--aurora-accent)" : "var(--aurora-success)" }}>
              {account ? `${activeCount} 台` : "--"}
            </div>
            <div className="mt-0.5 text-[11px] truncate" style={{ color: "var(--aurora-fg4)" }}>
              {activeCount === 0 ? "0 计费 · 安全待机" : "正在占用计算单元"}
            </div>
          </div>

          <div
            className="rounded-xl p-2.5 sm:p-3 min-w-0"
            style={{ background: "var(--aurora-chip)", border: "1px solid var(--aurora-border)" }}
          >
            <div className="text-[11px]" style={{ color: "var(--aurora-fg3)" }}>
              当前绑定 GPU 与显存
            </div>
            <div className="mt-1 text-sm font-semibold truncate" style={{ color: "var(--aurora-fg1)" }}>
              {compute?.gpu ? shortGpuName(compute.gpu) : "未分配"}
            </div>
            <div className="mt-0.5 text-[11px] tabular-nums truncate" style={{ color: "var(--aurora-fg4)" }}>
              {vramTotal > 0 ? `空闲 ${vramFree.toFixed(1)} / ${vramTotal.toFixed(1)} GB` : "启动后自动分配大显存"}
            </div>
          </div>

          <div
            className="rounded-xl p-2.5 sm:p-3 min-w-0"
            style={{ background: "var(--aurora-chip)", border: "1px solid var(--aurora-border)" }}
          >
            <div className="text-[11px]" style={{ color: "var(--aurora-fg3)" }}>
              本次时长 / 自动关机
            </div>
            <div className="mt-1 text-sm font-semibold tabular-nums truncate" style={{ color: "var(--aurora-fg1)" }}>
              {compute?.uptime_sec ? fmtDuration(compute.uptime_sec) : "0s"}
            </div>
            <div className="mt-0.5 text-[11px] truncate" style={{ color: "var(--aurora-fg4)" }}>
              {isReady
                ? compute?.busy
                  ? "出片任务执行中"
                  : compute?.auto_shutdown_in_sec != null
                  ? `${fmtDuration(compute.auto_shutdown_in_sec)} 后自动释放`
                  : "自动关机未开启"
                : `闲置 ${config.compute_auto_shutdown_min || 0} 分钟自动释放`}
            </div>
          </div>
        </div>

        {/* 显存与隧道条（运行中展示） */}
        {isReady && compute && (
          <div
            className="mt-3 rounded-xl p-3 space-y-2.5"
            style={{ background: "var(--aurora-chip)", border: "1px solid var(--aurora-border)" }}
          >
            {vramTotal > 0 && (
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-1.5">
                  <span className="font-medium truncate" style={{ color: "var(--aurora-fg1)" }}>
                    {compute.gpu}
                  </span>
                  <span className="tabular-nums" style={{ color: "var(--aurora-fg3)" }}>
                    显存已用 {vramUsed.toFixed(1)} / {vramTotal.toFixed(1)} GB · 利用率 {compute.gpu_util ?? 0}%
                    {compute.disk_free_gb ? ` · 磁盘余 ${compute.disk_free_gb.toFixed(0)} GB` : ""}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--aurora-border)" }}>
                  <div
                    className="h-full rounded-full transition-[width] duration-500"
                    style={{
                      width: `${Math.max(2, vramPct)}%`,
                      background: vramPct >= 90 ? "var(--aurora-danger)" : "var(--aurora-success)",
                    }}
                  />
                </div>
              </div>
            )}

            {compute.comfy_url && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span style={{ color: "var(--aurora-fg3)" }}>ComfyUI 隧道：</span>
                <code className="min-w-0 flex-1 break-all text-[12px]" style={{ color: "var(--aurora-accent)" }}>
                  {compute.comfy_url}
                </code>
                <Btn size="sm" variant="ghost" icon={copiedUrl === compute.comfy_url ? "check" : "copy"} onClick={() => copyText(compute.comfy_url)}>
                  {copiedUrl === compute.comfy_url ? "已复制" : "复制"}
                </Btn>
              </div>
            )}
          </div>
        )}
      </Glass>

      {/* 2. Google Colab 服务端真实活跃实例列表 */}
      <Glass padding="16px" radius={16}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <Icon name="activity" size={15} style={{ color: "var(--aurora-accent)" }} />
            <span className="text-xs font-semibold" style={{ color: "var(--aurora-fg1)" }}>
              Colab 服务端实时运行实例
            </span>
          </div>
          <span className="text-[11px]" style={{ color: "var(--aurora-fg4)" }}>
            直接查询 Google Colab 后端，含外部脚本启动的实例
          </span>
        </div>

        {account?.error && !account.cli_authorized ? (
          <div
            className="rounded-xl px-3.5 py-2.5 text-xs"
            style={{ background: "var(--aurora-warn-soft)", color: "var(--aurora-fg1)" }}
          >
            {account.error}
          </div>
        ) : account && account.sessions.length > 0 ? (
          <div className="space-y-2">
            {account.sessions.map((s) => {
              const stopKey = `stop-sess-${s.endpoint || s.name}`;
              return (
                <div
                  key={s.endpoint || s.name || s.raw}
                  className="flex flex-col gap-2.5 rounded-xl px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between min-w-0"
                  style={{ background: "var(--aurora-chip)", border: "1px solid var(--aurora-border)" }}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-semibold" style={{ color: "var(--aurora-fg1)" }}>
                      <span className="truncate">{s.name || "外部/孤立实例"}</span>
                      {s.hardware && <Chip tone="accent">{s.hardware}</Chip>}
                      {s.shape && <Chip tone="neutral">{s.shape}</Chip>}
                    </div>
                    <div className="text-[11px] font-mono break-all" style={{ color: "var(--aurora-fg3)" }}>
                      Endpoint: {s.endpoint || s.raw}
                    </div>
                  </div>
                  <Btn
                    size="sm"
                    variant="danger"
                    icon="close"
                    className="w-full justify-center sm:w-auto"
                    style={flatDangerBtnStyle}
                    disabled={busy === stopKey}
                    onClick={() => void handleStopCloudSession(s)}
                  >
                    {busy === stopKey ? "释放中…" : "释放停表"}
                  </Btn>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className="rounded-xl px-3.5 py-2.5 text-xs flex items-center gap-2"
            style={{ background: "var(--aurora-success-soft)", color: "var(--aurora-success)" }}
          >
            <Icon name="check" size={14} />
            <span>当前无任何计费中的 Colab 实例（0.00 CU/时），可放心关闭页面。</span>
          </div>
        )}
      </Glass>

      {/* 3. 一键启停与算力参数配置区 */}
      <Glass padding="16px" radius={16}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <Icon name="settings" size={15} style={{ color: "var(--aurora-accent)" }} />
            <span className="text-xs font-semibold" style={{ color: "var(--aurora-fg1)" }}>
              算力调度与出片模型配置
            </span>
          </div>
          <Btn size="sm" variant="ghost" icon="check" disabled={busy === "save"} onClick={handleSaveConfig}>
            {busy === "save" ? "保存中…" : "保存默认配置"}
          </Btn>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
              本次拉取模型套装
            </label>
            <select
              value={config.compute_models}
              onChange={(e) => setConfig({ ...config, compute_models: e.target.value })}
              style={fieldStyle}
            >
              {MODEL_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
              GPU 申请优先顺序（前一个无容量自动顺延下一个）
            </label>
            <input
              value={config.compute_colab_gpus}
              onChange={(e) => setConfig({ ...config, compute_colab_gpus: e.target.value })}
              placeholder="G4,A100,H100"
              style={fieldStyle}
            />
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {GPU_PRESETS.map((gp) => (
                <button
                  key={gp.id}
                  type="button"
                  onClick={() => setConfig({ ...config, compute_colab_gpus: gp.id })}
                  className="px-2 py-0.5 rounded-md text-[11px] transition-colors"
                  style={{
                    background: config.compute_colab_gpus === gp.id ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                    color: config.compute_colab_gpus === gp.id ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                    border: `1px solid ${config.compute_colab_gpus === gp.id ? "var(--aurora-accent)" : "var(--aurora-border)"}`,
                    cursor: "pointer",
                  }}
                >
                  {gp.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
              调度方式
            </label>
            <select
              value={config.compute_provider}
              onChange={(e) => setConfig({ ...config, compute_provider: e.target.value })}
              style={fieldStyle}
            >
              <option value="auto">自动（优先官方 Colab CLI，无人值守）</option>
              <option value="colab_cli">强制官方 Colab CLI（直接申请 GPU）</option>
              <option value="colab_mcp">本机 Chrome 浏览器 MCP</option>
              <option value="manual">手动固定 ComfyUI 地址</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
              队列闲置自动关机（分钟，0 表示不自动关机）
            </label>
            <input
              type="number"
              min={0}
              max={240}
              value={config.compute_auto_shutdown_min}
              onChange={(e) => setConfig({ ...config, compute_auto_shutdown_min: Number(e.target.value) })}
              style={fieldStyle}
            />
          </div>

          <div>
            <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
              MiniMax-H3 权重精度
            </label>
            <select
              value={config.h3_precision || "bf16"}
              onChange={(e) => setConfig({ ...config, h3_precision: e.target.value })}
              style={fieldStyle}
            >
              <option value="bf16">BF16 高精无量化（40G + Qwen3-VL INT8，推荐）</option>
              <option value="int8">INT8 轻量提速（21G + NVFP4，24G/双路）</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                H3 原生画质
              </label>
              <select
                value={config.h3_resolution || "768p"}
                onChange={(e) => setConfig({ ...config, h3_resolution: e.target.value })}
                style={fieldStyle}
              >
                <option value="768p">768P 原生高清（768x1344）</option>
                <option value="576p">576P 剧情速出（576x1024）</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                H3 采样步数（12~30）
              </label>
              <input
                type="number"
                min={12}
                max={30}
                value={config.h3_steps ?? 24}
                onChange={(e) => setConfig({ ...config, h3_steps: Math.max(12, Math.min(30, Number(e.target.value) || 24)) })}
                style={fieldStyle}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 mt-3 text-xs" style={{ color: "var(--aurora-fg2)" }}>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={config.compute_dual_worker}
              onChange={(e) => setConfig({ ...config, compute_dual_worker: e.target.checked })}
            />
            <span>大显存（&gt;=75GB）自动双路并发（2x H3 与 2x 1080P 超分）</span>
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={config.compute_gdrive_cache}
              onChange={(e) => setConfig({ ...config, compute_gdrive_cache: e.target.checked })}
            />
            <span>启用 Google Drive 权重缓存</span>
          </label>
        </div>

        {/* 主操作按钮栏（手机端按钮自动通栏易点按） */}
        <div
          className="mt-4 pt-3.5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
          style={{ borderTop: "1px solid var(--aurora-border)" }}
        >
          {!isReady && !isTransitional && (
            <Btn icon="zap" className="w-full justify-center sm:w-auto" style={flatPrimaryBtnStyle} disabled={busy !== ""} onClick={handleStart}>
              {busy === "start" ? "正在申请启动…" : "一键启动云端 GPU"}
            </Btn>
          )}
          {(isReady || isTransitional) && st !== "stopping" && (
            <Btn variant="danger" icon="close" className="w-full justify-center sm:w-auto" style={flatDangerBtnStyle} disabled={busy !== ""} onClick={handleStop}>
              {busy === "stop" ? "正在释放核实…" : "立即关闭并释放 GPU"}
            </Btn>
          )}
          {isReady && (
            <Btn variant="ghost" icon="clock" className="w-full justify-center sm:w-auto" disabled={busy !== ""} onClick={handleExtend}>
              顺延 15 分钟
            </Btn>
          )}
          {!isReady && !isTransitional && (
            <Btn variant="ghost" icon="link" className="w-full justify-center sm:w-auto" onClick={() => setShowBind((v) => !v)}>
              {showBind ? "收起手动绑定" : "手动绑定外部隧道"}
            </Btn>
          )}
        </div>

        {showBind && !isReady && (
          <div className="mt-3 pt-3 space-y-2" style={{ borderTop: "1px solid var(--aurora-border)" }}>
            <input
              value={bindComfyUrl}
              onChange={(e) => setBindComfyUrl(e.target.value)}
              placeholder="ComfyUI 地址（如 https://xxxx.trycloudflare.com）"
              style={fieldStyle}
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                value={bindCtrlUrl}
                onChange={(e) => setBindCtrlUrl(e.target.value)}
                placeholder="控制隧道 URL（可选，支持远程关机）"
                style={fieldStyle}
              />
              <input
                type="password"
                value={bindCtrlToken}
                onChange={(e) => setBindCtrlToken(e.target.value)}
                placeholder="控制 Token（可选）"
                style={fieldStyle}
              />
            </div>
            <Btn size="sm" icon="check" className="w-full justify-center sm:w-auto" style={flatPrimaryBtnStyle} disabled={busy !== "" || !bindComfyUrl.trim()} onClick={handleBind}>
              确认绑定并接管监控
            </Btn>
          </div>
        )}

        {compute?.error && (
          <div
            className="mt-3 rounded-xl px-3.5 py-2.5 text-xs"
            style={{
              background: "var(--aurora-danger-soft)",
              border: "1px solid var(--aurora-danger)",
              color: "var(--aurora-danger)",
            }}
          >
            {compute.error}
          </div>
        )}
      </Glass>

      {/* 4. 实时调度与装机日志 */}
      <Glass padding="14px 16px" radius={16}>
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <Icon name="terminal" size={14} style={{ color: "var(--aurora-fg3)" }} />
            <span className="text-xs font-semibold" style={{ color: "var(--aurora-fg2)" }}>
              算力调度与释放日志
            </span>
          </div>
          <span className="text-[11px]" style={{ color: "var(--aurora-fg4)" }}>
            {compute?.stage || "空闲待机"}
          </span>
        </div>
        <div
          className="max-h-56 overflow-y-auto rounded-xl p-3 font-mono text-[11px] leading-relaxed"
          style={{ background: "var(--aurora-chip)", border: "1px solid var(--aurora-border)", color: "var(--aurora-fg2)" }}
        >
          {compute?.logs && compute.logs.length > 0 ? (
            compute.logs.slice(-40).map((entry, idx) => (
              <div
                key={`${entry.ts}-${idx}`}
                className="break-all"
                style={{
                  color:
                    entry.level === "error"
                      ? "var(--aurora-danger)"
                      : entry.level === "warn"
                      ? "var(--aurora-warn)"
                      : "var(--aurora-fg2)",
                }}
              >
                <span className="mr-2 tabular-nums" style={{ color: "var(--aurora-fg4)" }}>
                  {new Date(entry.ts * 1000).toLocaleTimeString()}
                </span>
                <span>{entry.message}</span>
              </div>
            ))
          ) : (
            <div style={{ color: "var(--aurora-fg4)" }}>
              暂无调度日志。需要生成 H3 原生音画或 1080P 超分时，点击上方「一键启动云端 GPU」即可无人值守拉起算力。
            </div>
          )}
        </div>
      </Glass>
    </div>
  );
}
