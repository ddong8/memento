import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  CLAUDE_MODELS,
  claudeModelLimit,
  codexModelLimit,
  codexModels,
  isModelLimited,
  limitedModels,
  modelFamily,
  nextModel,
  noteDefaultModel,
  noteModelLimit,
  resetModelLimits,
  UNSUPPORTED_MS,
} from "../src/model-limits.js";
import { WsTaskClient } from "../src/ws-client.js";

afterEach(() => {
  resetModelLimits();
  delete process.env.MEMENTO_MODEL_LIMITS_FILE;
});

const NOW = Date.parse("2026-11-12T08:00:00Z");

it("Claude: a limit of one model is named, the account's own limits aren't", () => {
  expect(claudeModelLimit("You've hit your Opus limit · resets Nov 14, 9am", "")).toEqual({ model: "opus", message: "You've hit your Opus limit · resets Nov 14, 9am", until: undefined });
  expect(claudeModelLimit("", "", { type: "seven_day_sonnet", resetsAt: NOW / 1000 })).toEqual({ model: "sonnet", message: "You've hit your sonnet limit", until: NOW });
  expect(claudeModelLimit("You’ve hit your team’s shared budget for Opus. Switch to another model to continue.", "opus")?.model).toBe("opus");
  expect(claudeModelLimit("You've hit your session limit · resets 11:40am", "opus")).toBeUndefined();
  expect(claudeModelLimit("You've hit your weekly limit · resets Nov 14", "opus", { type: "seven_day" })).toBeUndefined();
});

it("Codex: the limit's name is matched to a model, else the one the run used", () => {
  const models = [
    { id: "gpt-6-luna", label: "GPT-6-Luna" },
    { id: "gpt-6", label: "GPT-6" },
  ];
  expect(codexModelLimit("You've hit your usage limit for GPT-6-Luna. Switch to another model now, or try again at 3:05 PM.", "", models)?.model).toBe("gpt-6-luna");
  expect(codexModelLimit("You've hit your usage limit for Luna Max. Switch to another model now.", "gpt-6", models)?.model).toBe("gpt-6");
  expect(codexModelLimit("You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM.", "gpt-6", models)).toBeUndefined();
});

it("Codex: a model the account can't use is skipped for a day, like one that ran out", () => {
  const msg = "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.";
  const hit = codexModelLimit(msg, "", [{ id: "gpt-6-luna", label: "GPT-6-Luna" }], NOW);
  expect(hit).toEqual({ model: "gpt-6-astra", message: msg, until: NOW + UNSUPPORTED_MS, unsupported: true });
  noteDefaultModel("codex", "gpt-6-astra");
  noteModelLimit("codex", hit!.model, hit!.message, hit!.until, NOW);
  expect(isModelLimited("codex", "", NOW + 3_600_000)).toBe(true);
  expect(nextModel("codex", [{ id: "gpt-6-astra", label: "x" }, { id: "gpt-6-luna", label: "GPT-6-Luna" }], "", "", NOW)?.id).toBe("gpt-6-luna");
});

it("next model: skips the family that ran out and ones still out, never Fable for Claude", () => {
  expect(modelFamily("claude", "claude-opus-5-5")).toBe("opus");
  expect(nextModel("claude", CLAUDE_MODELS, "claude-opus-5-5", "", NOW)?.id).toBe("sonnet");
  noteModelLimit("claude", "sonnet", "You've hit your Sonnet limit", undefined, NOW);
  expect(nextModel("claude", CLAUDE_MODELS, "opus", "", NOW)?.id).toBe("haiku");
  // The default model counts as the one that ran out when the task named none
  noteDefaultModel("codex", "gpt-6");
  const codex = [
    { id: "gpt-6", label: "GPT-6" },
    { id: "gpt-6-luna", label: "GPT-6-Luna" },
  ];
  expect(nextModel("codex", codex, "", "", NOW)?.id).toBe("gpt-6-luna");
  noteModelLimit("codex", "", "You've hit your usage limit for GPT-6", undefined, NOW);
  expect(isModelLimited("codex", "", NOW)).toBe(true);
  expect(isModelLimited("codex", "gpt-6-luna", NOW)).toBe(false);
});

