// /api/profile/llm: user-level custom LLM configuration, presets, agent settings & connectivity test (server/server/api/llm.py).
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { record } from "../audit";
import { currentUser } from "../auth/current-user";
import { auditRequest, type AppEnv } from "../context";
import { withoutNul } from "../db/client";
import { users } from "../db/pulled/schema";
import { HttpError, parseJsonObject } from "../http";
import { getSystemDefaultLlmInfo } from "../services/ai-provider";
import { modelEndpointViolation } from "../services/enterprise-policy";
import { revealLlmSettings, sealLlmSettings } from "../services/secret-box";

export const llmRoutes = new Hono<AppEnv>();

export const PRESETS = [
  {
    id: "anthropic",
    name: "Anthropic 官方 (Claude Opus 5.5 / Sonnet 5.5)",
    icon: "sparkles",
    base_url: "https://api.anthropic.com/v1",
    models: [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
    default_model: "claude-opus-5-5",
    default_background_model: "claude-sonnet-5-5",
    help_url: "https://console.anthropic.com",
  },
  {
    id: "volcengine",
    name: "火山方舟 (Volcengine Ark)",
    icon: "sparkles",
    base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
    models: ["glm-5.3", "glm-5.2", "deepseek-v4.1-flash", "ep-2025..."],
    default_model: "glm-5.3",
    default_background_model: "deepseek-v4.1-flash",
    help_url: "https://www.volcengine.com/product/ark",
  },
  {
    id: "deepseek",
    name: "DeepSeek 官方开放平台",
    icon: "zap",
    base_url: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    default_model: "deepseek-chat",
    default_background_model: "deepseek-chat",
    help_url: "https://platform.deepseek.com",
  },
  {
    id: "dashscope",
    name: "阿里百炼 (DashScope / 通义千问)",
    icon: "cloud",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"],
    default_model: "qwen-plus",
    default_background_model: "qwen-turbo",
    help_url: "https://bailian.console.aliyun.com",
  },
  {
    id: "siliconflow",
    name: "硅基流动 (SiliconFlow)",
    icon: "cpu",
    base_url: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct", "deepseek-ai/DeepSeek-R1"],
    default_model: "deepseek-ai/DeepSeek-V3",
    default_background_model: "deepseek-ai/DeepSeek-V3",
    help_url: "https://siliconflow.cn",
  },
  {
    id: "openai",
    name: "OpenAI 官方",
    icon: "bot",
    base_url: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
    default_model: "gpt-4o",
    default_background_model: "gpt-4o-mini",
    help_url: "https://platform.openai.com",
  },
  {
    id: "ollama",
    name: "Ollama / 本地私有化模型",
    icon: "terminal",
    base_url: "http://localhost:11434/v1",
    models: ["qwen2.5-coder", "deepseek-r1", "llama3.3"],
    default_model: "qwen2.5-coder",
    default_background_model: "qwen2.5-coder",
    help_url: "https://ollama.com",
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容接口",
    icon: "settings",
    base_url: "",
    models: [],
    default_model: "",
    default_background_model: "",
    help_url: "",
  },
];

function maskKey(key: string | null | undefined): string {
  if (!key) return "";
  const k = key.trim();
  if (k.length <= 8) return "******";
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
}

function mementoClientFlag(llmSettings: unknown): boolean {
  if (!llmSettings || typeof llmSettings !== "object" || Array.isArray(llmSettings)) return true;
  const agent = (llmSettings as Record<string, unknown>).agent;
  return !(agent && typeof agent === "object" && (agent as Record<string, unknown>).claude_memento_client === false);
}

llmRoutes.get("/", async (c) => {
  const { settings } = c.var.deps;
  const user = await currentUser(c);
  const saved = revealLlmSettings((user.llmSettings as Record<string, unknown>) ?? {}, settings);
  const rawKey = String(saved.api_key ?? "");
  const rawFbKey = String(saved.fallback_api_key ?? "");
  const primary = String(saved.primary_model || saved.model || "");
  const sysDef = getSystemDefaultLlmInfo();

  const settingsData = {
    custom_enabled: Boolean(saved.custom_enabled ?? false),
    provider: String(saved.provider ?? "custom"),
    base_url: String(saved.base_url ?? ""),
    api_key_masked: maskKey(rawKey),
    has_api_key: Boolean(rawKey),
    model: primary,
    primary_model: primary,
    background_model: String(saved.background_model ?? ""),
    temperature: typeof saved.temperature === "number" ? saved.temperature : 0.7,
    max_tokens: typeof saved.max_tokens === "number" ? saved.max_tokens : 4096,
    fallback_enabled: Boolean(saved.fallback_enabled ?? false),
    fallback_base_url: String(saved.fallback_base_url ?? ""),
    fallback_api_key_masked: maskKey(rawFbKey),
    has_fallback_api_key: Boolean(rawFbKey),
    fallback_model: String(saved.fallback_model ?? ""),
  };

  return c.json({
    status: "ok",
    settings: settingsData,
    ...settingsData,
    system_default: sysDef,
    system_defaults: sysDef,
    presets: PRESETS,
  });
});

llmRoutes.put("/", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);

  const temperature = body.temperature === undefined ? 0.7 : Number(body.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new HttpError(422, [{ type: "greater_than_equal", loc: ["body", "temperature"], msg: "temperature must be between 0.0 and 2.0", input: body.temperature }]);
  }
  const maxTokens = body.max_tokens === undefined ? 4096 : Number(body.max_tokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 65536) {
    throw new HttpError(422, [{ type: "greater_than_equal", loc: ["body", "max_tokens"], msg: "max_tokens must be between 256 and 65536", input: body.max_tokens }]);
  }

  const existing = revealLlmSettings((user.llmSettings as Record<string, unknown>) ?? {}, settings);
  const data: Record<string, unknown> = {
    custom_enabled: Boolean(body.custom_enabled ?? false),
    provider: String(body.provider ?? "custom"),
    base_url: String(body.base_url ?? ""),
    api_key: String(body.api_key ?? ""),
    model: String(body.model ?? ""),
    primary_model: String(body.primary_model ?? ""),
    background_model: String(body.background_model ?? ""),
    temperature,
    max_tokens: maxTokens,
    fallback_enabled: Boolean(body.fallback_enabled ?? false),
    fallback_base_url: String(body.fallback_base_url ?? ""),
    fallback_api_key: String(body.fallback_api_key ?? ""),
    fallback_model: String(body.fallback_model ?? ""),
  };
  if (existing.agent && typeof existing.agent === "object" && !Array.isArray(existing.agent)) {
    data.agent = existing.agent;
  }

  if (!data.model && data.primary_model) data.model = data.primary_model;
  else if (!data.primary_model && data.model) data.primary_model = data.model;

  const incomingKey = String(data.api_key).trim();
  if ((incomingKey && incomingKey.includes("****")) || (!incomingKey && !data.custom_enabled)) {
    data.api_key = String(existing.api_key ?? "");
  }
  const incomingFb = String(data.fallback_api_key).trim();
  if (incomingFb && incomingFb.includes("****")) {
    data.fallback_api_key = String(existing.fallback_api_key ?? "");
  }

  if (data.base_url) data.base_url = String(data.base_url).trim().replace(/\/+$/, "");
  if (data.fallback_base_url) data.fallback_base_url = String(data.fallback_base_url).trim().replace(/\/+$/, "");

  const policyErr = modelEndpointViolation(data, settings);
  if (policyErr) throw new HttpError(403, policyErr);

  await db.update(users).set({ llmSettings: withoutNul(sealLlmSettings(data, settings)) }).where(eq(users.id, user.id));
  await record(db, user, "llm_settings.update", auditRequest(c), {
    detail: { base_url: data.base_url || "", fallback_base_url: data.fallback_base_url || "", custom_enabled: Boolean(data.custom_enabled) },
  });

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (k !== "api_key" && k !== "fallback_api_key") rest[k] = v;
  const settingsResp = {
    ...rest,
    api_key_masked: maskKey(String(data.api_key ?? "")),
    has_api_key: Boolean(data.api_key),
    fallback_api_key_masked: maskKey(String(data.fallback_api_key ?? "")),
    has_fallback_api_key: Boolean(data.fallback_api_key),
  };

  return c.json({
    status: "ok",
    message: "大模型配置已更新并即时生效",
    settings: settingsResp,
    ...settingsResp,
  });
});

