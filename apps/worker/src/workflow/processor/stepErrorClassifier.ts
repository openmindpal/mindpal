/**
 * Step 错误分类与恢复逻辑
 * 从 processStep.ts 拆分出来
 */

import { isPlainObject } from "./common";

// ────────────────────────────────────────────────────────────────
// 错误类别定义
// ────────────────────────────────────────────────────────────────

export type ErrorCategory =
  | "timeout"
  | "needs_device"
  | "resource_exhausted"
  | "policy_violation"
  | "internal"
  | "retryable"
  | "device_execution_failed";

// ────────────────────────────────────────────────────────────────
// 可重试错误码集合
// ────────────────────────────────────────────────────────────────

/** 已知瞬时/可重试错误码（Node.js 系统错误 + PostgreSQL + Redis + HTTP/Fetch） */
const RETRYABLE_ERROR_CODES = new Set([
  // ── Node.js 系统 / 网络连接类 ──
  'ECONNREFUSED',              // 连接被拒绝
  'ECONNRESET',                // 连接重置
  'ETIMEDOUT',                 // 连接超时
  'EPIPE',                     // 管道断裂
  'ENOTFOUND',                 // DNS 解析失败（短暂）
  'EHOSTUNREACH',              // 主机不可达
  'ENETUNREACH',               // 网络不可达
  'EAI_AGAIN',                 // DNS 临时失败

  // ── PostgreSQL 连接类 (Class 08) ──
  '08000',                     // connection_exception
  '08001',                     // sqlclient_unable_to_establish_sqlconnection
  '08003',                     // connection_does_not_exist
  '08006',                     // connection_failure

  // ── PostgreSQL 事务 / 并发类 (Class 40) ──
  '40001',                     // serialization_failure（并发事务冲突）
  '40P01',                     // deadlock_detected

  // ── PostgreSQL 资源不足类 (Class 53) ──
  '53000',                     // insufficient_resources
  '53100',                     // disk_full
  '53200',                     // out_of_memory
  '53300',                     // too_many_connections

  // ── PostgreSQL 操作干预 / 系统类 (Class 57 / 58) ──
  '57014',                     // query_cancelled（超时取消）
  '57P01',                     // admin_shutdown
  '57P02',                     // crash_shutdown
  '57P03',                     // cannot_connect_now
  '58000',                     // system_error
  '58030',                     // io_error

  // ── Redis 瞬时错误 ──
  'BUSY',                      // Redis BUSY（后台操作进行中）
  'LOADING',                   // Redis 正在加载数据
  'CLUSTERDOWN',               // 集群不可用
  'TRYAGAIN',                  // 集群迁移中
  'MOVED',                     // 集群重定向（ioredis 通常自动处理）
  'MASTERDOWN',                // 主节点不可用
  'READONLY',                  // 只读模式（故障转移中）
  'NOREPLICAS',                // 无可用副本

  // ── HTTP / Fetch / undici ──
  'UND_ERR_CONNECT_TIMEOUT',   // undici 连接超时
  'UND_ERR_BODY_TIMEOUT',      // undici 请求体超时
  'FETCH_ERROR',               // fetch 网络错误
]);

/** Redis 错误关键字前缀列表（用于从 message 中识别） */
const REDIS_ERROR_PREFIXES = [
  'BUSY', 'LOADING', 'CLUSTERDOWN', 'TRYAGAIN',
  'MASTERDOWN', 'READONLY', 'NOREPLICAS',
] as const;

// ────────────────────────────────────────────────────────────────
// 错误码提取
// ────────────────────────────────────────────────────────────────

/**
 * 从错误对象中提取错误码。
 * 按优先级依次尝试：Node.js `.code` → PostgreSQL `.sqlState` → Redis message 前缀。
 */
export function extractErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) && !isPlainObject(error)) return undefined;

  const err = error as Record<string, any>;

  // Node.js 系统错误 / 通用 .code
  if ('code' in err && typeof err.code === 'string') {
    return err.code;
  }

  // PostgreSQL 驱动错误（pg / pg-native 均使用 sqlState / code）
  if ('sqlState' in err && typeof err.sqlState === 'string') {
    return err.sqlState;
  }

  // ioredis / Redis 错误：错误消息以关键字开头
  const msg = (err as any).message;
  if (typeof msg === 'string') {
    for (const prefix of REDIS_ERROR_PREFIXES) {
      if (msg.startsWith(prefix)) return prefix;
    }
  }

  return undefined;
}

// ────────────────────────────────────────────────────────────────
// 错误分类器
// ────────────────────────────────────────────────────────────────

/**
 * 根据错误消息分类错误类型
 */
export function classifyError(rawMessage: string): ErrorCategory {
  // 规范化消息
  const msg = rawMessage.startsWith("concurrency_limit:")
    ? "resource_exhausted:max_concurrency"
    : rawMessage;

  // 超时
  if (msg === "timeout") {
    return "timeout";
  }

  // 需要设备
  if (msg === "needs_device") {
    return "needs_device";
  }

  // 资源耗尽
  if (msg.startsWith("resource_exhausted:")) {
    return "resource_exhausted";
  }

  // 策略违规
  if (msg.startsWith("policy_violation:")) {
    return "policy_violation";
  }

  // 内部错误（模式校验失败）
  if (msg.startsWith("output_schema:") || msg.startsWith("input_schema:")) {
    return "internal";
  }

  // 写租约忙
  if (msg === "write_lease_busy") {
    return "retryable";
  }

  // 冲突
  if (msg.startsWith("conflict_")) {
    return "retryable";
  }

  // Schema 未找到
  if (msg.startsWith("schema_not_found:")) {
    return "retryable";
  }

  // 设备执行失败
  if (msg.startsWith("device_execution_failed:")) {
    return "device_execution_failed";
  }

  // 默认可重试
  return "retryable";
}

