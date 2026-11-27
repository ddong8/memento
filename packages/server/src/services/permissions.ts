// Permission service — checks user access to documents (server/server/services/permission_service.py).
import { and, eq, isNull, or } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import { permissions } from "../db/pulled/schema";

export async function canViewDocument(
  db: Db,
  settings: Pick<Settings, "debug" | "secretKey">,
  user: UserRow | null,
  doc: { visibility: string; projectId: string | null; toolId: string },
): Promise<boolean> {
  if (doc.visibility === "public") return true;
  if (settings.debug || !settings.secretKey || settings.secretKey === "change-me-in-production") return true;
  if (!user) return false;
  if (user.role === "owner" || user.role === "admin") return true;

  if (doc.projectId) {
    const [row] = await db
      .select({ id: permissions.id })
      .from(permissions)
      .where(
        and(
          eq(permissions.userId, user.id),
          or(eq(permissions.projectId, doc.projectId), isNull(permissions.projectId)),
          or(eq(permissions.toolId, doc.toolId), isNull(permissions.toolId)),
        ),
      )
      .limit(1);
    return !!row;
  }

  const [row] = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(and(eq(permissions.userId, user.id), or(eq(permissions.toolId, doc.toolId), isNull(permissions.toolId))))
    .limit(1);
  return !!row;
}
