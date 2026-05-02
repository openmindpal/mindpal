/**
 * collabStepTracker.ts — Collab Step 事件追踪中间件
 *
 * 将 index.ts Worker callback 中 130+ 行的 collab 事件追踪代码
 * 提取为 beforeStep / afterStep / afterRunStatusSync 三个钩子。
 * 属于 cross-cutting concern，非 collab run 时自动跳过。
 */
import type { Pool } from "pg";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:collabStepTracker" });
import { appendCollabEventOnce } from "../lib/collabEvents";
import { applyWorkerCollabState, mapRunStatusToCollabPhase } from "./collabStateSync";

export interface CollabMeta {
  tenantId: string;
  spaceId: string | null;
  collabRunId: string;
  taskId: string;
  actorRole: string | null;
  stepId: string;
  runId: string;
}

/**
 * 从 step + run 行获取 collab 元数据。
 * 如果不是 collab step 则返回 null。
 */
export async function resolveCollabMeta(pool: Pool, stepId: string, runId: string): Promise<CollabMeta | null> {
  const metaRes = await pool.query(
    `
      SELECT r.tenant_id, (s.input->>'spaceId') AS space_id,
             (s.input->>'collabRunId') AS collab_run_id,
             (s.input->>'taskId') AS task_id,
             (s.input->>'actorRole') AS actor_role
      FROM steps s
      JOIN runs r ON r.run_id = s.run_id
      WHERE s.step_id = $1
      LIMIT 1
    `,
    [stepId],
  );
  if (!metaRes.rowCount) return null;

  const collabRunId = String(metaRes.rows[0].collab_run_id ?? "");
  const taskId = String(metaRes.rows[0].task_id ?? "");
  if (!collabRunId || !taskId) return null;

  return {
    tenantId: String(metaRes.rows[0].tenant_id ?? ""),
    spaceId: metaRes.rows[0].space_id ? String(metaRes.rows[0].space_id) : null,
    collabRunId,
    taskId,
    actorRole: metaRes.rows[0].actor_role ? String(metaRes.rows[0].actor_role) : null,
    stepId,
    runId,
  };
}

/**
 * beforeStep — 在 processStep 之前调用，发送 collab.step.started 事件。
 */
export async function beforeStep(pool: Pool, meta: CollabMeta, redis?: { publish(channel: string, message: string): Promise<number> }): Promise<void> {
  const ex = await pool.query(
    "SELECT 1 FROM collab_run_events WHERE tenant_id = $1 AND collab_run_id = $2 AND type = $3 AND step_id = $4 LIMIT 1",
    [meta.tenantId, meta.collabRunId, "collab.step.started", meta.stepId],
  );
  if (ex.rowCount) return; // 已有，跳过

  const tool = await pool.query(
    "SELECT tool_ref, seq, (input->>'planStepId') AS plan_step_id FROM steps WHERE step_id = $1 LIMIT 1",
    [meta.stepId],
  );
  const toolRef = tool.rowCount ? (tool.rows[0].tool_ref ? String(tool.rows[0].tool_ref) : null) : null;
  const seq = tool.rowCount ? Number(tool.rows[0].seq ?? 0) : 0;
  const planStepId = tool.rowCount ? (tool.rows[0].plan_step_id ? String(tool.rows[0].plan_step_id) : null) : null;

  await appendCollabEventOnce({
    pool, redis,
    tenantId: meta.tenantId, spaceId: meta.spaceId, collabRunId: meta.collabRunId,
    taskId: meta.taskId, type: "collab.step.started", actorRole: meta.actorRole,
    runId: meta.runId, stepId: meta.stepId, payloadDigest: { toolRef, seq, planStepId },
    dedupeKeys: ["stepId"],
  });
}

/**
 * afterStep — 在 processStep 之后调用，发送 collab.step.completed / collab.step.failed 事件。
 */
export async function afterStep(pool: Pool, meta: CollabMeta, redis?: { publish(channel: string, message: string): Promise<number> }): Promise<void> {
  const st = await pool.query(
    "SELECT status, tool_ref, seq, error_category, last_error_digest, output_digest, (input->>'planStepId') AS plan_step_id FROM steps WHERE step_id = $1 LIMIT 1",
    [meta.stepId],
  );
  if (!st.rowCount) return;

  const s = String(st.rows[0].status ?? "");
  const toolRef = st.rows[0].tool_ref ? String(st.rows[0].tool_ref) : null;
  const seq = Number(st.rows[0].seq ?? 0);
  const planStepId = st.rows[0].plan_step_id ? String(st.rows[0].plan_step_id) : null;
  const type = s === "succeeded" ? "collab.step.completed" : s === "failed" ? "collab.step.failed" : "";
  if (!type) return;

  const payload =
    type === "collab.step.completed"
      ? { toolRef, seq, planStepId, outputDigest: st.rows[0].output_digest ?? null }
      : { toolRef, seq, planStepId, errorCategory: st.rows[0].error_category ?? null, lastErrorDigest: st.rows[0].last_error_digest ?? null };

  await appendCollabEventOnce({
    pool, redis,
    tenantId: meta.tenantId, spaceId: meta.spaceId, collabRunId: meta.collabRunId,
    taskId: meta.taskId, type, actorRole: meta.actorRole,
    runId: meta.runId, stepId: meta.stepId, payloadDigest: payload,
    dedupeKeys: ["stepId"],
  });
}

/**
 * afterRunStatusSync — 当 run 终态时同步 collab_runs 状态并发送 collab.run.{status} 事件。
 */
export async function afterRunStatusSync(pool: Pool, data: { runId: string }, collabMeta: CollabMeta | null, redis?: { publish(channel: string, message: string): Promise<number> }): Promise<void> {
  const r = await pool.query(
    "SELECT status, input_digest, tenant_id FROM runs WHERE run_id = $1 LIMIT 1",
    [String(data.runId ?? "")],
  );
  if (!r.rowCount) return;

  const st = String(r.rows[0].status ?? "");
  const inputDigest = (r.rows[0].input_digest as any) ?? null;
  const collabRunId = typeof inputDigest?.collabRunId === "string" ? String(inputDigest.collabRunId) : "";
  const taskId = typeof inputDigest?.taskId === "string" ? String(inputDigest.taskId) : "";
  const kind = String(inputDigest?.kind ?? "");
  const tenantId = String(r.rows[0].tenant_id ?? "");

  if (kind === "collab.run" && collabRunId && taskId && ["succeeded", "failed", "canceled", "stopped"].includes(st)) {
    await pool.query(
      "UPDATE collab_runs SET status = $3, updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2",
      [tenantId, collabRunId, st],
    );
    const phase = mapRunStatusToCollabPhase(st);
    if (phase) {
      await applyWorkerCollabState({
        pool,
        redis,
        tenantId,
        collabRunId,
        taskId,
        phase,
        setCurrentRole: true,
        currentRole: null,
        updateType: phase === "failed" ? "error" : "phase_change",
        sourceRole: "system",
        payload: { runId: String(data.runId ?? ""), status: st, terminal: true },
      }).catch((e: any) => {
        _logger.warn("terminal collab state sync failed", {
          runId: String(data.runId ?? ""),
          collabRunId,
          status: st,
          error: String(e?.message ?? e),
        });
      });
    }
    await appendCollabEventOnce({
      pool, redis,
      tenantId, spaceId: collabMeta?.spaceId ?? null, collabRunId, taskId,
      type: `collab.run.${st}`, actorRole: null,
      runId: String(data.runId ?? ""), stepId: null, payloadDigest: null,
    });
  }
}
