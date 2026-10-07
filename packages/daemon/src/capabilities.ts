import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureAgyCliInstalled } from "./antigravity.js";
import { homeDir } from "./config.js";
import { findExecutable } from "./exec-env.js";

/**
 * What agent CLIs this device can run and which models/effort levels each
 * offers, for the model pickers in the app. Reported over the task socket.
 */
export type Capabilities = Record<string, Record<string, unknown>>;

interface ModelOption {
  id: string;
  name: string;
  desc: string;
  is_default?: boolean;
}

export function formatClaudeDisplayName(modelId: string): string {
  const m = modelId.toLowerCase();
  if (m.includes("fable-5-1") || m.includes("fable-5.1")) return "Claude Fable 5.1";
  if (m.includes("mythos-5-1") || m.includes("mythos-5.1")) return "Claude Mythos 5.1";
  if (m.includes("fable-5")) return "Claude Fable 5";
  if (m.includes("mythos-5")) return "Claude Mythos 5";
  if (/(?<![0-9])opus-5/.test(m)) return "Claude Opus 5";
  if (/(?<![0-9])sonnet-5/.test(m)) return "Claude Sonnet 5";
  if (m.includes("opus-4-8")) return "Claude Opus 4.8";
  if (m.includes("opus-4-7")) return "Claude Opus 4.7";
  if (m.includes("opus-4-6")) return "Claude Opus 4.6";
  if (m.includes("sonnet-4-6") || m.includes("sonnet-4.6")) return "Claude Sonnet 4.6";
  if (m.includes("opus-4-5")) return "Claude Opus 4.5";
  if (m.includes("sonnet-4-5")) return "Claude Sonnet 4.5";
  if (m.includes("haiku-4-5")) return "Claude Haiku 4.5";
  if (m.includes("opus-4-1")) return "Claude Opus 4.1";
  if (m.includes("opus-4")) return "Claude Opus 4";
  if (m.includes("sonnet-4")) return "Claude Sonnet 4";
  if (m.includes("3-7-sonnet")) return "Claude 3.7 Sonnet";
  if (m.includes("3-5-sonnet")) return "Claude 3.5 Sonnet";
  if (m.includes("3-5-haiku")) return "Claude 3.5 Haiku";
  if (m.includes("opus")) return "Claude Opus";
  return modelId;
}

/** Newer generations first, then Fable > Mythos > Opus > Sonnet > Haiku. */
export function claudeModelRank(model: string): number {
  const m = model.toLowerCase();
  let score = 0;
  if (/5[_\-.]1/.test(m)) score += 800;
  else if (/(?<![0-9])[_\-.]5(?:$|[_\-.])/.test(m)) score += 700;
  else if (/4[_\-.][678]/.test(m)) score += 600;
  else if (/4[_\-.]5/.test(m)) score += 500;
  else if (/4[_\-.]1/.test(m)) score += 400;
  else if (/4[_\-.]0/.test(m) || m.includes("opus-4") || m.includes("sonnet-4")) score += 300;
  else if (/3[_\-.]7/.test(m)) score += 200;
  else if (/3[_\-.]5/.test(m)) score += 100;
  if (m.includes("fable")) score += 25;
  else if (m.includes("mythos")) score += 22;
  else if (m.includes("opus")) score += 20;
  else if (m.includes("sonnet")) score += 15;
  else if (m.includes("haiku")) score += 10;
  return -score;
}

