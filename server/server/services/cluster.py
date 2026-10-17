"""Coordination between api replicas over Redis.

What used to live in one process's memory and must now be seen by every
replica goes through here: which replica holds a device's WebSocket, calls to
that replica, task output streamed to whichever replica waits on it, what
devices report (SharedDict), jobs that must run once, and the replica that
runs the background loops.

Without Redis (or before start()) it behaves like a single process: calls to
"this" replica run locally, locks are this process's own, leases are always
held, publishing is a no-op. Self-hosted single-replica installs keep working
unchanged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from contextlib import asynccontextmanager
from typing import Any

import redis.asyncio as aioredis

from ..config import settings

logger = logging.getLogger("server.cluster")

PREFIX = "memento:cl:"
HEARTBEAT_SECONDS = 20
OWN_TTL = 60  # ownership outlives a missed heartbeat or two
OUTBOX_MAX = 20_000

OpHandler = Callable[[dict], Awaitable[Any]]
ChannelHandler = Callable[[str, dict], Any]


class ClusterUnavailable(Exception):
    """Another replica can't be reached: Redis is down, or that replica is gone."""


class Mutex:
    """A cluster-wide lock held until release(); renewed while held."""

    def __init__(self, cluster: "Cluster", name: str, token: str, ttl: float):
        self._cluster, self.name, self.token, self._ttl = cluster, name, token, ttl
        self._renew: asyncio.Task | None = asyncio.create_task(self._renew_loop())

    async def _renew_loop(self) -> None:
        while True:
            await asyncio.sleep(self._ttl / 3)
            await self._cluster._renew_lock(self.name, self.token, self._ttl)

    async def release(self) -> None:
        if self._renew:
            self._renew.cancel()
            self._renew = None
        await self._cluster.unlock(self.name, self.token)


