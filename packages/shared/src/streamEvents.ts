/**
 * Stream Events — 统一流式事件类型定义
 *
 * 将 dispatch.stream.ts / dispatch.streamAnswer.ts 中分散的 SSE 事件名
 * 收敛到统一的类型体系。所有流式推送事件必须使用本模块定义的枚举值。
 *
 * 覆盖场景：
 * - 思考阶段（thinking）
 * - 工具调用（tool_call）
 * - 回答生成（answer delta）
 * - 状态指示（phase indicator）
 * - 安全检测（safety）
 * - 流控制（error / done / keepalive）
 */

/* ================================================================== */
/*  流式事件类型枚举                                                     */
/* ================================================================== */

export enum StreamEventType {
  // ── 思考阶段 ──
  THINKING_START = "thinking.start",
  THINKING_DELTA = "thinking.delta",
  THINKING_END = "thinking.end",

  // ── 工具调用 ──
  TOOL_CALL_START = "tool_call.start",
  TOOL_CALL_PROGRESS = "tool_call.progress",
  TOOL_CALL_END = "tool_call.end",

  // ── 回答生成 ──
  ANSWER_START = "answer.start",
  ANSWER_DELTA = "answer.delta",
  ANSWER_END = "answer.end",

  // ── 状态指示（对应现有 SSE 事件名） ──
  STATUS = "status",
  PHASE_INDICATOR = "phaseIndicator",
  SAFETY = "safety",
  DELTA = "delta",
  TOOL_SUGGESTIONS = "toolSuggestions",
  NL2UI_STATUS = "nl2uiStatus",
  NL2UI_RESULT = "nl2uiResult",

  // ── 流控制 ──
  STREAM_ERROR = "stream.error",
  STREAM_DONE = "stream.done",
  PING = "ping",
  KEEPALIVE = "keepalive",
}

/* ================================================================== */
/*  流式事件载荷接口                                                     */
/* ================================================================== */

/** 统一流式事件信封 */
export interface StreamEvent {
  /** 事件类型 */
  eventType: StreamEventType;
  /** Agent 运行实例 ID（若在任务执行上下文中） */
  runId?: string;
  /** 步骤 ID（若事件关联特定步骤） */
  stepId?: string;
  /** 事件数据载荷 */
  data: unknown;
  /** 事件产生时间（ISO 8601） */
  timestamp: string;
}

/** 流控制接口 —— 客户端或中间件用于管理流生命周期 */
export interface StreamController {
  /** 暂停流推送 */
  pause(): void;
  /** 恢复流推送 */
  resume(): void;
  /** 取消流（发送 STREAM_DONE 后关闭） */
  cancel(): void;
  /** 注册事件处理器 */
  onEvent(handler: (event: StreamEvent) => void): void;
}

/* ================================================================== */
/*  SSE 事件名映射（兼容现有前端协议）                                     */
/* ================================================================== */

/**
 * 从 StreamEventType 到实际 SSE event name 的映射。
 * 现有前端监听的是 "status"、"delta"、"phaseIndicator" 等原始事件名，
 * 此映射保证在 API 层 sendEvent 时使用正确的 SSE 名称。
 */
export const STREAM_EVENT_SSE_NAME: Record<StreamEventType, string> = {
  [StreamEventType.THINKING_START]: "thinking.start",
  [StreamEventType.THINKING_DELTA]: "thinking.delta",
  [StreamEventType.THINKING_END]: "thinking.end",
  [StreamEventType.TOOL_CALL_START]: "tool_call.start",
  [StreamEventType.TOOL_CALL_PROGRESS]: "tool_call.progress",
  [StreamEventType.TOOL_CALL_END]: "tool_call.end",
  [StreamEventType.ANSWER_START]: "answer.start",
  [StreamEventType.ANSWER_DELTA]: "answer.delta",
  [StreamEventType.ANSWER_END]: "answer.end",
  [StreamEventType.STATUS]: "status",
  [StreamEventType.PHASE_INDICATOR]: "phaseIndicator",
  [StreamEventType.SAFETY]: "safety",
  [StreamEventType.DELTA]: "delta",
  [StreamEventType.TOOL_SUGGESTIONS]: "toolSuggestions",
  [StreamEventType.NL2UI_STATUS]: "nl2uiStatus",
  [StreamEventType.NL2UI_RESULT]: "nl2uiResult",
  [StreamEventType.STREAM_ERROR]: "stream.error",
  [StreamEventType.STREAM_DONE]: "stream.done",
  [StreamEventType.PING]: "ping",
  [StreamEventType.KEEPALIVE]: "keepalive",
};

/* ================================================================== */
/*  辅助工具函数                                                        */
/* ================================================================== */

/** 构造标准流式事件 */
export function createStreamEvent(
  eventType: StreamEventType,
  data: unknown,
  options?: { runId?: string; stepId?: string },
): StreamEvent {
  return {
    eventType,
    runId: options?.runId,
    stepId: options?.stepId,
    data,
    timestamp: new Date().toISOString(),
  };
}

/** 获取 SSE 事件名（用于 sendEvent 调用） */
export function getStreamEventSseName(eventType: StreamEventType): string {
  return STREAM_EVENT_SSE_NAME[eventType] ?? eventType;
}
