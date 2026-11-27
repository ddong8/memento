// Audit entries in access_logs, the same rows services/audit_service.py record() writes.
// Never breaks the action it records: a failed insert is logged and swallowed.
import type { Db } from "./db/client";
import { withoutNul } from "./db/client";
import { accessLogs } from "./db/pulled/schema";

export interface AuditActor {
  id: string;
  email: string;
  role: string;
}

export interface AuditRequest {
  ip: string | null;
  userAgent: string | null;
  path: string;
  method: string;
}

export async function record(
  db: Db,
  actor: AuditActor | null,
  action: string,
  req: AuditRequest | null,
  opts: { targetUserId?: string; detail?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    const meta: Record<string, unknown> = { audit: true };
    if (actor) {
      meta.actor_email = actor.email;
      meta.actor_role = actor.role;
    }
    if (opts.targetUserId) meta.target_user_id = opts.targetUserId;
    if (opts.detail) Object.assign(meta, opts.detail);
    if (req) {
      meta.path ??= req.path;
      meta.method ??= req.method;
    }
    await db.insert(accessLogs).values(
      withoutNul({
        userId: actor?.id ?? null,
        action,
        ipAddress: (req?.ip ?? "").slice(0, 45) || null,
        userAgent: req?.userAgent ?? null,
        metadata: meta,
      }),
    );
  } catch (e) {
    console.error(`couldn't record audit entry ${action}`, e);
  }
}
