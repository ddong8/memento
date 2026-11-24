"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  studioApi,
  studioAssetUrl,
  studioPublishBundleUrl,
  type EpisodePublishOverview,
  type PublishAgentInfo,
  type PublishJob,
  type PublishPlatformMeta,
  type StudioEpisode,
} from "@/lib/studio-api";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Chip, Glass } from "@/components/aurora/primitives";
import { parseDownloadProgress } from "@/lib/publish-progress";

interface Props {
  episode: StudioEpisode;
  onNotify: (ok: boolean, text: string) => void;
  onGoScreening: () => void;
}

type StatusTone = "neutral" | "accent" | "success" | "warn" | "danger";

const STATUS_META: Record<string, { label: string; tone: StatusTone }> = {
  prepared: { label: "待推送", tone: "neutral" },
  queued: { label: "排队等 Mac 领取", tone: "accent" },
  dispatched: { label: "Mac 已领取", tone: "accent" },
  downloading: { label: "拉取素材", tone: "accent" },
  uploading: { label: "上传填表中", tone: "accent" },
  awaiting_user: { label: "需本机扫码/验证", tone: "warn" },
  draft_saved: { label: "已存草稿", tone: "success" },
  published: { label: "已发布", tone: "success" },
  needs_publish_mode: { label: "该平台无草稿箱", tone: "warn" },
  failed: { label: "失败", tone: "danger" },
};

function DownloadProgress({ logs }: { logs: string[] }) {
  const p = parseDownloadProgress(logs);
  const percent = p ? p.percent : 0;
  const left = p ? (p.leftSec >= 60 ? `约剩 ${Math.floor(p.leftSec / 60)} 分 ${p.leftSec % 60} 秒` : `约剩 ${p.leftSec} 秒`) : "";
  return (
    <div className="flex flex-col gap-1.5" aria-label="成片拉取进度">
      <div className="flex items-center justify-between text-xs" style={{ color: "var(--aurora-fg2)" }}>
        <span>Mac 正在拉取成片{p ? `（${p.doneMb}/${p.totalMb} MB）` : "…"}</span>
        <span className="tabular-nums">{p ? `${percent}% · ${p.speed} MB/s · ${left}` : ""}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--aurora-chip)" }}>
        <div
          className="h-full rounded-full transition-[width] duration-700"
          style={{ width: `${Math.max(3, percent)}%`, background: "var(--aurora-accent)" }}
        />
      </div>
    </div>
  );
}

const ACTIVE_STATES = new Set(["queued", "dispatched", "downloading", "uploading", "awaiting_user"]);

const fieldStyle = {
  width: "100%",
  background: "var(--aurora-chip)",
  border: "1px solid var(--aurora-border)",
  borderRadius: 10,
  padding: "8px 10px",
  color: "var(--aurora-fg1)",
  fontSize: 13,
  outline: "none",
} as const;

// 拉模式：Mac 上的代理经 memento 主动领取任务，沿用本机 memento 客户端的登录，不用填地址和令牌。
// 已装成开机自启（launchd：com.filmkit.publisher）时不需要手动运行。
const MAC_AGENT_CMD = "cd ~/dev/filmkit && .venv/bin/python make_film.py publish-agent --pull";

interface JobDraft {
  title: string;
  description: string;
  tagsText: string;
  scheduled_at: string;
  mode: "draft" | "publish";
}

