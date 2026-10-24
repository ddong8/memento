import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CollectorConfig } from "../src/config.js";
import type { IngestClient } from "../src/ingest.js";
import { FileWatcher, isAgentInternalPath } from "../src/watcher.js";

const homes: string[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "session-project-"));
  homes.push(home);
  const sent: { relativePath: string; offset: number; metadata: Record<string, unknown> }[] = [];
  const ingest = {
    ingestDocument: async (doc: (typeof sent)[number]) => {
      sent.push(doc);
      return true;
    },
  } as unknown as IngestClient;
  const config = { extraWatchDirs: [] } as unknown as CollectorConfig;
  return { home, sent, watcher: new FileWatcher(config, ingest, () => {}, home) };
}

const line = (cwd: string, text: string) => JSON.stringify({ type: "user", cwd, message: { content: text } });

describe("the project a session log is filed under", () => {
  it("stays the folder the session started in when the agent changes directory", async () => {
    const { home, sent, watcher } = await setup();
    const root = join(home, "dev", "my-app");
    const dir = join(home, ".claude", "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(dir, { recursive: true });
    const file = join(dir, "sess-1.jsonl");
    await writeFile(file, `${line(root, "看看项目")}\n`);
    await watcher.syncFile(file, "claude_code");
    // Later turns run after `cd server`: every line from here on says so
    await appendFile(file, `${line(join(root, "server"), "跑测试")}\n${line(join(root, "server"), "改代码")}\n`);
    await watcher.syncFile(file, "claude_code");

    expect(sent).toHaveLength(2);
    expect(sent[1]!.offset).toBeGreaterThan(0);
    for (const doc of sent) {
      expect(doc.metadata).toMatchObject({ project_path: root, project_hash: "my-app", session_id: "sess-1" });
    }
  });

  it("takes an Antigravity workspace, never a file the agent wrote", async () => {
    const { home, sent, watcher } = await setup();
    const sid = "e8acd96e-e64f-4dac-8546-6a35e2f7e3da";
    const brain = join(home, ".gemini", "antigravity", "brain", sid);
    await mkdir(brain, { recursive: true });
    await mkdir(join(home, ".gemini", "antigravity", "conversations"), { recursive: true });
    const internal = `file://${join(brain, ".system_generated", "steps", "2", "output.txt")}`;
    const workspace = join(home, "work", "video-tool");
    await writeFile(join(home, ".gemini", "antigravity", "conversations", `${sid}.db`), `\x00${internal}\x00file://${workspace}\x00`);
    const file = join(brain, "transcript.jsonl");
    await writeFile(file, `${JSON.stringify({ type: "user", content: "做个视频" })}\n`);
    await watcher.syncFile(file, "antigravity");
    expect(sent[0]!.metadata).toMatchObject({ project_path: workspace, project_hash: "video-tool" });

    // Only its own files mentioned: no project rather than "output.txt"
    await writeFile(join(home, ".gemini", "antigravity", "conversations", `${sid}.db`), `\x00${internal}\x00`);
    await appendFile(file, `${JSON.stringify({ type: "assistant", content: "好了" })}\n`);
    await watcher.syncFile(file, "antigravity");
    expect(sent[1]!.metadata.project_hash).toBeUndefined();
  });

  it("cuts a workspace quoted inside a JSON string where the string's line ends", async () => {
    const { home, sent, watcher } = await setup();
    const sid = "0b9b1a7e-1111-4222-8333-944455556666";
    const brain = join(home, ".gemini", "antigravity", "brain", sid);
    await mkdir(brain, { recursive: true });
    const file = join(brain, "transcript.jsonl");
    const ws = "/Users/donghaixing/Desktop/dev/memento";
    // As seen in production: the path ran on into ",\n "repository": {...
    await writeFile(file, `${JSON.stringify({ content: `Active Workspaces:\n- ${ws}",\n            "repository": {` })}\n`);
    await watcher.syncFile(file, "antigravity");
    expect(sent[0]!.metadata).toMatchObject({ project_path: ws, project_hash: "memento" });
  });

  it("knows the agents' own folders", () => {
    expect(isAgentInternalPath("/Users/me/.gemini/antigravity/brain/x/.system_generated/steps/2/output.txt")).toBe(true);
    expect(isAgentInternalPath("C:\\Users\\Admin\\.gemini\\antigravity\\brain\\x")).toBe(true);
    expect(isAgentInternalPath("/Users/me/dev/memento")).toBe(false);
  });
});
