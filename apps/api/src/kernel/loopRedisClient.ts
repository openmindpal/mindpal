/**
 * Agent Loop — Redis Pub/Sub 懒单例连接
 *
 * 用于 step 完成事件驱动通知，避免每次 waitForStepCompletion 创建新连接。
 */

/* ─── 2.1 FIX: 模块级共享 Redis Pub/Sub 连接（懒单例） ─── */
let _sharedSubClient: import("ioredis").default | null = null;
let _sharedSubClientPromise: Promise<import("ioredis").default | null> | null = null;

export async function getSharedSubClient(): Promise<import("ioredis").default | null> {
  if (_sharedSubClient) return _sharedSubClient;
  if (_sharedSubClientPromise) return _sharedSubClientPromise;
  _sharedSubClientPromise = (async () => {
    try {
      const { default: Redis } = await import("ioredis");
      const client = new Redis({
        host: process.env.REDIS_HOST ?? "127.0.0.1",
        port: Number(process.env.REDIS_PORT ?? 6379),
        maxRetriesPerRequest: null as null,
        lazyConnect: true,
      });
      await client.connect();
      _sharedSubClient = client;
      return client;
    } catch {
      _sharedSubClientPromise = null;
      return null;
    }
  })();
  return _sharedSubClientPromise;
}
