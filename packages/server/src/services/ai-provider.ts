// Multi-provider OpenAI-compatible LLM client with automatic fallback (server/server/services/ai_provider.py).
import type { Redis } from "ioredis";

import type { Settings } from "../config";
import { reasonForException, reasonForStatus, recordCall } from "./ai-health";
import { modelEndpointViolation } from "./enterprise-policy";
import { revealLlmSettings } from "./secret-box";

export interface AIProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeout: number;
}

const thinkingSwitchRejected = new Set<string>();
const REASONING_RETRY_EXTRA_TOKENS = 8000;
const CUT_RETRY_MAX_TOKENS = 8192;

export function getSystemDefaultLlmInfo(env: Record<string, string | undefined> = process.env) {
  return {
    base_url: (env.MEMENTO_AI_BASE_URL || "https://coding.dashscope.aliyuncs.com/v1").replace(/\/+$/, ""),
    model: (env.MEMENTO_AI_MODEL || "kimi-k2.5").trim(),
    background_model: (env.MEMENTO_AI_BACKGROUND_MODEL || "").trim(),
    has_api_key: Boolean((env.MEMENTO_AI_API_KEY || "").trim()),
    fallback_model: (env.MEMENTO_AI_FALLBACK_MODEL || "qwen3.8-27b").trim(),
  };
}

export function getAiProviders(
  settings: Settings,
  opts: { background?: boolean; user?: { llmSettings?: unknown } | null; customSettings?: Record<string, unknown> | null } = {},
  env: Record<string, string | undefined> = process.env,
): AIProviderConfig[] {
  const providers: AIProviderConfig[] = [];
  const background = Boolean(opts.background);

  let userSettings: Record<string, unknown> | null = opts.customSettings ?? null;
  if (!userSettings && opts.user?.llmSettings && typeof opts.user.llmSettings === "object" && !Array.isArray(opts.user.llmSettings)) {
    userSettings = opts.user.llmSettings as Record<string, unknown>;
  }
  if (userSettings) {
    userSettings = revealLlmSettings(userSettings, settings);
    if (userSettings.custom_enabled && modelEndpointViolation(userSettings, settings)) {
      userSettings = { ...userSettings, custom_enabled: false };
    }
  }

  if (userSettings && userSettings.custom_enabled) {
    const uBase = String(userSettings.base_url ?? "").replace(/\/+$/, "");
    const uKey = String(userSettings.api_key ?? "").trim();
    const uModel = String(userSettings.model ?? "").trim();
    const uBgModel = String(userSettings.background_model ?? "").trim();
    if (uBase && uModel) {
      const effectiveKey = uKey || "no-key-required";
      if (background && uBgModel && uBgModel !== uModel) {
        providers.push({ name: "user_custom_background", baseUrl: uBase, apiKey: effectiveKey, model: uBgModel, timeout: 120 });
      }
      providers.push({ name: "user_custom", baseUrl: uBase, apiKey: effectiveKey, model: uModel, timeout: 120 });
    }
    if (userSettings.fallback_enabled) {
      const fbBase = String(userSettings.fallback_base_url ?? "").replace(/\/+$/, "");
      const fbKey = String(userSettings.fallback_api_key ?? "").trim();
      const fbModel = String(userSettings.fallback_model ?? "").trim();
      if (fbBase && fbModel) {
        providers.push({ name: "user_custom_fallback", baseUrl: fbBase, apiKey: fbKey || "no-key-required", model: fbModel, timeout: 120 });
      }
    }
  }

  const primaryUrl = (env.MEMENTO_AI_BASE_URL || "https://coding.dashscope.aliyuncs.com/v1").replace(/\/+$/, "");
  const primaryKey = (env.MEMENTO_AI_API_KEY || "").trim();
  const primaryModel = (env.MEMENTO_AI_MODEL || "kimi-k2.5").trim();
  const bgModel = (env.MEMENTO_AI_BACKGROUND_MODEL || "").trim();
  if (primaryKey && background && bgModel && bgModel !== primaryModel) {
    providers.push({ name: "primary_background", baseUrl: primaryUrl, apiKey: primaryKey, model: bgModel, timeout: 120 });
  }
  if (primaryKey) {
    providers.push({ name: "primary", baseUrl: primaryUrl, apiKey: primaryKey, model: primaryModel, timeout: 120 });
  }

  const fallbackUrl = (env.MEMENTO_AI_FALLBACK_BASE_URL || "https://oneapi.aiphacas.com/v1").replace(/\/+$/, "");
  const fallbackKey = (env.MEMENTO_AI_FALLBACK_API_KEY || "").trim();
  const fallbackModel = (env.MEMENTO_AI_FALLBACK_MODEL || "qwen3.8-27b").trim();
  const isDup = providers.some((p) => p.apiKey === fallbackKey && p.baseUrl === fallbackUrl);
  if (fallbackKey && !isDup) {
    providers.push({ name: "oneapi_fallback", baseUrl: fallbackUrl, apiKey: fallbackKey, model: fallbackModel, timeout: 120 });
  }

  const rawJson = (env.MEMENTO_AI_PROVIDERS || "").trim();
  if (rawJson) {
    try {
      const extra = JSON.parse(rawJson);
      if (Array.isArray(extra)) {
        extra.forEach((item, idx) => {
          if (item && typeof item === "object" && item.api_key && item.base_url) {
            providers.push({
              name: String(item.name || `provider_${idx + 1}`),
              baseUrl: String(item.base_url).replace(/\/+$/, ""),
              apiKey: String(item.api_key).trim(),
              model: String(item.model || "qwen3.8-27b"),
              timeout: 120,
            });
          }
        });
      }
    } catch {
      /* ignore invalid JSON */
    }
  }
  return providers;
}

