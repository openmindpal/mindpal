import type { Pool } from "pg";

/**
 * 确保 subject 存在于数据库中。
 *
 * 仅保证 subjects 表中存在对应记录，不再自动授予任何角色。
 * 角色绑定由以下途径管理：
 * - seed.ts（初始管理员，仅 SEED_ADMIN_SUBJECT_ID）
 * - SCIM / SAML / SSO 自动配置（通过 defaultRoleId）
 * - 管理员手动分配
 *
 * P0-1 安全修复：移除 dev 模式下 auto-grant admin 逻辑，
 * 恢复 RBAC default-deny 语义。
 */
export async function ensureSubject(params: { pool: Pool; tenantId: string; subjectId: string }) {
  const res = await params.pool.query("SELECT tenant_id FROM subjects WHERE id = $1 LIMIT 1", [params.subjectId]);
  const isNew = !res.rowCount;

  if (!isNew) {
    const tenantId = String(res.rows[0].tenant_id ?? "");
    if (tenantId !== params.tenantId) return { ok: false as const };
  } else {
    await params.pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [params.subjectId, params.tenantId]);
    console.log(`[ensureSubject] created new subject: ${params.subjectId} (tenant: ${params.tenantId})`);
  }

  return { ok: true as const, created: isNew };
}

