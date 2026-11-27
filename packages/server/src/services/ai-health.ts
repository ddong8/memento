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

export interface AiHealthCalls {
  total: number;
  ok: number;
  fallback: number;
  failed: number;
}

export interface AiHealthSummary {
  available: boolean;
  window_hours: number;
  calls: AiHealthCalls;
  by_kind: Record<string, { ok: number; fallback: number; failed: number }>;
  models: { provider: string; model: string; ok: number; failed: number; avg_latency_ms: number | null }[];
  reasons: { reason: string; label: string; count: number }[];
  hourly: { hour: string; ok: number; fallback: number; failed: number }[];
  recent_errors?: Record<string, unknown>[];
}

function emptyCalls() {
  return { ok: 0, fallback: 0, failed: 0 };
}

function utcIso(d: Date): string {
  return d.toISOString().replace(".000Z", "+00:00").replace("Z", "+00:00");
}

export function aggregate(buckets: [Date, Record<string, string>][]) {
  const calls = emptyCalls();
  const byKind: Record<string, { ok: number; fallback: number; failed: number }> = {};
  const models: Record<string, { ok: number; fail: number; ms: number }> = {};
  const reasons: Record<string, number> = {};
  const hourly: { hour: string; ok: number; fallback: number; failed: number }[] = [];

  for (const [hour, fields] of buckets) {
    const hourCalls = emptyCalls();
    for (const [field, raw] of Object.entries(fields || {})) {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) continue;
      const parts = field.split(":");
      if (parts[0] === "calls" && parts.length === 3) {
        const [, kind, outcome] = parts as [string, string, keyof typeof calls];
        if (outcome in calls) {
          calls[outcome] += n;
          hourCalls[outcome] += n;
          if (!byKind[kind]) byKind[kind] = emptyCalls();
          byKind[kind]![outcome] += n;
        }
      } else if (parts[0] === "model" && parts.length >= 3) {
        const name = parts.slice(1, -1).join(":");
        const metric = parts[parts.length - 1]!;
        if (!models[name]) models[name] = { ok: 0, fail: 0, ms: 0 };
        if (metric === "ok" || metric === "fail" || metric === "ms") models[name]![metric] += n;
      } else if (parts[0] === "reason" && parts.length === 2) {
        reasons[parts[1]!] = (reasons[parts[1]!] ?? 0) + n;
      }
    }
    hourly.push({ hour: utcIso(hour), ...hourCalls });
  }

  const modelRows = Object.entries(models)
    .map(([name, m]) => {
      const bar = name.indexOf("|");
      const provider = bar >= 0 ? name.slice(0, bar) : name;
      const model = bar >= 0 ? name.slice(bar + 1) : "";
      return {
        provider,
        model,
        ok: m.ok,
        failed: m.fail,
        avg_latency_ms: m.ok ? Math.round(m.ms / m.ok) : null,
      };
    })
    .sort((a, b) => b.ok + b.failed - (a.ok + a.failed));

  const reasonRows = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([r, c]) => ({ reason: r, label: REASON_LABELS[r] ?? r, count: c }));

  return {
    calls: { total: calls.ok + calls.fallback + calls.failed, ...calls },
    by_kind: byKind,
    models: modelRows,
    reasons: reasonRows,
    hourly,
  };
}

export async function summary(redis: Redis | null, hours = 24): Promise<AiHealthSummary> {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const hoursList: Date[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    hoursList.push(new Date(now.getTime() - i * 3600_000));
  }
  if (!redis) {
    return { available: false, window_hours: hours, ...aggregate([]) };
  }
  try {
    const pipe = redis.pipeline();
    for (const h of hoursList) pipe.hgetall(bucketKey(h));
    pipe.lrange(RECENT_KEY, 0, RECENT_KEEP - 1);
    const res = await pipe.exec();
    if (!res) return { available: false, window_hours: hours, ...aggregate([]) };
    const buckets: [Date, Record<string, string>][] = [];
    for (let i = 0; i < hoursList.length; i++) {
      const [err, val] = res[i]!;
      buckets.push([hoursList[i]!, !err && val && typeof val === "object" ? (val as Record<string, string>) : {}]);
    }
    const data = aggregate(buckets);
    const [rErr, rawList] = res[hoursList.length]!;
    const recent: Record<string, unknown>[] = [];
    if (!rErr && Array.isArray(rawList)) {
      for (const raw of rawList) {
        try {
          const item = JSON.parse(String(raw)) as Record<string, unknown>;
          const reason = String(item.reason ?? "");
          item.label = REASON_LABELS[reason] ?? reason;
          recent.push(item);
        } catch {
          /* ignore */
        }
      }
    }
    return { available: true, window_hours: hours, ...data, recent_errors: recent };
  } catch {
    return { available: false, window_hours: hours, ...aggregate([]) };
  }
}
