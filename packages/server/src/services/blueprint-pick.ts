// Which of several devices' copies of a project's code blueprint describes the newest code
// (server/server/services/blueprint_pick.py).
import { eq, like, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const CODE_BLUEPRINT_FILE = "CODE_BLUEPRINT.md";
export const LEGACY_CODE_BLUEPRINT_FILE = "PROJECT_BLUEPRINT.md";
export const CODE_BLUEPRINT_FILES = [CODE_BLUEPRINT_FILE, LEGACY_CODE_BLUEPRINT_FILE] as const;
export const CODE_BLUEPRINT_TITLES = ["# Code Blueprint:", "# Project Blueprint:"] as const;

export function codeBlueprintPath(col: AnyPgColumn, leaf?: string | null): SQL {
  if (leaf !== undefined && leaf !== null) {
    return or(...CODE_BLUEPRINT_FILES.map((name) => eq(col, `${leaf}/${name}`)))!;
  }
  return or(...CODE_BLUEPRINT_FILES.flatMap((name) => [eq(col, name), like(col, `%/${name}`)]))!;
}

export function isCodeBlueprintPath(path: string | null | undefined): boolean {
  const p = path || "";
  return CODE_BLUEPRINT_FILES.some((name) => p === name || p.endsWith(`/${name}`));
}

export function codeBlueprintTitle(content: string | null | undefined): string | null {
  const m = /^# (?:Code|Project) Blueprint:\s*(.+)$/m.exec(content || "");
  return m ? m[1]!.trim() : null;
}

const COMMIT_RE = /Commit: `([0-9a-f]{7,40})`/;
const UPDATED_RE = /Updated: `(\d{4}-\d{2}-\d{2})`/;
const HISTORY_RE = /`([0-9a-f]{7,40})` \((\d{4}-\d{2}-\d{2})\)/g;
const HEAD_CHARS = 2000;

export interface BlueprintCopy {
  commit: string;
  date: string;
  history: Set<string>;
  syncedMs: number | null;
}

function toMs(v: Date | string | null | undefined): number | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export function blueprintCopy(content: string | null | undefined, synced: Date | string | null | undefined): BlueprintCopy {
  const text = typeof content === "string" ? content : "";
  const head = text.slice(0, HEAD_CHARS);
  const cm = COMMIT_RE.exec(head);
  const commit = cm ? cm[1]! : "";
  const history = new Set<string>();
  let maxHistDate = "";
  for (const m of text.matchAll(HISTORY_RE)) {
    history.add(m[1]!);
    if (m[2]! > maxHistDate) maxHistDate = m[2]!;
  }
  const um = UPDATED_RE.exec(head);
  const date = um ? um[1]! : maxHistDate;
  return { commit, date, history, syncedMs: toMs(synced) };
}

function sameCommit(a: string, b: string): boolean {
  return Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));
}

function isLater(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a !== null;
  return a > b;
}

export function isFresher(a: BlueprintCopy, b: BlueprintCopy): boolean {
  if (sameCommit(a.commit, b.commit)) return isLater(a.syncedMs, b.syncedMs);
  if (b.commit) {
    for (const h of a.history) if (sameCommit(h, b.commit)) return true;
  }
  if (a.commit) {
    for (const h of b.history) if (sameCommit(h, a.commit)) return false;
  }
  if (a.date && b.date && a.date !== b.date) return a.date > b.date;
  return isLater(a.syncedMs, b.syncedMs);
}

export function pickFreshest<T>(
  items: Iterable<T>,
  getContent: (item: T) => string | null | undefined,
  getSynced: (item: T) => Date | string | null | undefined,
): T | null {
  let best: T | null = null;
  let bestCopy: BlueprintCopy | null = null;
  for (const item of items) {
    const text = getContent(item);
    if (typeof text !== "string" || !text) continue;
    const copy = blueprintCopy(text, getSynced(item));
    if (bestCopy === null || isFresher(copy, bestCopy)) {
      best = item;
      bestCopy = copy;
    }
  }
  return best;
}
