// The generator's command line, as the Python script's argparse took it: the same flags, unique
// prefixes of them (`--inst` for --install-hook), `--flag=value`, and exit status 2 with the usage on
// a bad command line. The daemon and the git hooks only pass full flags.
import { BLUEPRINT_FILE, buildBlueprintContent } from "./content.js";
import { exists, pjoin, pname, readTextIgnore, resolvePath, toNative } from "./files.js";
import { pyStrip } from "./py.js";
import { bootstrapDiscoveredProjects, ensureAgentGuidanceAnchor, installGitHook, SCRIPT_NAME, uninstallAll, uninstallGitHook, uninstallRepo, writeBlueprint } from "./repo.js";

interface Option {
  flag: string;
  dest: string;
  value?: string; // metavar of an option that takes a value
  help: string;
}

const OPTIONS: Option[] = [
  { flag: "--root", dest: "root", value: "ROOT", help: "Project root directory (default: current directory)" },
  { flag: "--output", dest: "output", value: "OUTPUT", help: "Output markdown path (default: <root>/PROJECT_BLUEPRINT.md)" },
  { flag: "--install-hook", dest: "install_hook", help: "Install the git hooks that keep the blueprint current" },
  { flag: "--uninstall-hook", dest: "uninstall_hook", help: "Remove the git hooks only" },
  { flag: "--uninstall", dest: "uninstall", help: "Take back everything done in --root (hooks, markers, generated file)" },
  { flag: "--uninstall-all", dest: "uninstall_all", help: "--uninstall for every repo this script touched" },
  { flag: "--anchor", dest: "anchor", help: "Also add a read-the-blueprint hint to the repo's CLAUDE.md / AGENTS.md / ..." },
  { flag: "--bootstrap-discovered", dest: "bootstrap_discovered", help: "Discover and install blueprint & hooks across all local git projects" },
  { flag: "--check", dest: "check", help: "Check if current PROJECT_BLUEPRINT.md is up-to-date" },
  { flag: "--quiet", dest: "quiet", help: "Suppress stdout messages" },
];
const DESCRIPTION = "Generate and maintain living PROJECT_BLUEPRINT.md for AI agents.";

export interface Args {
  root: string;
  output: string;
  install_hook: boolean;
  uninstall_hook: boolean;
  uninstall: boolean;
  uninstall_all: boolean;
  anchor: boolean;
  bootstrap_discovered: boolean;
  check: boolean;
  quiet: boolean;
}

class UsageError extends Error {}
class HelpRequested extends Error {}

/** shutil.get_terminal_size().columns: $COLUMNS, else the terminal's width, else 80. */
function terminalColumns(): number {
  const env = Number.parseInt(process.env.COLUMNS ?? "", 10);
  if (env > 0) return env;
  return process.stdout.isTTY && process.stdout.columns > 0 ? process.stdout.columns : 80;
}