it("limits are kept on disk, reported with their reset, and dropped once over", () => {
  const dir = mkdtempSync(join(tmpdir(), "limits_"));
  process.env.MEMENTO_MODEL_LIMITS_FILE = join(dir, "model-limits.json");
  const now = Date.now();
  noteModelLimit("claude", "claude-opus-5-5", "You've hit your Opus limit", now + 7_200_000, now);
  resetModelLimits(); // as after a restart
  expect(isModelLimited("claude", "opus", now)).toBe(true);
  expect(limitedModels("claude", now)).toEqual([{ family: "opus", model: "claude-opus-5-5", until: new Date(now + 7_200_000).toISOString(), message: "You've hit your Opus limit" }]);
  expect(limitedModels("codex", now)).toEqual([]);
  expect(isModelLimited("claude", "opus", now + 7_200_001)).toBe(false);
  resetModelLimits();
  expect(isModelLimited("claude", "opus", now)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

it("Codex models come from its cache in its own order, hidden ones left out", async () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome_"));
  execFileSync("mkdir", ["-p", join(home, ".codex")]);
  writeFileSync(
    join(home, ".codex", "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "gpt-6-luna", display_name: "GPT-6-Luna", priority: 2, visibility: "list" },
        { slug: "gpt-6", display_name: "GPT-6", priority: 1, visibility: "list" },
        { slug: "old", display_name: "Old", priority: 0, visibility: "hide" },
      ],
    }),
  );
  const saved = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  expect(await codexModels(home)).toEqual([
    { id: "gpt-6", label: "GPT-6" },
    { id: "gpt-6-luna", label: "GPT-6-Luna" },
  ]);
  if (saved !== undefined) process.env.CODEX_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
  "Claude task whose Opus limit ran out goes on with Sonnet, and the next task skips Opus",
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "opus_limit_"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "home");
    execFileSync("mkdir", ["-p", bin, home]);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const sid = "6f3d1184-787b-4878-a8f5-2f5ade4fb741";
    const limit = "You've hit your Opus limit · resets Nov 14, 9am (Asia/Shanghai)";
    const limited = [
      { type: "system", subtype: "init", session_id: sid, model: "claude-opus-5-5" },
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day_opus", resetsAt: Math.floor(Date.now() / 1000) + 3600 } },
      { type: "assistant", error: "rate_limit", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: limit }] }, session_id: sid },
      { type: "result", subtype: "success", is_error: true, result: limit, session_id: sid },
    ];
    const ok = [
      { type: "system", subtype: "init", session_id: sid, model: "claude-sonnet-5-5" },
      { type: "assistant", message: { role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "好了" }] }, session_id: sid },
      { type: "result", subtype: "success", is_error: false, result: "好了", session_id: sid },
    ];
    writeFileSync(join(tmp, "limited.jsonl"), limited.map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFileSync(join(tmp, "ok.jsonl"), ok.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const argsLog = join(tmp, "args.log");
    const fake = join(bin, "claude-opus-memento");
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$*" >> "${argsLog}"\nIFS= read -r first\ncase " $* " in\n  *" --model sonnet "*) cat "${tmp}/ok.jsonl"; cat > /dev/null; exit 0 ;;\n  *) cat "${tmp}/limited.jsonl"; cat > /dev/null; exit 1 ;;\nesac\n`,
    );
    chmodSync(fake, 0o755);
    process.env.HOME = home;

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const seen: string[] = [];
    const waiters = new Map<string, (m: Record<string, unknown>) => void>();
    const finished = (id: string) => new Promise<Record<string, unknown>>((r) => waiters.set(id, r));
    let socket: import("ws").WebSocket | undefined;
    const ready = new Promise<void>((r) =>
      wss.on("connection", (ws) => {
        socket = ws;
        ws.send(JSON.stringify({ type: "connected", device_name: "test" }));
        ws.on("message", (raw) => {
          seen.push(raw.toString());
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (msg.type === "task_finished") waiters.get(String(msg.task_id))?.(msg);
        });
        r();
      }),
    );
    await new Promise((r) => wss.once("listening", r));
    const port = (wss.address() as { port: number }).port;
    const client = new WsTaskClient({ serverUrl: `http://127.0.0.1:${port}`, token: "t", deviceId: "dev", deviceName: "test", platform: "test", extraWatchDirs: [] });
    void client.start();
    await ready;
    const dispatch = (id: string) =>
      socket!.send(JSON.stringify({ type: "task_dispatch", task: { id, action: "agent", timeout_seconds: 60, payload: { binary: "claude-opus-memento", prompt: "改一下", cwd: tmp } } }));

    const first = "feedbeef-0000-4000-8000-000000000011";
    let done = finished(first);
    dispatch(first);
    expect(await done).toMatchObject({ status: "succeeded", stdout: "好了" });
    const runs = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(runs).toHaveLength(2);
    expect(runs[0]).not.toContain("--model");
    expect(runs[1]).toContain("--model sonnet");
    expect(seen.join("\n")).toContain("模型切换");
    expect(seen.some((s) => s.includes('"agent_quotas"'))).toBe(true);

    // Opus is still out: the next task starts on Sonnet right away
    const second = "feedbeef-0000-4000-8000-000000000012";
    done = finished(second);
    dispatch(second);
    expect(await done).toMatchObject({ status: "succeeded" });
    const after = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(after).toHaveLength(3);
    expect(after[2]).toContain("--model sonnet");

    client.dispose();
    await new Promise((r) => wss.close(r));
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  },
  60_000,
);
