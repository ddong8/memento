// Checking & repairing conversation_messages against document text (server/server/services/message_audit.py).
import { sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { Db } from "../db/client";
import { messageAudit } from "../db/pulled/schema";
import { MAX_CONTENT_CHARS } from "./content-staging";
import { messagesToStore } from "./conversation-parser";
import { pushCommand } from "./device-commands";
import { sliceLockKey } from "./ingest-service";
import * as messageStore from "./message-store";

export const QUIET_MINUTES = 10;
export const TOO_BIG_CHARS = MAX_CONTENT_CHARS - 200_000;
export const TRUNCATED_MARK = "[TRUNCATED: line exceeded";
export const AUDIT_VERSION = 3;
export const MODES = new Set(["off", "observe", "repair"]);
const AUDIT_LOCK = 0x6d656d61756469;

async function recordAudit(
  db: Db,
  docId: string,
  contentHash: string | null,
  outcome: string,
  counts: { expected?: number; stored?: number; missing?: number; duplicates?: number; unknown?: number; detail?: Record<string, unknown> },
) {
  const detail = { ...(counts.detail ?? {}), v: AUDIT_VERSION };
  const nowIso = new Date().toISOString();
  await db
    .insert(messageAudit)
    .values({
      documentId: docId,
      contentHash,
      checkedAt: nowIso,
      outcome,
      expected: counts.expected ?? 0,
      stored: counts.stored ?? 0,
      missing: counts.missing ?? 0,
      duplicates: counts.duplicates ?? 0,
      unknown: counts.unknown ?? 0,
      detail,
    })
    .onConflictDoUpdate({
      target: messageAudit.documentId,
      set: {
        contentHash,
        checkedAt: nowIso,
        outcome,
        expected: counts.expected ?? 0,
        stored: counts.stored ?? 0,
        missing: counts.missing ?? 0,
        duplicates: counts.duplicates ?? 0,
        unknown: counts.unknown ?? 0,
        detail,
      },
    });
}

export async function auditDocument(db: Db, docId: string, repair: boolean): Promise<Record<string, unknown> | null> {
  return db.transaction(async (tx) => {
    const tdb = tx as unknown as Db;
    const docs = (await tx.execute(sql`
      SELECT tool_id, relative_path, machine_id, content, content_hash
      FROM documents WHERE id = ${docId}::uuid FOR UPDATE SKIP LOCKED
    `)) as unknown as {
      tool_id: string;
      relative_path: string;
      machine_id: string | null;
      content: string | null;
      content_hash: string | null;
    }[];
    const doc = docs[0];
    if (!doc) return null;
    if (doc.machine_id) {
      const k = sliceLockKey(doc.machine_id, doc.tool_id, doc.relative_path);
      const locked = (await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${k}, 0)) AS ok`)) as unknown as {
        ok: boolean;
      }[];
      if (!locked[0]?.ok) return null;
    }

    const prevRows = (await tx.execute(sql`SELECT detail, outcome, checked_at FROM message_audit WHERE document_id = ${docId}::uuid`)) as unknown as {
      detail: Record<string, unknown> | null;
      outcome: string;
      checked_at: string;
    }[];
    const prevRow = prevRows[0];
    const prev = (prevRow?.detail && typeof prevRow.detail === "object" ? prevRow.detail : {}) as Record<string, unknown>;
    const detail: Record<string, unknown> = {};
    if (prev.resync_requested_at) detail.resync_requested_at = prev.resync_requested_at;
    if (prev.repaired_at) detail.repaired_at = prev.repaired_at;
    else if (prevRow?.outcome === "repaired") detail.repaired_at = String(prevRow.checked_at);

    const content = doc.content ?? "";
    if (content.length >= TOO_BIG_CHARS) {
      await recordAudit(tdb, docId, doc.content_hash, "too_big", { detail });
      return { outcome: "too_big" };
    }

    const truncated = content.split(TRUNCATED_MARK).length - 1;
    if (truncated > 0) detail.truncated = truncated;

    const expected = messagesToStore(content, doc.tool_id);
    const stored = await messageStore.storedRows(tdb, docId);
    const plan = messageStore.planAlignment(stored, expected, 1, "interleave");
    const counts = {
      expected: expected.length,
      stored: stored.length,
      missing: plan.insert.length,
      duplicates: plan.duplicates,
      unknown: plan.unknown,
    };
    if (plan.standIns) detail.stand_ins = plan.standIns;
    if (plan.move.length) detail.moved = plan.move.length;
    if (plan.parked) detail.parked = plan.parked;
    if (plan.unvouched) detail.unvouched = plan.unvouched;

    let firstTs: Date | null = null;
    for (const m of expected) {
      if (m.timestamp && (!firstTs || m.timestamp < firstTs)) firstTs = m.timestamp;
    }
    if (plan.unknown && firstTs) {
      const cutoff = new Date(firstTs.getTime() - 1000).toISOString();
      const aheadRows = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM conversation_messages
        WHERE document_id = ${docId}::uuid AND line_number >= 1 AND "timestamp" < ${cutoff}::timestamptz
      `)) as unknown as { n: number }[];
      if (Number(aheadRows[0]?.n ?? 0) > 0) detail.ahead = Number(aheadRows[0]!.n);
    }

    let outcome: string;
    if (!messageStore.hasChanges(plan)) {
      outcome = "ok";
    } else if (repair) {
      await messageStore.applyAlignment(tdb, docId, plan, "audit");
      outcome = "repaired";
      detail.repaired_at = new Date().toISOString().replace("Z", "+00:00");
    } else {
      outcome = "needs_repair";
    }
    await recordAudit(tdb, docId, doc.content_hash, outcome, { ...counts, detail });
    return { outcome, ...counts, truncated };
  });
}

