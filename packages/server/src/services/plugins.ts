// Plugin Marketplace catalog, sealed config storage and runtime resolution (server/server/services/plugin_service.py).
import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import { HttpError } from "../http";
import { maskSecret, reveal, seal } from "./secret-box";

export interface PluginFieldSpec {
  key: string;
  label: string;
  type: "boolean" | "url" | "secret" | "text";
  required: boolean;
  server_capability?: string;
  placeholder?: string;
  help: string;
}

export interface PluginSpec {
  id: string;
  name: string;
  version: string;
  category: string;
  icon: string;
  entry_route: string;
  summary: string;
  highlights: string[];
  fields: PluginFieldSpec[];
}

export const PLUGIN_CATALOG: PluginSpec[] = [
  {
    id: "studio",
    name: "AI 演播台",
    version: "1.2.0",
    category: "创作生产",
    icon: "film",
    entry_route: "/studio",
    summary: "多引擎 AI 短剧与漫剧制作工作台，支持角色定妆锁定、分镜并发生成、图生视频、对口型与成片回传对话内联播放。",
    highlights: [
      "接入自建或云端 filmkit 引擎，独立管理短剧项目、角色定妆与分镜时间线",
      "成片自动归档至媒体库，支持 HTTP 206 流播与一键推送到对话内联播放",
      "作为工作台扩展插件，安装配置后在 AI 执事工作台与插件市场中解锁，不占用左侧主导航",
    ],
    fields: [
      {
        key: "use_server_default",
        label: "使用当前服务端预置演播台引擎",
        type: "boolean",
        required: false,
        server_capability: "studio_default",
        help: "当前服务端已配置托管 filmkit 引擎时，可直接一键接入，无需手动填写内网地址与密钥。",
      },
      {
        key: "filmkit_url",
        label: "演播台引擎地址 (filmkit URL)",
        type: "url",
        required: true,
        placeholder: "http://127.0.0.1:8765 或 https://studio.example.com",
        help: "自建 filmkit serve 的访问地址（使用服务端预置引擎时可留空）。",
      },
      {
        key: "filmkit_token",
        label: "访问令牌 (Bearer Token)",
        type: "secret",
        required: false,
        placeholder: "可选：对应 filmkit 的 FILMKIT_WEB_PASSWORD",
        help: "服务端加密保存，仅用于代理请求时附带 Authorization 请求头。",
      },
    ],
  },
  {
    id: "wechat_publish",
    name: "公众号一键分发",
    version: "1.1.0",
    category: "内容分发",
    icon: "share",
    entry_route: "",
    summary: "工作台 Markdown 多主题排版预览，一键推送至微信公众号草稿箱，并适配知乎、微博与小红书富文本导出。",
    highlights: [
      "在工作台文档视窗中解锁「分发」入口，支持四套商业排版主题实时预览",
      "对接你自己的微信草稿排版网关（/api/convert 与 /api/wechat/draft），隔离账号与素材库",
      "可自定义默认作者、默认封面 media_id 与文末附带的官网链接",
    ],
    fields: [
      {
        key: "api_base_url",
        label: "排版与草稿推送服务地址",
        type: "url",
        required: true,
        placeholder: "https://wx.example.com",
        help: "提供 /api/convert、/api/wechat/upload-cover 与 /api/wechat/draft 接口的服务根地址。",
      },
      {
        key: "api_token",
        label: "服务鉴权密钥 (可选)",
        type: "secret",
        required: false,
        placeholder: "可选：若推送网关开启鉴权则填写",
        help: "若你的自建网关需要 Bearer 鉴权，可在此填写并加密保存。",
      },
      {
        key: "default_author",
        label: "默认作者名",
        type: "text",
        required: false,
        placeholder: "Memento",
        help: "推送公众号草稿时的默认署名，可在发布弹窗中按篇修改。",
      },
      {
        key: "default_cover_media_id",
        label: "默认封面素材 Media ID",
        type: "text",
        required: false,
        placeholder: "可选：微信永久素材库封面 media_id",
        help: "文章无配图且未手动上传封面时使用的默认封面素材 ID。",
      },
      {
        key: "official_site_url",
        label: "文章附带官网链接",
        type: "url",
        required: false,
        placeholder: "https://mem.ihasy.com",
        help: "推送草稿时附带在文章底部的官网说明链接，留空则不额外追加。",
      },
    ],
  },
];

export const CATALOG_BY_ID: Record<string, PluginSpec> = Object.fromEntries(PLUGIN_CATALOG.map((p) => [p.id, p]));

export function serverHasStudioEngine(settings: Pick<Settings, "studioFilmkitUrl" | "studioFilmkitToken">): boolean {
  const url = (settings.studioFilmkitUrl || "").trim().replace(/\/+$/, "");
  const token = (settings.studioFilmkitToken || "").trim();
  if (!url) return false;
  if ((url === "http://127.0.0.1:8765" || url === "http://localhost:8765") && !token) return false;
  return true;
}

