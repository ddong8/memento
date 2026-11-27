// The shared Redis (rate limits, cross-replica coordination), same URL and keys as the Python server.
// Unreachable or not configured: callers fall back to process memory, as the Python side does.
import { Redis } from "ioredis";

let client: Redis | null | undefined;

export function redisClient(url: string): Redis | null {
  if (client !== undefined) return client;
  if (!url) return (client = null);
  try {
    client = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 2000 });
    client.on("error", () => {});
  } catch {
    client = null;
  }
  return client;
}

export function setRedisClientForTests(c: Redis | null): void {
  client = c;
}

export async function closeRedis(): Promise<void> {
  if (client) await client.quit().catch(() => {});
  client = undefined;
}
