export function getApiBase(): string {
  if (typeof window !== "undefined") {
    const { protocol, hostname, port } = window.location;
    // If accessed via standard ports (80/443) — likely behind reverse proxy, API at same origin
    if (!port || port === "80" || port === "443") {
      return `${protocol}//${hostname}`;
    }
    // Direct access with port — API on port 8001
    return `${protocol}//${hostname}:8001`;
  }
  return "http://localhost:8001";
}

// Keep for import compat — but always call getApiBase() instead
export const API_BASE = "";

/** Authenticated fetch — wraps native fetch with JWT from localStorage. */
export function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = _getToken();
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return fetch(url, { ...init, headers }).then((res) => {
    if (res.status === 401 && typeof window !== "undefined") {
      const onAuthPage = window.location.pathname.startsWith("/auth/");
      localStorage.removeItem("dr_token");
      if (!onAuthPage) {
        window.location.href = "/auth/login";
      }
    }
    return res;
  });
}

interface FetchOptions extends RequestInit {
  token?: string;
  skipCache?: boolean;
}

function _getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("dr_token");
}

// In-flight GET deduplication: if the same URL is requested while a previous
// request is still pending, return the same Promise. Cleared on completion.
const _inflight = new Map<string, Promise<unknown>>();

// Short-lived response cache for idempotent GETs (60s), lives for the tab session.
const _cache = new Map<string, { ts: number; data: unknown }>();
const CACHE_TTL_MS = 60_000;

export function invalidateApiCache(prefix?: string) {
  if (!prefix) { _cache.clear(); return; }
  for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k);
}

