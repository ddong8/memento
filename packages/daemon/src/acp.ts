// Starting ACP agents (OpenCode, Gemini CLI, Cursor, Kiro, Copilot CLI) through memento's generic runner
// (src/acp-runner, shipped as assets/acp_runner.mjs and copied to ~/.memento/runners like the other runners).
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AcpAgent, PermissionMode } from "./acp-runner/protocol.js";
import { homeDir, mementoDir } from "./config.js";

const runnerAsset = () => process.env.MEMENTO_ACP_RUNNER || fileURLToPath(new URL("../assets/acp_runner.mjs", import.meta.url));

/** The runner script on disk (a copy outside the app bundle, so it runs the same from any install). */
export async function acpRunnerScript(home = homeDir()): Promise<string> {
  const target = join(mementoDir(home), "runners", "acp_runner.mjs");
  const source = await readFile(runnerAsset(), "utf8");
  if ((await readFile(target, "utf8").catch(() => "")) !== source) {
    await mkdir(join(mementoDir(home), "runners"), { recursive: true });
    // A task starting meanwhile must not run half a file
    await writeFile(`${target}.tmp`, source, "utf8");
    if (process.platform !== "win32") await chmod(`${target}.tmp`, 0o755);
    await rename(`${target}.tmp`, target);
  }
  return target;
}

export function acpRunnerArgs(o: {
  runner: string;
  agent: AcpAgent;
  agentExe: string;
  workDir?: string;
  sessionId?: string;
  permissionMode: PermissionMode;
  prompt: string;
}): string[] {
  return [
    o.runner,
    "--cmd",
    o.agentExe,
    ...o.agent.args.flatMap((a) => ["--arg", a]),
    ...(o.workDir ? ["-C", o.workDir] : []),
    ...(o.sessionId ? ["--session", o.sessionId] : []),
    "--permission",
    o.permissionMode,
    "--label",
    o.agent.label,
    "--",
    o.prompt,
  ];
}
