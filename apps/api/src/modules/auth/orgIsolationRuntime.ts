/**
 * Organization Isolation Runtime — architecture-05 section 15.15/15.8
 * Handles: Organization hierarchy management, Space membership, Org-level RBAC bindings.
 *
 * 功能目标：实现组织级权限隔离，支持多层组织架构和空间成员管理。
 */
import type { Pool } from "pg";

/* ─── Organization Unit Types ─── */

export interface OrgUnit {
  orgUnitId: string;
  tenantId: string;
  parentId: string | null;
  orgName: string;
  orgPath: string;
  depth: number;
  createdAt: string;
}

export interface SubjectOrgAssignment {
  id: string;
  tenantId: string;
  subjectId: string;
  orgUnitId: string;
  createdAt: string;
}

export interface SpaceMember {
  tenantId: string;
  spaceId: string;
  subjectId: string;
  role: "owner" | "admin" | "member" | "viewer";
  createdAt: string;
}

/* ─── Organization Unit Repository ─── */

function toOrgUnit(r: any): OrgUnit {
  return {
    orgUnitId: String(r.org_unit_id),
    tenantId: String(r.tenant_id),
    parentId: r.parent_id ? String(r.parent_id) : null,
    orgName: String(r.org_name),
    orgPath: String(r.org_path),
    depth: Number(r.depth ?? 0),
    createdAt: String(r.created_at),
  };
}