async function apiFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const { token, skipCache, ...init } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string>),
  };
  // Public endpoints never attach Authorization and never redirect on 401.
  // Landing page + install bootstrap probes live here.
  const isPublic = path.startsWith("/api/public/");

  // Auto-attach JWT from localStorage (explicit token param takes priority,
  // except for public endpoints which never carry credentials).
  const jwt = isPublic ? undefined : (token || _getToken());
  if (jwt) {
    headers["Authorization"] = `Bearer ${jwt}`;
  }

  const base = getApiBase();
  const method = (init.method || "GET").toUpperCase();
  const cacheKey = method === "GET" && !skipCache ? `${base}${path}` : null;

  if (cacheKey) {
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data as T;
    const pending = _inflight.get(cacheKey) as Promise<T> | undefined;
    if (pending) return pending;
  }

  const run = (async () => {
    const res = await fetch(`${base}${path}`, { ...init, headers });
    if (!res.ok) {
      if (res.status === 401 && typeof window !== "undefined" && !isPublic) {
        const onAuthPage = window.location.pathname.startsWith("/auth/");
        const onLanding = window.location.pathname === "/";
        localStorage.removeItem("dr_token");
        if (!onAuthPage && !onLanding) window.location.href = "/auth/login";
        throw new Error("Unauthorized");
      }
      const text = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${text}`);
    }
    const data = (await res.json()) as T;
    if (cacheKey) _cache.set(cacheKey, { ts: Date.now(), data });
    return data;
  })();

  if (cacheKey) {
    _inflight.set(cacheKey, run);
    run.finally(() => _inflight.delete(cacheKey));
  }
  return run;
}

// --- Types ---

export interface ToolSummary {
  id: string;
  display_name: string;
  icon: string | null;
  total_files: number;
  total_size_bytes: number;
  last_sync_at: string | null;
}

export interface ToolDetail extends ToolSummary {
  categories: Record<string, number>;
}

export interface DocumentSummary {
  id: string;
  relative_path: string;
  category: string;
  content_type: string;
  title: string | null;
  file_size_bytes: number;
  synced_at: string;
  ai_summary?: string | null;
}

export interface DocumentDetail {
  id: string;
  tool_id: string;
  project_id: string | null;
  relative_path: string;
  category: string;
  content_type: string;
  title: string | null;
  content: string | null;
  content_hash: string;
  file_size_bytes: number;
  metadata: Record<string, unknown>;
  ai_summary: string | null;
  synced_at: string;
  created_at: string;
  updated_at: string | null;
}

export interface ConversationMeta {
  id: string;
  tool_id: string;
  title: string | null;
  relative_path: string;
  metadata: Record<string, unknown>;
  message_count: number;
  synced_at: string;
}

export interface ExportDiagnostics {
  step_count?: number;
  assistant_response_count?: number;
  assistant_thinking_count?: number;
  assistant_thinking_only_count?: number;
  assistant_fallback_count?: number;
  step_fetch_failed?: boolean;
  endpoint_count?: number;
  pb_shell_only?: boolean;
  generator_metadata_messages?: number;
  transcript_messages?: number;
  messages_truncated?: boolean;
  offline_vscdb_messages?: number;
  offline_vscdb_assistant_messages?: number;
  offline_vscdb_system_messages?: number;
  chat_export_messages?: number;
  chat_export_user_messages?: number;
  chat_export_action_messages?: number;
  offline_pb_transcript_messages?: number;
  offline_pb_messages?: number;
  offline_pb_total_messages?: number;
  offline_pb_string_count?: number;
  pb_file_present?: boolean;
  brain_file_count?: number;
  browser_recording_frame_count?: number;
  browser_recording_highlight_count?: number;
}

export interface ConversationMessage {
  id: number;
  line_number: number;
  message_type?: string | null;
  role: string | null;
  content: string;
  thinking?: string | null;
  tool_name?: string;
  tool_input?: string;
  raw_type?: string;
  metadata?: Record<string, unknown>;
  timestamp: string | null;
}

export interface MessagesResponse {
  total: number;
  offset: number;
  limit: number;
  messages: ConversationMessage[];
}

export interface DailyDate {
  date: string;
  document_count: number;
  tools?: string[];
}

export interface DailyDetail {
  date: string;
  total_documents: number;
  tools: Record<string, DocumentSummary[]>;
  summaries: { id: string; tool_id: string | null; title: string; summary: string; highlights: unknown }[];
}

export interface SearchResult {
  query: string;
  total: number;
  offset: number;
  limit: number;
  /** True when BGE-M3 vector results were fused in. False = keyword-only
   *  (embedding server down, deep page, or semantic explicitly disabled). */
  semantic_used?: boolean;
  results: SearchHit[];
}

export interface SearchHit {
  id: string;
  tool_id: string;
  relative_path: string;
  category: string;
  title: string | null;
  snippet: string;
  file_size_bytes: number;
  synced_at: string;
  /** Matched by meaning rather than literal text. */
  matched_semantically?: boolean;
}

// Remote device task — work dispatched to a collector on one of your machines
export interface DeviceTask {
  id: string;
  device_id: string;
  action: string;
  payload: Record<string, unknown> | null;
  status: "queued" | "running" | "succeeded" | "failed" | "timeout" | "cancelled";
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
  timeout_seconds: number;
  created_at: string | null;
  dispatched_at: string | null;
  finished_at: string | null;
  /** Risky operations the agent performed (pushed to the phone). */
  alerts?: { label: string; detail: string; tool: string; at?: string }[];
}

export interface DeviceSummary {
  id: string;
  name: string;
  device_id: string;
  collector_version: string | null;
  last_heartbeat: string | null;
  online?: boolean;
  document_count: number;
}

// Backlinks — knowledge-graph derived "what else discussed this?"
export interface BacklinksResult {
  entities: { id: string; name: string; type: string }[];
  related_documents: {
    id: string;
    title: string;
    relative_path: string;
    tool_id: string;
    category: string;
    synced_at: string | null;
    shared_entities: number;
  }[];
}

// Timeline
export interface TimelinePreviewMessage {
  role: string;
  content: string;
  tool_name?: string;
  timestamp: string | null;
}

export interface TimelineArtifact {
  id: string;
  title: string;
  doc_type: string;
  content_preview: string | null;
  file_size_bytes: number;
}

export interface TimelineConversation {
  id: string;
  title: string;
  message_count: number;
  preview_messages: TimelinePreviewMessage[];
  file_size_bytes: number;
}

export interface TimelineEvent {
  // Common
  type: string; // "session" (grouped) or category name (standalone)
  tool_id: string;
  tool_name: string;
  title?: string;
  timestamp: string;
  // Session-grouped events
  session_id?: string;
  conversation?: TimelineConversation;
  artifacts?: TimelineArtifact[];
  // Standalone events (non-session)
  id?: string;
  relative_path?: string;
  content_type?: string;
  ai_summary?: string | null;
  file_size_bytes?: number;
  preview_messages?: TimelinePreviewMessage[];
  message_count?: number;
  content_preview?: string;
}

export interface TimelineResponse {
  project: {
    id: string;
    slug: string;
    title: string;
    tool_id: string;
    source_path: string;
  };
  total: number;
  offset: number;
  limit: number;
  events: TimelineEvent[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  user_id: string;
  role: string;
}

export interface UserInfo {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  collector_token?: string | null;
  avatar_url?: string | null;
}

// --- API functions ---

export interface PublicStats {
  total_documents: number;
  total_messages: number;
  total_devices: number;
  total_tools: number;
}

// --- Resident profile (persona) ---

export interface ProfileVersion {
  id: string;
  status: "draft" | "published";
  version: number | null;
  content: string;
  stats: {
    edited_by_user?: boolean;
    memories?: number;
    user_voice?: { kept: number; corrections: number };
  };
  updated_at: string | null;
  published_at: string | null;
}

export type ProfileDraftStatus =
  | "updated" | "no_llm" | "user_editing" | "no_input" | "llm_failed" | "same_as_published";

export interface ProfileDevice {
  device_id: string;
  name: string;
  online: boolean;
  targets: string[];
  status: { version?: number | null; results?: Record<string, string>; reported_at?: string };
}

export interface ProfileState {
  published: ProfileVersion | null;
  draft: ProfileVersion | null;
  history: { version: number; published_at: string | null }[];
  targets: string[];
  devices: ProfileDevice[];
}

export interface AvatarSettings {
  is_initialized: boolean;
  gender: "male" | "female" | "agent";
  style: string;
  preset_id: string;
  nickname: string;
  avatar_url?: string;
  custom_photo_url?: string;
  theme_color: string;
  outfit_color: string;
  features: string[];
  updated_at?: string;
}

export interface AvatarGenerateResult {
  status: string;
  gender: "male" | "female" | "agent";
  style: string;
  preset_id: string;
  nickname: string;
  features: string[];
  theme_color: string;
  outfit_color: string;
  custom_photo_url?: string;
  analysis_summary: string;
  latency_ms: number;
}

function _invalidateProfile() {
  invalidateApiCache(`${getApiBase()}/api/profile`);
}

type Json = Record<string, unknown>;

/** A GET that skips the short-lived cache (status pages the user refreshes). */
function fresh<T>(path: string): Promise<T> {
  invalidateApiCache(`${getApiBase()}${path}`);
  return apiFetch<T>(path);
}

const post = <T = Json>(path: string, body?: unknown) =>
  apiFetch<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T = Json>(path: string, body: unknown) => apiFetch<T>(path, { method: "PUT", body: JSON.stringify(body) });

export const api = {
  // === Health, learning, evals ===
  getHealthOverview: () => fresh<Json>("/api/health/overview"),
  getEvals: () => fresh<Json>("/api/learning/evals"),
  /** Score retrieval now; rebuild first generates a new question set. */
  runEval: (rebuild = false) => post<Json>(`/api/learning/evals/run?rebuild=${rebuild}`),
  getReviews: () => fresh<Json>("/api/learning/reviews"),
  startReview: () => post<Json>("/api/learning/review"),
  /** {pending, accepted, dismissed, ...}: things the user keeps telling the AI. */
  getCorrections: () => fresh<Json>("/api/learning/corrections"),
  acceptCorrection: (id: string, opts: { statement?: string; general?: boolean } = {}) =>
    post(`/api/learning/corrections/${id}/accept`, {
      ...(opts.statement !== undefined ? { statement: opts.statement } : {}),
      ...(opts.general ? { general: true } : {}),
    }),
  dismissCorrection: (id: string) => post(`/api/learning/corrections/${id}/dismiss`),

  // === Skills ===
  /** {drafts, published, archived, counts, devices} */
  getSkills: () => fresh<Json>("/api/skills"),
  /** edits: title / description / body / slug / project. Editing a published skill ships a new version. */
  editSkill: (id: string, edits: Json) => put(`/api/skills/${id}`, edits),
  publishSkill: (id: string, edits: Json = {}) => post(`/api/skills/${id}/publish`, edits),
  /** action: dismiss | retire | restore | update/apply | update/discard */
  skillAction: (id: string, action: string) => post(`/api/skills/${id}/${action}`),

  // === Todos ===
  /** {open, closed, counts} */
  getTodos: () => fresh<Json>("/api/todos"),
  addTodo: (title: string, extra: { detail?: string; due?: string; project?: string } = {}) =>
    post("/api/todos", { title, ...extra }),
  /** fields: title / detail / project / due ("" clears) / status (open | done | dropped) */
  updateTodo: (id: string, fields: Json) => put(`/api/todos/${id}`, fields),

  // === Push notifications ===
  getNotifySettings: () => fresh<Json>("/api/notify/settings"),
  updateNotifySettings: (fields: Json) => put("/api/notify/settings", fields),
  registerDeviceToken: (token: string, platform = "mobile") =>
    post("/api/notify/device-token", { token, platform }),
  sendTestNotification: () => post("/api/notify/test"),
  getNotificationFeed: (since?: string) =>
    fresh<Array<{ id: string; title: string; body: string; kind?: string; created_at: string; url?: string }>>(
      since ? `/api/notify/feed?since=${encodeURIComponent(since)}` : "/api/notify/feed"
    ),

  // === Memory tiers & dreaming ===
  getMemoryTiers: () => fresh<Json>("/api/memory/tiers"),
  getDreamJournals: (limit = 20, offset = 0) => fresh<Json>(`/api/memory/dreams?limit=${limit}&offset=${offset}`),
  getDreamJournal: (id: string) => apiFetch<Json>(`/api/memory/dreams/${id}`),
  triggerDream: (daysBack = 1, range: { start?: string; end?: string } = {}) =>
    post("/api/memory/dream", {
      days_back: daysBack,
      ...(range.start ? { start_date: range.start } : {}),
      ...(range.end ? { end_date: range.end } : {}),
    }),
  triggerDreamBackfill: (chunkDays = 3, maxChunks = 30) =>
    post("/api/memory/dream/backfill", { chunk_days: chunkDays, max_chunks: maxChunks, run_async: true }),
  getDreamBackfillStatus: () => fresh<Json>("/api/memory/dream/backfill/status"),
  bootstrapMemories: () => post("/api/memory/bootstrap"),
  reviveCoreMemory: (id: string) => post(`/api/memory/core/${id}/revive`),
  /** All core memories, including dormant and superseded ones. */
  getCoreMemories: () => fresh<Json[]>("/api/memory/core"),

  getProfile: () => apiFetch<ProfileState>("/api/profile"),
  regenerateProfileDraft: () =>
    apiFetch<{ status: ProfileDraftStatus; draft: ProfileVersion | null }>(
      "/api/profile/draft/regenerate", { method: "POST" },
    ).finally(_invalidateProfile),
  saveProfileDraft: (content: string) =>
    apiFetch<{ draft: ProfileVersion }>("/api/profile/draft", {
      method: "PUT", body: JSON.stringify({ content }),
    }).finally(_invalidateProfile),
  discardProfileDraft: () =>
    apiFetch<{ status: string }>("/api/profile/draft", { method: "DELETE" }).finally(_invalidateProfile),
  publishProfile: (content?: string) =>
    apiFetch<{ published: ProfileVersion }>("/api/profile/publish", {
      method: "POST", body: JSON.stringify(content === undefined ? {} : { content }),
    }).finally(_invalidateProfile),
  setProfileTargets: (deviceId: string, targets: string[]) =>
    apiFetch<{ device_id: string; targets: string[] }>(
      `/api/profile/devices/${encodeURIComponent(deviceId)}/targets`,
      { method: "PUT", body: JSON.stringify({ targets }) },
    ).finally(_invalidateProfile),
  simulateProfile: (prompt: string, scenario?: string) =>
    apiFetch<{
      reply: string;
      triggered_dimension: "brain" | "communication" | "tech" | "execution" | "project" | "all";
      triggered_rule?: string;
      compliance_status: "pass" | "intercepted" | "adapted";
      latency_ms: number;
    }>("/api/profile/simulate", {
      method: "POST",
      body: JSON.stringify({ prompt, scenario }),
    }),
  // Digital Twin Cartoon Avatar API
  getAvatarSettings: () => fresh<AvatarSettings>("/api/profile/avatar"),
  saveAvatarSettings: (body: AvatarSettings) =>
    apiFetch<{ status: string; settings: AvatarSettings }>("/api/profile/avatar", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteAccount: (confirmation: string) =>
    apiFetch<{ success: boolean; message: string }>("/api/profile/account", {
      method: "DELETE",
      body: JSON.stringify({ confirmation }),
    }),
  generateAvatarFromPhoto: (body: { photo_data?: string; gender?: string; style_preference?: string }) =>
    apiFetch<AvatarGenerateResult>("/api/profile/avatar/generate", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getPublicStats: () => apiFetch<PublicStats>("/api/public/stats"),

  // 24/7 Always-On Proactive Agent API
  getProactiveSettings: () => fresh<ProactiveSettings>("/api/proactive/settings"),
  updateProactiveSettings: (body: Partial<ProactiveSettings>) =>
    apiFetch<{ status: string; settings: ProactiveSettings }>("/api/proactive/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  testMorningBrief: () =>
    apiFetch<{ status: string; message: string }>("/api/proactive/test-morning-brief", { method: "POST" }),
  testEveningReflection: () =>
    apiFetch<{ status: string; message: string }>("/api/proactive/test-evening-reflection", { method: "POST" }),

  // Custom User LLM API
  getLLMSettings: () => fresh<LLMProfileResponse>("/api/profile/llm"),
  updateLLMSettings: (body: LLMUpdateRequest) =>
    apiFetch<{ status: string; settings: LLMSettingsData }>("/api/profile/llm", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  testLLMConnection: (body: LLMTestRequest) =>
    apiFetch<LLMTestResponse>("/api/profile/llm/test", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // 24/7 Autonomous Missions API
  getMissions: (status?: string) =>
    fresh<AgentMissionItem[]>(status ? `/api/missions?status=${encodeURIComponent(status)}` : "/api/missions"),
  getMissionDetail: (id: string) => fresh<AgentMissionItem>(`/api/missions/${id}`),
  createMission: (body: { title: string; goal: string; risk_level?: string; context?: any }) =>
    apiFetch<{ id: string; status: string; title: string }>("/api/missions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  approveMission: (id: string) =>
    apiFetch<{ status: string; message: string }>(`/api/missions/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  rejectMission: (id: string, reason?: string) =>
    apiFetch<{ status: string; message: string }>(`/api/missions/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: reason || "用户驳回" }),
    }),

  // 24/7 Life Rhythm, Screen Time & AI Decision Advisor
  getLifeRhythm: (days = 7, tzOffset?: number) => {
    const tz = tzOffset !== undefined ? tzOffset : new Date().getTimezoneOffset();
    return fresh<DailyLifeRhythm[]>(`/api/life/rhythm?days=${days}&tz_offset=${tz}`);
  },
  syncLifeRhythm: (days = 7, tzOffset?: number) => {
    const tz = tzOffset !== undefined ? tzOffset : new Date().getTimezoneOffset();
    return apiFetch<{ status: string; synced_days: number; records: DailyLifeRhythm[] }>("/api/life/rhythm/sync", {
      method: "POST",
      body: JSON.stringify({ days, tz_offset: tz }),
    });
  },
  recordLifeRhythm: (body: {
    log_date?: string;
    wakeup_time?: string;
    bedtime?: string;
    sleep_hours?: number;
    app_usages: Array<{ name: string; minutes: number; category?: string }>;
  }) => apiFetch<{ status: string; id: string }>("/api/life/rhythm", { method: "POST", body: JSON.stringify(body) }),
  getLifeAdvice: (log_date?: string) =>
    apiFetch<{ status: string; advice: string }>(log_date ? `/api/life/rhythm/advice?log_date=${log_date}` : "/api/life/rhythm/advice", {
      method: "POST",
    }),
  populateSampleLifeRhythm: () =>
    apiFetch<{ status: string; message: string; advice: string }>("/api/life/rhythm/sample", { method: "POST" }),
  clearLifeRhythms: (log_date?: string) =>
    apiFetch<{ status: string; deleted_count: number }>(log_date ? `/api/life/rhythm/clear?log_date=${log_date}` : "/api/life/rhythm/clear", {
      method: "POST",
    }),
  parseScreenTimeImage: (image: string) =>
    apiFetch<{ status: string; log_date: string; apps_count: number; total_screen_minutes: number; apps: any[] }>("/api/life/rhythm/parse-image", {
      method: "POST",
      body: JSON.stringify({ image }),
    }),

  getTools: () => apiFetch<ToolSummary[]>("/api/tools"),
  getTool: (id: string) => apiFetch<ToolDetail>(`/api/tools/${id}`),
  getToolFiles: (id: string, category?: string, offset = 0, limit = 50) => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (category) params.set("category", category);
    return apiFetch<DocumentSummary[]>(`/api/tools/${id}/files?${params}`);
  },
  getDocument: (id: string) => apiFetch<DocumentDetail>(`/api/documents/${id}`),
  getConversation: (id: string) => apiFetch<ConversationMeta>(`/api/conversations/${id}`),
  getMessages: (id: string, offset = 0, limit = 50) =>
    apiFetch<MessagesResponse>(`/api/conversations/${id}/messages?offset=${offset}&limit=${limit}`),
  getDailyDates: (days = 30) => {
    const tz = new Date().getTimezoneOffset();
    return apiFetch<DailyDate[]>(`/api/daily?days=${days}&tz_offset=${tz}`);
  },
  getDaily: (date: string) => {
    const tz = new Date().getTimezoneOffset();
    return apiFetch<DailyDetail>(`/api/daily/${date}?tz_offset=${tz}`);
  },
  search: (q: string, tool?: string, offset = 0, limit = 20, deviceId?: string) => {
    const params = new URLSearchParams({ q, offset: String(offset), limit: String(limit) });
    if (tool) params.set("tool", tool);
    if (deviceId) params.set("device_id", deviceId);
    return apiFetch<SearchResult>(`/api/search?${params}`);
  },
  // === Remote device tasks ===
  listDeviceTasks: (deviceId?: string, status?: string, limit = 50) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (deviceId) p.set("device_id", deviceId);
    if (status) p.set("status", status);
    return apiFetch<DeviceTask[]>(`/api/tasks?${p}`);
  },
  getDeviceTask: (taskId: string) => apiFetch<DeviceTask>(`/api/tasks/${taskId}`),
  dispatchDeviceTask: (
    deviceId: string,
    action: "shell" | "agent",
    payload: Record<string, unknown>,
    timeoutSeconds = 300
  ) =>
    apiFetch<DeviceTask>(`/api/tasks/dispatch/${deviceId}`, {
      method: "POST",
      body: JSON.stringify({ action, payload, timeout_seconds: timeoutSeconds }),
    }),
  cancelDeviceTask: (taskId: string) =>
    apiFetch<DeviceTask>(`/api/tasks/${taskId}/cancel`, { method: "POST" }),
  getBacklinks: (docId: string) =>
    apiFetch<BacklinksResult>(`/api/documents/${docId}/backlinks`),
  register: (email: string, password: string, name?: string, inviteCode?: string) =>
    apiFetch<UserInfo>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, name, invite_code: inviteCode }),
    }),
  getRegistrationMode: () =>
    apiFetch<{ mode: "open" | "invite_only" | "closed"; has_any_user: boolean; github_enabled: boolean }>("/api/auth/registration-mode"),
  login: (email: string, password: string) =>
    apiFetch<TokenResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  getMe: (token: string) => apiFetch<UserInfo>("/api/auth/me", { token }),
  updateProfile: (token: string, data: { name?: string | null; avatar_url?: string | null }) =>
    apiFetch<UserInfo>("/api/auth/me", {
      method: "PATCH",
      token,
      body: JSON.stringify(data),
    }),
  uploadAvatar: async (token: string, file: File): Promise<UserInfo> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${getApiBase()}/api/auth/me/avatar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) {
      const txt = await res.text();
      let msg = txt;
      try {
        const parsed = JSON.parse(txt);
        if (parsed.detail) msg = parsed.detail;
      } catch { /* fallback to txt */ }
      throw new Error(msg);
    }
    return await res.json();
  },
  deleteAvatar: (token: string) =>
    apiFetch<UserInfo>("/api/auth/me/avatar", { method: "DELETE", token }),
  refreshToken: (token: string) =>
    apiFetch<TokenResponse>("/api/auth/refresh", { method: "POST", token }),
  getWechatTicket: () => apiFetch<{ ticket: string; expires_in: number }>("/api/auth/wechat/ticket", { skipCache: true }),
  pollWechatTicket: (ticket: string) =>
    apiFetch<{
      status: "pending" | "success" | "expired" | "not_found" | "registration_closed" | "account_disabled";
      access_token?: string;
      user_id?: string;
      role?: string;
      detail?: string;
    }>(`/api/auth/wechat/poll?ticket=${encodeURIComponent(ticket)}`, { skipCache: true }),
  // === Account-level backup/restore ===
  //
  // exportData hits a binary endpoint so we go around apiFetch's
  // JSON-only flow: fresh fetch with the Bearer header, response.blob()
  // to get the .zip body, then trigger a download via a hidden <a>.
  //
  // importData uploads a multipart body — also off the apiFetch path
  // because that helper hardcodes Content-Type: application/json.
  exportData: async (token: string, includeLogs: boolean): Promise<{ blob: Blob; filename: string; counts: string }> => {
    const url = `${getApiBase()}/api/data/export?include_access_logs=${includeLogs ? "true" : "false"}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Export failed: HTTP ${res.status} ${await res.text()}`);
    const cd = res.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="?([^";]+)"?/i);
    const filename = m?.[1] ?? `memento-export-${new Date().toISOString().slice(0, 10)}.zip`;
    return {
      blob: await res.blob(),
      filename,
      counts: res.headers.get("X-Memento-Counts") || "",
    };
  },
  importData: async (token: string, file: File): Promise<{
    ok: boolean;
    machine_id: string;
    counts: Record<string, number>;
    warnings: string[];
  }> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${getApiBase()}/api/data/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Import failed: HTTP ${res.status} ${txt}`);
    }
    return await res.json();
  },
  rotateCollectorToken: (token: string) =>
    apiFetch<UserInfo>("/api/auth/me/rotate-collector-token", { method: "POST", token }),
  getProjectTimeline: (projectId: string, offset = 0, limit = 50, category?: string, order = "desc") => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit), order });
    if (category) params.set("category", category);
    return apiFetch<TimelineResponse>(`/api/projects/${projectId}/timeline?${params}`);
  },
  listAskConversations: (deviceId?: string) => {
    const q = deviceId && deviceId !== "auto" && deviceId !== "ask_only" && deviceId !== "all"
      ? `?device_id=${encodeURIComponent(deviceId)}`
      : "";
    return apiFetch<AskConversationSummary[]>(`/api/ask/conversations${q}`);
  },
  getAskConversation: (id: string) =>
    apiFetch<AskConversationDetail>(`/api/ask/conversations/${id}`),
  updateAskConversation: (
    id: string,
    patch: Partial<{
      title: string;
      device_id: string;
      cwd: string;
      execution_mode: string;
      model: string;
      effort: string;
      project_id: string;
      session_id: string;
      worktree: boolean;
      compact_mode: boolean;
      config: Record<string, any>;
    }>
  ) =>
    apiFetch<{ ok: boolean; config?: Record<string, any> }>(`/api/ask/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  deleteAskConversation: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/ask/conversations/${id}`, { method: "DELETE" }),
  listAskRuns: (recentSeconds = 0) =>
    apiFetch<AskRunSummary[]>(`/api/ask/runs${recentSeconds > 0 ? `?recent=${recentSeconds}` : ""}`),
  cancelAskRun: (convId: string) =>
    apiFetch<{ status: string }>(`/api/ask/conversations/${convId}/cancel`, { method: "POST" }),
  listProjects: (toolId?: string, deviceId?: string) => {
    const params = new URLSearchParams();
    if (toolId) params.set("tool_id", toolId);
    if (deviceId && deviceId !== "auto" && deviceId !== "ask_only" && deviceId !== "all") {
      params.set("device_id", deviceId);
    }
    const q = params.toString() ? `?${params.toString()}` : "";
    return apiFetch<ProjectSummary[]>(`/api/projects${q}`);
  },
  getProjectConversations: (projectId: string, offset = 0, limit = 50, order = "desc", deviceId?: string) => {
    const params = new URLSearchParams({ session_offset: String(offset), session_limit: String(limit), order });
    if (deviceId && deviceId !== "auto" && deviceId !== "ask_only" && deviceId !== "all") {
      params.set("device_id", deviceId);
    }
    return apiFetch<{
      project: { id: string; slug: string; title: string; source_path: string };
      sessions: Array<{
        session_id: string;
        title: string;
        conversation_id: string;
        timestamp: string;
        message_count: number;
        file_size_bytes?: number;
        estimated_tokens?: number;
        compact_recommended?: boolean;
        messages?: Array<{
          role: string;
          content: string;
          timestamp?: string;
          raw_type?: string;
          subagent_name?: string;
        }>;
      }>;
      total_sessions: number;
    }>(`/api/projects/${projectId}/conversations?${params}`);
  },

  getSessionStats: (sessionId: string) =>
    apiFetch<{
      session_id: string;
      message_count: number;
      char_count: number;
      estimated_tokens: number;
      file_size_bytes: number;
      status: "normal" | "heavy" | "overflow_risk";
      compact_recommended: boolean;
    }>(`/api/conversations/${sessionId}/stats`),

  compactConversation: (sessionId: string, newPrompt = "", recentTurns = 6) =>
    apiFetch<{
      session_id: string;
      title: string;
      checkpoint: string;
      injected_context: string;
      new_prompt_with_context: string;
    }>(`/api/conversations/${sessionId}/compact`, {
      method: "POST",
      body: JSON.stringify({ new_prompt: newPrompt, recent_turns: recentTurns }),
    }),

  getAgentCapabilities: (tool: string, deviceId?: string) => {
    const params = new URLSearchParams({ tool });
    if (deviceId && deviceId !== "auto" && deviceId !== "ask_only") {
      params.set("device_id", deviceId);
    }
    return apiFetch<AgentCapabilities>(`/api/agent/capabilities?${params}`);
  },
};

