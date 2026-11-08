// Memento — one-click installer for macOS / Linux / Windows.
//
// Usage:
//   node scripts/install.mts              # full install (no embedding)
//   node scripts/install.mts embedding    # install the embedding server
//   node scripts/install.mts doctor       # status check
//   node scripts/install.mts update       # git pull + rebuild + upgrade
//   node scripts/install.mts uninstall [--purge | --all]
//   node scripts/install.mts uninstall-collector   # a device that only runs the collector
//
// Usually started by the top-level `./install.sh` or `.\install.ps1`, which find Node.js 22.18+ (or the
// Memento app's runtime) to run it.
import { existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as collector from "./install/collector.mts";
import * as docker from "./install/docker.mts";
import * as embeddingDocker from "./install/embedding-docker.mts";
import * as embeddingHost from "./install/embedding-host.mts";
import { ensureEnv, setEnvValue } from "./install/env-file.mts";
import { ensureFirstUser } from "./install/first-user.mts";
import { C, Interrupted, REPO_ROOT, ask, errorText, fail, heading, info, ok, run, step, which } from "./install/platform.mts";

interface Command {
  help: string;
  /** flag → [aliases, help] */
  flags: Record<string, [aliases: string[], help: string]>;
  run: (flags: Set<string>) => Promise<number>;
}

const COMMANDS: Record<string, Command> = {
  install: {
    help: "Full install (default)",
    flags: { "non-interactive": [["--non-interactive"], "Skip all prompts (fail if input required)"] },
    run: cmdInstall,
  },
  embedding: {
    help: "Install embedding server (Docker default; pass --native for GPU)",
    flags: { native: [["--native"], "Use host venv install instead of Docker (needed for CUDA / MPS GPU)."] },
    run: cmdEmbedding,
  },
  doctor: { help: "Print service status", flags: {}, run: cmdDoctor },
  update: { help: "Pull latest + rebuild", flags: {}, run: cmdUpdate },
  uninstall: {
    help: "Reverse the install",
    flags: {
      purge: [["--purge"], "Also delete data volumes + .env files"],
      all: [["--all"], "Everything: pip, config, logs, model cache, images, MCP entries"],
      yes: [["-y", "--yes"], "Skip confirmation prompt for --all"],
    },
    run: cmdUninstall,
  },
  "uninstall-collector": {
    help: "Only this device's collector: service, ~/.memento, logs, MCP entries, what it wrote into AI tools",
    flags: {},
    run: cmdUninstallCollector,
  },
};

async function cmdInstall(flags: Set<string>): Promise<number> {
  const interactive = !flags.has("non-interactive");
  heading("1. Environment file");
  await step(".env generate/merge", () => ensureEnv({ interactive }));

  heading("2. Docker stack");
  await step("Docker preflight", () => docker.preflight(), "Start Docker Desktop or `sudo systemctl start docker`");
  await step("docker compose up -d --build", () => docker.composeUp());
  await step("Wait for API /health", () => docker.waitForApi(180));

  heading("3. First user");
  const token = await ensureFirstUser(interactive);

  heading("4. Local collector");
  await step("Configure this device + install the collector daemon", () => collector.installCollector(token));

  heading("Done");
  console.log(`  ${C.green}▸${C.reset} Web UI:  http://localhost:3001`);
  console.log(`  ${C.green}▸${C.reset} API:     http://localhost:8001`);
  console.log(`  ${C.green}▸${C.reset} MinIO:   http://localhost:9001  (user/pass in .env)`);
  console.log();
  console.log(`  Semantic search & MCP memory?  ${C.cyan}./install.sh embedding${C.reset}`);
  console.log(`  Status check:                  ${C.cyan}./install.sh doctor${C.reset}`);
  console.log();
  return 0;
}

/** Docker by default; `--native` is the host venv install (for NVIDIA CUDA / Apple MPS). */
async function cmdEmbedding(flags: Set<string>): Promise<number> {
  if (flags.has("native")) {
    heading("Embedding (native host install — GPU mode)");
    await step("Install embedding (venv + torch + sentence-transformers + model)", () => embeddingHost.install());
    // The compose default is the in-stack `embedding` service; the api and worker reach a host process
    // via host.docker.internal
    await setEnvValue("MEMENTO_EMBEDDING_SERVER_URL", "http://host.docker.internal:8002");
    if (docker.serviceRunning("api")) {
      await step("Recreate api + celery so they use the native embedding server", () => docker.recreate("api", "celery-worker", "celery-beat"));
    } else {
      info("MEMENTO_EMBEDDING_SERVER_URL is set in .env; the api picks it up when it starts.");
    }
    return 0;
  }
  heading("Embedding (Docker — recommended)");
  await step("Build + start `embedding` compose profile (~5–15 min first time)", () => embeddingDocker.install());
  info("Semantic search & MCP memory_search are now wired up.");
  return 0;
}

async function cmdDoctor(): Promise<number> {
  heading("Service status");
  const rows = await docker.doctor();
  docker.printDoctor(rows);
  return rows.slice(0, 2).every((r) => r[1]) ? 0 : 1; // docker + api are hard requirements
}

async function cmdUpdate(): Promise<number> {
  heading("Update");
  // Self-heal: a previous install that crashed before .env was written would boot the api with the
  // dev-default secret key / collector token / MinIO creds, which validate_production() refuses
  info("Ensuring .env is present…");
  await ensureEnv({ interactive: false });
  info("Pulling latest code…");
  run("git", ["pull"], { cwd: REPO_ROOT });
  info("Rebuilding containers…");
  run("docker", ["compose", "up", "-d", "--build"], { check: true, cwd: REPO_ROOT });
  // The collector daemon runs from this checkout: rebuild it and reinstall its service on the new code
  if (collector.daemonServiceInstalled() && collector.canRunDaemon()) {
    info("Rebuilding the collector daemon…");
    collector.buildDaemon();
    run(process.execPath, [collector.DAEMON_CLI, "install-service"], { cwd: REPO_ROOT });
  }
  // Embedding (if installed) restarts via its own service manager (launchd / systemd / Docker restart policy)
  ok("Update complete. Run `./install.sh doctor` to verify.");
  return 0;
}

async function cmdUninstall(flags: Set<string>): Promise<number> {
  const deep = flags.has("all"); // `--all` implies `--purge` + deeper cleanup
  const purge = flags.has("purge") || deep;

  if (deep && process.stdin.isTTY && !flags.has("yes")) {
    console.log(
      `${C.yellow}WARNING${C.reset} \`--all\` will remove:\n` +
        "  • collector daemon service + old pip packages (memento-collector, memento-memory)\n" +
        "  • collector config + sync state (~/.memento)\n" +
        "  • collector + embedding logs\n" +
        "  • embedding venv + HuggingFace model cache (~1.3GB)\n" +
        "  • Docker images (memento-*)\n" +
        "  • docker volumes (all your synced data will be lost)\n" +
        "  • .env and .env.local\n" +
        "  • MCP entries in Claude / Cursor / Codex / Windsurf / Antigravity / Gemini configs\n" +
        "  • what Memento wrote into AI tools: profile block in CLAUDE.md / AGENTS.md / GEMINI.md …,\n" +
        "    Stop hooks, synced skills, the agy wrapper (anything you edited is kept)\n" +
        "Quit the Memento desktop app first, or it writes them back.",
    );
    if ((await ask("Type 'yes' to continue: ")).trim().toLowerCase() !== "yes") {
      info("Aborted.");
      return 1;
    }
  }

  heading("Uninstall");

  // 1. Collector
  if (deep) {
    info("Deep-uninstalling collector (service + config + logs + MCP entries)…");
    collector.deepUninstall();
  } else {
    collector.uninstallDaemonService();
    const retired = which("memento-collector"); // the retired Python collector, from older installs
    if (retired) run(retired, ["uninstall"]);
  }

  // 2. Embedding: both install paths, so users who switched modes keep no orphaned containers / agents
  info("Removing embedding service…");
  embeddingHost.uninstall(deep, deep);
  embeddingDocker.uninstall(deep);

  // 3. Docker
  info("Stopping Docker stack…");
  docker.composeDown(purge);
  if (deep) {
    info("Removing Docker images…");
    for (const img of ["memento-api", "memento-web", "memento-celery-worker", "memento-celery-beat"]) {
      run("docker", ["rmi", "-f", img], { capture: true });
    }
    ok("Images removed (non-fatal if already gone).");
  }

  // 4. Repo-local files
  if (purge) {
    info("Purging .env and .env.local…");
    for (const p of [join(REPO_ROOT, ".env"), join(REPO_ROOT, ".env.local"), join(REPO_ROOT, "install.log")]) {
      if (existsSync(p)) unlinkSync(p);
    }
    rmSync(embeddingHost.VENV_DIR, { recursive: true, force: true });
  }

  console.log();
  if (deep) {
    ok("Deep uninstall complete. Nothing belonging to Memento remains.");
    info(`If you installed via curl, the repo clone at ${REPO_ROOT} is safe to delete.`);
  } else if (purge) {
    ok("Uninstalled. Data volumes + .env purged.");
  } else {
    ok("Uninstalled. Data volumes preserved (use --purge to remove them).");
  }
  return 0;
}

/** A device that only runs the collector: everything of it, no server or Docker steps. */
async function cmdUninstallCollector(): Promise<number> {
  heading("Uninstall collector");
  collector.deepUninstall();
  ok("Collector removed. Quit and delete the Memento app too if it is installed, or it starts collecting again.");
  return 0;
}

// ── argument parsing ─────────────────────────────────────────
const PROG = "install";

function usage(): string {
  const names = Object.keys(COMMANDS);
  const lines = [
    `usage: ${PROG} [-h] {${names.join(",")}} ...`,
    "",
    "Memento — one-click installer for macOS / Linux / Windows.",
    "",
    "commands (default: install):",
    ...names.map((n) => `  ${n.padEnd(21)}${COMMANDS[n]!.help}`),
  ];
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    const flags = Object.values(cmd.flags);
    if (!flags.length) continue;
    lines.push("", `${name} options:`, ...flags.map(([aliases, help]) => `  ${aliases.join(", ").padEnd(21)}${help}`));
  }
  return `${lines.join("\n")}\n`;
}

