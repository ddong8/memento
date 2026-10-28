import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { antigravityExecutable, ensureAgyCliInstalled } from "../src/antigravity.js";
import { findExecutable, prepareCommand } from "../src/exec-env.js";

const agyCliPath = fileURLToPath(new URL("../assets/agy_cli.py", import.meta.url));

describe("Antigravity runner", () => {
  let home: string;
  const bundled = process.env.MEMENTO_AGY_RUNNER;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agy-home-"));
    delete process.env.MEMENTO_AGY_RUNNER; // set when the tests run under the desktop app's daemon
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (bundled !== undefined) process.env.MEMENTO_AGY_RUNNER = bundled;
  });

  it("runs memento's runner, not whichever agy comes first on PATH", async () => {
    const script = join(home, ".gemini", "antigravity", "bin", "agy_cli.py");
    expect(await antigravityExecutable(home)).toBe(script);
    expect(readFileSync(script, "utf8")).toBe(readFileSync(agyCliPath, "utf8"));
  });

  it("replaces an installed runner that differs from the shipped one", async () => {
    const dir = join(home, ".gemini", "antigravity", "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agy_cli.py"), "# older runner\n");
    expect(await ensureAgyCliInstalled(home)).toBe(join(dir, "agy_cli.py"));
    expect(readFileSync(join(dir, "agy_cli.py"), "utf8")).toBe(readFileSync(agyCliPath, "utf8"));
    expect(existsSync(join(dir, "agy_cli.py.tmp"))).toBe(false);
  });

  it("runs a .py runner with Python on every OS", async () => {
    expect(await prepareCommand("/home/u/.gemini/antigravity/bin/agy_cli.py", ["-p", "hi"], { isWindows: false, python: "/usr/bin/python3" })).toEqual({
      executable: "/usr/bin/python3",
      args: ["/home/u/.gemini/antigravity/bin/agy_cli.py", "-p", "hi"],
    });
  });

  it("lets a lookup pass over placeholders such as the Microsoft Store's python.exe", async () => {
    writeFileSync(join(home, "tool"), "");
    const env = { PATH: home };
    expect(await findExecutable(["tool"], env)).toBe(join(home, "tool"));
    expect(await findExecutable(["tool"], env, (f) => f.startsWith(home))).toBeUndefined();
  });

  it("calls the language server's agentapi directly, keeping multi-line prompts whole", () => {
    const script = `
import json, os, sys, tempfile
from pathlib import Path
tmp = tempfile.mkdtemp()
os.environ["HOME"] = os.environ["USERPROFILE"] = tmp
os.environ.pop("LOCALAPPDATA", None)
os.environ.pop("ANTIGRAVITY_LS_BINARY", None)
sys.path.insert(0, sys.argv[1])
import agy_cli
real_is_file = Path.is_file
Path.is_file = lambda self: str(self).startswith(tmp) and real_is_file(self)

assert agy_cli._agentapi_command() is None
ls = Path(tmp) / "Antigravity" / "language_server.exe"
ls.parent.mkdir()
ls.write_text("")
os.environ["ANTIGRAVITY_LS_BINARY"] = str(ls)
assert agy_cli._agentapi_command() == [str(ls), "agentapi"]
del os.environ["ANTIGRAVITY_LS_BINARY"]

bin_dir = Path(tmp) / ".gemini" / "antigravity" / "bin"
bin_dir.mkdir(parents=True)
(bin_dir / "agentapi.cmd").write_text('@echo off\\r\\n"%s" agentapi %%*\\r\\n' % ls, encoding="utf-8")
assert agy_cli._agentapi_command() == [str(ls), "agentapi"]
(bin_dir / "agentapi.cmd").unlink()
if sys.platform != "win32":
    wrapper = bin_dir / "agentapi"
    wrapper.write_text("#!/bin/sh\\n")
    wrapper.chmod(0o755)
    assert agy_cli._agentapi_command() == [str(wrapper)]

fake = Path(tmp) / "fake_ls.py"
fake.write_text("import json, sys\\nprint(json.dumps(sys.argv[1:]))\\n")
prompt = '第一行\\n第二行 & | < > ^ %PATH% "quoted"'
res = agy_cli._run_agentapi([sys.executable, str(fake), "agentapi"], "send-message", "cid", prompt)
assert json.loads(res.stdout) == ["agentapi", "send-message", "cid", prompt], res.stdout
print("AGENTAPI_OK")
`;
    const out = execFileSync("python3", ["-c", script, join(agyCliPath, "..")], { encoding: "utf8" });
    expect(out.trim()).toBe("AGENTAPI_OK");
  });

  it("continues (-c) the app's latest top-level conversation", () => {
    const script = `
import sqlite3, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import agy_cli
db = Path(tempfile.mkdtemp()) / "conversation_summaries.db"
assert agy_cli._latest_conversation_id(db) == ""
conn = sqlite3.connect(db)
conn.execute("CREATE TABLE conversation_summaries (conversation_id text, last_modified_time datetime NOT NULL, parent_conversation_id text NOT NULL DEFAULT '', killed numeric NOT NULL DEFAULT false)")
conn.executemany("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)", [
    ("older", "2026-10-25 14:06:18+00:00", "", 0),
    ("latest", "2026-10-28 05:44:36+00:00", "", 0),
    ("subagent", "2026-10-28 06:00:00+00:00", "latest", 0),
    ("killed", "2026-10-28 07:00:00+00:00", "", 1),
])
conn.commit()
conn.close()
assert agy_cli._latest_conversation_id(db) == "latest", agy_cli._latest_conversation_id(db)
print("LATEST_OK")
`;
    const out = execFileSync("python3", ["-c", script, join(agyCliPath, "..")], { encoding: "utf8" });
    expect(out.trim()).toBe("LATEST_OK");
  });
});
