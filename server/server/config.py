"""Server configuration via environment variables."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MEMENTO_")

    # Database
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5433/memento"

    # Redis (also how api replicas coordinate, see services/cluster.py)
    redis_url: str = "redis://localhost:6380/0"
    # On shutdown (e.g. a rolling deploy), how long to let ask runs in progress
    # finish before stopping them. Keep the pod's terminationGracePeriodSeconds above
    # preStop + uvicorn's graceful timeout + this.
    shutdown_drain_seconds: int = 600

    # S3 / MinIO
    s3_endpoint: str = "http://localhost:9000"
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_bucket: str = "memento"

    # Auth
    secret_key: str = "change-me-in-production"
    algorithm: str = "HS256"
    # Default 10 years (essentially permanent login until explicit logout).
    # Override via MEMENTO_ACCESS_TOKEN_EXPIRE_MINUTES for shared / kiosk deploys
    # where you want shorter sessions.
    access_token_expire_minutes: int = 60 * 24 * 365 * 10

    # Key for encrypting secrets stored in the database (users' model API keys, services/secret_box.py).
    # Empty: derived from secret_key. Changing it makes the stored keys unreadable (users re-enter them).
    data_key: str = ""

    # Collector auth
    collector_token: str = "collector-dev-token"

    # Claude API
    anthropic_api_key: str = ""
    summary_model: str = "claude-sonnet-4-20250514"

    # Checking conversation_messages against each conversation's text (services/message_audit.py):
    # "observe" records what it finds, "repair" also fixes it, "off" stops it. Repairing since 10-30, after
    # observing the first 200: what it inserts are parallel tool calls an old dedup key dropped, what it
    # deletes are copies an offline buffer replayed (kept in conversation_messages_removed)
    message_audit_mode: str = "repair"

    # Large file threshold (bytes) — files bigger go to S3
    large_file_threshold: int = 1_048_576  # 1 MB

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False

    # CORS — which origins the browser is allowed to call the API from.
    # Default `.*` accepts ANY origin. Convenient for self-hosted users
    # who put their server on whatever LAN IP / DDNS hostname / Tailscale
    # tailnet they happen to have — no .env tweak needed.
    #
    # Security caveat: this means any site a logged-in user visits can
    # make authenticated requests to their Memento API via the user's
    # browser cookies/JWT. The JWT lives in localStorage (not a cookie),
    # so it's not auto-sent by the browser, which mitigates most of the
    # classic CSRF risk — but if you serve this on the public internet,
    # set MEMENTO_CORS_ALLOW_ORIGIN_REGEX in .env to your domain(s) only.
    cors_allow_origin_regex: str = r".*"

    # Registration control:
    #   open        — anyone can self-register and is active right away (viewer)
    #   invite_only — must provide a valid invite_code at registration
    #   closed      — registration endpoint refuses everyone
    registration_mode: str = "open"

    # ---- Enterprise deployment (docs/enterprise.md) ----
    # What admins and owners see of other users' content (conversations, memory, devices, tasks):
    #   all — everything (a personal or family deployment; the behavior before this setting)
    #   own — only their own, like everyone else; they still manage accounts, invites and permissions
    admin_scope: str = "all"
    # Model endpoints users may configure for themselves, comma-separated host names
    # (e.g. "llm.corp.example.com,api.anthropic.com"; "*.corp.example.com" for subdomains). Empty: any.
    allowed_model_hosts: str = ""
    # Email + password login; turn off once everyone signs in through the company's identity provider
    password_login: bool = True
    # How long the audit log keeps entries, in days (0 keeps them forever)
    audit_retention_days: int = 365
    # Commands an agent on another device runs on the computer the code is on (memento-source), and
    # files it writes there outside the project:
    #   off          — refuse nothing; risky ones (sudo, writing /etc or ~/.ssh, rm -rf…) run and the user's
    #                  phone is told (11-19: the user asked for reminders instead of refusals)
    #   catastrophic — also refuse what wrecks that computer (formatting a disk, rm -rf of / or the home
    #                  folder, shutting it down)
    #   strict       — refuse every risky command and sensitive file (the rule before 11-19)
    remote_exec_policy: str = "off"

    # Single sign-on with any OpenID Connect provider (Keycloak, Authing, Azure AD / Entra ID,
    # Okta, Google Workspace, ...). Set issuer + client id + secret to enable it.
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    # Button text on the login page
    oidc_display_name: str = "企业账号"
    oidc_scopes: str = "openid email profile"
    # Only these email domains may sign in (comma-separated, empty: any the provider vouches for)
    oidc_allowed_domains: str = ""
    # Create an account the first time someone signs in (off: only accounts an admin made or invited)
    oidc_auto_create: bool = True
    # Members of this group (from the provider's "groups" claim) sign in as admin; others as viewer
    oidc_admin_group: str = ""

    # SCIM 2.0 provisioning (/scim/v2): the identity provider creates and deactivates accounts.
    # Bearer token the provider sends; empty disables the endpoint.
    scim_token: str = ""

    # GitHub OAuth login — set both to enable "Continue with GitHub".
    github_client_id: str = ""
    github_client_secret: str = ""
    # Public base URL of this deployment (e.g. https://mem.ihasy.com),
    # used to build the OAuth redirect_uri {public_url}/api/auth/github/callback.
    # When unset, the redirect_uri is derived from the incoming request.
    public_url: str = ""

    # WeChat Official Account webhook: the Token set under 消息与事件推送 in the WeChat
    # developer platform. Empty disables WeChat login. While rotating it, keep the old
    # value in wechat_token_previous until the platform has been switched over.
    wechat_token: str = ""
    wechat_token_previous: str = ""

    # Devices on the same LAN as the server talk to it directly instead of through the public entry
    # (comma-separated base URLs, e.g. http://<lan address>:<port>; requests carry the public host).
    # Kept in the cluster's config, never in this repository.
    lan_urls: str = ""
    # STUN servers for direct (WebRTC) file transfer between the browser and a device; ones that answer
    # from mainland China. No TURN: relaying would go through the same small public link.
    stun_urls: str = "stun:stun.miwifi.com:3478,stun:stun.chat.bilibili.com:3478,stun:stun.cloudflare.com:3478"

    # Apple Push Notification Service (APNs) for iOS offline background & lock-screen pushes
    apns_auth_key: str = ""  # Raw PEM content of AuthKey_xxx.p8
    apns_key_id: str = "JMF779PKS9"
    apns_team_id: str = "WHNZV34GK4"
    apns_bundle_id: str = "com.ihasy.memento"
    apns_production: bool = True

    # Studio (演播台 / filmkit 渲染引擎桥接地址与离线视频本地兜底目录)
    studio_filmkit_url: str = "http://127.0.0.1:8765"
    studio_filmkit_token: str = ""
    studio_local_video_dir: str = "/data2/memento/studio_videos"

    def validate_production(self) -> None:
        """Refuse to start with dev defaults when debug is off."""
        bad = []
        if self.secret_key == "change-me-in-production":
            bad.append("MEMENTO_SECRET_KEY")
        if self.collector_token == "collector-dev-token":
            bad.append("MEMENTO_COLLECTOR_TOKEN")
        if self.s3_access_key == "minioadmin" or self.s3_secret_key == "minioadmin":
            bad.append("MEMENTO_S3_ACCESS_KEY/MEMENTO_S3_SECRET_KEY")
        if bad and not self.debug:
            raise RuntimeError(
                "Insecure defaults detected in non-debug mode: "
                + ", ".join(bad)
                + ". Set these in .env or export MEMENTO_DEBUG=1 for local dev."
            )


settings = Settings()
