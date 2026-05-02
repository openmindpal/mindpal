/**
 * Worker-side: 审批过期定时处理（元数据驱动）
 * 
 * 分级处理流程：
 * 1. 升级检测：根据各行 escalation_minutes 字段判断是否需要升级，通知 escalation_target
 * 2. 过期自动拒绝：根据各行 auto_reject_on_expiry + expires_at 判断是否自动拒绝
 *
 * 所有策略从 approvals 行自身字段读取，不依赖外部 policy 参数。
 */
import type { Pool } from "pg";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:approvalExpiry" });

export async function tickApprovalExpiry(params: { pool: Pool }): Promise<void> {
  const { pool } = params;
  let escalatedCount = 0;
  let expiredCount = 0;

  // ── Step 1: 升级检测（元数据驱动） ─────────────────────────
  // 查询单行 escalation_minutes 已过、尚未升级的审批
  try {
    const toEscalate = await pool.query<{
      approval_id: string;
      tenant_id: string;
      run_id: string;
      step_id: string | null;
      space_id: string | null;
      tool_ref: string | null;
      escalation_target: string | null;
    }>(
      `SELECT approval_id, tenant_id, run_id, step_id, space_id, tool_ref, escalation_target
       FROM approvals
       WHERE status = 'pending'
         AND escalation_minutes IS NOT NULL
         AND escalated_at IS NULL
         AND created_at + interval '1 minute' * escalation_minutes < now()
       ORDER BY created_at ASC
       LIMIT 200`,
    );

    for (const row of toEscalate.rows) {
      try {
        await pool.query(
          "UPDATE approvals SET escalated_at = now(), updated_at = now() WHERE approval_id = $1",
          [row.approval_id],
        );
        // 如果配置了升级目标，插入通知
        if (row.escalation_target) {
          await pool.query(
            `INSERT INTO notification_queue (tenant_id, event, payload)
             VALUES ($1, 'approval.escalated', $2::jsonb)
             ON CONFLICT DO NOTHING`,
            [
              row.tenant_id,
              JSON.stringify({
                approvalId: row.approval_id,
                runId: row.run_id,
                stepId: row.step_id,
                spaceId: row.space_id,
                toolRef: row.tool_ref,
                escalationTarget: row.escalation_target,
              }),
            ],
          );
        }
        escalatedCount++;
      } catch (rowErr: any) {
        _logger.warn("escalation row failed", { approvalId: row.approval_id, error: String(rowErr?.message ?? rowErr) });
      }
    }

    if (escalatedCount > 0) {
      _logger.info("escalated approvals", { count: escalatedCount });
    }
  } catch (e: any) {
    _logger.warn("escalation query failed", { error: String(e?.message ?? e) });
  }

  // ── Step 2: 过期自动拒绝（元数据驱动） ───────────────────
  // 查询单行 auto_reject_on_expiry = true 且 expires_at 已过的审批
  try {
    const toExpire = await pool.query<{ approval_id: string; run_id: string; step_id: string | null }>(
      `SELECT approval_id, run_id, step_id
       FROM approvals
       WHERE status = 'pending'
         AND auto_reject_on_expiry = true
         AND expires_at IS NOT NULL
         AND expires_at < now()
       ORDER BY created_at ASC
       LIMIT 200`,
    );

    for (const row of toExpire.rows) {
      try {
        await pool.query(
          `UPDATE approvals
           SET status = 'rejected', reason = 'auto_expired', decided_at = now(), updated_at = now()
           WHERE approval_id = $1 AND status = 'pending'`,
          [row.approval_id],
        );
        await pool.query(
          "UPDATE runs SET status = 'canceled', finished_at = COALESCE(finished_at, now()), updated_at = now() WHERE run_id = $1 AND status = 'needs_approval'",
          [row.run_id],
        );
        await pool.query(
          "UPDATE jobs SET status = 'canceled', updated_at = now() WHERE run_id = $1 AND status IN ('needs_approval', 'queued', 'pending', 'running')",
          [row.run_id],
        );
        if (row.step_id) {
          await pool.query(
            "UPDATE steps SET status = 'canceled', finished_at = COALESCE(finished_at, now()), updated_at = now() WHERE step_id = $1 AND status IN ('needs_approval', 'pending', 'running')",
            [row.step_id],
          );
        }
        expiredCount++;
      } catch (rowErr: any) {
        _logger.warn("expiry row failed", { approvalId: row.approval_id, error: String(rowErr?.message ?? rowErr) });
      }
    }

    if (expiredCount > 0) {
      _logger.info("expired approvals", { count: expiredCount });
    }
  } catch (e: any) {
    _logger.warn("expiry query failed", { error: String(e?.message ?? e) });
  }
}
