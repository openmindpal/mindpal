import type { Pool } from "pg";
import { getRun, listSteps } from "./jobRepo";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "replayRepo" });

function digestObject(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const keys = Object.keys(body as any);
  return { keys: keys.slice(0, 50), keyCount: keys.length };
}

/**
 * P3-07a: 增强版 Agent Loop 回放
 *
 * 返回完整执行时间线：
 * 1. 基础 run + steps 信息
 * 2. 审计事件时间线（决策+观察+调用）
 * 3. GoalGraph 变化历史（目标分解、状态变更、重规划）
 * 4. WorldState 快照序列（每次迭代后的世界状态变化）
 * 5. Checkpoint 记录（循环恢复点）
 * 6. 目标验证日志（Verifier 评估结果）
 */
export async function buildRunReplay(params: { pool: Pool; tenantId: string; runId: string; limit?: number }) {
  const run = await getRun(params.pool, params.tenantId, params.runId);
  if (!run) return null;
  const steps = await listSteps(params.pool, run.runId);

  const limit = params.limit ?? 500;

  // 1. 审计事件时间线
  const evRes = await params.pool.query(
    `
      SELECT timestamp, event_id, resource_type, action, result, error_category, trace_id, request_id, run_id, step_id
      FROM audit_events
      WHERE tenant_id = $1 AND run_id = $2
      ORDER BY timestamp ASC, event_id ASC
      LIMIT $3
    `,
    [params.tenantId, params.runId, limit],
  );

  const timeline = evRes.rows.map((r: any) => {
    const ts = r.timestamp ? new Date(r.timestamp).toISOString() : null;
    return {
      timestamp: ts,
      eventType: `${String(r.resource_type)}.${String(r.action)}`,
      runId: r.run_id,
      stepId: r.step_id ?? null,
      result: r.result ?? null,
      errorCategory: r.error_category ?? null,
      traceId: r.trace_id ?? null,
      requestId: r.request_id ?? null,
    };
  });

  // 2. P3-07a: GoalGraph 变化历史
  let goalGraphHistory: any[] = [];
  try {
    const ggRes = await params.pool.query(
      `SELECT graph_id, main_goal, status, version, decomposition_reasoning, decomposed_by_model,
              graph_json, created_at, updated_at
       FROM goal_graphs
       WHERE tenant_id = $1 AND run_id = $2
       ORDER BY version ASC, created_at ASC
       LIMIT 20`,
      [params.tenantId, params.runId],
    );
    goalGraphHistory = ggRes.rows.map((r: any) => {
      const graphJson = r.graph_json ?? {};
      return {
        graphId: r.graph_id,
        mainGoal: r.main_goal,
        status: r.status,
        version: r.version,
        decompositionReasoning: r.decomposition_reasoning ?? null,
        decomposedByModel: r.decomposed_by_model ?? null,
        subGoalCount: Array.isArray(graphJson.subGoals) ? graphJson.subGoals.length : 0,
        subGoalSummary: Array.isArray(graphJson.subGoals)
          ? graphJson.subGoals.map((sg: any) => ({
              subGoalId: sg.subGoalId ?? null,
              description: typeof sg.description === "string" ? sg.description.slice(0, 200) : null,
              status: sg.status ?? null,
              priority: sg.priority ?? null,
            }))
          : [],
        globalSuccessCriteriaCount: Array.isArray(graphJson.globalSuccessCriteria) ? graphJson.globalSuccessCriteria.length : 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  } catch (err) { _logger.warn("goal_graphs query failed (table may not exist)", { err: (err as Error)?.message }); }

  // 3. P3-07a: WorldState 快照序列
  let worldStateSnapshots: any[] = [];
  try {
    const wsRes = await params.pool.query(
      `SELECT state_id, after_iteration, after_step_seq, entity_count, relation_count, fact_count, version, created_at
       FROM world_state_snapshots
       WHERE run_id = $1
       ORDER BY after_iteration ASC, after_step_seq ASC
       LIMIT 100`,
      [params.runId],
    );
    worldStateSnapshots = wsRes.rows.map((r: any) => ({
      stateId: r.state_id,
      afterIteration: r.after_iteration,
      afterStepSeq: r.after_step_seq,
      entityCount: r.entity_count,
      relationCount: r.relation_count,
      factCount: r.fact_count,
      version: r.version,
      createdAt: r.created_at,
    }));
  } catch (err) { _logger.warn("world_state_snapshots query failed (table may not exist)", { err: (err as Error)?.message }); }

  // 4. P3-07a: Checkpoint 记录
  let checkpoints: any[] = [];
  try {
    const cpRes = await params.pool.query(
      `SELECT loop_id, iteration, current_seq, succeeded_steps, failed_steps,
              status, node_id, heartbeat_at, started_at, finished_at, resume_count, created_at
       FROM agent_loop_checkpoints
       WHERE run_id = $1
       ORDER BY created_at ASC
       LIMIT 50`,
      [params.runId],
    );
    checkpoints = cpRes.rows.map((r: any) => ({
      loopId: r.loop_id,
      iteration: r.iteration,
      currentSeq: r.current_seq,
      succeededSteps: r.succeeded_steps,
      failedSteps: r.failed_steps,
      status: r.status,
      nodeId: r.node_id,
      heartbeatAt: r.heartbeat_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      resumeCount: r.resume_count,
      createdAt: r.created_at,
    }));
  } catch (err) { _logger.warn("agent_loop_checkpoints query failed (table may not exist)", { err: (err as Error)?.message }); }

  // 5. P3-07a: 目标验证日志
  let verificationLog: any[] = [];
  try {
    const vfRes = await params.pool.query(
      `SELECT log_id, iteration, verdict, confidence, reasoning, criteria_results, created_at
       FROM goal_verification_log
       WHERE tenant_id = $1 AND run_id = $2
       ORDER BY iteration ASC, created_at ASC
       LIMIT 50`,
      [params.tenantId, params.runId],
    );
    verificationLog = vfRes.rows.map((r: any) => ({
      logId: r.log_id,
      iteration: r.iteration,
      verdict: r.verdict,
      confidence: Number(r.confidence ?? 0),
      reasoning: r.reasoning ?? null,
      criteriaResults: r.criteria_results ?? [],
      createdAt: r.created_at,
    }));
  } catch (err) { _logger.warn("goal_verification_log query failed (table may not exist)", { err: (err as Error)?.message }); }

  const replay = {
    run: {
      ...run,
      sealStatus: (run as any).sealedAt ? "sealed" : "legacy",
      sealedInputDigest: (run as any).sealedInputDigest ?? null,
      sealedOutputDigest: (run as any).sealedOutputDigest ?? null,
      inputDigest: digestObject((run as any).inputDigest),
    },
    steps: steps.map((s: any) => ({
      ...s,
      sealStatus: s.sealedAt ? "sealed" : "legacy",
      sealedInputDigest: (s as any).sealedInputDigest ?? null,
      sealedOutputDigest: (s as any).sealedOutputDigest ?? null,
      inputDigest: digestObject(s.inputDigest),
      outputDigest: digestObject(s.outputDigest),
    })),
    timeline,
    // P3-07a 增强字段
    goalGraphHistory,
    worldStateSnapshots,
    checkpoints,
    verificationLog,
  };
  return replay;
}
