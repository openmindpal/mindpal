/**
 * 安全状态转换：先通过状态机校验，再执行 SQL 更新。
 * 如果转换不合法则记录警告并跳过更新（降级而非阻塞）。
 *
 * 从 api/kernel/loopStateHelpers 与 worker/workflow/eventDrivenResume 统一提取。
 */
import { tryTransitionRun, type RunStatus } from "./stateMachine";

/** pg Pool 最小接口，避免 shared 包直接依赖 pg */
export interface PoolLike {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface SafeTransitionRunOpts {
  finishedAt?: boolean;
  log?: { info?: (...a: any[]) => void; warn: (...a: any[]) => void };
  /** 可选 tenantId — 传入时 WHERE 条件追加 tenant_id 过滤 */
  tenantId?: string;
  /** 可选：调用方已获取的当前状态，避免重复 SELECT */
  fromStatus?: RunStatus;
  /** Event Sourcing: 触发方标识 */
  triggeredBy?: string;
  /** Event Sourcing: 附加元数据 */
  eventMetadata?: Record<string, unknown>;
}

export async function safeTransitionRun(
  pool: PoolLike,
  runId: string,
  toStatus: RunStatus,
  opts?: SafeTransitionRunOpts,
): Promise<boolean> {
  let from: RunStatus;
  if (opts?.fromStatus) {
    from = opts.fromStatus;
  } else {
    const res = opts?.tenantId
      ? await pool.query<{ status: string }>(
          "SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
          [opts.tenantId, runId],
        )
      : await pool.query<{ status: string }>(
          "SELECT status FROM runs WHERE run_id = $1 LIMIT 1",
          [runId],
        );
    if (!res.rowCount) return false;
    from = res.rows[0].status as RunStatus;
  }
  const transition = tryTransitionRun(from, toStatus);
  if (!transition.ok) {
    opts?.log?.warn(
      { runId, from, to: toStatus, violation: transition.violation?.message },
      "[safeTransitionRun] 状态转换被状态机拒绝，跳过更新",
    );
    return false;
  }
  const setFinished = opts?.finishedAt ? ", finished_at = COALESCE(finished_at, now())" : "";
  if (opts?.tenantId) {
    await pool.query(
      `UPDATE runs SET status = $2, updated_at = now()${setFinished} WHERE tenant_id = $3 AND run_id = $1`,
      [runId, toStatus, opts.tenantId],
    );
  } else {
    await pool.query(
      `UPDATE runs SET status = $2, updated_at = now()${setFinished} WHERE run_id = $1`,
      [runId, toStatus],
    );
  }
  // Event Sourcing: 尽力记录状态转换事件（best-effort，不阻塞主流程）
  if (opts?.tenantId) {
    try {
      await pool.query(
        `INSERT INTO state_events (event_id, run_id, tenant_id, from_status, to_status, triggered_by, metadata, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now())`,
        [runId, opts.tenantId, from, toStatus, opts?.triggeredBy ?? "system", JSON.stringify(opts?.eventMetadata ?? {})],
      );
    } catch (err) {
      opts?.log?.warn?.("state_events insert failed (non-blocking)", err);
    }
  }

  return true;
}

/**
 * 清理过期的状态转换事件记录
 * 保留最近 retentionDays 天的数据，删除更旧的记录
 * 建议由定时任务（如 Worker cron）定期调用
 */
export async function purgeStaleStateEvents(
  pool: PoolLike,
  retentionDays: number = 30,
): Promise<number> {
  const result = await pool.query(
    `DELETE FROM state_events WHERE created_at < now() - make_interval(days => $1)`,
    [retentionDays],
  );
  return result.rowCount ?? 0;
}
