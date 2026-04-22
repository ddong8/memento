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
  const { token, ...init } = opts;
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
  const cacheKey = method === "GET" ? `${base}${path}` : null;

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
  results: {
    id: string;
    tool_id: string;
    relative_path: string;
    category: string;
    title: string | null;
    snippet: string;
    file_size_bytes: number;
    synced_at: string;
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
}

// --- API functions ---

export interface PublicStats {
  total_documents: number;
  total_messages: number;
  total_devices: number;
  total_tools: number;
}

export const api = {
  getPublicStats: () => apiFetch<PublicStats>("/api/public/stats"),
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
  search: (q: string, tool?: string, offset = 0, limit = 20) => {
    const params = new URLSearchParams({ q, offset: String(offset), limit: String(limit) });
    if (tool) params.set("tool", tool);
    return apiFetch<SearchResult>(`/api/search?${params}`);
  },
  register: (email: string, password: string, name?: string, inviteCode?: string) =>
    apiFetch<UserInfo>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, name, invite_code: inviteCode }),
    }),
  getRegistrationMode: () =>
    apiFetch<{ mode: "open" | "invite_only" | "closed"; has_any_user: boolean }>("/api/auth/registration-mode"),
  login: (email: string, password: string) =>
    apiFetch<TokenResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  getMe: (token: string) => apiFetch<UserInfo>("/api/auth/me", { token }),
  rotateCollectorToken: (token: string) =>
    apiFetch<UserInfo>("/api/auth/me/rotate-collector-token", { method: "POST", token }),
  getProjectTimeline: (projectId: string, offset = 0, limit = 50, category?: string, order = "desc") => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit), order });
    if (category) params.set("category", category);
    return apiFetch<TimelineResponse>(`/api/projects/${projectId}/timeline?${params}`);
  },
};
