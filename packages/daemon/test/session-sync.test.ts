import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  claudeProjectDirName,
  exportClaudeSession,
  fetchClaudeSession,
  findClaudeSession,
  moveSessionCwd,
  type SessionRelay,
} from "../src/session-sync.js";

const SID = "4ffa3fac-1111-2222-3333-444455556666";

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const transcript = (cwd: string, uuids: string[]) =>
  [line({ type: "custom-title", customTitle: "Memento: t", sessionId: SID }), ...uuids.map((u) => line({ type: "user", uuid: u, cwd, sessionId: SID }))].join("\n") + "\n";

function home(): string {
  return mkdtempSync(join(tmpdir(), "memento-sess-"));
}

function put(h: string, cwd: string, text: string): string {
  const dir = join(h, ".claude", "projects", claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SID}.jsonl`);
  writeFileSync(path, text);
  return path;
}

/** The server and the source device behind it, as the executor's relay sees them. */
function relayTo(sourceHome: string): SessionRelay & { ops: string[] } {
  const ops: string[] = [];
  let file = "";
  const fn = (async (op: string, body: Record<string, unknown>) => {
    ops.push(op);
    if (op === "session") {
      const r = await exportClaudeSession(String(body.session_id), sourceHome);
      file = r.path;
      return { size: r.size, last_uuid: r.last_uuid, token: "t1" };
    }
    if (op === "chunk") {
      const buf = readFileSync(file).subarray(Number(body.offset), Number(body.offset) + Number(body.length));
      return { data_b64: buf.toString("base64"), bytes_read: buf.length };
    }
    throw new Error(`unexpected ${op}`);
  }) as unknown as SessionRelay & { ops: string[] };
  fn.ops = ops;
  return fn;
}

describe("a Claude Code session continued on another device", () => {
  it("Claude Code's folder for a directory dashes everything but letters and digits", () => {
    expect(claudeProjectDirName("/home/opc/.memento/workspaces/e91345181eb9/memento")).toBe("-home-opc--memento-workspaces-e91345181eb9-memento");
    expect(claudeProjectDirName("C:\\Users\\me\\repo")).toBe("C--Users-me-repo");
  });

  it("moves the transcript's working directory, subfolders included, and leaves other lines alone", () => {
    const text = [line({ type: "user", uuid: "a", cwd: "/Users/me/repo" }), line({ type: "user", uuid: "b", cwd: "/Users/me/repo/sub" }), "not json", line({ type: "x", cwd: "/elsewhere" })].join("\n");
    const out = moveSessionCwd(text, "/home/opc/ws/repo").split("\n");
    expect(JSON.parse(out[0]!).cwd).toBe("/home/opc/ws/repo");
    expect(JSON.parse(out[1]!).cwd).toBe("/home/opc/ws/repo/sub");
    expect(out[2]).toBe("not json");
    expect(JSON.parse(out[3]!).cwd).toBe("/elsewhere");
    // A Windows source onto a posix executor
    const win = moveSessionCwd(line({ uuid: "a", cwd: "C:\\Users\\me\\repo" }) + "\n" + line({ uuid: "b", cwd: "C:\\Users\\me\\repo\\src" }), "/w/repo");
    expect(win.split("\n").map((l) => JSON.parse(l).cwd)).toEqual(["/w/repo", "/w/repo/src"]);
  });

  it("fetches the session into this directory's folder so claude -r resumes it", async () => {
    const mac = home();
    const vps = home();
    put(mac, "/Users/me/repo", transcript("/Users/me/repo", ["u1", "u2"]));
    const relay = relayTo(mac);
    const got = await fetchClaudeSession({ sessionId: SID, sourceDeviceId: "mac", workDir: "/home/opc/ws/repo", relay, home: vps });
    expect(got.status).toBe("fetched");
    expect(got.path).toBe(join(vps, ".claude", "projects", "-home-opc-ws-repo", `${SID}.jsonl`));
    const lines = readFileSync(got.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].customTitle).toBe("Memento: t");
    expect(lines.slice(1).map((l) => [l.uuid, l.cwd])).toEqual([["u1", "/home/opc/ws/repo"], ["u2", "/home/opc/ws/repo"]]);
    expect(await findClaudeSession(SID, vps)).toBe(got.path);
  });

  it("keeps a copy here that already has the source's last entry (the session went on here)", async () => {
    const mac = home();
    const vps = home();
    put(mac, "/Users/me/repo", transcript("/Users/me/repo", ["u1", "u2"]));
    const here = put(vps, "/home/opc/ws/repo", transcript("/home/opc/ws/repo", ["u1", "u2", "u3"]));
    const relay = relayTo(mac);
    const got = await fetchClaudeSession({ sessionId: SID, sourceDeviceId: "mac", workDir: "/home/opc/ws/repo", relay, home: vps });
    expect(got.status).toBe("current");
    expect(relay.ops).toEqual(["session"]);
    expect(readFileSync(here, "utf8")).toContain('"uuid":"u3"');
  });

  it("replaces a copy here that is behind, setting it aside rather than deleting it", async () => {
    const mac = home();
    const vps = home();
    put(mac, "/Users/me/repo", transcript("/Users/me/repo", ["u1", "u2", "u3"]));
    const stale = put(vps, "/old/place", transcript("/old/place", ["u1"]));
    const got = await fetchClaudeSession({ sessionId: SID, sourceDeviceId: "mac", workDir: "/home/opc/ws/repo", relay: relayTo(mac), home: vps });
    expect(got.status).toBe("fetched");
    expect(readFileSync(got.path, "utf8")).toContain('"uuid":"u3"');
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(join(stale, "..")).some((n) => n.startsWith(`${SID}.jsonl.moved-`))).toBe(true);
    expect(await findClaudeSession(SID, vps)).toBe(got.path);
  });

  it("a session the source doesn't have, or a bad id, is an error", async () => {
    const mac = home();
    await expect(fetchClaudeSession({ sessionId: SID, sourceDeviceId: "mac", workDir: "/w", relay: relayTo(mac), home: home() })).rejects.toThrow(/没有会话/);
    await expect(fetchClaudeSession({ sessionId: "../../etc", sourceDeviceId: "mac", workDir: "/w", relay: relayTo(mac), home: home() })).rejects.toThrow(/会话号不对/);
  });
});
