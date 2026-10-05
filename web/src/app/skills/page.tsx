"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import { api } from "@/lib/api-client";
import { fmt, useI18n } from "@/lib/i18n";
import { Btn, Chip, Glass } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import CognitiveCompass from "@/components/memory/CognitiveCompass";
import type { SkillItem } from "@/components/skills/SkillMatrix3D";

const SkillMatrix3D = dynamic(
  () => import("@/components/skills/SkillMatrix3D"),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full rounded-3xl bg-[var(--aurora-surface)] border border-[var(--aurora-border)] animate-pulse flex flex-col items-center justify-center gap-3 text-xs text-[var(--aurora-fg3)]">
        <div className="w-10 h-10 rounded-2xl bg-[var(--aurora-accent)]/20 animate-spin border-2 border-transparent border-t-[var(--aurora-accent)]" />
        <span className="font-mono">正在载入 3D 技能科技树星阵...</span>
      </div>
    ),
  }
);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []) as Obj[];
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (v == null ? "" : String(v));
const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

function time(iso: unknown): string {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const mono: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const field: CSSProperties = {
  width: "100%",
  fontSize: 13,
  padding: "8px 12px",
  borderRadius: 12,
  border: "1px solid var(--aurora-border-strong)",
  background: "var(--aurora-surface-solid)",
  color: "var(--aurora-fg1)",
};

function SkillEditor({
  skill,
  busy,
  onSave,
  onCancel,
}: {
  skill: Obj;
  busy: boolean;
  onSave: (edits: Obj, publish: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const s = t.skills;
  const [title, setTitle] = useState(str(skill.title));
  const [slug, setSlug] = useState(str(skill.slug));
  const [description, setDescription] = useState(str(skill.description));
  const [body, setBody] = useState(str(skill.body));
  const isDraft = skill.status === "draft";
  const edits = { title: title.trim(), slug: slug.trim(), description: description.trim(), body };
  const label = (text: string, hint?: string) => (
    <div style={{ fontSize: 12, color: "var(--aurora-fg3)", margin: "10px 0 4px" }}>
      {text}
      {hint && <span style={{ color: "var(--aurora-fg4)" }}> · {hint}</span>}
    </div>
  );
  return (
    <div className="mt-3 p-4 rounded-2xl bg-[var(--aurora-surface-mute)] border border-[var(--aurora-border)] animate-in fade-in">
      {label(s.fieldTitle)}
      <input value={title} onChange={(e) => setTitle(e.target.value)} style={field} />
      {label(s.fieldSlug, s.fieldSlugHint)}
      <input value={slug} onChange={(e) => setSlug(e.target.value)} style={{ ...field, ...mono }} />
      {label(s.fieldDescription, s.fieldDescriptionHint)}
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} style={{ ...field, resize: "vertical" }} />
      {label(s.fieldBody)}
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} style={{ ...field, ...mono, lineHeight: 1.55, resize: "vertical" }} />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
        <Btn variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t.cancel}
        </Btn>
        {isDraft && (
          <Btn variant="glass" size="sm" onClick={() => onSave(edits, false)} disabled={busy}>
            {s.save}
          </Btn>
        )}
        <Btn size="sm" icon="rocket" onClick={() => onSave(edits, true)} disabled={busy || !edits.title || !edits.slug}>
          {isDraft ? s.saveAndPublish : s.saveNewVersion}
        </Btn>
      </div>
    </div>
  );
}

