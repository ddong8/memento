"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch, getApiBase } from "@/lib/api-client";
import { timeAgo } from "@/lib/constants";
import { Btn, Chip, Glass } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";

/**
 * Projects the user doesn't collect (server: services/project_exclusion.py). Excluding one stops
 * collecting it on every device and in every tool, deletes its conversations and takes its
 * memories, skills, corrections, todos and profile rules out of use; 恢复采集 puts those back.
 */

export interface ExclusionPreview {
  key: string;
  names: string[];
  documents: number;
  messages: number;
  memories: number;
  skills: number;
  corrections: number;
  todos: number;
  profile_rules: number;
}

export interface Exclusion {
  key: string;
  name: string;
  added_at: string;
  state: "purging" | "done" | "failed";
  updated_at: string;
  purged?: Partial<Record<"documents" | "memories" | "skills" | "corrections" | "todos" | "profile_rules", number>> | null;
  error?: string | null;
}

const BASE = () => `${getApiBase()}/api/collect/exclusions`;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error((body && (body.detail as string)) || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const exclusionsApi = {
  list: () => authFetch(BASE()).then((r) => json<{ items: Exclusion[] }>(r)).then((d) => d.items),
  preview: (name: string) => authFetch(`${BASE()}/preview?name=${encodeURIComponent(name)}`).then((r) => json<ExclusionPreview>(r)),
  add: (name: string) =>
    authFetch(BASE(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })
      .then((r) => json<{ item: Exclusion }>(r)).then((d) => d.item),
  restore: (key: string) => authFetch(`${BASE()}/${encodeURIComponent(key)}`, { method: "DELETE" }).then((r) => json<{ item: Exclusion }>(r)),
  retry: (key: string) => authFetch(`${BASE()}/${encodeURIComponent(key)}/retry`, { method: "POST" }).then((r) => json<{ item: Exclusion }>(r)),
};

/** What will go, in plain words (only the parts there is something of). */
export function previewLines(p: ExclusionPreview): { gone: string[]; paused: string[] } {
  const gone: string[] = [];
  if (p.documents) gone.push(`${p.documents} 个会话文件${p.messages ? `（${p.messages.toLocaleString()} 条消息）` : ""}`);
  const paused: string[] = [];
  if (p.memories) paused.push(`${p.memories} 条记忆和避坑`);
  if (p.skills) paused.push(`${p.skills} 个技能`);
  if (p.corrections) paused.push(`${p.corrections} 条学到的纠正`);
  if (p.todos) paused.push(`${p.todos} 条自动生成的待办`);
  if (p.profile_rules) paused.push(`画像里 ${p.profile_rules} 条项目规则`);
  return { gone, paused };
}

export function ExcludeProjectDialog({
  name, open, onClose, onDone,
}: {
  name: string;
  open: boolean;
  onClose: () => void;
  onDone?: (item: Exclusion) => void;
}) {
  const [preview, setPreview] = useState<ExclusionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !name.trim()) return;
    let alive = true;
    setPreview(null);
    setError(null);
    exclusionsApi.preview(name).then((p) => alive && setPreview(p)).catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [open, name]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open || typeof document === "undefined") return null;
  const lines = preview ? previewLines(preview) : null;
  const wildcard = name.includes("*");

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const item = await exclusionsApi.add(name);
      onDone?.(item);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[1000] flex items-end justify-center p-0 sm:items-center sm:p-6"
      style={{ background: "rgba(10, 10, 18, 0.45)", backdropFilter: "blur(4px)" }}
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-full max-w-md rounded-t-2xl p-5 sm:rounded-2xl sm:p-6"
        style={{ background: "var(--aurora-surface-solid)", border: "1px solid var(--aurora-border)", boxShadow: "0 24px 60px -20px rgba(0,0,0,0.35)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: "var(--aurora-danger-soft)", color: "var(--aurora-danger)" }}
          >
            <Icon name="eye" size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold" style={{ color: "var(--aurora-fg1)" }}>
              不再采集「{name}」{wildcard ? "这类项目" : ""}？
            </div>
            <div className="mt-1 text-[12.5px] leading-relaxed" style={{ color: "var(--aurora-fg3)" }}>
              所有设备、所有工具里{wildcard ? "名字符合的项目" : "这个项目"}的对话都不再采集。
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-2.5 text-[13px] leading-relaxed" style={{ color: "var(--aurora-fg2)" }}>
          {!preview && !error && <div style={{ color: "var(--aurora-fg4)" }}>正在统计会受影响的数据…</div>}
          {lines && (
            <>
              {preview && preview.names.length > 0 && wildcard && (
                <div className="text-[12px]" style={{ color: "var(--aurora-fg3)" }}>
                  现有项目：{preview.names.slice(0, 8).join("、")}
                  {preview.names.length > 8 ? ` 等 ${preview.names.length} 个` : ""}
                </div>
              )}
              <div className="rounded-xl p-3" style={{ background: "var(--aurora-danger-soft)" }}>
                <div className="font-medium" style={{ color: "var(--aurora-danger)" }}>删除</div>
                <div className="mt-0.5">{lines.gone.length ? lines.gone.join("，") : "还没有采集到它的会话"}</div>
              </div>
              <div className="rounded-xl p-3" style={{ background: "var(--aurora-chip)" }}>
                <div className="font-medium" style={{ color: "var(--aurora-fg1)" }}>停用（恢复采集时放回）</div>
                <div className="mt-0.5">{lines.paused.length ? lines.paused.join("，") : "没有从它学到的记忆、技能和画像规则"}</div>
              </div>
              <div className="text-[12px]" style={{ color: "var(--aurora-fg4)" }}>
                设备上的原始会话文件不动。以后恢复采集，这些会话有新内容时会整段重新采上来。
              </div>
            </>
          )}
          {error && <div style={{ color: "var(--aurora-danger)" }}>{error}</div>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Btn variant="glass" size="sm" onClick={onClose} disabled={busy}>
            取消
          </Btn>
          <Btn variant="danger" size="sm" onClick={confirm} disabled={busy || !preview}>
            {busy ? "正在处理…" : "不再采集"}
          </Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function purgedText(e: Exclusion): string {
  if (e.state === "purging") return "正在清理已采集的数据…";
  if (e.state === "failed") return `清理没有完成${e.error ? `：${e.error}` : ""}`;
  const p = e.purged || {};
  const parts = [
    p.documents ? `删除 ${p.documents} 个会话文件` : "",
    p.memories ? `停用 ${p.memories} 条记忆` : "",
    p.skills ? `${p.skills} 个技能` : "",
    p.profile_rules ? `${p.profile_rules} 条画像规则` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("，") : "没有需要清理的数据";
}

/** The list, in 设置 → 采集配置: add a name (or a pattern like test-*), see what was cleaned, put one back. */
export function ExcludedProjectsCard() {
  const [items, setItems] = useState<Exclusion[] | null>(null);
  const [name, setName] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(() => {
    exclusionsApi.list().then(setItems).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => load(), [load]);
  // While a cleanup runs, look again every few seconds
  useEffect(() => {
    if (!items?.some((e) => e.state === "purging")) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [items, load]);

  const restore = async (key: string) => {
    setBusyKey(key);
    setError(null);
    try {
      await exclusionsApi.restore(key);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  };
  const retry = async (key: string) => {
    setBusyKey(key);
    try {
      await exclusionsApi.retry(key);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Glass padding="clamp(14px, 3vw, 20px)" radius={18} style={{ marginBottom: 14 }}>
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)" }}>不采集的项目</span>
        {items && items.length > 0 && <Chip>{items.length}</Chip>}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: "var(--aurora-fg3)" }}>
        测试用、临时的项目可以不采集：所有设备上都停止采集，已采集的会话删除，从中学到的记忆、技能和画像规则停用。
        名字里写 * 可以一次排除一类，例如 test-*。
      </p>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) setAsking(name.trim());
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="项目名，例如 demo-test 或 test-*"
          maxLength={120}
          className="min-w-0 flex-1 rounded-[10px] px-3 py-1.5 text-[13px] outline-none"
          style={{ background: "var(--aurora-surface-mute)", border: "1px solid var(--aurora-border)", color: "var(--aurora-fg1)" }}
        />
        <Btn size="sm" icon="plus" disabled={!name.trim()} type="submit">
          添加
        </Btn>
      </form>

      {error && <div className="mt-2 text-[12.5px]" style={{ color: "var(--aurora-danger)" }}>{error}</div>}

      {items && items.length > 0 && (
        <div className="mt-3">
          {items.map((e) => (
            <div key={e.key} className="flex items-center gap-3 py-2.5" style={{ borderTop: "1px solid var(--aurora-border)" }}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium" style={{ color: "var(--aurora-fg1)" }}>{e.name}</span>
                  {e.state === "purging" && <Chip tone="accent">清理中</Chip>}
                  {e.state === "failed" && <Chip tone="danger">未完成</Chip>}
                </div>
                <div className="mt-0.5 text-[12px]" style={{ color: e.state === "failed" ? "var(--aurora-danger)" : "var(--aurora-fg3)" }}>
                  {timeAgo(e.added_at)} · {purgedText(e)}
                </div>
              </div>
              {e.state === "failed" && (
                <Btn variant="glass" size="sm" onClick={() => retry(e.key)} disabled={busyKey === e.key}>
                  重试
                </Btn>
              )}
              <Btn variant="glass" size="sm" onClick={() => restore(e.key)} disabled={busyKey === e.key || e.state === "purging"}>
                恢复采集
              </Btn>
            </div>
          ))}
        </div>
      )}

      <ExcludeProjectDialog
        name={asking || ""}
        open={asking !== null}
        onClose={() => setAsking(null)}
        onDone={() => {
          setName("");
          load();
        }}
      />
    </Glass>
  );
}
