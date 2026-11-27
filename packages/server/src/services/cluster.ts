// Cross-replica coordination over Redis, wire-compatible with server/server/services/cluster.py.
// Same key/channel prefix ("memento:cl:") so Python and TypeScript replicas interoperate during migration.
// Without Redis (single-installer desktop mode) degrades cleanly to single-process behavior.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { Redis } from "ioredis";

export const PREFIX = "memento:cl:";
export const HEARTBEAT_SECONDS = 20;
export const OWN_TTL = 60;

export type OpHandler = (payload: Record<string, unknown>) => Promise<unknown> | unknown;
export type ChannelHandler = (channel: string, msg: Record<string, unknown>) => Promise<void> | void;

export class ClusterUnavailable extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ClusterUnavailable";
  }
}

export class Mutex {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly cl: Cluster,
    readonly name: string,
    readonly token: string,
    private readonly ttl: number,
  ) {
    this.timer = setInterval(() => {
      void this.cl.renewLock(this.name, this.token, this.ttl);
    }, Math.max(1000, (ttl / 3) * 1000));
    this.timer.unref?.();
  }

  async release(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.cl.unlock(this.name, this.token);
  }
}

export class Cluster {
  readonly podId: string;
  private cmd: Redis | null = null;
  private sub: Redis | null = null;
  available = false;
  private ops = new Map<string, OpHandler>();
  private channels = new Map<string, ChannelHandler>();
  private patterns = new Map<string, ChannelHandler>();
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private owned = new Map<string, [number, string]>();
  private localLocks = new Map<string, [string, number]>();
  private onStartHooks: (() => Promise<void>)[] = [];
  private onStopHooks: (() => Promise<void>)[] = [];
  private hbTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(podId?: string) {
    this.podId = podId || `ts-${process.env.HOSTNAME || hostname()}-${randomUUID().replaceAll("-", "").slice(0, 6)}`;
    this.ops.set("ping", () => this.podId);
  }

  get podChannel(): string {
    return `${PREFIX}pod:${this.podId}`;
  }

  get redis(): Redis | null {
    return this.available ? this.cmd : null;
  }

  op(name: string, handler: OpHandler): void {
    this.ops.set(name, handler);
  }

  on(channel: string, handler: ChannelHandler): void {
    this.channels.set(channel, handler);
    if (this.sub && this.available) void this.sub.subscribe(channel).catch(() => {});
  }

  onPattern(pattern: string, handler: ChannelHandler): void {
    this.patterns.set(pattern, handler);
    if (this.sub && this.available) void this.sub.psubscribe(pattern).catch(() => {});
  }

  onStart(fn: () => Promise<void>): void {
    this.onStartHooks.push(fn);
  }

  onStop(fn: () => Promise<void>): void {
    this.onStopHooks.push(fn);
  }

