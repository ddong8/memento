"""Server configuration via environment variables."""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MEMENTO_")

    # Database
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5433/memento"

    # Redis
    redis_url: str = "redis://localhost:6380/0"

    # S3 / MinIO
    s3_endpoint: str = "http://localhost:9000"
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_bucket: str = "memento"

    # Auth
    secret_key: str = "change-me-in-production"
    algorithm: str = "HS256"
    # 30 days. The web client also calls /api/auth/refresh on mount and
    # every 12 hours while open, so as long as the user opens the app at
    # least once a month they stay logged in indefinitely. Override via
    # MEMENTO_ACCESS_TOKEN_EXPIRE_MINUTES for shared / kiosk deploys
    # where you want shorter sessions.
    access_token_expire_minutes: int = 60 * 24 * 30

    # Collector auth
    collector_token: str = "collector-dev-token"

    # Claude API
    anthropic_api_key: str = ""
    summary_model: str = "claude-sonnet-4-20250514"

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
    #   open        — anyone can self-register (pending, needs admin approval)
    #   invite_only — must provide a valid invite_code at registration
    #   closed      — registration endpoint refuses everyone
    registration_mode: str = "open"

    # GitHub OAuth login — set both to enable "Continue with GitHub".
    github_client_id: str = ""
    github_client_secret: str = ""
    # Public base URL of this deployment (e.g. https://mem.ihasy.com),
    # used to build the OAuth redirect_uri {public_url}/api/auth/github/callback.
    # When unset, the redirect_uri is derived from the incoming request.
    public_url: str = ""

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
