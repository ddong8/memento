/** Strips secrets, tokens and big inline images from text before it leaves the machine. */

const PATTERNS: [RegExp, string][] = [
  // OpenAI / general API keys
  [/sk-[a-zA-Z0-9]{20,}/g, "[API_KEY_REDACTED]"],
  [/sk-ant-[a-zA-Z0-9-]{20,}/g, "[ANTHROPIC_KEY_REDACTED]"],
  [/sk-proj-[a-zA-Z0-9-]{20,}/g, "[OPENAI_KEY_REDACTED]"],
  // GitHub tokens
  [/ghp_[a-zA-Z0-9]{36}/g, "[GITHUB_TOKEN_REDACTED]"],
  [/gho_[a-zA-Z0-9]{36}/g, "[GITHUB_OAUTH_REDACTED]"],
  [/github_pat_[a-zA-Z0-9_]{22,}/g, "[GITHUB_PAT_REDACTED]"],
  // Slack / Telegram tokens
  [/xox[baprs]-[a-zA-Z0-9-]+/g, "[SLACK_TOKEN_REDACTED]"],
  [/bot\d+:[A-Za-z0-9_-]{35}/g, "[TELEGRAM_BOT_TOKEN_REDACTED]"],
  [/\d{8,}:[A-Za-z0-9_-]{35}/g, "[TELEGRAM_TOKEN_REDACTED]"],
  // AWS keys
  [/AKIA[0-9A-Z]{16}/g, "[AWS_ACCESS_KEY_REDACTED]"],
  // Private keys (bounded so a missing END can't make the regex run away)
  [
    /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]{1,4096}?-----END\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gm,
    "[PRIVATE_KEY_REDACTED]",
  ],
  // Generic key=value or key: value
  [
    /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?([^\s"']{8,256})["']?/gi,
    "$1=[REDACTED]",
  ],
  // Bearer tokens in headers
  [/Bearer\s+[a-zA-Z0-9\-_.]+/g, "Bearer [TOKEN_REDACTED]"],
  // Credentials in URLs (https://user:pass@host)
  [/(https?:\/\/)[^\s:]{1,100}:[^\s@]{1,100}@/g, "$1[CREDS_REDACTED]@"],
  // Inline base64 images
  [/data:image\/[a-zA-Z0-9+-]+;base64,[A-Za-z0-9+/=]{100,8192}/g, "[IMAGE_DATA_OMITTED]"],
];

const SENSITIVE_KEYS = new Set([
  "token", "secret", "password", "apikey", "api_key", "accesstoken", "access_token", "refreshtoken",
  "refresh_token", "bottoken", "bot_token", "authtoken", "auth_token", "privatekey", "private_key", "credentials",
]);

export interface SanitizeResult {
  content: string;
  redactionCount: number;
}

function sanitizeChunk(chunk: string): SanitizeResult {
  let count = 0;
  let current = chunk;
  for (const [pattern, replacement] of PATTERNS) {
    try {
      const matches = current.match(pattern);
      if (matches?.length) {
        count += matches.length;
        current = current.replace(pattern, replacement);
      }
    } catch {
      // keep going with the other patterns
    }
  }
  return { content: current, redactionCount: count };
}

export function sanitizeText(text: string): SanitizeResult {
  if (!text) return { content: "", redactionCount: 0 };
  try {
    // Big multi-line text (session logs) goes line by line, so one regex never sees megabytes.
    if (text.length > 64 * 1024 && text.includes("\n")) {
      let total = 0;
      const lines = text.split("\n").map((line) => {
        if (!line) return "";
        const r = sanitizeChunk(line);
        total += r.redactionCount;
        return r.content;
      });
      return { content: lines.join("\n"), redactionCount: total };
    }
    return sanitizeChunk(text);
  } catch {
    return { content: text, redactionCount: 0 };
  }
}

export function sanitizeJson(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(sanitizeJson);
  if (data && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, SENSITIVE_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : sanitizeJson(v)]),
    );
  }
  if (typeof data === "string") return sanitizeText(data).content;
  return data;
}

/** The Flutter collector's 32-bit content hash (UTF-16 code units), kept identical so hashes match across clients. */
export function contentHash(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (Math.imul(31, hash) + s.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

/** Sanitize text or structured JSON/JSONL content before uploading to server. */
export function sanitizeDocumentContent(content: string, contentType: string): string {
  if (contentType === "json") {
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(sanitizeJson(parsed));
    } catch {
      return sanitizeText(content).content;
    }
  }
  if (contentType === "jsonl") {
    try {
      const lines = content.split("\n");
      const sanitizedLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        try {
          const parsed = JSON.parse(trimmed);
          return JSON.stringify(sanitizeJson(parsed));
        } catch {
          return sanitizeText(line).content;
        }
      });
      return sanitizedLines.join("\n");
    } catch {
      return sanitizeText(content).content;
    }
  }
  return sanitizeText(content).content;
}
