// Content staging for large conversations (server/server/services/content_staging.py).
import { asc, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { documentPendingDeltas } from "../db/pulled/schema";

export const STAGE_MIN_BYTES = 1 << 20;
export const QUIET_SECONDS = 600;
export const MAX_WAIT_SECONDS = 3600;
export const MAX_CONTENT_CHARS = 10_000_000;
export const HEAD_CHARS = 1_000_000;

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
