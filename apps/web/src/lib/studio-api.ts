"use client";

import { authFetch, getApiBase } from "@/lib/api-client";

export interface StudioProject {
  id: string;
  name: string;
  slug: string;
  style: string;
  aspect: string;
  default_engine: string;
  bgm_path: string;
  preset?: string;
}

export interface StudioPreset {
  label: string;
  style: string;
  subtitle_preset: string;
}

export interface StudioBatchState {
  running: boolean;
  mode: "" | "generate" | "animate" | "upscale";
  total: number;
  done: number;
  succeeded: number;
  failed: number;
  current_shot?: number;
  errors: string[];
  updated_at?: number;
}

export interface StudioCharacter {
  id: string;
  project_id: string;
  name: string;
  role: string;
  look: string;
  voice: string;
  rate: string;
  pitch: string;
  reference_path: string;
}

export interface StudioEpisode {
  id: string;
  project_id: string;
  title: string;
  slug: string;
  aspect: string;
  engine: string;
  transition: string;
  transition_duration: number;
  subtitle_preset: string;
  title_banner: string;
  end_card?: string;
  duck_bgm: boolean;
  bgm_volume: number;
  bgm_path: string;
  story_text: string;
  story_confirmed?: boolean;
  story_confirmed_at?: number | null;
  last_task_id: string;
  shot_count?: number;
  ready_count?: number;
  total_duration?: number;
}

export interface StudioShotCandidate {
  id: string;
  path: string;
  kind: "image" | "clip";
  source: string;
  created_at: number;
}

export interface StudioShot {
  id: string;
  episode_id: string;
  sort_order: number;
  shot_type: "image" | "clip" | "comfy";
  duration: number;
  motion: string;
  transition?: string;
  sfx?: string;
  fx?: string;
  acting?: string;
  voice_space?: string;
  overlay_text?: string;
  shot_scale?: string;
  camera_angle?: string;
  lip_sync?: boolean;
  link_prev?: boolean;
  cast: string[];
  dialogue: string;
  subtitle: string;
  prompt: string;
  active_candidate_id: string;
  candidates: StudioShotCandidate[];
  active_candidate: StudioShotCandidate | null;
  tts_preview_path: string;
}

export interface StudioTask {
  id: string;
  status: string;
  title?: string;
  error?: string;
  progress?: number;
  output_video?: string;
}

export interface StudioEpisodeDetail {
  project: StudioProject;
  episode: StudioEpisode;
  characters: StudioCharacter[];
  shots: StudioShot[];
  last_task: StudioTask | null;
}

export interface StudioVoiceOption {
  id: string;
  label: string;
  gender: string;
}

export interface StudioBgmItem {
  name: string;
  path: string;
  size: number;
  url: string;
  model?: string;
}

export interface StudioComputeState {
  status: "offline" | "connecting" | "awaiting_gpu" | "booting" | "ready" | "stopping" | "error";
  stage: string;
  gpu: string;
  vram_total_gb: number;
  vram_free_gb: number;
  comfy_url: string;
  uptime_sec: number;
  est_cu_used: number;
  auto_shutdown_in_sec: number | null;
  error: string;
}

export interface StudioHealth {
  online: boolean;
  filmkit_url: string;
  compute: StudioComputeState | null;
  error: string;
}

export interface PublishToChatResult {
  ok: boolean;
  conversation_id: string;
  conversation_title: string;
  title: string;
  video_url: string;
  canonical_video_url: string;
  size_bytes: number;
}

export interface StudioSettings {
  publish_agent_url?: string;
  publish_agent_token_set?: boolean;
  publish_default_mode?: "draft" | "publish";
  publish_dedup_remux?: boolean;
  upscale_enabled?: boolean;
  [key: string]: unknown;
}

export interface PublishPlatformAgentStatus {
  platform: string;
  adapter: string;
  logged_in: boolean;
  ready: boolean;
  detail: string;
}

export interface PublishPlatformMeta {
  id: string;
  name: string;
  adapter: "playwright" | "biliup" | "youtube_api";
  login_url: string;
  upload_url: string;
  max_title: number;
  max_desc: number;
  max_tags: number;
  supports_draft: boolean;
  supports_schedule: boolean;
  style_hint: string;
  agent_status: PublishPlatformAgentStatus | null;
}

export interface PublishAgentInfo {
  online: boolean;
  mode?: "pull" | "push";
  last_seen?: number | null;
  url: string;
  playwright: boolean;
  biliup: boolean;
  chrome: boolean;
  error: string;
  platform_status: Record<string, PublishPlatformAgentStatus>;
}