export interface AgentModelOption {
  id: string;
  name: string;
  desc?: string;
  is_default?: boolean;
}

export interface AgentEffortOption {
  id: string;
  name: string;
  desc?: string;
}

export interface AgentCapabilities {
  tool: string;
  models: AgentModelOption[];
  default_model: string;
  supports_effort: boolean;
  default_effort: string;
  effort_options: AgentEffortOption[];
}

export interface ProjectSummary {
  id: string;
  slug: string;
  title: string;
  tool_id: string;
  source_path: string;
  visibility: string;
  document_count: number;
  created_at: string;
  updated_at: string | null;
}

export interface AskConversationSummary {
  id: string;
  title: string;
  created_at: string | null;
  updated_at: string | null;
  device_id: string | null;
  cwd?: string | null;
  config?: Record<string, any>;
  message_count: number;
}

export interface AskConversationDetail {
  id: string;
  title: string;
  turns: Array<{
    role: "user" | "assistant";
    content: string;
    thinking?: string;
    sources?: any[];
    toolCalls?: any[];
    created_at?: string;
  }>;
  device_id: string | null;
  cwd: string | null;
  execution_mode?: string;
  model?: string;
  effort?: string;
  project_id?: string;
  session_id?: string;
  worktree?: boolean;
  compact_mode?: boolean;
  config?: Record<string, any>;
  created_at: string | null;
  updated_at: string | null;
}