async function requestResyncs(db: Db, redis: Redis, limit = 500): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT a.document_id, d.machine_id, d.tool_id, d.relative_path
    FROM message_audit a
    JOIN documents d ON d.id = a.document_id
    JOIN machines m ON m.id = d.machine_id
    WHERE (a.detail->>'truncated' IS NOT NULL OR a.detail->>'unvouched' IS NOT NULL
           OR a.detail->>'ahead' IS NOT NULL
           OR (a.outcome = 'too_big' AND EXISTS (SELECT 1 FROM conversation_messages cm WHERE cm.document_id = a.document_id)))
      AND a.detail->>'resync_requested_at' IS NULL
      AND m.collect_status->>'reported_at' IS NOT NULL
    ORDER BY a.checked_at
    LIMIT ${limit}
  `)) as unknown as { document_id: string; machine_id: string; tool_id: string; relative_path: string }[];

  const byMachine = new Map<string, { docId: string; tool: string; path: string }[]>();
  for (const r of rows) {
    const mid = String(r.machine_id);
    const list = byMachine.get(mid) ?? [];
    list.push({ docId: String(r.document_id), tool: r.tool_id, path: r.relative_path });
    byMachine.set(mid, list);
  }
  let asked = 0;
  for (const [mid, files] of byMachine.entries()) {
    const mRows = (await db.execute(sql`SELECT collector_token_hash FROM machines WHERE id = ${mid}::uuid`)) as unknown as {
      collector_token_hash: string | null;
    }[];
    const device = mRows[0]?.collector_token_hash;
    if (!device) continue;
    try {
      await pushCommand(redis, device, "resync_files", { files: files.map((f) => ({ tool: f.tool, relative_path: f.path })) });
    } catch {
      continue;
    }
    const nowIso = new Date().toISOString().replace("Z", "+00:00");
    for (const f of files) {
      await db.execute(sql`
        UPDATE message_audit
        SET detail = detail || jsonb_build_object('resync_requested_at', CAST(${nowIso} AS text))
        WHERE document_id = ${f.docId}::uuid
      `);
    }
    asked += files.length;
  }
  return asked;
}

export async function auditDue(
  db: Db,
  mode: string,
  redis: Redis | null,
  budgetSeconds = 120,
  limit = 200,
): Promise<Record<string, unknown>> {
  if (!MODES.has(mode) || mode === "off") return { mode };
  const repair = mode === "repair";
  const deadline = performance.now() + budgetSeconds * 1000;
  const stats: Record<string, unknown> = { mode };

  const got = (await db.execute(sql`SELECT pg_try_advisory_lock(${AUDIT_LOCK}) AS ok`)) as unknown as { ok: boolean }[];
  if (!got[0]?.ok) return { mode, busy: true };
  try {
    const redoClause = repair ? sql`OR a.outcome = 'needs_repair'` : sql``;
    const due = (await db.execute(sql`
      SELECT d.id FROM documents d
      LEFT JOIN message_audit a ON a.document_id = d.id
      WHERE d.category = 'conversation' AND d.content_type = 'jsonl'
        AND d.tool_id NOT IN ('memento', 'hermes')
        AND d.content IS NOT NULL
        AND d.synced_at < now() - (${QUIET_MINUTES} * interval '1 minute')
        AND NOT EXISTS (SELECT 1 FROM document_pending_deltas p WHERE p.document_id = d.id)
        AND (a.document_id IS NULL OR a.content_hash IS DISTINCT FROM d.content_hash ${redoClause}
             OR coalesce((a.detail->>'v')::int, 1) < 2
             OR (coalesce((a.detail->>'v')::int, 1) < ${AUDIT_VERSION} AND a.unknown > 0)
             OR (a.outcome = 'error' AND a.checked_at < now() - interval '1 day'))
      ORDER BY a.checked_at NULLS FIRST, d.synced_at DESC
      LIMIT ${limit}
    `)) as unknown as { id: string }[];

    for (const row of due) {
      if (performance.now() >= deadline) break;
      const docId = String(row.id);
      try {
        const found = await auditDocument(db, docId, repair);
        if (!found) {
          stats.busy = Number(stats.busy ?? 0) + 1;
          continue;
        }
        const out = String(found.outcome);
        stats[out] = Number(stats[out] ?? 0) + 1;
        for (const k of ["missing", "duplicates", "unknown"] as const) {
          if (found[k]) stats[k] = Number(stats[k] ?? 0) + Number(found[k]);
        }
      } catch (e) {
        stats.error = Number(stats.error ?? 0) + 1;
        try {
          const hRows = (await db.execute(sql`SELECT content_hash FROM documents WHERE id = ${docId}::uuid`)) as unknown as {
            content_hash: string | null;
          }[];
          await recordAudit(db, docId, hRows[0]?.content_hash ?? null, "error", { detail: { error: ((e as Error).message || String(e)).slice(0, 300) } });
        } catch {
          /* ignore */
        }
      }
    }

    if (repair && redis) {
      try {
        const asked = await requestResyncs(db, redis);
        if (asked) stats.resync_requested = asked;
      } catch {
        /* ignore */
      }
    }
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${AUDIT_LOCK})`).catch(() => {});
  }
  return stats;
}

export async function auditSummary(db: Db) {
  const rows = (await db.execute(sql`
    SELECT outcome, count(*)::int AS docs, coalesce(sum(missing), 0)::int AS missing,
           coalesce(sum(duplicates), 0)::int AS duplicates, coalesce(sum(unknown), 0)::int AS unknown
    FROM message_audit GROUP BY outcome
  `)) as unknown as { outcome: string; docs: number; missing: number; duplicates: number; unknown: number }[];
  const out: Record<string, { documents: number; missing: number; duplicates: number; unknown: number }> = {};
  for (const r of rows) {
    out[r.outcome] = { documents: Number(r.docs), missing: Number(r.missing), duplicates: Number(r.duplicates), unknown: Number(r.unknown) };
  }
  return out;
}
