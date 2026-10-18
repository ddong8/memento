"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { fmt, useI18n } from "@/lib/i18n";
import { Btn, Chip, Glass } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []) as Obj[];
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (v == null ? "" : String(v));

/**
 * Dreaming: the three memory tiers, running a consolidation by hand (recent days,
 * the whole history, a backfill replay or a bootstrap from the knowledge graph),
 * the dream journals, and memories that are no longer given to the AI.
 */
export default function DreamingPanel({
  onDreamingChange,
}: {
  onDreamingChange?: (active: boolean) => void;
} = {}) {
  const { t } = useI18n();
  const d = t.dreaming;
  const [tiers, setTiers] = useState<Obj | null>(null);
  const [journals, setJournals] = useState<Obj[]>([]);
  const [inactive, setInactive] = useState<Obj[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [showScopes, setShowScopes] = useState(false);
  const [openJournal, setOpenJournal] = useState<string | null>(null);
  const [journalDetail, setJournalDetail] = useState<Obj | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const [tierData, journalData, memories] = await Promise.all([
        api.getMemoryTiers(),
        api.getDreamJournals(20),
        api.getCoreMemories().catch(() => [] as Obj[]),
      ]);
      setTiers(tierData);
      setJournals(list(journalData.journals));
      setInactive((memories as Obj[]).filter((m) => !m.is_folder && m.status && m.status !== "active"));
      setError(null);
    } catch (e) {
      setError(fmt(d.loadFailed, { error: (e as Error).message }));
    }
  }, [d]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const dream = async (daysBack: number) => {
    setShowScopes(false);
    setRunning(true);
    onDreamingChange?.(true);
    setNotice(null);
    try {
      const res = await api.triggerDream(daysBack);
      setNotice(daysBack === 0 ? d.doneAll : fmt(d.doneDays, { n: daysBack }));
      if (res.report_markdown) setReport(str(res.report_markdown));
      await load();
    } catch (e) {
      setError(fmt(d.dreamFailed, { error: (e as Error).message }));
    } finally {
      setRunning(false);
      onDreamingChange?.(false);
    }
  };

  const backfill = async () => {
    setShowScopes(false);
    setRunning(true);
    onDreamingChange?.(true);
    setNotice(null);
    try {
      const res = await api.triggerDreamBackfill(3, 30);
      setNotice(str(res.message) || d.backfillStarted);
      for (let i = 0; i < 200 && alive.current; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const status = await api.getDreamBackfillStatus().catch(() => ({}) as Obj);
        if (status.status === "completed") {
          setNotice(d.backfillDone);
          await load();
          break;
        }
        if (status.status === "error") {
          setError(fmt(d.backfillFailed, { error: str(status.error) }));
          break;
        }
      }
    } catch (e) {
      setError(fmt(d.backfillFailed, { error: (e as Error).message }));
    } finally {
      setRunning(false);
      onDreamingChange?.(false);
    }
  };

  const bootstrap = async () => {
    setShowScopes(false);
    setRunning(true);
    onDreamingChange?.(true);
    setNotice(d.bootstrapping);
    try {
      const res = await api.bootstrapMemories();
      setNotice(fmt(d.bootstrapDone, { n: num(res.promoted_count) }));
      await load();
    } catch (e) {
      setError(fmt(d.bootstrapFailed, { error: (e as Error).message }));
    } finally {
      setRunning(false);
      onDreamingChange?.(false);
    }
  };

  const toggleJournal = async (id: string) => {
    if (openJournal === id) {
      setOpenJournal(null);
      return;
    }
    setOpenJournal(id);
    setJournalDetail(null);
    try {
      setJournalDetail(await api.getDreamJournal(id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const revive = async (id: string) => {
    try {
      await api.reviveCoreMemory(id);
      setNotice(d.revived);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const scopes: { label: string; hint: string; run: () => void }[] = [
    { label: d.scopeToday, hint: d.scopeTodayHint, run: () => dream(1) },
    { label: d.scopeWeek, hint: d.scopeWeekHint, run: () => dream(7) },
    { label: d.scopeMonth, hint: d.scopeMonthHint, run: () => dream(30) },
    { label: d.scopeAll, hint: d.scopeAllHint, run: () => dream(0) },
    { label: d.scopeBackfill, hint: d.scopeBackfillHint, run: backfill },
    { label: d.scopeBootstrap, hint: d.scopeBootstrapHint, run: bootstrap },
  ];

  const tierCards = tiers
    ? [
        { label: d.l1, value: num(obj(tiers.l1_working).conversations), hint: d.l1Hint },
        { label: d.l2, value: num(obj(tiers.l2_episodic).daily_summaries), hint: d.l2Hint },
        { label: d.l3, value: num(obj(tiers.l3_core).core_memories), hint: d.l3Hint, accent: true },
      ]
    : [];
  const statusLabel = (s: unknown) => (s === "dormant" ? d.dormant : s === "superseded" ? d.superseded : str(s));

  return (
    <div className="space-y-4">
      <Glass padding="clamp(14px, 3vw, 20px)" radius={18}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="moon" size={17} style={{ color: "var(--aurora-accent)" }} />
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)" }}>{d.title}</span>
        </div>
        <p style={{ margin: "8px 0 14px", fontSize: 12.5, color: "var(--aurora-fg2)", lineHeight: 1.55 }}>{d.intro}</p>
        <Btn icon="moon" disabled={running} onClick={() => setShowScopes((v) => !v)}>
          {running ? d.running : d.trigger}
        </Btn>
        {showScopes && (
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
            {scopes.map((s) => (
              <button
                key={s.label}
                type="button"
                disabled={running}
                onClick={s.run}
                style={{
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid var(--aurora-border)",
                  background: "var(--aurora-chip)",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--aurora-fg1)" }}>{s.label}</div>
                <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 2, lineHeight: 1.45 }}>{s.hint}</div>
              </button>
            ))}
          </div>
        )}
        {notice && <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--aurora-fg2)" }}>{notice}</p>}
        {error && <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "#DC2626" }}>{error}</p>}
      </Glass>

      {report && (
        <Glass padding="clamp(14px, 3vw, 20px)" radius={18}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
            <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)" }}>{d.report}</span>
            <Btn variant="ghost" size="sm" icon="close" onClick={() => setReport(null)}>
              {d.close}
            </Btn>
          </div>
          <div className="prose prose-sm max-w-none">
            <MarkdownViewer content={report} />
          </div>
        </Glass>
      )}

      {tiers && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
          {tierCards.map((c) => (
            <Glass key={c.label} padding={14} radius={16} style={c.accent ? { border: "1px solid var(--aurora-accent)" } : undefined}>
              <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)" }}>{c.label}</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: "var(--aurora-fg1)", fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
                {c.value.toLocaleString()}
              </div>
              <div style={{ fontSize: 11, color: "var(--aurora-fg3)", marginTop: 2 }}>{c.hint}</div>
            </Glass>
          ))}
        </div>
      )}

      <Glass padding="clamp(14px, 3vw, 20px)" radius={18}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", marginBottom: 6 }}>{d.journals}</div>
        {journals.length === 0 && <p style={{ margin: 0, fontSize: 13, color: "var(--aurora-fg3)" }}>{d.noJournals}</p>}
        {journals.map((j) => {
          const id = str(j.id);
          const m = obj(j.stage_metrics);
          return (
            <div key={id} style={{ borderTop: "1px solid var(--aurora-border)", padding: "10px 0" }}>
              <button
                type="button"
                onClick={() => toggleJournal(id)}
                style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: 0, padding: 0, cursor: "pointer" }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--aurora-fg1)" }}>{str(j.dream_date)}</span>
                  <span style={{ fontSize: 11.5, color: "var(--aurora-accent)" }}>
                    {fmt(d.journalLine, { scanned: num(m.scanned_items), promoted: num(m.promoted_count) })}
                  </span>
                </div>
                {str(j.summary_snippet) && openJournal !== id && (
                  <div style={{ fontSize: 12, color: "var(--aurora-fg2)", marginTop: 4, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {str(j.summary_snippet)}
                  </div>
                )}
              </button>
              {openJournal === id && (
                <div className="prose prose-sm max-w-none" style={{ marginTop: 8 }}>
                  {journalDetail ? (
                    <MarkdownViewer
                      content={
                        str(journalDetail.report_markdown) ||
                        [journalDetail.light_sleep_notes, journalDetail.rem_reflections, journalDetail.deep_consolidations].map(str).filter(Boolean).join("\n\n")
                      }
                    />
                  ) : (
                    <span style={{ fontSize: 12.5, color: "var(--aurora-fg3)" }}>{t.loading}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Glass>

      {inactive.length > 0 && (
        <Glass padding="12px 18px" radius={18}>
          <button
            type="button"
            onClick={() => setShowInactive((v) => !v)}
            style={{ display: "flex", width: "100%", alignItems: "center", background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left" }}
          >
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontSize: 13.5, color: "var(--aurora-fg2)" }}>{fmt(d.inactiveTitle, { n: inactive.length })}</span>
              <span style={{ display: "block", fontSize: 12, color: "var(--aurora-fg3)", marginTop: 2 }}>{d.inactiveHint}</span>
            </span>
            <Icon name={showInactive ? "minus" : "plus"} size={14} style={{ color: "var(--aurora-fg3)" }} />
          </button>
          {showInactive &&
            inactive.map((m) => (
              <div key={str(m.id)} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 0", borderTop: "1px solid var(--aurora-border)", marginTop: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <Chip tone="neutral">{statusLabel(m.status)}</Chip>
                    <span style={{ fontSize: 12, color: "var(--aurora-fg3)", fontFamily: "ui-monospace, monospace" }}>{str(m.tree_path)}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--aurora-fg2)", marginTop: 4, lineHeight: 1.45 }}>{str(m.content).slice(0, 300)}</div>
                  {str(m.status_reason) && <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 2 }}>{str(m.status_reason)}</div>}
                </div>
                <Btn variant="glass" size="sm" icon="refresh" onClick={() => revive(str(m.id))}>
                  {d.revive}
                </Btn>
              </div>
            ))}
        </Glass>
      )}
    </div>
  );
}