class Cluster:
    def __init__(self, redis_factory: Callable[[], Any] | None = None, pod_id: str | None = None):
        self.pod_id = pod_id or f"{os.environ.get('HOSTNAME') or socket.gethostname()}-{uuid.uuid4().hex[:6]}"
        self._redis_factory = redis_factory or (lambda: aioredis.from_url(settings.redis_url, decode_responses=True))
        self._r: Any = None
        self.available = False
        self._ops: dict[str, OpHandler] = {"ping": self._ping}
        self._channels: dict[str, ChannelHandler] = {}
        self._patterns: dict[str, ChannelHandler] = {}
        self._pending: dict[str, asyncio.Future] = {}
        self._owned: dict[str, tuple[int, str]] = {}  # key -> (ttl, value)
        # Locks taken while Redis is unavailable: name -> (token, monotonic expiry)
        self._local_locks: dict[str, tuple[str, float]] = {}
        self._outbox: asyncio.Queue | None = None
        self._tasks: list[asyncio.Task] = []
        self._background: set[asyncio.Task] = set()
        self._on_start: list[Callable[[], Awaitable[None]]] = []
        self._on_stop: list[Callable[[], Awaitable[None]]] = []
        self._subscribed = asyncio.Event()

    # ── wiring ────────────────────────────────────────────────────────────
    @property
    def pod_channel(self) -> str:
        return f"{PREFIX}pod:{self.pod_id}"

    def op(self, name: str, handler: OpHandler) -> None:
        """Handle call(…, name, …) from other replicas."""
        self._ops[name] = handler

    def on(self, channel: str, handler: ChannelHandler) -> None:
        """handler(channel, message) for every message published on channel.
        Register at import time: the listener subscribes once, in start()."""
        self._warn_if_started(channel)
        self._channels[channel] = handler

    def on_pattern(self, pattern: str, handler: ChannelHandler) -> None:
        self._warn_if_started(pattern)
        self._patterns[pattern] = handler

    def _warn_if_started(self, channel: str) -> None:
        if self._tasks:
            logger.warning("handler for %s registered after start(); it only takes effect "
                           "once the listener reconnects", channel)

    def on_start(self, fn: Callable[[], Awaitable[None]]) -> None:
        """Run once Redis is reachable (e.g. to load shared caches)."""
        self._on_start.append(fn)

    def on_stop(self, fn: Callable[[], Awaitable[None]]) -> None:
        """Run at stop(), before the connection closes."""
        self._on_stop.append(fn)

    async def start(self) -> None:
        try:
            self._r = self._redis_factory()
            await self._r.ping()
        except Exception as e:
            logger.warning("Redis unreachable, running as a single replica: %s", e)
            self._r = None
            return
        self.available = True
        self._outbox = asyncio.Queue(maxsize=OUTBOX_MAX)
        self._tasks = [
            asyncio.create_task(self._listen()),
            asyncio.create_task(self._publisher()),
            asyncio.create_task(self._heartbeat()),
        ]
        try:
            await asyncio.wait_for(self._subscribed.wait(), timeout=5)
        except asyncio.TimeoutError:
            logger.warning("cluster listener not subscribed after 5s")
        for fn in self._on_start:
            try:
                await fn()
            except Exception as e:
                logger.warning("cluster on_start hook failed: %s", e)
        logger.info("cluster started as %s", self.pod_id)

    async def stop(self) -> None:
        if self.available:
            for fn in self._on_stop:
                try:
                    await fn()
                except Exception as e:
                    logger.warning("cluster on_stop hook failed: %s", e)
        await self.flush()  # let goodbyes queued during shutdown (devices disconnecting) go out
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        if self.available and self._owned:
            try:
                for key, (_, value) in list(self._owned.items()):
                    await self._del_if_mine(key, value)
            except Exception:
                pass
        self._owned.clear()
        self.available = False
        if self._r is not None:
            try:
                await self._r.aclose()
            except Exception:
                pass
            self._r = None

    @property
    def redis(self) -> Any:
        """The command client, or None in single-replica mode."""
        return self._r if self.available else None

    # ── messages ──────────────────────────────────────────────────────────
    def publish(self, channel: str, message: dict) -> None:
        """Queue a message; messages leave in the order they were queued."""
        self._enqueue(channel, {**message, "origin": self.pod_id})

    def write(self, fn: Callable[[Any], Awaitable[Any]]) -> None:
        """Queue fn(redis), run in order with the other writes and messages
        (so a later value can never land before an earlier one)."""
        self._enqueue(None, fn)

    async def flush(self, timeout: float = 2.0) -> None:
        """Wait (up to timeout) until everything queued so far has gone out."""
        if self.available and self._outbox is not None:
            try:
                await asyncio.wait_for(self._outbox.join(), timeout=timeout)
            except asyncio.TimeoutError:
                pass

    def _enqueue(self, channel: str | None, item: Any) -> None:
        if not self.available or self._outbox is None:
            return
        try:
            self._outbox.put_nowait((channel, item))
        except asyncio.QueueFull:
            logger.warning("cluster outbox full, dropping a write for %s", channel or "redis")

    async def _publisher(self) -> None:
        assert self._outbox is not None
        while True:
            channel, item = await self._outbox.get()
            try:
                if channel is None:
                    await item(self._r)
                else:
                    await self._r.publish(channel, json.dumps(item, ensure_ascii=False, default=str))
            except Exception as e:
                logger.warning("cluster write to %s failed: %s", channel or "redis", e)
            finally:
                self._outbox.task_done()

    async def _listen(self) -> None:
        backoff = 1.0
        while True:
            pubsub = self._r.pubsub()
            try:
                await pubsub.subscribe(self.pod_channel, *self._channels)
                if self._patterns:
                    await pubsub.psubscribe(*self._patterns)
                self._subscribed.set()
                backoff = 1.0
                while True:
                    msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                    if msg is None:
                        continue
                    self._dispatch(msg)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("cluster listener lost Redis (%s); reconnecting in %.0fs", e, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)
            finally:
                try:  # say goodbye explicitly so calls to this replica fail fast from now on
                    await asyncio.wait_for(pubsub.unsubscribe(), timeout=1)
                    await asyncio.wait_for(pubsub.punsubscribe(), timeout=1)
                except Exception:
                    pass
                try:
                    await pubsub.aclose()
                except Exception:
                    pass

    def _dispatch(self, msg: dict) -> None:
        channel = msg.get("channel")
        try:
            data = json.loads(msg.get("data") or "{}")
        except (TypeError, ValueError):
            return
        if channel == self.pod_channel:
            kind = data.get("kind")
            if kind == "req":
                self.spawn(self._serve(data))
            elif kind == "res":
                fut = self._pending.get(data.get("req_id") or "")
                if fut and not fut.done():
                    if data.get("ok"):
                        fut.set_result(data.get("result"))
                    else:
                        fut.set_exception(RuntimeError(data.get("error") or "remote call failed"))
            return
        handler = self._channels.get(channel) if msg.get("type") == "message" else self._patterns.get(msg.get("pattern"))
        if handler is None:
            return
        try:
            res = handler(channel, data)
            if asyncio.iscoroutine(res):
                self.spawn(res)
        except Exception as e:
            logger.warning("handler for %s failed: %s", channel, e)

    def spawn(self, coro) -> None:
        """Run coro in the background, keeping a reference (the loop holds tasks only weakly)."""
        task = asyncio.create_task(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    # ── calls between replicas ────────────────────────────────────────────
    async def call(self, pod: str, op: str, payload: dict, timeout: float = 10.0) -> Any:
        """Run op on the given replica and return its result."""
        if pod == self.pod_id:
            return await self._ops[op](payload)
        if not self.available:
            raise ClusterUnavailable(op)
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        try:
            receivers = await self._r.publish(f"{PREFIX}pod:{pod}", json.dumps(
                {"kind": "req", "op": op, "payload": payload, "req_id": req_id, "reply_to": self.pod_id},
                ensure_ascii=False, default=str))
            if not receivers:  # nobody listens on its channel: no need to wait out the timeout
                raise ClusterUnavailable(f"replica {pod} is not listening")
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(req_id, None)

    async def _ping(self, _payload: dict) -> str:
        return self.pod_id

    async def alive(self, pod: str, timeout: float = 1.0) -> bool:
        """Whether that replica answers (a busy one still does within ms)."""
        try:
            await self.call(pod, "ping", {}, timeout=timeout)
            return True
        except Exception:
            return False

    async def _serve(self, data: dict) -> None:
        reply = {"kind": "res", "req_id": data.get("req_id")}
        handler = self._ops.get(data.get("op") or "")
        try:
            if handler is None:
                raise RuntimeError(f"unknown op {data.get('op')}")
            reply.update(ok=True, result=await handler(data.get("payload") or {}))
        except Exception as e:
            reply.update(ok=False, error=str(e))
        try:
            await self._r.publish(f"{PREFIX}pod:{data.get('reply_to')}", json.dumps(reply, ensure_ascii=False, default=str))
        except Exception as e:
            logger.warning("reply for %s failed: %s", data.get("op"), e)

    # ── ownership (key -> replica), re-asserted by the heartbeat ──────────
    # The stored value is this replica's id, or a caller-chosen value that
    # starts with it (e.g. one per run), so two holders on one replica differ.
    async def own(self, key: str, ttl: int = OWN_TTL, value: str | None = None) -> None:
        value = value or self.pod_id
        self._owned[key] = (ttl, value)
        if self.available:
            try:
                await self._r.set(PREFIX + key, value, ex=ttl)
            except Exception as e:
                logger.warning("own %s failed: %s", key, e)

    async def claim(self, key: str, ttl: int = OWN_TTL, value: str | None = None) -> bool:
        """Own key only if nobody else (no other replica, no other value) does."""
        value = value or self.pod_id
        held = self._owned.get(key)
        if held and held[1] != value:
            return False
        if self.available:
            try:
                if not (await self._r.set(PREFIX + key, value, ex=ttl, nx=True)
                        or await self._r.get(PREFIX + key) == value):
                    return False
            except Exception as e:
                logger.warning("claim %s failed, deciding on this replica alone: %s", key, e)
        self._owned[key] = (ttl, value)
        return True

    async def disown(self, key: str, value: str | None = None) -> None:
        value = value or self.pod_id
        held = self._owned.get(key)
        if held and held[1] == value:
            del self._owned[key]
        if self.available:
            try:
                await self._del_if_mine(key, value)
            except Exception as e:
                logger.warning("disown %s failed: %s", key, e)

    async def owner(self, key: str) -> str | None:
        """The stored value: the holder's replica id (or a value starting with it)."""
        if key in self._owned:
            return self._owned[key][1]
        if not self.available:
            return None
        try:
            return await self._r.get(PREFIX + key)
        except Exception:
            return None

    async def owners(self, key_prefix: str) -> dict[str, str]:
        """{key (without the prefix): replica} for every owned key starting with key_prefix.
        Raises if Redis fails mid-way, so callers don't mistake that for "nobody"."""
        if not self.available:
            return {}
        out: dict[str, str] = {}
        keys = [k async for k in self._r.scan_iter(match=f"{PREFIX}{key_prefix}*", count=500)]
        if keys:
            for k, v in zip(keys, await self._r.mget(keys)):
                if v:
                    out[k[len(PREFIX):]] = v
        return out

    async def _del_if_mine(self, key: str, value: str) -> None:
        if await self._r.get(PREFIX + key) == value:
            await self._r.delete(PREFIX + key)

    def forget(self, key: str) -> None:
        """Stop re-asserting key: another replica has taken it over."""
        self._owned.pop(key, None)

    async def _heartbeat(self) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            if not self._owned:
                continue
            try:
                owned = list(self._owned.items())
                holders = await self._r.mget([PREFIX + key for key, _ in owned])
                pipe = self._r.pipeline(transaction=False)
                for (key, (ttl, value)), holder in zip(owned, holders):
                    if holder in (None, value):
                        pipe.set(PREFIX + key, value, ex=ttl)
                    else:  # taken over (e.g. the device reconnected to another replica)
                        self._owned.pop(key, None)
                await pipe.execute()
            except Exception as e:
                logger.warning("cluster heartbeat failed: %s", e)

    # ── locks and leases ──────────────────────────────────────────────────
    async def try_lock(self, name: str, ttl: float) -> str | None:
        """A token if this replica got the lock for ttl seconds, else None."""
        token = uuid.uuid4().hex
        if not self.available:
            return self._try_local_lock(name, token, ttl)
        try:
            ok = await self._r.set(f"{PREFIX}lock:{name}", token, px=int(ttl * 1000), nx=True)
            return token if ok else None
        except Exception as e:
            logger.warning("lock %s failed, using this replica's own lock: %s", name, e)
            return self._try_local_lock(name, token, ttl)

    def _try_local_lock(self, name: str, token: str, ttl: float) -> str | None:
        now = time.monotonic()
        held = self._local_locks.get(name)
        if held and held[1] > now:
            return None
        self._local_locks[name] = (token, now + ttl)
        return token

    async def unlock(self, name: str, token: str) -> None:
        held = self._local_locks.get(name)
        if held and held[0] == token:
            del self._local_locks[name]
        if self.available:
            try:
                await self._del_if_mine(f"lock:{name}", token)
            except Exception as e:
                logger.warning("unlock %s failed: %s", name, e)

    async def locked(self, name: str) -> bool:
        """Whether some replica holds the lock."""
        if self.available:
            try:
                return bool(await self._r.exists(f"{PREFIX}lock:{name}"))
            except Exception as e:
                logger.warning("checking lock %s failed: %s", name, e)
        held = self._local_locks.get(name)
        return bool(held and held[1] > time.monotonic())

    async def _renew_lock(self, name: str, token: str, ttl: float) -> None:
        held = self._local_locks.get(name)
        if held and held[0] == token:
            self._local_locks[name] = (token, time.monotonic() + ttl)
        if not self.available:
            return
        try:
            if await self._r.get(f"{PREFIX}lock:{name}") == token:
                await self._r.pexpire(f"{PREFIX}lock:{name}", int(ttl * 1000))
        except Exception as e:
            logger.warning("renewing lock %s failed: %s", name, e)

    async def mutex(self, name: str, ttl: float = 120.0) -> Mutex | None:
        """Hold name until Mutex.release(), renewed in the background; None if taken."""
        token = await self.try_lock(name, ttl)
        return Mutex(self, name, token, ttl) if token else None

    @asynccontextmanager
    async def leased(self, name: str, ttl: float = 120.0) -> AsyncIterator[bool]:
        """Run a block only on the replica holding the named lease (`async with
        cluster.leased("pulse") as mine: if mine: ...`). The lease is renewed while
        the block runs and kept afterwards, so the same replica keeps the job; if
        it dies another one takes over after ttl."""
        if not await self.hold_lease(name, ttl):
            yield False
            return

        async def renew() -> None:
            while True:
                await asyncio.sleep(ttl / 3)
                await self.hold_lease(name, ttl)

        renewer = asyncio.create_task(renew())
        try:
            yield True
        finally:
            renewer.cancel()

    async def hold_lease(self, name: str, ttl: float) -> bool:
        """True while this replica holds the named lease; call more often than ttl."""
        if not self.available:
            return True
        key = f"{PREFIX}lease:{name}"
        try:
            if await self._r.set(key, self.pod_id, px=int(ttl * 1000), nx=True):
                return True
            if await self._r.get(key) == self.pod_id:
                await self._r.pexpire(key, int(ttl * 1000))
                return True
            return False
        except Exception as e:
            # Skip this round rather than risk two replicas running the job at once
            logger.warning("lease %s failed, skipping: %s", name, e)
            return False


class SharedDict:
    """A small dict every replica sees, for what devices report to the replica
    they're connected to. A write lands here at once, on the other replicas via
    a message, and in Redis for replicas that start later."""

    def __init__(self, cl: Cluster, name: str, ttl: int = 7 * 86400):
        self._cluster, self._ttl = cl, ttl
        self._key = f"{PREFIX}dict:{name}"
        self._channel = f"{PREFIX}dict-set:{name}"
        self.data: dict[str, Any] = {}
        cl.on(self._channel, self._on_message)
        cl.on_start(self._load)

    def set(self, keys: Iterable[str | None], value: Any) -> None:
        """Store value under every (non-empty) key."""
        keys = [k for k in dict.fromkeys(keys) if k]
        if not keys:
            return
        for k in keys:
            self.data[k] = value
        if self._cluster.available:
            self._cluster.publish(self._channel, {"keys": keys, "value": value})
            blob = json.dumps(value, ensure_ascii=False, default=str)
            self._cluster.write(lambda r: self._persist(r, {k: blob for k in keys}))

    async def _persist(self, r: Any, mapping: dict[str, str]) -> None:
        pipe = r.pipeline(transaction=False)
        pipe.hset(self._key, mapping=mapping)
        pipe.expire(self._key, self._ttl)
        await pipe.execute()

    def _on_message(self, _channel: str, msg: dict) -> None:
        if msg.get("origin") == self._cluster.pod_id:
            return
        for k in msg.get("keys") or []:
            self.data[k] = msg.get("value")

    async def _load(self) -> None:
        for k, blob in (await self._cluster.redis.hgetall(self._key)).items():
            try:
                self.data.setdefault(k, json.loads(blob))
            except (TypeError, ValueError):
                continue


cluster = Cluster()
