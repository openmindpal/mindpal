/**
 * Orchestration Events — Worker ↔ API 状态同步事件协议
 *
 * 定义 Worker 向 API 编排内核上报的事件类型，以及步骤执行结果的标准数据结构。
 * 设计原则：
 * - Worker 仅负责执行并上报结果（StepExecutionResult）
 * - API 编排内核根据事件驱动状态转换，决定"下一步做什么"
 * - 所有事件均携带 traceId + tenantId，便于可观测性追踪
 */

/* ================================================================== */
/*  事件类型枚举                                                        */
/* ================================================================== */

/** Worker 向 API 上报的事件类型 */
export enum OrchestrationEventType {
  /** 步骤开始执行 */
  STEP_STARTED = "step.started",
  /** 步骤执行成功完成 */
  STEP_COMPLETED = "step.completed",
  /** 步骤执行失败 */
  STEP_FAILED = "step.failed",
  /** 步骤进入阻塞态（需审批/设备/仲裁） */
  STEP_BLOCKED = "step.blocked",
  /** 工具被调用（执行开始前的信号） */
  TOOL_INVOKED = "tool.invoked",
  /** 工具执行返回结果 */
  TOOL_RESULT = "tool.result",
}

/* ================================================================== */
/*  事件载荷接口                                                        */
/* ================================================================== */

/** 编排事件标准信封 */
export interface OrchestrationEvent {
  /** 事件类型 */
  eventType: OrchestrationEventType;
  /** Agent 运行实例 ID */
  runId: string;
  /** 步骤 ID */
  stepId: string;
  /** 租户 ID */
  tenantId: string;
  /** 分布式追踪 ID */
  traceId: string;
  /** 事件产生时间（ISO 8601） */
  timestamp: string;
  /** 事件载荷（具体结构由 eventType 决定） */
  payload: Record<string, unknown>;
}

/** 步骤执行结果 —— Worker 完成步骤后构造并上报 */
export interface StepExecutionResult {
  /** Agent 运行实例 ID */
  runId: string;
  /** 步骤 ID */
  stepId: string;
  /** 终态状态 */
  status: "completed" | "failed" | "timeout" | "blocked";
  /** 步骤输出（成功时） */
  output?: Record<string, unknown>;
  /** 错误信息（失败时） */
  error?: {
    code: string;
    category: string;
    message: string;
    /** 是否可恢复 */
    recoverable?: boolean;
  };
  /** 阻塞原因（blocked 状态时） */
  blockReason?: "needs_approval" | "needs_device" | "needs_arbiter";
  /** 执行耗时(ms) */
  durationMs: number;
  /** Token 消耗（若步骤涉及 LLM 调用） */
  tokenUsage?: { prompt: number; completion: number };
  /** 工具引用 */
  toolRef?: string;
  /** 步骤序号 */
  seq?: number;
  /** 错误分类标签（与 ErrorCategory 对齐） */
  errorCategory?: string;
}

/* ================================================================== */
/*  编排决策指令 —— API 向 Worker 派发的控制指令                           */
/* ================================================================== */

/** API 编排内核向 Worker 发出的调度指令类型 */
export enum OrchestrationCommandType {
  /** 执行指定步骤 */
  EXECUTE_STEP = "execute_step",
  /** 取消指定步骤 */
  CANCEL_STEP = "cancel_step",
  /** 取消整个运行 */
  CANCEL_RUN = "cancel_run",
}

/* ================================================================== */
/*  预检结果                                                            */
/* ================================================================== */

/** 预检诊断项 */
export interface PreflightIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  details?: Record<string, unknown>;
}

/** 统一预检结果 */
export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
  requiredApprovals?: string[];
}

/** 调度指令信封 */
export interface OrchestrationCommand {
  commandType: OrchestrationCommandType;
  runId: string;
  stepId?: string;
  tenantId: string;
  traceId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

/* ================================================================== */
/*  辅助工具函数                                                        */
/* ================================================================== */

/** 构造标准编排事件 */
export function createOrchestrationEvent(
  eventType: OrchestrationEventType,
  params: {
    runId: string;
    stepId: string;
    tenantId: string;
    traceId: string;
    payload?: Record<string, unknown>;
  },
): OrchestrationEvent {
  return {
    eventType,
    runId: params.runId,
    stepId: params.stepId,
    tenantId: params.tenantId,
    traceId: params.traceId,
    timestamp: new Date().toISOString(),
    payload: params.payload ?? {},
  };
}

/** 从 Worker 原始步骤结果构造 StepExecutionResult */
export function buildStepExecutionResult(params: {
  runId: string;
  stepId: string;
  status: StepExecutionResult["status"];
  output?: Record<string, unknown>;
  error?: StepExecutionResult["error"];
  blockReason?: StepExecutionResult["blockReason"];
  durationMs: number;
  tokenUsage?: StepExecutionResult["tokenUsage"];
  toolRef?: string;
  seq?: number;
  errorCategory?: string;
}): StepExecutionResult {
  return {
    runId: params.runId,
    stepId: params.stepId,
    status: params.status,
    output: params.output,
    error: params.error,
    blockReason: params.blockReason,
    durationMs: params.durationMs,
    tokenUsage: params.tokenUsage,
    toolRef: params.toolRef,
    seq: params.seq,
    errorCategory: params.errorCategory,
  };
}
