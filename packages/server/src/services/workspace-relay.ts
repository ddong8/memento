// Cross-device workspace relay over device WebSockets (server/server/services/workspace_relay.py).
import { randomUUID } from "node:crypto";

import type { Deps } from "../context";
import { cluster } from "./cluster";
import { deviceHasFeature } from "./device-reports";
import { notifyUser } from "./notify";
import { classifyCatastrophic, classifyFileChange, classifyShellCommand, type RiskFinding } from "./risk-policy";
import { displayDeviceName, raiseAlert } from "./task-alerts";
import { findMachineByIdOrHash } from "./user-filter";
import { wsManager } from "./ws-manager";

export const TOKEN_TTL = 1800;
const TOKEN_KEY = "memento:ws:bundle:";
const localTokens = new Map<string, [number, Record<string, unknown>]>();

export const EXPORT_TIMEOUT = 150;
export const APPLY_TIMEOUT = 150;
export const PUSH_TIMEOUT = 300;
export const CHUNK_TIMEOUT = 60;
export const EXEC_MAX_MS = 30 * 60 * 1000;
export const EXEC_SLACK = 90;
export const EXEC_CHECK_SECONDS = 60;
export const EXEC_STATUS_TIMEOUT = 15;
export const SOURCE_GONE_GRACE = 120;
export const SESSION_TIMEOUT = 30;
export const CHUNK_MAX = 8 * 1024 * 1024;
export const PATCH_MAX = 10 * 1024 * 1024 + 1024;
export const CARRY_MAX = Math.floor((PATCH_MAX * 3) / 2);
export const COMMIT_TIMEOUT = 20 * 60;
export const GET_TIMEOUT = 120;
export const GET_MAX = Math.floor((8 * 1024 * 1024 * 4) / 3) + 1024;

const FEATURE_VERSION: Record<string, string> = {
  source_exec: "1.0.121",
  source_commit: "1.0.138",
  source_put: "1.0.141",
};

const APPLY_REPLY = [
  "applied",
  "conflict",
  "branch",
  "files",
  "patch_path",
  "detail",
  "commits",
  "committed",
  "commit_branch",
  "commits_error",
  "push",
] as const;

