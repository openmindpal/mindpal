/**
 * Task Queue 类型定义
 *
 * 会话级多任务并发队列系统的核心类型。
 * OS 级进程管理模型：每个会话维护独立的任务队列，
 * 支持优先级调度、依赖管理、前后台切换。
 */

/* ================================================================== */
/*  队列状态                                                            */
/* ================================================================== */

/** 队列条目状态 */
export type QueueEntryStatus =
  | "queued"      // 已入队等待调度
  | "ready"       // 依赖已就绪，可执行
  | "executing"   // 正在执行
  | "paused"      // 被用户/系统暂停
  | "completed"   // 执行完成
  | "failed"      // 执行失败
  | "cancelled"   // 已取消
  | "preempted";  // 被高优先级任务抢占（暂停）

/** 终态集合 */
export const TERMINAL_QUEUE_STATUSES: ReadonlySet<QueueEntryStatus> = new Set([
  "completed", "failed", "cancelled",
]);

/** 可调度状态（可以被 dequeue 执行的状态） */
export const SCHEDULABLE_STATUSES: ReadonlySet<QueueEntryStatus> = new Set([
  "queued", "ready",
]);

/** 活跃状态（占用资源的状态） */
export const ACTIVE_STATUSES: ReadonlySet<QueueEntryStatus> = new Set([
  "executing",
]);

/** 可恢复状态 */
export const RESUMABLE_STATUSES: ReadonlySet<QueueEntryStatus> = new Set([
  "paused", "preempted",
]);

/* ================================================================== */
/*  依赖类型                                                            */
/* ================================================================== */

/** 依赖类型 */
export type DepType =
  | "finish_to_start"   // 前置完成后才能开始
  | "output_to_input"   // 前置输出注入后续输入
  | "cancel_cascade";   // 取消时级联

/** 依赖状态 */
export type DepStatus =
  | "pending"      // 等待满足
  | "resolved"     // 已满足
  | "blocked"      // 上游失败/取消导致永久阻塞
  | "overridden";  // 被用户手动覆盖

/** 依赖来源 */
export type DepSource =
  | "auto"     // LLM 自动推断
  | "manual"   // 用户手动创建
  | "system";  // 系统规则生成

/* ================================================================== */
/*  队列条目                                                            */
/* ================================================================== */

/** 任务队列条目（对应 session_task_queue 表） */
export interface TaskQueueEntry {
  entryId: string;
  tenantId: string;
  spaceId: string | null;
  sessionId: string;
  taskId: string | null;
  runId: string | null;
  jobId: string | null;

  /** 用户原始请求/目标 */
  goal: string;
  /** 执行模式 */
  mode: "answer" | "execute" | "collab";
  /** 优先级 0-100，0 为最高 */
  priority: number;
  /** 队列内排序位置 */
  position: number;

  /** 队列状态 */
  status: QueueEntryStatus;
  /** 是否为前台任务 */
  foreground: boolean;

  /** 入队时间 */
  enqueuedAt: string;
  /** 依赖就绪时间 */
  readyAt: string | null;
  /** 开始执行时间 */
  startedAt: string | null;
  /** 完成时间 */
  completedAt: string | null;
  /** 预估执行时长 ms */
  estimatedDurationMs: number | null;

  /** 重试次数 */
  retryCount: number;
  /** 最后一次错误 */
  lastError: string | null;
  /** checkpoint 引用 */
  checkpointRef: string | null;

  /** 创建者 */
  createdBySubjectId: string;
  /** 扩展元数据 */
  metadata: Record<string, unknown> | null;

  createdAt: string;
  updatedAt: string;
}

/* ================================================================== */
/*  依赖关系                                                            */
/* ================================================================== */

/** 任务依赖关系（对应 task_dependencies 表） */
export interface TaskDependency {
  depId: string;
  tenantId: string;
  sessionId: string;

  /** 依赖方：此任务依赖 toEntryId */
  fromEntryId: string;
  /** 被依赖方：此任务被 fromEntryId 依赖 */
  toEntryId: string;

  /** 依赖类型 */
  depType: DepType;
  /** 依赖状态 */
  status: DepStatus;

  /** 输出映射（output_to_input 类型使用） */
  outputMapping: Record<string, string> | null;

  /** 依赖来源 */
  source: DepSource;

  /** 满足时间 */
  resolvedAt: string | null;

  createdAt: string;
  updatedAt: string;
}

/* ================================================================== */
/*  操作参数                                                            */
/* ================================================================== */

