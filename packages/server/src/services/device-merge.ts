// Device merge resolution (server/server/services/device_merge.py resolve_merged).
import { eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { machines } from "../db/pulled/schema";

export type MachineRow = typeof machines.$inferSelect;

export async function resolveMerged(db: Db, machine: MachineRow | null | undefined): Promise<MachineRow | null> {
  let cur: MachineRow | null = machine ?? null;
  let seen = 0;
  while (cur && cur.mergedInto && seen < 5) {
    const [next] = await db.select().from(machines).where(eq(machines.id, cur.mergedInto)).limit(1);
    cur = next ?? null;
    seen++;
  }
  return cur;
}
