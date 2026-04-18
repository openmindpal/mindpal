/**
 * dispatch.streamSessionPersist.ts — 会话上下文持久化辅助
 *
 * 从 dispatch.stream.ts 提取。原文件中 3 处几乎相同的会话上下文持久化逻辑
 * （即时动作、规划失败、执行完成）统一为本函数。
 */
import { redactValue } from "@openslin/shared";
import { upsertSessionContext, type SessionMessage, type SessionState } from "../../modules/memory/sessionContextRepo";
import type { Pool } from "pg";

function coerceRole(v: any): "user" | "assistant" | "system" {
  const r = String(v ?? "");
  if (r === "assistant" || r === "system" || r === "user") return r;
  return "user";
}

/**
 * 持久化流式会话上下文，保证后续对话轮能看到完整历史。
 *
 * @param params.prevMessages    之前的会话消息列表
 * @param params.userContent     本轮用户消息（已脱敏）
 * @param params.assistantContent 本轮助手回复摘要（可选，如果只有用户消息则不传）
 * @param params.historyLimit    保留消息条数上限
 * @param params.pool            数据库连接池
 * @param params.tenantId        租户 ID
 * @param params.spaceId         空间 ID
 * @param params.subjectId       主体 ID
 * @param params.sessionId       会话 ID
 * @param params.sessionState    P0: 结构化会话状态槽位
 */
export async function persistStreamSessionContext(params: {
  prevMessages: SessionMessage[];
  userMessage: string;
  assistantContent?: string;
  historyLimit: number;
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  sessionId: string;
  sessionState?: SessionState;
}): Promise<void> {
  const { prevMessages, userMessage, assistantContent, historyLimit, pool, tenantId, spaceId, subjectId, sessionId } = params;
  const nowIso = new Date().toISOString();
  const redacted = redactValue(userMessage);
  const userContent = String(redacted.value ?? "");

  const nextMsgs: SessionMessage[] = [
    ...prevMessages
      .map((m: any) => ({ role: coerceRole(m.role), content: String(m.content ?? ""), at: typeof m.at === "string" ? m.at : undefined }))
      .filter((m: any) => m.content),
    { role: "user" as const, content: userContent, at: nowIso },
  ];

  if (assistantContent) {
    nextMsgs.push({ role: "assistant" as const, content: assistantContent, at: nowIso });
  }

  const trimmed = nextMsgs.slice(Math.max(0, nextMsgs.length - historyLimit));
  const ttlDays = Math.max(1, Math.min(30, Number(process.env.ORCHESTRATOR_CONVERSATION_TTL_DAYS ?? "14") || 14));
  const expiresAt = new Date(Date.now() + ttlDays * 86400000).toISOString();

  await upsertSessionContext({
    pool, tenantId, spaceId,
    subjectId, sessionId,
    context: { v: 2, messages: trimmed, sessionState: params.sessionState, totalTurnCount: nextMsgs.length },
    expiresAt,
  });
}
