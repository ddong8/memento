import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { homeDir } from "./config.js";
import { DirectPullError, pullDirect } from "./p2p.js";

/**
 * A Claude Code session continued on another device, as is. Claude Code keeps a session only on the
 * device it ran on (~/.claude/projects/<the directory, dashed>/<id>.jsonl), so before resuming one whose
 * latest copy is elsewhere this device fetches that file through the server (op `session`, then the
 * same `chunk` reads a workspace bundle uses), points its working directory at this device's and puts
 * it where Claude Code looks: `claude -r` then goes on in the same session, same id and title, compacted
 * by Claude Code itself. The source answers `session_export_req` with where the file is.
 */

/** Session ids are UUIDs: anything else could reach outside the folder. */
const SESSION_ID = /^[\w-]{8,128}$/;

export type SessionRelay = (op: string, body: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;

export function claudeProjectsDir(home = homeDir()): string {
  return join(home, ".claude", "projects");
}

/** Claude Code's folder for sessions run in cwd: every character but letters and digits becomes "-". */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The session's transcript on this device (the newest when more than one project has it). */
export async function findClaudeSession(sessionId: string, home = homeDir()): Promise<string | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const projects = claudeProjectsDir(home);
  let best: { path: string; mtime: number } | undefined;
  for (const name of await readdir(projects).catch(() => [] as string[])) {
    const path = join(projects, name, `${sessionId}.jsonl`);
    const st = await stat(path).catch(() => null);
    if (st?.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path, mtime: st.mtimeMs };
  }
  return best?.path;
}

/** The last entry's uuid: a copy holding it has everything the transcript has. */
export function lastEntryUuid(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /"uuid"\s*:\s*"([^"]+)"/.exec(lines[i] ?? "");
    if (m?.[1]) return m[1];
  }
  return "";
}

export interface SessionExport {
  path: string;
  size: number;
  last_uuid: string;
}

/** The source's side: where the session is and how far it goes. */
export async function exportClaudeSession(sessionId: string, home = homeDir()): Promise<SessionExport> {
  const path = await findClaudeSession(sessionId, home);
  if (!path) throw new Error(`这台设备上没有会话 ${sessionId.slice(0, 8)}`);
  const st = await stat(path);
  // The tail is enough for the last uuid: read the last 256 KB, not a transcript of many MB
  const handle = await open(path, "r");
  try {
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, st.size - len);
    return { path, size: st.size, last_uuid: lastEntryUuid(buf.toString("utf8")) };
  } finally {
    await handle.close();
  }
}

/**
 * The transcript with its working directory moved: entries' cwd under the session's own directory
 * (the first one recorded) are put under toCwd, so Claude Code resumes it as a session of that
 * directory. Lines that aren't JSON stay as they are.
 */
export function moveSessionCwd(text: string, toCwd: string): string {
  const lines = text.split("\n");
  let from = "";
  for (const line of lines) {
    const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m) {
      try {
        from = JSON.parse(`"${m[1]}"`) as string;
      } catch {
        from = "";
      }
      if (from) break;
    }
  }
  const to = toCwd.replace(/[\\/]+$/, "");
  if (!from || from === to) return text;
  const fromBase = from.replace(/[\\/]+$/, "");
  const posix = !/^[A-Za-z]:[\\/]/.test(to) && !to.startsWith("\\\\");
  return lines
    .map((line) => {
      if (!line.includes('"cwd"')) return line;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return line;
      }
      const cwd = entry.cwd;
      if (typeof cwd !== "string") return line;
      let moved: string | undefined;
      if (cwd === fromBase || cwd === from) moved = to;
      else if (cwd.startsWith(`${fromBase}/`) || cwd.startsWith(`${fromBase}\\`)) {
        const rest = cwd.slice(fromBase.length);
        moved = to + (posix ? rest.replaceAll("\\", "/") : rest.replaceAll("/", "\\"));
      }
      if (moved === undefined) return line;
      entry.cwd = moved;
      return JSON.stringify(entry);
    })
    .join("\n");
}

export interface SessionFetch {
  /** `fetched`: the copy here was missing or behind and now is the source's; `current`: it was up to date. */
  status: "fetched" | "current";
  path: string;
  bytes?: number;
  /** Of those, the bytes that came straight from the source over WebRTC rather than through the server. */
  direct?: number;
}

