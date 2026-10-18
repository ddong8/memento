"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api } from "@/lib/api-client";
import { fmt, useI18n } from "@/lib/i18n";
import { Btn, Glass, TopBar } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";

/* The health overview is a loose JSON document (see server/services/health_service.py). */
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []) as Obj[];
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

const DANGER = "#DC2626";
const WARN = "#D97706";
const SUCCESS = "#10B981";

const percent = (ratio: unknown) => (typeof ratio === "number" ? `${Math.round(ratio * 100)}%` : "—");

function time(iso: unknown): string {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function Section({ title, trailing, children }: { title: string; trailing?: string; children: ReactNode }) {
  return (
    <Glass padding="clamp(14px, 3vw, 20px)" radius={18} style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1, fontSize: 14.5, fontWeight: 600, color: "var(--aurora-fg1)" }}>{title}</div>
        {trailing && <div style={{ fontSize: 12, color: "var(--aurora-fg3)" }}>{trailing}</div>}
      </div>
      {children}
    </Glass>
  );
}

function Metrics({ items }: { items: { label: string; value: string; color?: string }[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12 }}>
      {items.map((m) => (
        <div key={m.label} style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: m.color ?? "var(--aurora-fg1)",
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {m.value}
          </div>
          <div style={{ fontSize: 12, color: "var(--aurora-fg3)", marginTop: 2 }}>{m.label}</div>
        </div>
      ))}
    </div>
  );
}

function Row({
  left,
  right,
  rightColor,
  sub,
  mono = true,
  dot,
}: {
  left: string;
  right: string;
  rightColor?: string;
  sub?: string | null;
  mono?: boolean;
  dot?: string;
}) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "6px 0", alignItems: "flex-start" }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: 3, background: dot, marginTop: 7, flexShrink: 0 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "var(--aurora-fg1)", overflowWrap: "anywhere" }}>{left}</div>
        {sub && (
          <div
            style={{
              fontSize: 11.5,
              color: "var(--aurora-fg3)",
              marginTop: 2,
              overflowWrap: "anywhere",
              fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
            }}
          >
            {sub}
          </div>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: rightColor ?? "var(--aurora-fg2)", textAlign: "right", flexShrink: 0, maxWidth: "50%" }}>
        {right}
      </div>
    </div>
  );
}

const Divider = () => <div style={{ height: 1, background: "var(--aurora-border)", margin: "10px 0" }} />;
const Subhead = ({ children }: { children: ReactNode }) => (
  <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.03em", color: "var(--aurora-fg3)", marginBottom: 4 }}>{children}</div>
);
const Hint = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--aurora-fg3)", lineHeight: 1.55, ...style }}>{children}</p>
);

