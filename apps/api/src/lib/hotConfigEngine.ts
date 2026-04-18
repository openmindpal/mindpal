/**
 * P2-04a: 配置热更新引擎
 *
 * 基于 Redis Pub/Sub 的实时配置推送机制，实现：
 * 1. 本地配置缓存（per-tenant RuntimeConfigOverrides）
 * 2. 配置变更时通过 Redis Pub/Sub 广播到所有 API/Worker 实例
 * 3. 收到通知后自动刷新本地缓存
 * 4. 支持配置变更回调（订阅者模式）
 * 5. 定期 DB 轮询作为兜底（防止 Pub/Sub 消息丢失）
 *
 * ── Redis 频道 ──
 * openslin:config:changed:{tenantId} → 变更通知
 *
 * ── 消息格式 ──
 * { configKey: string, action: "set"|"delete", timestamp: number, source: string }
 */

import type { Pool } from "pg";
import type { RuntimeConfigOverrides } from "@openslin/shared";

// ── 常量 ──────────────────────────────────────────────────

const REDIS_CONFIG_CHANNEL_PREFIX = "openslin:config:changed:";

/** 本地缓存 TTL — 超时后强制从 DB 重新加载（兜底机制） */
const CACHE_TTL_MS = Number(process.env.CONFIG_CACHE_TTL_MS) || 60_000; // 60s

/** 定期轮询间隔 — 作为 Pub/Sub 的兜底 */
const POLL_INTERVAL_MS = Number(process.env.CONFIG_POLL_INTERVAL_MS) || 30_000; // 30s

// ── 类型 ──────────────────────────────────────────────────

/** 配置变更事件 */
export interface ConfigChangeEvent {
  tenantId: string;
  configKey: string;
  action: "set" | "delete";
  newValue?: string;
  timestamp: number;
  source: string; // 发起变更的实例标识
}

/** 配置变更监听回调 */
export type ConfigChangeListener = (event: ConfigChangeEvent) => void | Promise<void>;

/** 本地缓存条目 */
interface CacheEntry {
  overrides: RuntimeConfigOverrides;
  loadedAt: number;
  version: number; // 递增的版本号，用于检测是否需要刷新
}

// ── 热更新引擎类 ──────────────────────────────────────────

export class HotConfigEngine {
  private pool: Pool;
  private redisPub: any; // ioredis instance for publishing
  private redisSub: any; // ioredis instance for subscribing
  private instanceId: string;

  /** per-tenant 本地缓存 */
  private cache = new Map<string, CacheEntry>();

  /** 配置变更监听器列表 */
  private listeners: ConfigChangeListener[] = [];

  /** 定期轮询定时器 */
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** 是否已启动 */
  private started = false;

  /** 已订阅的 Redis 频道 */
  private subscribedChannels = new Set<string>();

  constructor(params: {
    pool: Pool;
    redisPub: any;
    redisSub: any;
    instanceId?: string;
  }) {
    this.pool = params.pool;
    this.redisPub = params.redisPub;
    this.redisSub = params.redisSub;
    this.instanceId = params.instanceId ?? `${process.pid}-${Date.now().toString(36)}`;
  }

  // ── 启动/停止 ────────────────────────────────────────────