export function splitThinking(rawContent: string | null | undefined, reasoningContent?: string | null): [string, string] {
  const parts: string[] = [];
  let clean = (rawContent ?? "").trim();
  if (reasoningContent && reasoningContent.trim()) parts.push(reasoningContent.trim());
  if (clean.includes("<think>")) {
    const re = /<think>([\s\S]*?)(?:<\/think>|$)/g;
    for (const m of clean.matchAll(re)) {
      if (m[1]?.trim()) parts.push(m[1].trim());
    }
    clean = clean.replace(re, "").trim();
  }
  return [parts.join("\n\n").trim(), clean];
}

export function completionProblem(data: Record<string, unknown>): string | null {
  const choices = Array.isArray(data.choices) ? (data.choices as Record<string, unknown>[]) : [];
  if (!choices.length) return "empty";
  const choice = choices[0]!;
  const msg = (choice.message as Record<string, unknown> | undefined) ?? {};
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return null;
  const raw = String(msg.content ?? "");
  const reasoning = String(msg.reasoning_content ?? "");
  const usage = (data.usage as Record<string, unknown> | undefined) ?? {};
  const details = (usage.completion_tokens_details as Record<string, unknown> | undefined) ?? {};
  const reasoningTokens = Number(usage.reasoning_tokens ?? details.reasoning_tokens ?? 0);
  if (choice.finish_reason === "length" && (reasoning.trim() || raw.includes("<think>") || reasoningTokens > 0)) {
    return "reasoning_exhausted";
  }
  const [, answer] = splitThinking(raw, reasoning);
  return answer ? null : "empty";
}

