/**
 * distributedLock.ts — P0-03: Redis 分布式锁
 *
 * 基于 Redis SET key value NX PX ttl 实现互斥锁。
 * 支持：
 *   - 自动续期 (watchdog): 持锁期间定时延长 TTL，防止长任务持锁超时
 *   - fencing token: 每次获锁生成唯一 token，释放时校验，防止误释放
 *   - 获取超时: acquireTimeoutMs 限制等待时间
 *   - withLock 便捷包裹: ticker 类任务一行代码即可获锁执行
 */
import crypto from "node:crypto";
import type Redis from "ioredis";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:distributedLock" });

/* ── 类型 ── */

export interface DistributedLockOptions {
  /** 锁在 Redis 中的 key 前缀 (会自动加上 "lock:" 前缀) */
  lockKey: string;
  /** 锁初始 TTL（ms），也是 watchdog 续期间隔的基准 (default: 15_000) */
  ttlMs?: number;
  /** 获取锁等待超时（ms, 0=不等待, default: 0） */
  acquireTimeoutMs?: number;
  /** 等待锁时的重试间隔（ms, default: 200） */
  retryIntervalMs?: number;
  /** 是否启用自动续期 watchdog (default: true) */
  autoRenew?: boolean;
}

export interface LockHandle {
  /** 锁 key */
  key: string;
  /** fencing token（唯一标识本次持锁） */
  token: string;
  /** 释放锁 */
  release(): Promise<boolean>;
}

/* ── Lua 脚本: 条件释放（仅 token 匹配才 DEL） ── */
const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

/* ── Lua 脚本: 条件续期（仅 token 匹配才 PEXPIRE） ── */
const RENEW_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

/* ── 核心实现 ── */

/**
 * 尝试获取分布式锁。
 * 成功返回 LockHandle，失败返回 null。
 */
export async function acquireLock(
  redis: Redis,
  opts: DistributedLockOptions,
): Promise<LockHandle | null> {
  const key = `lock:${opts.lockKey}`;
  const token = crypto.randomUUID();
  const ttlMs = Math.max(5_000, opts.ttlMs ?? 15_000);
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 0;
  const retryIntervalMs = Math.max(50, opts.retryIntervalMs ?? 200);
  const autoRenew = opts.autoRenew !== false;

  const deadline = acquireTimeoutMs > 0 ? Date.now() + acquireTimeoutMs : 0;

  // 尝试获取
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await redis.set(key, token, "PX", ttlMs, "NX");
    if (result === "OK") {
      // 获锁成功
      let renewTimer: ReturnType<typeof setInterval> | null = null;
      let released = false;

      if (autoRenew) {
        // watchdog: 每 ttl/3 续一次
        const renewInterval = Math.max(2_000, Math.floor(ttlMs / 3));
        renewTimer = setInterval(async () => {
          if (released) return;
          try {
            const renewed = await (redis as any).eval(RENEW_SCRIPT, 1, key, token, String(ttlMs));
            if (!renewed) {
              // token 不匹配，锁已被他人持有 — 停止续期
              _logger.warn("watchdog: lock lost (token mismatch), stopping renewal", { key });
              if (renewTimer) clearInterval(renewTimer);
            }
          } catch (err) {
            _logger.error("watchdog renew failed", { key, error: (err as Error)?.message ?? err });
          }
        }, renewInterval);
        renewTimer.unref(); // 不阻止进程退出
      }

      const handle: LockHandle = {
        key,
        token,
        release: async () => {
          if (released) return false;
          released = true;
          if (renewTimer) clearInterval(renewTimer);
          try {
            const result = await (redis as any).eval(RELEASE_SCRIPT, 1, key, token);
            return result === 1;
          } catch (err) {
            _logger.error("release failed", { key, error: (err as Error)?.message ?? err });
            return false;
          }
        },
      };

      _logger.info("lock acquired", { key, tokenPrefix: token.slice(0, 8), ttlMs });
      return handle;
    }

    // 获锁失败 — 是否继续等待
    if (deadline === 0 || Date.now() >= deadline) {
      return null; // 不等待 / 超时
    }

    await sleep(retryIntervalMs);
  }
}

/**
 * 便捷包裹: 获取锁 → 执行 fn → 释放锁。
 * 获锁失败时不执行 fn，也不抛错，返回 { executed: false }。
 */
export async function withLock<T>(
  redis: Redis,
  opts: DistributedLockOptions,
  fn: () => Promise<T>,
): Promise<{ executed: boolean; result?: T }> {
  const handle = await acquireLock(redis, opts);
  if (!handle) {
    return { executed: false };
  }
  try {
    const result = await fn();
    return { executed: true, result };
  } finally {
    await handle.release();
  }
}

/* ── 辅助 ── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
