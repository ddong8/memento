// Content staging for large conversations (server/server/services/content_staging.py).
import { asc, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { documentPendingDeltas, documents } from "../db/pulled/schema";
import { MAX_INPUT_CHARS } from "./tokenize";

export const STAGE_MIN_BYTES = 1 << 20;
export const QUIET_SECONDS = 600;
export const MAX_WAIT_SECONDS = 3600;
export const MAX_CONTENT_CHARS = 10_000_000;
export const HEAD_CHARS = 1_000_000;

export function pastIndex(content: string | null | undefined): boolean {
  return !!content && content.length >= MAX_INPUT_CHARS;
}

export async function shouldStage(db: Db, docId: string): Promise<boolean> {
  const [row] = await db
    .select({
      len: sql<number>`coalesce(octet_length(${documents.content}), 0)`,
      hasPending: sql<boolean>`exists(select 1 from document_pending_deltas where document_id = ${docId})`,
    })
    .from(documents)
    .where(eq(documents.id, docId))
    .limit(1);
  if (!row) return false;
  return Boolean(row.hasPending) || Number(row.len) >= STAGE_MIN_BYTES;
}

export async function stageDelta(db: Db, docId: string, delta: string): Promise<void> {
  await db.insert(documentPendingDeltas).values({ documentId: docId, content: delta });
}

export async function dropPending(db: Db, docId: string): Promise<void> {
  await db.delete(documentPendingDeltas).where(eq(documentPendingDeltas.documentId, docId));
}

export function capContent(content: string): string {
  if (content.length <= MAX_CONTENT_CHARS) return content;
  let headEnd = content.lastIndexOf("\n", HEAD_CHARS - 1);
  if (headEnd <= 0) headEnd = HEAD_CHARS;
  let tailFrom = content.length - (MAX_CONTENT_CHARS - headEnd - 1);
  const nl = content.indexOf("\n", tailFrom);
  const lineStart = nl >= 0 ? nl + 1 : 0;
  if (lineStart > 0 && lineStart < content.length) tailFrom = lineStart;
  return `${content.slice(0, headEnd)}\n${content.slice(tailFrom)}`;
}

export function appendContent(content: string | null | undefined, delta: string): string {
  return content ? capContent(`${content}\n${delta}`) : delta;
}

async function pendingSizes(db: Db, docId: string): Promise<[bigint, number][]> {
  const rows = await db
    .select({
      id: documentPendingDeltas.id,
      len: sql<number>`char_length(${documentPendingDeltas.content})`,
    })
    .from(documentPendingDeltas)
    .where(eq(documentPendingDeltas.documentId, docId))
    .orderBy(asc(documentPendingDeltas.id));
  return rows.map((r) => [r.id, Number(r.len)]);
}

function fetcher(db: Db): (ids: bigint[]) => Promise<string[]> {
  return async (ids: bigint[]) => {
    if (!ids.length) return [];
    const rows = await db
      .select({ id: documentPendingDeltas.id, content: documentPendingDeltas.content })
      .from(documentPendingDeltas)
      .where(inArray(documentPendingDeltas.id, ids));
    const map = new Map(rows.map((r) => [r.id, r.content]));
    return ids.map((id) => map.get(id) ?? "");
  };
}

async function joined(
  rawContent: string | null | undefined,
  deltas: [bigint, number][],
  fetch: (ids: bigint[]) => Promise<string[]>,
): Promise<string> {
  const content = rawContent ?? "";
  const sizes = deltas.map(([, n]) => n + 1);
  if (!content && sizes.length) sizes[0] = sizes[0]! - 1;

  const join = (texts: string[], first: number): string => {
    const j = texts.map((t) => `\n${t}`).join("");
    return first === 0 && !content ? j.slice(1) : j;
  };

  const totalExtra = sizes.reduce((a, b) => a + b, 0);
  if (content.length + totalExtra <= MAX_CONTENT_CHARS) {
    return content + join(await fetch(deltas.map(([id]) => id)), 0);
  }

  let head = content.slice(0, HEAD_CHARS);
  let k = 0;
  if (head.length < HEAD_CHARS) {
    let size = content.length;
    while (k < deltas.length && size < HEAD_CHARS) {
      size += sizes[k]!;
      k++;
    }
    head = (content + join(await fetch(deltas.slice(0, k).map(([id]) => id)), 0)).slice(0, HEAD_CHARS);
  }
  let headEnd = head.lastIndexOf("\n", HEAD_CHARS - 1);
  if (headEnd <= 0) headEnd = HEAD_CHARS;

  const keep = MAX_CONTENT_CHARS - headEnd - 1;
  let j = deltas.length;
  let size = 0;
  while (j > 0 && size < keep) {
    j--;
    size += sizes[j]!;
  }
  let tail = join(await fetch(deltas.slice(j).map(([id]) => id)), j);
  if (size < keep) tail = content.slice(Math.max(0, content.length - (keep - size))) + tail;
  tail = tail.slice(Math.max(0, tail.length - keep));
  const nl = tail.indexOf("\n");
  if (nl !== -1 && nl + 1 < tail.length) tail = tail.slice(nl + 1);
  return `${head.slice(0, headEnd)}\n${tail}`;
}

export async function withPending(db: Db, docId: string, content: string | null | undefined): Promise<string | null> {
  const deltas = await pendingSizes(db, docId);
  if (!deltas.length) return content ?? null;
  return joined(content, deltas, fetcher(db));
}

function joinedSize(contentLen: number, deltas: [bigint, number][]): number {
  let total = contentLen;
  for (let i = 0; i < deltas.length; i++) {
    total += deltas[i]![1] + (i === 0 && !contentLen ? 0 : 1);
  }
  return total;
}

export async function mergePending(db: Db, docId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const locked = (await tx.execute(sql`SELECT id FROM documents WHERE id = ${docId}::uuid FOR UPDATE SKIP LOCKED`)) as unknown as {
      id: string;
    }[];
    if (!locked.length) return 0;
    const tdb = tx as unknown as Db;
    const deltas = await pendingSizes(tdb, docId);
    if (!deltas.length) return 0;
    const ids = deltas.map(([id]) => id);
    const [lenRow] = await tx
      .select({ len: sql<number>`coalesce(char_length(${documents.content}), 0)` })
      .from(documents)
      .where(eq(documents.id, docId))
      .limit(1);
    const length = Number(lenRow?.len ?? 0);
    if (length > 0 && joinedSize(length, deltas) <= MAX_CONTENT_CHARS) {
      const texts = await fetcher(tdb)(ids);
      const tail = texts.map((t) => `\n${t}`).join("");
      await tx
        .update(documents)
        .set({ content: sql`${documents.content} || ${tail}` })
        .where(eq(documents.id, docId));
    } else {
      let current: string | null = null;
      if (length > 0) {
        const [curRow] = await tx.select({ content: documents.content }).from(documents).where(eq(documents.id, docId)).limit(1);
        current = curRow?.content ?? null;
      }
      const nextContent = await joined(current, deltas, fetcher(tdb));
      await tx.update(documents).set({ content: nextContent }).where(eq(documents.id, docId));
    }
    await tx.delete(documentPendingDeltas).where(inArray(documentPendingDeltas.id, ids));
    return deltas.length;
  });
}

