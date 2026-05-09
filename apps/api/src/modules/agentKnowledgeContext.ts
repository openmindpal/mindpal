/**
 * agentKnowledgeContext.ts — 知识/任务召回模块
 *
 * 从 agentContext.ts 拆分而来，负责：
 * - 近期任务召回 (recallRecentTasks)
 * - 知识混合检索召回 (recallRelevantKnowledge)
 */
import type { Pool } from "pg";
import { listRecentTaskStates } from "./memory/repo";
import { getKnowledgeContract } from "./contracts/knowledgeContract";
import { StructuredLogger } from "@mindpal/shared";
import { insertAuditEvent } from "./audit/auditRepo";

const _logger = new StructuredLogger({ module: "agentKnowledgeContext" });

// ─── 内部辅助 ─────────────────────────────────────────────────────

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

const TASK_RECALL_MAX_CHARS = Math.max(500, Number(process.env.ORCHESTRATOR_TASK_RECALL_MAX_CHARS) || 1500);
const TASK_RECALL_LIMIT = 8;

const KNOWLEDGE_RECALL_LIMIT = 3;
const KNOWLEDGE_RECALL_MAX_CHARS = 2000;

function knowledgeRecallLimit() {
  const raw = Number(process.env.AGENT_KNOWLEDGE_RECALL_LIMIT ?? String(KNOWLEDGE_RECALL_LIMIT));
  return clampInt(Number.isFinite(raw) ? Math.floor(raw) : KNOWLEDGE_RECALL_LIMIT, 0, 10);
}

// ─── 任务召回 ─────────────────────────────────────────────────────

export async function recallRecentTasks(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId?: string;
  auditContext?: { traceId?: string; requestId?: string };
}): Promise<{ text: string; recallStats?: { taskCount: number } }> {
  try {
    const tasks = await listRecentTaskStates({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      limit: TASK_RECALL_LIMIT,
      subjectId: params.subjectId,
    });
    if (!tasks.length) return { text: "" };

    let totalChars = 0;
    const lines: string[] = [];
    for (const t of tasks) {
      const planSummary = t.plan && typeof t.plan === "object"
        ? (Array.isArray(t.plan.steps) ? `${t.plan.steps.length} steps` : "has plan")
        : "no plan";
      const line = `- [${t.phase}] run=${t.runId.slice(0, 8)}… ${planSummary}, updated=${t.updatedAt}`;
      if (totalChars + line.length > TASK_RECALL_MAX_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }

    if (params.auditContext?.traceId && params.subjectId) {
      insertAuditEvent(params.pool, {
        subjectId: params.subjectId,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        resourceType: "memory",
        action: "task_recall",
        inputDigest: { limit: TASK_RECALL_LIMIT },
        outputDigest: { taskCount: tasks.length, returnedCount: lines.length, totalChars },
        result: "success",
        traceId: params.auditContext.traceId,
        requestId: params.auditContext.requestId,
      }).catch(() => {});
    }

    return { text: lines.join("\n"), recallStats: { taskCount: tasks.length } };
  } catch (err) {
    _logger.warn("recallRecentTasks failed", { err: (err as Error)?.message });
    return { text: "" };
  }
}

// ─── 知识召回 ─────────────────────────────────────────────────────

export async function recallRelevantKnowledge(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  message: string;
  auditContext?: { traceId?: string; requestId?: string };
}): Promise<{ text: string; recallStats?: { hitCount: number } }> {
  const limit = knowledgeRecallLimit();
  if (limit <= 0) return { text: "" };
  try {
    const querySlice = params.message.slice(0, 500);
    const result = await getKnowledgeContract().searchChunksHybrid({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      query: querySlice,
      limit,
    });
    const hits = result.hits ?? [];
    if (!hits.length) return { text: "" };

    let totalChars = 0;
    const lines: string[] = [];
    for (const h of hits) {
      const snippet = String(h.snippet ?? "").slice(0, 500);
      const line = `- [knowledge] ${snippet}`;
      if (totalChars + line.length > KNOWLEDGE_RECALL_MAX_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }

    if (params.auditContext?.traceId) {
      insertAuditEvent(params.pool, {
        subjectId: params.subjectId,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        resourceType: "knowledge",
        action: "recall",
        inputDigest: { queryLen: querySlice.length, limit },
        outputDigest: { hitCount: hits.length, returnedCount: lines.length, totalChars },
        result: "success",
        traceId: params.auditContext.traceId,
        requestId: params.auditContext.requestId,
      }).catch(() => {});
    }

    return { text: lines.join("\n"), recallStats: { hitCount: hits.length } };
  } catch (err) {
    _logger.warn("recallRelevantKnowledge failed", { err: (err as Error)?.message });
    return { text: "" };
  }
}
