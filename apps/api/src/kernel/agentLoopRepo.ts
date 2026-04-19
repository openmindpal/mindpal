/**
 * agentLoopRepo — Agent Loop 数据访问层
 *
 * 将 agentLoop.ts 中散落的内嵌 SQL 提取到此处，
 * 保持业务逻辑与数据访问分离。
 */
import type { Pool } from "pg";
import type { GoalGraph } from "@openslin/shared";

/** 获取 run 下已有步骤的最大 seq，用于确定新步骤起始编号 */
export async function getMaxStepSeq(pool: Pool, runId: string): Promise<number> {
  const res = await pool.query<{ max_seq: number }>(
    "SELECT COALESCE(MAX(seq), 0) as max_seq FROM steps WHERE run_id = $1",
    [runId],
  );
  return res.rows[0]?.max_seq ?? 0;
}

/** 插入或更新 GoalGraph（冲突时更新 json / status / version） */
export async function upsertGoalGraph(
  pool: Pool,
  params: {
    goalGraph: GoalGraph;
    tenantId: string;
    spaceId: string | null;
    runId: string;
    loopId: string;
    goal: string;
  },
): Promise<void> {
  const { goalGraph, tenantId, spaceId, runId, loopId, goal } = params;
  await pool.query(
    `INSERT INTO goal_graphs (graph_id, tenant_id, space_id, run_id, loop_id, main_goal, graph_json, decomposition_reasoning, decomposed_by_model, status, version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (graph_id) DO UPDATE SET graph_json=$7, status=$10, version=$11, updated_at=now()`,
    [
      goalGraph.graphId, tenantId, spaceId, runId, loopId,
      goal, JSON.stringify(goalGraph),
      goalGraph.decompositionReasoning ?? null, goalGraph.decomposedByModel ?? null,
      goalGraph.status, goalGraph.version,
    ],
  );
}

/** 删除 run 下所有 pending 状态的步骤（用于 replan） */
export async function deletePendingSteps(pool: Pool, runId: string): Promise<void> {
  await pool.query(
    "DELETE FROM steps WHERE run_id = $1 AND status = 'pending'",
    [runId],
  );
}
