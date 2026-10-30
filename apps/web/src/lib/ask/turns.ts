import { stripTransientStatusPrefix } from "@/components/viewers/MarkdownViewer";
import { ToolCallItem } from "@/components/ExecutionCard";

export type ExecutionMode = "ai" | "claude" | "codex" | "antigravity" | "workbuddy" | "shell";
export interface Source {
  id: string;
  title: string;
  relative_path: string;
  tool_id: string;
  category: string;
  synced_at: string | null;
  excerpt: string;
}

/** Where a client is in a run's event stream (see server services/ask_runs.py). */
export interface RunCursor {
  lastId: number;
  convId: string | null;
  executionMode?: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
  images?: string[];
  thinking?: string;
  sources?: Source[];
  toolCalls?: ToolCallItem[];
  error?: boolean;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  model?: string;
  execution_mode?: string;
  cached?: boolean;
}

/**
 * The saved turns of a run that has ended, keeping what the page streamed where the save has not
 * caught up yet (a reply still empty, no tool calls). Neither list is changed: the saved one may
 * be the request cache's own object.
 */
export function mergeFinishedTurns(shown: Turn[], saved: Turn[]): Turn[] {
  const prevLast = shown[shown.length - 1];
  const nextLast = saved[saved.length - 1];
  if (prevLast?.role !== "assistant" || nextLast?.role !== "assistant") return saved;
  const keepContent = Boolean(prevLast.content?.trim()) && !nextLast.content?.trim();
  const keepCalls = Boolean(prevLast.toolCalls?.length) && !nextLast.toolCalls?.length;
  if (!keepContent && !keepCalls) return saved;
  return [
    ...saved.slice(0, -1),
    {
      ...nextLast,
      ...(keepContent ? { content: prevLast.content } : {}),
      ...(keepCalls ? { toolCalls: prevLast.toolCalls } : {}),
    },
  ];
}

const turnSignature = (t: Turn | undefined) =>
  t ? [t.role, t.created_at || "", t.content?.length ?? 0, t.toolCalls?.length ?? 0, t.error ? 1 : 0].join("|") : "";

/**
 * Whether the saved turns (the last `limit` of the conversation) show anything the screen does
 * not. Compared from the end: the screen may also hold earlier history loaded on top.
 */
export function turnsChanged(shown: Turn[], saved: Turn[], limit: number): boolean {
  if (saved.length > shown.length) return true;
  if (saved.length < shown.length && shown.length <= limit) return true;
  for (let k = 1; k <= Math.min(2, saved.length); k++) {
    if (turnSignature(shown[shown.length - k]) !== turnSignature(saved[saved.length - k])) return true;
  }
  return false;
}

export function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onDone);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onDone);
        window.removeEventListener("memento_wake_stream", onDone);
        window.removeEventListener("memento_app_active", onDone);
        document.removeEventListener("visibilitychange", onVisChange);
      }
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onVisChange = () => {
      if (document.visibilityState === "visible") {
        onDone();
      }
    };
    timer = setTimeout(onDone, ms);
    signal?.addEventListener("abort", onDone);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onDone);
      window.addEventListener("memento_wake_stream", onDone);
      window.addEventListener("memento_app_active", onDone);
      document.addEventListener("visibilitychange", onVisChange);
    }
  });
}

export async function compressImageToDataUrl(file: File, maxDim = 1600, quality = 0.85): Promise<string> {
  // 1. 优先使用 OffscreenCanvas 与 createImageBitmap，GPU/后台线程异步解码与绘制，0ms 阻塞 UI 主线程
  if (typeof window !== "undefined" && "createImageBitmap" in window && "OffscreenCanvas" in window) {
    try {
      const bitmap = await createImageBitmap(file);
      let { width, height } = bitmap;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();

        // 优先使用现代 WebP 格式（体积减少 35% 且保留透明通道），降级为 JPEG
        let blob: Blob | null = null;
        try {
          blob = await canvas.convertToBlob({ type: "image/webp", quality });
        } catch {
          blob = null;
        }
        if (!blob || blob.type !== "image/webp") {
          blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
        }

        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob!);
        });
      }
    } catch {
      // 降级回退到标准 Image + Canvas
    }
  }

  // 2. 经典 DOM Canvas 兜底
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(e.target?.result as string);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        // 优先 WebP 编码，不支持则降级为 JPEG
        let dataUrl = canvas.toDataURL("image/webp", quality);
        if (!dataUrl.startsWith("data:image/webp")) {
          dataUrl = canvas.toDataURL("image/jpeg", quality);
        }
        resolve(dataUrl);
      };
      img.onerror = () => resolve(e.target?.result as string);
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function parseTurnContent(turn: Turn): { thinking: string; content: string } {
  let thinking = (turn.thinking || "").trim();
  let content = turn.content || "";

  if (content.includes("<think>")) {
    const match = content.match(/<think>([\s\S]*?)(?:<\/think>|$)/);
    if (match) {
      if (!thinking) {
        thinking = match[1].trim();
      }
      content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
    }
  }
  content = stripTransientStatusPrefix(content);
  return { thinking, content };
}
export function formatRelativeTime(dateStr: string | null, isZh: boolean): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return isZh ? "刚刚" : "just now";
  if (mins < 60) return isZh ? `${mins} 分钟前` : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return isZh ? `${hrs} 小时前` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return isZh ? `${days} 天前` : `${days}d ago`;
  return d.toLocaleDateString();
}

