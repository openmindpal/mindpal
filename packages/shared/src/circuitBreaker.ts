/**
 * circuitBreaker.ts — 通用熔断器实现 (P0-02)
 *
 * 状态机: CLOSED → OPEN → HALF_OPEN → CLOSED
 *
 * - CLOSED:    正常通行，累计连续失败数
 * - OPEN:      快速拒绝所有请求，等待 resetTimeoutMs 后进入 HALF_OPEN
 * - HALF_OPEN: 允许有限试探请求，成功则恢复 CLOSED，失败则重回 OPEN
 */

/* ── 类型定义 ── */

export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** 熔断器名称（用于日志 / 指标） */
  name: string;
  /** 连续失败多少次后打开熔断器 (default: 5) */
  failureThreshold?: number;
  /** OPEN 状态持续时长后尝试 HALF_OPEN (ms, default: 30_000) */
  resetTimeoutMs?: number;
  /** HALF_OPEN 状态允许的最大试探请求数 (default: 3) */
  halfOpenMaxAttempts?: number;
  /** 状态变迁回调 — 用于审计 / 指标上报 */
  onStateChange?: (event: CircuitBreakerStateChangeEvent) => void;
  /** 日志回调 — 接入结构化日志体系，避免硬编码 console.log */
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface CircuitBreakerStateChangeEvent {
  name: string;
  from: CircuitBreakerState;
  to: CircuitBreakerState;
  timestamp: number;
  consecutiveFailures: number;
}

export interface CircuitBreakerMetrics {
  name: string;
  state: CircuitBreakerState;
  consecutiveFailures: number;
  totalSuccesses: number;
  totalFailures: number;
  totalShortCircuited: number;
  lastFailureTs: number | null;
  lastSuccessTs: number | null;
  lastStateChangeTs: number | null;
}

/** 熔断器 OPEN 状态时抛出的异常 */
export class CircuitOpenError extends Error {
  constructor(public readonly breakerName: string) {
    super(`Circuit breaker "${breakerName}" is OPEN — request rejected`);
    this.name = "CircuitOpenError";
  }
}

/* ── 核心实现 ── */

export class CircuitBreaker {
  readonly name: string;

  private state: CircuitBreakerState = "closed";
  private consecutiveFailures = 0;
  private halfOpenAttempts = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;
  private readonly onStateChange?: (event: CircuitBreakerStateChangeEvent) => void;
  private readonly logger: (message: string, meta?: Record<string, unknown>) => void;

  /* 统计指标 */
  private totalSuccesses = 0;
  private totalFailures = 0;
  private totalShortCircuited = 0;
  private lastFailureTs: number | null = null;
  private lastSuccessTs: number | null = null;
  private lastStateChangeTs: number | null = null;

  /* OPEN 状态起始时间，用于计算是否到 resetTimeoutMs */
  private openedAt: number | null = null;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.failureThreshold = Math.max(1, opts.failureThreshold ?? 5);
    this.resetTimeoutMs = Math.max(1_000, opts.resetTimeoutMs ?? 30_000);
    this.halfOpenMaxAttempts = Math.max(1, opts.halfOpenMaxAttempts ?? 3);
    this.onStateChange = opts.onStateChange;
    this.logger = opts.logger ?? ((msg, _meta) => { /* 未注入日志器时静默，不使用 console.log */ });
  }

  /* ── 公共 API ── */

  /** 获取当前状态 */
  getState(): CircuitBreakerState {
    // 自动从 OPEN 过渡到 HALF_OPEN
    if (this.state === "open" && this.openedAt !== null) {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this.transition("half_open");
      }
    }
    return this.state;
  }

  /**
   * 包裹异步调用，自动记录成功 / 失败并执行熔断逻辑。
   * 当熔断器处于 OPEN 状态时直接抛出 CircuitOpenError。
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === "open") {
      this.totalShortCircuited++;
      throw new CircuitOpenError(this.name);
    }

    // HALF_OPEN: 检查是否超出试探上限
    if (currentState === "half_open" && this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
      this.totalShortCircuited++;
      throw new CircuitOpenError(this.name);
    }

    if (currentState === "half_open") {
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /** 手动记录一次成功 */
  recordSuccess(): void {
    this.totalSuccesses++;
    this.lastSuccessTs = Date.now();
    this.consecutiveFailures = 0;

    if (this.state === "half_open") {
      // HALF_OPEN 有成功 → 恢复 CLOSED
      this.transition("closed");
    }
  }

  /** 手动记录一次失败 */
  recordFailure(): void {
    this.totalFailures++;
    this.lastFailureTs = Date.now();
    this.consecutiveFailures++;

    if (this.state === "half_open") {
      // HALF_OPEN 任一失败 → 重回 OPEN
      this.transition("open");
      return;
    }

    if (this.state === "closed" && this.consecutiveFailures >= this.failureThreshold) {
      this.transition("open");
    }
  }

  /** 手动重置为 CLOSED */
  reset(): void {
    this.consecutiveFailures = 0;
    this.halfOpenAttempts = 0;
    this.openedAt = null;
    if (this.state !== "closed") {
      this.transition("closed");
    }
  }

  /** 导出当前指标快照 */
  getMetrics(): CircuitBreakerMetrics {
    return {
      name: this.name,
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      totalShortCircuited: this.totalShortCircuited,
      lastFailureTs: this.lastFailureTs,
      lastSuccessTs: this.lastSuccessTs,
      lastStateChangeTs: this.lastStateChangeTs,
    };
  }

  /* ── 内部 ── */

  private transition(to: CircuitBreakerState): void {
    const from = this.state;
    if (from === to) return;

    this.state = to;
    this.lastStateChangeTs = Date.now();

    if (to === "open") {
      this.openedAt = Date.now();
      this.halfOpenAttempts = 0;
    } else if (to === "half_open") {
      this.halfOpenAttempts = 0;
    } else if (to === "closed") {
      this.consecutiveFailures = 0;
      this.halfOpenAttempts = 0;
      this.openedAt = null;
    }

    if (this.onStateChange) {
      try {
        this.onStateChange({
          name: this.name,
          from,
          to,
          timestamp: Date.now(),
          consecutiveFailures: this.consecutiveFailures,
        });
      } catch {
        // 回调异常不影响主流程
      }
    }

    this.logger(
      `[circuit-breaker:${this.name}] ${from} → ${to}`,
      { breakerName: this.name, from, to, consecutiveFailures: this.consecutiveFailures },
    );
  }
}

/* ── 工厂：按维度键自动创建/复用熔断器 ── */

const registryMap = new Map<string, CircuitBreaker>();

/**
 * 获取指定维度的熔断器（不存在则自动创建）。
 * 典型用法:
 *   getOrCreateBreaker("llm:gpt-4o", { ... })
 *   getOrCreateBreaker("connector:slack", { ... })
 *   getOrCreateBreaker("federation:node-abc", { ... })
 */
export function getOrCreateBreaker(
  key: string,
  defaultOpts?: Omit<CircuitBreakerOptions, "name">,
): CircuitBreaker {
  let breaker = registryMap.get(key);
  if (!breaker) {
    breaker = new CircuitBreaker({ name: key, ...defaultOpts });
    registryMap.set(key, breaker);
  }
  return breaker;
}

/** 列出所有已注册熔断器的指标快照 */
export function getAllBreakerMetrics(): CircuitBreakerMetrics[] {
  return Array.from(registryMap.values()).map((b) => b.getMetrics());
}

/** 清空全局注册表（仅测试用） */
export function clearBreakerRegistry(): void {
  registryMap.clear();
}
