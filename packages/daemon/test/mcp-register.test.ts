import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { antigravityMcpFile, applyMcpRegistration, bundledMcpLauncher, convergeCodex, defaultMcpTargets, isOurEntry, standaloneMcpLauncher, type McpLauncher, type McpTarget } from "../src/mcp-register.js";

const EXE = "C:\\Users\\Admin\\AppData\\Local\\Programs\\@mementodesktop\\Memento.exe";
const MJS = "C:\\Users\\Admin\\AppData\\Local\\Programs\\@mementodesktop\\resources\\app.asar.unpacked\\dist\\mcp.mjs";
const launcher: McpLauncher = { command: EXE, args: [MJS], env: { ELECTRON_RUN_AS_NODE: "1" } };
const claudeEntry = { type: "stdio", command: EXE, args: [MJS], env: { ELECTRON_RUN_AS_NODE: "1" } };

let home: string;
let targets: Record<string, McpTarget>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mcp_register_"));
  targets = {
    claude_code: { toolHome: join(home, ".claude"), file: join(home, ".claude.json"), format: "claude" },
    codex: { toolHome: join(home, ".codex"), file: join(home, ".codex", "config.toml"), format: "codex" },
    antigravity: { toolHome: join(home, ".gemini", "antigravity"), file: join(home, ".gemini", "antigravity", "mcp_config.json"), format: "json" },
    cursor: { toolHome: join(home, ".cursor"), file: join(home, ".cursor", "mcp.json"), format: "json" },
  };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Record<string, any>;
const backups = () => (existsSync(join(home, ".memento", "backups", "mcp")) ? readdirSync(join(home, ".memento", "backups", "mcp")) : []);
const run = (add: string[] = []) => applyMcpRegistration({ launcher, add, home, targets });

it("rewrites the Python-era entry with its stale token, and folds the old local-scope copies into one", async () => {
  mkdirSync(join(home, ".claude"));
  const config = {
    numStartups: 12,
    mcpServers: {
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      "memento-memory": { type: "stdio", command: "python", args: ["-m", "mcp_server", "--server-url", "https://mem.ihasy.com", "--token", "old-token"], env: { PYTHONPATH: "C:\\memento" }, timeout: 30000 },
    },
    projects: {
      "C:/work/a": {
        allowedTools: [],
        mcpServers: {
          "daily-report-memory": { command: "python", args: ["-m", "mcp_server", "--server-url", "https://report.ihasy.com", "--token", "collector-dev-token"] },
          mine: { command: "node", args: ["mine.js"] },
          "memento-memory": { command: "C:\\old\\memento-mcp-sidecar.exe", args: [] },
        },
      },
      "C:/work/b": { allowedTools: ["Bash"] },
    },
  };
  writeFileSync(targets.claude_code!.file, JSON.stringify(config, null, 2));

  expect(await run()).toEqual({ claude_code: "repaired" });
  const out = readJson(targets.claude_code!.file);
  expect(out.numStartups).toBe(12);
  expect(Object.keys(out.mcpServers)).toEqual(["github", "memento-memory"]);
  expect(out.mcpServers.github).toEqual(config.mcpServers.github);
  // The user's own setting stays; no token anywhere
  expect(out.mcpServers["memento-memory"]).toEqual({ ...claudeEntry, timeout: 30000 });
  expect(Object.keys(out.projects["C:/work/a"].mcpServers)).toEqual(["memento-memory", "mine"]);
  expect(out.projects["C:/work/a"].mcpServers["memento-memory"]).toEqual(claudeEntry);
  expect(out.projects["C:/work/b"]).toEqual({ allowedTools: ["Bash"] });
  expect(JSON.stringify(out)).not.toMatch(/token/);
  expect(backups()).toHaveLength(1);

  // Converged: nothing written again
  expect(await run(["claude_code"])).toEqual({ claude_code: "unchanged" });
  expect(backups()).toHaveLength(1);
});

it("adds the entry only for tools chosen for the resident profile, and never creates Claude Code's own file", async () => {
  mkdirSync(join(home, ".claude"));
  expect(await run(["claude_code"])).toEqual({ claude_code: "absent" });
  expect(existsSync(targets.claude_code!.file)).toBe(false);

  writeFileSync(targets.claude_code!.file, JSON.stringify({ mcpServers: { github: { command: "npx" } } }));
  expect(await run()).toEqual({ claude_code: "off" });
  expect(readJson(targets.claude_code!.file).mcpServers).toEqual({ github: { command: "npx" } });

  expect(await run(["claude_code"])).toEqual({ claude_code: "added" });
  expect(readJson(targets.claude_code!.file).mcpServers).toEqual({ github: { command: "npx" }, "memento-memory": claudeEntry });
});

