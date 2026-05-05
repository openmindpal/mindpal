/**
 * S20 — Worker Ticker 声明式注册标准
 *
 * 定义 Ticker 配置接口、依赖注入、状态枚举及注册函数签名。
 * 纯类型定义，不依赖任何外部包。
 */

/* ─── Ticker 依赖注入接口 ──────────────────────────────────────── */

/** Ticker handler 接收的运行时依赖 */
export interface TickerDeps {
  pool: unknown;
  queue: unknown;
  redis: unknown;
  redisLock: unknown;
  masterKey: string;
  cfg: unknown;
  withLock: (redis: unknown, opts: { lockKey: string; ttlMs: number }, fn: () => Promise<unknown>) => Promise<unknown>;
}

/* ─── Ticker 定义接口 ──────────────────────────────────────────── */

/** Ticker 声明式配置 */
export interface TickerDef {
  /** Ticker 名称（全局唯一） */
  name: string;
  /** 执行间隔（ms），支持动态计算 */
  intervalMs: number | (() => number);
  /** Redis 分布式锁 Key，命名规范：worker:ticker:{name}:lock */
  lockKey: string;
  /** 锁 TTL（ms），默认等于 intervalMs */
  lockTtlMs?: number | (() => number);
  /** 如果设置为 true，则 handler 内不使用 withLock，直接执行 */
  noLock?: boolean;
  /** 是否需要 in-flight 保护（防止同实例内重叠执行） */
  inFlightGuard?: boolean;
  /** 定时任务处理函数 */
  handler: (deps: TickerDeps) => Promise<void>;
}

/* ─── Ticker 状态枚举 ──────────────────────────────────────────── */

/** Ticker 运行时状态 */
export const TickerStatus = {
  /** 已注册但未启动 */
  REGISTERED: "registered",
  /** 正在运行 */
  RUNNING: "running",
  /** 已停止 */
  STOPPED: "stopped",
  /** 执行出错 */
  ERROR: "error",
} as const;

export type TickerStatusValue = (typeof TickerStatus)[keyof typeof TickerStatus];

/* ─── Ticker 注册函数签名 ──────────────────────────────────────── */

/** 注册 Ticker 的函数签名 */
export type RegisterTickerFn = (def: TickerDef) => void;

/** 启动所有已注册 Ticker 的函数签名 */
export type StartAllTickersFn = (deps: TickerDeps) => unknown[];

/** 停止所有 Ticker 的函数签名 */
export type StopAllTickersFn = () => void;

/* ─── Ticker 运行时信息 ─────────────────────────────────────────── */

/** Ticker 运行时元数据（用于监控/诊断） */
export interface TickerRuntimeInfo {
  name: string;
  status: TickerStatusValue;
  intervalMs: number;
  lockKey: string;
  lastRunAt?: string;
  lastError?: string;
}