llmRoutes.get("/agent", async (c) => {
  const user = await currentUser(c);
  return c.json({ claude_memento_client: mementoClientFlag(user.llmSettings) });
});

llmRoutes.put("/agent", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  if (body.claude_memento_client === null || body.claude_memento_client === undefined) {
    throw new HttpError(422, "没有要修改的设置");
  }
  if (typeof body.claude_memento_client !== "boolean") {
    throw new HttpError(422, [{ type: "bool_parsing", loc: ["body", "claude_memento_client"], msg: "Input should be a valid boolean", input: body.claude_memento_client }]);
  }
  const data = { ...((user.llmSettings as Record<string, unknown>) ?? {}) };
  const agent = data.agent && typeof data.agent === "object" && !Array.isArray(data.agent) ? { ...(data.agent as Record<string, unknown>) } : {};
  agent.claude_memento_client = body.claude_memento_client;
  delete agent.claude_resume_mode;
  delete agent.claude_auto_compact_window;
  data.agent = agent;
  await db.update(users).set({ llmSettings: withoutNul(data) }).where(eq(users.id, user.id));
  return c.json({ claude_memento_client: mementoClientFlag(data) });
});

llmRoutes.post("/test", async (c) => {
  const { settings } = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const saved = revealLlmSettings((user.llmSettings as Record<string, unknown>) ?? {}, settings);
  const sysDef = getSystemDefaultLlmInfo();

  let baseUrl = String(body.base_url ?? "").trim().replace(/\/+$/, "");
  let apiKey = String(body.api_key ?? "").trim();
  let model = String(body.primary_model || body.model || "").trim();

  if (!baseUrl) baseUrl = String(saved.base_url ?? "").trim().replace(/\/+$/, "") || sysDef.base_url;
  if (!model) model = String(saved.primary_model || saved.model || "").trim() || sysDef.model;
  if (!apiKey || apiKey.includes("****")) apiKey = String(saved.api_key ?? "").trim();
  if (!apiKey && baseUrl === sysDef.base_url) apiKey = (process.env.MEMENTO_AI_API_KEY || "").trim();

  const policyErr = modelEndpointViolation({ base_url: baseUrl }, settings);
  if (policyErr) return c.json({ ok: false, success: false, error: policyErr, latency_ms: 0 });
  if (!baseUrl) return c.json({ ok: false, success: false, error: "未指定 API Base URL，请填写端点地址或选择上方服务商预设", latency_ms: 0 });
  if (!model) return c.json({ ok: false, success: false, error: "未指定模型名称，请填写或选择测试的模型", latency_ms: 0 });

  const start = performance.now();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey && apiKey !== "no-key-required") headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "请只回复五个汉字：'大模型连通'，不要输出任何多余内容。" }],
        temperature: 0.1,
        max_tokens: 50,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Math.floor(performance.now() - start);
    if (resp.status !== 200) {
      const errText = (await resp.text().catch(() => "")).slice(0, 300);
      return c.json({ ok: false, success: false, status_code: resp.status, error: `HTTP ${resp.status}: ${errText}`, latency_ms: latencyMs });
    }
    const data = (await resp.json()) as { choices?: { message?: { content?: string; reasoning_content?: string } }[] };
    const msg = data.choices?.[0]?.message;
    const reply = (msg?.content || msg?.reasoning_content || "").trim();
    return c.json({ ok: true, success: true, latency_ms: latencyMs, model, reply: reply || "连通正常（模型握手成功）" });
  } catch (e) {
    const latencyMs = Math.floor(performance.now() - start);
    if ((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") {
      return c.json({ ok: false, success: false, error: "请求超时（超过 15 秒）。请检查 Base URL 是否可访问或服务商网络状态。", latency_ms: latencyMs });
    }
    return c.json({ ok: false, success: false, error: `${(e as Error)?.name || "Error"}: ${(e as Error)?.message || e}`, latency_ms: latencyMs });
  }
});
