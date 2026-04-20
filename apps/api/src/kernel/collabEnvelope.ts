/**
 * Collab Orchestrator — Envelope 读写 + 共享状态 CRUD
 *
 * Agent 间通过 collab_envelopes 进行结构化中间结果共享，
 * 通过 collab_shared_state 进行乐观锁共享信念状态。
 */
import type { Pool } from "pg";
import type { AgentLoopResult } from "./agentLoop";
import { publishAgentResult } from "./collabBus";
import { StructuredLogger, collabConfig } from "@openslin/shared";

const logger = new StructuredLogger({ module: "collabEnvelope" });

// ── 结构化中间结果共享（collab_envelopes）───────────────────────

/** 将 Agent 的结果写入 collab_envelopes，供下游 Agent 查询 */
export async function writeCollabEnvelope(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  collabRunId: string;
  taskId: string;
  fromRole: string;
  toRole: string | null;
  broadcast: boolean;
  kind: string;
  result: AgentLoopResult;
  runId: string;
}): Promise<void> {
  const { pool, tenantId, spaceId, collabRunId, taskId, fromRole, toRole, broadcast, kind, result, runId } = params;
  const payloadDigest = {
    ok: result.ok,
    endReason: result.endReason,
    message: result.message ?? "",
    totalSteps: (result.succeededSteps ?? 0) + (result.failedSteps ?? 0),
    totalIterations: result.iterations ?? 0,
    observations: result.observations ?? [],
    runId,
    // ── 新增：结构化输出，Agent 间可传递工具执行结果的精确引用 ──
    structuredOutputs: extractStructuredOutputs(result.observations ?? []),
    // ── 新增：失败工具信息，下游 Agent 可感知并避免重复尝试 ──
    failedTools: extractFailedTools(result.observations ?? []),
  };
  try {
    await pool.query(
      `INSERT INTO collab_envelopes
       (tenant_id, space_id, collab_run_id, task_id, from_role, to_role, broadcast, kind, payload_digest)
       VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9)`,
      [tenantId, spaceId, collabRunId, taskId, fromRole, toRole, broadcast, kind, JSON.stringify(payloadDigest)],
    );
  } catch (e: any) {
    logger.warn("writeCollabEnvelope failed", { collabRunId, fromRole, error: String(e?.message ?? e) });
  }

  // P1-4: Redis Pub/Sub 实时推送（fire-and-forget，DB 已兜底）
  publishAgentResult({
    pool, tenantId, spaceId, collabRunId, taskId,
    fromAgent: fromRole, fromRole,
    result: { ok: result.ok, endReason: result.endReason, message: result.message, succeededSteps: result.succeededSteps, failedSteps: result.failedSteps, iterations: result.iterations },
    runId,
  }).catch((e: unknown) => {
    logger.warn("publishAgentResult fire-and-forget failed", { err: (e as Error)?.message, collabRunId });
  }); // Redis 失败不影响主流程
}

/** 读取已完成 Agent 的结构化结果，供下游 Agent 参考 */
export async function readCollabEnvelopes(params: {
  pool: Pool;
  collabRunId: string;
  toRole?: string;
}): Promise<Array<{ fromRole: string; kind: string; payloadDigest: any; createdAt: string }>> {
  const { pool, collabRunId, toRole } = params;
  try {
    const res = toRole
      ? await pool.query(
          `SELECT from_role, kind, payload_digest, created_at FROM collab_envelopes
           WHERE collab_run_id = $1::uuid AND (to_role = $2 OR broadcast = true)
           ORDER BY created_at ASC`,
          [collabRunId, toRole],
        )
      : await pool.query(
          `SELECT from_role, kind, payload_digest, created_at FROM collab_envelopes
           WHERE collab_run_id = $1::uuid
           ORDER BY created_at ASC`,
          [collabRunId],
        );
    return res.rows.map((r: any) => ({
      fromRole: String(r.from_role ?? ""),
      kind: String(r.kind ?? ""),
      payloadDigest: r.payload_digest ?? {},
      createdAt: String(r.created_at ?? ""),
    }));
  } catch {
    return [];
  }
}

/** 将结构化信封构建为 LLM 可读的上下文 */
export function buildEnvelopeContext(envelopes: Array<{ fromRole: string; kind: string; payloadDigest: any }>): string {
  if (envelopes.length === 0) return "";
  const sections = envelopes.map((e) => {
    const d = e.payloadDigest;
    const summary = d.message || "";
    const observations = Array.isArray(d.observations) && d.observations.length > 0
      ? `\n    Observations: ${JSON.stringify(d.observations.slice(-collabConfig("COLLAB_ENVELOPE_OBSERVATION_LIMIT")))}`
      : "";
    const structured = d.structuredOutputs && Object.keys(d.structuredOutputs).length > 0
      ? `\n    StructuredOutputs: ${JSON.stringify(d.structuredOutputs)}`
      : "";
    const failed = Array.isArray(d.failedTools) && d.failedTools.length > 0
      ? `\n    FailedTools: ${JSON.stringify(d.failedTools)}`
      : "";
    return `  [${e.fromRole}] (${e.kind}): ok=${d.ok ?? "unknown"}, steps=${d.totalSteps ?? "?"}, summary=${summary}${observations}${structured}${failed}`;
  });
  return "\n\n## Structured Results from Previous Agents\n" + sections.join("\n");
}