function iceServers(deps: Deps): string[] {
  return (deps.settings.stunUrls || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

function policyOf(deps: Deps): string {
  return (deps.settings.remoteExecPolicy || "off").trim().toLowerCase();
}

function refusalFor(deps: Deps, command: string, risk: RiskFinding | null): string | null {
  const policy = policyOf(deps);
  if (policy !== "strict" && policy !== "catastrophic") return null;
  if (policy === "strict") {
    return risk ? `这条命令有风险（${risk.label}），这个部署不允许在代码所在的设备上执行；需要的话请用户自己在那台设备上执行` : null;
  }
  const fatal = classifyCatastrophic(command);
  return fatal ? `这条命令会${fatal.label}，不在代码所在的设备上执行；确实需要请用户自己在那台设备上执行` : null;
}

async function sourceDevice(deps: Deps, sourceId: string, userId: string | null, feature?: string): Promise<[string | null, string | null]> {
  const m = await findMachineByIdOrHash(deps.db, deps.settings, sourceId);
  if (!m || !m.collectorTokenHash) return [null, "找不到代码所在的设备"];
  if (!userId || m.userId !== userId) return [null, "代码所在的设备不属于这个账号"];
  if (m.isArchived) return [null, "代码所在的设备已解除关联"];
  if (!wsManager.isOnline(m.collectorTokenHash)) return [null, `${m.name || "代码所在的设备"} 不在线，打开它上面的 Memento 后再试`];
  if (feature && !deviceHasFeature(m.name, feature)) {
    const need = FEATURE_VERSION[feature] ?? "1.0.121";
    return [null, `${m.name || "代码所在的设备"} 上的 Memento 版本太旧，升级到 ${need} 及以上后再试`];
  }
  return [m.collectorTokenHash, null];
}

async function putToken(entry: Record<string, unknown>): Promise<string> {
  const token = randomUUID().replaceAll("-", "");
  const r = cluster.redis;
  if (r) {
    await r.set(TOKEN_KEY + token, JSON.stringify(entry), "EX", TOKEN_TTL);
  } else {
    const now = performance.now() / 1000;
    for (const [k, [exp]] of [...localTokens.entries()]) {
      if (exp < now) localTokens.delete(k);
    }
    localTokens.set(token, [now + TOKEN_TTL, entry]);
  }
  return token;
}

async function getToken(token: string): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  const r = cluster.redis;
  if (r) {
    const raw = await r.get(TOKEN_KEY + token);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }
  const hit = localTokens.get(token);
  return hit && hit[0] >= performance.now() / 1000 ? hit[1] : null;
}

async function tellRisky(deps: Deps, taskId: string, risk: RiskFinding, sourceId: string, userId: string | null): Promise<void> {
  try {
    const m = await findMachineByIdOrHash(deps.db, deps.settings, sourceId);
    const name = m?.name ?? null;
    if (taskId && (await raiseAlert(deps, taskId, risk, "memento-source", name, { userId }))) return;
    if (userId) await notifyUser(deps, userId, "risky", `⚠️ ${risk.label}`, `${displayDeviceName(name)}：${risk.detail}`);
  } catch {
    /* ignore */
  }
}

async function awaitSource(source: string, payload: Record<string, unknown>, timeoutSec: number, execId = ""): Promise<Record<string, unknown>> {
  let finished = false;
  let result: Record<string, unknown> | null = null;
  const reqPromise = wsManager.requestDevice(source, payload, timeoutSec).then((r) => {
    finished = true;
    result = r;
    return r;
  });

  let goneSince: number | null = null;
  while (true) {
    const tick = new Promise<"tick">((resolve) => {
      const t = setTimeout(() => resolve("tick"), EXEC_CHECK_SECONDS * 1000);
      t.unref?.();
    });
    const winner = await Promise.race([reqPromise.then(() => "done" as const), tick]);
    if (winner === "done" || finished) return result ?? { error: "failed" };

    if (!wsManager.isOnline(source)) {
      const now = performance.now() / 1000;
      goneSince ??= now;
      if (now - goneSince >= SOURCE_GONE_GRACE) {
        return {
          error: `代码所在的设备断开连接超过 ${SOURCE_GONE_GRACE} 秒（睡眠或断网），这条命令的结果拿不回来了；它恢复在线后再试`,
          code: "source_unavailable",
        };
      }
      continue;
    }
    goneSince = null;
    if (!execId) continue;
    const st = await wsManager.requestDevice(source, { type: "workspace_exec_status", exec_id: execId }, EXEC_STATUS_TIMEOUT);
    if (finished && result) return result;
    if (st.state === "done" && st.result && typeof st.result === "object") return st.result as Record<string, unknown>;
    if (st.state === "unknown") {
      return { error: "代码所在的设备上已经没有这条命令了（那边的 Memento 重启过），请重新执行", code: "lost" };
    }
  }
}

function parseCommits(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    bundle_b64: String(r.bundle_b64 ?? ""),
    head: String(r.head ?? ""),
    base_head: String(r.base_head ?? ""),
    branch: String(r.branch ?? ""),
    push: r.push === true,
    ...(r.on_source === true ? { on_source: true } : {}),
  };
}

