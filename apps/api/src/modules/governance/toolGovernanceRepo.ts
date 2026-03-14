import type { Pool } from "pg";

export type ToolRolloutRow = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
  enabled: boolean;
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
}) {
  const res = await params.pool.query(
    `
      INSERT INTO tool_rollouts (tenant_id, scope_type, scope_id, tool_ref, enabled)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (tenant_id, scope_type, scope_id, tool_ref)
      DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.toolRef, params.enabled],
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

export async function isToolEnabled(params: { pool: Pool; tenantId: string; spaceId: string; toolRef: string }) {
  const space = await params.pool.query(
    `
      SELECT enabled
      FROM tool_rollouts
      WHERE tenant_id = $1 AND scope_type = 'space' AND scope_id = $2 AND tool_ref = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.toolRef],
  );
  if (space.rowCount) return Boolean(space.rows[0].enabled);

  const tenant = await params.pool.query(
    `
      SELECT enabled
      FROM tool_rollouts
      WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_id = $1 AND tool_ref = $2
      LIMIT 1
    `,
    [params.tenantId, params.toolRef],
  );
  if (tenant.rowCount) return Boolean(tenant.rows[0].enabled);

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
