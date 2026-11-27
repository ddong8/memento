// Settings from the environment, the same MEMENTO_* variables and defaults as server/server/config.py
// (both servers run side by side during the migration and must agree on secrets, URLs and policies).

type Env = Record<string, string | undefined>;

/** pydantic's bool parsing: 1/0, true/false, yes/no, on/off, t/f, y/n, any case. */
export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on", "t", "y"].includes(v)) return true;
  if (["0", "false", "no", "off", "f", "n"].includes(v)) return false;
  throw new Error(`not a boolean: ${raw}`);
}

function parseIntStrict(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n)) throw new Error(`MEMENTO_${name} must be an integer, got ${raw}`);
  return n;
}

/** SQLAlchemy's URL (postgresql+asyncpg://) as a plain postgres:// URL. */
export function plainDatabaseUrl(url: string): string {
  return url.replace(/^postgres(?:ql)?\+[a-z0-9]+:\/\//i, "postgres://").replace(/^postgresql:\/\//i, "postgres://");
}

export function loadSettings(env: Env = process.env) {
  const s = (name: string, fallback = "") => env[`MEMENTO_${name.toUpperCase()}`] ?? fallback;
  const settings = {
    databaseUrl: plainDatabaseUrl(s("database_url", "postgresql+asyncpg://postgres:postgres@localhost:5433/memento")),
    redisUrl: s("redis_url", "redis://localhost:6380/0"),
    secretKey: s("secret_key", "change-me-in-production"),
    algorithm: s("algorithm", "HS256"),
    accessTokenExpireMinutes: parseIntStrict(s("access_token_expire_minutes"), 60 * 24 * 365 * 10, "ACCESS_TOKEN_EXPIRE_MINUTES"),
    collectorToken: s("collector_token", "collector-dev-token"),
    host: s("host", "0.0.0.0"),
    port: parseIntStrict(s("port"), 8000, "PORT"),
    debug: parseBool(s("debug"), false),
    registrationMode: s("registration_mode", "open"),
    /** own: admins see only their own data; all (default): everyone's (enterprise_policy.sees_all) */
    adminScope: s("admin_scope", "all"),
    passwordLogin: parseBool(s("password_login"), true),
    githubClientId: s("github_client_id"),
    githubClientSecret: s("github_client_secret"),
    wechatToken: s("wechat_token"),
    oidcIssuer: s("oidc_issuer"),
    oidcClientId: s("oidc_client_id"),
    oidcClientSecret: s("oidc_client_secret"),
    oidcDisplayName: s("oidc_display_name", "企业账号"),
    publicUrl: s("public_url"),
    /** Starlette matches the whole origin against it (re.fullmatch) */
    corsAllowOriginRegex: s("cors_allow_origin_regex", ".*"),
    /** The commit this build is from; /health reports it (the deploy job waits for it). */
    buildSha: env.MEMENTO_BUILD_SHA ?? "dev",
  };
  return settings;
}

export type Settings = ReturnType<typeof loadSettings>;

/** Refuse to start with the development defaults when debug is off (config.py validate_production). */
export function validateProduction(settings: Settings, env: Env = process.env): void {
  const bad: string[] = [];
  if (settings.secretKey === "change-me-in-production") bad.push("MEMENTO_SECRET_KEY");
  if (settings.collectorToken === "collector-dev-token") bad.push("MEMENTO_COLLECTOR_TOKEN");
  if (bad.length && !settings.debug) {
    throw new Error(`Insecure defaults detected in non-debug mode: ${bad.join(", ")}. Set these or export MEMENTO_DEBUG=1 for local dev.`);
  }
  void env;
}