const MERGE_LOCK = 0x6d656d6d;

export async function mergeDue(db: Db, budgetSeconds = 50): Promise<Record<string, unknown>> {
  const deadline = performance.now() + budgetSeconds * 1000;
  const stats: Record<string, unknown> = { documents: 0, deltas: 0 };
  const got = (await db.execute(sql`SELECT pg_try_advisory_lock(${MERGE_LOCK}) AS ok`)) as unknown as { ok: boolean }[];
  if (!got[0]?.ok) return { ...stats, busy: true };
  try {
    const due = (await db.execute(sql`
      SELECT document_id FROM document_pending_deltas
      GROUP BY document_id
      HAVING max(created_at) <= now() - (${QUIET_SECONDS} * interval '1 second')
          OR min(created_at) <= now() - (${MAX_WAIT_SECONDS} * interval '1 second')
    `)) as unknown as { document_id: string }[];
    for (const row of due) {
      if (performance.now() >= deadline) break;
      try {
        const n = await mergePending(db, String(row.document_id));
        if (n > 0) {
          stats.documents = Number(stats.documents) + 1;
          stats.deltas = Number(stats.deltas) + n;
        }
      } catch (e) {
        console.warn("[content-staging] merge failed for", row.document_id, (e as Error).message);
      }
    }
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${MERGE_LOCK})`).catch(() => {});
  }
  return stats;
}