/** Pieces of the session file per request: base64 makes it a third bigger on the wire. */
const CHUNK = 4 * 1024 * 1024;
/** Smaller transcripts aren't worth setting up a direct channel for. */
const DIRECT_MIN = 256 * 1024;
/** Bigger than any transcript worth resuming (Claude Code compacts long before). */
const MAX_SESSION_BYTES = 512 * 1024 * 1024;

/**
 * Makes the session's latest copy (on sourceDeviceId) the one here, under workDir's project folder,
 * so `claude -r` resumes it. A copy here that already has its last entry is kept (it may be ahead: the
 * session went on here); an older one elsewhere on this device is set aside, not deleted.
 */
export async function fetchClaudeSession(o: {
  sessionId: string;
  sourceDeviceId: string;
  workDir: string;
  relay: SessionRelay;
  home?: string;
}): Promise<SessionFetch> {
  const home = o.home ?? homeDir();
  if (!SESSION_ID.test(o.sessionId)) throw new Error(`会话号不对：${o.sessionId}`);
  const info = await o.relay("session", { source_device_id: o.sourceDeviceId, session_id: o.sessionId }, 60_000);
  const size = Number(info.size ?? 0);
  const lastUuid = String(info.last_uuid ?? "");
  const token = String(info.token ?? "");
  if (!token || !(size > 0)) throw new Error("源设备没给出会话文件");
  if (size > MAX_SESSION_BYTES) throw new Error(`会话文件太大（${Math.round(size / 1024 / 1024)} MB）`);

  const target = join(claudeProjectsDir(home), claudeProjectDirName(o.workDir), `${o.sessionId}.jsonl`);
  const local = await findClaudeSession(o.sessionId, home);
  if (local && lastUuid) {
    const text = await readFile(local, "utf8").catch(() => "");
    if (text.includes(`"uuid":"${lastUuid}"`) || text.includes(`"uuid": "${lastUuid}"`)) {
      // Up to date (or ahead) already: only make sure it is where this directory's sessions are
      if (local !== target) await placeCopy(moveSessionCwd(text, o.workDir), target, local);
      return { status: "current", path: target };
    }
  }

  // Straight from the source over WebRTC when the server offers it and a direct path exists (the
  // server's public entry is a few Mbps); the rest, or all of it, piece by piece through the server
  const buf = Buffer.alloc(size);
  let offset = 0;
  const iceServers = Array.isArray(info.ice_servers) ? info.ice_servers.map(String) : null;
  if (iceServers && size >= DIRECT_MIN) {
    try {
      offset = await pullDirect({
        size,
        iceServers,
        signal: async (sdp) => {
          const r = await o.relay("p2p", { token, sdp }, 30_000);
          return { sdp: String(r.sdp ?? ""), path: String(r.path ?? "") };
        },
        write: async (data, at) => data.copy(buf, at),
      });
    } catch (e) {
      offset = e instanceof DirectPullError ? e.written : 0;
    }
  }
  const direct = offset;
  while (offset < size) {
    const r = await o.relay("chunk", { token, offset, length: Math.min(CHUNK, size - offset) }, 120_000);
    const data = Buffer.from(String(r.data_b64 ?? ""), "base64");
    if (!data.length) throw new Error("会话文件读取中断");
    data.copy(buf, offset);
    offset += data.length;
  }
  await placeCopy(moveSessionCwd(buf.toString("utf8"), o.workDir), target, local);
  return { status: "fetched", path: target, bytes: size, ...(direct ? { direct } : {}) };
}

/** Writes the transcript to target (whole, then renamed in) and sets an older copy elsewhere aside. */
async function placeCopy(text: string, target: string, older: string | undefined): Promise<void> {
  await mkdir(join(target, ".."), { recursive: true });
  const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text);
  if (older && older !== target) {
    await rename(older, `${older}.moved-${Date.now()}`).catch(() => {});
  } else if (older === target) {
    await rename(target, `${target}.before-${Date.now()}`).catch(() => {});
  }
  await rename(tmp, target).catch(async (e) => {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  });
}
