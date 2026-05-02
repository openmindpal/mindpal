/**
 * Streaming Message Router — 流式消息分发逻辑
 *
 * 从 websocketClient.ts 拆出，管理流式处理器注入和消息路由。
 */

import { safeLog } from '../kernel/log';

// ── 流式处理器注入接口（解耦 wsStreamingHandlers）────────────────

/** 流式执行器状态（由宿主注入的 streaming handlers 维护） */
export interface StreamingSessionState {
  executor: { stop: () => void; getSummary: () => any } | null;
  sessionId: string | null;
}

/** 流式发送上下文 */
export interface StreamingSendContext {
  ws: { readyState: number; send: (data: string) => void } | null;
}

/** 流式消息处理器接口 — 应用层需注入 */
export interface StreamingHandlers {
  handleStreamingStart(state: StreamingSessionState, ctx: StreamingSendContext, payload?: Record<string, unknown>): void;
  handleStreamingStep(state: StreamingSessionState, payload?: Record<string, unknown>): void;
  handleStreamingStop(state: StreamingSessionState): void;
  handleStreamingPause(state: StreamingSessionState): void;
  handleStreamingResume(state: StreamingSessionState): void;
}

let _streamingHandlers: StreamingHandlers | null = null;

/**
 * 注入流式消息处理器（应用层在使用 streaming 消息前调用）
 */
export function setStreamingHandlers(handlers: StreamingHandlers): void {
  _streamingHandlers = handlers;
}

// ── 流式消息路由 ─────────────────────────────────────────────

/** 流式消息类型集合 */
const STREAMING_TYPES = new Set([
  'streaming_start',
  'streaming_step',
  'streaming_stop',
  'streaming_pause',
  'streaming_resume',
]);

/**
 * 尝试将消息路由到流式处理器。
 * @returns true 如果消息已被处理（是流式消息），false 表示非流式消息
 */
export function routeStreamingMessage(
  type: string,
  state: StreamingSessionState,
  sendCtx: StreamingSendContext,
  payload?: Record<string, unknown>,
): boolean {
  if (!STREAMING_TYPES.has(type)) return false;

  if (!_streamingHandlers) {
    safeLog(`[StreamingMessageRouter] ${type}: StreamingHandlers 未注入，忽略`);
    return true;
  }

  switch (type) {
    case 'streaming_start':
      _streamingHandlers.handleStreamingStart(state, sendCtx, payload);
      break;
    case 'streaming_step':
      _streamingHandlers.handleStreamingStep(state, payload);
      break;
    case 'streaming_stop':
      _streamingHandlers.handleStreamingStop(state);
      break;
    case 'streaming_pause':
      _streamingHandlers.handleStreamingPause(state);
      break;
    case 'streaming_resume':
      _streamingHandlers.handleStreamingResume(state);
      break;
  }
  return true;
}
