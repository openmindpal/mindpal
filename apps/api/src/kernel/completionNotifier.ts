/**
 * P1-4: 完成后异步通知机制
 * 
 * 当任务/运行完成时触发异步通知：
 * - 支持多种通知渠道（inapp, email, im, webhook）
 * - 支持通知订阅配置
 * - 记录通知发送审计日志
 * 
 * 通知场景：
 * 1. 任务完成通知（succeeded/failed/canceled）
 * 2. 审批请求通知（needs_approval）
 * 3. 步骤完成通知（step succeeded/failed）
 * 4. 长时间运行提醒
 */
import type { Pool } from "pg";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type NotificationChannel = "inapp" | "email" | "im" | "webhook";

export type NotificationEvent = 
  | "run.succeeded"
  | "run.failed"
  | "run.canceled"
  | "run.needs_approval"
  | "step.succeeded"
  | "step.failed"
  | "task.completed"
  | "task.long_running"
  | "task.bg_completed"    // P3-09: 后台任务完成
  | "task.bg_failed"       // P3-09: 后台任务失败
  | "task.needs_intervention"; // P3-09: 任务需要干预（依赖阻塞/级联失败等）

export interface NotificationSubscription {
  subscriptionId: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  /** 订阅的事件类型 */
  events: NotificationEvent[];
  /** 通知渠道 */
  channel: NotificationChannel;
  /** 渠道配置（如 webhook URL、email 地址等） */
  channelConfig: Record<string, unknown>;
  /** 是否启用 */
  enabled: boolean;
  createdAt: string;
}

export interface NotificationPayload {
  event: NotificationEvent;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  runId?: string;
  taskId?: string;
  stepId?: string;
  phase?: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  traceId?: string | null;
}

export interface NotificationResult {
  ok: boolean;
  notificationId?: string;
  channel: NotificationChannel;
  status: "queued" | "sent" | "failed";
  error?: string;
}

/* ================================================================== */
/*  Subscription Management                                              */
/* ================================================================== */

/**
 * 创建通知订阅
 */
export async function createSubscription(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  events: NotificationEvent[];
  channel: NotificationChannel;
  channelConfig: Record<string, unknown>;
}): Promise<NotificationSubscription> {
  const { pool, tenantId, spaceId, subjectId, events, channel, channelConfig } = params;
  
  const res = await pool.query<{ subscription_id: string; created_at: string }>(
    `INSERT INTO notification_subscriptions 
     (tenant_id, space_id, subject_id, events, channel, channel_config, enabled, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, true, now(), now())
     RETURNING subscription_id, created_at`,
    [tenantId, spaceId, subjectId, JSON.stringify(events), channel, JSON.stringify(channelConfig)]
  );
  
  return {
    subscriptionId: res.rows[0].subscription_id,
    tenantId,
    spaceId,
    subjectId,
    events,
    channel,
    channelConfig,
    enabled: true,
    createdAt: res.rows[0].created_at,
  };
}

/**
 * 获取匹配的订阅列表
 */
export async function findMatchingSubscriptions(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  event: NotificationEvent;
}): Promise<NotificationSubscription[]> {
  const { pool, tenantId, spaceId, subjectId, event } = params;
  
  // 查找匹配的订阅：
  // 1. 同租户
  // 2. 空间匹配（null 表示所有空间）
  // 3. 主体匹配（null 表示所有主体）
  // 4. 事件匹配
  // 5. 已启用
  const res = await pool.query<{
    subscription_id: string;
    tenant_id: string;
    space_id: string | null;
    subject_id: string | null;
    events: string[];
    channel: string;
    channel_config: any;
    enabled: boolean;
    created_at: string;
  }>(
    `SELECT * FROM notification_subscriptions
     WHERE tenant_id = $1
       AND (space_id IS NULL OR space_id = $2)
       AND (subject_id IS NULL OR subject_id = $3)
       AND events @> $4::jsonb
       AND enabled = true`,
    [tenantId, spaceId, subjectId, JSON.stringify([event])]
  );
  
  return res.rows.map(row => ({
    subscriptionId: row.subscription_id,
    tenantId: row.tenant_id,
    spaceId: row.space_id,
    subjectId: row.subject_id,
    events: row.events as NotificationEvent[],
    channel: row.channel as NotificationChannel,
    channelConfig: row.channel_config ?? {},
    enabled: row.enabled,
    createdAt: row.created_at,
  }));
}

/* ================================================================== */
/*  Notification Dispatch                                                */
/* ================================================================== */

/**
 * 发送通知（入队）
 */
