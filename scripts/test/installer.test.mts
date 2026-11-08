// The installer's pure pieces and its file edits, against temp dirs only (never the real home).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { UsageError, parseArgs } from "../install.mts";
import { blueprintScriptVersion, removeInjected, removeMcpEntry, withoutCodexMcp, withoutStopHook, writeDeviceConfig } from "../install/collector.mts";
import { ensureEnv, parseEnv, renderEnv, setEnvValue } from "../install/env-file.mts";
import { render } from "../install/embedding-host.mts";
import { validEmail } from "../install/first-user.mts";
import { IS_WINDOWS, REPO_ROOT } from "../install/platform.mts";

const tmp = mkdtempSync(join(tmpdir(), "memento-installer-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const d = join(tmp, `case-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
};
const read = (path: string) => readFileSync(path, "utf8");

describe("parseArgs", () => {
  test("no command is install with the same arguments", () => {
    assert.deepEqual(parseArgs([]), { help: false, command: "install", flags: new Set() });
    assert.deepEqual(parseArgs(["--non-interactive"]), { help: false, command: "install", flags: new Set(["non-interactive"]) });
  });

  test("commands and their flags, aliases folded", () => {
    assert.deepEqual(parseArgs(["embedding", "--native"]), { help: false, command: "embedding", flags: new Set(["native"]) });
    assert.deepEqual(parseArgs(["uninstall", "--all", "-y"]), { help: false, command: "uninstall", flags: new Set(["all", "yes"]) });
    assert.deepEqual(parseArgs(["uninstall", "--yes", "--purge"]), { help: false, command: "uninstall", flags: new Set(["yes", "purge"]) });
    assert.deepEqual(parseArgs(["doctor"]), { help: false, command: "doctor", flags: new Set() });
  });

  test("help anywhere", () => {
    assert.deepEqual(parseArgs(["-h"]), { help: true });
    assert.deepEqual(parseArgs(["uninstall", "--help"]), { help: true });
  });

  test("an unknown command, including Object.prototype names", () => {
    for (const cmd of ["frobnicate", "constructor", "toString"]) {
      assert.throws(() => parseArgs([cmd]), (e: unknown) => e instanceof UsageError && e.message.startsWith(`argument command: invalid choice: '${cmd}'`));
    }
  });

  test("a flag of another command", () => {
    assert.throws(() => parseArgs(["doctor", "--native"]), (e: unknown) => e instanceof UsageError && e.message === "unrecognized arguments: --native");
    assert.throws(() => parseArgs(["--purge"]), (e: unknown) => e instanceof UsageError && e.message === "unrecognized arguments: --purge");
  });
});

describe(".env", () => {
  test("parseEnv: comments, blank lines, CRLF, values with =", () => {
    const p = join(freshDir(), ".env");
    write(p, "# comment\r\nA=1\r\n\r\n  B = two words \r\nC=x=y\r\nnot a pair\r\n");
    assert.deepEqual(parseEnv(p), { A: "1", B: "two words", C: "x=y" });
    assert.deepEqual(parseEnv(join(tmp, "missing.env")), {});
  });

  test("renderEnv: known keys in place, unset optional ones commented, the rest kept", () => {
    const text = renderEnv({ POSTGRES_PASSWORD: "pw", MEMENTO_AI_MODEL: "m", PIP_INDEX_URL: "https://pypi.example/simple" });
    assert.match(text, /^POSTGRES_PASSWORD=pw$/m);
    assert.match(text, /^MEMENTO_SECRET_KEY=$/m);
    assert.match(text, /^MEMENTO_AI_MODEL=m$/m);
    assert.match(text, /^# ANTHROPIC_API_KEY=$/m);
    assert.match(text, /^# MEMENTO_EMBEDDING_SERVER_URL=http:\/\/embedding:8002$/m);
    assert.match(text, /# ── other settings \(kept from your \.env\) ──\nPIP_INDEX_URL=https:\/\/pypi\.example\/simple\n$/);
  });

  test("ensureEnv generates the missing secrets once and keeps everything else", async () => {
    const p = join(freshDir(), ".env");
    write(p, "POSTGRES_PASSWORD=keep-me\nMEMENTO_CORS_ALLOW_ORIGIN_REGEX=.*\n");
    const first = await ensureEnv({ interactive: false, path: p });
    assert.equal(first.POSTGRES_PASSWORD, "keep-me");
    assert.equal(first.MEMENTO_CORS_ALLOW_ORIGIN_REGEX, ".*");
    assert.match(first.MEMENTO_SECRET_KEY!, /^[\w-]{64}$/);
    assert.match(first.MEMENTO_COLLECTOR_TOKEN!, /^[0-9a-f]{64}$/);
    assert.match(first.MINIO_ROOT_USER!, /^memento_[0-9a-f]{8}$/);
    assert.match(first.MINIO_ROOT_PASSWORD!, /^[\w-]{32}$/);
    const second = await ensureEnv({ interactive: false, path: p });
    assert.deepEqual(second, first);
    assert.deepEqual(parseEnv(p), first);
    if (!IS_WINDOWS) assert.equal(statSync(p).mode & 0o777, 0o600);
  });

  test("setEnvValue changes one key, creating .env when missing", async () => {
    const p = join(freshDir(), ".env");
    await setEnvValue("MEMENTO_EMBEDDING_SERVER_URL", "http://embedding:8002", p);
    const before = parseEnv(p);
    assert.equal(before.MEMENTO_EMBEDDING_SERVER_URL, "http://embedding:8002");
    await setEnvValue("MEMENTO_EMBEDDING_SERVER_URL", "http://host.docker.internal:8002", p);
    assert.deepEqual(parseEnv(p), { ...before, MEMENTO_EMBEDDING_SERVER_URL: "http://host.docker.internal:8002" });
    // the temp file it renames over .env is gone
    assert.deepEqual(readdirSync(dirname(p)), [".env"]);
  });
});

describe("small helpers", () => {
  test("validEmail", () => {
    assert.ok(validEmail("a@b.co"));
    assert.ok(!validEmail("a@b"));
    assert.ok(!validEmail("a b@c.d"));
  });

  test("render fills {name} placeholders and refuses a missing one", () => {
    assert.equal(render("<string>{python}</string> {port}", { python: "/v/bin/python", port: "8002" }), "<string>/v/bin/python</string> 8002");
    assert.throws(() => render("{python} {missing}", { python: "p" }), /missing/);
  });

  test("blueprintScriptVersion", () => {
    const d = freshDir();
    write(join(d, "a.mjs"), "#!/usr/bin/env node\nexport const BLUEPRINT_SCRIPT_VERSION = 12;\n");
    write(join(d, "b.py"), "BLUEPRINT_SCRIPT_VERSION = 3\n");
    write(join(d, "c.mjs"), "console.log(1)\n");
    assert.equal(blueprintScriptVersion(join(d, "a.mjs")), 12);
    assert.equal(blueprintScriptVersion(join(d, "b.py")), 3);
    assert.equal(blueprintScriptVersion(join(d, "c.mjs")), 0);
    assert.equal(blueprintScriptVersion(join(d, "missing.mjs")), -1);
    assert.ok(blueprintScriptVersion(join(REPO_ROOT, "scripts", "project_blueprint.mjs")) > 0);
  });
});

describe("collector config and uninstall edits", () => {
  test("writeDeviceConfig merges into collector.json, owner-only", () => {
    const home = freshDir();
    const path = join(home, ".memento", "collector.json");
    write(path, JSON.stringify({ device_id: "dev-1", token: "old", server_url: "http://old" }));
    assert.equal(writeDeviceConfig("new", "http://localhost:8001", "http://localhost:3001", home), path);
    assert.deepEqual(JSON.parse(read(path)), { device_id: "dev-1", token: "new", server_url: "http://localhost:8001", web_url: "http://localhost:3001" });
    if (!IS_WINDOWS) assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test("removeMcpEntry drops both Memento keys and nothing else", () => {
    const p = join(freshDir(), "mcp.json");
    write(p, JSON.stringify({ mcpServers: { "memento-memory": {}, "daily-report-memory": {}, other: { command: "x" } }, theme: "dark" }));
    removeMcpEntry(p);
    assert.deepEqual(JSON.parse(read(p)), { mcpServers: { other: { command: "x" } }, theme: "dark" });
    const untouched = join(dirname(p), "plain.json");
    write(untouched, '{"mcpServers": {"other": {}}}');
    removeMcpEntry(untouched);
    assert.equal(read(untouched), '{"mcpServers": {"other": {}}}');
  });

  test("withoutCodexMcp removes the section up to the next blank line or section", () => {
    const toml = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.memento-memory]",
      'command = "node"',
      'args = ["mcp.mjs"]',
      "[mcp_servers.other]",
      'command = "x"',
      "",
      "[mcp_servers.memento-memory.env]",
      'A = "1"',
      "",
      "[profiles.fast]",
      'model = "m"',
      "",
    ].join("\n");
    assert.equal(
      withoutCodexMcp(toml, "memento-memory"),
      ['model = "gpt-5"', "", "[mcp_servers.other]", 'command = "x"', "", "[mcp_servers.memento-memory.env]", 'A = "1"', "", "[profiles.fast]", 'model = "m"', ""].join("\n"),
    );
    assert.equal(withoutCodexMcp("[mcp_servers.memento-memory]\ncommand = \"node\"", "memento-memory"), "");
    assert.equal(withoutCodexMcp(toml, "absent"), toml);
  });

  test("withoutStopHook keeps other hooks and groups", () => {
    const script = "/h/.memento/hooks/stop-check.sh";
    const ours = { type: "command", command: `bash ${script}` };
    const theirs = { type: "command", command: "say done" };
    const settings = {
      model: "opus",
      hooks: { Stop: [{ hooks: [ours, theirs] }, { matcher: "x", hooks: [ours] }, { hooks: [theirs] }], PreToolUse: [{ hooks: [theirs] }] },
    };
    assert.deepEqual(withoutStopHook(settings, script), {
      model: "opus",
      hooks: { PreToolUse: [{ hooks: [theirs] }], Stop: [{ hooks: [theirs] }, { hooks: [theirs] }] },
    });
    assert.deepEqual(withoutStopHook({ model: "opus", hooks: { Stop: [{ hooks: [ours] }] } }, script), { model: "opus" });
    assert.equal(withoutStopHook({ hooks: { Stop: [{ hooks: [theirs] }] } }, script), undefined);
    assert.equal(withoutStopHook({}, script), undefined);
  });
});

describe("removeInjected (temp home)", () => {
  const home = join(tmp, "home");
  const saved: Record<string, string | undefined> = {};
  before(() => {
    // Every location removeInjected reads from the environment points into the temp home
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "APPDATA"]) saved[key] = process.env[key];
    process.env.CODEX_HOME = join(home, ".codex");
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    process.env.APPDATA = join(home, "AppData", "Roaming");
  });
  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("takes back exactly what is Memento's", () => {
    const mem = join(home, ".memento");
    // profile blocks: one inside the user's text, one in a file Memento created, one damaged
    const claudeMd = join(home, ".claude", "CLAUDE.md");
    write(claudeMd, "# mine\n\n<!-- memento:begin v3 -->\nprofile\n<!-- memento:end -->\n");
    write(`${claudeMd}.memento.bak`, "# mine\n");
    const agentsMd = join(home, ".codex", "AGENTS.md");
    write(agentsMd, "<!-- memento:begin -->\nprofile\n<!-- memento:end -->\n");
    const geminiMd = join(home, ".gemini", "GEMINI.md");
    const damaged = "<!-- memento:begin -->\na\n<!-- memento:begin -->\nb\n<!-- memento:end -->\n";
    write(geminiMd, damaged);
    write(join(mem, "profile_inject.json"), JSON.stringify({ codex: { created: true } }));

    // Stop hooks
    const script = join(mem, "hooks", "stop-check.sh");
    const claudeSettings = join(home, ".claude", "settings.json");
    write(claudeSettings, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: `bash ${script}` }] }] } }));
    const codexHooks = join(home, ".codex", "hooks.json");
    write(codexHooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: script }] }] } }));
    write(join(mem, "guard_inject.json"), JSON.stringify({ created: [codexHooks] }));

    // synced skills: one as written, one the user edited
    const skillA = join(home, ".claude", "skills", "a", "SKILL.md");
    const skillB = join(home, ".claude", "skills", "b", "SKILL.md");
    write(skillA, "skill a");
    write(skillB, "skill b, edited");
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    write(join(mem, "skill_inject.json"), JSON.stringify({ claude: { a: { hash: sha("skill a") }, b: { hash: sha("skill b") } } }));

    // the agy runner and the Python runner's wrapper
    const binDir = join(home, ".gemini", "antigravity", "bin");
    write(join(binDir, "agy_cli.py"), "print()");
    write(join(binDir, "agy_cli.mjs"), "console.log()");
    const wrapper = IS_WINDOWS ? join(home, "AppData", "Local", "agy", "bin", "agy.cmd") : join(home, ".local", "bin", "agy");
    const py = join(binDir, "agy_cli.py");
    write(wrapper, IS_WINDOWS ? `@echo off\r\npython "${py}" %*\r\n` : `#!/bin/sh\nexec python3 "${py}" "$@"\n`);

    removeInjected(home);

    assert.equal(read(claudeMd), "# mine\n");
    assert.ok(!existsSync(`${claudeMd}.memento.bak`));
    assert.ok(!existsSync(agentsMd));
    assert.equal(read(geminiMd), damaged);
    assert.deepEqual(JSON.parse(read(claudeSettings)), { model: "opus" });
    assert.ok(!existsSync(codexHooks));
    assert.ok(!existsSync(dirname(skillA)));
    assert.equal(read(skillB), "skill b, edited");
    assert.ok(!existsSync(wrapper));
    assert.ok(!existsSync(binDir));
  });

  test("leaves an agy that isn't Memento's", () => {
    const wrapper = IS_WINDOWS ? join(home, "AppData", "Local", "agy", "bin", "agy.cmd") : join(home, ".local", "bin", "agy");
    write(wrapper, "#!/bin/sh\nexec /opt/google/agy \"$@\"\n");
    removeInjected(home);
    assert.equal(read(wrapper), "#!/bin/sh\nexec /opt/google/agy \"$@\"\n");
  });
});
