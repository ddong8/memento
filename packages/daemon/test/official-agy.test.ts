import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import { officialAgyCli } from "../src/antigravity.js";

const dir = mkdtempSync(join(tmpdir(), "official-agy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const exe = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
};

it.skipIf(process.platform === "win32")("finds Google's agy in ~/.local/bin even off PATH, passing over the agy memento wrote", async () => {
  const home = join(dir, "home");
  const ours = join(dir, "bin", "agy");
  exe(ours, "#!/bin/sh\n# memento's Antigravity runner\nexec node '/x/agy_cli.mjs' \"$@\"\n");
  const linked = join(dir, "linked");
  mkdirSync(linked, { recursive: true });
  symlinkSync(ours, join(linked, "agy"));
  const env = { PATH: [join(dir, "bin"), linked].join(":") };
  expect(await officialAgyCli(home, env)).toBeUndefined();
  const google = join(home, ".local", "bin", "agy");
  exe(google, "\x7fELF google agy");
  expect(await officialAgyCli(home, env)).toBe(google);
});
