"""FastAPI application entry point."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .middleware.etag import ETagMiddleware
from .middleware.gzip_request import GzipRequestMiddleware

from .api import admin, ask, auth, collect_exclusions, conversations, daily, dashboard, data_io, devices, documents, events, health, hierarchy, ingest, install_bootstrap, learning, life_rhythm, llm, media, memory, missions, notify, plans, proactive, profile, projects, public, quotas, scim, search, share, skills, sso, studio, todos, tools, updates
# Aliased: `server.api.tasks` (remote device task queue) is a different module
# from the `server.tasks` package (Celery jobs). Importing it bare here would
# read as the latter.
from .api import tasks as device_tasks_api
from .config import settings
from .db.migrations import (
    MIGRATION_LOCK_ID as _MIGRATION_LOCK_ID,
    _run_migrations,  # noqa: F401 - re-exported for tests/scripts
    check_schema_ready,
    run_all_migrations,
)
from .db.session import engine, post_ingest_engine


async def _schedule_daily_compaction():
    """Run memory compaction once per day in background (on one replica: the
    first to get that day's lock)."""
    import asyncio
    from datetime import date
    from .services.cluster import cluster
    await asyncio.sleep(60)  # Wait for startup to complete
    while True:
        try:
            if await cluster.try_lock(f"compaction:{date.today().isoformat()}", 2 * 86400):
                from .db.session import async_session_factory
                from .services.memory_compaction import run_compaction
                async with async_session_factory() as db:
                    await run_compaction(db)
        except Exception as e:
            import logging
            logging.getLogger("compaction").info("Compaction skipped: %s", e)
        await asyncio.sleep(86400)  # Every 24 hours


async def _warm_embedding_server() -> None:
    """Send a single tiny encode request shortly after boot so the first
    real /api/memory/semantic call doesn't pay the BGE-M3 model's
    first-encode cost (model is loaded at embedding-server startup but
    the actual encode pipeline has JIT/cache warmup that can push 5-10 s
    on a cold CPU). 5 s delay lets the api itself finish lifespan first.
    """
    import asyncio, logging
    log = logging.getLogger("memento.warmup")
    await asyncio.sleep(5)
    try:
        from .services.embedding_service import _call_embedding_server
        v = await _call_embedding_server(["warmup"], timeout=30.0)
        if v and v[0]:
            log.info("embedding server warmed (dim=%d)", len(v[0]))
        else:
            log.info("embedding server warmup returned empty — service likely down")
    except Exception as e:
        log.info("embedding warmup skipped: %s", e)


async def _warmup_jieba() -> None:
    """Pre-initialize jieba CJK token dictionary in background thread.

    Jieba loads a 20MB dictionary file and builds a prefix Trie on first cut.
    Warming it up at boot avoids a 1-2s freeze on the first search or ingest.
    """
    import asyncio, logging
    log = logging.getLogger("memento.warmup")
    try:
        def _init():
            try:
                import jieba
                jieba.initialize()
                return True
            except ImportError:
                return False

        loaded = await asyncio.to_thread(_init)
        if loaded:
            log.info("jieba prefix dictionary preloaded")
    except Exception as e:
        log.info("jieba warmup skipped: %s", e)


async def _merge_device_records() -> None:
    """Fold device records left behind by a changed device id (see services/device_merge.py).

    Runs in the background after startup so a slow merge never delays serving.
    """
    import logging
    log = logging.getLogger("memento.devices")
    try:
        from .db.session import async_session_factory
        from .services.cluster import cluster
        from .services.device_merge import merge_duplicate_machines
        if not await cluster.try_lock("merge-device-records", 600):
            return  # another replica that just started is doing it
        async with async_session_factory() as db:
            merged = await merge_duplicate_machines(db)
        for m in merged:
            log.warning("merged device record %s (%s) into %s: moved %s, kept %s",
                        m["from"], m["name"], m["into"], m["moved_counts"], m["kept_counts"])
    except Exception as e:
        log.warning("device record merge skipped: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    import asyncio
    import os
    from sqlalchemy import text
    from .services.ask_runs import ask_runs
    from .services.cluster import cluster
    settings.validate_production()
    skip_ddl = os.getenv("MEMENTO_SKIP_DDL_MIGRATIONS", "").lower() in ("1", "true", "yes")
    if not skip_ddl:
        await run_all_migrations(engine)
    else:
        # Schema compatibility probe for multi-replica Kubernetes rolling updates
        await check_schema_ready(engine)
    # Model API keys users saved before they were encrypted: encrypt them now (idempotent, not DDL)
    try:
        from .services.secret_box import seal_existing
        async with engine.begin() as conn:
            await conn.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": _MIGRATION_LOCK_ID})
            sealed = await conn.run_sync(seal_existing)
        if sealed:
            logging.getLogger("memento.secrets").info("encrypted the saved model API keys of %d users", sealed)
    except Exception:
        logging.getLogger("memento.secrets").exception("encrypting saved model API keys failed; they stay readable as before")
    # Coordination with the other api replicas (device connections, runs, locks)
    await cluster.start()
    # One computer, one device record: fold in records left behind by a changed device id.
    merge_task = asyncio.create_task(_merge_device_records())
    # Daily compaction in the background; dreaming is the nightly Celery task (03:00)
    compaction_task = asyncio.create_task(_schedule_daily_compaction())
    # Fire-and-forget warmup of the embedding server and jieba tokenizer
    warmup_task = asyncio.create_task(_warm_embedding_server())
    jieba_task = asyncio.create_task(_warmup_jieba())
    # Start 24/7 Always-on Proactive Agent Pulse service
    from .services.pulse_service import start_proactive_pulse, stop_proactive_pulse
    await start_proactive_pulse()
    # Collaborative tasks: one replica schedules their steps onto the devices
    from .services.plan_service import hand_over_plans, start_plan_runner, stop_plan_runner
    await start_plan_runner()
    # Mind resonance scenarios learned by dreaming (in the Celery worker): loaded now and every 10 minutes
    from .services.mind_resonance_service import keep_dynamic_scenarios_fresh
    scenarios_task = asyncio.create_task(keep_dynamic_scenarios_fresh())
    yield
    # Out of the load balancer by now: let ask runs finish while their readers
    # reattach through the other replicas, then leave.
    await hand_over_plans()
    await ask_runs.drain(settings.shutdown_drain_seconds)
    await stop_proactive_pulse()
    await stop_plan_runner()
    compaction_task.cancel()
    scenarios_task.cancel()
    warmup_task.cancel()
    jieba_task.cancel()
    merge_task.cancel()
    from .services import bg_tasks
    await bg_tasks.cancel_all()
    await cluster.stop()
    from .services.ai_provider import close_shared_chat_client
    await close_shared_chat_client()
    await post_ingest_engine.dispose()
    await engine.dispose()


app = FastAPI(
    title="Memento",
    description="A shared brain for your AI coding tools — collects, indexes and surfaces conversations, memory, plans across every AI IDE and every device.",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — regex source is settings.cors_allow_origin_regex (see config.py).
# Self-hosted deployments on LAN IPs (192.168.x / 10.x / 172.16-31.x) are
# allowed by default; users with a public custom domain set
# MEMENTO_CORS_ALLOW_ORIGIN_REGEX in .env.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=settings.cors_allow_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(ETagMiddleware)
app.add_middleware(GzipRequestMiddleware)
from .middleware.audit_request import AuditRequestMiddleware  # noqa: E402
app.add_middleware(AuditRequestMiddleware)

# Register routers
app.include_router(dashboard.router)
app.include_router(ingest.router)
app.include_router(collect_exclusions.router)
app.include_router(tools.router)
app.include_router(documents.router)
app.include_router(conversations.router)
app.include_router(projects.router)
app.include_router(daily.router)
app.include_router(search.router)
app.include_router(device_tasks_api.router)
app.include_router(ask.router)
app.include_router(auth.router)
app.include_router(sso.router)
app.include_router(scim.router)
app.include_router(admin.router)
app.include_router(events.router)
app.include_router(devices.router)
app.include_router(hierarchy.router)
app.include_router(memory.router)
app.include_router(profile.router)
app.include_router(llm.router)
app.include_router(notify.router)
app.include_router(health.router)
app.include_router(learning.router)
app.include_router(skills.router)
app.include_router(todos.router)
app.include_router(install_bootstrap.router)
app.include_router(media.router)
app.include_router(studio.router)
app.include_router(public.router)
app.include_router(share.router)
app.include_router(data_io.router)
app.include_router(updates.router)
app.include_router(missions.router)
app.include_router(plans.router)
app.include_router(proactive.router)
app.include_router(life_rhythm.router)
app.include_router(quotas.router)
app.include_router(quotas.compat_router)
app.include_router(quotas.raw_router)
app.include_router(quotas.raw_compat_router)

from .api.ask import get_agent_capabilities, get_agent_models

app.get("/api/agent/capabilities", tags=["agent"])(get_agent_capabilities)
app.get("/api/agent/models", tags=["agent"])(get_agent_models)


@app.get("/")
async def root() -> dict:
    return {
        "name": "Memento",
        "version": "0.1.0",
        "docs": "/docs",
    }


@app.get("/health")
async def health() -> dict:
    # version = the commit this image was built from; the deploy workflow waits for it to go live
    return {"status": "ok", "version": os.environ.get("MEMENTO_BUILD_SHA", "dev")}


@app.get("/health/deep")
async def health_deep():
    """Also checks Postgres and Redis, for the outside monitor: /health stays up while either is down.
    Not the readiness probe: a database hiccup must not take every replica out of the Service at once."""
    import asyncio

    from fastapi.responses import JSONResponse
    from sqlalchemy import text

    from .services.cache import redis_client

    async def db_ok() -> None:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

    async def redis_ok() -> None:
        client = redis_client()
        if client is None or not await client.ping():
            raise RuntimeError("no redis client")

    checks: dict[str, str] = {}
    for name, probe in (("db", db_ok), ("redis", redis_ok)):
        try:
            await asyncio.wait_for(probe(), timeout=5)
            checks[name] = "ok"
        except Exception as e:
            checks[name] = f"error: {type(e).__name__}"
    ok = all(v == "ok" for v in checks.values())
    body = {"status": "ok" if ok else "degraded", "version": os.environ.get("MEMENTO_BUILD_SHA", "dev"), **checks}
    return JSONResponse(body, status_code=200 if ok else 503)