export function StudioPublishPanel({ episode, onNotify, onGoScreening }: Props) {
  const [platforms, setPlatforms] = useState<PublishPlatformMeta[]>([]);
  const [agent, setAgent] = useState<PublishAgentInfo | null>(null);
  const [overview, setOverview] = useState<EpisodePublishOverview | null>(null);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([
    "weixin_channels",
    "douyin",
    "xiaohongshu",
    "kuaishou",
    "bilibili",
  ]);
  const [defaultMode, setDefaultMode] = useState<"draft" | "publish">("draft");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [draftEdits, setDraftEdits] = useState<Record<string, JobDraft>>({});

  // 本机 Mac 分发代理内联配置
  const [showAgentConfig, setShowAgentConfig] = useState(false);
  const [agentUrl, setAgentUrl] = useState("");
  const [agentToken, setAgentToken] = useState("");
  const [agentTokenSet, setAgentTokenSet] = useState(false);
  const [dedupRemux, setDedupRemux] = useState(true);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [platRes, ovRes, stRes] = await Promise.all([
        studioApi.getPublishPlatforms(),
        studioApi.getEpisodePublish(episode.id),
        studioApi.getSettings().catch(() => null),
      ]);
      setPlatforms(platRes.platforms || []);
      setAgent(platRes.agent || null);
      setOverview(ovRes);
      setDraftEdits((prev) => {
        const next = { ...prev };
        for (const j of ovRes.jobs || []) {
          if (!next[j.id]) {
            next[j.id] = {
              title: j.title,
              description: j.description,
              tagsText: (j.tags || []).join(" "),
              scheduled_at: j.scheduled_at || "",
              mode: j.mode === "publish" ? "publish" : "draft",
            };
          }
        }
        return next;
      });
      if (stRes?.settings) {
        const s = stRes.settings;
        const savedUrl = String(s.publish_agent_url || "");
        setAgentUrl((cur) => (cur ? cur : savedUrl));
        setAgentTokenSet(Boolean(s.publish_agent_token_set));
        setDedupRemux(s.publish_dedup_remux !== false);
        if (s.publish_default_mode === "publish" || s.publish_default_mode === "draft") {
          setDefaultMode(s.publish_default_mode);
        }
      }
    } catch (e) {
      onNotify(false, `加载多平台分发状态失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [episode.id, onNotify]);

  useEffect(() => {
    setLoading(true);
    setDraftEdits({});
    void loadAll();
  }, [loadAll]);

  // 有进行中的分发任务时自动轮询本机代理状态
  useEffect(() => {
    const runningJobs = (overview?.jobs || []).filter((j) => ACTIVE_STATES.has(j.status));
    if (runningJobs.length === 0) return;
    const timer = setInterval(async () => {
      try {
        await Promise.all(runningJobs.map((j) => studioApi.syncPublishJob(j.id)));
        await loadAll();
      } catch {
        // 忽略瞬时轮询抖动
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [overview?.jobs, loadAll]);

  const platMap = useMemo(
    () => Object.fromEntries(platforms.map((p) => [p.id, p])),
    [platforms]
  );

  const preparedCount = useMemo(
    () => (overview?.jobs || []).filter((j) => j.status === "prepared").length,
    [overview?.jobs]
  );

  const togglePlatform = (pid: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(pid) ? prev.filter((x) => x !== pid) : [...prev, pid]
    );
  };

  const handleSaveAgentSettings = async () => {
    setBusy("save_agent");
    try {
      const patch: Record<string, unknown> = {
        publish_agent_url: agentUrl.trim(),
        publish_default_mode: defaultMode,
        publish_dedup_remux: dedupRemux,
      };
      if (agentToken.trim()) {
        patch.publish_agent_token = agentToken.trim();
      }
      const res = await studioApi.updateSettings(patch);
      setAgentToken("");
      setAgentTokenSet(Boolean(res.settings?.publish_agent_token_set));
      await loadAll();
      onNotify(true, "本机分发代理配置已保存并重新检测连通性");
    } catch (e) {
      onNotify(false, `保存代理配置失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleCopyCommand = async () => {
    try {
      await navigator.clipboard.writeText(MAC_AGENT_CMD);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 1800);
    } catch {
      onNotify(false, "复制失败，请手动复制下方终端命令");
    }
  };

  const handlePrepare = async (forceCopy = false) => {
    if (selectedPlatforms.length === 0) {
      onNotify(false, "请先至少勾选一个目标平台");
      return;
    }
    setBusy("prepare");
    try {
      const res = await studioApi.prepareEpisodePublish(episode.id, {
        platforms: selectedPlatforms,
        mode: defaultMode,
        force_copy: forceCopy,
      });
      setDraftEdits({});
      await loadAll();
      onNotify(
        true,
        `已生成 ${res.jobs.length} 个平台的差异化标题/封面与无损去重 MP4（独立 SHA-256），并打包可下载 ZIP`
      );
    } catch (e) {
      onNotify(false, `生成发布包失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const parseTags = (text: string) =>
    text
      .split(/[\s,，#]+/)
      .map((x) => x.trim())
      .filter(Boolean);

  const handleSaveJob = async (job: PublishJob) => {
    const ed = draftEdits[job.id];
    if (!ed) return;
    setBusy(`save:${job.id}`);
    try {
      await studioApi.patchPublishJob(job.id, {
        title: ed.title,
        description: ed.description,
        tags: parseTags(ed.tagsText),
        mode: ed.mode,
        scheduled_at: ed.scheduled_at,
      });
      await loadAll();
      onNotify(true, `已保存「${platMap[job.platform]?.name || job.platform}」差异化文案与定时设置`);
    } catch (e) {
      onNotify(false, `保存文案失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleDispatchOne = async (job: PublishJob, force = false) => {
    setBusy(`dispatch:${job.id}`);
    try {
      const ed = draftEdits[job.id];
      if (ed) {
        await studioApi.patchPublishJob(job.id, {
          title: ed.title,
          description: ed.description,
          tags: parseTags(ed.tagsText),
          mode: ed.mode,
          scheduled_at: ed.scheduled_at,
        });
      }
      await studioApi.dispatchPublishJob(job.id, force);
      await loadAll();
      onNotify(true, `已派发至本机 Mac 分发代理（${platMap[job.platform]?.name || job.platform}）`);
    } catch (e) {
      onNotify(false, `推送失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleDispatchBatch = async () => {
    setBusy("batch");
    try {
      const res = await studioApi.dispatchBatchPublish(episode.id, {});
      await loadAll();
      onNotify(
        res.errors.length === 0,
        `批量推送已提交：成功派发 ${res.dispatched.length} 个平台${
          res.errors.length > 0 ? `，跳过/失败 ${res.errors.length} 个` : ""
        }`
      );
    } catch (e) {
      onNotify(false, `批量推送失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleTriggerLogin = async (platform: string) => {
    setBusy(`login:${platform}`);
    try {
      const res = await studioApi.triggerPublishLogin(platform);
      onNotify(true, res.message || "已在本机拉起扫码登录窗口");
    } catch (e) {
      onNotify(false, `触发登录失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  if (loading && !overview) {
    return (
      <div style={{ color: "var(--aurora-fg4)", textAlign: "center", padding: "40px 0", fontSize: 13 }}>
        正在加载多平台分发工作台…
      </div>
    );
  }

  return (
    <div className="space-y-4 min-w-0">
      {/* 1. 本机 Mac 分发代理状态 + 目标平台选择 + 主操作 */}
      <Glass padding="16px" radius={16} className="space-y-4 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <Chip
              tone={agent?.online ? "success" : "warn"}
              icon={agent?.online ? "check" : "alert"}
            >
              {agent?.online
                ? `本机 Mac 分发代理在线 (${agent.chrome ? "Chrome" : "Chromium"}${agent.biliup ? " + biliup" : ""})`
                : "本机 Mac 分发代理未连接：推送的任务会排队，Mac 上线后自动执行"}
            </Chip>
            {overview?.video ? (
              <span className="text-xs truncate" style={{ color: "var(--aurora-fg3)" }}>
                成片：{overview.video.name} ({(overview.video.size_bytes / 1024 / 1024).toFixed(1)} MB)
              </span>
            ) : (
              <button
                type="button"
                onClick={onGoScreening}
                className="text-xs underline"
                style={{ color: "var(--aurora-warn)", background: "none", border: "none", cursor: "pointer" }}
              >
                本集尚未合成成片 MP4，前往合成母带
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Btn
              size="sm"
              variant="ghost"
              icon="settings"
              onClick={() => setShowAgentConfig((v) => !v)}
            >
              {showAgentConfig ? "收起代理配置" : "配置 Mac 代理"}
            </Btn>
            <Btn size="sm" variant="ghost" icon="refresh" onClick={() => void loadAll()}>
              刷新状态
            </Btn>
          </div>
        </div>

        {/* 内联 Mac 代理配置面板 */}
        {showAgentConfig && (
          <div
            className="rounded-xl p-3.5 space-y-3"
            style={{
              background: "var(--aurora-chip)",
              border: "1px solid var(--aurora-border)",
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold" style={{ color: "var(--aurora-fg1)" }}>
                本机 Mac 分发代理（拉模式：Mac 经 memento 主动领任务，账号 Cookie 只留在 Mac 上；已设开机自启）
              </div>
              <Btn size="sm" variant="ghost" icon="copy" onClick={handleCopyCommand}>
                {copiedCmd ? "已复制命令" : "复制 Mac 启动命令"}
              </Btn>
            </div>

            <div
              className="rounded-lg px-3 py-2 font-mono text-[11px] overflow-x-auto"
              style={{
                background: "var(--aurora-surface-solid)",
                border: "1px solid var(--aurora-border)",
                color: "var(--aurora-fg2)",
              }}
            >
              {MAC_AGENT_CMD}
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div>
                <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                  推模式代理地址（可选，留空则 Mac 主动来领任务）
                </label>
                <input
                  value={agentUrl}
                  onChange={(e) => setAgentUrl(e.target.value)}
                  placeholder="https://xxxx.trycloudflare.com"
                  style={fieldStyle}
                />
              </div>
              <div>
                <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                  推模式鉴权 Token（仅填了地址时需要）
                </label>
                <input
                  type="password"
                  value={agentToken}
                  onChange={(e) => setAgentToken(e.target.value)}
                  placeholder={agentTokenSet ? "已保存密钥（留空保持不变）" : "粘贴终端输出的 Bearer Token"}
                  style={fieldStyle}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <label
                className="inline-flex items-center gap-2 text-xs cursor-pointer"
                style={{ color: "var(--aurora-fg2)" }}
              >
                <input
                  type="checkbox"
                  checked={dedupRemux}
                  onChange={(e) => setDedupRemux(e.target.checked)}
                />
                FFmpeg 无损去重封装（每平台独立元数据与 SHA-256，零画质损失）
              </label>

              <Btn
                size="sm"
                icon="check"
                onClick={handleSaveAgentSettings}
                disabled={busy === "save_agent"}
              >
                {busy === "save_agent" ? "保存中…" : "保存代理配置"}
              </Btn>
            </div>

            {agent?.error && !agent.online && (
              <div className="text-[11px]" style={{ color: "var(--aurora-danger)" }}>
                最近探测信息：{agent.error}
              </div>
            )}
          </div>
        )}

        {/* 目标平台选择与扫码登录 */}
        <div
          className="pt-3 space-y-2.5"
          style={{ borderTop: "1px solid var(--aurora-border)" }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold" style={{ color: "var(--aurora-fg2)" }}>
              选择目标分发平台（支持一键本机扫码登录）
            </span>
            <select
              value={defaultMode}
              onChange={(e) => setDefaultMode(e.target.value as "draft" | "publish")}
              style={{ ...fieldStyle, width: "auto", minWidth: 210, padding: "6px 10px" }}
              aria-label="默认推送模式"
            >
              <option value="draft">默认模式：自动填表存草稿（推荐最稳）</option>
              <option value="publish">默认模式：自动提交/定时发布</option>
            </select>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {platforms.map((p) => {
              const checked = selectedPlatforms.includes(p.id);
              const logged = Boolean(p.agent_status?.logged_in);
              const adapterLabel =
                p.adapter === "biliup"
                  ? "biliup 直传"
                  : p.adapter === "youtube_api"
                  ? "官方 OAuth API"
                  : "本机可见 Chrome";
              return (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-xs transition-colors"
                  style={{
                    background: checked ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                    border: `1px solid ${checked ? "var(--aurora-accent)" : "var(--aurora-border)"}`,
                    color: "var(--aurora-fg1)",
                  }}
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePlatform(p.id)}
                      className="h-4 w-4 shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{p.name}</div>
                      <div className="truncate text-[11px]" style={{ color: "var(--aurora-fg3)" }}>
                        {adapterLabel}
                        {agent?.online ? (logged ? " · 已登录" : " · 未登录") : ""}
                      </div>
                    </div>
                  </label>
                  {agent?.online && (
                    <Btn
                      size="sm"
                      variant="ghost"
                      icon="lock"
                      disabled={busy === `login:${p.id}`}
                      onClick={() => void handleTriggerLogin(p.id)}
                    >
                      {logged ? "重登" : "扫码登录"}
                    </Btn>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 主操作按钮 */}
        <div
          className="pt-3 flex flex-wrap items-center gap-2"
          style={{ borderTop: "1px solid var(--aurora-border)" }}
        >
          <Btn
            icon="sparkles"
            onClick={() => void handlePrepare(false)}
            disabled={busy === "prepare" || !overview?.video}
          >
            {busy === "prepare" ? "生成差异化分发包中…" : "一键生成各平台差异化发布包"}
          </Btn>

          <Btn
            icon="rocket"
            variant="glass"
            onClick={() => void handleDispatchBatch()}
            disabled={busy === "batch" || !agent?.online || preparedCount === 0}
          >
            {busy === "batch" ? "派发中…" : `批量推送待发任务 (${preparedCount})`}
          </Btn>

          {overview?.has_zip && (
            <a
              href={studioPublishBundleUrl(episode.id)}
              download
              className="aurora-btn aurora-btn-ghost"
              style={{ textDecoration: "none" }}
            >
              <Icon name="download" size={14} />
              <span>下载全平台发布包 (.zip)</span>
            </a>
          )}
        </div>
      </Glass>

      {/* 2. 各平台差异化发布卡片 */}
      {(overview?.jobs || []).length === 0 ? (
        <Glass padding="28px 20px" radius={16} className="text-center">
          <div className="text-xs leading-relaxed" style={{ color: "var(--aurora-fg3)" }}>
            尚未为本集生成多平台发布包。勾选上方目标平台后点击「一键生成各平台差异化发布包」，系统将自动抽取 3 张高清封面、按各平台算法调性生成差异化标题与标签，并无损封装为各平台独立 SHA-256 成片。
          </div>
        </Glass>
      ) : (
        <div className="space-y-3">
          {(overview?.jobs || []).map((job) => {
            const meta = platMap[job.platform];
            const st = STATUS_META[job.status] || STATUS_META.prepared;
            const ed: JobDraft = draftEdits[job.id] || {
              title: job.title,
              description: job.description,
              tagsText: (job.tags || []).join(" "),
              scheduled_at: job.scheduled_at || "",
              mode: job.mode === "publish" ? "publish" : "draft",
            };
            return (
              <Glass key={job.id} padding="16px" radius={16} className="space-y-3 min-w-0">
                <div
                  className="flex flex-wrap items-center gap-2 pb-2.5"
                  style={{ borderBottom: "1px solid var(--aurora-border)" }}
                >
                  <span className="text-sm font-semibold" style={{ color: "var(--aurora-fg1)" }}>
                    {meta?.name || job.platform}
                  </span>
                  <Chip tone={st.tone}>{st.label}</Chip>
                  {job.video_sha256 && (
                    <Chip tone="neutral">SHA256: {job.video_sha256.slice(0, 12)}</Chip>
                  )}
                  {job.already_published && job.status === "prepared" && (
                    <Chip tone="warn" icon="alert">
                      本平台已有推送记录
                    </Chip>
                  )}
                  {job.published_url && (
                    <a
                      href={job.published_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs"
                      style={{ color: "var(--aurora-accent)" }}
                    >
                      <span>打开创作者后台</span>
                      <Icon name="external_link" size={12} />
                    </a>
                  )}
                  <button
                    type="button"
                    aria-label="删除任务"
                    onClick={async () => {
                      await studioApi.deletePublishJob(job.id);
                      await loadAll();
                    }}
                    className="ml-auto rounded-lg p-1.5"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--aurora-fg3)",
                      cursor: "pointer",
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                  {/* 左侧封面与 3 张候选切换 */}
                  <div className="space-y-2 lg:col-span-4 min-w-0">
                    <div
                      className="aspect-video w-full overflow-hidden rounded-xl flex items-center justify-center"
                      style={{
                        background: "var(--aurora-chip)",
                        border: "1px solid var(--aurora-border)",
                      }}
                    >
                      {job.cover_path ? (
                        <img
                          src={studioAssetUrl(job.cover_path)}
                          alt={`${meta?.name || job.platform} 封面`}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <span className="text-xs" style={{ color: "var(--aurora-fg4)" }}>
                          无封面
                        </span>
                      )}
                    </div>

                    {(overview?.covers || []).length > 0 && (
                      <div className="flex gap-1.5 overflow-x-auto pb-1">
                        {overview?.covers.map((c) => {
                          const picked = job.cover_path === c.path;
                          return (
                            <button
                              key={c.path}
                              type="button"
                              onClick={async () => {
                                await studioApi.patchPublishJob(job.id, { cover_path: c.path });
                                await loadAll();
                              }}
                              className="h-12 w-16 shrink-0 overflow-hidden rounded-lg"
                              style={{
                                border: picked
                                  ? "2px solid var(--aurora-accent)"
                                  : "1px solid var(--aurora-border)",
                                opacity: picked ? 1 : 0.72,
                                padding: 0,
                                cursor: "pointer",
                              }}
                            >
                              <img
                                src={studioAssetUrl(c.path)}
                                alt={c.name}
                                className="h-full w-full object-cover"
                              />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* 右侧差异化文案、定时与推送操作 */}
                  <div className="space-y-2.5 lg:col-span-8 min-w-0">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                          标题（上限 {meta?.max_title ?? 30} 字）
                        </label>
                        <input
                          value={ed.title}
                          onChange={(e) =>
                            setDraftEdits((prev) => ({
                              ...prev,
                              [job.id]: { ...ed, title: e.target.value },
                            }))
                          }
                          style={fieldStyle}
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                          推送模式
                        </label>
                        <select
                          value={ed.mode}
                          onChange={(e) =>
                            setDraftEdits((prev) => ({
                              ...prev,
                              [job.id]: { ...ed, mode: e.target.value as "draft" | "publish" },
                            }))
                          }
                          style={fieldStyle}
                        >
                          <option value="draft">存草稿箱/预览确认</option>
                          <option value="publish">直接/定时发布</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                        平台专属简介
                      </label>
                      <textarea
                        rows={2}
                        value={ed.description}
                        onChange={(e) =>
                          setDraftEdits((prev) => ({
                            ...prev,
                            [job.id]: { ...ed, description: e.target.value },
                          }))
                        }
                        style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.5 }}
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div>
                        <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                          话题标签（空格分隔，上限 {meta?.max_tags ?? 5} 个）
                        </label>
                        <input
                          value={ed.tagsText}
                          onChange={(e) =>
                            setDraftEdits((prev) => ({
                              ...prev,
                              [job.id]: { ...ed, tagsText: e.target.value },
                            }))
                          }
                          style={fieldStyle}
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                          定时发布（可选 ISO 时间，留空即刻）
                        </label>
                        <input
                          value={ed.scheduled_at}
                          onChange={(e) =>
                            setDraftEdits((prev) => ({
                              ...prev,
                              [job.id]: { ...ed, scheduled_at: e.target.value },
                            }))
                          }
                          placeholder="2026-11-24T18:00:00+08:00"
                          style={fieldStyle}
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <Btn
                        size="sm"
                        variant="ghost"
                        icon="check"
                        disabled={busy === `save:${job.id}`}
                        onClick={() => void handleSaveJob(job)}
                      >
                        {busy === `save:${job.id}` ? "保存中…" : "保存文案"}
                      </Btn>
                      <Btn
                        size="sm"
                        icon="rocket"
                        disabled={busy === `dispatch:${job.id}` || !agent?.online}
                        onClick={() => void handleDispatchOne(job, Boolean(job.already_published))}
                      >
                        {busy === `dispatch:${job.id}`
                          ? "派发中…"
                          : job.status === "failed"
                          ? "重试推送"
                          : "推送到本平台"}
                      </Btn>
                      {job.status === "awaiting_user" && (
                        <Btn
                          size="sm"
                          variant="glass"
                          icon="check"
                          onClick={async () => {
                            await studioApi.confirmPublishJob(job.id);
                            await loadAll();
                            onNotify(true, "已通知本机代理继续执行上传与填表");
                          }}
                        >
                          已在 Chrome 完成扫码/验证，继续
                        </Btn>
                      )}
                    </div>

                    {job.error && (
                      <div
                        className="rounded-lg px-3 py-2 text-xs"
                        style={{
                          background: "var(--aurora-danger-soft)",
                          color: "var(--aurora-danger)",
                        }}
                      >
                        {job.error}
                      </div>
                    )}

                    {job.status === "downloading" && <DownloadProgress logs={job.logs || []} />}

                    {job.logs && job.logs.length > 0 && (
                      <div
                        className="max-h-24 overflow-y-auto rounded-lg px-3 py-2 font-mono text-[11px]"
                        style={{
                          background: "var(--aurora-chip)",
                          border: "1px solid var(--aurora-border)",
                          color: "var(--aurora-fg3)",
                        }}
                      >
                        {job.logs.slice(-6).map((ln, idx) => (
                          <div key={idx}>{ln}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </Glass>
            );
          })}
        </div>
      )}
    </div>
  );
}