export interface PublishCoverCandidate {
  name: string;
  path: string;
  url: string;
}

export interface PublishJob {
  id: string;
  project_id: string;
  episode_id: string;
  platform: string;
  status: string;
  mode: "draft" | "publish";
  title: string;
  description: string;
  tags: string[];
  cover_path: string;
  video_path: string;
  video_sha256: string;
  scheduled_at: string;
  agent_job_id: string;
  published_url: string;
  error: string;
  logs: string[];
  already_published?: boolean;
  created_at: number;
  updated_at: number;
}

export interface EpisodePublishOverview {
  episode: StudioEpisode;
  video: { name: string; path: string; size_bytes: number; url: string } | null;
  covers: PublishCoverCandidate[];
  jobs: PublishJob[];
  has_zip: boolean;
  zip_url: string;
}

async function studioReq<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getApiBase().replace(/\/+$/, "");
  const res = await authFetch(`${base}${path}`, init);
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const data = await res.json();
      if (data?.detail) {
        msg = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
      }
    } catch {
      const txt = await res.text().catch(() => "");
      if (txt) msg = txt.slice(0, 240);
    }
    throw new Error(msg);
  }
  return res.json();
}

function jsonPost(method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function tokenParam(): string {
  if (typeof window === "undefined") return "";
  const tok = localStorage.getItem("dr_token") || "";
  return tok ? `token=${encodeURIComponent(tok)}` : "";
}

export function studioAssetUrl(relPath: string): string {
  const base = getApiBase().replace(/\/+$/, "");
  const tok = tokenParam();
  const q = `path=${encodeURIComponent(relPath)}${tok ? `&${tok}` : ""}`;
  return `${base}/api/studio/assets?${q}`;
}

export function studioEpisodeVideoUrl(episodeId: string, version?: string | number, stream = false): string {
  const base = getApiBase().replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (typeof window !== "undefined") {
    const tok = localStorage.getItem("dr_token") || "";
    if (tok) params.set("token", tok);
  }
  if (version !== undefined && String(version).trim() !== "") {
    params.set("v", String(version).trim());
  }
  if (stream) params.set("quality", "stream");
  const qs = params.toString();
  return `${base}/api/studio/episodes/${encodeURIComponent(episodeId)}/latest-video${qs ? `?${qs}` : ""}`;
}

export function studioPublishBundleUrl(episodeId: string): string {
  const base = getApiBase().replace(/\/+$/, "");
  const tok = tokenParam();
  return `${base}/api/studio/episodes/${encodeURIComponent(episodeId)}/publish/bundle.zip${tok ? `?${tok}` : ""}`;
}

export const studioApi = {
  health: () => studioReq<StudioHealth>("/api/studio/health"),
  computeStatus: () => studioReq<{ compute: StudioComputeState }>("/api/studio/compute/status"),
  computeStart: (models?: string) =>
    studioReq<{ compute: StudioComputeState }>("/api/studio/compute/start", jsonPost("POST", { models })),
  computeStop: () =>
    studioReq<{ compute: StudioComputeState }>("/api/studio/compute/stop", jsonPost("POST", {})),
  computeExtend: (minutes = 15) =>
    studioReq<{ compute: StudioComputeState }>("/api/studio/compute/extend", jsonPost("POST", { minutes })),

  listPresets: () => studioReq<{ presets: Record<string, StudioPreset> }>("/api/studio/presets"),
  listProjects: () => studioReq<{ projects: StudioProject[] }>("/api/studio/projects"),
  createProject: (body: { name: string; style?: string; aspect?: string; default_engine?: string; preset?: string }) =>
    studioReq<{ project: StudioProject; default_episode?: StudioEpisode; episode?: StudioEpisode }>(
      "/api/studio/projects",
      jsonPost("POST", body)
    ),
  getProject: (pid: string) =>
    studioReq<{ project: StudioProject; characters: StudioCharacter[]; episodes: StudioEpisode[] }>(
      `/api/studio/projects/${encodeURIComponent(pid)}`
    ),

  createEpisode: (pid: string, body: { title: string; aspect?: string; engine?: string; story_text?: string }) =>
    studioReq<{ episode: StudioEpisode }>(
      `/api/studio/projects/${encodeURIComponent(pid)}/episodes`,
      jsonPost("POST", body)
    ),
  getEpisode: (eid: string) =>
    studioReq<StudioEpisodeDetail>(`/api/studio/episodes/${encodeURIComponent(eid)}`),
  updateEpisode: (eid: string, patch: Partial<StudioEpisode>) =>
    studioReq<{ episode: StudioEpisode }>(
      `/api/studio/episodes/${encodeURIComponent(eid)}`,
      jsonPost("PATCH", patch)
    ),
  breakdownEpisode: (eid: string, story_text: string, shots = 8) =>
    studioReq<{ shots: StudioShot[]; characters: StudioCharacter[]; engine?: string }>(
      `/api/studio/episodes/${encodeURIComponent(eid)}/breakdown`,
      jsonPost("POST", { story_text, shots })
    ),
  syncAudioDurations: (eid: string) =>
    studioReq<{ shots: StudioShot[]; adjusted: Array<{ shot_id: string; duration: number }> }>(
      `/api/studio/episodes/${encodeURIComponent(eid)}/sync-audio-durations`,
      jsonPost("POST", {})
    ),
  renderEpisode: (eid: string) =>
    studioReq<{ task: StudioTask; compute_started?: boolean }>(
      `/api/studio/episodes/${encodeURIComponent(eid)}/render`,
      jsonPost("POST", {})
    ),
  publishToChat: (eid: string, body: { conversation_id?: string | null; task_id?: string | null; note?: string }) =>
    studioReq<PublishToChatResult>(
      `/api/studio/episodes/${encodeURIComponent(eid)}/publish-to-chat`,
      jsonPost("POST", body)
    ),

  createCharacter: (pid: string, body: { name: string; role?: string; look?: string; voice?: string }) =>
    studioReq<{ character: StudioCharacter }>(
      `/api/studio/projects/${encodeURIComponent(pid)}/characters`,
      jsonPost("POST", body)
    ),
  updateCharacter: (cid: string, patch: Partial<StudioCharacter>) =>
    studioReq<{ character: StudioCharacter }>(
      `/api/studio/characters/${encodeURIComponent(cid)}`,
      jsonPost("PATCH", patch)
    ),
  deleteCharacter: (cid: string) =>
    studioReq<{ ok: boolean }>(`/api/studio/characters/${encodeURIComponent(cid)}`, jsonPost("DELETE")),

  updateShot: (sid: string, patch: Partial<StudioShot>) =>
    studioReq<{ shot: StudioShot }>(`/api/studio/shots/${encodeURIComponent(sid)}`, jsonPost("PATCH", patch)),
  generateShot: (sid: string, count = 1) =>
    studioReq<{ shot: StudioShot }>(
      `/api/studio/shots/${encodeURIComponent(sid)}/generate`,
      jsonPost("POST", { count })
    ),
  pickShot: (sid: string, candidate_id: string) =>
    studioReq<{ shot: StudioShot }>(
      `/api/studio/shots/${encodeURIComponent(sid)}/pick`,
      jsonPost("POST", { candidate_id })
    ),
  ttsPreviewShot: (sid: string) =>
    studioReq<{ shot: StudioShot; url: string; engine?: string }>(
      `/api/studio/shots/${encodeURIComponent(sid)}/tts-preview`,
      jsonPost("POST", {})
    ),
  animateShot: (sid: string) =>
    studioReq<{ shot: StudioShot; url: string; source?: string }>(
      `/api/studio/shots/${encodeURIComponent(sid)}/animate`,
      jsonPost("POST", {})
    ),
  usePrevLastFrame: (sid: string) =>
    studioReq<{ shot: StudioShot; url: string }>(
      `/api/studio/shots/${encodeURIComponent(sid)}/use-prev-last-frame`,
      jsonPost("POST", {})
    ),
  lipsyncShot: (sid: string) =>
    studioReq<{ shot: StudioShot; url: string; source?: string }>(
      `/api/studio/shots/${encodeURIComponent(sid)}/lipsync`,
      jsonPost("POST", {})
    ),
  batchGenerate: (eid: string, body: { force?: boolean; max_workers?: number } = {}) =>
    studioReq<{ batch: StudioBatchState }>(
      `/api/studio/episodes/${encodeURIComponent(eid)}/batch-generate`,
      jsonPost("POST", body)
    ),
  batchAnimate: (eid: string, body: { force?: boolean; chain_frames?: boolean; max_workers?: number } = {}) =>
    studioReq<{ batch: StudioBatchState }>(
      `/api/studio/episodes/${encodeURIComponent(eid)}/batch-animate`,
      jsonPost("POST", body)
    ),
  batchStatus: (eid: string) =>
    studioReq<{ batch: StudioBatchState }>(`/api/studio/episodes/${encodeURIComponent(eid)}/batch-status`),

  listVoices: () => studioReq<{ voices: StudioVoiceOption[] }>("/api/studio/voices"),
  listBgm: () => studioReq<{ items: StudioBgmItem[] }>("/api/studio/bgm"),
  generateBgm: (prompt: string, name = "lyria_score", model = "lyria-3-pro-preview") =>
    studioReq<{ item: StudioBgmItem }>(
      "/api/studio/bgm/generate",
      jsonPost("POST", { prompt, name, model })
    ),
  getTask: (tid: string) => studioReq<{ task: StudioTask }>(`/api/studio/tasks/${encodeURIComponent(tid)}`),

  getSettings: () => studioReq<{ settings: StudioSettings }>("/api/studio/settings"),
  updateSettings: (patch: Record<string, unknown>) =>
    studioReq<{ settings: StudioSettings }>("/api/studio/settings", jsonPost("PUT", patch)),

  confirmStory: (eid: string, confirmed = true) =>
    studioReq<{ episode: StudioEpisode }>(
      `/api/studio/episodes/${encodeURIComponent(eid)}/confirm-story`,
      jsonPost("POST", { confirmed })
    ),
  batchUpscale: (eid: string, body: { force?: boolean } = {}) =>
    studioReq<{ batch: StudioBatchState }>(
      `/api/studio/episodes/${encodeURIComponent(eid)}/batch-upscale`,
      jsonPost("POST", body)
    ),

  getPublishPlatforms: () =>
    studioReq<{ platforms: PublishPlatformMeta[]; agent: PublishAgentInfo }>("/api/studio/publish/platforms"),
  getEpisodeStreamStatus: (episodeId: string) =>
    studioReq<{ ready: boolean; variant: string }>(
      `/api/studio/episodes/${encodeURIComponent(episodeId)}/stream-status`
    ),
  triggerPublishLogin: (platform: string) =>
    studioReq<{ ok: boolean; platform: string; pid?: number; message?: string }>(
      "/api/studio/publish/agent/login",
      jsonPost("POST", { platform })
    ),
  getEpisodePublish: (eid: string) =>
    studioReq<EpisodePublishOverview>(`/api/studio/episodes/${encodeURIComponent(eid)}/publish`),
  prepareEpisodePublish: (
    eid: string,
    body: { platforms: string[]; mode?: "draft" | "publish"; force_copy?: boolean }
  ) =>
    studioReq<{ covers: PublishCoverCandidate[]; jobs: PublishJob[]; zip_url: string; dedup_remux: boolean }>(
      `/api/studio/episodes/${encodeURIComponent(eid)}/publish/prepare`,
      jsonPost("POST", body)
    ),
  patchPublishJob: (
    jid: string,
    patch: {
      title?: string;
      description?: string;
      tags?: string[];
      cover_path?: string;
      mode?: "draft" | "publish";
      scheduled_at?: string;
    }
  ) =>
    studioReq<{ job: PublishJob }>(
      `/api/studio/publish/jobs/${encodeURIComponent(jid)}`,
      jsonPost("PATCH", patch)
    ),
  deletePublishJob: (jid: string) =>
    studioReq<{ ok: boolean }>(`/api/studio/publish/jobs/${encodeURIComponent(jid)}`, jsonPost("DELETE")),
  dispatchPublishJob: (jid: string, force = false) =>
    studioReq<{ job: PublishJob }>(
      `/api/studio/publish/jobs/${encodeURIComponent(jid)}/dispatch`,
      jsonPost("POST", { force })
    ),
  dispatchBatchPublish: (eid: string, body: { job_ids?: string[]; force?: boolean } = {}) =>
    studioReq<{ dispatched: PublishJob[]; errors: Array<{ job_id: string; platform: string; detail: string }> }>(
      `/api/studio/episodes/${encodeURIComponent(eid)}/publish/dispatch-batch`,
      jsonPost("POST", body)
    ),
  syncPublishJob: (jid: string) =>
    studioReq<{ job: PublishJob; sync_error?: string }>(
      `/api/studio/publish/jobs/${encodeURIComponent(jid)}/sync`
    ),
  confirmPublishJob: (jid: string) =>
    studioReq<{ job: PublishJob }>(
      `/api/studio/publish/jobs/${encodeURIComponent(jid)}/confirm`,
      jsonPost("POST", {})
    ),
};