it("creates Antigravity's MCP file when it's installed and chosen, and repairs Cursor's dead sidecar", async () => {
  mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
  mkdirSync(join(home, ".cursor"));
  writeFileSync(targets.cursor!.file, JSON.stringify({ mcpServers: { "memento-memory": { command: "C:\\Users\\Admin\\.memento\\bin\\memento-mcp-sidecar.exe", disabled: false } } }));

  expect(await run(["antigravity", "codex"])).toEqual({ codex: "absent", antigravity: "added", cursor: "repaired" });
  expect(readJson(targets.antigravity!.file)).toEqual({ mcpServers: { "memento-memory": { command: EXE, args: [MJS], env: { ELECTRON_RUN_AS_NODE: "1" } } } });
  expect(readJson(targets.cursor!.file).mcpServers["memento-memory"]).toEqual({ command: EXE, disabled: false, args: [MJS], env: { ELECTRON_RUN_AS_NODE: "1" } });
});

it("writes Antigravity's entry where the installed version reads it", async () => {
  const gemini = join(home, ".gemini");
  const legacy = join(gemini, "antigravity", "mcp_config.json");
  const current = join(gemini, "config", "mcp_config.json");
  // Fresh install, nothing written yet: the current place
  expect(antigravityMcpFile(gemini)).toBe(current);
  // An install that hasn't moved its settings yet only has the old file
  mkdirSync(join(gemini, "antigravity"), { recursive: true });
  writeFileSync(legacy, '{\n  "mcpServers": {}\n}');
  expect(antigravityMcpFile(gemini)).toBe(legacy);
  // Moved (the Windows machine: both files, the old one no longer read)
  mkdirSync(join(gemini, "config"));
  writeFileSync(join(gemini, "config", ".migrated"), "");
  expect(antigravityMcpFile(gemini)).toBe(current);
  rmSync(join(gemini, "config", ".migrated"));
  writeFileSync(current, ""); // this Mac: an empty file
  expect(antigravityMcpFile(gemini)).toBe(current);

  const t = defaultMcpTargets(home, {});
  expect(t.antigravity).toEqual({ toolHome: join(gemini, "antigravity"), file: current, format: "json" });
  expect(await applyMcpRegistration({ launcher, add: ["antigravity"], home, targets: { antigravity: t.antigravity! } })).toEqual({ antigravity: "added" });
  expect(readJson(current).mcpServers["memento-memory"].command).toBe(EXE);
  expect(readFileSync(legacy, "utf8")).toBe('{\n  "mcpServers": {}\n}');

  // Only the agy CLI installed
  rmSync(join(gemini, "antigravity"), { recursive: true });
  mkdirSync(join(gemini, "antigravity-cli"));
  expect(defaultMcpTargets(home, {}).antigravity!.toolHome).toBe(join(gemini, "antigravity-cli"));
});

it("leaves broken files and other people's servers alone", async () => {
  mkdirSync(join(home, ".cursor"));
  writeFileSync(targets.cursor!.file, "{ not json");
  const r = await run(["cursor"]);
  expect(r.cursor).toMatch(/^error: .*解析失败/);
  expect(readFileSync(targets.cursor!.file, "utf8")).toBe("{ not json");

  expect(isOurEntry("memento", "npx", ["-y", "someone-elses-memento"])).toBe(false);
  expect(isOurEntry("memory", "C:\\x\\memento-mcp-sidecar.exe", [])).toBe(true);
  expect(isOurEntry("memento", "node", ["/Applications/Memento.app/Contents/Resources/app.asar.unpacked/dist/mcp.mjs"])).toBe(true);
  expect(isOurEntry("daily-report-memory", "python", ["-m", "mcp_server"])).toBe(true);
  expect(isOurEntry("Memento-Memory", "anything", [])).toBe(true);
});

it("does nothing outside the packaged desktop app", async () => {
  mkdirSync(join(home, ".claude"));
  writeFileSync(targets.claude_code!.file, JSON.stringify({ mcpServers: { "memento-memory": { command: "python" } } }));
  expect(await applyMcpRegistration({ launcher: null, add: ["claude_code"], home, targets })).toEqual({});
  expect(readJson(targets.claude_code!.file).mcpServers["memento-memory"]).toEqual({ command: "python" });
});