function cutAtCap(data: Record<string, unknown>): boolean {
  const choices = Array.isArray(data.choices) ? (data.choices as Record<string, unknown>[]) : [];
  return choices.length > 0 && choices[0]?.finish_reason === "length";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callChatCompletion(
  settings: Settings,
  redis: Redis | null,
  messages: Record<string, unknown>[],
  opts: {
    tools?: Record<string, unknown>[];
    temperature?: number;
    maxTokens?: number;
    timeoutSec?: number;
    background?: boolean;
    user?: { llmSettings?: unknown } | null;
    customSettings?: Record<string, unknown> | null;
    model?: string | null;
  } = {},
): Promise<[Record<string, unknown>, AIProviderConfig]> {
  let providers = getAiProviders(settings, { background: opts.background, user: opts.user, customSettings: opts.customSettings });
  if (!providers.length) throw new Error("No AI API providers configured (missing API keys)");
  const modelOverride = (opts.model ?? "").trim();
  if (modelOverride) {
    providers = [{ ...providers[0]!, model: modelOverride }, ...providers.slice(1)];
  }
  const maxTokens = opts.maxTokens ?? 1500;
  const temperature = opts.temperature ?? 0.3;
  const timeoutMs = (opts.timeoutSec ?? 120) * 1000;
  const background = Boolean(opts.background);
  const kind = background ? "background" : "interactive";

  const errors: string[] = [];
  const failures: { provider: string; model: string; reason: string; detail: string }[] = [];

  for (let index = 0; index < providers.length; index++) {
    const p = providers[index]!;
    const pKey = `${p.baseUrl}|${p.model}`;
    let budget = maxTokens;
    let switchOffThinking = background && !thinkingSwitchRejected.has(pKey);
    let widened = false;
    let retriedWithoutSwitch = false;
    let rateRetries = 0;
    let cut: Record<string, unknown> | null = null;

    while (true) {
      const reqBody: Record<string, unknown> = {
        model: p.model,
        messages,
        temperature,
        max_tokens: budget,
      };
      if (opts.tools?.length) reqBody.tools = opts.tools;
      if (switchOffThinking) reqBody.thinking = { type: "disabled" };

      const started = performance.now();
      let resp: Response;
      try {
        resp = await fetch(`${p.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (rateRetries < 2) {
          rateRetries++;
          await sleep(1000 * rateRetries);
          continue;
        }
        const msg = `Provider '${p.name}' (${p.baseUrl}, ${p.model}) error: ${(e as Error).message || e}`;
        errors.push(msg);
        failures.push({ provider: p.name, model: p.model, reason: reasonForException(e), detail: String(e) });
        break;
      }

      if ((resp.status === 400 || resp.status === 422) && switchOffThinking && cut === null) {
        switchOffThinking = false;
        retriedWithoutSwitch = true;
        continue;
      }
      if (retriedWithoutSwitch && resp.status === 200) {
        thinkingSwitchRejected.add(pKey);
        retriedWithoutSwitch = false;
      }
      if ((resp.status === 429 || resp.status === 503) && rateRetries < 2) {
        rateRetries++;
        await sleep(1500 * rateRetries);
        continue;
      }
      if (resp.status !== 200) {
        const text = (await resp.text().catch(() => "")).slice(0, 200);
        errors.push(`Provider '${p.name}' (${p.baseUrl}, ${p.model}) returned HTTP ${resp.status}: ${text}`);
        failures.push({ provider: p.name, model: p.model, reason: reasonForStatus(resp.status), detail: `HTTP ${resp.status}: ${text}` });
        break;
      }

      const data = (await resp.json()) as Record<string, unknown>;
      const problem = completionProblem(data);
      const roomier = Math.min(budget * 2, CUT_RETRY_MAX_TOKENS);
      if (problem === null && background && !widened && roomier > budget && cutAtCap(data)) {
        widened = true;
        cut = data;
        failures.push({ provider: p.name, model: p.model, reason: "cut_retry", detail: `max_tokens=${budget}` });
        budget = roomier;
        continue;
      }
      if (problem === null) {
        await recordCall(redis, kind, index === 0 ? "ok" : "fallback", {
          provider: p.name,
          model: p.model,
          latencyMs: performance.now() - started,
          failures,
        });
        return [data, p];
      }
      if (problem === "reasoning_exhausted" && !widened) {
        widened = true;
        budget = maxTokens + REASONING_RETRY_EXTRA_TOKENS;
        failures.push({ provider: p.name, model: p.model, reason: "reasoning_retry", detail: `max_tokens=${maxTokens}` });
        continue;
      }
      errors.push(`Provider '${p.name}' (${p.baseUrl}, ${p.model}) returned no usable answer (${problem}, max_tokens=${budget})`);
      failures.push({ provider: p.name, model: p.model, reason: problem, detail: `max_tokens=${budget}` });
      break;
    }

    if (cut !== null) {
      await recordCall(redis, kind, index === 0 ? "ok" : "fallback", { provider: p.name, model: p.model, failures });
      return [cut, p];
    }
  }

  await recordCall(redis, kind, "failed", { failures });
  throw new Error(`All ${providers.length} AI providers failed: ${errors.join("; ")}`);
}

export async function* streamChatCompletion(
  settings: Settings,
  redis: Redis | null,
  messages: Record<string, unknown>[],
  opts: {
    temperature?: number;
    maxTokens?: number;
    timeoutSec?: number;
    user?: { llmSettings?: unknown } | null;
    customSettings?: Record<string, unknown> | null;
    model?: string | null;
    signal?: AbortSignal;
  } = {},
): AsyncGenerator<{ type: "thinking" | "content"; text: string }, void, void> {
  let providers = getAiProviders(settings, { background: false, user: opts.user, customSettings: opts.customSettings });
  if (!providers.length) throw new Error("No AI API providers configured (missing API keys)");
  const modelOverride = (opts.model ?? "").trim();
  if (modelOverride) {
    providers = [{ ...providers[0]!, model: modelOverride }, ...providers.slice(1)];
  }
  const temperature = opts.temperature ?? 0.3;
  const maxTokens = opts.maxTokens ?? 2500;
  const timeoutMs = (opts.timeoutSec ?? 120) * 1000;

  const errors: string[] = [];
  const failures: { provider: string; model: string; reason: string; detail: string }[] = [];

  for (let index = 0; index < providers.length; index++) {
    const p = providers[index]!;
    let started = false;
    const began = performance.now();
    let streamRetries = 0;

    while (streamRetries <= 2) {
      try {
        const timeoutSig = AbortSignal.timeout(timeoutMs);
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSig]) : timeoutSig;
        const resp = await fetch(`${p.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: p.model, messages, temperature, max_tokens: maxTokens, stream: true }),
          signal,
        });

        if ((resp.status === 429 || resp.status === 503) && streamRetries < 2) {
          streamRetries++;
          await sleep(1500 * streamRetries);
          continue;
        }
        if (resp.status !== 200 || !resp.body) {
          const detail = (await resp.text().catch(() => "")).slice(0, 200);
          errors.push(`Provider '${p.name}' HTTP ${resp.status}: ${detail}`);
          failures.push({ provider: p.name, model: p.model, reason: reasonForStatus(resp.status), detail: `HTTP ${resp.status}: ${detail}` });
          break;
        }

        started = true;
        let inThinkTag = false;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || !line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") break;
            try {
              const chunk = JSON.parse(dataStr) as { choices?: { delta?: { reasoning_content?: string; content?: string } }[] };
              const delta = chunk.choices?.[0]?.delta ?? {};
              const reasoning = delta.reasoning_content || "";
              if (reasoning) yield { type: "thinking", text: reasoning };

              const content = delta.content || "";
              if (content) {
                if (inThinkTag) {
                  const idx = content.indexOf("</think>");
                  if (idx !== -1) {
                    const tPart = content.slice(0, idx);
                    const cPart = content.slice(idx + 8);
                    if (tPart) yield { type: "thinking", text: tPart };
                    inThinkTag = false;
                    if (cPart) yield { type: "content", text: cPart };
                  } else {
                    yield { type: "thinking", text: content };
                  }
                } else {
                  const idx = content.indexOf("<think>");
                  if (idx !== -1) {
                    const cPart = content.slice(0, idx);
                    const rest = content.slice(idx + 7);
                    if (cPart) yield { type: "content", text: cPart };
                    inThinkTag = true;
                    const closeIdx = rest.indexOf("</think>");
                    if (closeIdx !== -1) {
                      const tPart = rest.slice(0, closeIdx);
                      const after = rest.slice(closeIdx + 8);
                      if (tPart) yield { type: "thinking", text: tPart };
                      inThinkTag = false;
                      if (after) yield { type: "content", text: after };
                    } else if (rest) {
                      yield { type: "thinking", text: rest };
                    }
                  } else {
                    yield { type: "content", text: content };
                  }
                }
              }
            } catch {
              continue;
            }
          }
        }

        await recordCall(redis, "stream", index === 0 ? "ok" : "fallback", {
          provider: p.name,
          model: p.model,
          latencyMs: performance.now() - began,
          failures,
        });
        return;
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        errors.push(`Provider '${p.name}' stream error: ${(e as Error).message || e}`);
        failures.push({ provider: p.name, model: p.model, reason: reasonForException(e), detail: String(e) });
        if (started) {
          await recordCall(redis, "stream", "failed", { failures });
          return;
        }
        break;
      }
    }
  }

  await recordCall(redis, "stream", "failed", { failures });
  throw new Error(`All ${providers.length} AI providers failed to stream: ${errors.join("; ")}`);
}

export async function callPlainChat(
  settings: Settings,
  redis: Redis | null,
  messages: Record<string, unknown>[],
  opts: {
    temperature?: number;
    maxTokens?: number;
    timeoutSec?: number;
    user?: { llmSettings?: unknown } | null;
    customSettings?: Record<string, unknown> | null;
    background?: boolean;
  } = {},
): Promise<string | null> {
  try {
    const [data] = await callChatCompletion(settings, redis, messages, {
      temperature: opts.temperature ?? 0.3,
      maxTokens: opts.maxTokens ?? 1500,
      timeoutSec: opts.timeoutSec ?? 120,
      background: opts.background ?? true,
      user: opts.user,
      customSettings: opts.customSettings,
    });
    const choices = Array.isArray(data.choices) ? (data.choices as Record<string, unknown>[]) : [];
    if (choices.length) {
      const msg = (choices[0]!.message as Record<string, unknown> | undefined) ?? {};
      const [, clean] = splitThinking(msg.content as string | undefined, msg.reasoning_content as string | undefined);
      return clean || null;
    }
    return null;
  } catch {
    return null;
  }
}
