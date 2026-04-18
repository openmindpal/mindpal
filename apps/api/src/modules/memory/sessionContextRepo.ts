import type { Pool } from "pg";

export type SessionRole = "user" | "assistant" | "system";

export type SessionMessage = {
  role: SessionRole;
  content: string;
  at?: string;
};

export type SessionContext = {
  v: 2;  // v2: 新增 sessionState 结构化槽位
  messages: SessionMessage[];
  /** 窗口溢出时由 LLM 生成的早期对话摘要 */
  summary?: string;
  /** 累计总轮数（含已被截断的轮次） */
  totalTurnCount?: number;
  /** P0: 结构化会话状态槽位（支持精准代词回指、话题切换恢复） */
  sessionState?: SessionState;
};

/** P0: 会话状态槽位（从结构化摘要中提取） */
export type SessionState = {
  /** 当前讨论的核心主题 */
  activeTopic?: string;
  /** 用户明确表达的任务意图或目标 */
  userIntent?: string;
  /** 焦点实体（如"XX项目""XX审批"） */
  entitiesInFocus?: string[];
  /** 约束条件列表 */
  constraints?: string[];
  /** 待回答问题列表 */
  pendingQuestions?: string[];
  /** 风险点列表 */
  riskPoints?: string[];
  /** 最后更新时间（ISO格式） */
  lastUpdatedAt?: string;
};

export type SessionContextListRow = {
  sessionId: string;
  context: SessionContext;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionContextListItem = {
  sessionId: string;
  messageCount: number;
  retainedMessageCount: number;
  isTrimmed: boolean;
  preview: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

function toRow(r: any) {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    spaceId: r.space_id as string,
    subjectId: r.subject_id as string,
    sessionId: r.session_id as string,
    context: (r.context_digest ?? null) as any,
    expiresAt: (r.expires_at ?? null) as string | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function normalizePreview(text: string | undefined, maxLength = 100) {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.slice(0, maxLength);
}

export function toSessionContextListItem(row: SessionContextListRow): SessionContextListItem {
  const messages = Array.isArray(row.context?.messages) ? row.context.messages : [];
  const retainedMessageCount = messages.length;
  const totalTurnCount = Number(row.context?.totalTurnCount);
  const messageCount = Number.isFinite(totalTurnCount)
    ? Math.max(retainedMessageCount, Math.floor(totalTurnCount))
    : retainedMessageCount;
  const isTrimmed = messageCount > retainedMessageCount;
  const firstUserPreview = normalizePreview(messages.find((m) => m.role === "user" && m.content)?.content);
  const latestUserPreview = normalizePreview([...messages].reverse().find((m) => m.role === "user" && m.content)?.content);
  const summaryPreview = normalizePreview(row.context?.summary);
  const preview = isTrimmed
    ? (summaryPreview || firstUserPreview || latestUserPreview)
    : (firstUserPreview || latestUserPreview || summaryPreview);
  return {
    sessionId: row.sessionId,
    messageCount,
    retainedMessageCount,
    isTrimmed,
    preview,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

export async function getSessionContext(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; sessionId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM memory_session_contexts
      WHERE tenant_id = $1
        AND space_id = $2
        AND subject_id = $3
        AND session_id = $4
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.subjectId, params.sessionId],
  );
  if (!res.rowCount) return null;
  const row = toRow(res.rows[0]);
  const ctx = row.context && typeof row.context === "object" ? (row.context as SessionContext) : null;
  if (!ctx || ctx.v < 1 || !Array.isArray(ctx.messages)) return null;
  return { sessionId: row.sessionId, context: ctx, expiresAt: row.expiresAt };
}

export async function upsertSessionContext(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  sessionId: string;
  context: SessionContext;
  expiresAt: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO memory_session_contexts (tenant_id, space_id, subject_id, session_id, context_digest, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (tenant_id, space_id, subject_id, session_id)
      DO UPDATE SET context_digest = EXCLUDED.context_digest, expires_at = EXCLUDED.expires_at, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.subjectId, params.sessionId, params.context, params.expiresAt],
  );
  return toRow(res.rows[0]);
}

export async function clearSessionContext(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; sessionId: string }) {
  const res = await params.pool.query(
    `
      DELETE FROM memory_session_contexts
      WHERE tenant_id = $1 AND space_id = $2 AND subject_id = $3 AND session_id = $4
    `,
    [params.tenantId, params.spaceId, params.subjectId, params.sessionId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** P2-2: 列出用户的会话上下文 */
export async function listSessionContexts(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  limit?: number;
}) {
  const limit = params.limit ?? 20;
  const res = await params.pool.query(
    `
      SELECT *
      FROM memory_session_contexts
      WHERE tenant_id = $1
        AND space_id = $2
        AND subject_id = $3
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY updated_at DESC
      LIMIT $4
    `,
    [params.tenantId, params.spaceId, params.subjectId, limit],
  );
  return res.rows.map((r) => {
    const row = toRow(r);
    const ctx = row.context && typeof row.context === "object" ? (row.context as SessionContext) : null;
    return { sessionId: row.sessionId, context: ctx, expiresAt: row.expiresAt, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }).filter((x) => x.context && x.context.v >= 1 && Array.isArray(x.context.messages));
}

