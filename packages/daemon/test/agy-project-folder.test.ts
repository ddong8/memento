import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agyFolderUri, projectForFolder, sameAgyFolder, timerSeconds } from "../src/agy-runner/runner.js";

describe("Antigravity project folders", () => {
  it("writes folder URIs as the app does", () => {
    // As in a Windows conversation_summaries row (2026-11-14)
    expect(agyFolderUri("D:\\dev\\2026\\0123\\favorite_chat\\easywork-copilot", "win32")).toBe(
      "file:///d%3A/dev/2026/0123/favorite_chat/easywork-copilot",
    );
    expect(agyFolderUri("/Users/me/dev/memento/", "darwin")).toBe("file:///Users/me/dev/memento");
    expect(agyFolderUri("/Users/me/my app", "darwin")).toBe("file:///Users/me/my%20app");
  });

  it("matches a folder whatever way it's written", () => {
    expect(sameAgyFolder("file:///d%3A/dev/2026/1112/chem-vision", "D:\\dev\\2026\\1112\\chem-vision", "win32")).toBe(true);
    expect(sameAgyFolder("file:///d%3A/dev/2026/1112/chem-vision", "D:\\dev\\2026\\0123\\favorite_chat\\easywork-copilot", "win32")).toBe(false);
    expect(sameAgyFolder("file:///Users/me/dev/memento", "/Users/me/dev/memento/", "darwin")).toBe(true);
    expect(sameAgyFolder("file:///Users/me/dev/Memento", "/Users/me/dev/memento", "darwin")).toBe(false);
  });
});

describe("projectForFolder", () => {
  let dir: string;
  let calls: Array<{ method: string; body: Record<string, unknown> }>;
  const projects: Record<string, unknown>[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agyproj-"));
    calls = [];
    projects.length = 0;
    process.env.ANTIGRAVITY_LS_ADDRESS = "127.0.0.1:1";
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      const method = String(url).split("/").pop() ?? "";
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ method, body });
      let reply: unknown = {};
      if (method === "ListProjects") reply = { projectIds: [...projects.map((p) => p.id), "outside-of-project"] };
      if (method === "ReadProjects") reply = { projects };
      if (method === "CreateProject") projects.push(body.project as Record<string, unknown>);
      if (method === "ReadProject") reply = { project: projects.find((p) => p.id === body.id) };
      return new Response(JSON.stringify(reply), { status: 200 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes the project whose resources name the folder, not the one made last", async () => {
    projects.push(
      { id: "easy", name: "easywork-copilot", projectResources: { resources: [{ gitFolder: { folderUri: agyFolderUri(dir) } }] } },
      { id: "chem", name: "chem-vision", projectResources: { resources: [{ gitFolder: { folderUri: "file:///elsewhere/chem-vision" } }] } },
    );
    expect(await projectForFolder(dir)).toBe("easy");
    expect(calls.some((c) => c.method === "CreateProject")).toBe(false);
  });

  it("makes a project for a folder no project names, with its own id and a free name", async () => {
    const base = dir.split(/[\\/]/).pop() ?? "";
    projects.push({ id: "other", name: base, projectResources: { resources: [{ gitFolder: { folderUri: "file:///x" } }] } });
    const id = await projectForFolder(dir);
    const create = calls.find((c) => c.method === "CreateProject")?.body.project as Record<string, unknown>;
    expect(id).toBe(create.id);
    expect(create.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(create.name).not.toBe(base);
    expect(create.projectResources).toEqual({ resources: [{ gitFolder: { folderUri: agyFolderUri(dir) } }] });
  });

  it("leaves the home folder alone", async () => {
    const { homedir } = await import("node:os");
    expect(await projectForFolder(homedir())).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("timerSeconds", () => {
  it("reads how long a schedule timer waits from its task description", () => {
    expect(timerSeconds("Created At: x\nTool is running as a background task with task id: c/task-87\nTask Description: Timer: 4m, Prompt: 再次检查")).toBe(240);
    expect(timerSeconds("Task Description: Timer: 1h30m, Prompt: x")).toBe(5400);
    expect(timerSeconds("Task Description: Timer: 45s, Prompt: x")).toBe(45);
    expect(timerSeconds("Task Description: kubectl rollout status deployment/copilot")).toBeUndefined();
  });
});