/** 24 hourly bars: answered calls in a quiet tone, failures stacked in red on top. */
function HourlyBars({ hourly }: { hourly: Obj[] }) {
  const { t } = useI18n();
  const h = t.health;
  const peak = Math.max(0, ...hourly.map((x) => num(x.ok) + num(x.fallback) + num(x.failed)));
  const usable = 42;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-end", height: 44, gap: 3 }}>
        {hourly.map((x, i) => {
          const ok = num(x.ok) + num(x.fallback);
          const failed = num(x.failed);
          const hour = typeof x.hour === "string" ? new Date(x.hour).getHours() : "";
          return (
            <div key={i} title={fmt(h.hourTip, { hour, ok, failed })} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
              {failed > 0 && <div style={{ height: Math.max(2, (usable * failed) / Math.max(peak, 1)), background: DANGER, borderRadius: "2px 2px 0 0" }} />}
              <div
                style={{
                  height: peak === 0 ? 2 : Math.max(2, (usable * ok) / peak),
                  background: "var(--aurora-accent)",
                  opacity: peak === 0 ? 0.15 : 0.45,
                  borderRadius: failed > 0 ? 0 : "2px 2px 0 0",
                }}
              />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--aurora-fg4)", marginTop: 4 }}>
        <span>{h.dayAgo}</span>
        <span>{h.now}</span>
      </div>
    </div>
  );
}

/** One bar per week: all corrections, repeats in amber, repeats of learned rules in red on top. */
function WeeklyRepeatBars({ weekly }: { weekly: Obj[] }) {
  const { t } = useI18n();
  const peak = Math.max(1, ...weekly.map((w) => num(w.total)));
  const usable = 54;
  const label = (end: unknown) => {
    if (typeof end !== "string") return "";
    const e = new Date(end);
    const s = new Date(e.getTime() - 7 * 86400_000);
    return `${s.getMonth() + 1}/${s.getDate()}–${e.getMonth() + 1}/${e.getDate()}`;
  };
  return (
    <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
      {weekly.map((w, i) => {
        const total = num(w.total);
        const repeat = num(w.repeat);
        const learned = num(w.learned_repeat);
        return (
          <div key={i} style={{ flex: 1, textAlign: "center", minWidth: 0 }}>
            <div style={{ height: 56, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
              {learned > 0 && <div style={{ height: (usable * learned) / peak, background: DANGER, borderRadius: "3px 3px 0 0" }} />}
              {repeat - learned > 0 && (
                <div style={{ height: (usable * (repeat - learned)) / peak, background: WARN, borderRadius: learned === 0 ? "3px 3px 0 0" : 0 }} />
              )}
              <div
                style={{
                  height: Math.max(2, (usable * (total - repeat)) / peak),
                  background: "var(--aurora-accent)",
                  opacity: total === 0 ? 0.15 : 0.45,
                  borderRadius: repeat === 0 ? "3px 3px 0 0" : 0,
                }}
              />
            </div>
            <div style={{ fontSize: 11, color: "var(--aurora-fg2)", marginTop: 4 }}>
              {total === 0 ? "—" : fmt(t.health.repeatShort, { p: Math.round((repeat * 100) / total) })}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--aurora-fg4)" }}>{label(w.end)}</div>
          </div>
        );
      })}
    </div>
  );
}

function EvalTrend({ trend }: { trend: Obj[] }) {
  const latestSet = trend[trend.length - 1]?.set_version;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 56, marginTop: 10 }}>
      {trend.map((x, i) => (
        <div
          key={i}
          title={`v${x.set_version} · ${percent(x.hit5)}`}
          style={{
            flex: 1,
            height: 4 + 48 * num(x.hit5),
            borderRadius: 3,
            background: x.set_version === latestSet ? "var(--aurora-accent)" : "var(--aurora-fg4)",
            opacity: x.set_version === latestSet ? 0.75 : 0.5,
          }}
        />
      ))}
    </div>
  );
}

export function StatusView({ hideTopBar = false }: { hideTopBar?: boolean }) {
  const { t } = useI18n();
  const h = t.health;
  const [data, setData] = useState<Obj | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allErrors, setAllErrors] = useState(false);
  const [showMisses, setShowMisses] = useState(false);
  const [evalJob, setEvalJob] = useState<Obj | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.getHealthOverview());
      setError(null);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg.includes("404") ? h.tooOld : fmt(h.loadFailed, { error: msg }));
    }
  }, [h]);

  useEffect(() => {
    load();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [load]);

  const runEval = async (rebuild: boolean) => {
    try {
      setEvalJob(await api.runEval(rebuild));
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(async () => {
        try {
          const job = obj((await api.getEvals()).job);
          setEvalJob(job);
          if (job.status !== "running") {
            if (poll.current) clearInterval(poll.current);
            poll.current = null;
            load();
          }
        } catch {
          // keep polling
        }
      }, 5000);
    } catch (e) {
      setError(fmt(h.evalStartFailed, { error: (e as Error).message }));
    }
  };

  const level = String(data?.level ?? "ok");
  const issues = list(data?.issues);
  const devices = obj(data?.devices);
  const evolution = data?.evolution ? obj(data.evolution) : null;

  return (
    <div className="w-full">
      {!hideTopBar && (
        <TopBar
          title={h.title}
          subtitle={h.subtitle}
          right={
            <Btn variant="glass" size="sm" icon="refresh" onClick={load}>
              {h.refresh}
            </Btn>
          }
        />
      )}

      {error && (
        <Glass padding={14} radius={14} style={{ marginBottom: 14, color: DANGER, fontSize: 13 }}>
          {error}
        </Glass>
      )}
      {!data && !error && <p style={{ color: "var(--aurora-fg3)", fontSize: 13 }}>{t.loading}</p>}

      {data && (
        <>
          {/* Overall status */}
          <Glass padding="clamp(14px, 3vw, 20px)" radius={18} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  background: level === "error" ? DANGER : level === "warn" ? WARN : SUCCESS,
                  boxShadow: `0 0 0 4px ${level === "error" ? DANGER : level === "warn" ? WARN : SUCCESS}2e`,
                }}
              />
              <span style={{ fontSize: 17, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                {level === "error" ? h.levelError : level === "warn" ? fmt(h.levelWarn, { n: issues.length }) : h.levelOk}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--aurora-fg3)", margin: "6px 0 0 22px" }}>
              {fmt(h.devicesLine, { total: num(devices.total), online: num(devices.online), at: time(data.generated_at) })}
            </div>
            {issues.length > 0 && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {issues.map((issue, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 13.5, lineHeight: 1.45, color: "var(--aurora-fg2)" }}>
                    <Icon name="activity" size={15} style={{ color: issue.level === "error" ? DANGER : WARN, flexShrink: 0, marginTop: 2 }} />
                    <span>{String(issue.text)}</span>
                  </div>
                ))}
              </div>
            )}
          </Glass>

          {evolution && <Evolution evo={evolution} />}
          {data.learning != null && <Learning learning={obj(data.learning)} />}
          {evolution?.eval != null && (
            <Section
              title={h.evalTitle}
              trailing={
                obj(evolution.eval).latest
                  ? fmt(h.evalSet, { v: String(obj(obj(evolution.eval).latest).set_version), n: num(obj(obj(evolution.eval).latest).cases) })
                  : h.evalSchedule
              }
            >
              <Eval
                evalData={obj(evolution.eval)}
                job={evalJob}
                showMisses={showMisses}
                onToggleMisses={() => setShowMisses((v) => !v)}
                onRun={runEval}
              />
            </Section>
          )}
          <Ai ai={obj(data.ai)} all={allErrors} onToggleAll={() => setAllErrors((v) => !v)} />
          <Dreaming dreaming={obj(data.dreaming)} />
          <Profile profile={obj(data.profile)} />
          <Section title={h.pipelineTitle} trailing={h.pipelineRetry}>
            <Metrics
              items={[
                { label: h.embeddingFailed, value: String(num(obj(data.pipeline).embedding_failed)), color: num(obj(data.pipeline).embedding_failed) > 0 ? WARN : undefined },
                { label: h.knowledgeFailed, value: String(num(obj(data.pipeline).knowledge_failed)), color: num(obj(data.pipeline).knowledge_failed) > 0 ? WARN : undefined },
              ]}
            />
            <Hint>{h.pipelineHint}</Hint>
          </Section>
        </>
      )}
    </div>
  );
}

