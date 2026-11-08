// Bundles the scripts the daemon runs as their own processes (on Electron run as Node, or on node)
// into single files with no dependencies:
//   - the blueprint generator (src/blueprint) -> scripts/project_blueprint.mjs, committed: the server
//     hands it to devices and this repo's own git hooks run it; and assets/project_blueprint.mjs
//   - the Antigravity task runner (src/agy-runner) -> assets/agy_cli.mjs
// The assets are what the app ships (apps/desktop/scripts/build.mjs copies assets/).
// `--check` fails when the committed generator is not what the sources build to.
import { build } from "esbuild";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = join(pkg, "../..");
const check = process.argv.includes("--check");

const RUNNERS = [
  {
    entry: "src/blueprint/main.ts",
    banner: "Memento living blueprint generator: writes and maintains PROJECT_BLUEPRINT.md for AI agents. Run with --help.",
    outputs: [join(repo, "scripts/project_blueprint.mjs"), join(pkg, "assets/project_blueprint.mjs")],
    committed: join(repo, "scripts/project_blueprint.mjs"),
  },
  {
    entry: "src/agy-runner/main.ts",
    banner: "Memento's Antigravity task runner: drives the language server Antigravity starts, for tasks sent to this device.",
    outputs: [join(pkg, "assets/agy_cli.mjs")],
  },
];

async function bundle(runner) {
  const res = await build({
    entryPoints: [join(pkg, runner.entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    // Electron 44 runs Node 24; a git hook without Memento falls back to whatever `node` is installed
    target: "node18",
    charset: "utf8",
    legalComments: "none",
    write: false,
    logLevel: "warning",
    banner: {
      js: [
        "#!/usr/bin/env node",
        `// ${runner.banner}`,
        `// Generated from packages/daemon/${runner.entry.replace(/\/main\.ts$/, "")} by packages/daemon/scripts/build-runners.mjs: do not edit.`,
      ].join("\n"),
    },
  });
  return res.outputFiles[0].text;
}

let stale = false;
for (const runner of RUNNERS) {
  if (!existsSync(join(pkg, runner.entry))) continue;
  const text = await bundle(runner);
  if (check) {
    if (runner.committed && (!existsSync(runner.committed) || readFileSync(runner.committed, "utf8") !== text)) {
      console.error(`${relative(repo, runner.committed)} is not what ${runner.entry} builds to: run node packages/daemon/scripts/build-runners.mjs`);
      stale = true;
    }
    continue;
  }
  for (const out of runner.outputs) {
    mkdirSync(dirname(out), { recursive: true });
    if (!existsSync(out) || readFileSync(out, "utf8") !== text) writeFileSync(out, text);
    chmodSync(out, 0o755);
  }
}
if (stale) process.exit(1);
