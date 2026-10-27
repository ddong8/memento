import { open } from "node:fs/promises";

/**
 * Completion-evidence check behind Claude Code's and Codex's Stop hook.
 *
 * When the reply says the work is done, fixed or live, the transcript has to
 * show a check that passed after the last change (tests, a type check, a build,
 * a real request, the pipeline or pod state, a screenshot). Otherwise the agent
 * is sent back once to run one, or to say plainly what it didn't verify. Rules
 * learned from the user's corrections tell an agent to verify; this makes it.
 *
 * Only the reply and the transcript are read; nothing here runs commands.
 */

export type GuardTool = "claude_code" | "codex";
export const GUARD_TOOLS: readonly GuardTool[] = ["claude_code", "codex"];

export interface StopInput {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  /** Set when this stop follows a continuation the hook asked for: never block twice. */
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
}

/** edit: changed code or config. ship: pushed or deployed. verify: anything that checks the result. */
export type StepKind = "edit" | "ship" | "verify" | "other";

export interface Step {
  kind: StepKind;
  /** null when the transcript doesn't say (a background command, say). */
  ok: boolean | null;
  text: string;
  /** In the current turn, i.e. after the user's last prompt. */
  turn: boolean;
}

/** unread: the transcript couldn't be read, so nothing is known and nothing is blocked. */
export type Outcome = "no_claim" | "unread" | "disclosed" | "verified" | "no_evidence" | "failed_check";

export interface Verdict {
  block: boolean;
  outcome: Outcome;
  claim: string | null;
  /** The claim is about something being live (deployed, released, in effect). */
  deploy: boolean;
  /** Follows a continuation the hook asked for. */
  followup: boolean;
  /** The check the verdict rests on, if any. */
  check: string | null;
  reason?: string;
}

// ---- the claim ----

