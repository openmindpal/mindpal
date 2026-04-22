/**
 * wsMessageHandlers.ts — WebSocket 消息处理器（任务/设备消息）
 *
 * 从 websocketClient.ts 提取，处理：
 * - handleTaskPending: 任务推送→claim→执行→上报
 * - handleDeviceMessage: 设备间消息分发
 * - reportExecutionResult: HTTP+WS 双通道结果上报
 */
import { safeLog, safeError, sha256_8 } from './log';
import { classifyError } from '@openslin/shared';
import { createTraceContext, injectTraceHeaders } from '@openslin/shared';
import { executeDeviceTool, type DeviceClaimEnvelope } from './executors';
import { apiPostJson } from './api';
import { syncPolicyToCache } from './kernel/auth';
import { dispatchMessageToPlugins } from './pluginRegistry';
import type { WebSocketMessage } from './websocketClient';

/** 最小依赖：宿主 agent 需要提供的上下文 */
export interface WsTaskContext {
  config: { apiBase: string; deviceToken: string; deviceId: string };
  confirmFn: (q: string) => Promise<boolean>;
  ws: { readyState: number; send: (data: string) => void } | null;
  /** 标记需要重新配对 */
  setNeedReEnroll: () => void;
  /** 停止整个 agent */
  stop: () => void;
  /** 设置当前任务 */
  setCurrentTask: (id: string | undefined) => void;
  setRunning: (v: boolean) => void;
}

/** 发送 WebSocket task_result */
export function sendTaskResult(
  ctx: WsTaskContext,
  executionId: string,
  status: 'succeeded' | 'failed',
  extra?: { errorCategory?: string; outputDigest?: any; evidenceRefs?: string[] },
): void {
  if (!ctx.ws || ctx.ws.readyState !== 1 /* WebSocket.OPEN */) {
    safeError(`[WebSocketDeviceAgent] WebSocket 未连接，跳过 WebSocket 结果上报：${executionId}`);
    return;
  }

  const message: WebSocketMessage = {
    type: 'task_result',
    payload: {
      executionId,
      status,
      errorCategory: extra?.errorCategory,
      outputDigest: extra?.outputDigest,
      evidenceRefs: extra?.evidenceRefs,
      timestamp: Date.now(),
      ...injectTraceHeaders(createTraceContext()),
    },
  };

  try {
    ctx.ws.send(JSON.stringify(message));
    safeLog(`[WebSocketDeviceAgent] WebSocket 结果上报：${executionId} -> ${status}`);
  } catch (sendErr: any) {
    safeError(`[WebSocketDeviceAgent] WebSocket 发送失败：${sendErr?.message ?? 'unknown'}`);
  }
}

/** 处理 device_message */
export async function handleDeviceMessage(payload?: Record<string, unknown>): Promise<void> {
  const msg = payload as any;
  if (!msg?.messageId) {
    safeError('[WebSocketDeviceAgent] device_message: messageId 缺失');
    return;
  }
  safeLog(`[WebSocketDeviceAgent] 收到设备消息: messageId=${msg.messageId} from=${msg.fromDeviceId ?? 'system'} topic=${msg.topic ?? 'direct'}`);

  try {
    await dispatchMessageToPlugins({
      messageId: String(msg.messageId),
      fromDeviceId: msg.fromDeviceId ?? null,
      topic: msg.topic ?? null,
      payload: msg.payload ?? {},
      createdAt: msg.createdAt ?? Date.now(),
    });
  } catch (err: any) {
    safeError(`[WebSocketDeviceAgent] 消息分发失败: ${err?.message ?? 'unknown'}`);
  }
}