export function formatExcerpt(raw: string): string {
  if (!raw) return "";
  let text = raw.trim();

  // If text is wrapped in or contains raw JSON line(s)
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const obj = JSON.parse(text);
      if (obj.content) {
        text = typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content);
      } else if (obj.payload?.message) {
        text = obj.payload.message;
      } else if (obj.message?.content) {
        const mc = obj.message.content;
        text = typeof mc === "string" ? mc : JSON.stringify(mc);
      } else if (obj.type === "session_meta") {
        return "会话启动信息";
      }
    } catch {
      // not a single JSON
    }
  }

  // Strip Antigravity & AI tool XML tags
  text = text.replace(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g, "用户: $1");
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "");
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "");
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  text = text.replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "");

  // If still raw session_meta JSON
  if (text.startsWith('{"timestamp"') && text.includes('"session_meta"')) {
    return "会话启动信息";
  }

  return text.trim();
}

export function normalizeEpochMs(val?: number | string | null): number {
  if (typeof val === "number" && Number.isFinite(val) && val > 0) {
    return val < 1e11 ? Math.round(val * 1000) : val;
  }
  if (typeof val === "string" && val.trim()) {
    const num = Number(val);
    if (Number.isFinite(num) && num > 0) {
      return num < 1e11 ? Math.round(num * 1000) : num;
    }
    const parsed = new Date(val).getTime();
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed < 1e11 && parsed > 1_000_000_000 ? parsed * 1000 : parsed;
    }
  }
  return Date.now();
}

export function normalizeIsoTimestamp(iso?: string): string | undefined {
  if (!iso) return undefined;
  let d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  if (d.getFullYear() < 2000 && d.getTime() > 1_000_000_000) {
    d = new Date(d.getTime() * 1000);
  }
  return d.toISOString();
}

export function formatTurnTimestamp(iso?: string): { short: string; full: string } | null {
  const normalized = normalizeIsoTimestamp(iso);
  if (!normalized) return null;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const full = `${year}-${month}-${day} ${hms}`;
  const now = new Date();
  const isToday =
    year === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const isSameYear = year === now.getFullYear();
  const short = isToday ? hms : isSameYear ? `${month}-${day} ${hms}` : full;
  return { short, full };
}

export function formatTurnDuration(
  durationMs?: number,
  startedAtIso?: string,
  finishedAtIso?: string,
  isZh = true
): string | null {
  let ms = typeof durationMs === "number" && durationMs > 0 ? durationMs : 0;
  if (!ms && startedAtIso && finishedAtIso) {
    const sNorm = normalizeIsoTimestamp(startedAtIso);
    const fNorm = normalizeIsoTimestamp(finishedAtIso);
    const t1 = sNorm ? new Date(sNorm).getTime() : NaN;
    const t2 = fNorm ? new Date(fNorm).getTime() : NaN;
    if (!Number.isNaN(t1) && !Number.isNaN(t2) && t2 > t1) {
      ms = t2 - t1;
    }
  }
  if (!ms || ms <= 0 || ms > 7 * 24 * 3600 * 1000) return null;
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const sec = ms / 1000;
  if (sec < 60) return isZh ? `${sec.toFixed(1)}秒` : `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (isZh) {
    return s > 0 ? `${m}分${s}秒` : `${m}分钟`;
  }
  return s > 0 ? `${m}m\u00A0${s}s` : `${m}m`;
}
