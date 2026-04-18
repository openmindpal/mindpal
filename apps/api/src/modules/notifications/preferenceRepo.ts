/**
 * P3-06b: 通知偏好管理 + 通知查询/已读标记
 *
 * 功能：
 * 1. 通知偏好 CRUD（渠道开关、免打扰、聚合策略、频率限制、事件过滤）
 * 2. 偏好检查 — 投递前根据用户偏好决定是否跳过
 * 3. 通知列表查询（inapp 通知 + 已读/未读状态）
 * 4. 已读标记 / 全部已读
 */
import type { Pool } from "pg";

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface NotificationPreference {
  preferenceId: string;
  tenantId: string;
  subjectId: string;
  channelEmail: boolean;
  channelInapp: boolean;
  channelIm: boolean;
  channelWebhook: boolean;
  dndEnabled: boolean;
  dndStartTime: string | null;
  dndEndTime: string | null;
  dndTimezone: string;
  digestEnabled: boolean;
  digestIntervalMinutes: number;
  digestMaxBatch: number;
  rateLimitPerHour: number;
  rateLimitPerDay: number;
  minSeverity: string;
  mutedEvents: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NotificationPreferenceUpdate {
  channelEmail?: boolean;
  channelInapp?: boolean;
  channelIm?: boolean;
  channelWebhook?: boolean;
  dndEnabled?: boolean;
  dndStartTime?: string | null;
  dndEndTime?: string | null;
  dndTimezone?: string;
  digestEnabled?: boolean;
  digestIntervalMinutes?: number;
  digestMaxBatch?: number;
  rateLimitPerHour?: number;
  rateLimitPerDay?: number;
  minSeverity?: string;
  mutedEvents?: string[];
}

export interface InappNotification {
  notificationId: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  event: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  status: string;
  createdAt: string;
  read: boolean;
  readAt: string | null;
}

// ────────────────────────────────────────────────────────────────
// Row mapper
// ────────────────────────────────────────────────────────────────

function toPref(r: any): NotificationPreference {
  return {
    preferenceId: r.preference_id,
    tenantId: r.tenant_id,
    subjectId: r.subject_id,
    channelEmail: r.channel_email,
    channelInapp: r.channel_inapp,
    channelIm: r.channel_im,
    channelWebhook: r.channel_webhook,
    dndEnabled: r.dnd_enabled,
    dndStartTime: r.dnd_start_time ?? null,
    dndEndTime: r.dnd_end_time ?? null,
    dndTimezone: r.dnd_timezone,
    digestEnabled: r.digest_enabled,
    digestIntervalMinutes: r.digest_interval_minutes,
    digestMaxBatch: r.digest_max_batch,
    rateLimitPerHour: r.rate_limit_per_hour,
    rateLimitPerDay: r.rate_limit_per_day,
    minSeverity: r.min_severity,
    mutedEvents: Array.isArray(r.muted_events) ? r.muted_events : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ────────────────────────────────────────────────────────────────
// 偏好 CRUD
// ────────────────────────────────────────────────────────────────

export async function getPreference(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
}): Promise<NotificationPreference | null> {
  const { pool, tenantId, subjectId } = params;
  const res = await pool.query(
    "SELECT * FROM notification_preferences WHERE tenant_id = $1 AND subject_id = $2 LIMIT 1",
    [tenantId, subjectId],
  );
  if (!res.rowCount) return null;
  return toPref(res.rows[0]);
}

export async function getOrCreatePreference(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
}): Promise<NotificationPreference> {
  const existing = await getPreference(params);
  if (existing) return existing;

  const { pool, tenantId, subjectId } = params;
  const res = await pool.query(
    `INSERT INTO notification_preferences (tenant_id, subject_id)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, subject_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [tenantId, subjectId],
  );
  return toPref(res.rows[0]);
}

export async function updatePreference(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  update: NotificationPreferenceUpdate;
}): Promise<NotificationPreference> {
  const { pool, tenantId, subjectId, update } = params;

  // 确保记录存在
  await getOrCreatePreference({ pool, tenantId, subjectId });

  // 构建动态 SET 子句
  const setClauses: string[] = ["updated_at = now()"];
  const values: any[] = [tenantId, subjectId];
  let idx = 3;

  const fieldMap: Record<string, string> = {
    channelEmail: "channel_email",
    channelInapp: "channel_inapp",
    channelIm: "channel_im",
    channelWebhook: "channel_webhook",
    dndEnabled: "dnd_enabled",
    dndStartTime: "dnd_start_time",
    dndEndTime: "dnd_end_time",
    dndTimezone: "dnd_timezone",
    digestEnabled: "digest_enabled",
    digestIntervalMinutes: "digest_interval_minutes",
    digestMaxBatch: "digest_max_batch",
    rateLimitPerHour: "rate_limit_per_hour",
    rateLimitPerDay: "rate_limit_per_day",
    minSeverity: "min_severity",
  };

  for (const [tsKey, dbCol] of Object.entries(fieldMap)) {
    const val = (update as any)[tsKey];
    if (val !== undefined) {
      setClauses.push(`${dbCol} = $${idx}`);
      values.push(val);
      idx++;
    }
  }

  if (update.mutedEvents !== undefined) {
    setClauses.push(`muted_events = $${idx}`);
    values.push(JSON.stringify(update.mutedEvents));
    idx++;
  }

  const res = await pool.query(
    `UPDATE notification_preferences SET ${setClauses.join(", ")}
     WHERE tenant_id = $1 AND subject_id = $2
     RETURNING *`,
    values,
  );
  return toPref(res.rows[0]);
}

// ────────────────────────────────────────────────────────────────
// 偏好检查（投递前调用）
// ────────────────────────────────────────────────────────────────

export interface DeliveryCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * 检查是否允许向指定用户投递指定渠道的通知
 */
export async function checkDeliveryAllowed(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  channel: string;
  event: string;
}): Promise<DeliveryCheck> {
  const { pool, tenantId, subjectId, channel, event } = params;
  const pref = await getPreference({ pool, tenantId, subjectId });
  if (!pref) return { allowed: true }; // 无偏好 → 默认全部允许

  // 渠道开关检查
  const channelMap: Record<string, boolean> = {
    email: pref.channelEmail,
    inapp: pref.channelInapp,
    im: pref.channelIm,
    webhook: pref.channelWebhook,
  };
  if (channelMap[channel] === false) {
    return { allowed: false, reason: `channel_${channel}_disabled` };
  }

  // 事件静默检查
  if (pref.mutedEvents.includes(event)) {
    return { allowed: false, reason: `event_muted: ${event}` };
  }

  // 免打扰检查
  if (pref.dndEnabled && pref.dndStartTime && pref.dndEndTime) {
    const nowInTz = getCurrentTimeInTz(pref.dndTimezone);
    if (isInDndWindow(nowInTz, pref.dndStartTime, pref.dndEndTime)) {
      return { allowed: false, reason: "dnd_active" };
    }
  }

  // 频率限制检查
  const hourCount = await getRecentNotificationCount(pool, tenantId, subjectId, 60);
  if (hourCount >= pref.rateLimitPerHour) {
    return { allowed: false, reason: "rate_limit_per_hour_exceeded" };
  }

  const dayCount = await getRecentNotificationCount(pool, tenantId, subjectId, 24 * 60);
  if (dayCount >= pref.rateLimitPerDay) {
    return { allowed: false, reason: "rate_limit_per_day_exceeded" };
  }

  return { allowed: true };
}

// ────────────────────────────────────────────────────────────────
// 通知列表 + 已读
// ────────────────────────────────────────────────────────────────

export async function listInappNotifications(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
}): Promise<{ items: InappNotification[]; total: number }> {
  const { pool, tenantId, subjectId, limit = 20, offset = 0, unreadOnly = false } = params;

  let whereExtra = "";
  if (unreadOnly) {
    whereExtra = `AND nrs.id IS NULL`;
  }

  const countRes = await pool.query(
    `SELECT COUNT(*) as count FROM notification_queue nq
     LEFT JOIN notification_read_status nrs
       ON nrs.tenant_id = nq.tenant_id AND nrs.subject_id = $2 AND nrs.notification_id = nq.notification_id
     WHERE nq.tenant_id = $1 AND nq.subject_id = $2 AND nq.channel = 'inapp' AND nq.status = 'sent'
     ${whereExtra}`,
    [tenantId, subjectId],
  );
  const total = Number(countRes.rows[0]?.count ?? 0);

  const res = await pool.query(
    `SELECT nq.*, nrs.read_at
     FROM notification_queue nq
     LEFT JOIN notification_read_status nrs
       ON nrs.tenant_id = nq.tenant_id AND nrs.subject_id = $2 AND nrs.notification_id = nq.notification_id
     WHERE nq.tenant_id = $1 AND nq.subject_id = $2 AND nq.channel = 'inapp' AND nq.status = 'sent'
     ${whereExtra}
     ORDER BY nq.created_at DESC
     LIMIT $3 OFFSET $4`,
    [tenantId, subjectId, limit, offset],
  );

  const items: InappNotification[] = res.rows.map((r: any) => ({
    notificationId: r.notification_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    subjectId: r.subject_id,
    event: r.event,
    title: r.title,
    body: r.body,
    metadata: r.metadata ?? {},
    status: r.status,
    createdAt: r.created_at,
    read: !!r.read_at,
    readAt: r.read_at ?? null,
  }));

  return { items, total };
}

export async function markNotificationRead(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  notificationId: string;
}): Promise<boolean> {
  const { pool, tenantId, subjectId, notificationId } = params;
  const res = await pool.query(
    `INSERT INTO notification_read_status (tenant_id, subject_id, notification_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, subject_id, notification_id) DO NOTHING`,
    [tenantId, subjectId, notificationId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markAllNotificationsRead(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
}): Promise<number> {
  const { pool, tenantId, subjectId } = params;
  const res = await pool.query(
    `INSERT INTO notification_read_status (tenant_id, subject_id, notification_id)
     SELECT $1, $2, nq.notification_id
     FROM notification_queue nq
     WHERE nq.tenant_id = $1 AND nq.subject_id = $2 AND nq.channel = 'inapp' AND nq.status = 'sent'
       AND NOT EXISTS (
         SELECT 1 FROM notification_read_status nrs
         WHERE nrs.tenant_id = $1 AND nrs.subject_id = $2 AND nrs.notification_id = nq.notification_id
       )
     ON CONFLICT DO NOTHING`,
    [tenantId, subjectId],
  );
  return res.rowCount ?? 0;
}

export async function getUnreadCount(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
}): Promise<number> {
  const { pool, tenantId, subjectId } = params;
  const res = await pool.query(
    `SELECT COUNT(*) as count FROM notification_queue nq
     WHERE nq.tenant_id = $1 AND nq.subject_id = $2 AND nq.channel = 'inapp' AND nq.status = 'sent'
       AND NOT EXISTS (
         SELECT 1 FROM notification_read_status nrs
         WHERE nrs.tenant_id = nq.tenant_id AND nrs.subject_id = $2 AND nrs.notification_id = nq.notification_id
       )`,
    [tenantId, subjectId],
  );
  return Number(res.rows[0]?.count ?? 0);
}

// ────────────────────────────────────────────────────────────────
// 辅助函数
// ────────────────────────────────────────────────────────────────

async function getRecentNotificationCount(
  pool: Pool,
  tenantId: string,
  subjectId: string,
  withinMinutes: number,
): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*) as count FROM notification_queue
     WHERE tenant_id = $1 AND subject_id = $2 AND status = 'sent'
       AND sent_at > now() - ($3 || ' minutes')::interval`,
    [tenantId, subjectId, withinMinutes],
  );
  return Number(res.rows[0]?.count ?? 0);
}

function getCurrentTimeInTz(tz: string): string {
  try {
    const d = new Date();
    const formatted = d.toLocaleTimeString("en-US", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return formatted;
  } catch {
    // 时区无效时返回 UTC 时间
    const d = new Date();
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
  }
}

function isInDndWindow(currentTime: string, startTime: string, endTime: string): boolean {
  // 简单字符串比较（HH:MM:SS 格式）
  const cur = currentTime.slice(0, 5); // HH:MM
  const start = startTime.slice(0, 5);
  const end = endTime.slice(0, 5);

  if (start <= end) {
    // 非跨日：22:00-23:59 之类不跨日
    return cur >= start && cur < end;
  } else {
    // 跨日：22:00-08:00
    return cur >= start || cur < end;
  }
}
