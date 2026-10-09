"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, DailyDate } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { Btn, Glass, TopBar, SectionLabel } from "@/components/aurora/primitives";
import { ToolGlyph } from "@/components/aurora/Icon";

/** Return YYYY-MM key for a Date (local). */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string, locale: string): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString(locale, { year: "numeric", month: "long" });
}

/** Fills a 6-row (42-cell) month grid: Mon→Sun, with day numbers and counts. */
interface CalendarCell {
  date: string | null;
  day: number | null;
  count: number;
  tools: string[];
  inMonth: boolean;
}

function buildMonthGrid(
  monthKey: string,
  data: Map<string, { count: number; tools: string[] }>,
): CalendarCell[] {
  const [y, m] = monthKey.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const lastDay = new Date(y, m, 0).getDate();
  const firstWeekday = (first.getDay() + 6) % 7;

  const cells: CalendarCell[] = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push({ date: null, day: null, count: 0, tools: [], inMonth: false });
  }
  for (let d = 1; d <= lastDay; d++) {
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const entry = data.get(iso);
    cells.push({
      date: iso,
      day: d,
      count: entry?.count ?? 0,
      tools: entry?.tools ?? [],
      inMonth: true,
    });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ date: null, day: null, count: 0, tools: [], inMonth: false });
  }
  return cells;
}

