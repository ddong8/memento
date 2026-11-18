import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  assertPathAllowed,
  managedPolicy,
  managedPolicyPath,
  parseManagedPolicy,
  pathAllowed,
  resetManagedPolicy,
  taskRefusal,
} from "../src/managed-policy.js";
import { TaskRunner } from "../src/task-runner.js";

afterEach(() => resetManagedPolicy());

describe("the policy the company's IT puts on the computer", () => {
  it("lives where MDM / group policy can write it on each system", () => {
    expect(managedPolicyPath({}, "darwin")).toBe("/Library/Application Support/Memento/managed.json");
    expect(managedPolicyPath({ ProgramData: "C:\\ProgramData" }, "win32")).toContain("Memento");
    expect(managedPolicyPath({}, "linux")).toBe("/etc/memento/managed.json");
    expect(managedPolicyPath({ MEMENTO_MANAGED_CONFIG: "/tmp/p.json" }, "linux")).toBe("/tmp/p.json");
  });

  it("reads server, task kinds and directories; a broken file locks nobody out", () => {
    const p = parseManagedPolicy(
      JSON.stringify({ server_url: "https://memento.corp.example.com/", remote_tasks: "agent", allowed_roots: ["~/work", "/srv/repos", 3] }),
      "/home/li",
    );
    expect(p.serverUrl).toBe("https://memento.corp.example.com");
    expect(p.remoteTasks).toBe("agent");
    expect(p.allowedRoots).toEqual(["/home/li/work", "/srv/repos"]);
    expect(parseManagedPolicy("{not json", "/home/li")).toMatchObject({ remoteTasks: "all", allowedRoots: [] });
    expect(parseManagedPolicy(JSON.stringify({ server_url: "javascript:alert(1)", remote_tasks: "everything" })))
      .toMatchObject({ remoteTasks: "all" });
    expect(parseManagedPolicy(JSON.stringify({ server_url: "javascript:alert(1)" })).serverUrl).toBeUndefined();
  });

  it("refuses the kinds of tasks the company turned off", () => {
    const agentOnly = parseManagedPolicy(JSON.stringify({ remote_tasks: "agent" }));
    expect(taskRefusal("agent", agentOnly)).toBeNull();
    expect(taskRefusal("shell", agentOnly)).toContain("只允许运行智能体任务");
    const none = parseManagedPolicy(JSON.stringify({ remote_tasks: "none" }));
    expect(taskRefusal("agent", none)).toContain("不允许接收远程任务");
    expect(taskRefusal("shell", parseManagedPolicy("{}"))).toBeNull();
  });

  it("reaches only inside the allowed directories, not a sibling that shares a prefix", () => {
    const p = parseManagedPolicy(JSON.stringify({ allowed_roots: ["/srv/repos"] }));
    expect(pathAllowed("/srv/repos", p, "linux")).toBe(true);
    expect(pathAllowed("/srv/repos/app/src/a.ts", p, "linux")).toBe(true);
    expect(pathAllowed("/srv/repos/../secrets/key", p, "linux")).toBe(false);
    expect(pathAllowed("/srv/repos-old/a", p, "linux")).toBe(false);
    expect(pathAllowed("/home/li/.ssh/id_rsa", p, "linux")).toBe(false);
    expect(() => assertPathAllowed("/etc/passwd", p)).toThrow(/管理员策略不允许访问/);
    expect(pathAllowed("/anything", parseManagedPolicy("{}"), "linux")).toBe(true);
  });

  it("the server it names wins over the user's own setting", async () => {
    const home = mkdtempSync(join(tmpdir(), "mp-home-"));
    mkdirSync(join(home, ".memento"), { recursive: true });
    writeFileSync(join(home, ".memento", "collector.json"), JSON.stringify({ server_url: "https://somewhere.else", token: "t" }));
    const file = join(home, "managed.json");
    writeFileSync(file, JSON.stringify({ server_url: "https://memento.corp.example.com" }));
    resetManagedPolicy();
    const cfg = await loadConfig({ home, env: { HOME: home, MEMENTO_MANAGED_CONFIG: file } });
    expect(managedPolicy().source).toBe(file);
    expect(cfg.serverUrl).toBe("https://memento.corp.example.com");
    expect(cfg.token).toBe("t");
  });

  it("a refused task is reported failed, with the reason, and nothing runs", async () => {
    resetManagedPolicy(parseManagedPolicy(JSON.stringify({ remote_tasks: "agent" })));
    const send = vi.fn();
    const runner = new TaskRunner(send);
    await runner.execute({ id: "t-shell", action: "shell", payload: { command: "echo hi" }, timeoutSeconds: 30 } as never);
    const finished = send.mock.calls.map((c) => c[0]).find((m) => m.type === "task_finished");
    expect(finished).toMatchObject({ task_id: "t-shell", status: "failed", error_type: "policy" });
    expect(String(finished.error)).toContain("只允许运行智能体任务");
    expect(send.mock.calls.some((c) => c[0].type === "task_output")).toBe(false);
  });

  it("a task outside the allowed directories doesn't start", async () => {
    resetManagedPolicy(parseManagedPolicy(JSON.stringify({ allowed_roots: [join(tmpdir(), "only-here-xyz")] })));
    const send = vi.fn();
    const runner = new TaskRunner(send);
    await runner.execute({ id: "t-cwd", action: "shell", payload: { command: "echo hi", cwd: tmpdir() }, timeoutSeconds: 30 } as never);
    const finished = send.mock.calls.map((c) => c[0]).find((m) => m.type === "task_finished");
    expect(finished).toMatchObject({ task_id: "t-cwd", status: "failed", error_type: "policy" });
  });
});
