/**
 * 快速事件处理器（P0-3: <10ms 响应）
 * 
 * 处理传感器触发、异常检测、紧急停止等安全关键事件
 */

import type { Pool } from 'pg';
import type { ResumeEvent, ResumeResult } from './eventDrivenResume';
import { writeAudit } from './processor/audit';
import { StructuredLogger } from '@mindpal/shared';

const _logger = new StructuredLogger({ module: 'worker:fastEventHandlers' });

// ────────────────────────────────────────────────────────────────
// 结构化日志工具（替代裸 console，便于日志采集与告警联动）
// ────────────────────────────────────────────────────────────────

function structuredLog(
  level: 'info' | 'warn' | 'error',
  tag: string,
  data: Record<string, unknown>,
): void {
  if (level === 'error') _logger.error(tag, data);
  else if (level === 'warn') _logger.warn(tag, data);
  else _logger.info(tag, data);
}

// ────────────────────────────────────────────────────────────────
// 紧急停止处理
// ────────────────────────────────────────────────────────────────

export async function handleEmergencyStop(
  pool: Pool,
  event: ResumeEvent,
  runId: string,
  currentStatus: string,
): Promise<ResumeResult> {
  // 立即暂停运行
  await pool.query(
    "UPDATE runs SET status = 'paused', updated_at = now() WHERE tenant_id = $1 AND run_id = $2",
    [event.tenantId, runId],
  );

  // 暂停所有待执行的步骤
  await pool.query(
    "UPDATE steps SET status = 'paused', updated_at = now() WHERE run_id = $1 AND status = 'pending'",
    [runId],
  );

  // 写入审计（高优先级标记）
  await writeFastEventAudit(pool, event, runId, currentStatus, 'paused', '紧急停止触发');

  structuredLog('error', 'FAST_EVENT.emergency.stop', { runId, previousStatus: currentStatus, newStatus: 'paused', tenantId: event.tenantId });

  return {
    ok: true,
    type: event.type,
    runId,
    previousStatus: currentStatus,
    newStatus: 'paused',
    message: '紧急停止已触发，运行已暂停',
  };
}

// ────────────────────────────────────────────────────────────────
// 传感器阈值超限处理
// ────────────────────────────────────────────────────────────────

export async function handleSensorThreshold(
  pool: Pool,
  event: ResumeEvent,
  runId: string,
  currentStatus: string,
): Promise<ResumeResult> {
  const severity = String(event.payload?.severity ?? 'medium');
  
  let newStatus = currentStatus;
  let message = '';

  if (severity === 'critical') {
    newStatus = 'paused';
    message = '传感器数据严重超限，已暂停运行';
    await pool.query(
      "UPDATE runs SET status = 'paused', updated_at = now() WHERE tenant_id = $1 AND run_id = $2",
      [event.tenantId, runId],
    );
  } else if (severity === 'high') {
    newStatus = 'streaming';
    message = '传感器数据高度超限，进入实时监控调整模式';
    await pool.query(
      "UPDATE runs SET status = 'streaming', updated_at = now() WHERE tenant_id = $1 AND run_id = $2",
      [event.tenantId, runId],
    );
  } else {
    message = '传感器数据超限，继续监控';
  }

  await writeFastEventAudit(pool, event, runId, currentStatus, newStatus, message);
  structuredLog('warn', 'FAST_EVENT.sensor.threshold_exceeded', { runId, severity, newStatus, tenantId: event.tenantId });

  return {
    ok: true,
    type: event.type,
    runId,
    previousStatus: currentStatus,
    newStatus,
    message,
  };
}

// ────────────────────────────────────────────────────────────────
// 障碍物检测处理
// ────────────────────────────────────────────────────────────────

export async function handleObstacleDetected(
  pool: Pool,
  event: ResumeEvent,
  runId: string,
  currentStatus: string,
): Promise<ResumeResult> {
  await pool.query(
    "UPDATE runs SET status = 'needs_device', updated_at = now(), block_reason = 'obstacle_detected' WHERE tenant_id = $1 AND run_id = $2",
    [event.tenantId, runId],
  );

  await writeFastEventAudit(pool, event, runId, currentStatus, 'needs_device', '检测到障碍物，等待路径重规划');
  structuredLog('warn', 'FAST_EVENT.obstacle.detected', { runId, blocked: true, newStatus: 'needs_device', tenantId: event.tenantId });

  return {
    ok: true,
    type: event.type,
    runId,
    previousStatus: currentStatus,
    newStatus: 'needs_device',
    message: '检测到障碍物，已暂停并等待重新规划',
  };
}

// ────────────────────────────────────────────────────────────────
// 力控异常处理
// ────────────────────────────────────────────────────────────────

export async function handleForceAnomaly(
  pool: Pool,
  event: ResumeEvent,
  runId: string,
  currentStatus: string,
): Promise<ResumeResult> {
  const anomalyType = String(event.payload?.anomalyType ?? 'unknown');
  
  let newStatus = 'paused';
  let message = `力控异常 (${anomalyType})，已暂停检查`;

  await pool.query(
    "UPDATE runs SET status = 'paused', updated_at = now(), block_reason = 'force_anomaly' WHERE tenant_id = $1 AND run_id = $2",
    [event.tenantId, runId],
  );

  await writeFastEventAudit(pool, event, runId, currentStatus, newStatus, message);
  structuredLog('warn', 'FAST_EVENT.force.anomaly', { runId, anomalyType, newStatus, tenantId: event.tenantId });

  return {
    ok: true,
    type: event.type,
    runId,
    previousStatus: currentStatus,
    newStatus,
    message,
  };
}

// ────────────────────────────────────────────────────────────────
// 快速事件审计记录（简化版，减少延迟）
// ────────────────────────────────────────────────────────────────

async function writeFastEventAudit(
  pool: Pool,
  event: ResumeEvent,
  runId: string,
  previousStatus: string,
  newStatus: string,
  message: string,
): Promise<void> {
  try {
    await writeAudit(pool, {
      traceId: event.traceId ?? `workflow.fast_event:${event.tenantId}:${runId}:${Date.now()}`,
      tenantId: event.tenantId,
      spaceId: event.spaceId ?? null,
      subjectId: event.subjectId,
      runId,
      stepId: event.stepId,
      resourceType: "workflow",
      action: "fast_event",
      result: "success",
      inputDigest: { eventType: event.type, sourceId: event.sourceId, message },
      outputDigest: { previousStatus, newStatus, message },
    });
  } catch (e) {
    _logger.warn("audit write failed", { err: (e as Error)?.message ?? e });
  }
}
