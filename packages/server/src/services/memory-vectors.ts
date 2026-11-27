// Vector embeddings & cosine nearest-neighbor search for UserMemory (server/server/services/memory_vectors.py).
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { Settings } from "../config";
import type { Db } from "../db/client";
import { userMemories } from "../db/pulled/schema";
import { callEmbeddingServer, toVectorLiteral } from "./embedding";

export type UserMemoryRow = typeof userMemories.$inferSelect;

export const EMBED_CHARS = 800;
export const EMBED_BATCH = 32;
export const BACKFILL_LIMIT = 400;
export const NEIGHBOR_MIN_SIM = 0.8;
export const NEIGHBORS = 5;

export function memoryText(mem: { content?: string | null }): string {
  return (mem.content || "").slice(0, EMBED_CHARS);
}

export async function embedMemories(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  memories: UserMemoryRow[],
  timeoutSec = 60,
): Promise<number> {
  const todo = memories.filter((m) => m.embedding == null && (m.content || "").trim().length > 0);
  let done = 0;
  for (let start = 0; start < todo.length; start += EMBED_BATCH) {
    const part = todo.slice(start, start + EMBED_BATCH);
    const vectors = await callEmbeddingServer(settings, redis, part.map(memoryText), timeoutSec);
    if (!vectors || vectors.length !== part.length) break;
    for (let i = 0; i < part.length; i++) {
      const mem = part[i]!;
      const vec = vectors[i];
      if (!vec?.length) continue;
      const lit = toVectorLiteral(vec);
      const updated = (await db.execute(sql`
        UPDATE user_memories
        SET embedding = ${lit}::vector, updated_at = updated_at
        WHERE id = ${mem.id}::uuid AND content = ${mem.content}
        RETURNING id
      `)) as unknown as { id: string }[];
      if (updated.length) {
        (mem as { embedding: number[] | null }).embedding = vec;
        done++;
      }
    }
  }
  return done;
}

export async function backfillMemoryVectors(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  limit = BACKFILL_LIMIT,
): Promise<{ missing: number; embedded: number }> {
  const missing = await db
    .select()
    .from(userMemories)
    .where(and(eq(userMemories.status, "active"), eq(userMemories.isFolder, false), isNull(userMemories.embedding)))
    .orderBy(desc(userMemories.updatedAt))
    .limit(limit);
  const embedded = missing.length ? await embedMemories(db, settings, redis, missing) : 0;
  return { missing: missing.length, embedded };
}

export async function nearestMemories(
  db: Db,
  userId: string,
  vector: number[],
  opts: { categories?: readonly string[] | null; exclude?: readonly string[]; limit?: number; minSim?: number } = {},
): Promise<UserMemoryRow[]> {
  const limit = opts.limit ?? NEIGHBORS;
  const minSim = opts.minSim ?? NEIGHBOR_MIN_SIM;
  const lit = toVectorLiteral(vector);
  const distExpr = sql`(${userMemories.embedding} <=> ${lit}::vector)`;
  const conds = [
    eq(userMemories.userId, userId),
    eq(userMemories.status, "active"),
    eq(userMemories.isFolder, false),
    isNotNull(userMemories.embedding),
    sql`${distExpr} <= ${1 - minSim}`,
  ];
  if (opts.categories?.length) conds.push(inArray(userMemories.category, [...opts.categories]));
  if (opts.exclude?.length) conds.push(notInArray(userMemories.id, [...opts.exclude]));
  return db
    .select()
    .from(userMemories)
    .where(and(...conds))
    .orderBy(distExpr)
    .limit(limit);
}