// ────────────────────────────────────────────────────────────────
// 错误恢复策略
// ────────────────────────────────────────────────────────────────

export interface ErrorRecoveryDecision {
  /** 是否应该重新抛出错误以触发重试 */
  shouldRethrow: boolean;
  /** 是否为终态（不应重试） */
  isTerminal: boolean;
  /** 建议的退避时间（毫秒） */
  backoffMs: number | null;
}

/**
 * 获取错误的恢复决策
 */
export function getErrorRecoveryDecision(category: ErrorCategory, err?: any): ErrorRecoveryDecision {
  switch (category) {
    // 策略违规和内部错误是终态，不重试
    case "policy_violation":
    case "internal":
      return { shouldRethrow: false, isTerminal: true, backoffMs: null };

    // 需要设备是特殊状态，由外部流程处理
    case "needs_device":
      return { shouldRethrow: false, isTerminal: false, backoffMs: null };

    // 超时通常不重试
    case "timeout":
      return { shouldRethrow: true, isTerminal: false, backoffMs: null };

    // 资源耗尽通常不重试
    case "resource_exhausted":
      return { shouldRethrow: true, isTerminal: false, backoffMs: null };

    // 设备执行失败，可能重试
    case "device_execution_failed":
      return { shouldRethrow: true, isTerminal: false, backoffMs: null };

    // 可重试错误
    case "retryable": {
      // 如果是写租约忙，使用错误中的退避时间
      const writeLease = err?.writeLease;
      if (writeLease && typeof writeLease.backoffMs === "number") {
        return { shouldRethrow: true, isTerminal: false, backoffMs: writeLease.backoffMs };
      }
      return { shouldRethrow: true, isTerminal: false, backoffMs: null };
    }

    default:
      return { shouldRethrow: true, isTerminal: false, backoffMs: null };
  }
}

// ────────────────────────────────────────────────────────────────
// 错误信息提取
// ────────────────────────────────────────────────────────────────

export interface ExtractedErrorInfo {
  message: string;
  category: ErrorCategory;
  capabilityEnvelopeSummary: any | null;
  writeLease: any | null;
  deviceExecutionId: string | null;
  deviceId: string | null;
}

/**
 * 从错误对象提取结构化信息。
 * 优先通过错误码判定可重试性，再回退到消息分类。
 */
export function extractErrorInfo(err: any): ExtractedErrorInfo {
  const rawMsg = String(err?.message ?? err);
  const msg = rawMsg.startsWith("concurrency_limit:") ? "resource_exhausted:max_concurrency" : rawMsg;

  // 优先：错误码匹配 → retryable
  const code = extractErrorCode(err);
  const category = (code && RETRYABLE_ERROR_CODES.has(code))
    ? "retryable" as ErrorCategory
    : classifyError(rawMsg);

  return {
    message: msg,
    category,
    capabilityEnvelopeSummary: isPlainObject(err?.capabilityEnvelopeSummary) ? err.capabilityEnvelopeSummary : null,
    writeLease: isPlainObject(err?.writeLease) ? err.writeLease : null,
    deviceExecutionId: err?.deviceExecutionId ?? null,
    deviceId: err?.deviceId ?? null,
  };
}

// ────────────────────────────────────────────────────────────────
// 错误消息规范化
// ────────────────────────────────────────────────────────────────

/**
 * 规范化错误消息
 */
export function normalizeErrorMessage(rawMessage: string): string {
  if (rawMessage.startsWith("concurrency_limit:")) {
    return "resource_exhausted:max_concurrency";
  }
  return rawMessage;
}

// ────────────────────────────────────────────────────────────────
// 死信分类
// ────────────────────────────────────────────────────────────────

export type DeadLetterCategory =
  | 'retryable_deadletter'   // 可重试：瞬时错误（网络超时、资源不足）已超过正常重试次数
  | 'permanent_deadletter';  // 永久失败：逻辑错误、权限拒绝、数据验证等

/** 死信重试次数上限 */
export const MAX_DEADLETTER_RETRIES = 3;

/**
 * 对已进入死信队列的错误进行二次分类，判断是否值得重试。
 * 同时检查错误码以确保瞬时错误不被误判为永久失败。
 *
 * @param error       原始错误（用于提取 message / code 做分类）
 * @param retryCount  已执行的死信重试次数
 */
export function classifyDeadLetter(error: unknown, retryCount: number): DeadLetterCategory {
  // 超过死信重试上限 → 永久失败
  if (retryCount >= MAX_DEADLETTER_RETRIES) {
    return 'permanent_deadletter';
  }

  // 错误码匹配 → 一定是瞬时可重试
  const code = extractErrorCode(error);
  if (code && RETRYABLE_ERROR_CODES.has(code)) {
    return 'retryable_deadletter';
  }

  const rawMsg = String((error as any)?.message ?? error);
  const category = classifyError(rawMsg);
  const decision = getErrorRecoveryDecision(category);

  // 终态错误（policy_violation / internal）→ 永久失败
  if (decision.isTerminal) {
    return 'permanent_deadletter';
  }

  // 非终态错误且未超重试上限 → 可重试
  return 'retryable_deadletter';
}
