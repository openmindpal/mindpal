/**
 * S19 — BullMQ Job 数据结构标准
 *
 * 定义 Worker 作业的标准数据结构、状态枚举、选项接口与结果接口。
 * 纯类型定义，不依赖任何外部包。
 */

/* ─── Job Payload（三元组必填） ─────────────────────────────────── */

/** Worker 作业数据必须符合的基本结构（jobId/runId/stepId 三元组必填） */
export interface WorkflowJobData {
  /** 作业唯一标识 */
  jobId: string;
  /** 工作流运行实例 ID */
  runId: string;
  /** 步骤 ID */
  stepId: string;
  /** 作业类型，用于分发路由 */
  kind?: string;
  /** 可扩展字段 */
  [key: string]: unknown;
}

/* ─── Job 状态枚举 ──────────────────────────────────────────────── */

/** BullMQ Job 生命周期状态 */
export const JobStatus = {
  /** 等待处理 */
  WAITING: "waiting",
  /** 已延迟 */
  DELAYED: "delayed",
  /** 处理中 */
  ACTIVE: "active",
  /** 处理完成 */
  COMPLETED: "completed",
  /** 处理失败 */
  FAILED: "failed",
  /** 进入死信队列 */
  DEADLETTER: "deadletter",
} as const;

export type JobStatusValue = (typeof JobStatus)[keyof typeof JobStatus];

/* ─── Job 选项接口 ──────────────────────────────────────────────── */

/** 退避策略类型 */
export type BackoffStrategy = "fixed" | "exponential" | "custom";

/** 退避配置 */
export interface JobBackoffOptions {
  type: BackoffStrategy;
  /** 退避延迟（ms） */
  delay: number;
}

/** Job 入队选项 */
export interface JobOptions {
  /** 优先级（数字越小优先级越高） */
  priority?: number;
  /** 最大重试次数 */
  attempts?: number;
  /** 退避策略 */
  backoff?: JobBackoffOptions;
  /** 延迟执行（ms） */
  delay?: number;
  /** 作业超时（ms） */
  timeout?: number;
  /** 是否可移除（完成/失败后自动清理） */
  removeOnComplete?: boolean | number;
  /** 失败后是否自动移除 */
  removeOnFail?: boolean | number;
  /** Job ID（去重用） */
  jobId?: string;
}

/* ─── Job 结果接口 ──────────────────────────────────────────────── */

/** Job 执行结果 */
export interface JobResult {
  /** 是否成功 */
  success: boolean;
  /** 结果数据 */
  data?: unknown;
  /** 错误信息（失败时） */
  error?: string;
  /** 错误分类代码 */
  errorCode?: string;
  /** 错误分类 */
  errorCategory?: string;
  /** 执行耗时（ms） */
  durationMs?: number;
}

/* ─── 声明式 Job Handler 定义 ───────────────────────────────────── */

/** Job Handler 依赖注入接口 */
export interface JobDeps {
  pool: unknown;
  queue: unknown;
  masterKey?: string;
  [key: string]: unknown;
}

/** 内置 Job Handler 定义 */
export interface BuiltinJobDef {
  /** Job 类型标识（kind 路由键） */
  kind: string;
  /** 便于日志/调试的标签 */
  label: string;
  /** 处理函数 */
  handler: (data: unknown, deps: JobDeps) => Promise<void>;
}

/* ─── 错误分类（死信队列） ──────────────────────────────────────── */

/** Job 失败分类信息 */
export interface JobFailureInfo {
  /** BullMQ 内部 Job ID */
  queueJobId: string;
  /** 三元组 */
  jobId: string;
  runId: string;
  stepId: string;
  /** 已尝试次数 */
  attemptsMade: number;
  /** 最大尝试次数 */
  maxAttempts: number;
  /** 是否为最终失败（进入死信） */
  isFinalAttempt: boolean;
  /** 错误信息 */
  errorMessage: string;
  /** 错误代码 */
  errorCode?: string;
  /** 错误分类 */
  errorCategory?: string;
}
