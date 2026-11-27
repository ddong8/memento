// Redis-backed command queue for collectors (server/server/services/device_commands.py).
import type { Redis } from "ioredis";

import { PREFIX } from "./cluster";

export const CMD_KEY = `${PREFIX}devcmd:`;
export const CMD_SEQ = `${PREFIX}devcmd-seq`;
export const CMD_TTL = 7 * 86400;

export interface DeviceCommand {
  id: number;
  action: string;
  created_at: number;
  payload?: Record<string, unknown>;
}

export async function pushCommand(
  redis: Redis,
  deviceCollectorId: string,
  action: string,
  payload?: Record<string, unknown> | null,
): Promise<number> {
  const cmdId = Number(await redis.incr(CMD_SEQ));
  const cmd: DeviceCommand = { id: cmdId, action, created_at: Date.now() / 1000 };
  if (payload && Object.keys(payload).length) cmd.payload = payload;
  const pipe = redis.pipeline();
  pipe.rpush(CMD_KEY + deviceCollectorId, JSON.stringify(cmd));
  pipe.expire(CMD_KEY + deviceCollectorId, CMD_TTL);
  await pipe.exec();
  return cmdId;
}

export async function pendingCommands(redis: Redis, deviceCollectorId: string): Promise<DeviceCommand[]> {
  const items = await redis.lrange(CMD_KEY + deviceCollectorId, 0, -1);
  return items.map((c) => JSON.parse(c) as DeviceCommand);
}

export async function ackCommand(redis: Redis, deviceCollectorId: string, cmdId: number): Promise<void> {
  const items = await redis.lrange(CMD_KEY + deviceCollectorId, 0, -1);
  for (const raw of items) {
    try {
      const parsed = JSON.parse(raw) as { id?: number };
      if (parsed.id === cmdId) await redis.lrem(CMD_KEY + deviceCollectorId, 0, raw);
    } catch {
      /* ignore malformed entry */
    }
  }
}
