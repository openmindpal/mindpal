import type { Pool } from "pg";

/* ── P2-2: 通用 UserPreference CRUD ── */

export type UserPreferenceRow = {
  id: string;
  tenantId: string;
  subjectId: string;
  prefKey: string;
  prefValue: any;
  createdAt: string;
  updatedAt: string;
};

function toPref(r: any): UserPreferenceRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    subjectId: r.subject_id,
    prefKey: r.pref_key,
    prefValue: r.pref_value,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 通用：获取用户偏好 */
export async function getUserPreference(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  prefKey: string;
}): Promise<UserPreferenceRow | null> {
  const res = await params.pool.query(
    `
      SELECT *
      FROM memory_user_preferences
      WHERE tenant_id = $1 AND subject_id = $2 AND pref_key = $3
      LIMIT 1
    `,
    [params.tenantId, params.subjectId, params.prefKey],
  );
  if (!res.rowCount) return null;
  return toPref(res.rows[0]);
}

/** 通用：设置用户偏好（upsert） */
export async function setUserPreference(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  prefKey: string;
  prefValue: any;
}): Promise<UserPreferenceRow> {
  const res = await params.pool.query(
    `
      INSERT INTO memory_user_preferences (tenant_id, subject_id, pref_key, pref_value, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, now())
      ON CONFLICT (tenant_id, subject_id, pref_key)
      DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.subjectId, params.prefKey, JSON.stringify(params.prefValue)],
  );
  return toPref(res.rows[0]);
}

/** 通用：删除用户偏好 */
export async function deleteUserPreference(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  prefKey: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    `DELETE FROM memory_user_preferences WHERE tenant_id = $1 AND subject_id = $2 AND pref_key = $3`,
    [params.tenantId, params.subjectId, params.prefKey],
  );
  return Boolean(res.rowCount);
}

/** 通用：列出用户所有偏好 */
export async function listUserPreferences(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  prefKeyPrefix?: string;
  limit?: number;
}): Promise<UserPreferenceRow[]> {
  const limit = params.limit ?? 100;
  if (params.prefKeyPrefix) {
    const res = await params.pool.query(
      `
        SELECT *
        FROM memory_user_preferences
        WHERE tenant_id = $1 AND subject_id = $2 AND pref_key LIKE $3
        ORDER BY updated_at DESC
        LIMIT $4
      `,
      [params.tenantId, params.subjectId, `${params.prefKeyPrefix}%`, limit],
    );
    return res.rows.map(toPref);
  } else {
    const res = await params.pool.query(
      `
        SELECT *
        FROM memory_user_preferences
        WHERE tenant_id = $1 AND subject_id = $2
        ORDER BY updated_at DESC
        LIMIT $3
      `,
      [params.tenantId, params.subjectId, limit],
    );
    return res.rows.map(toPref);
  }
}

/* ── 下面是特定用途的便捷函数 ── */

export async function getUserLocalePreference(params: { pool: Pool; tenantId: string; subjectId: string }) {
  const res = await params.pool.query(
    `
      SELECT pref_value
      FROM memory_user_preferences
      WHERE tenant_id = $1 AND subject_id = $2 AND pref_key = 'locale'
      LIMIT 1
    `,
    [params.tenantId, params.subjectId],
  );
  if (!res.rowCount) return null;
  const v = res.rows[0].pref_value;
  return typeof v === "string" && v.trim() ? v : null;
}

export async function setUserLocalePreference(params: { pool: Pool; tenantId: string; subjectId: string; locale: string }) {
  const locale = params.locale.trim();
  const res = await params.pool.query(
    `
      INSERT INTO memory_user_preferences (tenant_id, subject_id, pref_key, pref_value, updated_at)
      VALUES ($1,$2,'locale',$3::jsonb,now())
      ON CONFLICT (tenant_id, subject_id, pref_key)
      DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = now()
      RETURNING pref_value
    `,
    [params.tenantId, params.subjectId, JSON.stringify(locale)],
  );
  const v = res.rows[0].pref_value;
  return typeof v === "string" && v.trim() ? v : locale;
}

function viewPrefKey(params: { spaceId: string | null; pageName: string }) {
  const scope = params.spaceId ? `space:${params.spaceId}` : "tenant";
  return `ui.view_pref:${scope}:${params.pageName}`;
}

export async function getUserPageViewPrefs(params: { pool: Pool; tenantId: string; subjectId: string; spaceId: string | null; pageName: string }) {
  const key = viewPrefKey({ spaceId: params.spaceId, pageName: params.pageName });
  const res = await params.pool.query(
    `
      SELECT pref_value
      FROM memory_user_preferences
      WHERE tenant_id = $1 AND subject_id = $2 AND pref_key = $3
      LIMIT 1
    `,
    [params.tenantId, params.subjectId, key],
  );
  if (!res.rowCount) return null;
  const v = res.rows[0].pref_value;
  return v && typeof v === "object" ? (v as any) : null;
}

export async function setUserPageViewPrefs(params: { pool: Pool; tenantId: string; subjectId: string; spaceId: string | null; pageName: string; prefs: any }) {
  const key = viewPrefKey({ spaceId: params.spaceId, pageName: params.pageName });
  const res = await params.pool.query(
    `
      INSERT INTO memory_user_preferences (tenant_id, subject_id, pref_key, pref_value, updated_at)
      VALUES ($1,$2,$3,$4::jsonb,now())
      ON CONFLICT (tenant_id, subject_id, pref_key)
      DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = now()
      RETURNING pref_value
    `,
    [params.tenantId, params.subjectId, key, JSON.stringify(params.prefs ?? {})],
  );
  return res.rows[0].pref_value as any;
}

export async function resetUserPageViewPrefs(params: { pool: Pool; tenantId: string; subjectId: string; spaceId: string | null; pageName: string }) {
  const key = viewPrefKey({ spaceId: params.spaceId, pageName: params.pageName });
  const res = await params.pool.query("DELETE FROM memory_user_preferences WHERE tenant_id = $1 AND subject_id = $2 AND pref_key = $3", [
    params.tenantId,
    params.subjectId,
    key,
  ]);
  return Boolean(res.rowCount);
}