export async function dispatchNotification(params: {
  pool: Pool;
  payload: NotificationPayload;
  subscription: NotificationSubscription;
}): Promise<NotificationResult> {
  const { pool, payload, subscription } = params;
  
  try {
    // 创建通知记录
    const res = await pool.query<{ notification_id: string }>(
      `INSERT INTO notification_queue
       (tenant_id, space_id, subject_id, subscription_id, event, channel, 
        title, body, metadata, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', now(), now())
       RETURNING notification_id`,
      [
        payload.tenantId,
        payload.spaceId,
        payload.subjectId,
        subscription.subscriptionId,
        payload.event,
        subscription.channel,
        payload.title,
        payload.body,
        JSON.stringify(payload.metadata ?? {}),
      ]
    );
    
    return {
      ok: true,
      notificationId: res.rows[0].notification_id,
      channel: subscription.channel,
      status: "queued",
    };
  } catch (err: any) {
    return {
      ok: false,
      channel: subscription.channel,
      status: "failed",
      error: err?.message ?? "Unknown error",
    };
  }
}

/**
 * 触发事件通知
 * 查找所有匹配的订阅并入队通知
 */
export async function triggerEventNotification(params: {
  pool: Pool;
  payload: NotificationPayload;
}): Promise<NotificationResult[]> {
  const { pool, payload } = params;
  
  // 查找匹配的订阅
  const subscriptions = await findMatchingSubscriptions({
    pool,
    tenantId: payload.tenantId,
    spaceId: payload.spaceId,
    subjectId: payload.subjectId,
    event: payload.event,
  });
  
  // 为每个订阅发送通知
  const results: NotificationResult[] = [];
  
  for (const sub of subscriptions) {
    const result = await dispatchNotification({ pool, payload, subscription: sub });
    results.push(result);
  }
  
  return results;
}

/* ================================================================== */
/*  Convenience Functions for Common Events                              */
/* ================================================================== */

/**
 * 通知任务完成
 */
export async function notifyRunCompleted(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  runId: string;
  taskId?: string;
  phase: "succeeded" | "failed" | "canceled";
  summary?: string;
  traceId?: string | null;
}): Promise<NotificationResult[]> {
  const { pool, tenantId, spaceId, subjectId, runId, taskId, phase, summary, traceId } = params;
  
  const eventMap: Record<string, NotificationEvent> = {
    succeeded: "run.succeeded",
    failed: "run.failed",
    canceled: "run.canceled",
  };
  
  const titleMap: Record<string, string> = {
    succeeded: "任务完成",
    failed: "任务失败",
    canceled: "任务已取消",
  };
  
  const event = eventMap[phase] ?? "run.succeeded";
  const title = titleMap[phase] ?? "任务状态更新";
  
  return triggerEventNotification({
    pool,
    payload: {
      event,
      tenantId,
      spaceId,
      subjectId,
      runId,
      taskId,
      phase,
      title,
      body: summary ?? `运行 ${runId} 已${phase === "succeeded" ? "完成" : phase === "failed" ? "失败" : "取消"}`,
      metadata: { runId, taskId, phase },
      traceId,
    },
  });
}

/**
 * 通知需要审批
 */
export async function notifyApprovalRequired(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  runId: string;
  stepId: string;
  toolRef: string;
  approvalId: string;
  traceId?: string | null;
}): Promise<NotificationResult[]> {
  const { pool, tenantId, spaceId, subjectId, runId, stepId, toolRef, approvalId, traceId } = params;
  
  return triggerEventNotification({
    pool,
    payload: {
      event: "run.needs_approval",
      tenantId,
      spaceId,
      subjectId,
      runId,
      stepId,
      title: "待审批操作",
      body: `操作 ${toolRef} 需要您的审批`,
      metadata: { runId, stepId, toolRef, approvalId },
      traceId,
    },
  });
}

/**
 * 通知长时间运行提醒
 */
/**
 * P3-09: 通知后台任务完成
 */
export async function notifyBackgroundTaskCompleted(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  entryId: string;
  taskId?: string | null;
  goal: string;
  traceId?: string | null;
}): Promise<NotificationResult[]> {
  const { pool, tenantId, spaceId, subjectId, entryId, taskId, goal, traceId } = params;

  return triggerEventNotification({
    pool,
    payload: {
      event: "task.bg_completed",
      tenantId,
      spaceId,
      subjectId,
      taskId: taskId ?? undefined,
      title: "后台任务已完成",
      body: `后台任务「${goal.slice(0, 100)}」已完成`,
      metadata: { entryId, taskId, goal: goal.slice(0, 200) },
      traceId,
    },
  });
}

/**
 * P3-09: 通知后台任务失败
 */
export async function notifyBackgroundTaskFailed(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  entryId: string;
  taskId?: string | null;
  goal: string;
  error: string;
  traceId?: string | null;
}): Promise<NotificationResult[]> {
  const { pool, tenantId, spaceId, subjectId, entryId, taskId, goal, error, traceId } = params;

  return triggerEventNotification({
    pool,
    payload: {
      event: "task.bg_failed",
      tenantId,
      spaceId,
      subjectId,
      taskId: taskId ?? undefined,
      title: "后台任务失败",
      body: `后台任务「${goal.slice(0, 100)}」执行失败：${error.slice(0, 200)}`,
      metadata: { entryId, taskId, goal: goal.slice(0, 200), error: error.slice(0, 500) },
      traceId,
    },
  });
}

