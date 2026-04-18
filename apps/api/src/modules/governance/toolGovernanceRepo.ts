import type { Pool } from "pg";
import { getToolVersionByRef } from "../tools/toolRepo";
import { resolveSupplyChainPolicy, checkTrust, checkDependencyScan } from "@openslin/shared";
import { insertAuditEvent } from "../audit/auditRepo";
import { Errors } from "../../lib/errors";

export type ToolRolloutRow = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
  enabled: boolean;
  disableMode: "immediate" | "graceful";
  graceDeadline: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ToolActiveRow = {
  tenantId: string;
  name: string;
  activeToolRef: string;
  createdAt: string;
  updatedAt: string;
};

export type ToolActiveOverrideRow = {
  tenantId: string;
  spaceId: string;
  name: string;
  activeToolRef: string;
  createdAt: string;
  updatedAt: string;
};

function toRollout(r: any): ToolRolloutRow {
  return {
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    toolRef: r.tool_ref,
    enabled: r.enabled,
    disableMode: r.disable_mode ?? "immediate",
    graceDeadline: r.grace_deadline ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toActive(r: any): ToolActiveRow {
  return {
    tenantId: r.tenant_id,
    name: r.name,
    activeToolRef: r.active_tool_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toActiveOverride(r: any): ToolActiveOverrideRow {
  return {
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    name: r.name,
    activeToolRef: r.active_tool_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function setToolRollout(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
  enabled: boolean;
  disableMode?: "immediate" | "graceful";
  graceDeadline?: Date | null;
}) {
  const mode = params.disableMode ?? "immediate";
  const deadline = params.graceDeadline ?? null;
  const res = await params.pool.query(
    `
      INSERT INTO tool_rollouts (tenant_id, scope_type, scope_id, tool_ref, enabled, disable_mode, grace_deadline)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (tenant_id, scope_type, scope_id, tool_ref)
      DO UPDATE SET enabled = EXCLUDED.enabled, disable_mode = EXCLUDED.disable_mode, grace_deadline = EXCLUDED.grace_deadline, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.toolRef, params.enabled, mode, deadline],
  );
  return toRollout(res.rows[0]);
}

export async function deleteToolRollout(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
}) {
  const res = await params.pool.query(
    `
      DELETE FROM tool_rollouts
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND tool_ref = $4
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.toolRef],
  );
  return res.rowCount ?? 0;
}

/**
 * Check if a tool is enabled for a given tenant+space.
 *
 * Graceful-disable support:
 *   When `runCreatedAt` is provided and the rollout is in graceful-disable mode
 *   with a grace_deadline still in the future AND the run was created before
 *   the graceful disable was initiated, the tool is considered "still enabled"
 *   for that existing run.
 */
export async function isToolEnabled(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  toolRef: string;
  /** Optional: creation time of the current run, used for graceful-disable grace period. */
  runCreatedAt?: Date;
}) {
  // Helper: evaluate a single rollout row
  function evaluateRow(row: any): boolean {
    if (Boolean(row.enabled)) return true;
    // Tool is disabled — check for graceful grace period
    if (
      row.disable_mode === "graceful" &&
      row.grace_deadline &&
      params.runCreatedAt
    ) {
      const deadline = new Date(row.grace_deadline);
      if (deadline > new Date() && params.runCreatedAt < deadline) {
        return true; // grace period still active for this run
      }
    }
    return false;
  }

  const space = await params.pool.query(
    `
      SELECT enabled, disable_mode, grace_deadline
      FROM tool_rollouts
      WHERE tenant_id = $1 AND scope_type = 'space' AND scope_id = $2 AND tool_ref = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.toolRef],
  );
  if (space.rowCount) return evaluateRow(space.rows[0]);

  const tenant = await params.pool.query(
    `
      SELECT enabled, disable_mode, grace_deadline
      FROM tool_rollouts
      WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_id = $1 AND tool_ref = $2
      LIMIT 1
    `,
    [params.tenantId, params.toolRef],
  );
  if (tenant.rowCount) return evaluateRow(tenant.rows[0]);

  return false;
}

export async function getToolRolloutEnabled(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
}) {
  const res = await params.pool.query(
    `
      SELECT enabled
      FROM tool_rollouts
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND tool_ref = $4
      LIMIT 1
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.toolRef],
  );
  if (!res.rowCount) return null;
  return Boolean(res.rows[0].enabled);
}

export async function setActiveToolRef(params: { pool: Pool; tenantId: string; name: string; toolRef: string }) {
  const res = await params.pool.query(
    `
      INSERT INTO tool_active_versions (tenant_id, name, active_tool_ref)
      VALUES ($1,$2,$3)
      ON CONFLICT (tenant_id, name)
      DO UPDATE SET active_tool_ref = EXCLUDED.active_tool_ref, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.name, params.toolRef],
  );
  return toActive(res.rows[0]);
}

export async function clearActiveToolRef(params: { pool: Pool; tenantId: string; name: string }) {
  const res = await params.pool.query(
    `
      DELETE FROM tool_active_versions
      WHERE tenant_id = $1 AND name = $2
    `,
    [params.tenantId, params.name],
  );
  return res.rowCount ?? 0;
}

export async function setActiveToolOverride(params: { pool: Pool; tenantId: string; spaceId: string; name: string; toolRef: string }) {
  const res = await params.pool.query(
    `
      INSERT INTO tool_active_overrides (tenant_id, space_id, name, active_tool_ref)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id, space_id, name)
      DO UPDATE SET active_tool_ref = EXCLUDED.active_tool_ref, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.name, params.toolRef],
  );
  return toActiveOverride(res.rows[0]);
}

