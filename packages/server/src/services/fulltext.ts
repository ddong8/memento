// Keyword matching over document_search through its GIN index with BM25 IDF term weighting (server/server/services/fulltext.py).
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client";
import { documentSearch } from "../db/pulled/schema";

export const COMMON_TERM_SHARE = 0.05;
const DF_TTL_MS = 600_000;
const DF_MAX = 5000;
const dfCache = new Map<string, [number, number]>();
let nCache: [number, number] | null = null;

/** Force GIN index scan on document_search within the current transaction (matches Python use_fulltext_index). */
export async function useFulltextIndex(db: Db): Promise<void> {
  await db.execute(sql`SET LOCAL enable_seqscan = off`);
}

async function docFreq(db: Db, terms: string[]): Promise<{ n: number; df: Record<string, number> }> {
  const now = performance.now();
  const df: Record<string, number> = {};
  const todo: string[] = [];
  for (const t of terms) {
    const hit = dfCache.get(t);
    if (hit && hit[0] > now) df[t] = hit[1];
    else todo.push(t);
  }
  if (!todo.length && nCache && nCache[0] > now) {
    return { n: nCache[1], df };
  }

  const cols: SQL[] = [sql`(SELECT count(*)::int FROM document_search) AS _n`];
  todo.forEach((t, idx) => {
    cols.push(sql`(SELECT count(*)::int FROM document_search WHERE content_tsv @@ to_tsquery('simple', ${t})) AS ${sql.raw(`_t${idx}`)}`);
  });
  const res = (await db.execute(sql`SELECT ${sql.join(cols, sql`, `)}`)) as unknown as Record<string, unknown>[];
  const row = res[0] ?? {};
  const n = Number(row._n ?? 0);
  nCache = [now + DF_TTL_MS, n];
  if (dfCache.size > DF_MAX) dfCache.clear();
  todo.forEach((t, idx) => {
    const c = Number(row[`_t${idx}`] ?? 0);
    df[t] = c;
    if (c > 0) dfCache.set(t, [now + DF_TTL_MS, c]);
  });
  return { n, df };
}

function idf(n: number, df: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

export async function keywordMatch(db: Db, terms: string[]): Promise<{ tsquery: string; rankExpr: SQL }> {
  const { n, df } = await docFreq(db, terms);
  const rare = terms.filter((t) => (df[t] ?? 0) > 0 && (df[t] ?? 0) <= n * COMMON_TERM_SHARE);
  if (!rare.length) {
    const everything = terms.join(" | ");
    return {
      tsquery: everything,
      rankExpr: sql`ts_rank(${documentSearch.contentTsv}, to_tsquery('simple', ${everything}), 1)`,
    };
  }
  const parts: SQL[] = [];
  for (const t of terms) {
    if ((df[t] ?? 0) > 0) {
      const w = idf(n, df[t]!);
      parts.push(sql`(${w}::double precision * ts_rank(${documentSearch.contentTsv}, to_tsquery('simple', ${t}), 1))`);
    }
  }
  return {
    tsquery: rare.join(" | "),
    rankExpr: parts.length ? sql`(${sql.join(parts, sql` + `)})` : sql`0::double precision`,
  };
}
