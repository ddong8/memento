// Completion check (Stop hook) settings, device status & event stats (server/server/services/guard_service.py).
import { and, count, desc, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import { withoutNul, type Db } from "../db/client";
import { guardEvents, machines } from "../db/pulled/schema";
import { pgToIso } from "../pytime";
import { profileTargets } from "./profile-targets";

export const GUARD_TOOLS = ["claude_code", "codex"] as const;
export const OUTCOMES = ["verified", "no_evidence", "failed_check", "disclosed", "unread"] as const;
export const SETTING = "completion_guard";

const GUARD_TOOL_SET = new Set<string>(GUARD_TOOLS);
const OUTCOME_SET = new Set<string>(OUTCOMES);

export function guardEnabled(user: Pick<UserRow, "proactiveSettings">): boolean {
  const s = user.proactiveSettings && typeof user.proactiveSettings === "object" && !Array.isArray(user.proactiveSettings)
    ? (user.proactiveSettings as Record<string, unknown>)
    : {};
  return s[SETTING] !== false;
}

export function guardTools(user: Pick<UserRow, "proactiveSettings">, machine: { profileTargetsOff?: unknown }): string[] {
  if (!guardEnabled(user)) return [];
  const targets = profileTargets(machine);
  return GUARD_TOOLS.filter((t) => targets.includes(t));
}

function parseAt(raw: unknown): string {
  const nowMs = Date.now();
  if (typeof raw === "string") {
    const normalized = raw.replace("Z", "+00:00");
    const ms = Date.parse(normalized);
    if (Number.isFinite(ms) && ms >= nowMs - 30 * 86400_000 && ms <= nowMs + 10 * 60_000) {
      return new Date(ms).toISOString();
    }
  }
  return new Date(nowMs).toISOString();
}

function cleanText(raw: unknown, limit: number): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s ? [...s].slice(0, limit).join("") : null;
}

export function buildEventRows(
  userId: string,
  machineId: string,
  events: Record<string, unknown>[],
): (typeof guardEvents.$inferInsert)[] {
  const rows: (typeof guardEvents.$inferInsert)[] = [];
  for (const e of events.slice(0, 50)) {
    const tool = String(e?.tool ?? "");
    const outcome = String(e?.outcome ?? "");
    if (!GUARD_TOOL_SET.has(tool) || !OUTCOME_SET.has(outcome)) continue;
    rows.push(
      withoutNul({
        userId,
        machineId,
        tool,
        sessionId: cleanText(e.session_id, 100),
        outcome,
        blocked: Boolean(e.blocked),
        followup: Boolean(e.followup),
        deploy: Boolean(e.deploy),
        claim: cleanText(e.claim, 200),
        check: cleanText(e.check, 200),
        cwd: cleanText(e.cwd, 300),
        saidAt: parseAt(e.at),
      }),
    );
  }
  return rows;
}

export function mergeGuardStatus(
  currentStatus: unknown,
  results: Record<string, unknown>,
): Record<string, unknown> {
  const status =
    currentStatus && typeof currentStatus === "object" && !Array.isArray(currentStatus)
      ? { ...(currentStatus as Record<string, unknown>) }
      : {};
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(results || {})) {
    if (GUARD_TOOL_SET.has(k) || k === "codex_trust") {
      filtered[k] = String(v ?? "").slice(0, 200);
    }
  }
  status.guards = {
    results: filtered,
    reported_at: new Date().toISOString().replace("Z", "+00:00"),
  };
  return status;
}