export async function createOrgUnit(params: {
  pool: Pool;
  tenantId: string;
  orgName: string;
  parentId?: string | null;
}): Promise<OrgUnit> {
  let parentPath = "/";
  let parentDepth = 0;

  if (params.parentId) {
    const parentRes = await params.pool.query(
      "SELECT org_path, depth FROM org_units WHERE tenant_id = $1 AND org_unit_id = $2",
      [params.tenantId, params.parentId],
    );
    if (parentRes.rowCount) {
      parentPath = String(parentRes.rows[0].org_path);
      parentDepth = Number(parentRes.rows[0].depth ?? 0);
    }
  }

  // Build org path: /parent_path/org_name
  const sanitizedName = params.orgName.replace(/[\/\\]/g, "_");
  const orgPath = parentPath === "/" ? `/${sanitizedName}` : `${parentPath}/${sanitizedName}`;

  const res = await params.pool.query(
    `INSERT INTO org_units (tenant_id, parent_id, org_name, org_path, depth)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [params.tenantId, params.parentId ?? null, params.orgName, orgPath, parentDepth + 1],
  );
  return toOrgUnit(res.rows[0]);
}

export async function getOrgUnit(params: { pool: Pool; tenantId: string; orgUnitId: string }): Promise<OrgUnit | null> {
  const res = await params.pool.query(
    "SELECT * FROM org_units WHERE tenant_id = $1 AND org_unit_id = $2",
    [params.tenantId, params.orgUnitId],
  );
  if (!res.rowCount) return null;
  return toOrgUnit(res.rows[0]);
}

export async function getOrgUnitByPath(params: { pool: Pool; tenantId: string; orgPath: string }): Promise<OrgUnit | null> {
  const res = await params.pool.query(
    "SELECT * FROM org_units WHERE tenant_id = $1 AND org_path = $2",
    [params.tenantId, params.orgPath],
  );
  if (!res.rowCount) return null;
  return toOrgUnit(res.rows[0]);
}

export async function listOrgUnits(params: {
  pool: Pool;
  tenantId: string;
  parentId?: string | null;
  includeDescendants?: boolean;
}): Promise<OrgUnit[]> {
  if (params.includeDescendants && params.parentId) {
    // Get parent org_path first
    const parentRes = await params.pool.query(
      "SELECT org_path FROM org_units WHERE tenant_id = $1 AND org_unit_id = $2",
      [params.tenantId, params.parentId],
    );
    if (!parentRes.rowCount) return [];
    const parentPath = String(parentRes.rows[0].org_path);

    // Get all descendants (org_path LIKE '/parent_path/%')
    const res = await params.pool.query(
      "SELECT * FROM org_units WHERE tenant_id = $1 AND org_path LIKE $2 ORDER BY org_path",
      [params.tenantId, `${parentPath}/%`],
    );
    return res.rows.map(toOrgUnit);
  }

  if (params.parentId !== undefined) {
    const res = await params.pool.query(
      "SELECT * FROM org_units WHERE tenant_id = $1 AND parent_id = $2 ORDER BY org_name",
      [params.tenantId, params.parentId],
    );
    return res.rows.map(toOrgUnit);
  }

  // List root orgs (no parent)
  const res = await params.pool.query(
    "SELECT * FROM org_units WHERE tenant_id = $1 AND parent_id IS NULL ORDER BY org_name",
    [params.tenantId],
  );
  return res.rows.map(toOrgUnit);
}

export async function updateOrgUnit(params: {
  pool: Pool;
  tenantId: string;
  orgUnitId: string;
  orgName?: string;
}): Promise<OrgUnit | null> {
  if (!params.orgName) return getOrgUnit(params);

  const res = await params.pool.query(
    "UPDATE org_units SET org_name = $3 WHERE tenant_id = $1 AND org_unit_id = $2 RETURNING *",
    [params.tenantId, params.orgUnitId, params.orgName],
  );
  if (!res.rowCount) return null;
  return toOrgUnit(res.rows[0]);
}

export async function deleteOrgUnit(params: { pool: Pool; tenantId: string; orgUnitId: string }): Promise<boolean> {
  // Check for children
  const childRes = await params.pool.query(
    "SELECT COUNT(*)::int AS cnt FROM org_units WHERE tenant_id = $1 AND parent_id = $2",
    [params.tenantId, params.orgUnitId],
  );
  if (Number(childRes.rows[0]?.cnt ?? 0) > 0) {
    throw new Error("Cannot delete org unit with children");
  }

  const res = await params.pool.query(
    "DELETE FROM org_units WHERE tenant_id = $1 AND org_unit_id = $2",
    [params.tenantId, params.orgUnitId],
  );
  return (res.rowCount ?? 0) > 0;
}

/* ─── Subject Org Assignment Repository ─── */

function toSubjectOrgAssignment(r: any): SubjectOrgAssignment {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    subjectId: String(r.subject_id),
    orgUnitId: String(r.org_unit_id),
    createdAt: String(r.created_at),
  };
}

export async function assignSubjectToOrg(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  orgUnitId: string;
}): Promise<SubjectOrgAssignment> {
  const res = await params.pool.query(
    `INSERT INTO subject_org_assignments (tenant_id, subject_id, org_unit_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, subject_id, org_unit_id) DO UPDATE SET created_at = subject_org_assignments.created_at
     RETURNING *`,
    [params.tenantId, params.subjectId, params.orgUnitId],
  );
  return toSubjectOrgAssignment(res.rows[0]);
}

export async function removeSubjectFromOrg(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  orgUnitId: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    "DELETE FROM subject_org_assignments WHERE tenant_id = $1 AND subject_id = $2 AND org_unit_id = $3",
    [params.tenantId, params.subjectId, params.orgUnitId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getSubjectOrgAssignments(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
}): Promise<SubjectOrgAssignment[]> {
  const res = await params.pool.query(
    "SELECT * FROM subject_org_assignments WHERE tenant_id = $1 AND subject_id = $2",
    [params.tenantId, params.subjectId],
  );
  return res.rows.map(toSubjectOrgAssignment);
}

export async function listOrgMembers(params: {
  pool: Pool;
  tenantId: string;
  orgUnitId: string;
  includeDescendants?: boolean;
}): Promise<SubjectOrgAssignment[]> {
  if (params.includeDescendants) {
    // Get org_path first
    const orgRes = await params.pool.query(
      "SELECT org_path FROM org_units WHERE tenant_id = $1 AND org_unit_id = $2",
      [params.tenantId, params.orgUnitId],
    );
    if (!orgRes.rowCount) return [];
    const orgPath = String(orgRes.rows[0].org_path);

    // Get all members in this org and descendants
    const res = await params.pool.query(
      `SELECT soa.* FROM subject_org_assignments soa
       JOIN org_units ou ON soa.tenant_id = ou.tenant_id AND soa.org_unit_id = ou.org_unit_id
       WHERE soa.tenant_id = $1 AND (ou.org_path = $2 OR ou.org_path LIKE $3)
       ORDER BY soa.subject_id`,
      [params.tenantId, orgPath, `${orgPath}/%`],
    );
    return res.rows.map(toSubjectOrgAssignment);
  }

  const res = await params.pool.query(
    "SELECT * FROM subject_org_assignments WHERE tenant_id = $1 AND org_unit_id = $2",
    [params.tenantId, params.orgUnitId],
  );
  return res.rows.map(toSubjectOrgAssignment);
}

/* ─── Space Member Repository ─── */

function toSpaceMember(r: any): SpaceMember {
  return {
    tenantId: String(r.tenant_id),
    spaceId: String(r.space_id),
    subjectId: String(r.subject_id),
    role: String(r.role ?? "member") as SpaceMember["role"],
    createdAt: String(r.created_at),
  };
}

export async function addSpaceMember(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  role?: SpaceMember["role"];
}): Promise<SpaceMember> {
  const role = params.role ?? "member";
  const res = await params.pool.query(
    `INSERT INTO space_members (tenant_id, space_id, subject_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, space_id, subject_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING *`,
    [params.tenantId, params.spaceId, params.subjectId, role],
  );
  return toSpaceMember(res.rows[0]);
}

export async function removeSpaceMember(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    "DELETE FROM space_members WHERE tenant_id = $1 AND space_id = $2 AND subject_id = $3",
    [params.tenantId, params.spaceId, params.subjectId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getSpaceMember(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
}): Promise<SpaceMember | null> {
  const res = await params.pool.query(
    "SELECT * FROM space_members WHERE tenant_id = $1 AND space_id = $2 AND subject_id = $3",
    [params.tenantId, params.spaceId, params.subjectId],
  );
  if (!res.rowCount) return null;
  return toSpaceMember(res.rows[0]);
}

export async function listSpaceMembers(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
}): Promise<SpaceMember[]> {
  const res = await params.pool.query(
    "SELECT * FROM space_members WHERE tenant_id = $1 AND space_id = $2 ORDER BY role, subject_id",
    [params.tenantId, params.spaceId],
  );
  return res.rows.map(toSpaceMember);
}

export async function getSubjectSpaces(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
}): Promise<SpaceMember[]> {
  const res = await params.pool.query(
    "SELECT * FROM space_members WHERE tenant_id = $1 AND subject_id = $2 ORDER BY space_id",
    [params.tenantId, params.subjectId],
  );
  return res.rows.map(toSpaceMember);
}

export async function updateSpaceMemberRole(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  role: SpaceMember["role"];
}): Promise<SpaceMember | null> {
  const res = await params.pool.query(
    "UPDATE space_members SET role = $4 WHERE tenant_id = $1 AND space_id = $2 AND subject_id = $3 RETURNING *",
    [params.tenantId, params.spaceId, params.subjectId, params.role],
  );
  if (!res.rowCount) return null;
  return toSpaceMember(res.rows[0]);
}

/* ─── Org-level RBAC Binding ─── */

/**
 * 检查主体是否属于指定组织（含祖先链）。
 * 用于组织级权限继承计算。
 */
export async function isSubjectInOrgHierarchy(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  orgUnitId: string;
}): Promise<boolean> {
  // Get the target org_path
  const orgRes = await params.pool.query(
    "SELECT org_path FROM org_units WHERE tenant_id = $1 AND org_unit_id = $2",
    [params.tenantId, params.orgUnitId],
  );
  if (!orgRes.rowCount) return false;
  const targetPath = String(orgRes.rows[0].org_path);

  // Get all orgs the subject belongs to
  const assignRes = await params.pool.query(
    `SELECT ou.org_path FROM subject_org_assignments soa
     JOIN org_units ou ON soa.tenant_id = ou.tenant_id AND soa.org_unit_id = ou.org_unit_id
     WHERE soa.tenant_id = $1 AND soa.subject_id = $2`,
    [params.tenantId, params.subjectId],
  );

  // Check if any assignment is on the path to target (ancestor or exact match)
  for (const row of assignRes.rows) {
    const subjectOrgPath = String(row.org_path);
    if (targetPath.startsWith(subjectOrgPath)) {
      return true; // Subject's org is an ancestor of target
    }
    if (subjectOrgPath.startsWith(targetPath)) {
      return true; // Subject's org is a descendant of target
    }
  }

  return false;
}

/**
 * 获取主体在指定空间的有效角色。
 * 考虑直接成员角色和组织继承角色。
 */
export async function getEffectiveSpaceRole(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
}): Promise<SpaceMember["role"] | null> {
  // 1. 直接成员优先（直接成员角色 > 组织继承角色）
  const direct = await getSpaceMember(params);
  if (direct) return direct.role;

  // 2. P1-3: 查询 org-level space access policies — 组织继承角色
  //    流程：查找 subject 所属的所有 org → 对每个 org 及其祖先链检查 access policy → 返回最高权限角色
  const subjectOrgs = await params.pool.query(
    `SELECT soa.org_unit_id, ou.org_path
     FROM subject_org_assignments soa
     JOIN org_units ou ON soa.tenant_id = ou.tenant_id AND soa.org_unit_id = ou.org_unit_id
     WHERE soa.tenant_id = $1 AND soa.subject_id = $2`,
    [params.tenantId, params.subjectId],
  );

  if (!subjectOrgs.rowCount) return null;

  // 收集 subject 所属 org 的所有 org_path（用于祖先匹配）
  const subjectOrgPaths: string[] = subjectOrgs.rows.map((r: any) => String(r.org_path));
  const subjectOrgIds: string[] = subjectOrgs.rows.map((r: any) => String(r.org_unit_id));

  // 查询所有可能匹配的 access policies
  // 情况 A: policy 的 org_unit_id 是 subject 直接所属的 org（精确匹配）
  // 情况 B: policy 的 org_unit_id 是 subject 所属 org 的祖先，且 include_descendants = true
  const policies = await params.pool.query(
    `SELECT oap.inherited_role, oap.include_descendants, ou.org_path AS policy_org_path
     FROM org_space_access_policies oap
     JOIN org_units ou ON oap.tenant_id = ou.tenant_id AND oap.org_unit_id = ou.org_unit_id
     WHERE oap.tenant_id = $1 AND oap.space_id = $2`,
    [params.tenantId, params.spaceId],
  );

  if (!policies.rowCount) return null;

  // 角色优先级映射（越高越优先）
  const rolePriority: Record<string, number> = {
    owner: 4,
    admin: 3,
    member: 2,
    viewer: 1,
  };

  let bestRole: SpaceMember["role"] | null = null;
  let bestPriority = 0;

  for (const policy of policies.rows) {
    const policyOrgPath = String(policy.policy_org_path);
    const inheritedRole = String(policy.inherited_role) as SpaceMember["role"];
    const includeDescendants = Boolean(policy.include_descendants);
    const rp = rolePriority[inheritedRole] ?? 0;

    // 检查 subject 的每个 org 是否匹配此 policy
    for (const subjectOrgPath of subjectOrgPaths) {
      let matches = false;

      if (subjectOrgPath === policyOrgPath) {
        // 精确匹配
        matches = true;
      } else if (includeDescendants && subjectOrgPath.startsWith(policyOrgPath + "/")) {
        // subject 的 org 是 policy org 的后代
        matches = true;
      }

      if (matches && rp > bestPriority) {
        bestRole = inheritedRole;
        bestPriority = rp;
      }
    }
  }

  return bestRole;
}

/* ─── Isolation Validation ─── */

/**
 * 验证跨租户/组织数据访问隔离。
 * 用于审计和策略强制执行。
 */
export async function validateDataIsolation(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  targetTenantId: string;
  targetSpaceId?: string;
  targetOrgUnitId?: string;
}): Promise<{ allowed: boolean; reason?: string }> {
  // Cross-tenant access is always denied
  if (params.tenantId !== params.targetTenantId) {
    return { allowed: false, reason: "cross_tenant_access_denied" };
  }

  // Check space access if specified
  if (params.targetSpaceId) {
    const role = await getEffectiveSpaceRole({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.targetSpaceId,
      subjectId: params.subjectId,
    });
    if (!role) {
      return { allowed: false, reason: "space_access_denied" };
    }
  }

  // Check org access if specified
  if (params.targetOrgUnitId) {
    const inOrg = await isSubjectInOrgHierarchy({
      pool: params.pool,
      tenantId: params.tenantId,
      subjectId: params.subjectId,
      orgUnitId: params.targetOrgUnitId,
    });
    if (!inOrg) {
      return { allowed: false, reason: "org_access_denied" };
    }
  }

  return { allowed: true };
}