function Evolution({ evo }: { evo: Obj }) {
  const { t } = useI18n();
  const h = t.health;
  const skills = obj(evo.skills);
  const reviews = obj(evo.reviews);
  const todos = obj(evo.todos);
  const memory = obj(evo.memory);
  const agent = obj(reviews.agent_tasks);
  const sessions = num(reviews.sessions);
  const done = num(obj(reviews.outcomes).done);
  const repeats = num(reviews.pitfall_repeats);
  const overdue = num(todos.overdue);
  const reviewRun = evo.review_run ? obj(evo.review_run) : null;
  const lifecycleRun = evo.lifecycle_run ? obj(evo.lifecycle_run) : null;
  const reviewSessions = reviewRun ? obj(reviewRun.sessions) : {};
  return (
    <Section title={h.evolutionTitle} trailing={h.last7}>
      <Metrics
        items={[
          { label: h.skillsPublished, value: String(num(skills.published)) },
          { label: h.skillsDraft, value: String(num(skills.draft)), color: num(skills.draft) > 0 ? "var(--aurora-accent)" : undefined },
          { label: h.pitfalls, value: String(num(reviews.pitfalls_total)) },
          { label: h.pitfallRepeats, value: String(repeats), color: repeats > 0 ? DANGER : undefined },
        ]}
      />
      <div style={{ height: 12 }} />
      <Metrics
        items={[
          { label: h.reviewedSessions, value: String(sessions) },
          { label: h.doneRate, value: sessions === 0 ? "—" : `${Math.round((done * 100) / sessions)}%` },
          { label: h.agentSuccess, value: percent(agent.success_rate) },
          { label: h.todosOverdue, value: `${num(todos.open)} · ${overdue}`, color: overdue > 0 ? DANGER : undefined },
        ]}
      />
      <Hint>{h.evolutionHint}</Hint>
      <Divider />
      <Subhead>{h.metabolism}</Subhead>
      <Row left={h.memActive} right={fmt(h.items, { n: num(memory.active) })} sub={fmt(h.memRecalled, { n: num(memory.recalled_recent) })} mono={false} />
      <Row left={h.memDormant} right={fmt(h.items, { n: num(memory.dormant) })} sub={h.memDormantHint} mono={false} />
      <Row
        left={h.memSuperseded}
        right={fmt(h.items, { n: num(memory.superseded) })}
        sub={fmt(h.memSupersededHint, { n: num(memory.superseded_recent) })}
        mono={false}
      />
      {(reviewRun || lifecycleRun) && <Divider />}
      {reviewRun && (
        <Row
          left={h.lastReview}
          right={time(reviewRun.at)}
          sub={reviewSessions.error == null ? fmt(h.sessionsN, { n: num(reviewSessions.reviewed) }) : fmt(h.errorWith, { error: String(reviewSessions.error) })}
          mono={false}
        />
      )}
      {lifecycleRun && (
        <Row
          left={h.lastLifecycle}
          right={time(lifecycleRun.at)}
          sub={fmt(h.lifecycleLine, { superseded: num(obj(lifecycleRun.reconcile).superseded), dormant: num(lifecycleRun.dormant) })}
          mono={false}
        />
      )}
    </Section>
  );
}

