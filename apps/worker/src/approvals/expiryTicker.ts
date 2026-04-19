/**
 * Worker-side: 审批过期定时处理
 * 
 * 定期扫描 pending 状态的审批请求，对过期的自动拒绝并取消对应运行，
 * 对超过升级阈值的标记为 escalated。
 */
import type { Pool } from "pg";
import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "worker:approvalExpiry" });

const DEFAULT_EXPIRATION_MINUTES = 1440; // 24h
const DEFAULT_ESCALATION_MINUTES = 240;  // 4h

export async function tickApprovalExpiry(params: { pool: Pool }): Promise<void> {
  const { pool } = params;
  const expirationMinutes = Math.max(1, Number(process.env.APPROVAL_EXPIRATION_MINUTES) || DEFAULT_EXPIRATION_MINUTES);
  const escalationMinutes = Math.max(1, Number(process.env.APPROVAL_ESCALATION_MINUTES) || DEFAULT_ESCALATION_MINUTES);
  const autoRejectOnExpiry = process.env.APPROVAL_AUTO_REJECT !== "0";

  const now = new Date();
  let processed = 0;

  // 1. 升级处理
  if (escalationMinutes > 0) {
    const escalationThreshold = new Date(now.getTime() - escalationMinutes * 60 * 1000);
    try {
      const res = await pool.query(
        `UPDATE approvals
         SET escalated_at = now(), updated_at = now()
         WHERE status = 'pending'
           AND escalated_at IS NULL
           AND created_at < $1
         RETURNING approval_id`,
        [escalationThreshold.toISOString()],
      );
      const cnt = res.rowCount ?? 0;
      if (cnt > 0) {
        _logger.info("escalated approvals", { count: cnt });
        processed += cnt;
      }
    } catch (e: any) {
      _logger.warn("escalation failed", { error: String(e?.message ?? e) });
    }
  }

  // 2. 过期自动拒绝
  if (expirationMinutes > 0 && autoRejectOnExpiry) {
    const expirationThreshold = new Date(now.getTime() - expirationMinutes * 60 * 1000);
    try {
      const toExpire = await pool.query<{ approval_id: string; run_id: string }>(
        `SELECT approval_id, run_id FROM approvals
         WHERE status = 'pending'
           AND created_at < $1
         ORDER BY created_at ASC
         LIMIT 200`,
        [expirationThreshold.toISOString()],
      );

      for (const row of toExpire.rows) {
        await pool.query(
          `UPDATE approvals
           SET status = 'expired', decision = 'reject', reason = 'auto_expired', decided_at = now(), updated_at = now()
           WHERE approval_id = $1 AND status = 'pending'`,
          [row.approval_id],
        );
        await pool.query(
          "UPDATE runs SET status = 'canceled', finished_at = COALESCE(finished_at, now()), updated_at = now() WHERE run_id = $1 AND status = 'needs_approval'",
          [row.run_id],
        );
        processed++;
      }

      if (toExpire.rowCount && toExpire.rowCount > 0) {
        _logger.info("expired approvals", { count: toExpire.rowCount });
      }
    } catch (e: any) {
      _logger.warn("expiry processing failed", { error: String(e?.message ?? e) });
    }
  }
}