export async function clearActiveToolOverride(params: { pool: Pool; tenantId: string; spaceId: string; name: string }) {
  const res = await params.pool.query(
    `
      DELETE FROM tool_active_overrides
      WHERE tenant_id = $1 AND space_id = $2 AND name = $3
    `,
    [params.tenantId, params.spaceId, params.name],
  );
  return res.rowCount ?? 0;
}

export async function getActiveToolOverride(params: { pool: Pool; tenantId: string; spaceId: string; name: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM tool_active_overrides
      WHERE tenant_id = $1 AND space_id = $2 AND name = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.name],
  );
  if (!res.rowCount) return null;
  return toActiveOverride(res.rows[0]);
}

export async function listActiveToolOverrides(params: { pool: Pool; tenantId: string; spaceId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM tool_active_overrides
      WHERE tenant_id = $1 AND space_id = $2
      ORDER BY name ASC
    `,
    [params.tenantId, params.spaceId],
  );
  return res.rows.map(toActiveOverride);
}

export async function getActiveToolRef(params: { pool: Pool; tenantId: string; name: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM tool_active_versions
      WHERE tenant_id = $1 AND name = $2
      LIMIT 1
    `,
    [params.tenantId, params.name],
  );
  if (!res.rowCount) return null;
  return toActive(res.rows[0]);
}

export async function listActiveToolRefs(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM tool_active_versions
      WHERE tenant_id = $1
      ORDER BY name ASC
    `,
    [params.tenantId],
  );
  return res.rows.map(toActive);
}

export async function listToolRollouts(params: { pool: Pool; tenantId: string; scopeType?: "tenant" | "space"; scopeId?: string }) {
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
      FROM tool_rollouts
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT 500
    `,
    args,
  );
  return res.rows.map(toRollout);
}

/* ================================================================== */
/*  High-level: enable / disable tool for a scope                      */
/* ================================================================== */

export interface EnableToolParams {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
  /** Subject performing the action (for audit). */
  subjectId?: string;
  /** Trace ID for audit correlation. */
  traceId?: string;
  /** Policy decision from requirePermission (for audit). */
  policyDecision?: any;
}

export interface EnableToolResult {
  rollout: ToolRolloutRow;
  previousEnabled: boolean | null;
}

/**
 * Enable a tool for a given scope (tenant or space).
 *
 * Validates:
 *  1. Tool version exists and is released
 *  2. Supply chain gate: trust + scan (for artifact-based tools)
 *
 * Then writes the rollout and an audit event.
 */