export interface AskRunSummary {
  conversation_id: string;
  title: string;
  question: string;
  execution_mode?: string | null;
  model?: string | null;
  device_name?: string | null;
  started_at: number;
  finished_at?: number | null;
  elapsed_seconds: number;
  done: boolean;
  cancelled: boolean;
  failed: boolean;
  current_step?: string;
  step_type?: "init" | "thinking" | "tool_call" | "executing" | "tool_result" | "generating" | "done" | "cancelled" | "error";
  tool_name?: string | null;
  events: number;
}

export interface ProactiveSettings {
  enabled: boolean;
  morning_brief_enabled: boolean;
  morning_brief_time: string;
  evening_reflection_enabled: boolean;
  evening_reflection_time: string;
  device_alert_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  timezone_offset_hours: number;
  auto_approve_safe: boolean;
}

export interface AgentMissionItem {
  id: string;
  title: string;
  goal: string;
  status: "queued" | "running" | "waiting_approval" | "paused" | "succeeded" | "failed" | "cancelled";
  risk_level: string;
  current_step: number;
  steps_count?: number;
  steps?: any[];
  pending_action?: any;
  summary?: string;
  error?: string;
  last_heartbeat?: string;
  created_at?: string;
}

export interface DailyLifeRhythm {
  id: string;
  date: string;
  wakeup_time: string | null;
  bedtime: string | null;
  sleep_hours: number | null;
  total_screen_minutes: number;
  productive_minutes: number;
  distraction_minutes: number;
  app_usages: Array<{
    name: string;
    category: "work" | "social" | "entertainment" | "reading" | "general";
    minutes: number;
    icon?: string;
  }>;
  ai_advice: string | null;
}

export interface LLMPreset {
  id: string;
  name: string;
  icon: string;
  base_url: string;
  models: string[];
  default_model: string;
  default_background_model: string;
  help_url: string;
}

export interface LLMSettingsData {
  custom_enabled: boolean;
  provider: string;
  base_url: string;
  api_key_masked: string;
  has_api_key: boolean;
  primary_model: string;
  background_model: string;
  fallback_model: string;
  temperature: number;
  max_tokens: number;
}

export interface LLMProfileResponse {
  settings: LLMSettingsData;
  system_default: {
    base_url: string;
    model: string;
    provider: string;
  };
  presets: LLMPreset[];
}

export interface LLMUpdateRequest {
  custom_enabled?: boolean;
  provider?: string;
  base_url?: string;
  api_key?: string;
  primary_model?: string;
  background_model?: string;
  fallback_model?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface LLMTestRequest {
  provider?: string;
  base_url?: string;
  api_key?: string;
  primary_model?: string;
}

export interface LLMTestResponse {
  success: boolean;
  latency_ms: number;
  reply?: string;
  error?: string;
  provider?: string;
  model?: string;
}
