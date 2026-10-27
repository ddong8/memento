"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type GuardOverview } from "@/lib/api-client";
import { BrandMark } from "@/components/aurora/BrandMark";
import { Chip } from "@/components/aurora/primitives";

const TOOL_LABEL: Record<string, string> = { claude_code: "Claude Code", codex: "Codex" };

/** What the collector reported for one tool's Stop hook. */
function installText(result: string | undefined): { text: string; tone: "success" | "warn" | "danger" | "neutral" } {
  if (!result) return { text: "等待设备同步", tone: "neutral" };
  if (result === "written" || result === "unchanged") return { text: "已安装", tone: "success" };
  if (result === "absent") return { text: "本机未装此工具", tone: "neutral" };
  if (result === "unsupported") return { text: "Windows 暂不支持", tone: "neutral" };
  if (result === "removed") return { text: "已移除", tone: "neutral" };
  return { text: result.replace(/^error:\s*/, "出错："), tone: "danger" };
}

const OUTCOME_TEXT: Record<string, string> = {
  verified: "补了验证",
  disclosed: "改为说明未验证的部分",
  no_evidence: "没有验证",
  failed_check: "最近一次检查失败",
};

function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="px-3 py-2 rounded-xl bg-[var(--aurora-chip)] min-w-0">
      <div className="text-[10px] text-[var(--aurora-fg4)] truncate">{label}</div>
      <div className="text-lg font-semibold text-[var(--aurora-fg1)] leading-tight tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-[var(--aurora-fg4)] truncate">{sub}</div>}
    </div>
  );
}

/**
 * The Stop hook in Claude Code and Codex: when the AI says done / fixed / live
 * with nothing checked since its last change, it is sent back to check first.
 * Installed on the tools the profile is injected into.
 */
export default function CompletionGuard() {
  const [data, setData] = useState<GuardOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.getGuard());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const res = await api.setGuard(!data.enabled);
      setData({ ...data, enabled: res.enabled });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <p className="text-[11px] text-[#DC2626]">{error}</p> : null;
  const s = data.stats;
  const rate = s.unchecked_rate == null ? "—" : `${Math.round(s.unchecked_rate * 100)}%`;

  return (
    <div className="p-3.5 rounded-2xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] shadow-xs space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-xs sm:text-sm text-[var(--aurora-fg1)]">完成核查</span>
            <Chip tone={data.enabled ? "success" : "neutral"}>{data.enabled ? "已开启" : "已关闭"}</Chip>
          </div>
          <p className="text-[10px] text-[var(--aurora-fg3)] mt-0.5 leading-relaxed">
            AI 说“完成、已修复、已上线”时，如果最后一次改动之后没跑过测试、没查线上版本，就退回去让它先验证再交付；
            说明了哪些没验证的照常放行。装在上面开启了画像注入的 Claude Code 和 Codex 里。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={data.enabled}
          aria-label="完成核查开关"
          disabled={busy}
          onClick={toggle}
          className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${
            data.enabled ? "bg-[var(--aurora-accent)]" : "bg-[var(--aurora-border)]"
          } ${busy ? "opacity-60" : "cursor-pointer"}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
              data.enabled ? "translate-x-4" : ""
            }`}
          />
        </button>
      </div>

      {error && <p className="text-[11px] text-[#DC2626]">{error}</p>}

      {data.devices.length > 0 && (
        <div className="space-y-1.5">
          {data.devices.map((d) => (
            <div key={d.id} className="flex items-center gap-2 flex-wrap text-[11px]">
              <span className="font-semibold text-[var(--aurora-fg2)] min-w-[64px]">{d.name}</span>
              {data.tools.map((tool) => {
                const on = data.enabled && d.tools.includes(tool);
                const st = on ? installText(d.results[tool]) : { text: "未开启", tone: "neutral" as const };
                const trust = tool === "codex" && on ? d.results.codex_trust : undefined;
                const trustBad = trust && trust !== "trusted";
                return (
                  <span key={tool} className="flex items-center gap-1">
                    <BrandMark id={tool} size={13} colored={on} />
                    <Chip tone={trustBad ? "danger" : st.tone}>
                      {TOOL_LABEL[tool] ?? tool}：{trustBad ? `信任失败（${trust.replace(/^error:\s*/, "")}）` : st.text}
                    </Chip>
                  </span>
                );
              })}
              {d.reported_at && <span className="text-[10px] text-[var(--aurora-fg4)] font-mono ml-auto">{time(d.reported_at)}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label={`近 ${data.days} 天说“完成”`} value={String(s.claims)} sub={s.deploy_claims ? `其中上线 ${s.deploy_claims} 次` : undefined} />
        <Stat label="有验证依据" value={String(s.verified)} sub={s.disclosed ? `另有 ${s.disclosed} 次说明了未验证` : undefined} />
        <Stat label="没验证就说完成" value={String(s.blocked)} sub={`占 ${rate}`} />
        <Stat label="退回后补了验证" value={`${s.checked_after}/${s.followups}`} sub={s.disclosed_after ? `${s.disclosed_after} 次改为说明` : undefined} />
      </div>

      {data.recent.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold text-[var(--aurora-fg3)]">最近退回与之后的结果</div>
          {data.recent.slice(0, 8).map((e, i) => (
            <div key={`${e.at}-${i}`} className="text-[11px] leading-snug flex gap-2 min-w-0">
              <span className="text-[var(--aurora-fg4)] font-mono shrink-0">{time(e.at)}</span>
              <span className="shrink-0" style={{ color: e.followup ? (e.outcome === "verified" ? "#10B981" : "var(--aurora-fg3)") : "#B45309" }}>
                {e.followup ? OUTCOME_TEXT[e.outcome] ?? e.outcome : "退回"}
              </span>
              <span className="text-[var(--aurora-fg2)] truncate" title={e.check ? `${e.claim ?? ""}\n验证：${e.check}` : e.claim ?? ""}>
                {e.claim}
                {e.followup && e.check ? <span className="text-[var(--aurora-fg4)] font-mono"> · {e.check}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