async function opExport(deps: Deps, data: Record<string, unknown>, userId: string | null): Promise<Record<string, unknown>> {
  const [source, why] = await sourceDevice(deps, String(data.source_device_id ?? ""), userId);
  if (!source) return { error: why, code: "source_unavailable" };
  const have = Array.isArray(data.have) ? data.have.filter((h): h is string => typeof h === "string").slice(0, 20) : [];
  const res = await wsManager.requestDevice(source, { type: "workspace_export_req", path: String(data.path ?? ""), have }, EXPORT_TIMEOUT);
  if (res.error) return { error: res.error, code: res.code ?? "failed" };
  const keys = ["size", "head", "branch", "snapshot", "tree", "root", "rel", "up_to_date", "upstream", "user_name", "user_email", "left_behind"] as const;
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = res[k] ?? null;
  if (!res.up_to_date) {
    out.token = await putToken({ device: source, path: res.bundle_path, size: Number(res.size ?? 0), user: String(userId ?? "") });
    out.ice_servers = iceServers(deps);
  }
  return out;
}

async function opP2p(deps: Deps, data: Record<string, unknown>, userId: string | null): Promise<Record<string, unknown>> {
  const entry = await getToken(String(data.token ?? ""));
  if (!entry || entry.user !== String(userId ?? "")) return { error: "传输已过期，重新开始任务", code: "expired" };
  const sdp = String(data.sdp ?? "");
  if (!sdp || sdp.length > 64 * 1024) return { error: "bad offer" };
  const res = await wsManager.requestP2pAnswer(String(entry.device), sdp, iceServers(deps));
  if (!res.sdp) return { error: res.error ?? "源设备没有应答直连", code: "no_direct" };
  return { sdp: res.sdp, path: entry.path };
}

async function opSession(deps: Deps, data: Record<string, unknown>, userId: string | null): Promise<Record<string, unknown>> {
  const [source, why] = await sourceDevice(deps, String(data.source_device_id ?? ""), userId);
  if (!source) return { error: why, code: "source_unavailable" };
  const res = await wsManager.requestDevice(source, { type: "session_export_req", session_id: String(data.session_id ?? "") }, SESSION_TIMEOUT);
  if (res.error) return { error: res.error, code: res.code ?? "failed" };
  const size = Number(res.size ?? 0);
  const out: Record<string, unknown> = { size, last_uuid: String(res.last_uuid ?? "") };
  if (size > 0) {
    out.token = await putToken({ device: source, path: res.path, size, user: String(userId ?? "") });
    out.ice_servers = iceServers(deps);
  }
  return out;
}

async function opChunk(_deps: Deps, data: Record<string, unknown>, userId: string | null): Promise<Record<string, unknown>> {
  const entry = await getToken(String(data.token ?? ""));
  if (!entry || entry.user !== String(userId ?? "")) return { error: "传输已过期，重新开始任务", code: "expired" };
  const totalSize = Number(entry.size ?? 0);
  const offset = Math.max(0, Number(data.offset ?? 0));
  if (offset >= totalSize) return { data_b64: "", bytes_read: 0 };
  const length = Math.max(1, Math.min(Number(data.length ?? CHUNK_MAX), CHUNK_MAX, totalSize - offset));
  const chunk = await wsManager.requestFileChunk(String(entry.device), String(entry.path), offset, length, CHUNK_TIMEOUT);
  if (!chunk) return { error: "从代码所在的设备读取代码包失败（设备离线或文件已清理）", code: "source_unavailable" };
  return { data_b64: chunk.toString("base64"), bytes_read: chunk.length };
}