function Learning({ learning }: { learning: Obj }) {
  const { t } = useI18n();
  const h = t.health;
  const weekly = list(learning.weekly);
  const top = list(learning.top);
  const total = num(learning.total);
  const learnedRepeat = num(learning.learned_repeat);
  const repeatPct = total === 0 ? "—" : `${Math.round((num(learning.repeat) * 100) / total)}%`;
  const topicStatus: Record<string, string> = { accepted: h.topicAccepted, pending: h.topicPending, dismissed: h.topicDismissed };
  return (
    <Section title={h.learningTitle} trailing={fmt(h.lastNDays, { n: num(learning.window_days) || 30 })}>
      <Metrics
        items={[
          { label: h.corrections, value: String(total) },
          { label: h.repeatRate, value: repeatPct },
          { label: h.learnedRepeat, value: String(learnedRepeat), color: learnedRepeat > 0 ? DANGER : undefined },
          { label: h.pendingTopics, value: String(num(learning.pending)) },
        ]}
      />
      <Hint>{h.learningHint}</Hint>
      {weekly.some((w) => num(w.total) > 0) && <WeeklyRepeatBars weekly={weekly} />}
      {top.length > 0 ? (
        <>
          <Divider />
          <Subhead>{h.topTopics}</Subhead>
          {top.map((x, i) => (
            <Row
              key={i}
              left={String(x.statement)}
              right={`${fmt(h.times, { n: num(x.count) })} · ${topicStatus[String(x.status)] ?? String(x.status)}`}
              sub={num(x.learned_repeat) > 0 ? fmt(h.saidAgain, { n: num(x.learned_repeat) }) : null}
              mono={false}
              rightColor={num(x.learned_repeat) > 0 ? DANGER : x.status === "accepted" ? SUCCESS : undefined}
            />
          ))}
        </>
      ) : (
        total === 0 && <Hint style={{ fontSize: 13 }}>{h.noCorrections}</Hint>
      )}
    </Section>
  );
}

