import Redis from "ioredis";
import type { ApiConfig } from "../../config";

export type RedisClient = Redis;

export function createRedisClient(cfg: ApiConfig) {
  const client = new Redis({
    host: cfg.redis.host,
    port: cfg.redis.port,
    maxRetriesPerRequest: null,
    lazyConnect: true,
    connectTimeout: 500,
    enableOfflineQueue: false,
  });
  client.on("error", () => undefined);
  return client;
}