async function opExec(deps: Deps, data: Record<string, unknown>, userId: string | null): Promise<Record<string, unknown>> {
  const command = String(data.command ?? "").trim();
  if (!command) return { error: "没有要执行的命令" };
  const risk = classifyShellCommand(command);
  const risky = Boolean(risk && (risk.level === "danger" || risk.level === "critical"));
  const refused = refusalFor(deps, command, risky ? risk : null);
  if (refused) return { error: refused, code: "refused" };
  const [source, why] = await sourceDevice(deps, String(data.source_device_id ?? ""), userId, "source_exec");
  if (!source) return { error: why, code: "source_unavailable" };
  if (risky && risk) {
    cluster.spawn(() => tellRisky(deps, String(data.task_id ?? ""), risk, String(data.source_device_id ?? ""), userId));
  }
  const patch = String(data.patch_b64 ?? "");
  if (patch.length > PATCH_MAX) return { error: "改动太大", code: "too_big" };
  const timeoutMs = Math.max(10_000, Math.min(Number(data.timeout_ms ?? EXEC_MAX_MS), EXEC_MAX_MS));
  const execId = String(data.exec_id ?? "");
  const res = await awaitSource(
    source,
    {
      type: "workspace_exec_req",
      path: String(data.path ?? ""),
      snapshot: String(data.snapshot ?? ""),
      rel: String(data.rel ?? ""),
      patch_b64: patch,
      command,
      timeout_ms: timeoutMs,
      task_id: String(data.task_id ?? ""),
      exec_id: execId,
    },
    timeoutMs / 1000 + EXEC_SLACK,
    execId,
  );
  if (res.error) return { error: res.error, code: res.code ?? "failed" };
  const out: Record<string, unknown> = {};
  for (const k of ["exit_code", "stdout", "stderr", "timed_out", "seconds"]) if (k in res) out[k] = res[k];
  return out;
}

async function opExecCancel(deps: Deps, data: Record<string, unknown>, userId: string | null): Promise<Record<string, unknown>> {
  const taskId = String(data.task_id ?? "");
  if (!taskId) return { error: "缺少任务 id" };
  const [source, why] = await sourceDevice(deps, String(data.source_device_id ?? ""), userId);
  if (!source) return { error: why, code: "source_unavailable" };
  const sent = await wsManager.sendJson(source, { type: "workspace_exec_cancel", task_id: taskId, exec_id: String(data.exec_id ?? "") });
  return { sent: Boolean(sent) };
}

async function opCommit(deps: Deps, data: Record<string, unknown>, userId: string | null): Promise<Record<string, unknown>> {
  const message = String(data.message ?? "").trim();
  if (!message) return { error: "提交说明是空的" };
  const [source, why] = await sourceDevice(deps, String(data.source_device_id ?? ""), userId, "source_commit");
  if (!source) return { error: why, code: "source_unavailable" };
  const patch = String(data.patch_b64 ?? "");
  if (patch.length > PATCH_MAX) return { error: "改动太大", code: "too_big" };
  const paths = Array.isArray(data.paths) ? data.paths.filter((p): p is string => typeof p === "string").slice(0, 200) : [];
  const res = await awaitSource(
    source,
    {
      type: "workspace_commit_req",
      path: String(data.path ?? ""),
      task_id: String(data.task_id ?? ""),
      snapshot: String(data.snapshot ?? ""),
      base_tree: String(data.base_tree ?? ""),
      base_head: String(data.base_head ?? ""),
      parent: String(data.parent ?? ""),
      patch_b64: patch,
      message: message.slice(0, 5000),
      paths,
    },
    COMMIT_TIMEOUT,
  );
  if (res.error) return { error: res.error, code: res.code ?? "failed" };
  const out: Record<string, unknown> = {};
  for (const k of ["exit_code", "stdout", "stderr", "sha", "subject", "files", "hook_patch_b64", "seconds"]) {
    if (k in res) out[k] = res[k];
  }
  return out;
}

async function opGet(deps: Deps, data: Record<string, unknown>, userId: string | null): Promise<Record<string, unknown>> {
  const [source, why] = await sourceDevice(deps, String(data.source_device_id ?? ""), userId, "source_commit");
  if (!source) return { error: why, code: "source_unavailable" };
  const res = await wsManager.requestDevice(
    source,
    {
      type: "workspace_get_req",
      path: String(data.path ?? ""),
      file: String(data.file ?? ""),
      rel: String(data.rel ?? ""),
      task_id: String(data.task_id ?? ""),
    },
    GET_TIMEOUT,
  );
  if (res.error) return { error: res.error, code: res.code ?? "failed" };
  if (String(res.data_b64 ?? "").length > GET_MAX) return { error: "文件太大", code: "too_big" };
  const out: Record<string, unknown> = {};
  for (const k of ["data_b64", "size", "path"]) if (k in res) out[k] = res[k];
  return out;
}