export async function guardStats(db: Db, userId: string, sinceIso: string, untilIso?: string | null) {
  const conds = [
    eq(guardEvents.userId, userId),
    gte(guardEvents.saidAt, sinceIso),
    ne(guardEvents.outcome, "unread"),
  ];
  if (untilIso) conds.push(lt(guardEvents.saidAt, untilIso));
  const [r] = await db
    .select({
      claims: sql<number>`count(*) filter (where ${guardEvents.followup} is false)`.mapWith(Number),
      verified: sql<number>`count(*) filter (where ${guardEvents.followup} is false and ${guardEvents.outcome} = 'verified')`.mapWith(Number),
      disclosed: sql<number>`count(*) filter (where ${guardEvents.followup} is false and ${guardEvents.outcome} = 'disclosed')`.mapWith(Number),
      blocked: sql<number>`count(*) filter (where ${guardEvents.followup} is false and ${guardEvents.blocked} is true)`.mapWith(Number),
      followups: sql<number>`count(*) filter (where ${guardEvents.followup} is true)`.mapWith(Number),
      checkedAfter: sql<number>`count(*) filter (where ${guardEvents.followup} is true and ${guardEvents.outcome} = 'verified')`.mapWith(Number),
      disclosedAfter: sql<number>`count(*) filter (where ${guardEvents.followup} is true and ${guardEvents.outcome} = 'disclosed')`.mapWith(Number),
      deployClaims: sql<number>`count(*) filter (where ${guardEvents.followup} is false and ${guardEvents.deploy} is true)`.mapWith(Number),
    })
    .from(guardEvents)
    .where(and(...conds));
  const claims = r?.claims || 0;
  const blocked = r?.blocked || 0;
  return {
    claims,
    verified: r?.verified || 0,
    disclosed: r?.disclosed || 0,
    blocked,
    followups: r?.followups || 0,
    checked_after: r?.checkedAfter || 0,
    disclosed_after: r?.disclosedAfter || 0,
    deploy_claims: r?.deployClaims || 0,
    unchecked_rate: claims ? Math.round((blocked / claims) * 1000) / 1000 : null,
  };
}

export async function guardOverview(db: Db, user: UserRow, days = 30) {
  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
  const machineRows = await db
    .select()
    .from(machines)
    .where(and(eq(machines.userId, user.id), isNull(machines.mergedInto), eq(machines.isArchived, false)))
    .orderBy(sql`${machines.lastHeartbeat} DESC NULLS LAST`);

  const devices: Record<string, unknown>[] = [];
  const names = new Map<string, string>();
  for (const m of machineRows) {
    names.set(m.id, m.name);
    const pStatus = m.profileStatus && typeof m.profileStatus === "object" ? (m.profileStatus as Record<string, unknown>) : {};
    const gStatus = pStatus.guards && typeof pStatus.guards === "object" ? (pStatus.guards as Record<string, unknown>) : {};
    const tools = GUARD_TOOLS.filter((t) => profileTargets(m).includes(t));
    if (!tools.length && !Object.keys(gStatus).length) continue;
    devices.push({
      id: m.id,
      name: m.name,
      tools,
      results: (gStatus.results as Record<string, unknown>) || {},
      reported_at: gStatus.reported_at ?? null,
    });
  }

  const perToolRows = await db
    .select({ tool: guardEvents.tool, n: count() })
    .from(guardEvents)
    .where(and(eq(guardEvents.userId, user.id), gte(guardEvents.saidAt, sinceIso), eq(guardEvents.followup, false)))
    .groupBy(guardEvents.tool);
  const perTool: Record<string, number> = {};
  for (const r of perToolRows) perTool[r.tool] = Number(r.n);

  const recentRows = await db
    .select()
    .from(guardEvents)
    .where(
      and(
        eq(guardEvents.userId, user.id),
        gte(guardEvents.saidAt, sinceIso),
        or(eq(guardEvents.blocked, true), eq(guardEvents.followup, true)),
      ),
    )
    .orderBy(desc(guardEvents.saidAt))
    .limit(20);

  return {
    enabled: guardEnabled(user),
    tools: [...GUARD_TOOLS],
    days,
    devices,
    stats: { ...(await guardStats(db, user.id, sinceIso)), per_tool: perTool },
    recent: recentRows.map((e) => ({
      tool: e.tool,
      device: e.machineId ? (names.get(e.machineId) ?? null) : null,
      outcome: e.outcome,
      blocked: e.blocked,
      followup: e.followup,
      deploy: e.deploy,
      claim: e.claim,
      check: e.check,
      cwd: e.cwd,
      at: pgToIso(e.saidAt),
    })),
  };
}