it("keeps five backups per tool", async () => {
  mkdirSync(join(home, ".cursor"));
  for (let i = 0; i < 7; i++) {
    writeFileSync(targets.cursor!.file, JSON.stringify({ mcpServers: { "memento-memory": { command: `old-${i}` } } }));
    expect((await run()).cursor).toBe("repaired");
    await new Promise((r) => setTimeout(r, 2));
  }
  const kept = backups().filter((f) => f.startsWith("cursor-"));
  expect(kept).toHaveLength(5);
  // The newest five, taken before each rewrite: the last holds what the last run found
  expect(readJson(join(home, ".memento", "backups", "mcp", kept.sort().at(-1)!)).mcpServers["memento-memory"].command).toBe("old-6");
});

const codexOld = [
  'model = "gpt-5.5"',
  "",
  "[mcp_servers.github]",
  'command = "npx"',
  'args = ["-y", "@modelcontextprotocol/server-github"]',
  "",
  "[mcp_servers.memento-memory]",
  "command = 'C:\\Users\\Admin\\.memento\\bin\\memento-mcp-sidecar.exe'",
  "args = [",
  '  "--token",',
  '  "old-token",',
  "]",
  "tool_timeout_sec = 120",
  "",
  "[mcp_servers.memento-memory.env]",
  'MEMENTO_SERVER_TOKEN = "old-token"',
  "",
  "[mcp_servers.memento-memory.tools.memory_search]",
  'approval = "never"',
  "",
  "# my notes on the next server",
  "[mcp_servers.daily-report-memory]",
  'command = "python"',
  'args = ["-m", "mcp_server"]',
  "",
  "[projects.'C:\\work']",
  'trust_level = "trusted"',
  "",
].join("\r\n");

it("rewrites Codex's entry in place, keeping the user's settings, comments and line endings", async () => {
  const r = convergeCodex(codexOld, launcher, false);
  expect(r.change).toBe("repaired");
  expect(r.next).toBe(
    [
      'model = "gpt-5.5"',
      "",
      "[mcp_servers.github]",
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-github"]',
      "",
      "[mcp_servers.memento-memory]",
      `command = ${JSON.stringify(EXE)}`,
      `args = [${JSON.stringify(MJS)}]`,
      "tool_timeout_sec = 120",
      "",
      "[mcp_servers.memento-memory.env]",
      'ELECTRON_RUN_AS_NODE = "1"',
      "",
      "[mcp_servers.memento-memory.tools.memory_search]",
      'approval = "never"',
      "",
      "# my notes on the next server",
      "",
      "[projects.'C:\\work']",
      'trust_level = "trusted"',
      "",
    ].join("\r\n"),
  );
  expect(r.next).not.toMatch(/token/);
  // Its own output reads back as converged
  expect(convergeCodex(r.next, launcher, true).change).toBe("unchanged");
});