export default function DailyPage() {
  const [allDates, setAllDates] = useState<DailyDate[]>([]);
  const [days, setDays] = useState(120);
  // Start as true so the first render shows loading, no cascade render needed.
  const [loading, setLoading] = useState(true);
  const [selectedMonth, setSelectedMonth] = useState<string>(() => monthKey(new Date()));
  const { t, locale } = useI18n();

  useEffect(() => {
    let cancelled = false;
    api
      .getDailyDates(days)
      .then((d) => { if (!cancelled) setAllDates(d); })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  // Map: YYYY-MM-DD → {count, tools}
  const countMap = useMemo(() => {
    const m = new Map<string, { count: number; tools: string[] }>();
    for (const d of allDates) m.set(d.date, { count: d.document_count, tools: d.tools ?? [] });
    return m;
  }, [allDates]);

  // Current month cells
  const cells = useMemo(() => buildMonthGrid(selectedMonth, countMap), [selectedMonth, countMap]);
  const monthCells = cells.filter((c) => c.inMonth);
  const monthTotal = monthCells.reduce((s, c) => s + c.count, 0);
  const activeDays = monthCells.filter((c) => c.count > 0).length;
  const busiestDay = monthCells.reduce<CalendarCell | null>(
    (best, c) => (c.count > (best?.count ?? 0) ? c : best),
    null
  );
  const dailyAvg = activeDays ? Math.round(monthTotal / activeDays) : 0;
  const maxCount = Math.max(1, ...monthCells.map((c) => c.count));

  // Month navigation
  const goMonth = (delta: number) => {
    const [y, m] = selectedMonth.split("-").map(Number);
    const next = new Date(y, m - 1 + delta, 1);
    const nextKey = monthKey(next);
    setSelectedMonth(nextKey);
    // Auto-extend history window if going way back
    const cutoff = Date.now() - days * 86400000;
    if (next.getTime() < cutoff) setDays(Math.min(365, days + 120));
  };

  const isCurrentMonth = selectedMonth === monthKey(new Date());

  return (
    <div className="max-w-6xl mx-auto">
      <TopBar
        title={t.daily.title}
        subtitle="Memory captured per day across all tools"
        right={
          <>
            <Btn variant="glass" size="sm" icon="chevron_left" onClick={() => goMonth(-1)}>
              Prev
            </Btn>
            <Btn
              variant="glass"
              size="sm"
              iconRight="chevron_right"
              onClick={() => goMonth(1)}
              disabled={isCurrentMonth}
            >
              Next
            </Btn>
          </>
        }
      />

      <div
        className="grid gap-5 lg:[grid-template-columns:minmax(0,1fr)_320px] grid-cols-1"
      >
        {/* Calendar */}
        <div className="min-w-0">
          <SectionLabel>{monthLabel(selectedMonth, locale)}</SectionLabel>
          <Glass padding={0} radius={18} style={{ overflow: "hidden" }}>
            {/* Day-of-week header */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
                borderBottom: "1px solid var(--aurora-border)",
                background: "var(--aurora-chip)",
              }}
            >
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                <div
                  key={d}
                  className="px-1.5 sm:px-3 py-1.5 sm:py-2 text-[9px] sm:text-[10px] text-center sm:text-left"
                  style={{
                    color: "var(--aurora-fg3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    fontWeight: 600,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                >
                  {d}
                </div>
              ))}
            </div>
            {/* Cells */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}>
              {cells.map((c, i) => (
                <DayCell
                  key={i}
                  cell={c}
                  intensity={maxCount ? c.count / maxCount : 0}
                  isLast={i >= cells.length - 7}
                  isEndOfRow={(i + 1) % 7 === 0}
                />
              ))}
            </div>
          </Glass>
        </div>

        {/* Right stats panel */}
        <div>
          <SectionLabel>This month</SectionLabel>
          <Glass padding={18} radius={18}>
            <div
              style={{
                fontSize: 36,
                fontWeight: 500,
                color: "var(--aurora-fg1)",
                letterSpacing: "-0.03em",
                lineHeight: 1,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              {loading ? "…" : monthTotal.toLocaleString()}
            </div>
            <div style={{ fontSize: 12, color: "var(--aurora-fg3)", marginTop: 4 }}>
              {t.daily.title} · {activeDays} active days
            </div>
            <div style={{ height: 1, background: "var(--aurora-border)", margin: "16px 0" }} />

            <StatRow label="Daily average" value={dailyAvg.toLocaleString()} />
            <StatRow
              label="Busiest day"
              value={
                busiestDay && busiestDay.count > 0
                  ? `${busiestDay.day} · ${busiestDay.count}`
                  : "—"
              }
            />
            <StatRow label="Active days" value={`${activeDays} / ${monthCells.length}`} />

            {allDates.length === 0 && !loading && (
              <p style={{ fontSize: 12, color: "var(--aurora-fg4)", marginTop: 14 }}>
                {t.daily.noActivity}
              </p>
            )}
          </Glass>
        </div>
      </div>
    </div>
  );
}

function DayCell({
  cell, intensity, isLast, isEndOfRow,
}: {
  cell: CalendarCell; intensity: number; isLast: boolean; isEndOfRow: boolean;
}) {
  const [hover, setHover] = useState(false);

  if (!cell.inMonth) {
    return (
      <div
        className="min-h-[54px] sm:min-h-[88px]"
        style={{
          background: "var(--aurora-surface-mute)",
          borderRight: isEndOfRow ? "none" : "1px solid var(--aurora-border)",
          borderBottom: isLast ? "none" : "1px solid var(--aurora-border)",
          opacity: 0.4,
        }}
      />
    );
  }

  const active = cell.count > 0;
  const hot = intensity > 0.55;
  // Aurora-only: stronger color-mix; Arc/Baseline: subtle.
  // Implement dual-level via two strategies baked in one expression:
  // cell bg at intensity 0 = surface; at 1 = ~80% accent.
  const bg = active
    ? `color-mix(in oklch, var(--aurora-accent) ${Math.round(12 + intensity * 68)}%, var(--aurora-surface-solid))`
    : "var(--aurora-surface-solid)";
  const textColor = hot ? "#fff" : "var(--aurora-fg2)";

  return (
    <Link
      href={`/daily/${cell.date}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="min-h-[54px] sm:min-h-[88px] p-1 sm:p-2.5 flex flex-col"
      style={{
        position: "relative",
        borderRight: isEndOfRow ? "none" : "1px solid var(--aurora-border)",
        borderBottom: isLast ? "none" : "1px solid var(--aurora-border)",
        background: bg,
        textDecoration: "none",
        transition: "transform .15s, box-shadow .15s",
        transform: hover ? "scale(1.04)" : "none",
        boxShadow: hover ? "0 8px 20px -8px color-mix(in srgb, var(--aurora-accent) 40%, transparent)" : "none",
        zIndex: hover ? 1 : 0,
      }}
      title={cell.date ? `${cell.date}: ${cell.count}` : undefined}
    >
      {/* Top row: day + count side-by-side, always in flow */}
      <div className="flex items-baseline justify-between gap-0.5 sm:gap-1 min-w-0">
        <span
          className="text-[9px] sm:text-[11px] flex-shrink-0"
          style={{
            color: hot ? "rgba(255,255,255,0.85)" : "var(--aurora-fg3)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          {String(cell.day).padStart(2, "0")}
        </span>
        <span
          className="text-[11px] sm:text-xl truncate"
          style={{
            fontWeight: 500,
            letterSpacing: "-0.03em",
            color: active ? textColor : "var(--aurora-fg5)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          {active ? cell.count : "·"}
        </span>
      </div>

      {/* Bottom row: tools — separate row, no overlap with count */}
      {active && cell.tools.length > 0 && (
        <div
          className="flex gap-0.5 sm:gap-1 mt-auto pt-1 scale-[0.8] sm:scale-100 origin-bottom-left"
          style={{ opacity: hot ? 0.95 : 0.85 }}
        >
          {cell.tools.slice(0, 4).map((tid) => (
            <ToolGlyph key={tid} id={tid} size={14} />
          ))}
        </div>
      )}
    </Link>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        padding: "6px 0",
        fontSize: 12,
      }}
    >
      <span style={{ color: "var(--aurora-fg3)" }}>{label}</span>
      <span
        style={{
          color: "var(--aurora-fg1)",
          fontWeight: 500,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}
      >
        {value}
      </span>
    </div>
  );
}