export class UsageError extends Error {}

export type Parsed = { help: true } | { help: false; command: string; flags: Set<string> };

/** argv → command + flags; no command means `install` with the same arguments. */
export function parseArgs(argv: string[]): Parsed {
  if (argv.some((a) => a === "-h" || a === "--help")) return { help: true };
  const [first, ...rest] = argv;
  const named = first !== undefined && Object.hasOwn(COMMANDS, first);
  const command = named ? first : "install";
  const args = named ? rest : argv;
  const known = COMMANDS[command]!.flags;
  const flags = new Set<string>();
  const unknown: string[] = [];
  for (const a of args) {
    const hit = Object.entries(known).find(([, [aliases]]) => aliases.includes(a));
    if (hit) flags.add(hit[0]);
    else unknown.push(a);
  }
  if (unknown.length) {
    if (!named && first !== undefined && !first.startsWith("-")) {
      throw new UsageError(`argument command: invalid choice: '${first}' (choose from ${Object.keys(COMMANDS).map((n) => `'${n}'`).join(", ")})`);
    }
    throw new UsageError(`unrecognized arguments: ${unknown.join(" ")}`);
  }
  return { help: false, command, flags };
}

let interruptedShown = false;
function interrupted(): number {
  if (!interruptedShown) fail("\nInterrupted.");
  interruptedShown = true;
  return 130;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${usage().split("\n")[0]}\n${PROG}: error: ${e.message}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(usage());
    return 0;
  }
  // Ctrl-C outside a prompt (prompts and child processes report it as Interrupted)
  process.on("SIGINT", () => process.exit(interrupted()));
  try {
    return await COMMANDS[parsed.command]!.run(parsed.flags);
  } catch (e) {
    if (e instanceof Interrupted) return interrupted();
    fail(errorText(e));
    const logPath = join(REPO_ROOT, "install.log");
    writeFileSync(logPath, e instanceof Error && e.stack ? `${e.stack}\n` : `${String(e)}\n`, "utf8");
    fail(`Full traceback saved to ${logPath}`);
    fail("Try `./install.sh doctor` to diagnose.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
  // Prompts leave stdin referenced; nothing else is pending once main returns
  process.stdin.unref?.();
}
