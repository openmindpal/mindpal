/**
 * SCIM 2.0 Provisioning Runtime — architecture-05 section 15.15
 * Handles: Users/Groups CRUD, synchronization status tracking, IdP provisioning integration.
 *
 * 功能目标：实现企业级SCIM 2.0用户/组自动供给，支持Azure AD、Okta等主流IdP。
 */
import crypto from "node:crypto";
import type { Pool } from "pg";
import { ensureSubject } from "./subjectRepo";
import { insertAuditEvent } from "../audit/auditRepo";

/* ─── SCIM Types (RFC 7643/7644) ─── */

export interface ScimUser {
  schemas: string[];
  id?: string;
  externalId?: string;
  userName: string;
  name?: {
    formatted?: string;
    familyName?: string;
    givenName?: string;
  };
  displayName?: string;
  emails?: Array<{ value: string; primary?: boolean; type?: string }>;
  active?: boolean;
  groups?: Array<{ value: string; display?: string }>;
  meta?: {
    resourceType: string;
    created?: string;
    lastModified?: string;
    location?: string;
  };
}

export interface ScimGroup {
  schemas: string[];
  id?: string;
  externalId?: string;
  displayName: string;
  members?: Array<{ value: string; display?: string; type?: string }>;
  meta?: {
    resourceType: string;
    created?: string;
    lastModified?: string;
    location?: string;
  };
}

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export interface ScimError {
  schemas: string[];
  status: string;
  scimType?: string;
  detail?: string;
}

/* ─── SCIM Config Repository ─── */

