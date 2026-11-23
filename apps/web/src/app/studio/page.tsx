"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, AskConversationSummary } from "@/lib/api-client";
import { usePlugins } from "@/lib/plugins-context";
import {
  studioApi,
  studioAssetUrl,
  studioEpisodeVideoUrl,
  StudioBatchState,
  StudioBgmItem,
  StudioCharacter,
  StudioComputeState,
  StudioEpisode,
  StudioEpisodeDetail,
  StudioHealth,
  StudioPreset,
  StudioProject,
  StudioShot,
  StudioTask,
  StudioVoiceOption,
} from "@/lib/studio-api";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, TopBar } from "@/components/aurora/primitives";
import { StudioPublishPanel } from "@/components/studio/StudioPublishPanel";
import { VideoPlayer } from "@/components/viewers/MediaPreview";

type StudioTab = "storyboard" | "cast_audio" | "screening" | "publish";

const VALID_TABS: StudioTab[] = ["storyboard", "cast_audio", "screening", "publish"];

const MOTION_OPTIONS = [
  { id: "zoom_in", label: "缓慢推近" },
  { id: "zoom_in_handheld", label: "手持呼吸推近" },
  { id: "shock_zoom", label: "冲击震屏推近" },
  { id: "zoom_out", label: "缓慢拉远" },
  { id: "pan_left", label: "向左平移" },
  { id: "pan_right", label: "向右平移" },
  { id: "static", label: "静止定格" },
];

const VOICE_SPACE_OPTIONS = [
  { id: "indoor_room", label: "室内自然声场" },
  { id: "close_whisper", label: "贴耳呼吸气声" },
  { id: "behind_door_ghost", label: "隔门雨夜鬼魅混响" },
  { id: "cemetery_outdoor", label: "户外空旷反射" },
  { id: "dry", label: "纯干声" },
];

const FX_OPTIONS = [
  { id: "", label: "无微特效" },
  { id: "rain_mist", label: "冷青夜雨雾" },
  { id: "flicker", label: "灯管频闪" },
  { id: "chromatic_shock", label: "高潮 RGB 色差冲击" },
  { id: "riser_shake", label: "悬念渐强微颤" },
  { id: "shake", label: "冲击闪白微颤" },
];

const SFX_OPTIONS = [
  { id: "", label: "无点状音效" },
  { id: "page_turn", label: "翻纸冷风" },
  { id: "flashlight_click", label: "手电咔哒" },
  { id: "midnight_bell", label: "午夜钟声" },
  { id: "bulb_buzz", label: "电流滋啦" },
  { id: "knock_3", label: "三声慢叩门" },
  { id: "heartbeat", label: "急促心跳" },
  { id: "horror_boom", label: "次低频重击" },
  { id: "lock_slide,riser_cut", label: "插销滑动 + 急升骤停" },
];

const TRANSITION_OPTIONS = [
  { id: "", label: "跟随剧集默认" },
  { id: "cut", label: "干净硬切" },
  { id: "flash", label: "惊悚闪白" },
  { id: "fade", label: "黑场淡化" },
];

const SHOT_SCALE_OPTIONS = [
  { id: "", label: "自动景别" },
  { id: "wide", label: "远景定场" },
  { id: "medium", label: "中景叙事" },
  { id: "ots", label: "过肩正反打" },
  { id: "closeup", label: "近景情绪" },
  { id: "extreme_closeup", label: "特写钩子" },
];

const CAMERA_ANGLE_OPTIONS = [
  { id: "", label: "默认机位" },
  { id: "eye_level", label: "平拍视角" },
  { id: "low_angle", label: "仰拍压迫" },
  { id: "high_angle", label: "俯拍窥视" },
  { id: "dutch", label: "荷兰斜角" },
];

const FALLBACK_PRESETS: Record<string, StudioPreset> = {
  live_action_drama: {
    label: "真人写实短剧（国产 S+ 影视级）",
    style:
      "high-budget contemporary mainland Chinese S+ streaming television drama cinematography, authentic Chinese East Asian beauty aesthetic, refined harmonious East Asian facial bone structure, luminous smooth fair complexion, soft diffused studio butterfly beauty key lighting, clean bright cool-neutral luxury color grading, subtle natural Chinese editorial makeup, restrained authentic micro-expressions, shot on 85mm cinema prime lens, shallow depth of field, photorealistic, no harsh facial shadows, no aged gritty skin, no Western-stereotype Asian features",
    subtitle_preset: "cinema_sub",
  },
  urban_romance: {
    label: "都市情感爽剧（高端国产剧）",
    style:
      "top-tier modern Shanghai urban Chinese romance television drama (Tencent/iQIYI S+ quality), attractive contemporary Chinese actors with delicate East Asian bone structure, luminous porcelain-ivory skin, soft flattering diffused key lighting, airy sleek metropolitan interiors, quiet-luxury modern Chinese styling, restrained natural micro-expressions, shallow depth of field, photorealistic, no harsh shadows, no greasy hair, no yellow documentary tint",
    subtitle_preset: "manga_gold",
  },
  costume_drama: {
    label: "古装仙侠短剧（东方美学实拍）",
    style:
      "high-budget Chinese historical costume xianxia/wuxia television drama, classical Oriental Chinese beauty aesthetic, refined fair East Asian features, soft misty natural beauty lighting, exquisite authentic silk hanfu embroidery, poetic Jiangnan/palace cinematography, shallow depth of field, photorealistic live-action, no harsh gritty shadows",
    subtitle_preset: "manga_gold",
  },
  suspense_anime: {
    label: "悬疑暗黑国漫（爆款漫剧）",
    style:
      "dark Chinese supernatural anime comic style, moody volumetric lighting, crisp ink linework, cinematic suspense framing, rich shadows, masterpiece",
    subtitle_preset: "manga_gold",
  },
};

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

function StudioInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialProjectParam = searchParams.get("project") || "";
  const initialEpisodeParam = searchParams.get("episode") || "";
  const initialTabParam = searchParams.get("tab") || "";

  const [health, setHealth] = useState<StudioHealth | null>(null);
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(initialProjectParam);
  const [episodes, setEpisodes] = useState<StudioEpisode[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string>(initialEpisodeParam);
  const [detail, setDetail] = useState<StudioEpisodeDetail | null>(null);
  const [voices, setVoices] = useState<StudioVoiceOption[]>([]);
  const [bgmList, setBgmList] = useState<StudioBgmItem[]>([]);
  const [conversations, setConversations] = useState<AskConversationSummary[]>([]);
  const [compute, setCompute] = useState<StudioComputeState | null>(null);

  const [activeTab, setActiveTabState] = useState<StudioTab>(() => {
    if (VALID_TABS.includes(initialTabParam as StudioTab)) {
      return initialTabParam as StudioTab;
    }
    if (typeof window !== "undefined") {
      const saved = sessionStorage.getItem("memento_studio_active_tab");
      if (saved && VALID_TABS.includes(saved as StudioTab)) {
        return saved as StudioTab;
      }
    }
    return "storyboard";
  });
  const setActiveTab = useCallback((next: StudioTab) => {
    setActiveTabState(next);
    if (typeof window !== "undefined") {
      try {
        sessionStorage.setItem("memento_studio_active_tab", next);
      } catch {}
    }
  }, []);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string>("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  // Project / Episode create inline state
  const [presets, setPresets] = useState<Record<string, StudioPreset>>(FALLBACK_PRESETS);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjPreset, setNewProjPreset] = useState("live_action_drama");
  const [newProjName, setNewProjName] = useState("");
  const [newProjStyle, setNewProjStyle] = useState(FALLBACK_PRESETS.live_action_drama.style);
  const [storyDraft, setStoryDraft] = useState("");
  const [breakdownCount, setBreakdownCount] = useState(8);
  const [batchState, setBatchState] = useState<StudioBatchState | null>(null);
  const [chainFrames, setChainFrames] = useState(true);

  // Lyria BGM prompt
  const [bgmPrompt, setBgmPrompt] = useState(
    "Cinematic dark Chinese folklore supernatural suspense film score, purely instrumental, eerie erhu and deep cello drone, escalating tension strings"
  );

  // Publish to chat state
  const [targetConvId, setTargetConvId] = useState<string>("");
  const [publishNote, setPublishNote] = useState<string>("");
  const [publishedConvId, setPublishedConvId] = useState<string>("");
  const [publishedVideoUrl, setPublishedVideoUrl] = useState<string>("");
  const [renderVersionOverride, setRenderVersionOverride] = useState<string>("");
  const [renderTask, setRenderTask] = useState<StudioTask | null>(null);

  const notify = useCallback((ok: boolean, text: string) => {
    setNotice({ ok, text });
  }, []);

  const loadEpisode = useCallback(async (eid: string) => {
    if (!eid) return;
    try {
      const epDetail = await studioApi.getEpisode(eid);
      setDetail(epDetail);
      setStoryDraft(epDetail.episode.story_text || "");
      setRenderTask(epDetail.last_task || null);
      setPublishedVideoUrl("");
      setRenderVersionOverride("");
    } catch (e) {
      notify(false, `加载剧集失败：${(e as Error).message}`);
    }
  }, [notify]);

  const loadProject = useCallback(async (pid: string, preferEpisodeId?: string) => {
    if (!pid) return;
    try {
      const data = await studioApi.getProject(pid);
      setEpisodes(data.episodes || []);
      const pick =
        (preferEpisodeId && data.episodes.find((ep) => ep.id === preferEpisodeId)?.id) ||
        data.episodes[0]?.id ||
        "";
      setSelectedEpisodeId(pick);
      if (pick) {
        await loadEpisode(pick);
      } else {
        setDetail(null);
      }
    } catch (e) {
      notify(false, `加载项目失败：${(e as Error).message}`);
    }
  }, [loadEpisode, notify]);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const [h, convs] = await Promise.all([
        studioApi.health(),
        api.listAskConversations(undefined, 30).catch(() => [] as AskConversationSummary[]),
      ]);
      setHealth(h);
      setCompute(h.compute || null);
      setConversations(Array.isArray(convs) ? convs : []);
      if (typeof window !== "undefined") {
        const lastConv = localStorage.getItem("memento_last_ask_conv_id") || "";
        if (lastConv && convs.some((c) => c.id === lastConv)) {
          setTargetConvId(lastConv);
        }
      }
      if (!h.online) {
        setLoading(false);
        return;
      }
      const [projRes, voiceRes, bgmRes, presetRes] = await Promise.all([
        studioApi.listProjects(),
        studioApi.listVoices().catch(() => ({ voices: [] })),
        studioApi.listBgm().catch(() => ({ items: [] })),
        studioApi.listPresets().catch(() => ({ presets: FALLBACK_PRESETS })),
      ]);
      const list = projRes.projects || [];
      setProjects(list);
      setVoices(voiceRes.voices || []);
      setBgmList(bgmRes.items || []);
      if (presetRes.presets && Object.keys(presetRes.presets).length > 0) {
        setPresets(presetRes.presets);
        if (presetRes.presets.live_action_drama?.style) {
          setNewProjStyle((prev) =>
            prev === FALLBACK_PRESETS.live_action_drama.style
              ? presetRes.presets.live_action_drama.style
              : prev
          );
        }
      }

      const targetProj =
        (initialProjectParam && list.find((p) => p.id === initialProjectParam)?.id) ||
        list[0]?.id ||
        "";
      setSelectedProjectId(targetProj);
      if (targetProj) {
        await loadProject(targetProj, initialEpisodeParam);
      }
    } catch (e) {
      notify(false, (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [initialEpisodeParam, initialProjectParam, loadProject, notify]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Poll render task if active
  useEffect(() => {
    if (!renderTask || !["queued", "running"].includes(renderTask.status)) return;
    const timer = setInterval(async () => {
      try {
        const res = await studioApi.getTask(renderTask.id);
        setRenderTask(res.task);
        if (res.task.status === "succeeded" || res.task.status === "done") {
          setRenderVersionOverride(res.task.id || String(Date.now()));
          notify(true, "成片母带已渲染完成，可直接预览或发送到对话播放");
          if (selectedEpisodeId) void loadEpisode(selectedEpisodeId);
        } else if (res.task.status === "failed") {
          notify(false, `渲染失败：${res.task.error || "请查看任务日志"}`);
        }
      } catch {}
    }, 3000);
    return () => clearInterval(timer);
  }, [renderTask, selectedEpisodeId, loadEpisode, notify]);

  // Poll batch job if running
  useEffect(() => {
    if (!selectedEpisodeId || !batchState?.running) return;
    const timer = setInterval(async () => {
      try {
        const res = await studioApi.batchStatus(selectedEpisodeId);
        setBatchState(res.batch);
        if (!res.batch.running) {
          await loadEpisode(selectedEpisodeId);
          const modeLabel =
          res.batch.mode === "upscale"
            ? "全集 SeedVR2 1080P 超分"
            : res.batch.mode === "animate"
            ? "全集 MiniMax-H3 原生音画转动态"
            : "全集批量生图";
          notify(
            res.batch.failed === 0,
            `${modeLabel}已完成：成功 ${res.batch.succeeded}/${res.batch.total}${
              res.batch.failed > 0 ? `，失败 ${res.batch.failed}` : ""
            }`
          );
        }
      } catch {}
    }, 2500);
    return () => clearInterval(timer);
  }, [selectedEpisodeId, batchState?.running, loadEpisode, notify]);

  const handleCreateProject = async () => {
    if (!newProjName.trim()) return;
    setBusyAction("create_project");
    try {
      const res = await studioApi.createProject({
        name: newProjName.trim(),
        style: newProjStyle.trim(),
        preset: newProjPreset,
        aspect: "vertical",
        default_engine: "external",
      });
      setNewProjName("");
      setShowNewProject(false);
      const listRes = await studioApi.listProjects();
      setProjects(listRes.projects || []);
      setSelectedProjectId(res.project.id);
      await loadProject(res.project.id, res.default_episode?.id || res.episode?.id);
      notify(true, `已创建项目「${res.project.name}」`);
    } catch (e) {
      notify(false, (e as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const handleBreakdown = async () => {
    if (!selectedEpisodeId || !storyDraft.trim()) return;
    setBusyAction("breakdown");
    try {
      await studioApi.breakdownEpisode(selectedEpisodeId, storyDraft.trim(), breakdownCount);
      await loadEpisode(selectedEpisodeId);
      notify(true, "已完成 AI 剧本拆镜与角色提取");
    } catch (e) {
      notify(false, (e as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const handleShotPatch = async (sid: string, patch: Partial<StudioShot>) => {
    try {
      const res = await studioApi.updateShot(sid, patch);
      setDetail((prev) =>
        prev
          ? { ...prev, shots: prev.shots.map((s) => (s.id === sid ? res.shot : s)) }
          : prev
      );
    } catch (e) {
      notify(false, `保存分镜失败：${(e as Error).message}`);
    }
  };

  const handleShotAction = async (
    sid: string,
    kind: "generate" | "tts" | "animate" | "linkprev" | "lipsync"
  ) => {
    setBusyAction(`${kind}:${sid}`);
    try {
      if (kind === "generate") {
        const res = await studioApi.generateShot(sid, 1);
        setDetail((prev) =>
          prev ? { ...prev, shots: prev.shots.map((s) => (s.id === sid ? res.shot : s)) } : prev
        );
        notify(true, "新分镜候选图已生成");
      } else if (kind === "tts") {
        const res = await studioApi.ttsPreviewShot(sid);
        setDetail((prev) =>
          prev ? { ...prev, shots: prev.shots.map((s) => (s.id === sid ? res.shot : s)) } : prev
        );
        notify(true, `配音试听已生成 (${res.engine || "TTS"})`);
      } else if (kind === "linkprev") {
        const res = await studioApi.usePrevLastFrame(sid);
        setDetail((prev) =>
          prev ? { ...prev, shots: prev.shots.map((s) => (s.id === sid ? res.shot : s)) } : prev
        );
        notify(true, "已提取上一镜尾帧作为本镜首帧，确保动作与光影连贯");
      } else if (kind === "lipsync") {
        const res = await studioApi.lipsyncShot(sid);
        setDetail((prev) =>
          prev ? { ...prev, shots: prev.shots.map((s) => (s.id === sid ? res.shot : s)) } : prev
        );
        notify(true, `单镜对口型已完成 (${res.source || "InfiniteTalk"})`);
      } else {
        const res = await studioApi.animateShot(sid);
        setDetail((prev) =>
          prev ? { ...prev, shots: prev.shots.map((s) => (s.id === sid ? res.shot : s)) } : prev
        );
        notify(true, `单镜 I2V 动态视频已生成 (${res.source || "I2V"})`);
      }
    } catch (e) {
      notify(false, (e as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const handleBatchGenerate = async () => {
    if (!selectedEpisodeId) return;
    setBusyAction("batch_gen");
    try {
      const res = await studioApi.batchGenerate(selectedEpisodeId, { force: false, max_workers: 3 });
      setBatchState(res.batch);
      if (res.batch.total === 0) {
        notify(true, "所有分镜已有画面，无需重复生成");
      } else {
        notify(true, `已启动后台并发批量生图（共 ${res.batch.total} 镜）`);
      }
    } catch (e) {
      notify(false, (e as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const handleBatchAnimate = async () => {
    if (!selectedEpisodeId) return;
    setBusyAction("batch_anim");
    try {
      const res = await studioApi.batchAnimate(selectedEpisodeId, {
        force: false,
        chain_frames: chainFrames,
        max_workers: 3,
      });
      setBatchState(res.batch);
      if (res.batch.total === 0) {
        notify(true, "全集分镜均已是动态视频片段");
      } else {
        notify(
          true,
          `已启动后台批量转动态 I2V（共 ${res.batch.total} 镜${chainFrames ? "，已开启首尾帧衔接" : ""}）`
        );
      }
    } catch (e) {
      notify(false, (e as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const handleConfirmStory = async () => {
    if (!selectedEpisodeId || !detail) return;
    const nextConfirmed = !detail.episode.story_confirmed;
    setBusyAction("confirm_story");
    try {
      await studioApi.confirmStory(selectedEpisodeId, nextConfirmed);
      await loadEpisode(selectedEpisodeId);
      notify(
        true,
        nextConfirmed
          ? "已确认本集剧情无误，现可执行全集 1080P 超分"
          : "已取消剧情确认锁定，可继续修改分镜并按原分辨率快速预览"
      );
    } catch (e) {
      notify(false, (e as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const handleBatchUpscale = async () => {
    if (!selectedEpisodeId) return;
    setBusyAction("batch_upscale");
    try {
      const res = await studioApi.batchUpscale(selectedEpisodeId, { force: false });
      setBatchState(res.batch);
      if (res.batch.total === 0) {
        notify(true, "所有动态片段均已完成 1080P 超分，无需重复执行");
      } else {
        notify(true, `已启动后台批量 1080P 超分（共 ${res.batch.total} 镜）`);
      }
    } catch (e) {
      notify(false, (e as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const handleSyncAudio = async () => {
    if (!selectedEpisodeId) return;
    setBusyAction("sync_audio");
    try {
      const res = await studioApi.syncAudioDurations(selectedEpisodeId);
      await loadEpisode(selectedEpisodeId);
      notify(true, `已按真实情感配音时长对齐 ${res.adjusted?.length ?? 0} 个分镜`);
    } catch (e) {
      notify(false, (e as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const handleRender = async () => {
    if (!selectedEpisodeId) return;
    setBusyAction("render");
    try {
      const res = await studioApi.renderEpisode(selectedEpisodeId);
      setRenderTask(res.task);
      setActiveTab("screening");
      notify(true, "已提交全集母带合成任务，完成后可一键发往对话播放");
    } catch (e) {
      notify(false, `提交渲染失败：${(e as Error).message}`);
    } finally {
      setBusyAction("");
    }
  };

  const handleGenerateBgm = async () => {
    if (!bgmPrompt.trim() || !selectedEpisodeId) return;
    setBusyAction("bgm_gen");
    try {
      const res = await studioApi.generateBgm(
        bgmPrompt.trim(),
        detail?.project.slug || "lyria_score",
        "lyria-3-pro-preview"
      );
      const bgmRes = await studioApi.listBgm();
      setBgmList(bgmRes.items || []);
      await studioApi.updateEpisode(selectedEpisodeId, { bgm_path: res.item.path });
      await loadEpisode(selectedEpisodeId);
      notify(true, `Lyria 3 Pro 电影配乐已生成并绑定：${res.item.name}`);
    } catch (e) {
      notify(false, `生成配乐失败：${(e as Error).message}`);
    } finally {
      setBusyAction("");
    }
  };

  const handlePublishToChat = async () => {
    if (!selectedEpisodeId) return;
    setBusyAction("publish");
    try {
      const res = await studioApi.publishToChat(selectedEpisodeId, {
        conversation_id: targetConvId || null,
        task_id: renderTask?.id || detail?.episode.last_task_id || null,
        note: publishNote.trim(),
      });
      setPublishedConvId(res.conversation_id);
      setPublishedVideoUrl(res.video_url);
      if (typeof window !== "undefined") {
        localStorage.setItem("memento_last_ask_conv_id", res.conversation_id);
        window.dispatchEvent(new Event("memento_switch_chat"));
      }
      notify(true, `成片已归档并发送到对话「${res.conversation_title}」，点击下方按钮即可在对话内直接播放`);
    } catch (e) {
      notify(false, `发布到对话失败：${(e as Error).message}`);
    } finally {
      setBusyAction("");
    }
  };

  const handleComputeAction = async (action: "start" | "stop" | "extend") => {
    setBusyAction(`compute:${action}`);
    try {
      const res =
        action === "start"
          ? await studioApi.computeStart()
          : action === "stop"
          ? await studioApi.computeStop()
          : await studioApi.computeExtend(15);
      setCompute(res.compute);
      notify(
        true,
        action === "start"
          ? "已触发云端算力启动"
          : action === "stop"
          ? "已释放云端算力，停止计费"
          : "已延长自动关机时间 15 分钟"
      );
    } catch (e) {
      notify(false, (e as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const episodeVideoVersion = renderVersionOverride || detail?.episode.last_task_id || renderTask?.id || "";

  const episodePreviewSrc = useMemo(() => {
    if (publishedVideoUrl) return publishedVideoUrl;
    if (!selectedEpisodeId) return "";
    return studioEpisodeVideoUrl(selectedEpisodeId, episodeVideoVersion);
  }, [publishedVideoUrl, selectedEpisodeId, episodeVideoVersion]);

  const computeOnline = compute?.status === "ready";
  const computeBusy = compute && ["connecting", "awaiting_gpu", "booting", "stopping"].includes(compute.status);

  return (
    <div className="w-full max-w-6xl mx-auto pb-16 min-w-0 overflow-x-hidden">
      <TopBar
        title="演播台"
        subtitle="AI 剧本拆镜、Gemini 情感配音、Lyria 交响配乐与商业母带出片，成片一键发往对话内联播放"
      />

      {/* 状态提示条 */}
      {notice && (
        <Glass
          padding="10px 14px"
          radius={12}
          style={{
            marginBottom: 14,
            borderColor: notice.ok ? "var(--aurora-accent)" : "#DC2626",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <span style={{ fontSize: 13, color: notice.ok ? "var(--aurora-fg1)" : "#DC2626" }}>
            {notice.text}
          </span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            style={{ background: "none", border: "none", color: "var(--aurora-fg3)", cursor: "pointer" }}
          >
            <Icon name="close" size={14} />
          </button>
        </Glass>
      )}

      {/* 引擎离线提示 */}
      {!loading && health && !health.online && (
        <Glass padding={20} radius={16} style={{ marginBottom: 16 }}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--aurora-fg1)" }}>
                <Icon name="alert" size={16} style={{ color: "#D97706" }} />
                <span>演播台渲染引擎 (filmkit) 尚未连接</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--aurora-fg3)" }}>
                当前桥接地址：{health.filmkit_url}。请先在本机或集群启动 filmkit serve，或通过环境变量
                MEMENTO_STUDIO_FILMKIT_URL 指向已运行的演播台服务。
              </p>
            </div>
            <Btn icon="refresh" onClick={bootstrap}>
              重新检测
            </Btn>
          </div>
        </Glass>
      )}

      {loading && (
        <div style={{ color: "var(--aurora-fg4)", textAlign: "center", padding: "48px 0", fontSize: 13 }}>
          正在连接演播台引擎…
        </div>
      )}

      {!loading && health?.online && (
        <>
          {/* 顶栏控制条：项目/剧集切换 + 云算力状态 + 主操作 */}
          <Glass padding="14px 16px" radius={16} style={{ marginBottom: 14 }}>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_1fr_auto]">
                <div className="flex items-center gap-2 min-w-0">
                  <select
                    value={selectedProjectId}
                    onChange={(e) => {
                      const pid = e.target.value;
                      setSelectedProjectId(pid);
                      setPublishedVideoUrl("");
                      void loadProject(pid);
                    }}
                    style={fieldStyle}
                    aria-label="选择项目"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        项目：{p.name}
                      </option>
                    ))}
                  </select>
                  <Btn icon="plus" variant="ghost" onClick={() => setShowNewProject((v) => !v)}>
                    新建
                  </Btn>
                </div>

                <select
                  value={selectedEpisodeId}
                  onChange={(e) => {
                    const eid = e.target.value;
                    setSelectedEpisodeId(eid);
                    setPublishedVideoUrl("");
                    void loadEpisode(eid);
                  }}
                  style={fieldStyle}
                  aria-label="选择剧集"
                >
                  {episodes.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      剧集：{ep.title} ({ep.shot_count ?? 0} 镜)
                    </option>
                  ))}
                </select>

                <div className="flex flex-wrap items-center gap-2">
                  <Btn
                    icon="film"
                    onClick={handleRender}
                    disabled={!selectedEpisodeId || busyAction === "render"}
                  >
                    {busyAction === "render" ? "提交中…" : "合成母带"}
                  </Btn>
                  <Btn
                    icon="share"
                    variant="ghost"
                    onClick={() => setActiveTab("screening")}
                    disabled={!selectedEpisodeId}
                  >
                    放映并发送到对话
                  </Btn>
                  <Btn
                    icon="rocket"
                    variant="ghost"
                    onClick={() => setActiveTab("publish")}
                    disabled={!selectedEpisodeId}
                  >
                    多平台分发
                  </Btn>
                </div>
              </div>

              {/* 新建项目面板（内置 AI 短剧 / 漫剧商业预设） */}
              {showNewProject && (
                <div
                  className="grid grid-cols-1 gap-2 pt-3 sm:grid-cols-[180px_190px_1fr_auto]"
                  style={{ borderTop: "1px solid var(--aurora-border)" }}
                >
                  <select
                    value={newProjPreset}
                    onChange={(e) => {
                      const key = e.target.value;
                      setNewProjPreset(key);
                      if (presets[key]?.style) {
                        setNewProjStyle(presets[key].style);
                      }
                    }}
                    style={fieldStyle}
                    aria-label="项目类型预设"
                  >
                    {Object.entries(presets).map(([key, meta]) => (
                      <option key={key} value={key}>
                        {meta.label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={newProjName}
                    onChange={(e) => setNewProjName(e.target.value)}
                    placeholder="新短剧名称，如：豪门暗局"
                    style={fieldStyle}
                  />
                  <input
                    value={newProjStyle}
                    onChange={(e) => setNewProjStyle(e.target.value)}
                    placeholder="全局统一画风英文提示词"
                    style={fieldStyle}
                  />
                  <Btn
                    icon="check"
                    onClick={handleCreateProject}
                    disabled={!newProjName.trim() || busyAction === "create_project"}
                  >
                    确认创建
                  </Btn>
                </div>
              )}

              {/* Colab 云算力轻量状态条 */}
              <div
                className="flex flex-wrap items-center justify-between gap-2 pt-2.5 text-xs"
                style={{ borderTop: "1px solid var(--aurora-border)", color: "var(--aurora-fg3)" }}
              >
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <Icon name="server" size={14} style={{ color: computeOnline ? "#16A34A" : "var(--aurora-fg3)" }} />
                  <span>
                    云端 GPU 算力：
                    {computeOnline
                      ? `${compute?.gpu || "已就绪"} (${compute?.vram_free_gb?.toFixed(1) ?? "?"}G 可用)`
                      : computeBusy
                      ? compute?.stage || compute?.status
                      : "离线（0 消耗）"}
                  </span>
                  {computeOnline && compute?.auto_shutdown_in_sec != null && (
                    <Chip>{Math.ceil(compute.auto_shutdown_in_sec / 60)} 分钟后自动释放</Chip>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {!computeOnline ? (
                    <Btn
                      icon="zap"
                      variant="ghost"
                      onClick={() => handleComputeAction("start")}
                      disabled={!!busyAction || !!computeBusy}
                    >
                      按需启动 GPU
                    </Btn>
                  ) : (
                    <>
                      <Btn
                        icon="clock"
                        variant="ghost"
                        onClick={() => handleComputeAction("extend")}
                        disabled={!!busyAction}
                      >
                        续期 15m
                      </Btn>
                      <Btn
                        icon="close"
                        variant="ghost"
                        onClick={() => handleComputeAction("stop")}
                        disabled={!!busyAction}
                      >
                        立即释放
                      </Btn>
                    </>
                  )}
                </div>
              </div>
            </div>
          </Glass>

          {/* 工作区 Tabs */}
          <div className="flex flex-wrap items-center gap-2 mb-3.5">
            {(
              [
                { id: "storyboard", label: `分镜剧场 (${detail?.shots.length ?? 0})`, icon: "layers" },
                { id: "cast_audio", label: "角色与配乐", icon: "music" },
                { id: "screening", label: "成片放映与对话发布", icon: "film" },
                { id: "publish", label: "多平台分发", icon: "rocket" },
              ] as const
            ).map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium transition-colors"
                  style={{
                    background: active ? "var(--aurora-accent)" : "var(--aurora-surface-solid)",
                    color: active ? "#FFFFFF" : "var(--aurora-fg2)",
                    border: `1px solid ${active ? "var(--aurora-accent)" : "var(--aurora-border)"}`,
                    cursor: "pointer",
                  }}
                >
                  <Icon name={tab.icon} size={14} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* TAB 1: 分镜剧场 */}
          {activeTab === "storyboard" && detail && (
            <div className="space-y-4">
              {/* 剧本拆镜区 */}
              <Glass padding="14px 16px" radius={16}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-semibold" style={{ color: "var(--aurora-fg2)" }}>
                    故事大纲 AI 拆镜
                  </span>
                  <div className="flex items-center gap-2">
                    <select
                      value={breakdownCount}
                      onChange={(e) => setBreakdownCount(Number(e.target.value))}
                      style={{ ...fieldStyle, width: 100, padding: "5px 8px" }}
                    >
                      {[6, 8, 10, 12].map((n) => (
                        <option key={n} value={n}>
                          {n} 镜
                        </option>
                      ))}
                    </select>
                    <Btn
                      icon="sparkles"
                      onClick={handleBreakdown}
                      disabled={!storyDraft.trim() || busyAction === "breakdown"}
                    >
                      {busyAction === "breakdown" ? "拆镜中…" : "AI 拆镜"}
                    </Btn>
                  </div>
                </div>
                <textarea
                  value={storyDraft}
                  onChange={(e) => setStoryDraft(e.target.value)}
                  rows={3}
                  placeholder="粘贴短剧冲突剧本或小说片段，点击 AI 拆镜自动按正反打/景别/口型标记拆出全集分镜…"
                  style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.55 }}
                />

                {/* 短剧量产批量流水线工具条 */}
                <div
                  className="mt-3 pt-3 flex flex-wrap items-center justify-between gap-2"
                  style={{ borderTop: "1px solid var(--aurora-border)" }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Btn
                      icon="image"
                      variant="ghost"
                      onClick={handleBatchGenerate}
                      disabled={!!busyAction || !!batchState?.running || detail.shots.length === 0}
                    >
                      全集批量生图
                    </Btn>
                    <Btn
                      icon="film"
                      variant="ghost"
                      onClick={handleBatchAnimate}
                      disabled={!!busyAction || !!batchState?.running || detail.shots.length === 0}
                    >
                      全集批量转动态 (I2V)
                    </Btn>
                    <Btn
                      icon="clock"
                      variant="ghost"
                      onClick={handleSyncAudio}
                      disabled={!!busyAction || detail.shots.length === 0}
                    >
                      {busyAction === "sync_audio" ? "对齐中…" : "以声定画对齐时长"}
                    </Btn>
                    <Btn
                      icon="check"
                      variant={detail.episode.story_confirmed ? "primary" : "ghost"}
                      onClick={handleConfirmStory}
                      disabled={!!busyAction || detail.shots.length === 0}
                    >
                      {detail.episode.story_confirmed ? "剧情已确认" : "确认剧情"}
                    </Btn>
                    <Btn
                      icon="zap"
                      variant="ghost"
                      onClick={handleBatchUpscale}
                      disabled={
                        !!busyAction ||
                        !!batchState?.running ||
                        !detail.episode.story_confirmed ||
                        detail.shots.length === 0
                      }
                    >
                      全集 1080P 超分
                    </Btn>
                  </div>

                  <label
                    className="inline-flex items-center gap-1.5 text-xs cursor-pointer"
                    style={{ color: "var(--aurora-fg3)" }}
                  >
                    <input
                      type="checkbox"
                      checked={chainFrames}
                      onChange={(e) => setChainFrames(e.target.checked)}
                    />
                    批量动态时按标记自动首尾帧衔接
                  </label>
                </div>

                {batchState && (batchState.running || batchState.total > 0) && (
                  <div
                    className="mt-2.5 rounded-xl px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2"
                    style={{
                      background: "var(--aurora-chip)",
                      border: "1px solid var(--aurora-border)",
                      color: "var(--aurora-fg2)",
                    }}
                  >
                    <span>
                      {batchState.running
                        ? `后台执行中（${
                            batchState.mode === "upscale"
                              ? "阶段二：SeedVR2 1080P 超分"
                              : batchState.mode === "animate"
                              ? "阶段一：MiniMax-H3 原生音画"
                              : "批量生图"
                          }）：已完成 ${batchState.done}/${batchState.total} 镜`
                        : `最近批量任务：成功 ${batchState.succeeded}/${batchState.total}${
                            batchState.failed > 0 ? `，失败 ${batchState.failed}` : ""
                          }`}
                    </span>
                    {batchState.errors?.length > 0 && (
                      <span style={{ color: "#DC2626" }}>{batchState.errors[0]}</span>
                    )}
                  </div>
                )}
              </Glass>

              {/* 分镜卡片列表 */}
              <div className="space-y-3">
                {detail.shots.map((shot) => {
                  const activeCand = shot.active_candidate;
                  const isClip = activeCand?.kind === "clip";
                  return (
                    <Glass key={shot.id} padding="14px 16px" radius={16}>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-[176px_1fr]">
                        {/* 左侧分镜画面预览 */}
                        <div className="flex flex-col gap-2">
                          <div
                            className="relative w-full overflow-hidden rounded-xl flex items-center justify-center"
                            style={{
                              aspectRatio: detail.episode.aspect === "landscape" ? "16 / 9" : "9 / 16",
                              maxHeight: 290,
                              background: "var(--aurora-chip)",
                              border: "1px solid var(--aurora-border)",
                            }}
                          >
                            {activeCand ? (
                              isClip ? (
                                <video
                                  src={studioAssetUrl(activeCand.path)}
                                  controls
                                  playsInline
                                  muted
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <img
                                  src={studioAssetUrl(activeCand.path)}
                                  alt={`第 ${shot.sort_order} 镜`}
                                  className="h-full w-full object-cover"
                                />
                              )
                            ) : (
                              <span className="text-xs" style={{ color: "var(--aurora-fg4)" }}>
                                暂无画面
                              </span>
                            )}
                            <span
                              className="absolute left-2 top-2 rounded-md px-2 py-0.5 text-[11px] font-semibold"
                              style={{ background: "rgba(15,23,42,0.78)", color: "#FFFFFF" }}
                            >
                              #{shot.sort_order} {isClip ? "动态" : "静态"}
                            </span>
                          </div>

                          <div className="grid grid-cols-3 gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleShotAction(shot.id, "generate")}
                              disabled={!!busyAction}
                              className="rounded-lg px-2 py-1.5 text-[11px] font-medium"
                              style={{
                                background: "var(--aurora-chip)",
                                border: "1px solid var(--aurora-border)",
                                color: "var(--aurora-fg1)",
                                cursor: "pointer",
                              }}
                            >
                              {busyAction === `generate:${shot.id}` ? "生图中" : "抽卡生图"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleShotAction(shot.id, "animate")}
                              disabled={!!busyAction}
                              className="rounded-lg px-2 py-1.5 text-[11px] font-medium"
                              style={{
                                background: "var(--aurora-chip)",
                                border: "1px solid var(--aurora-border)",
                                color: "var(--aurora-fg1)",
                                cursor: "pointer",
                              }}
                            >
                              {busyAction === `animate:${shot.id}` ? "I2V中" : "转动态"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleShotAction(shot.id, "tts")}
                              disabled={!!busyAction}
                              className="rounded-lg px-2 py-1.5 text-[11px] font-medium"
                              style={{
                                background: "var(--aurora-chip)",
                                border: "1px solid var(--aurora-border)",
                                color: "var(--aurora-fg1)",
                                cursor: "pointer",
                              }}
                            >
                              {busyAction === `tts:${shot.id}` ? "合成中" : "试听"}
                            </button>
                          </div>

                          <div className="grid grid-cols-2 gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleShotAction(shot.id, "lipsync")}
                              disabled={!!busyAction || !shot.dialogue}
                              className="rounded-lg px-2 py-1.5 text-[11px] font-medium"
                              style={{
                                background: shot.lip_sync ? "var(--aurora-accent)" : "var(--aurora-chip)",
                                border: `1px solid ${shot.lip_sync ? "var(--aurora-accent)" : "var(--aurora-border)"}`,
                                color: shot.lip_sync ? "#FFFFFF" : "var(--aurora-fg1)",
                                cursor: "pointer",
                                opacity: !shot.dialogue ? 0.5 : 1,
                              }}
                            >
                              {busyAction === `lipsync:${shot.id}` ? "口型中…" : "对口型"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleShotAction(shot.id, "linkprev")}
                              disabled={!!busyAction || shot.sort_order <= 1}
                              className="rounded-lg px-2 py-1.5 text-[11px] font-medium"
                              style={{
                                background: "var(--aurora-chip)",
                                border: "1px solid var(--aurora-border)",
                                color: "var(--aurora-fg1)",
                                cursor: "pointer",
                                opacity: shot.sort_order <= 1 ? 0.5 : 1,
                              }}
                            >
                              {busyAction === `linkprev:${shot.id}` ? "抽帧中" : "取上镜尾帧"}
                            </button>
                          </div>

                          {shot.tts_preview_path && (
                            <audio
                              src={studioAssetUrl(shot.tts_preview_path)}
                              controls
                              className="w-full h-8"
                            />
                          )}
                        </div>

                        {/* 右侧导演参数编辑 */}
                        <div className="space-y-2.5 min-w-0">
                          <div>
                            <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                              角色台词（格式：角色名: 台词）
                            </label>
                            <input
                              defaultValue={shot.dialogue}
                              onBlur={(e) => {
                                if (e.target.value !== shot.dialogue) {
                                  void handleShotPatch(shot.id, { dialogue: e.target.value });
                                }
                              }}
                              style={fieldStyle}
                            />
                          </div>

                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <div>
                              <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                                导演表演指导（Gemini TTS 演技情绪）
                              </label>
                              <input
                                defaultValue={shot.acting || ""}
                                placeholder="例如：in a trembling hushed whisper..."
                                onBlur={(e) => {
                                  if (e.target.value !== (shot.acting || "")) {
                                    void handleShotPatch(shot.id, { acting: e.target.value });
                                  }
                                }}
                                style={fieldStyle}
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                                顶部规则 / 高能警示徽章（可选）
                              </label>
                              <input
                                defaultValue={shot.overlay_text || ""}
                                placeholder="例如：【铁律第一条】午夜十二点后，绝不开门"
                                onBlur={(e) => {
                                  if (e.target.value !== (shot.overlay_text || "")) {
                                    void handleShotPatch(shot.id, { overlay_text: e.target.value });
                                  }
                                }}
                                style={fieldStyle}
                              />
                            </div>
                          </div>

                          {/* 短剧多机位/景别/口型/首尾帧衔接导演栏 */}
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 items-center">
                            <select
                              value={shot.shot_scale || ""}
                              onChange={(e) => void handleShotPatch(shot.id, { shot_scale: e.target.value })}
                              style={fieldStyle}
                              title="景别（正反打）"
                            >
                              {SHOT_SCALE_OPTIONS.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>

                            <select
                              value={shot.camera_angle || ""}
                              onChange={(e) => void handleShotPatch(shot.id, { camera_angle: e.target.value })}
                              style={fieldStyle}
                              title="机位角度"
                            >
                              {CAMERA_ANGLE_OPTIONS.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>

                            <label
                              className="inline-flex items-center gap-1.5 text-xs cursor-pointer px-2"
                              style={{ color: "var(--aurora-fg2)" }}
                            >
                              <input
                                type="checkbox"
                                checked={Boolean(shot.lip_sync)}
                                onChange={(e) => void handleShotPatch(shot.id, { lip_sync: e.target.checked })}
                              />
                              近景对口型
                            </label>

                            <label
                              className="inline-flex items-center gap-1.5 text-xs cursor-pointer px-2"
                              style={{ color: "var(--aurora-fg2)" }}
                            >
                              <input
                                type="checkbox"
                                checked={Boolean(shot.link_prev)}
                                disabled={shot.sort_order <= 1}
                                onChange={(e) => void handleShotPatch(shot.id, { link_prev: e.target.checked })}
                              />
                              衔接上镜尾帧
                            </label>
                          </div>

                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                            <select
                              value={shot.motion || "zoom_in"}
                              onChange={(e) => void handleShotPatch(shot.id, { motion: e.target.value })}
                              style={fieldStyle}
                              title="运镜"
                            >
                              {MOTION_OPTIONS.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>

                            <select
                              value={shot.voice_space || "indoor_room"}
                              onChange={(e) => void handleShotPatch(shot.id, { voice_space: e.target.value })}
                              style={fieldStyle}
                              title="空间声学"
                            >
                              {VOICE_SPACE_OPTIONS.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>

                            <select
                              value={shot.fx || ""}
                              onChange={(e) => void handleShotPatch(shot.id, { fx: e.target.value })}
                              style={fieldStyle}
                              title="微特效"
                            >
                              {FX_OPTIONS.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>

                            <select
                              value={shot.sfx || ""}
                              onChange={(e) => void handleShotPatch(shot.id, { sfx: e.target.value })}
                              style={fieldStyle}
                              title="点状音效"
                            >
                              {SFX_OPTIONS.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>

                            <select
                              value={shot.transition || ""}
                              onChange={(e) => void handleShotPatch(shot.id, { transition: e.target.value })}
                              style={fieldStyle}
                              title="转场"
                            >
                              {TRANSITION_OPTIONS.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>
                    </Glass>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 2: 角色与配乐 */}
          {activeTab === "cast_audio" && detail && (
            <div className="space-y-4">
              {/* 角色音色库 */}
              <Glass padding="16px" radius={16}>
                <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--aurora-fg1)" }}>
                  角色定妆与棚录音色（{detail.characters.length} 位）
                </h3>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {detail.characters.map((ch: StudioCharacter) => (
                    <div
                      key={ch.id}
                      className="rounded-xl p-3 flex flex-col gap-2"
                      style={{
                        background: "var(--aurora-chip)",
                        border: "1px solid var(--aurora-border)",
                      }}
                    >
                      <div className="flex items-center gap-2.5">
                        {ch.reference_path ? (
                          <img
                            src={studioAssetUrl(ch.reference_path)}
                            alt={ch.name}
                            className="h-12 w-12 rounded-lg object-cover shrink-0"
                          />
                        ) : (
                          <div
                            className="h-12 w-12 rounded-lg flex items-center justify-center shrink-0"
                            style={{ background: "var(--aurora-surface-solid)" }}
                          >
                            <Icon name="user" size={18} />
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate" style={{ color: "var(--aurora-fg1)" }}>
                            {ch.name}
                          </div>
                          <div className="text-xs truncate" style={{ color: "var(--aurora-fg3)" }}>
                            {ch.role || "角色"}
                          </div>
                        </div>
                      </div>
                      <select
                        value={ch.voice}
                        onChange={async (e) => {
                          await studioApi.updateCharacter(ch.id, { voice: e.target.value });
                          await loadEpisode(detail.episode.id);
                          notify(true, `已更新 ${ch.name} 音色为 ${e.target.value}`);
                        }}
                        style={fieldStyle}
                      >
                        {voices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </Glass>

              {/* Lyria 3 Pro 电影配乐 + 片头片尾卡 */}
              <Glass padding="16px" radius={16} className="space-y-3">
                <h3 className="text-sm font-semibold" style={{ color: "var(--aurora-fg1)" }}>
                  Lyria 3 Pro 电影交响原声配乐与包装
                </h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
                  <input
                    value={bgmPrompt}
                    onChange={(e) => setBgmPrompt(e.target.value)}
                    placeholder="描述电影配乐风格（纯器乐无歌词）…"
                    style={fieldStyle}
                  />
                  <Btn
                    icon="music"
                    onClick={handleGenerateBgm}
                    disabled={busyAction === "bgm_gen" || !bgmPrompt.trim()}
                  >
                    {busyAction === "bgm_gen" ? "谱曲中…" : "一键生成电影配乐"}
                  </Btn>
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  <div>
                    <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                      当前绑定配乐
                    </label>
                    <select
                      value={detail.episode.bgm_path || ""}
                      onChange={async (e) => {
                        await studioApi.updateEpisode(detail.episode.id, { bgm_path: e.target.value });
                        await loadEpisode(detail.episode.id);
                      }}
                      style={fieldStyle}
                    >
                      <option value="">无背景配乐</option>
                      {bgmList.map((b) => (
                        <option key={b.path} value={b.path}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                      片头标题卡（| 分隔主副标题）
                    </label>
                    <input
                      defaultValue={detail.episode.title_banner || ""}
                      onBlur={(e) =>
                        void studioApi.updateEpisode(detail.episode.id, { title_banner: e.target.value })
                      }
                      placeholder="《夜班守墓人七条铁律》|第一集 · 午夜敲门声"
                      style={fieldStyle}
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] mb-1" style={{ color: "var(--aurora-fg3)" }}>
                      片尾悬念追更卡（| 分隔三行）
                    </label>
                    <input
                      defaultValue={detail.episode.end_card || ""}
                      onBlur={(e) =>
                        void studioApi.updateEpisode(detail.episode.id, { end_card: e.target.value })
                      }
                      placeholder="第一集 完|门开了……下一秒谁在外面？|关注追更 · 第二集"
                      style={fieldStyle}
                    />
                  </div>
                </div>
              </Glass>
            </div>
          )}

          {/* TAB 3: 成片放映与一键发送到对话播放 */}
          {activeTab === "screening" && detail && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,440px)_1fr]">
              <Glass padding="16px" radius={16} className="min-w-0">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <h3 className="text-sm font-semibold truncate" style={{ color: "var(--aurora-fg1)" }}>
                    {detail.project.name} · {detail.episode.title}
                  </h3>
                  {renderTask && (
                    <Chip>
                      {renderTask.status === "running"
                        ? "渲染中…"
                        : renderTask.status === "succeeded" || renderTask.status === "done"
                        ? "已就绪"
                        : renderTask.status}
                    </Chip>
                  )}
                </div>

                {episodePreviewSrc ? (
                  <VideoPlayer
                    src={episodePreviewSrc}
                    title={`${detail.project.name} · ${detail.episode.title}`}
                  />
                ) : (
                  <div
                    className="rounded-xl p-10 text-center text-xs"
                    style={{ background: "var(--aurora-chip)", color: "var(--aurora-fg4)" }}
                  >
                    尚未渲染成片，请先点击顶部「合成母带」
                  </div>
                )}
              </Glass>

              <Glass padding="18px" radius={16} className="space-y-4 min-w-0">
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: "var(--aurora-fg1)" }}>
                    一键归档并发送到 AI 执事对话中直接播放
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--aurora-fg3)" }}>
                    点击发送后，系统会将最新成片持久化归档至 Memento 媒体库（支持 HTTP 206 Range 拖动、全屏播放与离线缓存），并在所选对话中插入原生视频播放器气泡，桌面端、Web 端与手机端均可随时秒开。
                  </p>
                </div>

                <div>
                  <label className="block text-xs mb-1.5" style={{ color: "var(--aurora-fg2)" }}>
                    目标对话
                  </label>
                  <select
                    value={targetConvId}
                    onChange={(e) => setTargetConvId(e.target.value)}
                    style={fieldStyle}
                  >
                    <option value="">新建专属对话（自动命名为：演播台成片 · {detail.project.name}）</option>
                    {conversations.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title || "未命名对话"}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs mb-1.5" style={{ color: "var(--aurora-fg2)" }}>
                    附带说明（可选）
                  </label>
                  <input
                    value={publishNote}
                    onChange={(e) => setPublishNote(e.target.value)}
                    placeholder="例如：第1集 v4 商业母带，重点听门外红伞女人混响与结尾插销"
                    style={fieldStyle}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2.5 pt-1">
                  <Btn
                    icon="sparkles"
                    onClick={handlePublishToChat}
                    disabled={busyAction === "publish"}
                  >
                    {busyAction === "publish" ? "正在归档并发送…" : "发送到对话直接播放"}
                  </Btn>

                  <Btn
                    icon="rocket"
                    variant="ghost"
                    onClick={() => setActiveTab("publish")}
                  >
                    前往多平台自动分发
                  </Btn>

                  {publishedConvId && (
                    <Btn
                      icon="message"
                      variant="ghost"
                      onClick={() => router.push(`/ask?id=${encodeURIComponent(publishedConvId)}`)}
                    >
                      立即前往对话观看
                    </Btn>
                  )}
                </div>
              </Glass>
            </div>
          )}

          {/* TAB 4: 多平台自动分发中心 */}
          {activeTab === "publish" && detail && (
            <StudioPublishPanel
              episode={detail.episode}
              onNotify={notify}
              onGoScreening={() => setActiveTab("screening")}
            />
          )}
        </>
      )}
    </div>
  );
}

function StudioPluginGate() {
  const { loaded, isPluginReady } = usePlugins();
  if (!loaded) {
    return (
      <div style={{ color: "var(--aurora-fg4)", textAlign: "center", padding: "48px 0", fontSize: 13 }}>
        正在检查演播台插件状态…
      </div>
    );
  }
  if (!isPluginReady("studio")) {
    return (
      <div className="max-w-xl mx-auto py-16 px-4">
        <Glass className="p-7 text-center space-y-4">
          <div
            className="w-12 h-12 rounded-2xl mx-auto flex items-center justify-center"
            style={{
              background: "var(--aurora-accent-soft)",
              color: "var(--aurora-accent)",
              border: "1px solid var(--aurora-border)",
            }}
          >
            <Icon name="film" size={24} />
          </div>
          <h2 className="text-lg font-semibold text-[var(--aurora-fg1)]">
            AI 演播台插件尚未安装或配置
          </h2>
          <p className="text-sm leading-relaxed text-[var(--aurora-fg3)]">
            演播台属于插件市场可选扩展能力。请先前往插件市场安装「AI 演播台」并配置你的 filmkit 引擎地址（或启用当前服务端托管引擎），保存后即可立即使用。
          </p>
          <div className="pt-2 flex items-center justify-center gap-3">
            <Link href="/plugins?highlight=studio" style={{ textDecoration: "none" }}>
              <Btn icon="box">前往插件市场安装配置</Btn>
            </Link>
          </div>
        </Glass>
      </div>
    );
  }
  return <StudioInner />;
}

export default function StudioPage() {
  return (
    <Suspense
      fallback={
        <div style={{ color: "var(--aurora-fg4)", textAlign: "center", padding: "48px 0", fontSize: 13 }}>
          演播台加载中…
        </div>
      }
    >
      <StudioPluginGate />
    </Suspense>
  );
}