  async start(redisUrl: string): Promise<void> {
    if (!redisUrl) return;
    try {
      const cmd = new Redis(redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 3000, enableOfflineQueue: true });
      cmd.on("error", () => {});
      await cmd.ping();
      const sub = new Redis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 3000 });
      sub.on("error", () => {});
      this.cmd = cmd;
      this.sub = sub;
      this.available = true;

      sub.on("message", (channel, raw) => this.dispatch("message", channel, "", raw));
      sub.on("pmessage", (pattern, channel, raw) => this.dispatch("pmessage", channel, pattern, raw));
      sub.on("ready", () => {
        const chs = [this.podChannel, ...this.channels.keys()];
        if (chs.length) void sub.subscribe(...chs).catch(() => {});
        const pats = [...this.patterns.keys()];
        if (pats.length) void sub.psubscribe(...pats).catch(() => {});
      });

      const chs = [this.podChannel, ...this.channels.keys()];
      if (chs.length) await sub.subscribe(...chs);
      const pats = [...this.patterns.keys()];
      if (pats.length) await sub.psubscribe(...pats);

      this.hbTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_SECONDS * 1000);
      this.hbTimer.unref?.();

      for (const fn of this.onStartHooks) {
        await fn().catch(() => {});
      }
    } catch {
      this.cmd?.disconnect();
      this.sub?.disconnect();
      this.cmd = null;
      this.sub = null;
      this.available = false;
    }
  }

  async stop(): Promise<void> {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
    if (this.available) {
      for (const fn of this.onStopHooks) await fn().catch(() => {});
      await this.flush();
      for (const [key, [, value]] of [...this.owned.entries()]) {
        await this.delIfMine(key, value).catch(() => {});
      }
    }
    this.owned.clear();
    this.available = false;
    await Promise.allSettled([this.sub?.quit(), this.cmd?.quit()]);
    this.sub = null;
    this.cmd = null;
  }

  publish(channel: string, message: Record<string, unknown>): void {
    if (!this.available || !this.cmd) return;
    const payload = JSON.stringify({ ...message, origin: this.podId });
    this.write(async (r) => {
      await r.publish(channel, payload);
    });
  }

  write(fn: (r: Redis) => Promise<unknown>): void {
    if (!this.available || !this.cmd) return;
    const r = this.cmd;
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.available) return;
        await fn(r);
      })
      .catch(() => {});
  }

  async flush(): Promise<void> {
    await this.writeChain.catch(() => {});
  }

  private dispatch(type: "message" | "pmessage", channel: string, pattern: string, raw: string) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw || "{}") as Record<string, unknown>;
    } catch {
      return;
    }
    if (channel === this.podChannel) {
      if (data.kind === "req") {
        void this.serve(data);
      } else if (data.kind === "res") {
        const reqId = String(data.req_id ?? "");
        const p = this.pending.get(reqId);
        if (p) {
          this.pending.delete(reqId);
          clearTimeout(p.timer);
          if (data.ok) p.resolve(data.result);
          else p.reject(new Error(String(data.error || "remote call failed")));
        }
      }
      return;
    }
    const handler = type === "message" ? this.channels.get(channel) : this.patterns.get(pattern);
    if (!handler) return;
    try {
      const res = handler(channel, data);
      if (res && typeof (res as Promise<void>).catch === "function") (res as Promise<void>).catch(() => {});
    } catch {
      /* isolate handler errors */
    }
  }

  private async serve(data: Record<string, unknown>): Promise<void> {
    const reply: Record<string, unknown> = { kind: "res", req_id: data.req_id };
    const handler = this.ops.get(String(data.op ?? ""));
    try {
      if (!handler) throw new Error(`unknown op ${String(data.op)}`);
      reply.ok = true;
      reply.result = await handler((data.payload as Record<string, unknown>) ?? {});
    } catch (e) {
      reply.ok = false;
      reply.error = (e as Error).message || String(e);
    }
    if (this.cmd && data.reply_to) {
      await this.cmd.publish(`${PREFIX}pod:${String(data.reply_to)}`, JSON.stringify(reply)).catch(() => {});
    }
  }

  async call(pod: string, op: string, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    if (pod === this.podId) {
      const h = this.ops.get(op);
      if (!h) throw new Error(`unknown op ${op}`);
      return h(payload);
    }
    if (!this.available || !this.cmd) throw new ClusterUnavailable(op);
    const reqId = randomUUID().replaceAll("-", "");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new ClusterUnavailable(`call ${op} to ${pod} timed out`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      void this.cmd!
        .publish(`${PREFIX}pod:${pod}`, JSON.stringify({ kind: "req", op, payload, req_id: reqId, reply_to: this.podId }))
        .then((receivers) => {
          if (!receivers) {
            this.pending.delete(reqId);
            clearTimeout(timer);
            reject(new ClusterUnavailable(`replica ${pod} is not listening`));
          }
        })
        .catch((err) => {
          this.pending.delete(reqId);
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  async alive(pod: string, timeoutMs = 1000): Promise<boolean> {
    try {
      await this.call(pod, "ping", {}, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async own(key: string, ttl = OWN_TTL, value?: string): Promise<void> {
    const val = value || this.podId;
    this.owned.set(key, [ttl, val]);
    if (this.available && this.cmd) {
      await this.cmd.set(PREFIX + key, val, "EX", ttl).catch(() => {});
    }
  }

  async claim(key: string, ttl = OWN_TTL, value?: string): Promise<boolean> {
    const val = value || this.podId;
    const held = this.owned.get(key);
    if (held && held[1] !== val) return false;
    if (this.available && this.cmd) {
      try {
        const ok = await this.cmd.set(PREFIX + key, val, "EX", ttl, "NX");
        if (!ok && (await this.cmd.get(PREFIX + key)) !== val) return false;
      } catch {
        /* local fallback */
      }
    }
    this.owned.set(key, [ttl, val]);
    return true;
  }

  async disown(key: string, value?: string): Promise<void> {
    const val = value || this.podId;
    const held = this.owned.get(key);
    if (held && held[1] === val) this.owned.delete(key);
    if (this.available && this.cmd) {
      await this.delIfMine(key, val).catch(() => {});
    }
  }

  async owner(key: string): Promise<string | null> {
    const local = this.owned.get(key);
    if (local) return local[1];
    if (!this.available || !this.cmd) return null;
    try {
      return await this.cmd.get(PREFIX + key);
    } catch {
      return null;
    }
  }

  async owners(keyPrefix: string): Promise<Record<string, string>> {
    if (!this.available || !this.cmd) return {};
    const out: Record<string, string> = {};
    let cursor = "0";
    const keys: string[] = [];
    do {
      const [next, batch] = await this.cmd.scan(cursor, "MATCH", `${PREFIX}${keyPrefix}*`, "COUNT", 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    if (keys.length) {
      const vals = await this.cmd.mget(...keys);
      for (let i = 0; i < keys.length; i++) {
        if (vals[i]) out[keys[i]!.slice(PREFIX.length)] = vals[i]!;
      }
    }
    return out;
  }

  forget(key: string): void {
    this.owned.delete(key);
  }

  private async delIfMine(key: string, value: string): Promise<void> {
    if (!this.cmd) return;
    if ((await this.cmd.get(PREFIX + key)) === value) await this.cmd.del(PREFIX + key);
  }

  private async heartbeat(): Promise<void> {
    if (!this.available || !this.cmd || !this.owned.size) return;
    try {
      const entries = [...this.owned.entries()];
      const holders = await this.cmd.mget(...entries.map(([k]) => PREFIX + k));
      const pipe = this.cmd.pipeline();
      for (let i = 0; i < entries.length; i++) {
        const [key, [ttl, value]] = entries[i]!;
        const holder = holders[i];
        if (holder === null || holder === value) pipe.set(PREFIX + key, value, "EX", ttl);
        else this.owned.delete(key);
      }
      await pipe.exec();
    } catch {
      /* ignore */
    }
  }

  async tryLock(name: string, ttlSeconds: number): Promise<string | null> {
    const token = randomUUID().replaceAll("-", "");
    if (!this.available || !this.cmd) return this.tryLocalLock(name, token, ttlSeconds);
    try {
      const ok = await this.cmd.set(`${PREFIX}lock:${name}`, token, "PX", Math.round(ttlSeconds * 1000), "NX");
      return ok ? token : null;
    } catch {
      return this.tryLocalLock(name, token, ttlSeconds);
    }
  }

  private tryLocalLock(name: string, token: string, ttlSeconds: number): string | null {
    const now = performance.now() / 1000;
    const held = this.localLocks.get(name);
    if (held && held[1] > now) return null;
    this.localLocks.set(name, [token, now + ttlSeconds]);
    return token;
  }

  async unlock(name: string, token: string): Promise<void> {
    const held = this.localLocks.get(name);
    if (held && held[0] === token) this.localLocks.delete(name);
    if (this.available && this.cmd) await this.delIfMine(`lock:${name}`, token).catch(() => {});
  }

  async renewLock(name: string, token: string, ttlSeconds: number): Promise<void> {
    const held = this.localLocks.get(name);
    if (held && held[0] === token) this.localLocks.set(name, [token, performance.now() / 1000 + ttlSeconds]);
    if (!this.available || !this.cmd) return;
    try {
      if ((await this.cmd.get(`${PREFIX}lock:${name}`)) === token) {
        await this.cmd.pexpire(`${PREFIX}lock:${name}`, Math.round(ttlSeconds * 1000));
      }
    } catch {
      /* ignore */
    }
  }

  async mutex(name: string, ttlSeconds = 120): Promise<Mutex | null> {
    const token = await this.tryLock(name, ttlSeconds);
    return token ? new Mutex(this, name, token, ttlSeconds) : null;
  }

  async holdLease(name: string, ttlSeconds = 120): Promise<boolean> {
    if (!this.available || !this.cmd) return true;
    const key = `${PREFIX}lease:${name}`;
    try {
      if (await this.cmd.set(key, this.podId, "PX", Math.round(ttlSeconds * 1000), "NX")) return true;
      if ((await this.cmd.get(key)) === this.podId) {
        await this.cmd.pexpire(key, Math.round(ttlSeconds * 1000));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async releaseLease(name: string): Promise<void> {
    if (!this.available || !this.cmd) return;
    await this.delIfMine(`lease:${name}`, this.podId).catch(() => {});
  }
}

export class SharedDict<T = unknown> {
  readonly data = new Map<string, T>();
  private readonly key: string;
  private readonly channel: string;

  constructor(
    private readonly cl: Cluster,
    name: string,
    private readonly ttl = 7 * 86400,
  ) {
    this.key = `${PREFIX}dict:${name}`;
    this.channel = `${PREFIX}dict-set:${name}`;
    cl.on(this.channel, (_ch, msg) => {
      if (msg.origin === cl.podId) return;
      const keys = Array.isArray(msg.keys) ? msg.keys : [];
      for (const k of keys) if (typeof k === "string" && k) this.data.set(k, msg.value as T);
    });
    cl.onStart(async () => {
      const r = cl.redis;
      if (!r) return;
      const all = await r.hgetall(this.key);
      for (const [k, blob] of Object.entries(all)) {
        if (this.data.has(k)) continue;
        try {
          this.data.set(k, JSON.parse(blob) as T);
        } catch {
          /* ignore */
        }
      }
    });
  }

  set(keys: Iterable<string | null | undefined>, value: T): void {
    const clean = [...new Set([...keys].filter((k): k is string => Boolean(k)))];
    if (!clean.length) return;
    for (const k of clean) this.data.set(k, value);
    if (this.cl.available) {
      this.cl.publish(this.channel, { keys: clean, value });
      const blob = JSON.stringify(value);
      const mapping: Record<string, string> = {};
      for (const k of clean) mapping[k] = blob;
      this.cl.write(async (r) => {
        const pipe = r.pipeline();
        pipe.hset(this.key, mapping);
        pipe.expire(this.key, this.ttl);
        await pipe.exec();
      });
    }
  }
}

export const cluster = new Cluster();
