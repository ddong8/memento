// AI call health hourly counters & small Redis JSON records (server/server/services/ai_health.py).
// Shares exact Redis keys with Python so health page and proactive pulse stay consistent across replicas.
import type { Redis } from "ioredis";

const PREFIX = "memento:ai_health";
const BUCKET_TTL = 3 * 24 * 3600;
const RECENT_KEY = `${PREFIX}:recent_errors`;
const RECENT_KEEP = 30;

export const RETRY_REASONS = new Set(["reasoning_retry", "cut_retry"]);
export const REASON_LABELS: Record<string, string> = {
  reasoning_exhausted: "思考耗尽额度",
  reasoning_retry: "思考超额后加额度重试",
  cut_retry: "回答被截断后加额度重试",
  empty: "返回空内容",
  timeout: "超时",
  network: "网络错误",
  rate_limited: "限流 (429)",
  auth: "鉴权失败",
  server_error: "服务端错误 (5xx)",
  bad_request: "请求被拒 (4xx)",
  error: "其他错误",
};

export function reasonForStatus(code: number): string {
  if (code === 429) return "rate_limited";
  if (code === 401 || code === 403) return "auth";
  if (code >= 500) return "server_error";
  return "bad_request";
}

export function reasonForException(err: unknown): string {
  const name = (err as Error)?.name ?? "";
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  if (name === "TimeoutError" || name === "AbortError" || msg.includes("timeout")) return "timeout";
  if (msg.includes("fetch failed") || msg.includes("econn") || msg.includes("network") || msg.includes("socket")) return "network";
  return "error";
}

function bucketKey(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${PREFIX}:h:${y}${mo}${day}${h}`;
}

export async function recordCall(
  redis: Redis | null,
  kind: string,
  outcome: "ok" | "fallback" | "failed",
  opts: {
    provider?: string | null;
    model?: string | null;
    latencyMs?: number | null;
    failures?: { provider: string; model: string; reason: string; detail: string }[];
  } = {},
): Promise<void> {
  if (!redis) return;
  const now = new Date();
  const key = bucketKey(now);
  try {
    const pipe = redis.pipeline();
    pipe.hincrby(key, `calls:${kind}:${outcome}`, 1);
    if (opts.provider && opts.model && outcome !== "failed") {
      pipe.hincrby(key, `model:${opts.provider}|${opts.model}:ok`, 1);
      if (opts.latencyMs != null) pipe.hincrby(key, `model:${opts.provider}|${opts.model}:ms`, Math.round(opts.latencyMs));
    }
    for (const f of opts.failures ?? []) {
      pipe.hincrby(key, `model:${f.provider}|${f.model}:fail`, 1);
      pipe.hincrby(key, `reason:${f.reason}`, 1);
      if (!RETRY_REASONS.has(f.reason)) {
        pipe.lpush(
          RECENT_KEY,
          JSON.stringify({
            at: now.toISOString().replace("Z", "+00:00"),
            kind,
            provider: f.provider,
            model: f.model,
            reason: f.reason,
            detail: (f.detail || "").slice(0, 300),
            fatal: outcome === "failed",
          }),
        );
      }
    }
    pipe.ltrim(RECENT_KEY, 0, RECENT_KEEP - 1);
    pipe.expire(key, BUCKET_TTL);
    await pipe.exec();
  } catch {
    /* best-effort bookkeeping */
  }
}

export async function claimAlert(redis: Redis | null, name: string, cooldownSeconds: number): Promise<boolean> {
  if (!redis) return true;
  try {
    return Boolean(await redis.set(`${PREFIX}:alert:${name}`, "1", "EX", cooldownSeconds, "NX"));
  } catch {
    return false;
  }
}

export async function putJson(redis: Redis | null, name: string, value: unknown, ttlSeconds = 14 * 24 * 3600): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(`${PREFIX}:${name}`, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* ignore */
  }
}

export async function getJson<T = unknown>(redis: Redis | null, name: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(`${PREFIX}:${name}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
