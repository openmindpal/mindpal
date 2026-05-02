/**
 * wsStreamingHandlers.ts — WebSocket 流式执行器集成
 *
 * 从 websocketClient.ts 提取，处理：
 * - handleStreamingStart / Step / Stop / Pause / Resume
 * - sendStreamingEvent（通过 WS 上报进度/状态）
 */
import { safeLog, safeError } from '@mindpal/device-agent-sdk';
import {
  createStreamingExecutor,
  type StreamingExecutor,
  type StreamingStep,
  type StreamingEvent,
  type StreamingExecutorConfig,
} from '@mindpal/device-agent-sdk';
import type { WebSocketMessage } from '@mindpal/device-agent-sdk';

/** 流式会话状态 */
export interface StreamingState {
  executor: StreamingExecutor | null;
  sessionId: string | null;
}

/** 宿主需要提供的最小 WS 发送接口 */
export interface StreamingSendContext {
  ws: { readyState: number; send: (data: string) => void } | null;
}

export function handleStreamingStart(
  state: StreamingState,
  ctx: StreamingSendContext,
  payload?: Record<string, unknown>,
): void {
  const sessionId = String(payload?.sessionId ?? `stream-${Date.now()}`);

  if (state.executor) {
    safeLog(`[WebSocketDeviceAgent] 停止旧的 streaming 会话: ${state.sessionId}`);
    state.executor.stop();
  }

  const execConfig: StreamingExecutorConfig = {
    interStepDelayMs: Number(payload?.interStepDelayMs ?? 50),
    stepTimeoutMs: Number(payload?.stepTimeoutMs ?? 10000),
    ocrCacheTtlMs: Number(payload?.ocrCacheTtlMs ?? 2000),
    maxQueueSize: Number(payload?.maxQueueSize ?? 200),
    stopOnError: Boolean(payload?.stopOnError ?? false),
  };

  state.sessionId = sessionId;
  state.executor = createStreamingExecutor(execConfig);

  state.executor.onEvent((event: StreamingEvent) => {
    sendStreamingEvent(state, ctx, sessionId, event);
  });

  if (Array.isArray(payload?.steps)) {
    state.executor.appendSteps(payload.steps as StreamingStep[]);
  }

  state.executor.start();
  safeLog(`[WebSocketDeviceAgent] streaming 启动: sessionId=${sessionId}`);

  state.executor.waitUntilDone().then(() => {
    if (state.sessionId === sessionId) {
      state.executor = null;
      state.sessionId = null;
      safeLog(`[WebSocketDeviceAgent] streaming 会话结束: ${sessionId}`);
    }
  }).catch(() => {});
}

export function handleStreamingStep(
  state: StreamingState,
  payload?: Record<string, unknown>,
): void {
  if (!state.executor) {
    safeError('[WebSocketDeviceAgent] streaming_step: 无活跃的 streaming 会话');
    return;
  }
  const steps = Array.isArray(payload?.steps) ? payload.steps as StreamingStep[] : [];
  if (steps.length === 0) {
    safeLog('[WebSocketDeviceAgent] streaming_step: 空步骤列表');
    return;
  }
  const done = Boolean(payload?.done);
  state.executor.appendSteps(steps);
  if (done) state.executor.markInputDone();
  safeLog(`[WebSocketDeviceAgent] streaming 追加 ${steps.length} 步, done=${done}`);
}

export function handleStreamingStop(state: StreamingState): void {
  if (!state.executor) {
    safeLog('[WebSocketDeviceAgent] streaming_stop: 无活跃会话，忽略');
    return;
  }
  safeLog(`[WebSocketDeviceAgent] streaming 停止: sessionId=${state.sessionId}`);
  state.executor.stop();
}

export function handleStreamingPause(state: StreamingState): void {
  if (!state.executor) return;
  state.executor.pause();
  safeLog(`[WebSocketDeviceAgent] streaming 暂停`);
}

export function handleStreamingResume(state: StreamingState): void {
  if (!state.executor) return;
  state.executor.resume();
  safeLog(`[WebSocketDeviceAgent] streaming 恢复`);
}

function sendStreamingEvent(
  state: StreamingState,
  ctx: StreamingSendContext,
  sessionId: string,
  event: StreamingEvent,
): void {
  if (!ctx.ws || ctx.ws.readyState !== 1 /* WebSocket.OPEN */) return;

  const msgType: WebSocketMessage['type'] =
    event.type === 'session_end' ? 'streaming_status'
    : event.type === 'state_change' ? 'streaming_status'
    : 'streaming_progress';

  const message: WebSocketMessage = {
    type: msgType,
    payload: {
      sessionId,
      ...event as unknown as Record<string, unknown>,
      summary: state.executor?.getSummary(),
      timestamp: Date.now(),
    },
  };

  try {
    ctx.ws.send(JSON.stringify(message));
  } catch {
    safeError('[WebSocketDeviceAgent] streaming 事件上报失败');
  }
}