async function opPut(deps: Deps, data: Record<string, unknown>, userId: string | null): Promise<Record<string, unknown>> {
  const dest = String(data.dest ?? "").trim();
  if (!dest) return { error: "没有给要写到的位置" };
  const risk = classifyFileChange(dest, null);
  const risky = Boolean(risk && (risk.level === "danger" || risk.level === "critical"));
  if (risky && risk && policyOf(deps) === "strict") {
    return { error: `这个部署不允许写这个位置（${risk.label}）；需要的话请用户自己在那台设备上改`, code: "refused" };
  }
  const content = String(data.data_b64 ?? "");
  if (content.length > GET_MAX) return { error: "文件太大", code: "too_big" };
  const [source, why] = await sourceDevice(deps, String(data.source_device_id ?? ""), userId, "source_put");
  if (!source) return { error: why, code: "source_unavailable" };
  if (risky && risk) {
    cluster.spawn(() => tellRisky(deps, String(data.task_id ?? ""), risk, String(data.source_device_id ?? ""), userId));
  }
  const res = await wsManager.requestDevice(source, { type: "workspace_put_req", path: String(data.path ?? ""), dest, data_b64: content }, GET_TIMEOUT);
  if (res.error) return { error: res.error, code: res.code ?? "failed" };
  const out: Record<string, unknown> = {};
  for (const k of ["path", "size", "backup"]) if (k in res) out[k] = res[k];
  return out;
}

async function opApply(deps: Deps, data: Record<string, unknown>, userId: string | null): Promise<Record<string, unknown>> {
  const [source, why] = await sourceDevice(deps, String(data.source_device_id ?? ""), userId);
  if (!source) return { error: why, code: "source_unavailable" };
  const patch = String(data.patch_b64 ?? "");
  if (!patch) return { error: "补丁是空的" };
  if (patch.length > PATCH_MAX) return { error: "补丁太大", code: "too_big" };
  const files = Array.isArray(data.files) ? data.files.slice(0, 2000) : [];
  const commits = parseCommits(data.commits);
  if (commits && patch.length + String(commits.bundle_b64).length > CARRY_MAX) return { error: "改动和提交太大", code: "too_big" };
  const res = await wsManager.requestDevice(
    source,
    {
      type: "workspace_apply_req",
      path: String(data.path ?? ""),
      task_id: String(data.task_id ?? ""),
      base_tree: String(data.base_tree ?? ""),
      mode: data.mode === "save" ? "save" : "apply",
      patch_b64: patch,
      files,
      ...(commits ? { commits } : {}),
    },
    commits?.push ? PUSH_TIMEOUT : APPLY_TIMEOUT,
  );
  if (res.error) return { error: res.error, code: res.code ?? "failed" };
  const out: Record<string, unknown> = {};
  for (const k of APPLY_REPLY) if (k in res) out[k] = res[k];
  return out;
}

const OPS: Record<string, (deps: Deps, data: Record<string, unknown>, userId: string | null) => Promise<Record<string, unknown>>> = {
  export: opExport,
  chunk: opChunk,
  p2p: opP2p,
  session: opSession,
  exec: opExec,
  exec_cancel: opExecCancel,
  commit: opCommit,
  get: opGet,
  put: opPut,
  apply: opApply,
};

export async function handleWorkspaceRelay(deps: Deps, data: Record<string, unknown>, executorId: string, userId: string | null): Promise<void> {
  const reqId = data.req_id;
  const op = String(data.op ?? "");
  const fn = OPS[op];
  let reply: Record<string, unknown>;
  try {
    reply = fn ? await fn(deps, data, userId) : { error: `unknown op ${op}` };
  } catch (e) {
    reply = { error: `服务器中转失败：${(e as Error).message || String(e)}` };
  }
  await wsManager.sendJson(executorId, { ...reply, type: "ws_relay_reply", req_id: reqId });
}
