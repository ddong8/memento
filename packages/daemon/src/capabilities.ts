import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { ensureAgyCliInstalled } from "./antigravity.js";
import { homeDir } from "./config.js";
import { findExecutable } from "./exec-env.js";
import { ensureWorkbuddyCliInstalled, isWorkbuddyInstalled } from "./workbuddy.js";

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
  if (m.includes("opus-5-5") || m.includes("opus-5.5") || m.includes("opus-5_5")) return "Claude Opus 5.5";
  if (m.includes("sonnet-5-5") || m.includes("sonnet-5.5") || m.includes("sonnet-5_5")) return "Claude Sonnet 5.5";
  if (m.includes("haiku-5-5") || m.includes("haiku-5.5") || m.includes("haiku-5_5")) return "Claude Haiku 5.5";
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
  if (/5[_\-.]5/.test(m)) score += 900;
  else if (/5[_\-.]1/.test(m)) score += 800;
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
  "claude-opus-5-5",
  "claude-sonnet-5-5",
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
    { id: "opus", name: "opus (官方动态最新 Opus 别名)", desc: "官方推荐别名，极高智能与超长上下文 (当前自动映射 Claude Opus 5.5)" },
    { id: "sonnet", name: "sonnet (官方动态最新 Sonnet 别名)", desc: "官方推荐别名，自动指向最新主力 (当前自动映射 Claude Sonnet 5.5)" },
    { id: "fable", name: "fable (官方动态最新 Fable 别名)", desc: "官方推荐别名，最强智能体与高阶科学推理 (当前为 Claude Fable 5.1)" },
    { id: "opus[1m]", name: "opus[1m] (100万上下文增强版)", desc: "Claude Opus 深度思维 / 100万 Token 超大上下文" },
    { id: "haiku", name: "haiku (官方动态最新 Haiku 别名)", desc: "官方推荐别名，极速轻量 (当前为 Claude Haiku 4.5)" },
    { id: "claude-opus-5-5", name: "claude-opus-5-5 (Claude Opus 5.5)", desc: "顶尖旗舰架构设计与前沿复杂多步推理 (最新顶级旗舰)" },
    { id: "claude-sonnet-5-5", name: "claude-sonnet-5-5 (Claude Sonnet 5.5)", desc: "最新前沿主力编码与多模态推理模型 (最新主力)" },
    { id: "opus-5.5", name: "opus-5.5 (Claude Opus 5.5 简写)", desc: "Claude Opus 5.5 快速别名" },
    { id: "sonnet-5.5", name: "sonnet-5.5 (Claude Sonnet 5.5 简写)", desc: "Claude Sonnet 5.5 快速别名" },
  ];
  const seen = new Set(models.map((m) => m.id));
  if (defaultModel && !seen.has(defaultModel)) {
    models.push({ id: defaultModel, name: `${defaultModel} (当前本地配置)`, desc: "本地 ~/.claude/settings.json 中配置的模型" });
    seen.add(defaultModel);
  }

  // 1. 自动提取本地 ~/.claude/settings.json 中 modelSettings 配置的任意自定义与最新模型
  const modelSettings = (settings?.modelSettings && typeof settings.modelSettings === "object")
    ? (settings.modelSettings as Record<string, unknown>)
    : {};
  for (const configuredModel of Object.keys(modelSettings)) {
    if (configuredModel && !seen.has(configuredModel)) {
      seen.add(configuredModel);
      models.push({
        id: configuredModel,
        name: `${configuredModel} (${formatClaudeDisplayName(configuredModel)} · 本地配置)`,
        desc: "在 ~/.claude/settings.json 中配置的模型",
      });
    }
  }

  // 2. 自动拉取：尝试从 Anthropic API / 本地配置的反代 Base URL 动态探测获取最新模型列表
  const envConfig = (settings?.env && typeof settings.env === "object") ? (settings.env as Record<string, string>) : {};
  const baseUrl = envConfig.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;
  const authToken = envConfig.ANTHROPIC_AUTH_TOKEN || envConfig.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (baseUrl || authToken) {
    try {
      const endpoint = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/v1/models` : "https://api.anthropic.com/v1/models";
      const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
      if (authToken) {
        if (authToken.startsWith("sk-ant-")) headers["x-api-key"] = authToken;
        else headers["Authorization"] = `Bearer ${authToken}`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(endpoint, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const payload = (await res.json()) as any;
        const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
        for (const item of list) {
          const mid = String(item?.id || item?.name || "");
          if (mid && mid.toLowerCase().includes("claude-") && !seen.has(mid)) {
            seen.add(mid);
            models.push({
              id: mid,
              name: `${mid} (${formatClaudeDisplayName(mid)} · 动态拉取)`,
              desc: "从 Anthropic API 动态获取到的最新可用模型",
            });
          }
        }
      }
    } catch {
      // 忽略网络或证书错误，优雅回退
    }
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

  // 扫描 Node/NVM 版本目录中的全局 Claude Code 二进制与脚本
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  try {
    const nvmVersions = join(nvmDir, "versions", "node");
    if (existsSync(nvmVersions)) {
      for (const ver of readdirSync(nvmVersions)) {
        candidates.push(
          join(nvmVersions, ver, "lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
          join(nvmVersions, ver, "lib/node_modules/@anthropic-ai/claude-code/cli.js"),
          join(nvmVersions, ver, "bin/claude"),
        );
      }
    }
  } catch {
    // ignore
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

const WORKBUDDY_BUILTIN_MODELS: ModelOption[] = [
  { id: "deep-model", name: "极致 (Deep Model)", desc: "旗舰模型组合，专为复杂决策与高难度任务打造" },
  { id: "balanced-model", name: "均衡 (Balanced Model)", desc: "性能与成本兼顾，稳定应对日常工作" },
  { id: "fast-model", name: "快速 (Fast Model)", desc: "低成本极速响应，适合轻量高频操作" },
  { id: "hy4-preview", name: "Tencent HY 4.0 Preview", desc: "腾讯混元旗舰大模型 4.0 预览版" },
  { id: "hy3-x", name: "Tencent HY 3.0-X", desc: "腾讯混元 3.0 增强推理模型" },
  { id: "hy3", name: "Tencent HY 3.0", desc: "腾讯混元 3.0 主力大模型" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", desc: "DeepSeek V4 旗舰深度推理模型" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", desc: "DeepSeek V4.1 高速响应模型" },
  { id: "glm-5.3", name: "GLM-5.3", desc: "智谱旗舰编码与 Agent 模型" },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", desc: "智谱高速轻量模型" },
  { id: "glm-5.2", name: "GLM-5.2", desc: "智谱主力通用大模型" },
  { id: "glm-5.1", name: "GLM-5.1", desc: "智谱稳定编码模型" },
  { id: "glm-5v-turbo", name: "GLM-5V-Turbo", desc: "智谱多模态视觉极速模型" },
  { id: "minimax-m3", name: "MiniMax-M3", desc: "MiniMax M3 原生智能体模型" },
  { id: "kimi-k3-1", name: "Kimi-K3.1", desc: "月之暗面 Kimi K3.1 旗舰长上下文模型" },
  { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview", desc: "月之暗面 Kimi K2.8 预览版" },
  { id: "kimi-k2.7", name: "Kimi-K2.7", desc: "月之暗面 Kimi K2.7 模型" },
  { id: "kimi-k2.6", name: "Kimi-K2.6", desc: "月之暗面 Kimi K2.6 模型" },
];

async function workbuddyCapabilities(wbPath: string, home: string): Promise<Record<string, unknown>> {
  const modelsConfig = await readJson(join(home, ".workbuddy", "models.json"));
  const customModels: ModelOption[] = [];
  if (Array.isArray(modelsConfig?.models)) {
    for (const raw of modelsConfig.models) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const rawId = String(m.id ?? "").trim();
      if (!rawId) continue;
      const fullId = rawId.startsWith("custom-local:") ? rawId : `custom-local:${rawId}`;
      const displayName = String(m.name ?? rawId).trim();
      const vendor = String(m.vendor ?? "Custom").trim();
      customModels.push({
        id: fullId,
        name: `${displayName} (自定义模型)`,
        desc: `${vendor}${m.url ? ` · ${String(m.url)}` : ""}`,
      });
    }
  }

  const models: ModelOption[] = [
    {
      id: "",
      name: "⚡ 默认模型 (跟随 WorkBuddy 配置)",
      desc: "使用当前 WorkBuddy 客户端配置的默认模型",
      is_default: true,
    },
    ...customModels,
    ...WORKBUDDY_BUILTIN_MODELS,
  ];

  return {
    tool: "workbuddy",
    available: true,
    path: wbPath,
    models,
    default_model: "",
    supports_effort: true,
    default_effort: "medium",
    effort_options: [
      { id: "", name: "⚡ 默认思考量 (跟随 WorkBuddy 配置)", desc: "使用当前模型默认思考深度" },
      { id: "minimal", name: "Minimal (极简思考)", desc: "最低思考开销，极速直出" },
      { id: "low", name: "Low (低思考量)", desc: "轻量思考，快速响应" },
      { id: "medium", name: "Medium (中等思考量)", desc: "平衡推理速度与深度" },
      { id: "high", name: "High (高思考量)", desc: "深入推理，适合复杂编码" },
      { id: "xhigh", name: "XHigh (超高思考量)", desc: "高强度多步逻辑推演" },
      { id: "max", name: "Max (最大思考量)", desc: "全量深度思维链探索" },
    ],
  };
}

export async function probeEnvironmentFingerprint(home = homeDir()): Promise<Record<string, unknown>> {
  const [gitExe, pyExe, dockerExe, cargoExe, pnpmExe] = await Promise.all([
    findExecutable(["git"]),
    findExecutable(["python3", "python"]),
    findExecutable(["docker"]),
    findExecutable(["cargo"]),
    findExecutable(["pnpm"]),
  ]);

  const devDirs = ["Desktop/dev", "dev", "projects", "code", "workspace", "src"]
    .map((sub) => join(home, sub))
    .filter((dir) => existsSync(dir));

  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER || process.env.USERNAME || "";
  }

  return {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    hostname: os.hostname(),
    username,
    home,
    shell: process.env.SHELL || process.env.ComSpec || (os.platform() === "win32" ? "powershell.exe" : "/bin/bash"),
    tools: {
      git: gitExe ? "available" : undefined,
      node: process.version,
      python: pyExe ? "available" : undefined,
      docker: dockerExe ? "available" : undefined,
      cargo: cargoExe ? "available" : undefined,
      pnpm: pnpmExe ? "available" : undefined,
    },
    workspaces: devDirs,
    probed_at: new Date().toISOString(),
  };
}

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
  if (isWorkbuddyInstalled(home)) {
    await ensureWorkbuddyCliInstalled(home);
  }
  const wb = await findExecutable(["workbuddy", "workbuddy_cli.mjs", "codebuddy"]);
  if (wb && isWorkbuddyInstalled(home)) {
    caps.workbuddy = await workbuddyCapabilities(wb, home);
  }
  try {
    caps.environment = await probeEnvironmentFingerprint(home);
  } catch {
    // Ignore environment probing failures
  }
  return caps;
}
