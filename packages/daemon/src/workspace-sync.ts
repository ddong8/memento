import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { AgentEvent } from "./agent-stream.js";
import { homeDir } from "./config.js";
import {
  dropPending,
  listPending,
  mirrorBase,
  mirrorHave,
  mirrorPatch,
  packPatch,
  PATCH_LIMIT,
  prepareMirror,
  savePending,
  WorkspaceError,
  type AppliedFile,
  type ExportResult,
  type Mirror,
} from "./workspace.js";

/**
 * The executor's side of a task whose code is on another device: fetch the code before the agent
 * starts, send what it changed back when it's done. Everything goes through the server over this
 * device's own connection (`relay`): the two devices never need to reach each other.
 */

/** One request to the server, answered by it or by the source device behind it. Rejects on an error reply. */
export type Relay = (op: string, body: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;

export interface WorkspaceSpec {
  sourceDeviceId: string;
  sourcePath: string;
  sourceName: string;
}

export function parseWorkspaceSpec(raw: unknown): WorkspaceSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const sourceDeviceId = String(r.source_device_id ?? "").trim();
  const sourcePath = String(r.source_path ?? "").trim();
  if (!sourceDeviceId || !sourcePath) return undefined;
  return { sourceDeviceId, sourcePath, sourceName: String(r.source_name ?? "").trim() || "源设备" };
}

/**
 * The agent's answer with the clone's paths turned into the source's: the user reads it on the
 * device the code is on, where links into ~/.memento/workspaces/... open nothing. A Windows source
 * gets forward slashes, so "C:/x/a.py" and "file:///C:/x/a.py" both work there.
 */
export function toSourcePaths(text: string, workDir: string, sourcePath: string): string {
  const clone = workDir.replace(/[\\/]+$/, "");
  if (!text || !clone || clone === "/" || !text.includes(clone)) return text;
  const windows = /^[A-Za-z]:[\\/]/.test(sourcePath) || sourcePath.startsWith("\\\\");
  const source = (windows ? sourcePath.replaceAll("\\", "/") : sourcePath).replace(/\/+$/, "");
  // Only whole path components: "/ws/x" must not match inside "/ws/xy"
  const at = new RegExp(`(file://)?${clone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![^/\\s)\\]"'\`<>])`, "g");
  return text.replace(at, (_m, scheme: string | undefined) => (scheme ? `file://${source.startsWith("/") ? "" : "/"}${source}` : source));
}

/** Bundle pieces fetched per request: base64 makes it a third bigger on the wire. */
const CHUNK = 4 * 1024 * 1024;

export interface WorkspaceRun {
  spec: WorkspaceSpec;
  mirror: Mirror;
  release: () => void;
}

/** Clones in use by running tasks: a second task on the same directory gets a clone of its own. */
const busy = new Set<string>();

function takeSlot(spec: WorkspaceSpec, home?: string): { base: string; release: () => void } {
  const first = mirrorBase(spec.sourceDeviceId, spec.sourcePath, home);
  for (let n = 1; ; n++) {
    const base = n === 1 ? first : `${first}-${n}`;
    if (busy.has(base)) continue;
    busy.add(base);
    return { base, release: () => busy.delete(base) };
  }
}

async function download(relay: Relay, token: string, size: number, home?: string): Promise<string> {
  const dir = join(home ?? homeDir(), ".memento", "tmp");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `ws-${randomBytes(6).toString("hex")}.bundle`);
  const handle = await open(file, "w");
  try {
    let offset = 0;
    while (offset < size) {
      const r = await relay("chunk", { token, offset, length: Math.min(CHUNK, size - offset) }, 120_000);
      const data = Buffer.from(String(r.data_b64 ?? ""), "base64");
      if (!data.length) throw new WorkspaceError("源设备代码包读取中断");
      await handle.write(data, 0, data.length, offset);
      offset += data.length;
    }
  } catch (e) {
    await handle.close().catch(() => {});
    await rm(file, { force: true }).catch(() => {});
    throw e;
  }
  await handle.close();
  return file;
}

function exportInfo(r: Record<string, unknown>): Pick<ExportResult, "head" | "branch" | "snapshot" | "tree" | "root" | "rel" | "upToDate"> & { token: string; size: number } {
  return {
    token: String(r.token ?? ""),
    size: Number(r.size ?? 0),
    head: String(r.head ?? ""),
    branch: String(r.branch ?? ""),
    snapshot: String(r.snapshot ?? ""),
    tree: String(r.tree ?? ""),
    root: String(r.root ?? ""),
    rel: String(r.rel ?? ""),
    upToDate: r.up_to_date === true,
  };
}

/** Brings this device's clone of the source directory up to the state it is in on the source right now. */
export async function prepareWorkspace(
  spec: WorkspaceSpec,
  relay: Relay,
  options: { env?: NodeJS.ProcessEnv; home?: string; emit?: (e: AgentEvent) => void } = {},
): Promise<WorkspaceRun> {
  const { env, home, emit } = options;
  const slot = takeSlot(spec, home);
  try {
    const started = Date.now();
    let have = await mirrorHave(slot.base, env);
    for (let attempt = 0; ; attempt++) {
      const info = exportInfo(await relay("export", { source_device_id: spec.sourceDeviceId, path: spec.sourcePath, have }, 180_000));
      let bundle: string | undefined;
      try {
        if (!info.upToDate) bundle = await download(relay, info.token, info.size, home);
        const mirror = await prepareMirror(slot.base, info, bundle, { env });
        emit?.({
          kind: "workspace",
          status: "synced",
          source: spec.sourceName,
          path: spec.sourcePath,
          branch: info.branch,
          bytes: info.size,
          seconds: Math.round((Date.now() - started) / 100) / 10,
        } as AgentEvent);
        return { spec, mirror, release: slot.release };
      } catch (e) {
        // The clone lacks commits the bundle builds on (lost, or never fetched): ask for everything once
        if (e instanceof WorkspaceError && e.code === "missing_base" && attempt === 0) {
          have = [];
          continue;
        }
        throw e;
      } finally {
        if (bundle) await rm(bundle, { force: true }).catch(() => {});
      }
    }
  } catch (e) {
    slot.release();
    throw e;
  }
}