export interface ScimConfigRow {
  scimConfigId: string;
  tenantId: string;
  bearerTokenHash: string;
  allowedOperations: string[];
  autoProvision: boolean;
  defaultRoleId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function toScimConfig(r: any): ScimConfigRow {
  return {
    scimConfigId: String(r.scim_config_id),
    tenantId: String(r.tenant_id),
    bearerTokenHash: String(r.bearer_token_hash),
    allowedOperations: Array.isArray(r.allowed_operations) ? r.allowed_operations : JSON.parse(r.allowed_operations || "[]"),
    autoProvision: Boolean(r.auto_provision),
    defaultRoleId: r.default_role_id ? String(r.default_role_id) : null,
    status: String(r.status ?? "active"),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function getScimConfig(params: { pool: Pool; tenantId: string }): Promise<ScimConfigRow | null> {
  const res = await params.pool.query(
    "SELECT * FROM scim_configs WHERE tenant_id = $1 AND status = 'active' LIMIT 1",
    [params.tenantId],
  );
  if (!res.rowCount) return null;
  return toScimConfig(res.rows[0]);
}

export async function createScimConfig(params: {
  pool: Pool;
  tenantId: string;
  bearerToken: string;
  allowedOperations?: string[];
  autoProvision?: boolean;
  defaultRoleId?: string | null;
}): Promise<ScimConfigRow> {
  const bearerTokenHash = crypto.createHash("sha256").update(params.bearerToken).digest("hex");
  const res = await params.pool.query(
    `INSERT INTO scim_configs (tenant_id, bearer_token_hash, allowed_operations, auto_provision, default_role_id)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     RETURNING *`,
    [
      params.tenantId,
      bearerTokenHash,
      JSON.stringify(params.allowedOperations ?? ["Users.list", "Users.get", "Users.create", "Users.update", "Users.delete", "Groups.list", "Groups.get"]),
      params.autoProvision ?? true,
      params.defaultRoleId ?? null,
    ],
  );
  return toScimConfig(res.rows[0]);
}

export async function verifyScimToken(params: { pool: Pool; tenantId: string; bearerToken: string }): Promise<ScimConfigRow | null> {
  const tokenHash = crypto.createHash("sha256").update(params.bearerToken).digest("hex");
  const res = await params.pool.query(
    "SELECT * FROM scim_configs WHERE tenant_id = $1 AND bearer_token_hash = $2 AND status = 'active' LIMIT 1",
    [params.tenantId, tokenHash],
  );
  if (!res.rowCount) return null;
  return toScimConfig(res.rows[0]);
}

/* ─── SCIM User Repository ─── */

export interface ScimProvisionedUserRow {
  scimUserId: string;
  tenantId: string;
  externalId: string;
  subjectId: string;
  displayName: string | null;
  email: string | null;
  active: boolean;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}

function toProvisionedUser(r: any): ScimProvisionedUserRow {
  return {
    scimUserId: String(r.scim_user_id),
    tenantId: String(r.tenant_id),
    externalId: String(r.external_id),
    subjectId: String(r.subject_id),
    displayName: r.display_name ? String(r.display_name) : null,
    email: r.email ? String(r.email) : null,
    active: Boolean(r.active),
    lastSyncedAt: String(r.last_synced_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function listScimUsers(params: {
  pool: Pool;
  tenantId: string;
  startIndex?: number;
  count?: number;
  filter?: string;
}): Promise<{ users: ScimProvisionedUserRow[]; totalResults: number }> {
  const startIndex = Math.max(1, params.startIndex ?? 1);
  const count = Math.min(100, Math.max(1, params.count ?? 20));
  const offset = startIndex - 1;

  // Basic filter support (userName eq "xxx")
  let whereClause = "tenant_id = $1";
  const queryParams: any[] = [params.tenantId];

  if (params.filter) {
    const eqMatch = params.filter.match(/userName\s+eq\s+"([^"]+)"/i);
    if (eqMatch) {
      whereClause += " AND subject_id = $2";
      queryParams.push(eqMatch[1]);
    }
    const swMatch = params.filter.match(/userName\s+sw\s+"([^"]+)"/i);
    if (swMatch) {
      whereClause += " AND subject_id LIKE $2";
      queryParams.push(swMatch[1] + "%");
    }
  }

  const countRes = await params.pool.query(
    `SELECT COUNT(*)::int AS total FROM scim_provisioned_users WHERE ${whereClause}`,
    queryParams,
  );
  const totalResults = Number(countRes.rows[0]?.total ?? 0);

  const res = await params.pool.query(
    `SELECT * FROM scim_provisioned_users WHERE ${whereClause} ORDER BY created_at ASC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
    [...queryParams, count, offset],
  );

  return {
    users: res.rows.map(toProvisionedUser),
    totalResults,
  };
}

export async function getScimUserById(params: { pool: Pool; tenantId: string; scimUserId: string }): Promise<ScimProvisionedUserRow | null> {
  const res = await params.pool.query(
    "SELECT * FROM scim_provisioned_users WHERE tenant_id = $1 AND scim_user_id = $2",
    [params.tenantId, params.scimUserId],
  );
  if (!res.rowCount) return null;
  return toProvisionedUser(res.rows[0]);
}

export async function getScimUserByExternalId(params: { pool: Pool; tenantId: string; externalId: string }): Promise<ScimProvisionedUserRow | null> {
  const res = await params.pool.query(
    "SELECT * FROM scim_provisioned_users WHERE tenant_id = $1 AND external_id = $2",
    [params.tenantId, params.externalId],
  );
  if (!res.rowCount) return null;
  return toProvisionedUser(res.rows[0]);
}

export async function createScimUser(params: {
  pool: Pool;
  tenantId: string;
  externalId: string;
  subjectId: string;
  displayName?: string | null;
  email?: string | null;
  active?: boolean;
  config: ScimConfigRow;
}): Promise<ScimProvisionedUserRow> {
  // Ensure subject exists in the system
  if (params.config.autoProvision) {
    await ensureSubject({ pool: params.pool, tenantId: params.tenantId, subjectId: params.subjectId });

    // Link identity
    await params.pool.query(
      `INSERT INTO subject_identity_links (tenant_id, primary_subject_id, linked_subject_id, identity_label, provider_type, provider_ref)
       VALUES ($1, $2, $2, 'scim', 'scim', $3)
       ON CONFLICT (tenant_id, primary_subject_id, linked_subject_id) DO UPDATE SET updated_at = now()`,
      [params.tenantId, params.subjectId, params.config.scimConfigId],
    );

    // Assign default role if configured
    if (params.config.defaultRoleId) {
      await params.pool.query(
        `INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id)
         VALUES ($1, $2, 'tenant', $3)
         ON CONFLICT DO NOTHING`,
        [params.subjectId, params.config.defaultRoleId, params.tenantId],
      );
    }
  }

  const res = await params.pool.query(
    `INSERT INTO scim_provisioned_users (tenant_id, external_id, subject_id, display_name, email, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, external_id) DO UPDATE SET
       subject_id = EXCLUDED.subject_id,
       display_name = EXCLUDED.display_name,
       email = EXCLUDED.email,
       active = EXCLUDED.active,
       last_synced_at = now(),
       updated_at = now()
     RETURNING *`,
    [params.tenantId, params.externalId, params.subjectId, params.displayName ?? null, params.email ?? null, params.active ?? true],
  );

  return toProvisionedUser(res.rows[0]);
}

export async function updateScimUser(params: {
  pool: Pool;
  tenantId: string;
  scimUserId: string;
  displayName?: string | null;
  email?: string | null;
  active?: boolean;
}): Promise<ScimProvisionedUserRow | null> {
  const updates: string[] = [];
  const values: any[] = [];
  let paramIdx = 1;

  updates.push(`tenant_id = $${paramIdx++}`);
  values.push(params.tenantId);

  updates.push(`scim_user_id = $${paramIdx++}`);
  values.push(params.scimUserId);

  if (params.displayName !== undefined) {
    updates.push(`display_name = $${paramIdx++}`);
    values.push(params.displayName);
  }
  if (params.email !== undefined) {
    updates.push(`email = $${paramIdx++}`);
    values.push(params.email);
  }
  if (params.active !== undefined) {
    updates.push(`active = $${paramIdx++}`);
    values.push(params.active);
  }

  const res = await params.pool.query(
    `UPDATE scim_provisioned_users SET
       ${params.displayName !== undefined ? "display_name = $3," : ""}
       ${params.email !== undefined ? `email = $${params.displayName !== undefined ? 4 : 3},` : ""}
       ${params.active !== undefined ? `active = $${(params.displayName !== undefined ? 1 : 0) + (params.email !== undefined ? 1 : 0) + 3},` : ""}
       last_synced_at = now(),
       updated_at = now()
     WHERE tenant_id = $1 AND scim_user_id = $2
     RETURNING *`,
    [params.tenantId, params.scimUserId, params.displayName, params.email, params.active].filter((v) => v !== undefined),
  );

  if (!res.rowCount) return null;
  return toProvisionedUser(res.rows[0]);
}

export async function deleteScimUser(params: { pool: Pool; tenantId: string; scimUserId: string }): Promise<boolean> {
  const res = await params.pool.query(
    "DELETE FROM scim_provisioned_users WHERE tenant_id = $1 AND scim_user_id = $2",
    [params.tenantId, params.scimUserId],
  );
  return (res.rowCount ?? 0) > 0;
}

/* ─── SCIM Group Repository ─── */

export interface ScimProvisionedGroupRow {
  scimGroupId: string;
  tenantId: string;
  externalId: string;
  displayName: string;
  members: Array<{ value: string; display?: string }>;
  active: boolean;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}

function toProvisionedGroup(r: any): ScimProvisionedGroupRow {
  return {
    scimGroupId: String(r.scim_group_id),
    tenantId: String(r.tenant_id),
    externalId: String(r.external_id),
    displayName: String(r.display_name),
    members: Array.isArray(r.members) ? r.members : JSON.parse(r.members || "[]"),
    active: Boolean(r.active),
    lastSyncedAt: String(r.last_synced_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function listScimGroups(params: {
  pool: Pool;
  tenantId: string;
  startIndex?: number;
  count?: number;
  filter?: string;
}): Promise<{ groups: ScimProvisionedGroupRow[]; totalResults: number }> {
  const startIndex = Math.max(1, params.startIndex ?? 1);
  const count = Math.min(100, Math.max(1, params.count ?? 20));
  const offset = startIndex - 1;

  let whereClause = "tenant_id = $1";
  const queryParams: any[] = [params.tenantId];

  if (params.filter) {
    const eqMatch = params.filter.match(/displayName\s+eq\s+"([^"]+)"/i);
    if (eqMatch) {
      whereClause += " AND display_name = $2";
      queryParams.push(eqMatch[1]);
    }
  }

  const countRes = await params.pool.query(
    `SELECT COUNT(*)::int AS total FROM scim_provisioned_groups WHERE ${whereClause}`,
    queryParams,
  );
  const totalResults = Number(countRes.rows[0]?.total ?? 0);

  const res = await params.pool.query(
    `SELECT * FROM scim_provisioned_groups WHERE ${whereClause} ORDER BY created_at ASC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
    [...queryParams, count, offset],
  );

  return {
    groups: res.rows.map(toProvisionedGroup),
    totalResults,
  };
}

export async function getScimGroupById(params: { pool: Pool; tenantId: string; scimGroupId: string }): Promise<ScimProvisionedGroupRow | null> {
  const res = await params.pool.query(
    "SELECT * FROM scim_provisioned_groups WHERE tenant_id = $1 AND scim_group_id = $2",
    [params.tenantId, params.scimGroupId],
  );
  if (!res.rowCount) return null;
  return toProvisionedGroup(res.rows[0]);
}

export async function getScimGroupByExternalId(params: { pool: Pool; tenantId: string; externalId: string }): Promise<ScimProvisionedGroupRow | null> {
  const res = await params.pool.query(
    "SELECT * FROM scim_provisioned_groups WHERE tenant_id = $1 AND external_id = $2",
    [params.tenantId, params.externalId],
  );
  if (!res.rowCount) return null;
  return toProvisionedGroup(res.rows[0]);
}

export async function createScimGroup(params: {
  pool: Pool;
  tenantId: string;
  externalId: string;
  displayName: string;
  members?: Array<{ value: string; display?: string }>;
  active?: boolean;
  config: ScimConfigRow;
}): Promise<ScimProvisionedGroupRow> {
  const members = params.members ?? [];

  const res = await params.pool.query(
    `INSERT INTO scim_provisioned_groups (tenant_id, external_id, display_name, members, active)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (tenant_id, external_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       members = EXCLUDED.members,
       active = EXCLUDED.active,
       last_synced_at = now(),
       updated_at = now()
     RETURNING *`,
    [params.tenantId, params.externalId, params.displayName, JSON.stringify(members), params.active ?? true],
  );

  const group = toProvisionedGroup(res.rows[0]);

  // Auto-provision: ensure member subjects exist + sync role bindings
  if (params.config.autoProvision) {
    await syncGroupMembers({ pool: params.pool, tenantId: params.tenantId, group, config: params.config });
  }

  return group;
}

export async function updateScimGroup(params: {
  pool: Pool;
  tenantId: string;
  scimGroupId: string;
  displayName?: string;
  members?: Array<{ value: string; display?: string }>;
  active?: boolean;
  config: ScimConfigRow;
}): Promise<ScimProvisionedGroupRow | null> {
  const sets: string[] = ["last_synced_at = now()", "updated_at = now()"];
  const values: any[] = [params.tenantId, params.scimGroupId];
  let idx = 3;

  if (params.displayName !== undefined) {
    sets.push(`display_name = $${idx++}`);
    values.push(params.displayName);
  }
  if (params.members !== undefined) {
    sets.push(`members = $${idx++}::jsonb`);
    values.push(JSON.stringify(params.members));
  }
  if (params.active !== undefined) {
    sets.push(`active = $${idx++}`);
    values.push(params.active);
  }

  const res = await params.pool.query(
    `UPDATE scim_provisioned_groups SET ${sets.join(", ")}
     WHERE tenant_id = $1 AND scim_group_id = $2
     RETURNING *`,
    values,
  );

  if (!res.rowCount) return null;
  const group = toProvisionedGroup(res.rows[0]);

  // Re-sync role bindings on membership change
  if (params.config.autoProvision && params.members !== undefined) {
    await syncGroupMembers({ pool: params.pool, tenantId: params.tenantId, group, config: params.config });
  }

  return group;
}

export async function deleteScimGroup(params: { pool: Pool; tenantId: string; scimGroupId: string }): Promise<boolean> {
  // Before deleting, remove all role_bindings created by this group's role mappings
  const mappings = await params.pool.query(
    "SELECT role_id, scope_type, scope_id FROM scim_group_role_mappings WHERE tenant_id = $1 AND scim_group_id = $2",
    [params.tenantId, params.scimGroupId],
  );
  const group = await getScimGroupById({ pool: params.pool, tenantId: params.tenantId, scimGroupId: params.scimGroupId });
  if (group && mappings.rowCount) {
    for (const member of group.members) {
      for (const mapping of mappings.rows) {
        await params.pool.query(
          "DELETE FROM role_bindings WHERE subject_id = $1 AND role_id = $2 AND scope_type = $3 AND scope_id = $4",
          [member.value, mapping.role_id, mapping.scope_type, mapping.scope_id],
        );
      }
    }
    // Bump policy cache
    const { bumpPolicyCacheEpoch } = await import("./policyCacheEpochRepo");
    await bumpPolicyCacheEpoch({ pool: params.pool, tenantId: params.tenantId, scopeType: "tenant", scopeId: params.tenantId });
  }

  // CASCADE will delete scim_group_role_mappings
  const res = await params.pool.query(
    "DELETE FROM scim_provisioned_groups WHERE tenant_id = $1 AND scim_group_id = $2",
    [params.tenantId, params.scimGroupId],
  );
  return (res.rowCount ?? 0) > 0;
}

/* ─── Group → Role Mapping & Member Sync ─── */

export async function getGroupRoleMappings(params: { pool: Pool; tenantId: string; scimGroupId: string }) {
  const res = await params.pool.query(
    "SELECT * FROM scim_group_role_mappings WHERE tenant_id = $1 AND scim_group_id = $2",
    [params.tenantId, params.scimGroupId],
  );
  return res.rows.map((r: any) => ({
    mappingId: String(r.mapping_id),
    tenantId: String(r.tenant_id),
    scimGroupId: String(r.scim_group_id),
    roleId: String(r.role_id),
    scopeType: String(r.scope_type),
    scopeId: String(r.scope_id),
  }));
}

export async function upsertGroupRoleMapping(params: {
  pool: Pool;
  tenantId: string;
  scimGroupId: string;
  roleId: string;
  scopeType?: string;
  scopeId?: string;
}) {
  const scopeType = params.scopeType ?? "tenant";
  const scopeId = params.scopeId ?? params.tenantId;
  await params.pool.query(
    `INSERT INTO scim_group_role_mappings (tenant_id, scim_group_id, role_id, scope_type, scope_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, scim_group_id, role_id, scope_type, scope_id) DO NOTHING`,
    [params.tenantId, params.scimGroupId, params.roleId, scopeType, scopeId],
  );
}

/**
 * 核心同步逻辑：基于 Group 的 members 列表和 role mappings，
 * 自动为每个 member subject 创建/清理 role_bindings。
 *
 * 流程：
 * 1. 确保所有 member subjects 存在
 * 2. 查询此 Group 的所有 role mappings
 * 3. 为每个 member × mapping 创建 role_binding（幂等）
 * 4. 移除不再属于 members 的旧 bindings
 * 5. Bump policy cache epoch
 */
export async function syncGroupMembers(params: {
  pool: Pool;
  tenantId: string;
  group: ScimProvisionedGroupRow;
  config: ScimConfigRow;
}) {
  const { pool, tenantId, group, config } = params;

  // 1. Ensure all member subjects exist
  for (const member of group.members) {
    if (!member.value) continue;
    await ensureSubject({ pool, tenantId, subjectId: member.value });
    // Assign default role if configured (same as user provisioning)
    if (config.defaultRoleId) {
      await pool.query(
        `INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id)
         VALUES ($1, $2, 'tenant', $3)
         ON CONFLICT DO NOTHING`,
        [member.value, config.defaultRoleId, tenantId],
      );
    }
  }

  // 2. Get role mappings for this group
  const mappings = await getGroupRoleMappings({ pool, tenantId, scimGroupId: group.scimGroupId });
  if (!mappings.length) return;

  const currentMemberIds = new Set(group.members.map(m => m.value).filter(Boolean));

  // 3. Create bindings for current members
  for (const member of group.members) {
    if (!member.value) continue;
    for (const mapping of mappings) {
      await pool.query(
        `INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [member.value, mapping.roleId, mapping.scopeType, mapping.scopeId],
      );
    }
  }

  // 4. Find previous members (subjects that have bindings via this group's mappings but are no longer in members)
  for (const mapping of mappings) {
    const existingBindings = await pool.query(
      `SELECT DISTINCT rb.subject_id
       FROM role_bindings rb
       WHERE rb.role_id = $1 AND rb.scope_type = $2 AND rb.scope_id = $3
         AND rb.subject_id NOT IN (SELECT unnest($4::text[]))`,
      [mapping.roleId, mapping.scopeType, mapping.scopeId, Array.from(currentMemberIds)],
    );
    // Only remove if the subject was previously a SCIM group member (check provisioned users to avoid removing manually-assigned bindings)
    // For safety, we only remove bindings for subjects that were provisioned via SCIM
    for (const row of existingBindings.rows) {
      const subjectId = String(row.subject_id);
      const wasScimProvisioned = await pool.query(
        "SELECT 1 FROM scim_provisioned_users WHERE tenant_id = $1 AND subject_id = $2 LIMIT 1",
        [tenantId, subjectId],
      );
      if (wasScimProvisioned.rowCount) {
        await pool.query(
          "DELETE FROM role_bindings WHERE subject_id = $1 AND role_id = $2 AND scope_type = $3 AND scope_id = $4",
          [subjectId, mapping.roleId, mapping.scopeType, mapping.scopeId],
        );
      }
    }
  }

  // 5. Bump policy cache
  const { bumpPolicyCacheEpoch } = await import("./policyCacheEpochRepo");
  await bumpPolicyCacheEpoch({ pool, tenantId, scopeType: "tenant", scopeId: tenantId });
}

/* ─── SCIM Response Builders ─── */

export function buildScimGroupResponse(group: ScimProvisionedGroupRow, baseUrl: string): ScimGroup {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    id: group.scimGroupId,
    externalId: group.externalId,
    displayName: group.displayName,
    members: group.members.map(m => ({
      value: m.value,
      display: m.display,
      type: "User",
    })),
    meta: {
      resourceType: "Group",
      created: group.createdAt,
      lastModified: group.updatedAt,
      location: `${baseUrl}/scim/v2/Groups/${group.scimGroupId}`,
    },
  };
}

export function buildScimUserResponse(user: ScimProvisionedUserRow, baseUrl: string): ScimUser {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: user.scimUserId,
    externalId: user.externalId,
    userName: user.subjectId,
    displayName: user.displayName || undefined,
    emails: user.email ? [{ value: user.email, primary: true, type: "work" }] : undefined,
    active: user.active,
    meta: {
      resourceType: "User",
      created: user.createdAt,
      lastModified: user.updatedAt,
      location: `${baseUrl}/scim/v2/Users/${user.scimUserId}`,
    },
  };
}

export function buildScimListResponse<T>(params: {
  resources: T[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
}): ScimListResponse<T> {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: params.totalResults,
    startIndex: params.startIndex,
    itemsPerPage: params.itemsPerPage,
    Resources: params.resources,
  };
}

export function buildScimError(status: number, detail: string, scimType?: string): ScimError {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    scimType,
    detail,
  };
}

/* ─── SCIM Sync Status Tracking ─── */

export async function recordScimSyncEvent(params: {
  pool: Pool;
  tenantId: string;
  operation: string;
  externalId: string;
  subjectId: string;
  result: "success" | "error";
  errorMessage?: string;
}): Promise<void> {
  await insertAuditEvent(params.pool, {
    subjectId: "scim_provisioner",
    tenantId: params.tenantId,
    resourceType: "scim",
    action: params.operation,
    outputDigest: {
      externalId: params.externalId,
      subjectId: params.subjectId,
      errorMessage: params.errorMessage,
    },
    result: params.result,
    traceId: `scim:${params.operation}:${params.externalId}`,
  });
}

/* ─── SCIM Metrics Helpers ─── */

export async function getScimSyncStats(params: {
  pool: Pool;
  tenantId: string;
  window?: "1h" | "24h" | "7d";
}): Promise<{
  totalUsers: number;
  activeUsers: number;
  recentSyncs: number;
  syncErrors: number;
}> {
  const interval = params.window === "7d" ? "7 days" : params.window === "24h" ? "24 hours" : "1 hour";

  const userStatsRes = await params.pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE active)::int AS active
     FROM scim_provisioned_users
     WHERE tenant_id = $1`,
    [params.tenantId],
  );

  const syncStatsRes = await params.pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE result = 'error')::int AS errors
     FROM audit_events
     WHERE tenant_id = $1
       AND resource_type = 'scim'
       AND timestamp >= NOW() - $2::interval`,
    [params.tenantId, interval],
  );

  return {
    totalUsers: Number(userStatsRes.rows[0]?.total ?? 0),
    activeUsers: Number(userStatsRes.rows[0]?.active ?? 0),
    recentSyncs: Number(syncStatsRes.rows[0]?.total ?? 0),
    syncErrors: Number(syncStatsRes.rows[0]?.errors ?? 0),
  };
}