/** 入队参数 */
export interface EnqueueParams {
  tenantId: string;
  spaceId?: string | null;
  sessionId: string;
  goal: string;
  mode: "answer" | "execute" | "collab";
  priority?: number;
  foreground?: boolean;
  createdBySubjectId: string;
  taskId?: string | null;
  runId?: string | null;
  jobId?: string | null;
  estimatedDurationMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

/** 入队结果 */
export interface EnqueueResult {
  entry: TaskQueueEntry;
  position: number;
  /** 该会话当前正在执行的任务数 */
  activeCount: number;
}

/** P3-14: 自动重试配置 */
export interface RetryConfig {
  /** 最大自动重试次数（0 = 不自动重试） */
  maxAutoRetries: number;
  /** 重试间隔基数 ms（指数退避: baseDelayMs * 2^retryCount） */
  baseDelayMs: number;
  /** 最大重试间隔 ms */
  maxDelayMs: number;
  /** 是否自动修复断裂的依赖链（将 blocked deps 标记为 overridden） */
  autoRepairDepChain: boolean;
}

/** 默认重试配置 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAutoRetries: 2,
  baseDelayMs: 3000,
  maxDelayMs: 30000,
  autoRepairDepChain: false,
};

/** 调度决策 */
export interface ScheduleDecision {
  /** 是否立即执行 */
  immediate: boolean;
  /** 如果不是立即执行，预估等待时间 ms */
  estimatedWaitMs?: number;
  /** 如果需要抢占，被抢占的 entryId */
  preemptEntryId?: string;
  /** 原因说明 */
  reason: string;
}

/** 队列状态快照（给前端用） */
export interface QueueSnapshot {
  sessionId: string;
  entries: TaskQueueEntry[];
  dependencies: TaskDependency[];
  /** 当前活跃（executing）任务数 */
  activeCount: number;
  /** 排队中任务数 */
  queuedCount: number;
  /** 前台任务 entryId */
  foregroundEntryId: string | null;
}

/* ================================================================== */
/*  SSE 多路复用事件                                                     */
/* ================================================================== */

/** 队列管理 SSE 事件类型 */
export type QueueEventType =
  | "taskQueued"         // 任务已入队
  | "taskStarted"        // 任务开始执行
  | "taskCompleted"      // 任务执行完成
  | "taskFailed"         // 任务执行失败
  | "taskCancelled"      // 任务已取消
  | "taskPaused"         // 任务已暂停
  | "taskResumed"        // 任务已恢复
  | "taskPreempted"      // 任务被抢占
  | "taskRetried"        // 任务自动重试
  | "taskReordered"      // 队列顺序已变更
  | "taskForeground"     // 任务切换为前台
  | "taskBackground"     // 任务切换为后台
  | "depCreated"         // 依赖关系已创建
  | "depResolved"        // 依赖已满足
  | "depBlocked"         // 依赖被阻塞
  | "cascadeCancelled"   // 级联取消
  | "depRepaired"        // 依赖链修复（blocked→overridden）
  | "queueSnapshot";     // 队列完整快照（初始化/恢复用）

/** 队列 SSE 事件载荷 */
export interface QueueEvent {
  type: QueueEventType;
  sessionId: string;
  entryId?: string;
  taskId?: string | null;
  data: Record<string, unknown>;
  timestamp: string;
}

/* ================================================================== */
/*  DB 行映射辅助                                                       */
/* ================================================================== */

/** 将数据库行（snake_case）映射为 TaskQueueEntry（camelCase） */
export function rowToQueueEntry(row: Record<string, unknown>): TaskQueueEntry {
  return {
    entryId: row.entry_id as string,
    tenantId: row.tenant_id as string,
    spaceId: (row.space_id as string) || null,
    sessionId: row.session_id as string,
    taskId: (row.task_id as string) || null,
    runId: (row.run_id as string) || null,
    jobId: (row.job_id as string) || null,
    goal: row.goal as string,
    mode: row.mode as TaskQueueEntry["mode"],
    priority: row.priority as number,
    position: row.position as number,
    status: row.status as QueueEntryStatus,
    foreground: row.foreground as boolean,
    enqueuedAt: String(row.enqueued_at),
    readyAt: row.ready_at ? String(row.ready_at) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    estimatedDurationMs: (row.estimated_duration_ms as number) || null,
    retryCount: (row.retry_count as number) || 0,
    lastError: (row.last_error as string) || null,
    checkpointRef: (row.checkpoint_ref as string) || null,
    createdBySubjectId: row.created_by_subject_id as string,
    metadata: (row.metadata as Record<string, unknown>) || null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 将数据库行映射为 TaskDependency */
export function rowToDependency(row: Record<string, unknown>): TaskDependency {
  return {
    depId: row.dep_id as string,
    tenantId: row.tenant_id as string,
    sessionId: row.session_id as string,
    fromEntryId: row.from_entry_id as string,
    toEntryId: row.to_entry_id as string,
    depType: row.dep_type as DepType,
    status: row.status as DepStatus,
    outputMapping: (row.output_mapping as Record<string, string>) || null,
    source: row.source as DepSource,
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