function Eval({
  evalData,
  job,
  showMisses,
  onToggleMisses,
  onRun,
}: {
  evalData: Obj;
  job: Obj | null;
  showMisses: boolean;
  onToggleMisses: () => void;
  onRun: (rebuild: boolean) => void;
}) {
  const { t } = useI18n();
  const h = t.health;
  const latest = evalData.latest ? obj(evalData.latest) : null;
  const trend = list(evalData.trend);
  const running = job?.status === "running" || obj(evalData.job).status === "running";
  const metrics = obj(latest?.metrics);
  const hybrid = obj(metrics.hybrid);
  const misses = list(metrics.misses);
  const regression = evalData.regression != null;
  const jobError = job?.status === "error" ? String(job.error ?? "") : null;
  return (
    <>
      {!latest ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--aurora-fg3)", lineHeight: 1.6 }}>{h.evalIntro}</p>
      ) : (
        <>
          <Metrics
            items={[
              { label: h.hit5, value: percent(hybrid.hit5), color: regression ? DANGER : undefined },
              { label: h.hit1, value: percent(hybrid.hit1) },
              { label: "MRR", value: typeof hybrid.mrr === "number" ? hybrid.mrr.toFixed(2) : "—" },
              { label: h.keywordSemantic, value: `${percent(obj(metrics.keyword).hit5)} / ${percent(obj(metrics.semantic).hit5)}` },
            ]}
          />
          <Hint>
            {fmt(h.lastEval, { at: time(latest.created_at) })}
            {num(metrics.semantic_unavailable) > 0 && ` · ${fmt(h.semanticDown, { n: num(metrics.semantic_unavailable) })}`}
            {evalData.stale === true && ` · ${h.evalStale}`}
          </Hint>
          {trend.length > 1 && <EvalTrend trend={trend} />}
          {misses.length > 0 && (
            <>
              <Divider />
              <button
                type="button"
                onClick={onToggleMisses}
                style={{ display: "flex", width: "100%", alignItems: "center", background: "none", border: 0, padding: 0, cursor: "pointer" }}
              >
                <span style={{ flex: 1, textAlign: "left" }}>
                  <Subhead>{fmt(h.misses, { n: misses.length })}</Subhead>
                </span>
                <Icon name={showMisses ? "minus" : "plus"} size={14} style={{ color: "var(--aurora-fg3)" }} />
              </button>
              {showMisses &&
                misses.map((m, i) => (
                  <div key={i} style={{ fontSize: 12.5, color: "var(--aurora-fg2)", padding: "3px 0" }}>
                    · {String(m.query)}
                  </div>
                ))}
            </>
          )}
        </>
      )}
      {jobError && <Hint style={{ color: DANGER }}>{fmt(h.evalError, { error: jobError })}</Hint>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <Btn variant="ghost" size="sm" disabled={running} onClick={() => onRun(true)}>
          {h.rebuildSet}
        </Btn>
        <Btn size="sm" icon="target" disabled={running} onClick={() => onRun(false)}>
          {running ? h.evalRunning : h.runEval}
        </Btn>
      </div>
    </>
  );
}

function Ai({ ai, all, onToggleAll }: { ai: Obj; all: boolean; onToggleAll: () => void }) {
  const { t } = useI18n();
  const h = t.health;
  const calls = obj(ai.calls);
  const total = num(calls.total);
  const pct = total === 0 ? null : Math.floor(((num(calls.ok) + num(calls.fallback)) * 100) / total);
  const failed = num(calls.failed);
  const recent = list(ai.recent_errors);
  const providers: Record<string, string> = { primary_background: h.providerBackground, primary: h.providerPrimary, oneapi_fallback: h.providerFallback };
  const latency = (ms: unknown) => (typeof ms !== "number" ? "—" : ms >= 1000 ? fmt(h.seconds, { n: (ms / 1000).toFixed(1) }) : fmt(h.millis, { n: Math.round(ms) }));
  return (
    <Section title={h.aiTitle} trailing={h.last24h}>
      {ai.available === false && <Hint style={{ color: WARN, marginTop: 0, marginBottom: 10 }}>{h.aiUnavailable}</Hint>}
      <Metrics
        items={[
          { label: h.totalCalls, value: String(total) },
          { label: h.successRate, value: pct == null ? "—" : `${pct}%`, color: pct != null && pct < 95 ? WARN : undefined },
          { label: h.byFallback, value: String(num(calls.fallback)) },
          { label: h.failed, value: String(failed), color: failed > 0 ? DANGER : undefined },
        ]}
      />
      {list(ai.hourly).length > 0 && <HourlyBars hourly={list(ai.hourly)} />}
      {list(ai.models).length > 0 && (
        <>
          <Divider />
          <Subhead>{h.byModel}</Subhead>
          {list(ai.models).map((m, i) => (
            <Row
              key={i}
              left={`${providers[String(m.provider)] ?? String(m.provider)} · ${String(m.model)}`}
              right={fmt(h.modelLine, { ok: num(m.ok), failed: num(m.failed), latency: latency(m.avg_latency_ms) })}
              rightColor={num(m.failed) > 0 ? WARN : undefined}
            />
          ))}
        </>
      )}
      {list(ai.reasons).length > 0 && (
        <>
          <Divider />
          <Subhead>{h.reasons}</Subhead>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
            {list(ai.reasons).map((r, i) => (
              <span key={i} style={{ fontSize: 12, color: "var(--aurora-fg2)", background: "var(--aurora-chip)", borderRadius: 6, padding: "3px 8px" }}>
                {String(r.label)} × {num(r.count)}
              </span>
            ))}
          </div>
        </>
      )}
      {recent.length > 0 && (
        <>
          <Divider />
          <Subhead>{h.recentFailures}</Subhead>
          {(all ? recent : recent.slice(0, 4)).map((e, i) => (
            <Row
              key={i}
              left={`${String(e.label)} · ${String(e.model)}`}
              right={time(e.at)}
              dot={e.fatal === true ? DANGER : WARN}
              sub={typeof e.detail === "string" && e.detail ? e.detail : null}
            />
          ))}
          {recent.length > 4 && (
            <Btn variant="ghost" size="sm" onClick={onToggleAll} style={{ marginTop: 4 }}>
              {all ? h.collapse : fmt(h.showAll, { n: recent.length })}
            </Btn>
          )}
        </>
      )}
    </Section>
  );
}