export default function SkillsPage() {
  const { t } = useI18n();
  const s = t.skills;
  const [data, setData] = useState<Obj | null>(null);
  const [reviews, setReviews] = useState<Obj>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [showUpdate, setShowUpdate] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Navigation tab for Right Wing
  const [activeTab, setActiveTab] = useState<"published" | "drafts" | "reviews" | "archived">("published");

  // 3D Skill Matrix Synergy State
  const [selectedSkillSlug, setSelectedSkillSlug] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fullscreen Theater & Panel Collapse State (Default: True for 100% 3D Skill Matrix)
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(true);
  const cockpitRef = useRef<HTMLDivElement>(null);

  const togglePhysicalFullscreen = () => {
    if (!document.fullscreenElement) {
      cockpitRef.current?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  };

  const job = reviews.job ? obj(reviews.job) : null;
  const reviewRunning = job?.status === "running";

  const load = useCallback(async () => {
    try {
      const [skills, rev] = await Promise.all([api.getSkills(), api.getReviews().catch(() => ({}))]);
      setData(skills);
      setReviews(rev);
      setError(null);
      return obj(obj(rev).job).status === "running";
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg.includes("404") ? s.tooOld : msg);
      return false;
    }
  }, [s]);

  const jobSummary = useCallback(
    (j: Obj) => {
      if (j.status === "error") return fmt(s.reviewError, { error: str(j.error) });
      const sessions = obj(obj(j.result).sessions);
      const reviewed = num(sessions.reviewed);
      if (reviewed === 0) return s.reviewNothing;
      return fmt(s.reviewDone, { n: reviewed, skills: count(sessions.skills_new), pitfalls: num(sessions.pitfalls_new), todos: num(sessions.todos_new) });
    },
    [s]
  );

  const startPolling = useCallback(() => {
    if (poll.current) return;
    poll.current = setInterval(async () => {
      const running = await load();
      if (!running && poll.current) {
        clearInterval(poll.current);
        poll.current = null;
        const rev = await api.getReviews().catch(() => ({}) as Obj);
        if (obj(rev).job) setNotice(jobSummary(obj(obj(rev).job)));
      }
    }, 5000);
  }, [load, jobSummary]);

  useEffect(() => {
    load().then((running) => running && startPolling());
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [load, startPolling]);

  const act = async (id: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const reviewNow = async () => {
    setBusy("review");
    setNotice(null);
    try {
      await api.startReview();
      setNotice(s.reviewStarted);
      await load();
      startPolling();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const drafts = list(data?.drafts);
  const published = list(data?.published);
  const archived = list(data?.archived);

  // Map into SkillItem for 3D matrix
  const matrixSkills = useMemo<SkillItem[]>(() => {
    const pList: SkillItem[] = published.map((p) => ({
      id: str(p.id),
      slug: str(p.slug),
      title: str(p.title),
      description: str(p.description),
      status: "published",
      version: num(p.version) || 1,
      body: str(p.body),
      results: obj(p.results),
    }));
    const dList: SkillItem[] = drafts.map((d) => ({
      id: str(d.id),
      slug: str(d.slug),
      title: str(d.title),
      description: str(d.description),
      status: "draft",
      version: num(d.version) || 0,
      body: str(d.body),
      results: obj(d.results),
    }));
    return [...pList, ...dList];
  }, [published, drafts]);

  // Handle 3D skill selection
  const handleSelectSkillFrom3D = (skill: SkillItem | null) => {
    if (!skill) {
      setSelectedSkillSlug(null);
      return;
    }
    setSelectedSkillSlug(skill.slug || null);
    if (skill.status === "draft") {
      setActiveTab("drafts");
    } else {
      setActiveTab("published");
    }
    if (skill.id) {
      setExpanded((prev) => new Set(prev).add(skill.id!));
    }
  };

  const [copiedSkillSlug, setCopiedSkillSlug] = useState<string | null>(null);

  const selectedSkillObj = useMemo(() => {
    if (!selectedSkillSlug) return null;
    return matrixSkills.find((s) => s.slug === selectedSkillSlug) || null;
  }, [matrixSkills, selectedSkillSlug]);

  const activeRawSkill = useMemo(() => {
    if (!selectedSkillSlug) return null;
    return (
      published.find((p) => p.slug === selectedSkillSlug) ||
      drafts.find((d) => d.slug === selectedSkillSlug) ||
      null
    );
  }, [published, drafts, selectedSkillSlug]);

  const handleCopySkillBody = (text: string, slug: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSkillSlug(slug);
    setTimeout(() => setCopiedSkillSlug(null), 2000);
  };

  const reviewList = list(reviews.reviews);
  const stats = obj(reviews.stats);
  const outcomes = obj(stats.outcomes);
  const outcomeLabels: Record<string, string> = {
    done: s.outcomeDone,
    partial: s.outcomePartial,
    failed: s.outcomeFailed,
    chat: s.outcomeChat,
    error: s.outcomeError,
    unknown: s.outcomeUnknown,
  };
  const outcomeTone = (o: string) =>
    o === "done" ? "success" : o === "failed" || o === "error" ? "danger" : o === "partial" ? "warn" : "neutral";

  const renderSkillCard = (skill: Obj) => {
    const id = str(skill.id);
    const slug = str(skill.slug);
    const status = str(skill.status) || "draft";
    const disabled = busy !== null;
    const update = skill.pending_update ? obj(skill.pending_update) : null;
    const evidence = list(skill.evidence);
    const isExpanded = expanded.has(id);
    const isSelectedIn3D = selectedSkillSlug === slug;

    return (
      <div
        key={id}
        onClick={() => setSelectedSkillSlug(slug)}
        className={`p-4 rounded-2xl border transition-all flex flex-col justify-between cursor-pointer ${
          isSelectedIn3D
            ? "bg-[var(--aurora-surface-solid)] border-[var(--aurora-accent)] shadow-md ring-1 ring-[var(--aurora-accent)]/30"
            : "bg-[var(--aurora-surface-solid)] border-[var(--aurora-border)] hover:border-[var(--aurora-border-strong)]"
        }`}
      >
        <div>
          {/* Card Header */}
          <div className="flex items-start justify-between gap-3 pb-2.5 mb-2.5 border-b border-[var(--aurora-border)]">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-xl flex items-center justify-center bg-[rgba(245,158,11,0.12)] text-[#F59E0B] shrink-0">
                <Icon name="zap" size={15} />
              </div>
              <div className="min-w-0">
                <h3 className="text-xs sm:text-sm font-bold text-[var(--aurora-fg1)] truncate">
                  {str(skill.title)}
                </h3>
                <span className="text-[10px] font-mono text-[var(--aurora-fg4)] truncate block">
                  /{slug}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[var(--aurora-chip)] text-[var(--aurora-fg2)] font-semibold">
                {status === "published" ? `v${str(skill.version || "1.0")}` : "草稿"}
              </span>
              {isSelectedIn3D && (
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[var(--aurora-accent)]/15 text-[var(--aurora-accent)] border border-[var(--aurora-accent)]/30">
                  3D 对焦中
                </span>
              )}
            </div>
          </div>

          <p className="text-xs text-[var(--aurora-fg2)] leading-relaxed mb-3">
            {str(skill.description)}
          </p>

          {/* Update Notice */}
          {update && (
            <div className="mb-3 p-2.5 rounded-xl bg-[rgba(217,119,6,0.08)] border border-[rgba(217,119,6,0.25)] text-xs">
              <div className="font-semibold text-[#B45309] mb-1">发现新版技能演进建议：</div>
              <p className="text-[var(--aurora-fg3)]">{str(update.reason)}</p>
              {showUpdate === id && (
                <div className="mt-2 pt-2 border-t border-[rgba(217,119,6,0.2)] prose prose-sm max-w-none text-xs">
                  <MarkdownViewer content={str(update.body)} />
                </div>
              )}
              <div className="flex gap-1.5 justify-end mt-2">
                <Btn variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); act(id, () => api.skillAction(id, "update/discard")); }}>忽略</Btn>
                <Btn variant="glass" size="sm" onClick={(e) => { e.stopPropagation(); setShowUpdate(showUpdate === id ? null : id); }}>
                  {showUpdate === id ? "收起" : "对比变更"}
                </Btn>
                <Btn size="sm" onClick={(e) => { e.stopPropagation(); act(id, () => api.skillAction(id, "update/apply"), s.updateApplied); }}>应用更新</Btn>
              </div>
            </div>
          )}

          {/* Expanded Step Body */}
          {isExpanded && (
            <div className="mb-3 p-3 rounded-xl bg-[var(--aurora-surface)] border border-[var(--aurora-border)]">
              <div className="prose prose-sm max-w-none text-xs leading-relaxed">
                <MarkdownViewer content={str(skill.body)} />
              </div>
              {evidence.length > 0 && (
                <div className="mt-2 pt-2 border-t border-[var(--aurora-border)] text-[10px] text-[var(--aurora-fg4)]">
                  提炼自最近真实操作会话：{str(evidence[evidence.length - 1]?.title || "日常编码实践")}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Card Footer Actions */}
        <div className="pt-2.5 border-t border-[var(--aurora-border)] flex items-center justify-between" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => toggle(id)}
            className="text-xs text-[var(--aurora-accent)] hover:underline flex items-center gap-1 font-medium"
          >
            <Icon name={isExpanded ? "minus" : "plus"} size={11} />
            <span>{isExpanded ? "收起步骤指令" : "查看执行指令"}</span>
          </button>

          <div className="flex items-center gap-1.5">
            {status === "draft" && (
              <>
                <Btn variant="ghost" size="sm" disabled={disabled} onClick={() => act(id, () => api.skillAction(id, "dismiss"))}>
                  放弃
                </Btn>
                <Btn variant="glass" size="sm" icon="edit" disabled={disabled} onClick={() => setEditing(id)}>
                  编辑
                </Btn>
                <Btn size="sm" icon="rocket" disabled={disabled} onClick={() => act(id, () => api.publishSkill(id), s.publishedNotice)}>
                  发布
                </Btn>
              </>
            )}
            {status === "published" && (
              <>
                <Btn variant="ghost" size="sm" disabled={disabled} onClick={() => act(id, () => api.skillAction(id, "retire"), s.retiredNotice)}>
                  归档
                </Btn>
                <Btn variant="glass" size="sm" icon="edit" disabled={disabled} onClick={() => setEditing(id)}>
                  微调
                </Btn>
              </>
            )}
          </div>
        </div>

        {editing === id && (
          <div onClick={(e) => e.stopPropagation()}>
            <SkillEditor
              skill={skill}
              busy={disabled}
              onCancel={() => setEditing(null)}
              onSave={(edits, publish) =>
                publish && status === "draft"
                  ? act(id, () => api.publishSkill(id, edits), s.publishedNotice)
                  : act(id, () => api.editSkill(id, edits), status === "draft" ? s.saved : s.savedNewVersion)
              }
            />
          </div>
        )}
      </div>
    );
  };

  const filteredPublished = useMemo(() => {
    if (!searchQuery.trim()) return published;
    const q = searchQuery.toLowerCase().trim();
    return published.filter(
      (p) => str(p.title).toLowerCase().includes(q) || str(p.slug).toLowerCase().includes(q) || str(p.description).toLowerCase().includes(q)
    );
  }, [published, searchQuery]);

  const filteredDrafts = useMemo(() => {
    if (!searchQuery.trim()) return drafts;
    const q = searchQuery.toLowerCase().trim();
    return drafts.filter(
      (d) => str(d.title).toLowerCase().includes(q) || str(d.slug).toLowerCase().includes(q) || str(d.description).toLowerCase().includes(q)
    );
  }, [drafts, searchQuery]);

  return (
    <div className="h-[calc(100dvh-68px)] max-h-[calc(100dvh-68px)] flex flex-col gap-2 overflow-hidden">
      {/* ─────────────────────────────────────────────────────────────
          1. 统一顶栏 (Ultra-Refined Single-Row Cockpit Header)
          ───────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 pb-1 border-b border-[var(--aurora-border)] shrink-0 flex-wrap sm:flex-nowrap">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-xl flex items-center justify-center bg-[rgba(245,158,11,0.12)] text-[#F59E0B] shadow-xs shrink-0">
            <Icon name="zap" size={16} />
          </div>
          <div className="flex items-center gap-1.5 min-w-0">
            <h1 className="text-xs sm:text-base font-bold text-[var(--aurora-fg1)] tracking-tight truncate">
              技能进化 · 科技树
            </h1>
            <span className="text-[10px] px-2 py-0.2 rounded-full font-medium bg-[rgba(16,185,129,0.12)] text-[#10B981] hidden md:flex items-center gap-1 font-mono shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] breathing-glow-emerald" />
              Agent Skill 协议就绪 · 5 端全息注入
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Btn
            variant="glass"
            size="sm"
            icon="refresh"
            disabled={reviewRunning || busy !== null}
            onClick={reviewNow}
          >
            {reviewRunning ? s.reviewing : "自动审查提炼技能"}
          </Btn>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          Cognitive Compass Compact Header Bar (36px Height)
          ───────────────────────────────────────────────────────────── */}
      <div className="shrink-0">
        <CognitiveCompass
          currentTab="skills"
          variant="compact"
          summaryStats={{
            skillsCount: published.length + drafts.length,
            syncedTargetsCount: 5,
          }}
        />
      </div>

      {error && (
        <Glass padding={8} radius={10} className="shrink-0" style={{ color: "#DC2626", fontSize: 11 }}>
          {error}
        </Glass>
      )}
      {notice && (
        <Glass padding={8} radius={10} className="shrink-0" style={{ color: "var(--aurora-fg2)", fontSize: 11 }}>
          <div className="flex items-center justify-between">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} className="text-[var(--aurora-fg4)] hover:text-[var(--aurora-fg1)]">
              <Icon name="close" size={10} />
            </button>
          </div>
        </Glass>
      )}

      {/* ─────────────────────────────────────────────────────────────
          2. 一屏全景双翼驾驶舱 (Unified Single-Screen Twin Cockpit)
          ───────────────────────────────────────────────────────────── */}
      <div ref={cockpitRef} className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 min-h-0 overflow-hidden relative">
        {/* ── 左翼: 3D 技能科技树与 5 端激光阵列主舞台 (支持 100% 满屏沉浸与分屏联动) ── */}
        <div className={`h-full flex flex-col min-h-0 relative rounded-3xl overflow-hidden border border-[var(--aurora-border)] bg-[var(--aurora-surface)] shadow-xl transition-all duration-300 ${
          isPanelCollapsed ? "lg:col-span-12 w-full" : "lg:col-span-5"
        }`}>
          <SkillMatrix3D
            skills={matrixSkills}
            selectedSlug={selectedSkillSlug}
            onSelectSkill={handleSelectSkillFrom3D}
            isPanelCollapsed={isPanelCollapsed}
            onToggleCollapse={() => setIsPanelCollapsed(!isPanelCollapsed)}
            onToggleFullscreen={togglePhysicalFullscreen}
            isPaused={!isPanelCollapsed}
            className="w-full h-full"
          />

          {/* 3D 场景内全息技能 SOP 详情视窗 (In-Scene Holographic Skill SOP Inspector) */}
          {selectedSkillObj && (
            <>
              {/* Mobile Backdrop to prevent gesture leakage */}
              <div
                onClick={() => handleSelectSkillFrom3D(null)}
                className="sm:hidden absolute inset-0 z-25 bg-black/60 backdrop-blur-xs animate-in fade-in"
              />
              <div
                onTouchStart={(e) => e.stopPropagation()}
                className="absolute z-30 max-sm:inset-x-2 max-sm:bottom-2 max-sm:max-h-[72vh] sm:top-14 sm:right-3 sm:bottom-3 sm:w-[380px] xl:w-[440px] flex flex-col pointer-events-auto bg-black/90 backdrop-blur-2xl border border-white/20 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in max-sm:slide-in-from-bottom-6 sm:slide-in-from-right-4 duration-200"
              >
                {/* Mobile Drag Handle */}
                <div className="w-10 h-1 rounded-full bg-white/25 mx-auto my-1.5 sm:hidden shrink-0" />

              {/* Top Title & Quick Actions */}
              <div className="p-3.5 border-b border-white/10 bg-white/5 flex items-start justify-between gap-2 shrink-0">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={`text-[9px] font-mono px-2 py-0.5 rounded-full font-bold uppercase ${
                        selectedSkillObj.status === "published"
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                          : "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                      }`}
                    >
                      {selectedSkillObj.status === "published" ? "✓ 生产运行中" : "⚡ 演进草稿"}
                    </span>
                    <span className="text-[10px] font-mono text-white/50 px-1.5 py-0.5 rounded bg-white/10">
                      v{selectedSkillObj.version}
                    </span>
                    <span className="text-[10px] font-mono text-amber-400 font-bold truncate">
                      /{selectedSkillObj.slug}
                    </span>
                  </div>
                  <h3 className="text-sm font-bold text-white truncate tracking-tight">
                    {selectedSkillObj.title || selectedSkillObj.slug}
                  </h3>
                  {selectedSkillObj.description && (
                    <p className="text-[11px] text-white/70 line-clamp-2 leading-relaxed">
                      {selectedSkillObj.description}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleCopySkillBody(selectedSkillObj.body || "", selectedSkillObj.slug || "")}
                    className="p-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white/80 hover:text-white transition-all text-xs flex items-center gap-1"
                    title="复制 SOP 完整指令"
                  >
                    <Icon name="copy" size={13} />
                    <span className="text-[10px] font-mono">
                      {copiedSkillSlug === selectedSkillObj.slug ? "已复制" : "复制代码"}
                    </span>
                  </button>
                  <button
                    onClick={() => setSelectedSkillSlug(null)}
                    className="p-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-all"
                    title="关闭视窗"
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              </div>

              {/* 5 端全息实时注入基座状态指示 */}
              <div className="px-3.5 py-2 bg-black/40 border-b border-white/5 flex items-center justify-between text-[10px] font-mono shrink-0">
                <span className="text-white/60 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 breathing-glow-emerald" />
                  5 端热注入就绪
                </span>
                <div className="flex items-center gap-1">
                  {["Claude", "Cursor", "OpenCode", "VSCode", "Windsurf"].map((c) => (
                    <span key={c} className="px-1.5 py-0.2 rounded bg-white/10 text-white/80 text-[9px]">
                      {c}
                    </span>
                  ))}
                </div>
              </div>

              {/* Scrollable SOP Markdown Instructions Content */}
              <div className="flex-1 min-h-0 overflow-y-auto p-3.5 space-y-3 custom-scrollbar text-xs leading-relaxed text-white/90">
                <div className="text-[11px] font-mono text-white/50 flex items-center justify-between">
                  <span>📄 标准作业程序 (SOP) 执行指令</span>
                  <span>{selectedSkillObj.body?.length || 0} 字符</span>
                </div>
                {selectedSkillObj.body ? (
                  <div className="p-3 rounded-xl bg-white/5 border border-white/10 font-mono text-[11px] text-white/90 overflow-x-auto">
                    <MarkdownViewer content={selectedSkillObj.body} />
                  </div>
                ) : (
                  <div className="text-white/40 text-center py-6 text-xs font-mono">
                    该技能暂未定义正文指令
                  </div>
                )}

                {/* 演化复盘分析元数据 (若有) */}
                {selectedSkillObj.results && Object.keys(selectedSkillObj.results).length > 0 && (
                  <div className="p-2.5 rounded-xl bg-purple-500/10 border border-purple-500/20 text-[10px] space-y-1">
                    <div className="font-bold text-purple-300 font-mono flex items-center gap-1">
                      <Icon name="sparkles" size={12} />
                      <span>自进化复盘元数据</span>
                    </div>
                    <pre className="text-white/70 overflow-x-auto whitespace-pre-wrap font-mono">
                      {JSON.stringify(selectedSkillObj.results, null, 2)}
                    </pre>
                  </div>
                )}
              </div>

              {/* Bottom Quick Action Footer */}
              <div className="p-2.5 bg-white/5 border-t border-white/10 flex items-center justify-between gap-2 shrink-0">
                <div className="text-[10px] font-mono text-white/50">
                  点击 3D 外部空白可取消对焦
                </div>
                {activeRawSkill && (
                  <button
                    onClick={() => {
                      if (selectedSkillObj.status === "draft") {
                        setActiveTab("drafts");
                        setEditing(str(activeRawSkill.id));
                      } else {
                        setActiveTab("published");
                        setShowUpdate(str(activeRawSkill.id));
                      }
                      setIsPanelCollapsed(false);
                    }}
                    className="px-3 py-1 rounded-xl text-xs font-semibold bg-[var(--aurora-accent)] text-white hover:opacity-90 transition-all flex items-center gap-1 shadow-md"
                  >
                    <Icon name="edit" size={12} />
                    <span>在编辑台打开</span>
                  </button>
                )}
              </div>
            </div>
            </>
          )}

          {/* 3D 悬浮底部小指示器 (未选中时提示) */}
          {!selectedSkillObj && (
            <div className="absolute bottom-3 left-3 right-3 pointer-events-none text-center">
              <span className="text-[10px] font-mono text-white/70 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/15 pointer-events-auto shadow-lg">
                点击技能晶核发射激光束注入 5 端基座并在场景内查看 SOP · 滚轮缩放 · 左键旋转
              </span>
            </div>
          )}
        </div>

        {/* ── 右翼 (7 列 / 58%): 技能列表、演进草稿与审查动态 (移动端自适应全屏抽屉，桌面端双翼分屏) ── */}
        {!isPanelCollapsed && (
          <div className="max-lg:fixed max-lg:inset-0 max-lg:z-50 max-lg:rounded-none max-lg:border-none lg:col-span-7 h-full flex flex-col min-h-0 bg-[var(--aurora-surface)] rounded-3xl border border-[var(--aurora-border)] shadow-2xl overflow-hidden animate-in fade-in max-lg:slide-in-from-bottom-6 duration-300">
            {/* A. 顶部仪表盘概览与 Tab 导航区 (Sticky Header) */}
            <div className="p-3 bg-gradient-to-r from-[var(--aurora-surface-solid)] via-[var(--aurora-surface)] to-[var(--aurora-chip)] border-b border-[var(--aurora-border)] shrink-0 space-y-2.5">
              {/* Mobile Back Button to 3D */}
              <div className="flex items-center justify-between lg:hidden pb-1 border-b border-white/10">
                <button
                  onClick={() => setIsPanelCollapsed(true)}
                  className="px-2.5 py-1 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-semibold flex items-center gap-1.5 shrink-0 text-white"
                >
                  <Icon name="arrow_left" size={14} />
                  <span>返回 3D 科技树</span>
                </button>
                <span className="text-[11px] font-mono text-white/50">技能管理中枢</span>
              </div>
              {/* 三列高级 KPI 态势磁贴 */}
              <div className="grid grid-cols-3 gap-2">
                {/* Tile 1: 活跃上线技能 */}
                <div className="p-2 rounded-xl bg-[var(--aurora-surface)]/80 border border-[var(--aurora-border)] flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-[var(--aurora-fg4)]">活跃上线技能</div>
                    <div className="text-xs font-bold text-[#10B981] font-mono mt-0.5">
                      {published.length} <span className="text-[10px] font-normal text-[var(--aurora-fg3)]">个</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[rgba(16,185,129,0.1)] text-[#10B981]">
                      Agent Skill 协议
                    </span>
                  </div>
                </div>

                {/* Tile 2: 待审草稿与演进 */}
                <div className="p-2 rounded-xl bg-[var(--aurora-surface)]/80 border border-[var(--aurora-border)] flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-[var(--aurora-fg4)]">待审草稿与演进</div>
                    <div className="text-xs font-bold text-[#F59E0B] font-mono mt-0.5">
                      {drafts.length} <span className="text-[10px] font-normal text-[var(--aurora-fg3)]">个</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[rgba(245,158,11,0.1)] text-[#F59E0B]">
                      会话挖掘
                    </span>
                  </div>
                </div>

                {/* Tile 3: 5 端受护运行时 */}
                <div className="p-2 rounded-xl bg-[var(--aurora-surface)]/80 border border-[var(--aurora-border)] flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-[var(--aurora-fg4)]">全息注入终端</div>
                    <div className="text-xs font-bold text-[#3B82F6] font-mono mt-0.5">
                      5 <span className="text-[10px] font-normal text-[var(--aurora-fg3)]">端在线</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[rgba(59,130,246,0.1)] text-[#3B82F6]">
                      全部激活
                    </span>
                  </div>
                </div>
              </div>

              {/* Navigation Tabs Bar */}
              <div className="flex items-center justify-between gap-2 overflow-x-auto pb-0.5">
                <div className="flex items-center gap-1.5">
                  {[
                    { id: "published", label: `⚡ 活跃技能 (${published.length})`, color: "#10B981" },
                    { id: "drafts", label: `📝 演进草稿 (${drafts.length})`, color: "#F59E0B" },
                    { id: "reviews", label: `🔄 审查动态 ${reviewRunning ? "· 进行中" : ""}`, color: "#3B82F6" },
                    { id: "archived", label: `📦 历史归档 (${archived.length})`, color: "#64748B" },
                  ].map((tb) => (
                    <button
                      key={tb.id}
                      onClick={() => setActiveTab(tb.id as typeof activeTab)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all border ${
                        activeTab === tb.id
                          ? "bg-[var(--aurora-surface-solid)] text-[var(--aurora-fg1)] border-[var(--aurora-border-strong)] shadow-xs font-bold"
                          : "border-transparent text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-surface-solid)]/60"
                      }`}
                    >
                      {tb.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Search input */}
                  <div className="relative w-32 shrink-0">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="过滤技能..."
                      className="w-full pl-6 pr-2 py-0.8 text-[11px] rounded-lg bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] text-[var(--aurora-fg1)] placeholder-[var(--aurora-fg4)] focus:outline-hidden focus:border-[var(--aurora-accent)]"
                    />
                    <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--aurora-fg4)]">
                      <Icon name="search" size={10} />
                    </span>
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery("")}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--aurora-fg4)] hover:text-[var(--aurora-fg1)]"
                      >
                        <Icon name="close" size={9} />
                      </button>
                    )}
                  </div>

                  {/* 收起面板让 3D 铺满全屏按钮 */}
                  <button
                    onClick={() => setIsPanelCollapsed(true)}
                    className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] border border-[var(--aurora-border)] transition-all shadow-2xs"
                    title="收起右侧面板，3D 科技树铺满全屏"
                  >
                    <Icon name="sidebar" size={13} />
                  </button>
                </div>
              </div>
          </div>

          {/* B. 内容滚动主视口 (Smooth Inner Scroll Container) */}
          <div className="flex-1 overflow-y-auto p-3.5 space-y-3 min-h-0 scrollbar-thin">
            {/* ── TAB 1: 活跃上线技能 (Published) ── */}
            {activeTab === "published" && (
              <div className="space-y-2.5 animate-in fade-in">
                {filteredPublished.length === 0 ? (
                  <div className="p-8 text-center text-xs text-[var(--aurora-fg4)] bg-[var(--aurora-surface-solid)] rounded-2xl border border-[var(--aurora-border)]">
                    {searchQuery ? "未找到匹配的上线技能" : "暂无已发布技能，可在「演进草稿」中发布或通过日常编码自动提炼"}
                  </div>
                ) : (
                  filteredPublished.map(renderSkillCard)
                )}
              </div>
            )}

            {/* ── TAB 2: 演进建议与草稿 (Drafts) ── */}
            {activeTab === "drafts" && (
              <div className="space-y-2.5 animate-in fade-in">
                {filteredDrafts.length === 0 ? (
                  <div className="p-8 text-center text-xs text-[var(--aurora-fg4)] bg-[var(--aurora-surface-solid)] rounded-2xl border border-[var(--aurora-border)]">
                    {searchQuery ? "未找到匹配的草稿" : "当前无待审技能草稿，系统将在会话复盘中持续挖掘高价值操作"}
                  </div>
                ) : (
                  filteredDrafts.map(renderSkillCard)
                )}
              </div>
            )}

            {/* ── TAB 3: 审查动态 (Reviews) ── */}
            {activeTab === "reviews" && (
              <div className="space-y-3 animate-in fade-in">
                {job && (
                  <div className="p-3.5 rounded-2xl bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold text-[var(--aurora-fg1)] flex items-center gap-1.5">
                        {reviewRunning && (
                          <span className="w-2 h-2 rounded-full bg-[var(--aurora-accent)] animate-ping" />
                        )}
                        <span>审查任务状态：{str(job.status)}</span>
                      </div>
                      <div className="text-[11px] text-[var(--aurora-fg3)] mt-0.5">
                        {jobSummary(job)}
                      </div>
                    </div>
                    <Btn
                      variant="glass"
                      size="sm"
                      icon="refresh"
                      disabled={reviewRunning || busy !== null}
                      onClick={reviewNow}
                    >
                      {reviewRunning ? s.reviewing : "重新审查"}
                    </Btn>
                  </div>
                )}

                {/* Outcome Stats Pills */}
                {Object.keys(outcomes).length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {Object.entries(outcomes).map(([outcome, cnt]) => (
                      <div
                        key={outcome}
                        className="p-2.5 rounded-xl bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] text-xs flex items-center justify-between"
                      >
                        <span className="text-[var(--aurora-fg3)]">
                          {outcomeLabels[outcome] || outcome}
                        </span>
                        <span className="font-mono font-bold text-[var(--aurora-fg1)]">
                          {num(cnt)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Review Sessions List */}
                <div className="space-y-2">
                  <div className="text-xs font-bold text-[var(--aurora-fg2)]">
                    会话复盘审查记录 ({reviewList.length})
                  </div>
                  {reviewList.length === 0 ? (
                    <div className="p-6 text-center text-xs text-[var(--aurora-fg4)] bg-[var(--aurora-surface-solid)] rounded-2xl border border-[var(--aurora-border)]">
                      暂无审查审计记录
                    </div>
                  ) : (
                    reviewList.map((r, i) => (
                      <div
                        key={i}
                        className="p-3 rounded-xl bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] text-xs space-y-1"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-[var(--aurora-fg1)]">
                            {str(r.session_title || r.title || `会话审计 #${i + 1}`)}
                          </span>
                          <span className="text-[10px] font-mono text-[var(--aurora-fg4)]">
                            {time(r.created_at || r.reviewed_at)}
                          </span>
                        </div>
                        {Boolean(r.notes) && (
                          <p className="text-[11px] text-[var(--aurora-fg3)] leading-relaxed">
                            {str(r.notes)}
                          </p>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* ── TAB 4: 历史归档 (Archived) ── */}
            {activeTab === "archived" && (
              <div className="space-y-2.5 animate-in fade-in">
                {archived.length === 0 ? (
                  <div className="p-8 text-center text-xs text-[var(--aurora-fg4)] bg-[var(--aurora-surface-solid)] rounded-2xl border border-[var(--aurora-border)]">
                    暂无已归档技能
                  </div>
                ) : (
                  archived.map(renderSkillCard)
                )}
              </div>
            )}
          </div>
        </div>
      )}

        {/* 当处于全屏铺满模式时，右侧边缘浮动的展开技能中枢悬浮岛 */}
        {isPanelCollapsed && (
          <button
            onClick={() => setIsPanelCollapsed(false)}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-30 px-3.5 py-2 rounded-2xl bg-black/80 hover:bg-black/95 backdrop-blur-2xl border border-white/25 text-white shadow-2xl transition-all flex items-center gap-2 group text-xs font-mono animate-in slide-in-from-right duration-300 hover:scale-105"
            title="展开右侧技能与 SOP 中枢"
          >
            <Icon name="chevron_left" size={14} className="text-[#F59E0B] group-hover:-translate-x-0.5 transition-transform" />
            <span className="font-semibold tracking-wide">展开控制台</span>
          </button>
        )}
      </div>
    </div>
  );
}
