/**
 * S21 — Worker Graceful Shutdown 标准
 *
 * 定义优雅关闭协议：信号处理、关闭阶段、超时配置、钩子接口。
 * 纯类型定义，不依赖任何外部包。
 */

/* ─── 关闭信号 ─────────────────────────────────────────────────── */

/** Worker 支持的关闭信号 */
export type ShutdownSignal = "SIGTERM" | "SIGINT";

/* ─── 关闭阶段枚举 ─────────────────────────────────────────────── */

/**
 * Graceful shutdown 严格的两阶段关闭顺序（不可重排）：
 * 1. DRAIN — 等待 BullMQ Worker 当前 Job 完成，不再接受新 Job
 * 2. CLEANUP — 关闭后台资源（Ticker/Queue/Redis/Health/DB）
 */
export const ShutdownPhase = {
  /** 阶段一：排空当前作业（worker.close()） */
  DRAIN: "drain",
  /** 阶段二：释放后台资源（shutdownWorkerRuntime） */
  CLEANUP: "cleanup",
  /** 关闭完成 */
  COMPLETE: "complete",
  /** 超时强制退出 */
  FORCE_EXIT: "force_exit",
} as const;

export type ShutdownPhaseValue = (typeof ShutdownPhase)[keyof typeof ShutdownPhase];

/* ─── 超时配置 ─────────────────────────────────────────────────── */

/** Graceful shutdown 超时配置 */
export interface ShutdownTimeoutConfig {
  /**
   * 整体关闭超时（ms）。
   * 须小于 K8s terminationGracePeriodSeconds，留出缓冲。
   * 最小 10_000，默认 30_000。
   */
  shutdownTimeoutMs: number;
}

/** 默认关闭超时（ms） */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/** 最小关闭超时（ms） */
export const MIN_SHUTDOWN_TIMEOUT_MS = 10_000;

/* ─── 关闭钩子接口 ─────────────────────────────────────────────── */

/** 优雅关闭钩子（按阶段注册） */
export interface ShutdownHook {
  /** 钩子名称（日志标识） */
  name: string;
  /** 所属关闭阶段 */
  phase: ShutdownPhaseValue;
  /** 钩子执行函数 */
  execute: () => Promise<void>;
}

/** 关闭钩子注册函数签名 */
export type RegisterShutdownHookFn = (hook: ShutdownHook) => void;

/* ─── 关闭状态接口 ─────────────────────────────────────────────── */

/** Worker 关闭状态（防止多次调用的守护标志） */
export interface ShutdownState {
  /** 是否正在关闭中 */
  shuttingDown: boolean;
  /** 触发关闭的信号 */
  signal?: ShutdownSignal;
  /** 当前所处阶段 */
  currentPhase?: ShutdownPhaseValue;
  /** 关闭开始时间（Unix ms） */
  startedAt?: number;
}

/* ─── Worker Runtime 资源描述 ──────────────────────────────────── */

/** Worker 运行时需要关闭的资源描述 */
export interface WorkerRuntimeResource {
  /** 资源名称 */
  name: string;
  /** 关闭函数 */
  close: () => Promise<void>;
  /** 关闭顺序（数字越小越先关闭） */
  order?: number;
}

/** shutdownWorkerRuntime 函数签名 */
export type ShutdownWorkerRuntimeFn = (runtime: {
  resources: WorkerRuntimeResource[];
}) => Promise<void>;

/* ─── Graceful Shutdown 函数签名 ───────────────────────────────── */

/** gracefulWorkerShutdown 标准函数签名 */
export type GracefulWorkerShutdownFn = (signal: ShutdownSignal) => Promise<void>;
