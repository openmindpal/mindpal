/**
 * ChangeSet — Shared types, row mappers, and internal helpers.
 *
 * This module is NOT meant to be imported directly by external consumers.
 * External code should import from `./changeSetRepo` (barrel).
 */
import type { Pool, PoolClient } from "pg";
import { resolveSupplyChainPolicy, supplyChainGate as runSupplyChainGate } from "@mindpal/shared";

// ---- Exported Types ----

export type ChangeSetStatus = "draft" | "submitted" | "approved" | "released" | "rolled_back";

export type ChangeSetRow = {
  id: string;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  title: string;
  status: ChangeSetStatus;
  riskLevel: "low" | "medium" | "high";
  requiredApprovals: number;
  canaryTargets: string[] | null;
  canaryReleasedAt: string | null;
  promotedAt: string | null;
  createdBy: string;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  rollbackOf: string | null;
  rollbackData: any;
  createdAt: string;
  updatedAt: string;
};

export type ChangeSetItemRow = {
  id: string;
  changesetId: string;
  kind:
    | "tool.enable"
    | "tool.disable"
    | "tool.set_active"
    | "ui.page.publish"
    | "ui.page.rollback"
    | "policy.cache.invalidate"
    | "policy.version.release"
    | "policy.publish"
    | "policy.set_active"
    | "policy.rollback"
    | "policy.set_override"
    | "workbench.plugin.publish"
    | "workbench.plugin.rollback"
    | "workbench.plugin.canary"
    | "schema.publish"
    | "schema.set_active"
    | "schema.rollback"
    | "model_routing.upsert"
    | "model_routing.disable"
    | "artifact_policy.upsert";
  payload: any;
  createdAt: string;
};

// ---- Row Mappers ----

export function toCs(r: any): ChangeSetRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    title: r.title,
    status: r.status,
    riskLevel: r.risk_level,
    requiredApprovals: r.required_approvals,
    canaryTargets: Array.isArray(r.canary_targets) ? r.canary_targets : null,
    canaryReleasedAt: r.canary_released_at,
    promotedAt: r.promoted_at,
    createdBy: r.created_by,
    submittedAt: r.submitted_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    releasedBy: r.released_by,
    releasedAt: r.released_at,
    rollbackOf: r.rollback_of,
    rollbackData: r.rollback_data,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toItem(r: any): ChangeSetItemRow {
  return {
    id: r.id,
    changesetId: r.changeset_id,
    kind: r.kind,
    payload: r.payload,
    createdAt: r.created_at,
  };
}

// ---- Internal Helpers ----

/** Unify Pool / PoolClient for queries. */
export function client(pool: Pool | PoolClient) {
  return pool as any;
}

/** Count approvals for a changeset. */
export async function countApprovals(params: { pool: Pool | PoolClient; tenantId: string; changesetId: string }) {
  const res = await client(params.pool).query(
    `SELECT COUNT(*)::int AS c FROM governance_changeset_approvals WHERE tenant_id = $1 AND changeset_id = $2`,
    [params.tenantId, params.changesetId],
  );
  return res.rows[0].c as number;
}

/** Shared helper: run supplyChainGate with resolved policy. */
export function validateToolSupplyChain(
  trustSummary: any, scanSummary: any, sbomSummary: any, sbomDigest: any,
) {
  const policy = resolveSupplyChainPolicy();
  return runSupplyChainGate({ policy, trustSummary, scanSummary, sbomSummary, sbomDigest, requestedIsolation: "auto" });
}
