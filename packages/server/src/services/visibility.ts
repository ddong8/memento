// Whose data a user sees (services/enterprise_policy.py sees_all, services/user_filter.py).
import { eq, inArray, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import { machines } from "../db/pulled/schema";

export const isAdmin = (u: Pick<UserRow, "role">) => u.role === "admin" || u.role === "owner";

/** Admins and owners see everyone's unless MEMENTO_ADMIN_SCOPE=own. */
export const seesAll = (u: Pick<UserRow, "role">, settings: Settings) => isAdmin(u) && (settings.adminScope || "all").trim().toLowerCase() !== "own";

/** The user's machine ids, or null when they see every machine. */
export async function userMachineIds(db: Db, user: UserRow, settings: Settings): Promise<string[] | null> {
  if (seesAll(user, settings)) return null;
  const rows = await db.select({ id: machines.id }).from(machines).where(eq(machines.userId, user.id));
  return rows.map((r) => r.id);
}

/** apply_user_filter: no condition when null; an empty list matches nothing (as SQL `IN ()` would). */
export function machineFilter(ids: string[] | null, col: PgColumn): SQL | undefined {
  if (ids === null) return undefined;
  return ids.length ? inArray(col, ids) : (eq(col, "00000000-0000-0000-0000-000000000000") as SQL);
}
