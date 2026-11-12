// memento's Codex runner against a stand-in `codex app-server`: follow-ups typed before the turn started
// wait for it, and one Codex refuses is reported back as late, so the page sends it as the next message.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const runner = fileURLToPath(new URL("../assets/codex_app.mjs", import.meta.url));

it.skipIf(process.platform === "win32")("Codex runner: early follow-ups go into the turn once it starts, a refused one comes back late", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memento-codex-steer-"));
  const log = join(dir, "steers.jsonl");
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
let steers = 0;
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method === "initialize") send({ id: m.id, result: {} });
    else if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "th1" } } });
    // Slow to start, so both follow-ups arrive before there is a turn to steer
    else if (m.method === "turn/start") setTimeout(() => send({ id: m.id, result: { turn: { id: "tu1" } } }), 400);
    else if (m.method === "turn/steer") {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(m.params) + "\\n");
      if (++steers === 1) send({ id: m.id, result: {} });
      else {
        send({ id: m.id, error: { code: -32600, message: "turn already ending" } });
        setTimeout(() => send({ method: "turn/completed", params: { threadId: "th1", turn: { id: "tu1", status: "completed" } } }), 100);
      }
    }
  }
});
`,
  );
  chmodSync(bin, 0o755);

  const proc = spawn(process.execPath, [runner, "--codex", bin, "--", "改一下"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  proc.stdout.on("data", (c) => (stdout += c));
  proc.stdin.write("先看 README\n");
  proc.stdin.write("再跑测试\n");
  const code = await new Promise<number | null>((r) => proc.on("exit", r));

  const steers = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(steers.map((s) => [s.input[0].text, s.threadId, s.expectedTurnId])).toEqual([
    ["先看 README", "th1", "tu1"],
    ["再跑测试", "th1", "tu1"],
  ]);
  const lines = stdout.trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.filter((l) => l.type === "memento_event").map((l) => l.event)).toEqual([{ kind: "steer", text: "再跑测试", status: "late" }]);
  expect(lines.some((l) => l.type === "turn.completed")).toBe(true);
  expect(code).toBe(0);
  rmSync(dir, { recursive: true, force: true });
}, 20_000);