export async function enableToolForScope(params: EnableToolParams): Promise<EnableToolResult> {
  const { pool, tenantId, scopeType, scopeId, toolRef } = params;

  // Validate version exists and is released
  const ver = await getToolVersionByRef(pool, tenantId, toolRef);
  if (!ver) {
    throw Errors.badRequest(`工具「${toolRef}」不存在，请检查工具名称和版本号是否正确 (Tool "${toolRef}" not found)`);
  }
  if (ver.status !== "released") {
    throw Errors.badRequest(`工具「${toolRef}」尚未发布（当前状态: ${ver.status}），无法启用 (Tool not released, current: ${ver.status})`);
  }

  // Supply chain gate for artifact-based tools
  if (ver.artifactRef) {
    const policy = resolveSupplyChainPolicy();
    const t = checkTrust(policy, ver.trustSummary);
    const s = checkDependencyScan(policy, ver.scanSummary);
    if (!t.ok) throw Errors.trustNotVerified();
    if (!s.ok) throw Errors.scanNotPassed();
  }

  // Check previous state
  const previousEnabled = await getToolRolloutEnabled({ pool, tenantId, scopeType, scopeId, toolRef });

  // Write rollout
  const rollout = await setToolRollout({ pool, tenantId, scopeType, scopeId, toolRef, enabled: true });

  // Write audit event if state changed
  if (previousEnabled !== true) {
    await insertAuditEvent(pool, {
      subjectId: params.subjectId,
      tenantId,
      spaceId: scopeType === "space" ? scopeId : undefined,
      resourceType: "governance",
      action: "tool.enable",
      policyDecision: params.policyDecision,
      inputDigest: { scopeType, scopeId, toolRef },
      outputDigest: { enabled: true, previousEnabled },
      result: "success",
      traceId: params.traceId ?? "",
    });
  }

  return { rollout, previousEnabled };
}

/**
 * Disable a tool for a given scope (tenant or space).
 *
 * Writes the rollout and an audit event.
 */
export interface DisableToolParams extends EnableToolParams {
  /** Disable mode: 'immediate' (default) or 'graceful' (allows existing runs to finish). */
  disableMode?: "immediate" | "graceful";
  /** Grace period in minutes for graceful mode (default: 5). */
  graceMinutes?: number;
}

export async function disableToolForScope(params: DisableToolParams): Promise<EnableToolResult> {
  const { pool, tenantId, scopeType, scopeId, toolRef } = params;
  const disableMode = params.disableMode ?? "immediate";
  const graceMinutes = params.graceMinutes ?? 5;

  // Check previous state
  const previousEnabled = await getToolRolloutEnabled({ pool, tenantId, scopeType, scopeId, toolRef });

  // Compute grace deadline for graceful mode
  let graceDeadline: Date | null = null;
  if (disableMode === "graceful") {
    graceDeadline = new Date(Date.now() + graceMinutes * 60_000);
  }

  // Write rollout
  const rollout = await setToolRollout({ pool, tenantId, scopeType, scopeId, toolRef, enabled: false, disableMode, graceDeadline });

  // Write audit event if state changed
  if (previousEnabled !== false) {
    await insertAuditEvent(pool, {
      subjectId: params.subjectId,
      tenantId,
      spaceId: scopeType === "space" ? scopeId : undefined,
      resourceType: "governance",
      action: "tool.disable",
      policyDecision: params.policyDecision,
      inputDigest: { scopeType, scopeId, toolRef, disableMode, graceMinutes: disableMode === "graceful" ? graceMinutes : undefined },
      outputDigest: { enabled: false, previousEnabled, disableMode, graceDeadline: graceDeadline?.toISOString() ?? null },
      result: "success",
      traceId: params.traceId ?? "",
    });
  }

  if (disableMode === "graceful") {
    console.info(
      `[governance] disableToolForScope: graceful disable for tool=${toolRef} tenant=${tenantId} scope=${scopeType}:${scopeId} graceDeadline=${graceDeadline?.toISOString()}`
    );
  }

  return { rollout, previousEnabled };
}
