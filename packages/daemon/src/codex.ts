import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { homeDir, mementoDir } from "./config.js";

const runnerAsset = () => process.env.MEMENTO_CODEX_RUNNER || fileURLToPath(new URL("../assets/codex_app.mjs", import.meta.url));

/**
 * memento's Codex runner (assets/codex_app.mjs), copied to `~/.memento/runners` where a child process
 * can run it (the asset itself may sit inside the desktop app's archive). Rewritten when it changes.
 */
export async function codexRunner(home = homeDir()): Promise<string> {
  const target = join(mementoDir(home), "runners", "codex_app.mjs");
  const source = await readFile(runnerAsset(), "utf8");
  if ((await readFile(target, "utf8").catch(() => "")) !== source) {
    await mkdir(join(mementoDir(home), "runners"), { recursive: true });
    await writeFile(target, source);
  }
  return target;
}