const SLUG_RE = /(?:id|default|firstParty|voice_model):["'](claude-[a-z0-9.\-]+)["']/g;

/** Model ids Claude Code knows, found in the text of `sources` (its bundle or binary). */
export function claudeSlugsIn(text: string, into: Set<string>): void {
  for (const m of text.matchAll(SLUG_RE)) {
    const slug = m[1]!;
    const sl = slug.toLowerCase();
    if (!["fable", "mythos", "opus", "sonnet", "haiku"].some((f) => sl.includes(f))) continue;
    if (["token", "key", "dist", "header", "release"].some((f) => sl.includes(f))) continue;
    into.add(slug);
  }
}

const scanCache = new Map<string, string[]>();

/** Scans a file in slices (the native binary is hundreds of MB) and caches by path, size and mtime. */
async function scanFile(path: string): Promise<string[]> {
  let key: string;
  try {
    const st = statSync(path);
    key = `${path}:${st.size}:${st.mtimeMs}`;
  } catch {
    return [];
  }
  const hit = scanCache.get(key);
  if (hit) return hit;
  const found = new Set<string>();
  let carry = "";
  await new Promise<void>((resolve) => {
    const stream = createReadStream(path, { highWaterMark: 8 * 1024 * 1024 });
    stream.on("data", (chunk) => {
      const text = carry + (chunk as Buffer).toString("latin1");
      claudeSlugsIn(text, found);
      carry = text.slice(-256);
    });
    stream.on("end", () => resolve());
    stream.on("error", () => resolve());
  });
  const slugs = [...found];
  scanCache.set(key, slugs);
  return slugs;
}

const FALLBACK_CLAUDE = [
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-1-20250805",
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
];

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function claudeCapabilities(claudePath: string, home: string): Promise<Record<string, unknown>> {
  const settings = await readJson(join(home, ".claude", "settings.json"));
  const defaultModel = String(settings?.model ?? "").trim();
  const defaultEffort = String(settings?.effortLevel ?? "").trim();

  const models: ModelOption[] = [
    {
      id: "",
      name: defaultModel ? `⚡ 默认模型 (跟随客户端配置: ${defaultModel})` : "⚡ 默认模型 (跟随客户端/CLI配置)",
      desc: defaultModel ? `当前本地配置: ${defaultModel}` : "使用本地 Claude Code 配置的默认模型",
      is_default: true,
    },
    { id: "sonnet", name: "sonnet (官方动态最新 Sonnet 别名)", desc: "官方推荐别名，自动指向最新主力 (当前为 Claude Sonnet 5)" },
    { id: "opus", name: "opus (官方动态最新 Opus 别名)", desc: "官方推荐别名，极高智能与超长上下文 (当前为 Claude Opus 5)" },
    { id: "fable", name: "fable (官方动态最新 Fable 别名)", desc: "官方推荐别名，最强智能体与高阶科学推理 (当前为 Claude Fable 5.1)" },
    { id: "opus[1m]", name: "opus[1m] (100万上下文增强版)", desc: "Claude Opus 深度思维 / 100万 Token 超大上下文" },
    { id: "haiku", name: "haiku (官方动态最新 Haiku 别名)", desc: "官方推荐别名，极速轻量 (当前为 Claude Haiku 4.5)" },
  ];
  const seen = new Set(models.map((m) => m.id));
  if (defaultModel && !seen.has(defaultModel)) {
    models.push({ id: defaultModel, name: `${defaultModel} (当前本地配置)`, desc: "本地 ~/.claude/settings.json 中配置的模型" });
    seen.add(defaultModel);
  }

  const candidates: string[] = [];
  try {
    const ext = join(home, ".vscode", "extensions");
    for (const d of readdirSync(ext)) {
      if (!d.includes("anthropic.claude-code")) continue;
      const bin = join(ext, d, "resources", "native-binary", "claude");
      if (existsSync(bin)) candidates.push(bin);
    }
  } catch {
    // no VS Code extensions
  }
  candidates.push(
    join(home, ".claude/local/node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
    join(home, ".claude/local/node_modules/@anthropic-ai/claude-code/cli.js"),
    join(home, ".claude/local/claude"),
    join(home, ".local/bin/claude"),
    claudePath,
  );
  const targets = new Set<string>();
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    targets.add(p);
    try {
      targets.add(realpathSync(p));
    } catch {
      // keep the link itself
    }
  }
  const discovered = new Set<string>();
  for (const t of targets) for (const s of await scanFile(t)) discovered.add(s);
  const slugs = discovered.size ? [...discovered].sort((a, b) => claudeModelRank(a) - claudeModelRank(b)) : FALLBACK_CLAUDE;
  for (const slug of slugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push({ id: slug, name: `${slug} (${formatClaudeDisplayName(slug)})`, desc: "官方支持模型" });
  }

  return {
    tool: "claude",
    available: true,
    path: claudePath,
    models,
    default_model: defaultModel,
    supports_effort: true,
    default_effort: defaultEffort || "max",
    effort_options: [
      {
        id: "",
        name: defaultEffort ? `⚡ 默认 Effort (跟随配置: ${defaultEffort})` : "⚡ 默认 Effort (跟随CLI配置)",
        desc: defaultEffort ? `使用本地配置的 effortLevel (${defaultEffort})` : "使用客户端配置的思考量",
      },
      { id: "low", name: "Low (快速 / 低思考量)", desc: "轻量思考，极速响应，节省 Token" },
      { id: "medium", name: "Medium (标准思考量)", desc: "平衡速度与推理质量，适合日常编程" },
      { id: "high", name: "High (深度推理 / 高思考量)", desc: "深入思维链，攻坚复杂架构与排错" },
      { id: "max", name: "Max (最大思考量)", desc: "顶级复杂任务深度多步探索" },
    ],
  };
}

/** `model = "..."` style keys from Codex's config.toml. */
export function codexConfigValues(text: string): { model: string; effort: string } {
  let model = "";
  let effort = "medium";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const value = () => (line.split("=")[1] ?? "").trim().replaceAll('"', "").replaceAll("'", "");
    if (line.startsWith("model =")) model = value();
    else if (line.startsWith("model_reasoning_effort =")) effort = value();
  }
  return { model, effort };
}