it("accepts the snippet the app shows (inline env), adds to a config without one, and leaves other layouts alone", async () => {
  const snippet = ["[mcp_servers.memento-memory]", `command = ${JSON.stringify(EXE)}`, `args = [${JSON.stringify(MJS)}]`, 'env = { ELECTRON_RUN_AS_NODE = "1" }', ""].join("\n");
  expect(convergeCodex(snippet, launcher, true)).toEqual({ next: snippet, change: "unchanged" });

  const plain = 'model = "o3"\n\n[projects."/x"]\ntrust_level = "trusted"\n\n\n';
  const added = convergeCodex(plain, launcher, true);
  expect(added.change).toBe("added");
  expect(added.next).toBe(`model = "o3"\n\n[projects."/x"]\ntrust_level = "trusted"\n\n[mcp_servers.memento-memory]\ncommand = ${JSON.stringify(EXE)}\nargs = [${JSON.stringify(MJS)}]\n\n[mcp_servers.memento-memory.env]\nELECTRON_RUN_AS_NODE = "1"\n`);
  expect(convergeCodex(plain, launcher, false)).toEqual({ next: plain, change: "none" });

  expect(() => convergeCodex('[mcp_servers]\nmemento-memory = { command = "python" }\n', launcher, true)).toThrow();

  // Codex's own layout: an empty [mcp_servers] header above the tables, literal strings
  const codexOwn = [
    "[mcp_servers]",
    "",
    "[mcp_servers.memento-memory]",
    "command = 'C:\\Users\\Admin\\AppData\\Local\\Memento\\memento-mcp-sidecar.exe'",
    "args = []",
    "",
    "[mcp_servers.memento-memory.env]",
    'MEMENTO_SERVER_TOKEN = "old-token"',
    "",
    "[mcp_servers.node_repl]",
    "command = 'C:\\x\\node_repl.exe'",
    "",
  ].join("\n");
  const fixed = convergeCodex(codexOwn, launcher, true);
  expect(fixed.change).toBe("repaired");
  expect(fixed.next).toBe(
    [
      "[mcp_servers]",
      "",
      "[mcp_servers.memento-memory]",
      `command = ${JSON.stringify(EXE)}`,
      `args = [${JSON.stringify(MJS)}]`,
      "",
      "[mcp_servers.memento-memory.env]",
      'ELECTRON_RUN_AS_NODE = "1"',
      "",
      "[mcp_servers.node_repl]",
      "command = 'C:\\x\\node_repl.exe'",
      "",
    ].join("\n"),
  );

  mkdirSync(join(home, ".codex"));
  writeFileSync(targets.codex!.file, plain);
  expect(await run(["codex"])).toEqual({ codex: "added" });
  expect(readFileSync(targets.codex!.file, "utf8")).toBe(added.next);
  expect(await run(["codex"])).toEqual({ codex: "unchanged" });
});

it("a daemon without the desktop app registers the packages/mcp built next to it, started with its own Node", async () => {
  // The source checkout executor.sh builds: packages/daemon/dist and packages/mcp/dist, deps hoisted to the root
  const repo = join(home, "src", "memento");
  const daemonDist = join(repo, "packages", "daemon", "dist");
  const cli = join(repo, "packages", "mcp", "dist", "cli.js");
  mkdirSync(daemonDist, { recursive: true });
  expect(standaloneMcpLauncher(daemonDist, "/opt/node/bin/node")).toBeNull();
  mkdirSync(join(repo, "packages", "mcp", "dist"), { recursive: true });
  writeFileSync(cli, "");
  // Built but its SDK not installed: the entry would fail to start
  expect(standaloneMcpLauncher(daemonDist, "/opt/node/bin/node")).toBeNull();
  mkdirSync(join(repo, "node_modules", "@modelcontextprotocol", "sdk"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "{}");
  const standalone = standaloneMcpLauncher(daemonDist, "/opt/node/bin/node")!;
  expect(standalone).toEqual({ command: "/opt/node/bin/node", args: [cli], env: {} });

  // The desktop app's launcher wins; a half-set one means none rather than a guess
  expect(bundledMcpLauncher({ MEMENTO_MCP_COMMAND: cli, MEMENTO_MCP_ENTRY: cli })).toEqual({ command: cli, args: [cli], env: { ELECTRON_RUN_AS_NODE: "1" } });
  expect(bundledMcpLauncher({ MEMENTO_MCP_COMMAND: cli })).toBeNull();

  // An entry added by hand under our name, and an old desktop one: both become the plain Node entry, no env
  mkdirSync(join(home, ".claude"));
  writeFileSync(targets.claude_code!.file, JSON.stringify({ mcpServers: { "memento-memory": { type: "stdio", command: EXE, args: [MJS], env: { ELECTRON_RUN_AS_NODE: "1" } } } }));
  mkdirSync(join(home, ".codex"));
  writeFileSync(targets.codex!.file, `[mcp_servers.memento-memory]\ncommand = "node"\nargs = ["/home/u/.memento/mcp-server/dist/cli.js"]\n`);
  const sync = () => applyMcpRegistration({ launcher: standalone, add: ["claude_code", "codex"], home, targets });
  expect(await sync()).toEqual({ claude_code: "repaired", codex: "repaired" });
  expect(readJson(targets.claude_code!.file).mcpServers["memento-memory"]).toEqual({ type: "stdio", command: "/opt/node/bin/node", args: [cli] });
  expect(readFileSync(targets.codex!.file, "utf8")).toBe(`[mcp_servers.memento-memory]\ncommand = "/opt/node/bin/node"\nargs = [${JSON.stringify(cli)}]\n`);
  expect(await sync()).toEqual({ claude_code: "unchanged", codex: "unchanged" });
  expect(isOurEntry("my-memory", "/usr/bin/node", [cli])).toBe(true);
});