/**
 * P3-09: 通知任务需要干预（依赖阻塞、级联失败等）
 */
export async function notifyTaskNeedsIntervention(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  entryId: string;
  taskId?: string | null;
  goal: string;
  reason: string;
  traceId?: string | null;
}): Promise<NotificationResult[]> {
  const { pool, tenantId, spaceId, subjectId, entryId, taskId, goal, reason, traceId } = params;

  return triggerEventNotification({
    pool,
    payload: {
      event: "task.needs_intervention",
      tenantId,
      spaceId,
      subjectId,
      taskId: taskId ?? undefined,
      title: "任务需要干预",
      body: `任务「${goal.slice(0, 100)}」需要您的注意：${reason}`,
      metadata: { entryId, taskId, goal: goal.slice(0, 200), reason },
      traceId,
    },
  });
}

export async function notifyLongRunning(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  runId: string;
  taskId?: string;
  durationMinutes: number;
  traceId?: string | null;
}): Promise<NotificationResult[]> {
  const { pool, tenantId, spaceId, subjectId, runId, taskId, durationMinutes, traceId } = params;
  
  return triggerEventNotification({
    pool,
    payload: {
      event: "task.long_running",
      tenantId,
      spaceId,
      subjectId,
      runId,
      taskId,
      title: "长时间运行提醒",
      body: `任务已运行 ${durationMinutes} 分钟`,
      metadata: { runId, taskId, durationMinutes },
      traceId,
    },
  });
}

/* ================================================================== */
/*  Notification Templates                                               */
/* ================================================================== */

/**
 * 格式化通知内容
 */
export function formatNotificationContent(params: {
  template: string;
  variables: Record<string, unknown>;
  locale?: string;
}): string {
  const { template, variables } = params;
  
  let result = template;
  
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{{${key}}}`;
    // P2-2 FIX: 使用 split/join 替代 new RegExp，避免花括号作为正则特殊字符导致 ReDoS 风险
    result = result.split(placeholder).join(String(value ?? ""));
  }
  
  return result;
}

/**
 * 默认通知模板
 */
export const DEFAULT_NOTIFICATION_TEMPLATES: Record<NotificationEvent, { title: { zh: string; en: string }; body: { zh: string; en: string } }> = {
  "run.succeeded": {
    title: { zh: "任务完成", en: "Task Completed" },
    body: { zh: "运行 {{runId}} 已成功完成", en: "Run {{runId}} has completed successfully" },
  },
  "run.failed": {
    title: { zh: "任务失败", en: "Task Failed" },
    body: { zh: "运行 {{runId}} 执行失败", en: "Run {{runId}} has failed" },
  },
  "run.canceled": {
    title: { zh: "任务已取消", en: "Task Canceled" },
    body: { zh: "运行 {{runId}} 已被取消", en: "Run {{runId}} has been canceled" },
  },
  "run.needs_approval": {
    title: { zh: "待审批操作", en: "Approval Required" },
    body: { zh: "操作 {{toolRef}} 需要您的审批", en: "Operation {{toolRef}} requires your approval" },
  },
  "step.succeeded": {
    title: { zh: "步骤完成", en: "Step Completed" },
    body: { zh: "步骤 {{stepId}} 已完成", en: "Step {{stepId}} has completed" },
  },
  "step.failed": {
    title: { zh: "步骤失败", en: "Step Failed" },
    body: { zh: "步骤 {{stepId}} 执行失败", en: "Step {{stepId}} has failed" },
  },
  "task.completed": {
    title: { zh: "任务已完成", en: "Task Completed" },
    body: { zh: "任务 {{taskId}} 已完成", en: "Task {{taskId}} has completed" },
  },
  "task.long_running": {
    title: { zh: "长时间运行提醒", en: "Long Running Alert" },
    body: { zh: "任务已运行 {{durationMinutes}} 分钟", en: "Task has been running for {{durationMinutes}} minutes" },
  },
  "task.bg_completed": {
    title: { zh: "后台任务已完成", en: "Background Task Completed" },
    body: { zh: "后台任务「{{goal}}」已完成", en: "Background task '{{goal}}' has completed" },
  },
  "task.bg_failed": {
    title: { zh: "后台任务失败", en: "Background Task Failed" },
    body: { zh: "后台任务「{{goal}}」执行失败：{{error}}", en: "Background task '{{goal}}' has failed: {{error}}" },
  },
  "task.needs_intervention": {
    title: { zh: "任务需要干预", en: "Task Needs Intervention" },
    body: { zh: "任务「{{goal}}」需要您的注意：{{reason}}", en: "Task '{{goal}}' needs your attention: {{reason}}" },
  },
};