function validateHttpUrl(raw: string, label: string): string {
  const val = (raw || "").trim().replace(/\/+$/, "");
  if (!val) return "";
  try {
    const parsed = new URL(val);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.host) {
      throw new Error("bad");
    }
    return val;
  } catch {
    throw new HttpError(400, `${label}必须是合法的 http:// 或 https:// 地址`);
  }
}

export function sanitizeAndSealConfig(
  settings: Settings,
  pluginId: string,
  incoming: Record<string, unknown>,
  existingSealed?: Record<string, unknown> | null,
): Record<string, unknown> {
  const spec = CATALOG_BY_ID[pluginId];
  if (!spec) throw new HttpError(404, `未知插件: ${pluginId}`);
  const prev = { ...(existingSealed ?? {}) };
  const out: Record<string, unknown> = {};

  for (const field of spec.fields) {
    const key = field.key;
    if (!(key in incoming)) {
      if (key in prev) out[key] = prev[key];
      continue;
    }
    const rawVal = incoming[key];
    if (field.type === "boolean") {
      out[key] = Boolean(rawVal);
    } else if (field.type === "url") {
      const s = String(rawVal ?? "").trim();
      out[key] = s ? validateHttpUrl(s, field.label) : "";
    } else if (field.type === "secret") {
      if (rawVal === "__CLEAR__") {
        out[key] = "";
      } else if (typeof rawVal === "string" && rawVal.trim()) {
        out[key] = seal(rawVal.trim(), settings);
      } else if (key in prev) {
        out[key] = prev[key];
      } else {
        out[key] = "";
      }
    } else {
      out[key] = String(rawVal ?? "").trim().slice(0, 300);
    }
  }

  if (pluginId === "studio" && out.use_server_default && !serverHasStudioEngine(settings)) {
    out.use_server_default = false;
  }
  return out;
}

export function isPluginConfigured(
  settings: Pick<Settings, "studioFilmkitUrl" | "studioFilmkitToken">,
  pluginId: string,
  rawConfig?: Record<string, unknown> | null,
): boolean {
  const cfg = rawConfig ?? {};
  if (pluginId === "studio") {
    if (cfg.use_server_default && serverHasStudioEngine(settings)) return true;
    return Boolean(String(cfg.filmkit_url ?? "").trim());
  }
  if (pluginId === "wechat_publish") {
    return Boolean(String(cfg.api_base_url ?? "").trim());
  }
  return false;
}

function userPluginEntry(user: Pick<UserRow, "pluginSettings"> | null | undefined, pluginId: string): Record<string, unknown> {
  const raw = user?.pluginSettings;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entry = (raw as Record<string, unknown>)[pluginId];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
}

export function publicPluginConfig(
  settings: Pick<Settings, "dataKey" | "secretKey">,
  pluginId: string,
  sealedConfig?: Record<string, unknown> | null,
): Record<string, unknown> {
  const spec = CATALOG_BY_ID[pluginId];
  if (!spec) return {};
  const raw = sealedConfig ?? {};
  const out: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const key = field.key;
    if (field.type === "secret") {
      const val = typeof raw[key] === "string" ? (raw[key] as string) : "";
      const decrypted = val ? reveal(val, settings) : "";
      out[`has_${key}`] = Boolean(decrypted);
      out[`${key}_masked`] = maskSecret(decrypted);
    } else if (field.type === "boolean") {
      out[key] = Boolean(raw[key] ?? false);
    } else {
      out[key] = String(raw[key] ?? "");
    }
  }
  return out;
}

export function getUserPluginsPayload(settings: Settings, user: Pick<UserRow, "pluginSettings"> | null | undefined) {
  const serverCaps = { studio_default: serverHasStudioEngine(settings) };
  const items = PLUGIN_CATALOG.map((spec) => {
    const entry = userPluginEntry(user, spec.id);
    const installed = Boolean(entry.installed ?? false);
    const enabled = installed ? Boolean(entry.enabled ?? true) : false;
    const rawCfg = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? (entry.config as Record<string, unknown>) : {};
    const configured = isPluginConfigured(settings, spec.id, rawCfg);
    const ready = installed && enabled && configured;
    return {
      ...structuredClone(spec),
      installed,
      enabled,
      configured,
      ready,
      installed_at: (entry.installed_at as string | undefined) ?? null,
      updated_at: (entry.updated_at as string | undefined) ?? null,
      config: publicPluginConfig(settings, spec.id, rawCfg),
    };
  });
  return {
    plugins: items,
    server_capabilities: serverCaps,
  };
}

export function nowIso(): string {
  const d = new Date();
  const ms = String(d.getUTCMilliseconds() * 1000).padStart(6, "0");
  return `${d.toISOString().slice(0, 19)}${ms === "000000" ? "" : `.${ms}`}+00:00`;
}
