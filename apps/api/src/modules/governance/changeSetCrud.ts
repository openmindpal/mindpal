/**
 * ChangeSet — CRUD operations + lifecycle (submit / approve) + approval gate.
 */
import type { Pool } from "pg";
import { toCs, toItem, client, countApprovals, type ChangeSetRow, type ChangeSetItemRow } from "./changeSetShared";
import { getToolDefinition } from "../tools/toolRepo";
import { assessChangesetGate, checkEvalAdmission } from "../../kernel/approvalRuleEngine";

// ---- CRUD ----

export async function createChangeSet(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  title: string;
  createdBy: string;
  canaryTargets?: string[] | null;
}) {
  const canaryTargets = params.canaryTargets ? JSON.stringify(params.canaryTargets) : null;
  const res = await params.pool.query(
    `
      INSERT INTO governance_changesets (tenant_id, scope_type, scope_id, title, status, created_by, canary_targets)
      VALUES ($1,$2,$3,$4,'draft',$5,$6)
      RETURNING *
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.title, params.createdBy, canaryTargets],
  );
  return toCs(res.rows[0]);
}

export async function getChangeSet(params: { pool: Pool; tenantId: string; id: string }) {
  const res = await params.pool.query(
    `SELECT * FROM governance_changesets WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [params.tenantId, params.id],
  );
  if (!res.rowCount) return null;
  return toCs(res.rows[0]);
}

export async function listChangeSets(params: { pool: Pool; tenantId: string; scopeType?: "tenant" | "space"; scopeId?: string; limit: number }) {
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [params.tenantId];
  let idx = 2;
  if (params.scopeType) {
    where.push(`scope_type = $${idx++}`);
    args.push(params.scopeType);
  }
  if (params.scopeId) {
    where.push(`scope_id = $${idx++}`);
    args.push(params.scopeId);
  }
  const res = await params.pool.query(
    `
      SELECT *
      FROM governance_changesets
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `,
    [...args, params.limit],
  );
  return res.rows.map(toCs);
}

export async function listChangeSetItems(params: { pool: Pool; tenantId: string; changesetId: string }) {
  const res = await params.pool.query(
    `
      SELECT i.*
      FROM governance_changeset_items i
      JOIN governance_changesets c ON c.id = i.changeset_id
      WHERE c.tenant_id = $1 AND c.id = $2
      ORDER BY i.created_at ASC
    `,
    [params.tenantId, params.changesetId],
  );
  return res.rows.map(toItem);
}

export async function addChangeSetItem(params: {
  pool: Pool;
  tenantId: string;
  changesetId: string;
  kind: ChangeSetItemRow["kind"];
  payload: any;
}) {
  const cs = await getChangeSet({ pool: params.pool, tenantId: params.tenantId, id: params.changesetId });
  if (!cs) throw new Error("changeset_not_found");
  if (cs.status !== "draft") throw new Error("changeset_not_draft");

  const res = await params.pool.query(
    `
      INSERT INTO governance_changeset_items (changeset_id, kind, payload)
      VALUES ($1,$2,$3)
      RETURNING *
    `,
    [params.changesetId, params.kind, params.payload],
  );
  return toItem(res.rows[0]);
}

// ---- Lifecycle ----

export async function submitChangeSet(params: { pool: Pool; tenantId: string; id: string }) {
  const items = await listChangeSetItems({ pool: params.pool, tenantId: params.tenantId, changesetId: params.id });
  const gate = await computeApprovalGate({ pool: params.pool, tenantId: params.tenantId, items });
  const res = await params.pool.query(
    `
      UPDATE governance_changesets
      SET status = 'submitted',
          submitted_at = now(),
          required_approvals = $3,
          risk_level = $4,
          updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
      RETURNING *
    `,
    [params.tenantId, params.id, gate.requiredApprovals, gate.riskLevel],
  );
  if (!res.rowCount) throw new Error("changeset_submit_failed");
  return toCs(res.rows[0]);
}

export async function approveChangeSet(params: { pool: Pool; tenantId: string; id: string; approvedBy: string }) {
  const tx = await params.pool.connect();
  try {
    await tx.query("BEGIN");
    const locked = await tx.query(
      `SELECT * FROM governance_changesets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [params.tenantId, params.id],
    );
    if (!locked.rowCount) throw new Error("changeset_not_found");
    const cs = toCs(locked.rows[0]);
    if (cs.status !== "submitted") throw new Error("changeset_not_submitted");

    await tx.query(
      `
        INSERT INTO governance_changeset_approvals (tenant_id, changeset_id, approved_by)
        VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id, changeset_id, approved_by) DO NOTHING
      `,
      [params.tenantId, params.id, params.approvedBy],
    );

    const cntRes = await tx.query(
      `SELECT COUNT(*)::int AS c FROM governance_changeset_approvals WHERE tenant_id = $1 AND changeset_id = $2`,
      [params.tenantId, params.id],
    );
    const approvals = cntRes.rows[0].c as number;

    let out = cs;
    if (approvals >= cs.requiredApprovals) {
      const upd = await tx.query(
        `
          UPDATE governance_changesets
          SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND id = $2
          RETURNING *
        `,
        [params.tenantId, params.id, params.approvedBy],
      );
      out = toCs(upd.rows[0]);
    }

    await tx.query("COMMIT");
    return { changeset: out, approvals };
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}

// ---- Approval Gate ----

/**
 * 检查单个 item kind 是否触发 eval 准入（纯数据驱动）。
 */
export async function itemMatchesEvalKinds(kind: string, pool: Pool, tenantId: string): Promise<boolean> {
  const result = await checkEvalAdmission({ pool, tenantId, kind });
  return result.required;
}

/**
 * 计算变更集的审批门禁（纯数据驱动）。
 *
 * 从 approval_rules 表动态加载 changeset_gate 和 eval_admission 规则。
 * 返回值中 matchedRules 和 humanSummary 用于审批自描述。
 */
export async function computeApprovalGate(params: { pool: Pool; tenantId: string; items: ChangeSetItemRow[] }) {
  const itemKinds = params.items.map((i) => i.kind);

  const assessment = await assessChangesetGate({
    pool: params.pool,
    tenantId: params.tenantId,
    itemKinds,
  });

  let { riskLevel: risk, requiredApprovals, evalAdmissionRequired } = assessment;

  // 补充：对 tool.* 类 item，额外查询工具定义的风险声明
  for (const item of params.items) {
    if (!item.kind.startsWith("tool.")) continue;
    const toolRef = String(item.payload?.toolRef ?? "");
    const name = item.kind === "tool.set_active"
      ? String(item.payload?.name ?? "")
      : toolRef.slice(0, Math.max(0, toolRef.lastIndexOf("@")));
    if (!name) continue;
    const def = await getToolDefinition(params.pool, params.tenantId, name);
    if (!def) continue;
    if (def.riskLevel === "high" && risk !== "high") risk = "high";
    else if (def.riskLevel === "medium" && risk === "low") risk = "medium" as typeof risk;
    if (def.approvalRequired && requiredApprovals < 2) requiredApprovals = 2;
  }

  return {
    riskLevel: risk,
    requiredApprovals,
    evalAdmissionRequired,
    matchedRules: assessment.matchedRules,
    humanSummary: assessment.humanSummary,
  };
}