async function codexCapabilities(codexPath: string, home: string): Promise<Record<string, unknown>> {
  const codexHome = process.env.CODEX_HOME || join(home, ".codex");
  const { model: defaultModel, effort: defaultEffort } = codexConfigValues(
    await readFile(join(codexHome, "config.toml"), "utf8").catch(() => ""),
  );

  const cache = await readJson(join(codexHome, "models_cache.json"));
  const found = new Set<string>();
  const cachedOptions: ModelOption[] = [];
  if (Array.isArray(cache?.models)) {
    const raw = (cache.models as Record<string, unknown>[]).filter((m) => m && typeof m === "object");
    raw.sort((a, b) => Number(a.priority ?? 999) - Number(b.priority ?? 999));
    for (const m of raw) {
      const slug = String(m.slug ?? "");
      if (!slug || slug === "codex-auto-review" || found.has(slug)) continue;
      found.add(slug);
      const name = String(m.display_name ?? slug);
      cachedOptions.push({
        id: slug,
        name: slug === defaultModel ? `${name} (当前主力)` : name,
        desc: String(m.description ?? ""),
      });
    }
  }

  // 若本地 cache 存在且 defaultModel 无法匹配可用列表（如降级为 Free 账号导致高阶模型权限受限），智能推荐可用首选
  const isDefaultModelValid = !defaultModel || found.size === 0 || found.has(defaultModel);
  const fallbackRecommended = found.size > 0 ? cachedOptions[0]?.id : "";

  let defaultModelDisplayName = defaultModel;
  let defaultModelDesc = defaultModel ? `当前配置: ${defaultModel}` : "使用本地默认配置模型";
  if (!isDefaultModelValid && fallbackRecommended) {
    defaultModelDisplayName = `${defaultModel} (账号权限受限，建议使用 ${fallbackRecommended})`;
    defaultModelDesc = `原配置 ${defaultModel} 当前账号暂不可用，已智能回退推荐 ${fallbackRecommended}`;
  }

  const models: ModelOption[] = [
    {
      id: "",
      name: defaultModel ? `⚡ 默认模型 (跟随CLI配置: ${defaultModelDisplayName})` : "⚡ 默认模型 (跟随客户端配置)",
      desc: defaultModelDesc,
      is_default: true,
    },
    ...cachedOptions,
  ];

  if (models.length === 1) {
    models.push(
      { id: "gpt-reserve", name: "GPT-Reserve (极速主力)", desc: "高性价比快速编码与日常任务" },
      { id: "gpt-6-astra", name: "GPT-6-Astra (前沿旗舰)", desc: "前沿深度多步推理模型，复杂编码首选" },
      { id: "gpt-5.6-sol", name: "GPT-5.6-Sol (日常主力)", desc: "可靠的主力 Agent 编码模型" },
      { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", desc: "均衡的高性价比日常模型" },
      { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", desc: "极速响应日常编码模型" },
      { id: "gpt-5.5", name: "GPT-5.5 (经典稳定)", desc: "经典全能编码与推理模型" },
      { id: "o3", name: "o3 (深度思维)", desc: "OpenAI 深度思维链" },
      { id: "o4-mini", name: "o4-mini", desc: "轻量高速响应" },
    );
  }
  return {
    tool: "codex",
    available: true,
    path: codexPath,
    models,
    default_model: defaultModel,
    supports_effort: true,
    default_effort: defaultEffort,
    effort_options: [
      { id: "", name: `⚡ 默认 Effort (${defaultEffort})`, desc: `使用本地配置的 reasoning_effort (${defaultEffort})` },
      { id: "low", name: "Low (快速 / 低思考量)", desc: "轻量思考，极速响应，节省 Token" },
      { id: "medium", name: "Medium (标准思考量)", desc: "平衡速度与推理质量，适合日常编程" },
      { id: "high", name: "High (深度推理 / 高思考量)", desc: "深入思维链，攻坚复杂架构与疑难排错" },
    ],
  };
}

const ANTIGRAVITY_MODELS: ModelOption[] = [
  { id: "", name: "⚡ 默认模型 (系统配置: Gemini 3.8 Flash)", desc: "使用当前 Antigravity 默认模型配置", is_default: true },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (High, Fast)", desc: "最新高智能极速响应模型 (Antigravity 默认推荐)" },
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash (Medium, Fast)", desc: "极速日常编码与高吞吐分析" },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash (Fast)", desc: "轻量超低延迟模型" },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro (深度推理)", desc: "高复杂度架构攻坚与深度逻辑推演" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", desc: "原生嵌入 Antigravity 的高阶思维模型" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6 (Thinking)", desc: "顶级架构分析与复杂逻辑推演" },
  { id: "gpt-oss-120b", name: "GPT-OSS 120B (Medium)", desc: "开源高性价比大模型" },
  { id: "flash", name: "Gemini Flash (快速推荐)", desc: "标准 Flash 阶梯 (自动映射最新 Gemini 3.8 Flash)" },
  { id: "pro", name: "Gemini Pro (强力推理)", desc: "标准 Pro 阶梯 (自动映射最新 Gemini 3.1 Pro / Claude)" },
  { id: "flash_lite", name: "Gemini Flash-Lite (超轻量)", desc: "超轻量阶梯 (自动映射 Gemini 3.6 Flash)" },
];

export async function probeCapabilities(home = homeDir()): Promise<Capabilities> {
  const caps: Capabilities = {};
  const claude = await findExecutable(["claude", "claude-code"]);
  if (claude) {
    const info = await claudeCapabilities(claude, home);
    caps.claude = info;
    caps.claude_code = info;
  }
  const codex = await findExecutable(["codex", "codex-cli"]);
  if (codex) caps.codex = await codexCapabilities(codex, home);
  await ensureAgyCliInstalled(home);
  const agy = await findExecutable(["agy", "agy_cli.py", "agentapi"]);
  if (agy) {
    caps.antigravity = {
      tool: "antigravity",
      available: true,
      path: agy,
      models: ANTIGRAVITY_MODELS,
      default_model: "gemini-3.8-flash",
      supports_effort: false,
      default_effort: "",
      effort_options: [],
    };
  }
  return caps;
}
