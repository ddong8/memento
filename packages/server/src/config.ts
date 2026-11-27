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
    shutdownDrainSeconds: parseIntStrict(s("shutdown_drain_seconds"), 600, "SHUTDOWN_DRAIN_SECONDS"),
    // S3 / MinIO and optional local-folder backend for single-installer desktop mode
    s3Endpoint: s("s3_endpoint", "http://localhost:9000"),
    s3AccessKey: s("s3_access_key", "minioadmin"),
    s3SecretKey: s("s3_secret_key", "minioadmin"),
    s3Bucket: s("s3_bucket", "memento"),
    storageDir: s("storage_dir"),
    // Auth
    secretKey: s("secret_key", "change-me-in-production"),
    algorithm: s("algorithm", "HS256"),
    accessTokenExpireMinutes: parseIntStrict(s("access_token_expire_minutes"), 60 * 24 * 365 * 10, "ACCESS_TOKEN_EXPIRE_MINUTES"),
    dataKey: s("data_key"),
    collectorToken: s("collector_token", "collector-dev-token"),
    // Server
    host: s("host", "0.0.0.0"),
    port: parseIntStrict(s("port"), 8000, "PORT"),
    debug: parseBool(s("debug"), false),
    registrationMode: s("registration_mode", "open"),
    /** own: admins see only their own data; all (default): everyone's (enterprise_policy.sees_all) */
    adminScope: s("admin_scope", "all"),
    allowedModelHosts: s("allowed_model_hosts"),
    passwordLogin: parseBool(s("password_login"), true),
    auditRetentionDays: parseIntStrict(s("audit_retention_days"), 365, "AUDIT_RETENTION_DAYS"),
    remoteExec: (env.MEMENTO_REMOTE_EXEC ?? "").trim() === "1",
    remoteExecPolicy: s("remote_exec_policy", "off"),
    // OAuth / SSO / SCIM
    githubClientId: s("github_client_id"),
    githubClientSecret: s("github_client_secret"),
    wechatToken: s("wechat_token"),
    wechatTokenPrevious: s("wechat_token_previous"),
    oidcIssuer: s("oidc_issuer"),
    oidcClientId: s("oidc_client_id"),
    oidcClientSecret: s("oidc_client_secret"),
    oidcDisplayName: s("oidc_display_name", "企业账号"),
    oidcScopes: s("oidc_scopes", "openid email profile"),
    oidcAllowedDomains: s("oidc_allowed_domains"),
    oidcAutoCreate: parseBool(s("oidc_auto_create"), true),
    oidcAdminGroup: s("oidc_admin_group"),
    scimToken: s("scim_token"),
    publicUrl: s("public_url"),
    /** Optional Next.js standalone upstream URL (e.g. http://127.0.0.1:38770) for single-port standalone mode */
    webUpstream: s("web_upstream").replace(/\/+$/, ""),
    /** Starlette matches the whole origin against it (re.fullmatch) */
    corsAllowOriginRegex: s("cors_allow_origin_regex", ".*"),
    // Studio / Updates
    studioFilmkitUrl: s("studio_filmkit_url", "http://127.0.0.1:8765"),
    studioFilmkitToken: s("studio_filmkit_token"),
    studioLocalVideoDir: s("studio_local_video_dir", "/data2/memento/studio_videos"),
    updatesDir: s("updates_dir"),
    githubRepo: s("github_repo", "ddong8/memento"),
    updateCacheTtl: parseIntStrict(s("update_cache_ttl"), 300, "UPDATE_CACHE_TTL"),
    githubToken: env.GITHUB_TOKEN || env.GH_TOKEN || "",
    // LAN / WebRTC / APNs
    lanUrls: s("lan_urls"),
    stunUrls: s("stun_urls", "stun:stun.miwifi.com:3478,stun:stun.chat.bilibili.com:3478,stun:stun.cloudflare.com:3478"),
    apnsAuthKey: s("apns_auth_key"),
    apnsKeyId: s("apns_key_id", "JMF779PKS9"),
    apnsTeamId: s("apns_team_id", "WHNZV34GK4"),
    apnsBundleId: s("apns_bundle_id", "com.ihasy.memento"),
    apnsProduction: parseBool(s("apns_production"), true),
    // Embeddings (local BGE-M3 or OpenAI-compatible such as SiliconFlow)
    embeddingDim: parseIntStrict(s("embedding_dim"), 1024, "EMBEDDING_DIM"),
    embeddingProvider: s("embedding_provider", "local").trim().toLowerCase(),
    embeddingServerUrl: s("embedding_server_url", "http://host.docker.internal:8002").replace(/\/+$/, ""),
    embeddingApiUrl: s("embedding_api_url", "https://api.siliconflow.cn/v1").replace(/\/+$/, ""),
    embeddingApiKey: s("embedding_api_key"),
    embeddingModel: s("embedding_model", "BAAI/bge-m3"),
    sessionHeavyTokens: parseIntStrict(s("session_heavy_tokens"), 150000, "SESSION_HEAVY_TOKENS"),
    messageAuditMode: s("message_audit_mode", "observe").trim().toLowerCase(),
    enableScheduler: parseBool(s("enable_scheduler"), false),
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