  /**
   * 启动热更新引擎
   * - 订阅 Redis Pub/Sub 通配频道
   * - 启动定期轮询兜底
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // 订阅通配频道（所有租户的配置变更）
    try {
      await this.redisSub.psubscribe(`${REDIS_CONFIG_CHANNEL_PREFIX}*`);
      this.redisSub.on("pmessage", (_pattern: string, channel: string, message: string) => {
        this.handleRedisMessage(channel, message).catch((err) => {
          console.error("[hot-config] Redis message handler error", err);
        });
      });
    } catch (err) {
      console.error("[hot-config] Failed to subscribe to Redis config channel", err);
    }

    // 启动定期轮询兜底
    this.pollTimer = setInterval(() => {
      this.pollAllCachedTenants().catch((err) => {
        console.error("[hot-config] Poll error", err);
      });
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();

    console.log(`[hot-config] Engine started (instance=${this.instanceId}, poll=${POLL_INTERVAL_MS}ms, cacheTTL=${CACHE_TTL_MS}ms)`);
  }

  /**
   * 停止热更新引擎
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    try {
      await this.redisSub.punsubscribe(`${REDIS_CONFIG_CHANNEL_PREFIX}*`);
    } catch { /* ignore */ }

    this.cache.clear();
    this.listeners.length = 0;
    console.log("[hot-config] Engine stopped");
  }

  // ── 配置读取（带缓存） ───────────────────────────────────

  /**
   * 获取指定租户的配置覆盖（优先使用本地缓存）
   *
   * @param tenantId - 租户 ID
   * @param forceRefresh - 是否强制从 DB 刷新
   */
  async getOverrides(tenantId: string, forceRefresh = false): Promise<RuntimeConfigOverrides> {
    const cached = this.cache.get(tenantId);

    // 检查缓存有效性
    if (cached && !forceRefresh && (Date.now() - cached.loadedAt) < CACHE_TTL_MS) {
      return cached.overrides;
    }

    // 从 DB 加载并更新缓存
    return this.loadAndCacheTenantOverrides(tenantId);
  }

  /**
   * 批量预加载多个租户的配置（用于系统启动时）
   */
  async preloadTenants(tenantIds: string[]): Promise<void> {
    await Promise.all(
      tenantIds.map((id) => this.loadAndCacheTenantOverrides(id).catch(() => {})),
    );
  }

  // ── 配置写入（通知广播） ──────────────────────────────────

  /**
   * 广播配置变更通知到所有实例
   *
   * 应在 setConfigOverride / deleteConfigOverride 之后调用。
   */
  async broadcastConfigChange(event: Omit<ConfigChangeEvent, "timestamp" | "source">): Promise<void> {
    const fullEvent: ConfigChangeEvent = {
      ...event,
      timestamp: Date.now(),
      source: this.instanceId,
    };

    const channel = `${REDIS_CONFIG_CHANNEL_PREFIX}${event.tenantId}`;

    try {
      await this.redisPub.publish(channel, JSON.stringify(fullEvent));
    } catch (err) {
      console.error("[hot-config] Failed to publish config change", err);
    }

    // 本地也立即刷新
    await this.invalidateAndReload(event.tenantId);

    // 通知本地监听器
    await this.notifyListeners(fullEvent);
  }

  // ── 监听器管理 ────────────────────────────────────────────

  /**
   * 注册配置变更监听器
   *
   * @returns 取消注册的函数
   */
  onConfigChange(listener: ConfigChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  // ── 状态查询 ──────────────────────────────────────────────

  /** 获取当前缓存状态 */
  getCacheStats(): {
    tenantCount: number;
    entries: Array<{ tenantId: string; keyCount: number; ageMs: number; version: number }>;
  } {
    const entries = Array.from(this.cache.entries()).map(([tenantId, entry]) => ({
      tenantId,
      keyCount: Object.keys(entry.overrides).length,
      ageMs: Date.now() - entry.loadedAt,
      version: entry.version,
    }));
    return { tenantCount: this.cache.size, entries };
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.started;
  }

  // ── 内部实现 ──────────────────────────────────────────────

  private async loadAndCacheTenantOverrides(tenantId: string): Promise<RuntimeConfigOverrides> {
    try {
      const res = await this.pool.query(
        `SELECT config_key, config_value FROM runtime_config_overrides WHERE tenant_id = $1`,
        [tenantId],
      );
      const overrides: RuntimeConfigOverrides = {};
      for (const row of res.rows) {
        overrides[String(row.config_key)] = String(row.config_value);
      }

      const existing = this.cache.get(tenantId);
      this.cache.set(tenantId, {
        overrides,
        loadedAt: Date.now(),
        version: (existing?.version ?? 0) + 1,
      });

      return overrides;
    } catch (err) {
      console.error(`[hot-config] Failed to load overrides for tenant=${tenantId}`, err);
      // 返回旧缓存或空
      return this.cache.get(tenantId)?.overrides ?? {};
    }
  }

  private async invalidateAndReload(tenantId: string): Promise<void> {
    await this.loadAndCacheTenantOverrides(tenantId);
  }

  private async handleRedisMessage(channel: string, message: string): Promise<void> {
    try {
      const event = JSON.parse(message) as ConfigChangeEvent;

      // 跳过自己发出的消息（已在 broadcastConfigChange 中处理）
      if (event.source === this.instanceId) return;

      // 刷新该租户的缓存
      await this.invalidateAndReload(event.tenantId);

      // 通知本地监听器
      await this.notifyListeners(event);

      console.log(
        `[hot-config] Config reloaded: tenant=${event.tenantId} key=${event.configKey} ` +
        `action=${event.action} from=${event.source}`,
      );
    } catch (err) {
      console.error("[hot-config] Failed to handle Redis message", err);
    }
  }

  private async notifyListeners(event: ConfigChangeEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (err) {
        console.error("[hot-config] Listener error", err);
      }
    }
  }

  /**
   * 定期轮询所有已缓存租户的配置（兜底机制）
   */
  private async pollAllCachedTenants(): Promise<void> {
    const now = Date.now();
    const tenantsToRefresh: string[] = [];

    for (const [tenantId, entry] of this.cache) {
      if (now - entry.loadedAt >= CACHE_TTL_MS) {
        tenantsToRefresh.push(tenantId);
      }
    }

    if (!tenantsToRefresh.length) return;

    await Promise.all(
      tenantsToRefresh.map((id) =>
        this.loadAndCacheTenantOverrides(id).catch(() => {}),
      ),
    );
  }
}

// ── 全局单例 ──────────────────────────────────────────────

let _engine: HotConfigEngine | null = null;

/**
 * 初始化全局热更新引擎（应在 API/Worker 启动时调用一次）
 */
export function initHotConfigEngine(params: {
  pool: Pool;
  redisPub: any;
  redisSub: any;
  instanceId?: string;
}): HotConfigEngine {
  if (_engine) return _engine;
  _engine = new HotConfigEngine(params);
  return _engine;
}

/**
 * 获取全局热更新引擎实例
 */
export function getHotConfigEngine(): HotConfigEngine | null {
  return _engine;
}

/**
 * 便捷方法：获取配置覆盖（自动判断是否有热更新引擎，没有则直接查 DB）
 */
export async function getConfigOverridesWithHotCache(params: {
  pool: Pool;
  tenantId: string;
}): Promise<RuntimeConfigOverrides> {
  if (_engine?.isRunning()) {
    return _engine.getOverrides(params.tenantId);
  }
  // 回退：直接查 DB
  const res = await params.pool.query(
    `SELECT config_key, config_value FROM runtime_config_overrides WHERE tenant_id = $1`,
    [params.tenantId],
  );
  const overrides: RuntimeConfigOverrides = {};
  for (const row of res.rows) {
    overrides[String(row.config_key)] = String(row.config_value);
  }
  return overrides;
}
