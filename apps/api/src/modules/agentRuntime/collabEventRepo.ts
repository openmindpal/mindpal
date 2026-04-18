import type { Pool } from "pg";

export type CollabRunEventRow = {
  eventId: string;
  tenantId: string;
  spaceId: string | null;
  collabRunId: string;
  taskId: string;
  type: string;
  actorRole: string | null;
  runId: string | null;
  stepId: string | null;
  payloadDigest: any | null;
  policySnapshotRef: string | null;
  correlationId: string | null;
  /** P2-5.1: 责任链追溯 - 提议者 */
  proposedBy: string | null;
  /** P2-5.1: 责任链追溯 - 执行者 */
  executedBy: string | null;
  /** P2-5.1: 责任链追溯 - 审核者 */
  reviewedBy: string | null;
  /** P2-5.1: 责任链追溯 - 批准者 */
  approvedBy: string | null;
  createdAt: string;
};

function toEvent(r: any): CollabRunEventRow {
  return {
    eventId: String(r.event_id),
    tenantId: String(r.tenant_id),
    spaceId: r.space_id ? String(r.space_id) : null,
    collabRunId: String(r.collab_run_id),
    taskId: String(r.task_id),
    type: String(r.type),
    actorRole: r.actor_role ? String(r.actor_role) : null,
    runId: r.run_id ? String(r.run_id) : null,
    stepId: r.step_id ? String(r.step_id) : null,
    payloadDigest: r.payload_digest ?? null,
    policySnapshotRef: r.policy_snapshot_ref ? String(r.policy_snapshot_ref) : null,
    correlationId: r.correlation_id ? String(r.correlation_id) : null,
    proposedBy: r.proposed_by ? String(r.proposed_by) : null,
    executedBy: r.executed_by ? String(r.executed_by) : null,
    reviewedBy: r.reviewed_by ? String(r.reviewed_by) : null,
    approvedBy: r.approved_by ? String(r.approved_by) : null,
    createdAt: String(r.created_at),
  };
}

export async function appendCollabRunEvent(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  collabRunId: string;
  taskId: string;
  type: string;
  actorRole?: string | null;
  runId?: string | null;
  stepId?: string | null;
  payloadDigest?: any | null;
  policySnapshotRef?: string | null;
  correlationId?: string | null;
  /** P2-5.1: 提议者 */
  proposedBy?: string | null;
  /** P2-5.1: 执行者 */
  executedBy?: string | null;
  /** P2-5.1: 审核者 */
  reviewedBy?: string | null;
  /** P2-5.1: 批准者 */
  approvedBy?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO collab_run_events (
        tenant_id, space_id, collab_run_id, task_id,
        type, actor_role, run_id, step_id,
        payload_digest, policy_snapshot_ref, correlation_id,
        proposed_by, executed_by, reviewed_by, approved_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId,
      params.collabRunId,
      params.taskId,
      params.type,
      params.actorRole ?? null,
      params.runId ?? null,
      params.stepId ?? null,
      params.payloadDigest ?? null,
      params.policySnapshotRef ?? null,
      params.correlationId ?? null,
      params.proposedBy ?? null,
      params.executedBy ?? null,
      params.reviewedBy ?? null,
      params.approvedBy ?? null,
    ],
  );
  return toEvent(res.rows[0]);
}

export async function listCollabRunEvents(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  limit: number;
  before?: string | null;
  type?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}) {
  const limit = Math.max(1, Math.min(200, params.limit));
  const where: string[] = ["tenant_id = $1", "collab_run_id = $2"];
  const args: any[] = [params.tenantId, params.collabRunId];
  let idx = 3;
  if (params.before) {
    where.push(`created_at < $${idx++}`);
    args.push(params.before);
  }
  if (params.type) {
    where.push(`type = $${idx++}`);
    args.push(params.type);
  }
  if (params.actorRole) {
    where.push(`actor_role = $${idx++}`);
    args.push(params.actorRole);
  }
  if (params.correlationId) {
    where.push(`correlation_id = $${idx++}`);
    args.push(params.correlationId);
  }
  args.push(limit);
  const res = await params.pool.query(
    `
      SELECT *
      FROM collab_run_events
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++}
    `,
    args,
  );
  return res.rows.map(toEvent);
}
