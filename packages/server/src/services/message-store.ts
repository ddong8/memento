// Stable-ID message alignment & slice storage (server/server/services/message_store.py).
import { sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { conversationMessages } from "../db/pulled/schema";
import { dialogueKey, replyKey, type StoredMessage } from "./conversation-parser";

export const ROW_KEY_SQL =
  "md5(coalesce(role, '') || ':' || coalesce(floor(extract(epoch from \"timestamp\"))::bigint::text, '') " +
  "|| ':' || content || chr(31) || coalesce(metadata->>'tool_input', ''))";
export const LOOSE_KEY_SQL =
  "CASE WHEN \"timestamp\" IS NULL THEN NULL " +
  "ELSE coalesce(role, '') || ':' || floor(extract(epoch from \"timestamp\"))::bigint::text END";

export const PARKED = 1_000_000_000;
export const UPLOAD_REMOVED = "upload";
const TRANSIT = 1_000_000_000;

export interface StoredRow {
  id: bigint;
  lineNumber: number;
  rowKey: string;
  looseKey: string | null;
}

export interface Alignment {
  move: [bigint, number][];
  insert: [number, StoredMessage][];
  delete: bigint[];
  unchanged: number;
  parked: number;
  duplicates: number;
  unknown: number;
  standIns: number;
  unvouched: number;
}

export function hasChanges(plan: Alignment): boolean {
  return plan.move.length > 0 || plan.insert.length > 0 || plan.delete.length > 0;
}

function cmpRow(a: { lineNumber: number; id: bigint }, b: { lineNumber: number; id: bigint }): number {
  if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function bisectLeftAnchors(anchors: { line: number; id: bigint; idx: number }[], line: number, id: bigint): number {
  let lo = 0;
  let hi = anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const a = anchors[mid]!;
    if (a.line < line || (a.line === line && a.id < id)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function planAlignment(
  stored: StoredRow[],
  expected: StoredMessage[],
  startLine = 1,
  rest: "delete" | "park" | "keep" | "interleave" = "delete",
): Alignment {
  const free = new Map<string, StoredRow[]>();
  for (const row of stored) {
    const q = free.get(row.rowKey);
    if (q) q.push(row);
    else free.set(row.rowKey, [row]);
  }
  const taken: (StoredRow | null)[] = expected.map((msg) => {
    const q = free.get(msg.key);
    return q && q.length ? q.shift()! : null;
  });
  const left: StoredRow[] = [];
  for (const q of free.values()) left.push(...q);
  left.sort(cmpRow);
  const wanted = new Set(expected.map((m) => m.key));

  const plan: Alignment = {
    move: [],
    insert: [],
    delete: [],
    unchanged: 0,
    parked: 0,
    duplicates: 0,
    unknown: 0,
    standIns: 0,
    unvouched: 0,
  };

  if (rest === "interleave") {
    let kept: StoredRow[] = [];
    for (const r of left) {
      if (wanted.has(r.rowKey)) {
        plan.delete.push(r.id);
        plan.duplicates++;
      } else {
        kept.push(r);
      }
    }
    const byLoose = new Map<string, StoredRow[]>();
    for (const r of kept) {
      if (r.looseKey) {
        const q = byLoose.get(r.looseKey);
        if (q) q.push(r);
        else byLoose.set(r.looseKey, [r]);
      }
    }
    const standing = new Set<bigint>();
    for (let i = 0; i < expected.length; i++) {
      const msg = expected[i]!;
      if (taken[i] === null && msg.loose) {
        const q = byLoose.get(msg.loose);
        if (q && q.length) {
          const r = q.shift()!;
          taken[i] = r;
          standing.add(r.id);
        }
      }
    }
    plan.standIns = standing.size;
    kept = kept.filter((r) => !standing.has(r.id));
    const stillKept: StoredRow[] = [];
    for (const r of kept) {
      if (r.lineNumber >= PARKED) {
        plan.delete.push(r.id);
        plan.parked++;
      } else {
        stillKept.push(r);
      }
    }
    plan.unknown = stillKept.length;
    plan.unvouched = stillKept.length - new Set(stillKept.map((r) => r.rowKey)).size;

    const anchors: { line: number; id: bigint; idx: number }[] = [];
    for (let i = 0; i < taken.length; i++) {
      const r = taken[i];
      if (r) anchors.push({ line: r.lineNumber, id: r.id, idx: i });
    }
    anchors.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const after = new Map<number, StoredRow[]>();
    for (const r of stillKept) {
      const j = bisectLeftAnchors(anchors, r.lineNumber, r.id) - 1;
      const key = j >= 0 ? anchors[j]!.idx : -1;
      const arr = after.get(key);
      if (arr) arr.push(r);
      else after.set(key, [r]);
    }
    const order: ({ kind: "row"; row: StoredRow } | { kind: "msg"; msg: StoredMessage })[] = (after.get(-1) ?? []).map((row) => ({
      kind: "row",
      row,
    }));
    for (let i = 0; i < expected.length; i++) {
      const t = taken[i];
      order.push(t ? { kind: "row", row: t } : { kind: "msg", msg: expected[i]! });
      for (const r of after.get(i) ?? []) order.push({ kind: "row", row: r });
    }
    for (let k = 0; k < order.length; k++) {
      const line = startLine + k;
      const item = order[k]!;
      if (item.kind === "msg") plan.insert.push([line, item.msg]);
      else if (item.row.lineNumber === line) plan.unchanged++;
      else plan.move.push([item.row.id, line]);
    }
    return plan;
  }

  for (let i = 0; i < expected.length; i++) {
    const line = startLine + i;
    const row = taken[i];
    if (!row) plan.insert.push([line, expected[i]!]);
    else if (row.lineNumber === line) plan.unchanged++;
    else plan.move.push([row.id, line]);
  }
  if (rest === "park") {
    for (let i = 0; i < left.length; i++) {
      plan.parked++;
      const row = left[i]!;
      if (row.lineNumber !== PARKED + i) plan.move.push([row.id, PARKED + i]);
    }
  } else if (rest === "keep") {
    plan.parked = left.length;
  } else {
    for (const row of left) {
      plan.delete.push(row.id);
      if (wanted.has(row.rowKey)) plan.duplicates++;
      else plan.unknown++;
    }
  }
  return plan;
}

export async function storedRows(db: Db, docId: string, startLine = 1, endLine?: number): Promise<StoredRow[]> {
  const endClause = endLine !== undefined ? sql` AND line_number < ${endLine}` : sql``;
  const rows = (await db.execute(sql`
    SELECT id, line_number, ${sql.raw(ROW_KEY_SQL)} AS row_key, ${sql.raw(LOOSE_KEY_SQL)} AS loose_key
    FROM conversation_messages
    WHERE document_id = ${docId}::uuid AND line_number >= ${startLine}${endClause}
    ORDER BY line_number, id
  `)) as unknown as { id: string | number | bigint; line_number: number; row_key: string; loose_key: string | null }[];
  return rows.map((r) => ({
    id: BigInt(r.id),
    lineNumber: Number(r.line_number),
    rowKey: String(r.row_key),
    looseKey: r.loose_key ?? null,
  }));
}

export async function insertMessages(db: Db, docId: string, rows: [number, StoredMessage][]): Promise<void> {
  for (let i = 0; i < rows.length; i += 100) {
    const slice = rows.slice(i, i + 100);
    await db.insert(conversationMessages).values(
      slice.map(([line, msg]) => ({
        documentId: docId,
        lineNumber: line,
        messageType: msg.messageType,
        role: msg.role,
        content: msg.content,
        metadata: msg.metadata,
        timestamp: msg.timestamp ? msg.timestamp.toISOString() : null,
      })),
    );
  }
}

export async function applyAlignment(db: Db, docId: string, plan: Alignment, archiveReason?: string): Promise<void> {
  if (plan.delete.length) {
    const idLit = `{${plan.delete.map((id) => id.toString()).join(",")}}`;
    if (archiveReason) {
      await db.execute(sql`
        INSERT INTO conversation_messages_removed
          (id, document_id, line_number, message_type, role, content, metadata, "timestamp", created_at, reason)
        SELECT id, document_id, line_number, message_type, role, content, metadata, "timestamp", created_at, ${archiveReason}
        FROM conversation_messages WHERE id = ANY(${idLit}::bigint[])
        ON CONFLICT (id) DO NOTHING
      `);
    }
    await db.execute(sql`DELETE FROM conversation_messages WHERE id = ANY(${idLit}::bigint[])`);
  }
  if (plan.move.length) {
    const idLit = `{${plan.move.map(([id]) => id.toString()).join(",")}}`;
    const lineLit = `{${plan.move.map(([, line]) => String(line)).join(",")}}`;
    await db.execute(sql`UPDATE conversation_messages SET line_number = -line_number - ${TRANSIT} WHERE id = ANY(${idLit}::bigint[])`);
    await db.execute(sql`
      UPDATE conversation_messages AS c SET line_number = v.line
      FROM (SELECT unnest(${idLit}::bigint[]) AS id, unnest(${lineLit}::integer[]) AS line) AS v
      WHERE c.id = v.id
    `);
  }
  if (plan.insert.length) {
    await insertMessages(db, docId, plan.insert);
  }
}

export async function recentDialogueKeys(db: Db, docId: string, limit = 50): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT role, "timestamp", content FROM conversation_messages
    WHERE document_id = ${docId}::uuid AND role IN ('user', 'assistant') AND line_number < ${PARKED}
    ORDER BY line_number DESC LIMIT ${limit}
  `)) as unknown as { role: string; timestamp: string | null; content: string }[];
  const keys = new Set<string>();
  let lastReplyContent: string | null = null;
  for (const r of rows) {
    const ts = r.timestamp ? new Date(r.timestamp.includes("T") ? r.timestamp : r.timestamp.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")) : null;
    keys.add(dialogueKey(r.role, null, r.content, ts && !Number.isNaN(ts.getTime()) ? ts : null));
    if (lastReplyContent === null && r.role === "assistant") lastReplyContent = r.content;
  }
  if (lastReplyContent !== null) keys.add(replyKey(lastReplyContent));
  return keys;
}

export async function storeSlice(
  db: Db,
  docId: string,
  msgsOf: (seen: Set<string>) => StoredMessage[],
  full: boolean,
  complete: boolean,
): Promise<StoredMessage[]> {
  if (full) {
    const msgs = msgsOf(new Set<string>());
    const plan = planAlignment(await storedRows(db, docId), msgs, 1, complete ? "delete" : "park");
    await applyAlignment(db, docId, plan, UPLOAD_REMOVED);
    return msgs;
  }
  const topRes = (await db.execute(
    sql`SELECT line_number FROM conversation_messages WHERE document_id = ${docId}::uuid ORDER BY line_number DESC LIMIT 1`,
  )) as unknown as { line_number: number }[];
  const top = topRes[0] ? Number(topRes[0].line_number) : null;
  const seen = await recentDialogueKeys(db, docId);
  const msgs = msgsOf(seen);
  if (top === null || top < PARKED) {
    const start = Math.max(top ?? 0, 0) + 1;
    await insertMessages(db, docId, msgs.map((m, i) => [start + i, m]));
    return msgs;
  }
  const lastRes = (await db.execute(
    sql`SELECT line_number FROM conversation_messages WHERE document_id = ${docId}::uuid AND line_number < ${PARKED} ORDER BY line_number DESC LIMIT 1`,
  )) as unknown as { line_number: number }[];
  const last = lastRes[0] ? Number(lastRes[0].line_number) : 0;
  const parked = await storedRows(db, docId, PARKED);
  const plan = planAlignment(parked, msgs, Math.max(last, 0) + 1, complete ? "delete" : "keep");
  await applyAlignment(db, docId, plan, UPLOAD_REMOVED);
  return msgs;
}