const VERBS = "完成|修复|修好|改好|改完|解决|上线|部署|发布|生效|搞定|做完|跑通|落地|交付";
const CLAIM_ZH = new RegExp(
  `(?:已经?|均已|都已|全都|全部|均)\\s*(?:${VERBS})|(?:${VERBS})(?:了|完毕|完成|成功)|(?:验证|测试|自测|检查)(?:都|全部|均)?(?:已)?通过`,
);
const CLAIM_EN =
  /\b(?:(?:is|are|has been|have been|now|all|everything(?:'s| is)?)\s+(?:done|fixed|deployed|live|complete|completed|resolved|working|shipped|released)|(?:fixed|deployed|shipped|released|completed)\s+(?:and|the|it|in|to)\b)/i;
const DEPLOY = /上线|部署|发布|生效|live|deploy|releas|ship/i;
const NEGATED_ZH = /未|没|不|无法|尚|别/;
const NEGATED_EN = /\b(?:not|never|un)\b|n't\b/i;
const CONDITIONAL_ZH = /如果|若是|假如|一旦|等到|直到|待|可能|也许|或许|是否|有没有|能否/;
const QUESTION_END = /(?:吗|么|呢)?[？?]\s*$|吗\s*$/;

/** Saying outright that something wasn't verified is the honest way to end; it isn't blocked. */
const DISCLOSED =
  /未(?:经)?(?:验证|实测|测试|自测|核实)|没(?:有)?(?:验证|实测|测试|自测|跑测试|核实)|无法(?:验证|实测|测试|核实)|尚未(?:验证|测试|核实)|待验证|未能(?:验证|测试)|\bnot (?:yet )?(?:verified|tested)\b|\bunverified\b|\buntested\b|\b(?:haven't|have not|didn't|did not|couldn't|could not) (?:verify|test|run)\b/i;

/** The reply without code, quotes and quoted lines: a claim there is someone else's words. */
export function stripQuoted(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, " ");
}

/** The first sentence that claims the work is done, or null. */
export function findClaim(text: string): string | null {
  const plain = stripQuoted(text);
  for (const sentence of plain.match(/[^。！!？?\n；;]+[。！!？?；;]?/g) ?? []) {
    if (QUESTION_END.test(sentence)) continue;
    const zh = CLAIM_ZH.exec(sentence);
    if (zh) {
      const before = sentence.slice(Math.max(0, zh.index - 4), zh.index);
      const after = sentence.slice(zh.index + zh[0].length, zh.index + zh[0].length + 1);
      const lead = sentence.slice(Math.max(0, zh.index - 8), zh.index);
      if (!NEGATED_ZH.test(before) && !/[后时前]/.test(after) && !CONDITIONAL_ZH.test(lead)) return sentence.trim().slice(0, 120);
    }
    const en = CLAIM_EN.exec(sentence);
    if (en && !NEGATED_EN.test(sentence.slice(Math.max(0, en.index - 12), en.index + en[0].length))) {
      return sentence.trim().slice(0, 120);
    }
  }
  return null;
}

// ---- the steps ----

const TEMP_PATH = /^(?:\/tmp\/|\/private\/tmp\/|\/private\/var\/folders\/|\/var\/folders\/|\/dev\/)/;
/** Notes and memory: writing them after the checks isn't a change that needs another check. */
const NOTE_PATH = /\.(?:md|markdown|txt|rst|log)$|\/\.claude\/projects\/|\/\.codex\/memories\//i;
const isChange = (path: string) => !!path && !TEMP_PATH.test(path) && !NOTE_PATH.test(path);

const EDIT_CMD =
  /\bsed\s+(?:-[a-zA-Z]*\s+)*-i|\bperl\s+-[a-z]*i|\bapply_patch\b|\bgit\s+apply\b|\bpatch\s+-p|>\s*(?!\/tmp\/|\/private\/|\/dev\/|&)[\w./~-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|dart|json|ya?ml|toml|css|scss|html|vue|sh|sql)\b/;
/** A Python or Node script that writes files (the usual heredoc edit) is an edit, not a check. */
const SCRIPT_WRITES = /open\([^)]*,\s*['"][wa]\+?['"]|\.write_text\(|\bwriteFileSync\(|\bshutil\.(?:copy|move)/;
const SHIP_CMD =
  /\bgit\b[^|;&\n]*?\spush\b|\bkubectl\b[^|;&\n]*?\s(?:apply|set|patch|scale|delete|rollout\s+restart)\b|\bhelm\s+(?:install|upgrade)\b|\bdocker\s+push\b|\bgh\s+(?:release\s+create|workflow\s+run)\b|\bnpm\s+publish\b|\b(?:fly|vercel|wrangler)\s+deploy\b/;
const VERIFY_CMD =
  /\b(?:pytest|vitest|jest|mocha|playwright|cypress|unittest|rspec|phpunit|tsc|mypy|pyright|ruff|eslint|flake8|xcodebuild|gradlew?|curl|wget|psql|redis-cli|sqlite3|journalctl|lsof)\b|\bgo\s+(?:test|build|vet)\b|\bcargo\s+(?:test|check|build|clippy)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|build|check)\b|\bnpx\s+\S+|\bmake\s+(?:test|check|build)\b|\b(?:flutter|dart)\s+(?:test|analyze)\b|\b(?:mvn|dotnet)\s+test\b|\bkubectl\b[^|;&\n]*?\s(?:get|rollout\s+status|logs|describe|exec|top|wait)\b|\bgh\s+(?:run|pr\s+checks|api|release\s+view)\b|\bdocker\s+(?:ps|logs|inspect|exec)\b|\bsystemctl\s+status\b|\blaunchctl\s+(?:list|print)\b|\bnc\s+-z\b|\bping\b|\buv\s+run\b|\bdeno\s+(?:test|run)\b|\bswift\s+(?:test|build)\b/;
const VERIFY_SCRIPT = /\bpython3?\s+(?:-m\s+\w|-\s|[\w./~-]+\.py\b)|\bnode\s+(?:--test\b|[\w./~-]+\.m?[jt]s\b)/;
const VERIFY_TOOL = /screenshot|browser|computer|preview|playwright|chrome|navigate|snapshot|^Monitor$|^TaskOutput$|^BashOutput$/i;

/** `git add` naming only notes (docs, memory): pushing that ships nothing to check. */
function addsOnlyNotes(command: string): boolean {
  const added = /\bgit\s+add\s+([^|;&\n]+)/.exec(command);
  if (!added) return false;
  const paths = added[1]!.trim().split(/\s+/).filter((a) => !a.startsWith("-"));
  return paths.length > 0 && paths.every((p) => NOTE_PATH.test(p));
}

/** Steps one shell command makes, in the order a compound command would run them. */
export function commandSteps(command: string, ok: boolean | null, turn: boolean): Step[] {
  const text = command.replace(/\s+/g, " ").trim().slice(0, 160);
  const steps: Step[] = [];
  const scriptEdit = VERIFY_SCRIPT.test(command) && SCRIPT_WRITES.test(command);
  if (EDIT_CMD.test(command) || scriptEdit) steps.push({ kind: "edit", ok: null, text, turn });
  if (SHIP_CMD.test(command) && !addsOnlyNotes(command)) steps.push({ kind: "ship", ok: null, text, turn });
  if (VERIFY_CMD.test(command) || (VERIFY_SCRIPT.test(command) && !scriptEdit)) steps.push({ kind: "verify", ok, text, turn });
  return steps.length ? steps : [{ kind: "other", ok, text, turn }];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Claude Code transcript lines (JSONL) → steps. A prompt the user typed starts a new turn. */
export function claudeSteps(lines: string[]): Step[] {
  const steps: Step[] = [];
  const pending = new Map<string, Step[]>();
  for (const line of lines) {
    let row: Json;
    try {
      row = obj(JSON.parse(line));
    } catch {
      continue;
    }
    if (row.isSidechain) continue;
    const content = obj(row.message).content;
    if (row.type === "user") {
      const blocks = Array.isArray(content) ? content.map(obj) : [];
      const results = blocks.filter((b) => b.type === "tool_result");
      if (!results.length && !row.isMeta && (typeof content === "string" || blocks.length)) {
        for (const s of steps) s.turn = false;
        continue;
      }
      for (const r of results) {
        for (const s of pending.get(str(r.tool_use_id)) ?? []) if (s.kind === "verify" || s.kind === "other") s.ok = r.is_error === true ? false : true;
        pending.delete(str(r.tool_use_id));
      }
      continue;
    }
    if (row.type !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content.map(obj)) {
      if (block.type !== "tool_use") continue;
      const name = str(block.name);
      const input = obj(block.input);
      let made: Step[];
      if (/^(?:Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) {
        const path = str(input.file_path) || str(input.notebook_path);
        made = [{ kind: isChange(path) ? "edit" : "other", ok: null, text: `${name} ${path}`, turn: true }];
      } else if (name === "Bash") {
        made = commandSteps(str(input.command), null, true);
      } else if (VERIFY_TOOL.test(name) && !/memento-memory/.test(name)) {
        made = [{ kind: "verify", ok: null, text: name, turn: true }];
      } else {
        made = [{ kind: "other", ok: null, text: name, turn: true }];
      }
      steps.push(...made);
      pending.set(str(block.id), made);
    }
  }
  return steps;
}

/** Codex rollout lines (JSONL) → steps. A started task is a new turn. */
export function codexSteps(lines: string[]): Step[] {
  const steps: Step[] = [];
  for (const line of lines) {
    let row: Json;
    try {
      row = obj(JSON.parse(line));
    } catch {
      continue;
    }
    if (row.type !== "event_msg") continue;
    const payload = obj(row.payload);
    if (payload.type === "task_started") {
      for (const s of steps) s.turn = false;
      continue;
    }
    if (payload.type !== "item_completed") continue;
    const item = obj(payload.item);
    switch (item.type) {
      case "CommandExecution": {
        const cmd = Array.isArray(item.command) ? String(item.command.at(-1) ?? "") : str(item.command);
        const code = item.exit_code === undefined || item.exit_code === null ? null : Number(item.exit_code);
        steps.push(...commandSteps(cmd, code === null || Number.isNaN(code) ? null : code === 0, true));
        break;
      }
      case "FileChange": {
        const paths = Object.keys(obj(item.changes));
        const failed = item.status !== undefined && item.status !== "completed";
        if (!failed) steps.push({ kind: paths.some(isChange) ? "edit" : "other", ok: null, text: `edit ${paths.slice(0, 3).join(", ")}`, turn: true });
        break;
      }
      case "McpToolCall": {
        const name = `${str(item.server)} ${str(item.tool)}`;
        const ok = item.status === undefined ? null : item.status === "completed";
        steps.push({ kind: VERIFY_TOOL.test(name) ? "verify" : "other", ok, text: name.trim(), turn: true });
        break;
      }
      case "ImageView":
        steps.push({ kind: "verify", ok: true, text: "view image", turn: true });
        break;
    }
  }
  return steps;
}

/** The last `maxBytes` of a transcript, as whole lines (a 2 GB transcript is only read at its end). */
export async function readTail(path: string, maxBytes = 4 * 1024 * 1024): Promise<string[]> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } finally {
    await fh.close();
  }
}

// ---- the verdict ----

const NOTE = "（Memento 结果核查：用户要求交付前自测、不得谎报完成。如果这句话并不是在说你这次的工作已经完成，直接结束即可。）";

function reasonFor(outcome: Outcome, claim: string, deploy: boolean, check: string | null): string {
  const said = `你说「${claim.slice(0, 60)}」`;
  if (outcome === "failed_check") {
    return `${said}，但最后一次验证是失败的（${check ?? ""}）。先把问题修好、重新验证通过，再在回复里附上结果；修不好就如实写出失败原因和现状。${NOTE}`;
  }
  if (deploy) {
    return `${said}，但在最后一次推送或部署之后没有核实线上状态。先实际验证（流水线结果、线上版本号或健康检查、pod 状态等），把关键输出写进回复；确实没法验证的，明确写出哪些没验证、为什么。${NOTE}`;
  }
  return `${said}，但在最后一次改动之后没有运行过任何验证（测试、类型检查、构建、实际请求或截图）。先实际验证，并在回复里附上结果；确实没法验证的，明确写出哪些没验证、为什么。${NOTE}`;
}

export function decide(input: StopInput, steps: Step[]): Verdict {
  const followup = input.stop_hook_active === true;
  const message = input.last_assistant_message ?? "";
  const claim = findClaim(message);
  if (!claim) return { block: false, outcome: "no_claim", claim: null, deploy: false, followup, check: null };
  const deploy = DEPLOY.test(claim);

  const last = (pred: (s: Step) => boolean) => {
    for (let i = steps.length - 1; i >= 0; i--) if (pred(steps[i]!)) return i;
    return -1;
  };
  const lastShip = last((s) => s.kind === "ship");
  const lastChange = last((s) => s.kind === "edit" || s.kind === "ship");
  const anchor = deploy && lastShip >= 0 ? lastShip : lastChange;
  // With no change in sight, the claim is about earlier work: it has to be checked in this turn.
  const checks = steps.slice(anchor + 1).filter((s) => s.kind === "verify" && (anchor >= 0 || s.turn));
  const latest = checks.at(-1) ?? null;

  let outcome: Outcome;
  if (DISCLOSED.test(stripQuoted(message))) outcome = "disclosed";
  else if (!latest) outcome = "no_evidence";
  else if (latest.ok === false) outcome = "failed_check";
  else outcome = "verified";

  const failing = outcome === "no_evidence" || outcome === "failed_check";
  const verdict: Verdict = { block: failing && !followup, outcome, claim, deploy, followup, check: latest?.text ?? null };
  if (verdict.block) verdict.reason = reasonFor(outcome, claim, deploy, latest?.text ?? null);
  return verdict;
}

/** Read the transcript the hook names and decide; a transcript that can't be read counts as no steps. */
export async function checkStop(tool: GuardTool, input: StopInput): Promise<Verdict> {
  if (!findClaim(input.last_assistant_message ?? "")) {
    return { block: false, outcome: "no_claim", claim: null, deploy: false, followup: input.stop_hook_active === true, check: null };
  }
  const path = input.transcript_path ?? "";
  const lines = path.endsWith(".jsonl") ? await readTail(path).catch(() => null) : null;
  if (!lines?.length) {
    const claim = findClaim(input.last_assistant_message ?? "");
    return { block: false, outcome: "unread", claim, deploy: DEPLOY.test(claim ?? ""), followup: input.stop_hook_active === true, check: null };
  }
  return decide(input, tool === "codex" ? codexSteps(lines) : claudeSteps(lines));
}