// ── 辅助函数：结构化输出提取 ─────────────────────────────────────

/**
 * 从观察序列中提取结构化工具输出（如创建的 entity ID、文件路径等）
 */
function extractStructuredOutputs(observations: any[]): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const obs of observations) {
    if (obs.status === "succeeded" && obs.toolRef && obs.outputDigest) {
      outputs[obs.toolRef] = {
        stepId: obs.stepId,
        output: obs.outputDigest,
      };
    }
  }
  return outputs;
}

/**
 * 从观察序列中提取失败的工具调用信息，供下游 Agent 感知
 */
function extractFailedTools(observations: any[]): Array<{ toolRef: string; errorCategory: string | null; error: unknown }> {
  return observations
    .filter((obs: any) => obs.status === "failed" || obs.status === "deadletter")
    .map((obs: any) => ({
      toolRef: obs.toolRef ?? "unknown",
      errorCategory: obs.errorCategory ?? null,
      error: obs.outputDigest?.error ?? obs.outputDigest ?? null,
    }));
}

// ── 共享信念状态（collab_shared_state）──────────────────────────

/**
 * P1-4: 写入或更新共享信念状态（乐观锁）
 * 如果 version 不匹配，返回当前值而非覆盖
 */
export async function upsertCollabSharedState(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  key: string;
  value: any;
  updatedByAgent: string;
  updatedByRole?: string;
  expectedVersion?: number;
}): Promise<{ ok: boolean; currentVersion: number; currentValue: any }> {
  const { pool, tenantId, collabRunId, key, value, updatedByAgent, updatedByRole } = params;

  if (params.expectedVersion != null) {
    // 乐观锁更新
    const res = await pool.query(
      `UPDATE collab_shared_state SET value = $5, updated_by_agent = $6, updated_by_role = $7, version = version + 1, updated_at = now()
       WHERE tenant_id = $1 AND collab_run_id = $2 AND key = $3 AND version = $4
       RETURNING version, value`,
      [tenantId, collabRunId, key, params.expectedVersion, JSON.stringify(value), updatedByAgent, updatedByRole ?? null],
    );
    if (res.rowCount) {
      const r = res.rows[0] as any;
      return { ok: true, currentVersion: r.version, currentValue: r.value };
    }
    // 版本不匹配，返回当前值
    const current = await pool.query(
      `SELECT version, value FROM collab_shared_state WHERE tenant_id = $1 AND collab_run_id = $2 AND key = $3`,
      [tenantId, collabRunId, key],
    );
    if (current.rowCount) {
      const c = current.rows[0] as any;
      return { ok: false, currentVersion: c.version, currentValue: c.value };
    }
  }

  // UPSERT
  const res = await pool.query(
    `INSERT INTO collab_shared_state (tenant_id, collab_run_id, key, value, updated_by_agent, updated_by_role)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, collab_run_id, key)
     DO UPDATE SET value = $4, updated_by_agent = $5, updated_by_role = $6, version = collab_shared_state.version + 1, updated_at = now()
     RETURNING version, value`,
    [tenantId, collabRunId, key, JSON.stringify(value), updatedByAgent, updatedByRole ?? null],
  );
  const r = res.rows[0] as any;
  return { ok: true, currentVersion: r.version, currentValue: r.value };
}

/** P1-4: 读取共享信念状态 */
export async function readCollabSharedState(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  key?: string;
}): Promise<Array<{ key: string; value: any; version: number; updatedByAgent: string }>> {
  const { pool, tenantId, collabRunId } = params;
  if (params.key) {
    const res = await pool.query(
      `SELECT key, value, version, updated_by_agent FROM collab_shared_state WHERE tenant_id = $1 AND collab_run_id = $2 AND key = $3`,
      [tenantId, collabRunId, params.key],
    );
    return res.rows.map((r: any) => ({ key: r.key, value: r.value, version: r.version, updatedByAgent: r.updated_by_agent }));
  }
  const res = await pool.query(
    `SELECT key, value, version, updated_by_agent FROM collab_shared_state WHERE tenant_id = $1 AND collab_run_id = $2 ORDER BY key`,
    [tenantId, collabRunId],
  );
  return res.rows.map((r: any) => ({ key: r.key, value: r.value, version: r.version, updatedByAgent: r.updated_by_agent }));
}