export interface WorkspaceOutcome extends Record<string, unknown> {
  kind: "workspace";
  status: "unchanged" | "applied" | "conflict" | "saved" | "pending" | "failed";
  source: string;
  files?: AppliedFile[];
  branch?: string;
  patch_path?: string;
  error?: string;
}

/**
 * Sends what the agent changed back to the source. `apply`: written into its working tree (a task
 * that succeeded); `save`: only kept there for the user to look at (failed, stopped). A source that
 * is offline gets it later, from the pending queue.
 */
export async function finishWorkspace(
  run: WorkspaceRun,
  taskId: string,
  mode: "apply" | "save",
  relay: Relay,
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<WorkspaceOutcome> {
  const { env, home } = options;
  const source = run.spec.sourceName;
  try {
    const made = await mirrorPatch(run.mirror, { env, home });
    if (!made.patch.length) return { kind: "workspace", status: "unchanged", source };
    const packed = await packPatch(made.patch);
    if (packed.length > PATCH_LIMIT) {
      const kept = await savePending({ taskId, sourceDeviceId: run.spec.sourceDeviceId, sourcePath: run.spec.sourcePath, baseTree: run.mirror.baseTree, mode: "save" }, made.patch, home);
      return {
        kind: "workspace",
        status: "failed",
        source,
        files: made.files.slice(0, 200),
        patch_path: kept.patchFile,
        error: `改动太大（压缩后 ${Math.round(packed.length / 1048576)}MB），没有传回；补丁留在执行机 ${kept.patchFile}`,
      };
    }
    try {
      return await sendPatch(relay, { taskId, spec: run.spec, baseTree: run.mirror.baseTree, mode, packed, files: made.files });
    } catch (e) {
      await savePending({ taskId, sourceDeviceId: run.spec.sourceDeviceId, sourcePath: run.spec.sourcePath, baseTree: run.mirror.baseTree, mode }, made.patch, home);
      return {
        kind: "workspace",
        status: "pending",
        source,
        files: made.files.slice(0, 200),
        error: `${source} 暂时收不到改动（${e instanceof Error ? e.message : String(e)}），它上线后自动补发`,
      };
    }
  } catch (e) {
    return { kind: "workspace", status: "failed", source, error: e instanceof Error ? e.message : String(e) };
  } finally {
    run.release();
  }
}

async function sendPatch(
  relay: Relay,
  p: { taskId: string; spec: WorkspaceSpec; baseTree: string; mode: "apply" | "save"; packed: string; files: AppliedFile[] },
): Promise<WorkspaceOutcome> {
  const r = await relay(
    "apply",
    {
      source_device_id: p.spec.sourceDeviceId,
      path: p.spec.sourcePath,
      task_id: p.taskId,
      base_tree: p.baseTree,
      mode: p.mode,
      patch_b64: p.packed,
      files: p.files.slice(0, 2000),
    },
    180_000,
  );
  const files = Array.isArray(r.files) ? (r.files as AppliedFile[]).slice(0, 200) : p.files.slice(0, 200);
  const status = r.applied === true ? "applied" : r.conflict === true ? "conflict" : "saved";
  return {
    kind: "workspace",
    status,
    source: p.spec.sourceName,
    files,
    ...(r.branch ? { branch: String(r.branch) } : {}),
    ...(r.patch_path ? { patch_path: String(r.patch_path) } : {}),
    ...(r.detail ? { error: String(r.detail) } : {}),
  };
}

let flushing = false;

/** Patches whose source was offline: sent again (on every reconnect and every few minutes). */
export async function flushPendingPatches(relay: Relay, log: (m: string) => void = () => {}, home?: string): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const p of await listPending(home)) {
      try {
        const patch = await readFile(p.patchFile);
        const packed = await packPatch(patch);
        if (packed.length > PATCH_LIMIT) continue;
        const spec: WorkspaceSpec = { sourceDeviceId: p.sourceDeviceId, sourcePath: p.sourcePath, sourceName: "源设备" };
        const out = await sendPatch(relay, { taskId: p.taskId, spec, baseTree: p.baseTree, mode: p.mode, packed, files: [] });
        await dropPending(p, home);
        sent++;
        log(`Delivered pending workspace patch of task ${p.taskId} to ${p.sourceDeviceId}: ${out.status}`);
      } catch (e) {
        // Still offline: keep it; a patch nobody took for a week is dropped
        if (Date.now() - Date.parse(p.createdAt) > 7 * 86_400_000) await dropPending(p, home).catch(() => {});
        else log(`Pending workspace patch of task ${p.taskId} not delivered yet: ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    flushing = false;
  }
  return sent;
}