function useRunLabels() {
  const { t } = useI18n();
  const h = t.health;
  return {
    updated: h.runUpdated,
    same_as_published: h.runSame,
    no_input: h.runNoInput,
    llm_failed: h.runLlmFailed,
    no_llm: h.runNoLlm,
    user_editing: h.runUserEditing,
    error: h.runError,
  } as Record<string, string>;
}

function Dreaming({ dreaming }: { dreaming: Obj }) {
  const { t } = useI18n();
  const h = t.health;
  const labels = useRunLabels();
  const journals = list(dreaming.journals);
  const run = dreaming.last_run ? obj(dreaming.last_run) : null;
  return (
    <Section title={h.dreamingTitle} trailing={h.dreamingSchedule}>
      {run && (
        <Row
          left={fmt(h.lastNightly, { at: time(run.at) })}
          right={run.ok === false ? h.failedShort : h.okShort}
          rightColor={run.ok === false ? DANGER : SUCCESS}
          sub={run.ok === false ? String(run.error ?? "") : fmt(h.draftStatus, { status: labels[String(run.profile_status)] ?? String(run.profile_status ?? "—") })}
        />
      )}
      {run && journals.length > 0 && <Divider />}
      {journals.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--aurora-fg3)" }}>{h.noJournals}</p>
      ) : (
        <>
          <Subhead>{h.recentJournals}</Subhead>
          {journals.map((j, i) => (
            <Row
              key={i}
              left={String(j.date)}
              right={[
                fmt(h.scanned, { n: num(j.scanned) }),
                fmt(h.promoted, { n: num(j.promoted) }),
                ...(num(j.relations) > 0 ? [fmt(h.relations, { n: num(j.relations) })] : []),
                ...(j.voice != null ? [fmt(h.voice, { n: num(j.voice) })] : []),
              ].join(" · ")}
              rightColor={num(j.promoted) > 0 ? "var(--aurora-fg1)" : "var(--aurora-fg3)"}
            />
          ))}
        </>
      )}
    </Section>
  );
}

function Profile({ profile }: { profile: Obj }) {
  const { t } = useI18n();
  const h = t.health;
  const labels = useRunLabels();
  const published = profile.published ? obj(profile.published) : null;
  const draft = profile.draft ? obj(profile.draft) : null;
  const run = profile.last_run ? obj(profile.last_run) : null;
  const devices = list(profile.devices);
  const runFailed = run != null && (run.status === "llm_failed" || run.status === "error");
  return (
    <Section title={h.profileTitle}>
      <Row
        left={h.published}
        right={published ? `v${String(published.version)} · ${time(published.published_at)}` : h.notYet}
        rightColor={published ? undefined : WARN}
      />
      <Row left={h.draft} right={draft ? fmt(h.generatedAt, { at: time(draft.updated_at) }) : h.none} />
      {run && (
        <Row
          left={h.lastManual}
          right={`${labels[String(run.status)] ?? String(run.status)} · ${time(run.at)}`}
          rightColor={runFailed ? DANGER : undefined}
          sub={run.error ? String(run.error) : null}
        />
      )}
      {devices.length > 0 && (
        <>
          <Divider />
          <Subhead>{h.writeDevices}</Subhead>
          {devices.map((d, i) => {
            const errors = Array.isArray(d.errors) ? (d.errors as unknown[]).map(String) : [];
            return (
              <Row
                key={i}
                left={String(d.name).replace(/\s*\([^)]*\)\s*$/, "")}
                right={
                  errors.length
                    ? fmt(h.errorWith, { error: errors.join("、") })
                    : d.synced === true
                      ? fmt(h.syncedV, { v: String(d.version) })
                      : published
                        ? h.pendingSync
                        : h.waitingPublish
                }
                dot={d.online === true ? SUCCESS : "var(--aurora-fg4)"}
                rightColor={errors.length ? DANGER : d.synced === true ? SUCCESS : "var(--aurora-fg3)"}
              />
            );
          })}
        </>
      )}
    </Section>
  );
}
