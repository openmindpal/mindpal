/**
 * MetadataRegistry — 统一元数据注册层
 * 收敛 tool/workflow/permission/connector 的元数据管理
 * 复用 toolGovernanceRepo 的分层策略（Tenant默认 + Space覆盖）
 */

export type MetadataKind = "tool" | "workflow" | "permission" | "connector";
export type MetadataScopeType = "tenant" | "space";
export type RolloutMode = "immediate" | "graceful";

/** 统一元数据条目 */
export interface MetadataEntry {
  kind: MetadataKind;
  name: string;
  version: string;
  tenantId: string;
  scopeType: MetadataScopeType;
  scopeId: string;
  /** inputs/outputs JSON Schema */
  schema?: Record<string, unknown>;
  capabilities?: string[];
  enabled: boolean;
  rolloutMode?: RolloutMode;
  graceDeadline?: string | null;
  updatedAt: string;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

/** 元数据查询条件 */
export interface MetadataQuery {
  kind?: MetadataKind;
  tenantId: string;
  scopeType?: MetadataScopeType;
  scopeId?: string;
  name?: string;
  enabled?: boolean;
}

/** 元数据分层解析选项 */
export interface MetadataResolveOpts {
  kind: MetadataKind;
  name: string;
  tenantId: string;
  spaceId: string;
  /** 用于 graceful disable 宽限期判断 */
  runCreatedAt?: Date;
}

/** 依赖注入：仅需一个 pool.query 方法 */
export interface MetadataRegistryDeps {
  pool: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
}

/** metadata_registry 显式字段列表（与 toEntry 映射对齐） */
const METADATA_REGISTRY_COLS = `kind, name, version, tenant_id, scope_type, scope_id,
  schema_json, capabilities, enabled, rollout_mode, grace_deadline,
  metadata_json, updated_at`;

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function toEntry(row: any): MetadataEntry {
  return {
    kind: row.kind,
    name: row.name,
    version: row.version,
    tenantId: row.tenant_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    schema: row.schema_json ?? undefined,
    capabilities: row.capabilities ?? undefined,
    enabled: Boolean(row.enabled),
    rolloutMode: row.rollout_mode ?? undefined,
    graceDeadline: row.grace_deadline ?? null,
    updatedAt: row.updated_at,
    metadata: row.metadata_json ?? undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  CRUD functions                                                      */
/* ------------------------------------------------------------------ */

/**
 * 注册/更新元数据条目（upsert 语义）。
 *
 * 使用 `INSERT ... ON CONFLICT DO UPDATE` 保证幂等写入。
 * 唯一约束：`(kind, name, tenant_id, scope_type, scope_id)`。
 *
 * @param deps  依赖注入（pool）
 * @param entry 要写入的元数据条目（updatedAt 由数据库自动生成）
 * @returns 写入后的完整 MetadataEntry
 */
export async function registerMetadata(
  deps: MetadataRegistryDeps,
  entry: Omit<MetadataEntry, "updatedAt">,
): Promise<MetadataEntry> {
  const res = await deps.pool.query(
    `INSERT INTO metadata_registry
       (kind, name, version, tenant_id, scope_type, scope_id,
        schema_json, capabilities, enabled, rollout_mode, grace_deadline, metadata_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (kind, name, tenant_id, scope_type, scope_id)
     DO UPDATE SET
       version        = EXCLUDED.version,
       schema_json    = EXCLUDED.schema_json,
       capabilities   = EXCLUDED.capabilities,
       enabled        = EXCLUDED.enabled,
       rollout_mode   = EXCLUDED.rollout_mode,
       grace_deadline = EXCLUDED.grace_deadline,
       metadata_json  = EXCLUDED.metadata_json,
       updated_at     = now()
     RETURNING ${METADATA_REGISTRY_COLS}`,
    [
      entry.kind,
      entry.name,
      entry.version,
      entry.tenantId,
      entry.scopeType,
      entry.scopeId,
      entry.schema ? JSON.stringify(entry.schema) : null,
      entry.capabilities ?? null,
      entry.enabled,
      entry.rolloutMode ?? "immediate",
      entry.graceDeadline ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    ],
  );
  return toEntry(res.rows[0]);
}

/**
 * 解析元数据（分层：Space覆盖 > Tenant默认）。
 *
 * 复用 toolGovernanceRepo.isToolEnabled 的分层策略：
 * 1. 查询 space 级条目
 * 2. fallback 到 tenant 级
 * 3. 如果 graceful disable 且 grace_deadline 未超，视为启用
 *
 * @param deps 依赖注入（pool）
 * @param opts 解析选项
 * @returns 匹配的 MetadataEntry 或 null
 */
export async function resolveMetadata(
  deps: MetadataRegistryDeps,
  opts: MetadataResolveOpts,
): Promise<MetadataEntry | null> {
  // 1. 查询 space 级
  const spaceRes = await deps.pool.query(
    `SELECT ${METADATA_REGISTRY_COLS} FROM metadata_registry
     WHERE kind = $1 AND name = $2 AND tenant_id = $3
       AND scope_type = 'space' AND scope_id = $4
     LIMIT 1`,
    [opts.kind, opts.name, opts.tenantId, opts.spaceId],
  );
  if (spaceRes.rows.length > 0) return toEntry(spaceRes.rows[0]);

  // 2. fallback 到 tenant 级
  const tenantRes = await deps.pool.query(
    `SELECT ${METADATA_REGISTRY_COLS} FROM metadata_registry
     WHERE kind = $1 AND name = $2 AND tenant_id = $3
       AND scope_type = 'tenant' AND scope_id = $3
     LIMIT 1`,
    [opts.kind, opts.name, opts.tenantId],
  );
  if (tenantRes.rows.length > 0) return toEntry(tenantRes.rows[0]);

  return null;
}

/**
 * 列出元数据条目，按 query 条件过滤。
 *
 * @param deps  依赖注入（pool）
 * @param query 查询条件（tenantId 必填，其余可选）
 * @returns 匹配的 MetadataEntry 数组
 */
export async function listMetadata(
  deps: MetadataRegistryDeps,
  query: MetadataQuery,
): Promise<MetadataEntry[]> {
  const where: string[] = ["tenant_id = $1"];
  const args: unknown[] = [query.tenantId];
  let idx = 2;

  if (query.kind) {
    where.push(`kind = $${idx++}`);
    args.push(query.kind);
  }
  if (query.scopeType) {
    where.push(`scope_type = $${idx++}`);
    args.push(query.scopeType);
  }
  if (query.scopeId) {
    where.push(`scope_id = $${idx++}`);
    args.push(query.scopeId);
  }
  if (query.name) {
    where.push(`name = $${idx++}`);
    args.push(query.name);
  }
  if (query.enabled !== undefined) {
    where.push(`enabled = $${idx++}`);
    args.push(query.enabled);
  }

  const res = await deps.pool.query(
    `SELECT ${METADATA_REGISTRY_COLS} FROM metadata_registry
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC
     LIMIT 500`,
    args,
  );
  return res.rows.map(toEntry);
}

/**
 * 停用元数据条目（支持 immediate/graceful 两种模式）。
 *
 * - immediate：立即禁用
 * - graceful：设置宽限截止时间，在此之前已创建的 run 仍可使用
 *
 * @param deps 依赖注入（pool）
 * @param opts 停用选项
 * @returns 是否成功更新了记录
 */
export async function deactivateMetadata(
  deps: MetadataRegistryDeps,
  opts: {
    kind: MetadataKind;
    name: string;
    tenantId: string;
    scopeType: MetadataScopeType;
    scopeId: string;
    mode?: RolloutMode;
    graceDeadline?: Date | null;
  },
): Promise<boolean> {
  const mode = opts.mode ?? "immediate";
  const deadline = opts.graceDeadline ?? null;
  const res = await deps.pool.query(
    `UPDATE metadata_registry
     SET enabled = false, rollout_mode = $1, grace_deadline = $2, updated_at = now()
     WHERE kind = $3 AND name = $4 AND tenant_id = $5
       AND scope_type = $6 AND scope_id = $7`,
    [mode, deadline, opts.kind, opts.name, opts.tenantId, opts.scopeType, opts.scopeId],
  );
  return (res.rows as any).length !== undefined
    ? (res as any).rowCount > 0
    : false;
}

/**
 * 检查元数据是否启用（分层解析 + graceful 宽限）。
 *
 * 逻辑：
 * 1. 调用 resolveMetadata 进行分层解析
 * 2. 若条目不存在，返回 false
 * 3. 若 enabled=true，返回 true
 * 4. 若 graceful 模式且宽限期未过（基于 runCreatedAt），返回 true
 *
 * @param deps 依赖注入（pool）
 * @param opts 解析选项
 * @returns 是否启用
 */
export async function isMetadataEnabled(
  deps: MetadataRegistryDeps,
  opts: MetadataResolveOpts,
): Promise<boolean> {
  const entry = await resolveMetadata(deps, opts);
  if (!entry) return false;
  if (entry.enabled) return true;
  // graceful 模式下检查宽限期
  if (entry.rolloutMode === "graceful" && entry.graceDeadline && opts.runCreatedAt) {
    return opts.runCreatedAt <= new Date(entry.graceDeadline);
  }
  return false;
}