// textwrap.wrap(text, width) as argparse calls it: words split at whitespace and after hyphens,
// greedy lines, words longer than a line broken (at a hyphen when there is one)
const WORDSEP_RE =
  /([\t\n\x0b\x0c\r ]+|(?<=[\w!"'&.,?])-{2,}(?=\w)|[^\t\n\x0b\x0c\r ]+?(?:-(?:(?<=[^\d\W]{2}-)|(?<=[^\d\W]-[^\d\W]-))(?=[^\d\W]-?[^\d\W])|(?=[\t\n\x0b\x0c\r ]|$)|(?<=[\w!"'&.,?])(?=-{2,}\w)))/;

function wrap(text: string, width: number): string[] {
  const chunks = text.split(WORDSEP_RE).filter((c) => c).reverse();
  const lines: string[] = [];
  while (chunks.length) {
    const line: string[] = [];
    let len = 0;
    if (lines.length && !chunks[chunks.length - 1]!.trim()) chunks.pop();
    while (chunks.length) {
      const l = chunks[chunks.length - 1]!.length;
      if (len + l > width) break;
      line.push(chunks.pop()!);
      len += l;
    }
    if (chunks.length && chunks[chunks.length - 1]!.length > width) {
      const spaceLeft = width < 1 ? 1 : width - len;
      const chunk = chunks[chunks.length - 1]!;
      let cut = spaceLeft;
      const hyphen = chunk.lastIndexOf("-", spaceLeft - 1);
      if (chunk.length > spaceLeft && hyphen > 0 && /[^-]/.test(chunk.slice(0, hyphen))) cut = hyphen + 1;
      line.push(chunk.slice(0, cut));
      chunks[chunks.length - 1] = chunk.slice(cut);
    }
    if (line.length && !line[line.length - 1]!.trim()) line.pop();
    if (line.length) lines.push(line.join(""));
  }
  return lines;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** argparse's usage line, wrapped the way its HelpFormatter wraps it. */
function usageText(prog: string, width: number): string {
  const prefix = "usage: ";
  const parts = ["[-h]", ...OPTIONS.map((o) => (o.value ? `[${o.flag} ${o.value}]` : `[${o.flag}]`))];
  const oneLine = [prog, ...parts].join(" ");
  if (prefix.length + oneLine.length <= width) return prefix + oneLine;
  const getLines = (items: string[], indent: string, withPrefix: boolean): string[] => {
    const lines: string[] = [];
    let line: string[] = [];
    let lineLen = (withPrefix ? prefix.length : indent.length) - 1;
    for (const part of items) {
      if (lineLen + 1 + part.length > width && line.length) {
        lines.push(indent + line.join(" "));
        line = [];
        lineLen = indent.length - 1;
      }
      line.push(part);
      lineLen += part.length + 1;
    }
    if (line.length) lines.push(indent + line.join(" "));
    if (withPrefix) lines[0] = lines[0]!.slice(indent.length);
    return lines;
  };
  let lines: string[];
  if (prefix.length + prog.length <= 0.75 * width) {
    const indent = " ".repeat(prefix.length + prog.length + 1);
    lines = getLines([prog, ...parts], indent, true);
  } else {
    lines = [prog, ...getLines(parts, " ".repeat(prefix.length), false)];
  }
  return prefix + lines.join("\n");
}

function usage(prog: string): string {
  return usageText(prog, terminalColumns() - 2) + "\n";
}

function help(prog: string): string {
  const width = terminalColumns() - 2;
  const rows: [string, string][] = [["-h, --help", "show this help message and exit"], ...OPTIONS.map((o): [string, string] => [o.value ? `${o.flag} ${o.value}` : o.flag, o.help])];
  const maxHelpPosition = Math.min(24, Math.max(width - 20, 4));
  const helpPosition = Math.min(Math.max(...rows.map(([name]) => name.length + 2)) + 2, maxHelpPosition);
  const helpWidth = Math.max(width - helpPosition, 11);
  const actionWidth = helpPosition - 2 - 2;
  const body: string[] = [];
  for (const [name, text] of rows) {
    const lines = wrap(squash(text), helpWidth);
    if (name.length <= actionWidth) {
      body.push(`  ${name.padEnd(actionWidth)}  ${lines[0] ?? ""}`);
    } else {
      body.push(`  ${name}`);
      if (lines.length) body.push(" ".repeat(helpPosition) + lines[0]);
    }
    for (const l of lines.slice(1)) body.push(" ".repeat(helpPosition) + l);
  }
  const description = wrap(squash(DESCRIPTION), Math.max(width, 11)).join("\n");
  return `${usageText(prog, width)}\n\n${description}\n\noptions:\n${body.join("\n")}\n`;
}

/** A word argparse takes as an option rather than a value (negative numbers are values here). */
function looksLikeOption(word: string): boolean {
  return word.startsWith("-") && word !== "-" && !/^-\d+$|^-\d*\.\d+$/.test(word);
}

function matchOption(word: string): Option | "help" | null {
  const name = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
  if (name === "-h" || name === "--help") return "help";
  const exact = OPTIONS.find((o) => o.flag === name);
  if (exact) return exact;
  if (!name.startsWith("--") || name.length < 3) return null;
  const hits = OPTIONS.filter((o) => o.flag.startsWith(name));
  if ("--help".startsWith(name)) {
    if (!hits.length) return "help";
    throw new UsageError(`ambiguous option: ${name} could match --help, ${hits.map((o) => o.flag).join(", ")}`);
  }
  if (hits.length > 1) throw new UsageError(`ambiguous option: ${name} could match ${hits.map((o) => o.flag).join(", ")}`);
  return hits[0] ?? null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    root: ".",
    output: "",
    install_hook: false,
    uninstall_hook: false,
    uninstall: false,
    uninstall_all: false,
    anchor: false,
    bootstrap_discovered: false,
    check: false,
    quiet: false,
  };
  const extras: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const word = argv[i++]!;
    if (word === "--") {
      extras.push(...argv.slice(i));
      break;
    }
    if (!looksLikeOption(word)) {
      extras.push(word);
      continue;
    }
    const opt = matchOption(word);
    if (opt === null) {
      extras.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    const explicit = eq >= 0 ? word.slice(eq + 1) : null;
    if (opt === "help") {
      if (explicit !== null) throw new UsageError(`argument -h/--help: ignored explicit argument '${explicit}'`);
      throw new HelpRequested();
    }
    if (!opt.value) {
      if (explicit !== null) throw new UsageError(`argument ${opt.flag}: ignored explicit argument '${explicit}'`);
      (args as unknown as Record<string, boolean>)[opt.dest] = true;
      continue;
    }
    let value = explicit;
    if (value === null) {
      const next = argv[i];
      if (next === undefined || looksLikeOption(next) || next === "--") throw new UsageError(`argument ${opt.flag}: expected one argument`);
      value = next;
      i++;
    }
    (args as unknown as Record<string, string>)[opt.dest] = value;
  }
  if (extras.length) throw new UsageError(`unrecognized arguments: ${extras.join(" ")}`);
  return args;
}

function say(line: string): void {
  process.stdout.write(line + "\n");
}

export function main(argv: string[] = process.argv.slice(2), prog = SCRIPT_NAME): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof HelpRequested) {
      process.stdout.write(help(prog));
      return 0;
    }
    if (e instanceof UsageError) {
      process.stderr.write(`${usage(prog)}${prog}: error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  if (args.uninstall_all) return uninstallAll(args.quiet);
  if (args.bootstrap_discovered) return bootstrapDiscoveredProjects(args.quiet, args.anchor);
  const root = resolvePath(args.root);
  const outPath = args.output ? resolvePath(args.output) : null;

  if (args.uninstall) {
    const ok = uninstallRepo(root);
    if (!args.quiet) say(ok ? `Removed living blueprint & hooks from: ${toNative(root)}` : `Could not fully clean ${toNative(root)}`);
    return ok ? 0 : 1;
  }

  if (args.uninstall_hook) {
    const ok = uninstallGitHook(root);
    if (!args.quiet) say("Git hooks uninstalled.");
    return ok ? 0 : 1;
  }

  if (args.check) {
    const target = outPath ?? pjoin(root, BLUEPRINT_FILE);
    if (!exists(target)) {
      if (!args.quiet) say(`${pname(target)} is missing.`);
      return 1;
    }
    const current = readTextIgnore(target);
    if (pyStrip(current) !== pyStrip(buildBlueprintContent(root))) {
      if (!args.quiet) say(`${pname(target)} is outdated.`);
      return 1;
    }
    if (!args.quiet) say(`${pname(target)} is up to date.`);
    return 0;
  }

  let ok = true;
  if (args.install_hook) ok = installGitHook(root);
  if (args.anchor) ensureAgentGuidanceAnchor(root);
  let target: string;
  let changed: boolean;
  try {
    [target, changed] = writeBlueprint(root, outPath);
  } catch (e) {
    process.stderr.write(`Failed to generate blueprint for ${toNative(root)}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (!args.quiet) {
    if (args.install_hook) say(ok ? "Git hooks installed." : "Failed to install git hooks.");
    say(`${changed ? "Generated" : "Unchanged"} living blueprint at: ${toNative(target)}`);
  }
  return ok ? 0 : 1;
}