/** 上报执行结果：HTTP + WebSocket 双通道 */
async function reportExecutionResult(
  ctx: WsTaskContext,
  executionId: string,
  claim: DeviceClaimEnvelope,
  result: { status: 'succeeded' | 'failed'; errorCategory?: string; outputDigest?: any; evidenceRefs?: string[] },
  durationMs: number,
): Promise<void> {
  const toolRef = claim.execution.toolRef;
  const toolNameStr = toolRef.includes('@') ? toolRef.slice(0, toolRef.indexOf('@')) : toolRef;

  const policyDigest = claim.policyDigest ?? null;
  let outputDigest = result.outputDigest ?? {};
  if (policyDigest) outputDigest = { ...outputDigest, policyDigest };
  outputDigest = { ...outputDigest, tool: toolNameStr, durationMs };

  const evidenceRefs = result.status === 'succeeded'
    ? (result.evidenceRefs ?? [`local:evidence:${sha256_8(executionId)}`])
    : undefined;

  // HTTP 上报
  try {
    const httpResult = await apiPostJson({
      apiBase: ctx.config.apiBase,
      path: `/device-agent/executions/${encodeURIComponent(executionId)}/result`,
      token: ctx.config.deviceToken,
      body: { status: result.status, errorCategory: result.errorCategory, outputDigest, evidenceRefs },
    });

    if (httpResult.status === 401 || httpResult.status === 403) {
      safeError(`[WebSocketDeviceAgent] 结果上报鉴权失败（${httpResult.status}），需要重新配对`);
      ctx.setNeedReEnroll();
      ctx.stop();
      return;
    }
    if (httpResult.status !== 200) {
      safeError(`[WebSocketDeviceAgent] HTTP 结果上报失败：status=${httpResult.status}`);
    }
  } catch (httpErr: any) {
    safeError(`[WebSocketDeviceAgent] HTTP 结果上报异常：${httpErr?.message ?? 'unknown'}`);
  }

  // WebSocket 上报
  sendTaskResult(ctx, executionId, result.status, { errorCategory: result.errorCategory, outputDigest, evidenceRefs });
}

/** 处理 task_pending */
export async function handleTaskPending(
  ctx: WsTaskContext,
  payload?: Record<string, unknown>,
): Promise<void> {
  const executionId = String(payload?.executionId ?? '');
  if (!executionId) {
    safeError('[WebSocketDeviceAgent] 任务 ID 缺失');
    return;
  }

  const inlineClaim = payload?.claim as DeviceClaimEnvelope | undefined;
  safeLog(`[WebSocketDeviceAgent] 收到待执行任务：${executionId}（inline=${!!inlineClaim}）`);
  ctx.setCurrentTask(executionId);
  ctx.setRunning(true);

  const startTime = Date.now();

  try {
    let claim: DeviceClaimEnvelope;

    if (inlineClaim?.execution) {
      claim = inlineClaim;
      safeLog(`[WebSocketDeviceAgent] 使用 inline claim，跳过 HTTP claim`);
    } else {
      safeLog(`[WebSocketDeviceAgent] 从 API claim 任务：${executionId}`);
      const claimResp = await apiPostJson<DeviceClaimEnvelope>({
        apiBase: ctx.config.apiBase,
        path: `/device-agent/executions/${encodeURIComponent(executionId)}/claim`,
        token: ctx.config.deviceToken,
        body: {},
      });

      if (claimResp.status === 401 || claimResp.status === 403) {
        safeError(`[WebSocketDeviceAgent] claim 鉴权失败（${claimResp.status}），需要重新配对`);
        ctx.setNeedReEnroll();
        ctx.stop();
        return;
      }
      if (claimResp.status !== 200 || !claimResp.json?.execution) {
        safeError(`[WebSocketDeviceAgent] claim 失败：status=${claimResp.status}`);
        sendTaskResult(ctx, executionId, 'failed', { errorCategory: 'claim_failed' });
        return;
      }
      claim = claimResp.json;
    }

    if (claim.policy) {
      try {
        await syncPolicyToCache(claim.policy);
      } catch (cacheErr: any) {
        safeError(`[WebSocketDeviceAgent] 策略缓存失败：${cacheErr?.message ?? 'unknown'}`);
      }
    }

    safeLog(`[WebSocketDeviceAgent] 执行工具：${claim.execution.toolRef}`);
    const result = await executeDeviceTool({
      cfg: { apiBase: ctx.config.apiBase, deviceToken: ctx.config.deviceToken },
      claim,
      confirmFn: ctx.confirmFn,
    });

    const durationMs = Date.now() - startTime;
    safeLog(`[WebSocketDeviceAgent] 工具执行完成：${claim.execution.toolRef} -> ${result.status}（${durationMs}ms）`);

    await reportExecutionResult(ctx, executionId, claim, result, durationMs);
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const svcErr = classifyError(err);
    const execCategory = svcErr.category === 'internal' ? 'executor_exception' : svcErr.category;
    safeError(`[WebSocketDeviceAgent] 任务执行异常：${svcErr.message}（${durationMs}ms）`);
    sendTaskResult(ctx, executionId, 'failed', {
      errorCategory: execCategory,
      outputDigest: { errorCode: svcErr.code, error: svcErr.message.slice(0, 200) },
    });
  } finally {
    ctx.setCurrentTask(undefined);
    ctx.setRunning(false);
  }
}
